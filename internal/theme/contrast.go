// Package theme reads the UI's colour tokens and measures them.
//
// The tokens live in web/src/styles.css, and nothing in the Go binary consumes
// them at runtime — this package exists so that a contrast floor can be a test
// rather than an intention. A colour that fails WCAG is a bug you cannot see by
// looking, because the whole failure mode is that it looks fine to whoever
// picked it; the only way it stays fixed is if something fails the build.
//
// It also guards the specific collision that made "outside the cluster" and
// "unprotected" the same red in two files at once. See TestTokens.
package theme

import (
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
)

// RGB is a colour in the sRGB gamut, each channel in [0,1].
type RGB struct{ R, G, B float64 }

// ParseHex reads #rgb or #rrggbb.
func ParseHex(s string) (RGB, error) {
	h := strings.TrimPrefix(strings.TrimSpace(s), "#")
	if len(h) == 3 {
		h = string([]byte{h[0], h[0], h[1], h[1], h[2], h[2]})
	}
	if len(h) != 6 {
		return RGB{}, fmt.Errorf("%q is not a hex colour", s)
	}
	v, err := strconv.ParseUint(h, 16, 32)
	if err != nil {
		return RGB{}, fmt.Errorf("%q is not a hex colour: %w", s, err)
	}
	return RGB{
		R: float64((v>>16)&0xff) / 255,
		G: float64((v>>8)&0xff) / 255,
		B: float64(v&0xff) / 255,
	}, nil
}

// luminance is the WCAG relative luminance of a colour.
func (c RGB) luminance() float64 {
	lin := func(v float64) float64 {
		if v <= 0.04045 {
			return v / 12.92
		}
		return math.Pow((v+0.055)/1.055, 2.4)
	}
	return 0.2126*lin(c.R) + 0.7152*lin(c.G) + 0.0722*lin(c.B)
}

// Contrast is the WCAG 2.1 contrast ratio between two colours, from 1 to 21.
// The order of the arguments does not matter.
func Contrast(a, b RGB) float64 {
	la, lb := a.luminance(), b.luminance()
	if la < lb {
		la, lb = lb, la
	}
	return (la + 0.05) / (lb + 0.05)
}

// oklab converts sRGB to OKLab, a perceptually uniform space where Euclidean
// distance corresponds to how different two colours actually look.
func (c RGB) oklab() (l, a, b float64) {
	lin := func(v float64) float64 {
		if v <= 0.04045 {
			return v / 12.92
		}
		return math.Pow((v+0.055)/1.055, 2.4)
	}
	r, g, bl := lin(c.R), lin(c.G), lin(c.B)

	x := math.Cbrt(0.4122214708*r + 0.5363325363*g + 0.0514459929*bl)
	y := math.Cbrt(0.2119034982*r + 0.6806995451*g + 0.1073969566*bl)
	z := math.Cbrt(0.0883024619*r + 0.2817188376*g + 0.6299787005*bl)

	return 0.2104542553*x + 0.7936177850*y - 0.0040720468*z,
		1.9779984951*x - 2.4285922050*y + 0.4505937099*z,
		0.0259040371*x + 0.7827717662*y - 0.8086757660*z
}

// Distance is how different two colours look, as a Euclidean distance in OKLab.
// Roughly: 0 is identical, 0.02 is just noticeable, 0.1 is plainly different.
//
// This is the right question to ask of two colours that carry different
// meanings, and [Contrast] is the wrong one. Contrast measures luminance alone,
// so it reports the green of "allowed" and the amber of "approximate" as
// 1.02:1 — all but identical — when they differ almost entirely in hue and
// nobody would confuse them. Legibility is a luminance question; distinctness
// is not.
func Distance(a, b RGB) float64 {
	l1, a1, b1 := a.oklab()
	l2, a2, b2 := b.oklab()
	return math.Sqrt((l1-l2)*(l1-l2) + (a1-a2)*(a1-a2) + (b1-b2)*(b1-b2))
}

// Tokens is one theme's custom properties, keyed without the leading "--".
type Tokens map[string]string

// Colour resolves a token to a colour, following one level of var() indirection
// — which is all the stylesheet uses, and deliberately so: a chain of aliases
// is a good way to lose track of what a colour actually is.
func (t Tokens) Colour(name string) (RGB, error) {
	raw, ok := t[name]
	if !ok {
		return RGB{}, fmt.Errorf("no token --%s", name)
	}
	if ref, ok := varReference(raw); ok {
		target, ok := t[ref]
		if !ok {
			return RGB{}, fmt.Errorf("--%s refers to --%s, which is not defined", name, ref)
		}
		if _, nested := varReference(target); nested {
			return RGB{}, fmt.Errorf("--%s refers to --%s, which is itself an alias", name, ref)
		}
		raw = target
	}
	return ParseHex(raw)
}

var varPattern = regexp.MustCompile(`^var\(\s*--([a-z0-9-]+)\s*\)$`)

func varReference(value string) (string, bool) {
	m := varPattern.FindStringSubmatch(strings.TrimSpace(value))
	if m == nil {
		return "", false
	}
	return m[1], true
}

// Names returns the token names, for comparing one theme's set against another.
func (t Tokens) Names() []string {
	out := make([]string, 0, len(t))
	for k := range t {
		out = append(out, k)
	}
	return out
}

var declaration = regexp.MustCompile(`--([a-z0-9-]+)\s*:\s*([^;]+);`)

// Block extracts the custom properties declared by one rule.
//
// selector must match the rule's selector exactly as written, e.g. ":root" or
// "[data-theme='light']". Matching is anchored on the selector being followed by
// its opening brace, so ":root" does not also match ":root:not(...)" and
// "[data-theme='light']" does not match "[data-theme='light'] .rim".
func Block(css, selector string) (Tokens, error) {
	open := regexp.MustCompile(`(?m)^\s*` + regexp.QuoteMeta(selector) + `\s*\{`)
	loc := open.FindStringIndex(css)
	if loc == nil {
		return nil, fmt.Errorf("no rule for selector %q", selector)
	}

	depth, end := 0, -1
	for i := loc[1] - 1; i < len(css); i++ {
		switch css[i] {
		case '{':
			depth++
		case '}':
			depth--
			if depth == 0 {
				end = i
			}
		}
		if end >= 0 {
			break
		}
	}
	if end < 0 {
		return nil, fmt.Errorf("rule for %q is never closed", selector)
	}

	out := Tokens{}
	for _, m := range declaration.FindAllStringSubmatch(css[loc[1]:end], -1) {
		out[m[1]] = strings.TrimSpace(m[2])
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("rule for %q declares no custom properties", selector)
	}
	return out, nil
}
