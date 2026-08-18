# Third-party assets

## Lucide icons

`src/graph/lucide-icons.json` contains SVG icons extracted from
[Lucide](https://lucide.dev), used as node pictograms in the graph. They are
recoloured white at extract time so the renderer can tint them, and are otherwise
unmodified.

Lucide is ISC licensed:

```
ISC License

Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part of
Feather (MIT). All other copyright (c) for Lucide are held by Lucide Contributors
2022.

Permission to use, copy, modify, and/or distribute this software for any purpose
with or without fee is hereby granted, provided that the above copyright notice
and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS
OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
THIS SOFTWARE.
```

## Inter

`src/fonts/inter-latin-wght-normal.woff2` is the latin subset of the Inter
variable font, taken unmodified from the `@fontsource-variable/inter` package
(v5.3.0). It is vendored rather than fetched from a CDN at runtime: Marsad runs
inside the cluster it reads, and plenty of those have no egress to a font host —
or a NetworkPolicy forbidding it, which would be a poor look for this tool in
particular.

Inter is licensed under the SIL Open Font License 1.1. The full licence is in
`src/fonts/inter-LICENSE.txt`.

```
Copyright 2016 The Inter Project Authors (https://github.com/rsms/inter)

This Font Software is licensed under the SIL Open Font License, Version 1.1.
```

## JetBrains Mono

`src/fonts/jetbrains-mono-latin-wght-normal.woff2` is the latin subset of the
JetBrains Mono variable font, taken unmodified from the
`@fontsource-variable/jetbrains-mono` package (v5.3.0). It sets ports, policy
names, hostnames and YAML — everything where a character has to be unambiguous.

JetBrains Mono is licensed under the SIL Open Font License 1.1. The full licence
is in `src/fonts/jetbrains-mono-LICENSE.txt`.

```
Copyright 2020 The JetBrains Mono Project Authors
(https://github.com/JetBrains/JetBrainsMono)

This Font Software is licensed under the SIL Open Font License, Version 1.1.
```
