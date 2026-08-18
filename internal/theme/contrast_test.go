package theme_test

import (
	"os"
	"path/filepath"
	"slices"
	"testing"

	"github.com/FathiQ/marsad/internal/theme"
)

// stylesheet is the single source of truth for both the chrome and the canvas:
// graph/style.ts reads these same custom properties at runtime rather than
// carrying its own copy, so what is asserted here is what gets painted.
const stylesheet = "../../web/src/styles.css"

// The floors. Text is held to WCAG AA for body text; anything that is a shape
// rather than a glyph — a border you have to find, a node fill, an edge stroke —
// is held to the 3:1 non-text floor.
const (
	textFloor       = 4.5
	structuralFloor = 3.0
)

// textTokens must be legible as text against both the page and a card.
var textTokens = []string{
	"fg", "text-strong", "text-body", "muted", "faint", "text-dim",
	"accent", "danger", "allowed-text", "approx-text",
}

// structuralTokens are strokes, fills and borders that carry meaning without
// carrying letters.
var structuralTokens = []string{
	"line-faint", "neutral-edge", "allowed", "approx",
	"node-domain", "node-cidr", "node-world",
}

// grounds are what the above are measured against.
var grounds = []string{"bg", "surface"}

func load(t *testing.T) (dark, lightMedia, lightAttr theme.Tokens) {
	t.Helper()

	b, err := os.ReadFile(filepath.Clean(stylesheet))
	if err != nil {
		t.Fatalf("reading %s: %v", stylesheet, err)
	}
	css := string(b)

	dark, err = theme.Block(css, ":root")
	if err != nil {
		t.Fatalf("dark tokens: %v", err)
	}
	lightMedia, err = theme.Block(css, ":root:not([data-theme='dark'])")
	if err != nil {
		t.Fatalf("light tokens (prefers-color-scheme): %v", err)
	}
	lightAttr, err = theme.Block(css, "[data-theme='light']")
	if err != nil {
		t.Fatalf("light tokens (toggle): %v", err)
	}
	return dark, lightMedia, lightAttr
}

// TestContrastFloors is the test that stops a token quietly regressing.
//
// Every value it checks failed at least once: --faint was 4.35 in dark and 3.35
// in light, and --text-dim — which carries every section label in the UI — was
// 3.11 and 2.61. Nobody noticed by looking, which is the point.
func TestContrastFloors(t *testing.T) {
	dark, _, light := load(t)

	for _, tc := range []struct {
		theme  string
		tokens theme.Tokens
	}{
		{"dark", dark},
		{"light", light},
	} {
		for _, ground := range grounds {
			bg, err := tc.tokens.Colour(ground)
			if err != nil {
				t.Fatalf("%s: %v", tc.theme, err)
			}

			for _, set := range []struct {
				names []string
				floor float64
				kind  string
			}{
				{textTokens, textFloor, "text"},
				{structuralTokens, structuralFloor, "structural"},
			} {
				for _, name := range set.names {
					fg, err := tc.tokens.Colour(name)
					if err != nil {
						t.Errorf("%s: %v", tc.theme, err)
						continue
					}
					if got := theme.Contrast(fg, bg); got < set.floor {
						t.Errorf("%s: --%s on --%s is %.2f:1, below the %s floor of %.1f:1",
							tc.theme, name, ground, got, set.kind, set.floor)
					}
				}
			}
		}
	}
}

// TestAccentForegroundIsLegible covers the one pair that is not measured against
// the page: text printed on a filled accent button.
func TestAccentForegroundIsLegible(t *testing.T) {
	dark, _, light := load(t)

	for name, tokens := range map[string]theme.Tokens{"dark": dark, "light": light} {
		accent, err := tokens.Colour("accent")
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		fg, err := tokens.Colour("accent-fg")
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if got := theme.Contrast(fg, accent); got < textFloor {
			t.Errorf("%s: --accent-fg on --accent is %.2f:1, below %.1f:1", name, got, textFloor)
		}
	}
}

// TestDistinctSignals guards the collision this whole package was written for.
//
// --node-world and --danger were byte-identical in both themes and in both
// files that declared them, so "this reaches outside the cluster" and "no policy
// protects this" rendered as the same red. A viewer could not tell the two
// apart, and neither meaning is one you want to guess at.
//
// The pairs here are colours that must never converge, whatever else changes.
func TestDistinctSignals(t *testing.T) {
	dark, _, light := load(t)

	pairs := [][2]string{
		{"node-world", "danger"},
		{"node-world", "node-cidr"},
		{"node-cidr", "node-domain"},
		{"allowed", "approx"},
		{"allowed", "neutral-edge"},
		{"approx", "danger"},
	}

	// Measured in OKLab, not as a contrast ratio.
	//
	// The first version of this test used Contrast, and reported --allowed
	// against --approx as 1.02:1 — the green and the amber have nearly the same
	// luminance and differ almost entirely in hue. That is a property of the
	// metric, not a defect in the palette: nobody confuses those two.
	//
	// 0.08 sits below every intended pair (the tightest is light --node-world
	// against --danger, at 0.099 — orange and red on a white ground) and far
	// above identity. It is a floor against two signals *converging*, not a
	// judgement about whether they read well together.
	const minSeparation = 0.08

	for name, tokens := range map[string]theme.Tokens{"dark": dark, "light": light} {
		for _, pair := range pairs {
			a, err := tokens.Colour(pair[0])
			if err != nil {
				t.Fatalf("%s: %v", name, err)
			}
			b, err := tokens.Colour(pair[1])
			if err != nil {
				t.Fatalf("%s: %v", name, err)
			}
			if a == b {
				t.Errorf("%s: --%s and --%s are the same colour (%v); they mean different things",
					name, pair[0], pair[1], a)
				continue
			}
			if got := theme.Distance(a, b); got < minSeparation {
				t.Errorf("%s: --%s and --%s are %.3f apart in OKLab, too close to tell apart",
					name, pair[0], pair[1], got)
			}
		}
	}
}

// TestLightThemeIsDeclaredIdentically keeps the two light blocks in step.
//
// Light is declared twice on purpose — once under prefers-color-scheme for a
// viewer who has never touched the toggle, once on the attribute for one who
// has. Two copies drift, and the failure is invisible to whichever of the two
// you happen to be testing in.
func TestLightThemeIsDeclaredIdentically(t *testing.T) {
	_, media, attr := load(t)

	names := media.Names()
	slices.Sort(names)
	other := attr.Names()
	slices.Sort(other)

	if !slices.Equal(names, other) {
		t.Fatalf("the two light blocks declare different tokens:\n  media: %v\n  attr:  %v", names, other)
	}
	for _, name := range names {
		if media[name] != attr[name] {
			t.Errorf("--%s is %q under prefers-color-scheme but %q on [data-theme='light']",
				name, media[name], attr[name])
		}
	}
}

// TestThemesDeclareTheSameTokens catches a token added to one theme and
// forgotten in the other, which renders as one theme's colour on the other's
// ground — the classic unreadable-in-light bug.
func TestThemesDeclareTheSameTokens(t *testing.T) {
	dark, _, light := load(t)

	d, l := dark.Names(), light.Names()
	slices.Sort(d)
	slices.Sort(l)

	for _, name := range d {
		if !slices.Contains(l, name) {
			t.Errorf("--%s is declared in dark but not in light", name)
		}
	}
	for _, name := range l {
		if !slices.Contains(d, name) {
			t.Errorf("--%s is declared in light but not in dark", name)
		}
	}
}

func TestContrast(t *testing.T) {
	tests := []struct {
		name string
		a, b string
		want float64
	}{
		{"black on white is the maximum", "#000000", "#ffffff", 21},
		{"a colour against itself is the minimum", "#4699fe", "#4699fe", 1},
		{"order does not matter", "#ffffff", "#000000", 21},
		{"shorthand hex parses", "#fff", "#000", 21},
		{"mid grey on white", "#767676", "#ffffff", 4.54},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			a, err := theme.ParseHex(tc.a)
			if err != nil {
				t.Fatalf("parsing %q: %v", tc.a, err)
			}
			b, err := theme.ParseHex(tc.b)
			if err != nil {
				t.Fatalf("parsing %q: %v", tc.b, err)
			}
			if got := theme.Contrast(a, b); got < tc.want-0.01 || got > tc.want+0.01 {
				t.Errorf("Contrast(%s, %s) = %.2f, want %.2f", tc.a, tc.b, got, tc.want)
			}
		})
	}
}

func TestParseHexRejectsNonsense(t *testing.T) {
	for _, s := range []string{"", "#", "#12", "#12345", "oklch(0.5 0.1 200)", "#gggggg", "red"} {
		if _, err := theme.ParseHex(s); err == nil {
			t.Errorf("ParseHex(%q) succeeded, want an error", s)
		}
	}
}

func TestBlockIsAnchoredOnTheSelector(t *testing.T) {
	const css = `
:root {
  --a: #111111;
}
:root:not([data-theme='dark']) {
  --a: #222222;
}
[data-theme='light'] {
  --a: #333333;
}
[data-theme='light'] .rim {
  box-shadow: none;
}
`
	for _, tc := range []struct{ selector, want string }{
		{":root", "#111111"},
		{":root:not([data-theme='dark'])", "#222222"},
		{"[data-theme='light']", "#333333"},
	} {
		got, err := theme.Block(css, tc.selector)
		if err != nil {
			t.Fatalf("Block(%q): %v", tc.selector, err)
		}
		if got["a"] != tc.want {
			t.Errorf("Block(%q)[a] = %q, want %q", tc.selector, got["a"], tc.want)
		}
	}

	if _, err := theme.Block(css, ":root:not([data-theme='light'])"); err == nil {
		t.Error("Block succeeded for a selector that is not in the stylesheet")
	}
}

func TestColourFollowsOneAlias(t *testing.T) {
	tokens := theme.Tokens{
		"approx": "#efad32",
		"warn":   "var(--approx)",
		"chain":  "var(--warn)",
		"gone":   "var(--nope)",
	}

	got, err := tokens.Colour("warn")
	if err != nil {
		t.Fatalf("Colour(warn): %v", err)
	}
	want, _ := theme.ParseHex("#efad32")
	if got != want {
		t.Errorf("Colour(warn) = %v, want %v", got, want)
	}

	if _, err := tokens.Colour("chain"); err == nil {
		t.Error("Colour followed an alias to another alias; it should refuse")
	}
	if _, err := tokens.Colour("gone"); err == nil {
		t.Error("Colour resolved an alias to an undefined token")
	}
}
