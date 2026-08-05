# Brand

`source.png` is the mark as an image model rendered it — a soft raster with the
shells separated by grooves in a lighter navy, and a glow around the silhouette.
None of that survives being shrunk to a favicon or filled in one flat colour, so
the shipped mark is a vector rebuild of it: `trace.py` holds the measured curves
and emits the paths.

| File | Use |
| --- | --- |
| `mark.svg` | The mark on a dark background, two colours. |
| `mark-onlight.svg` | The same on a light background. |
| `mark-mono.svg` | One flat colour. The sky is a hole, not a fill. |
| `mark-512.png` | Raster, for anywhere that will not take SVG. |
| `source.png` | What was generated, kept for provenance. |

The in-app mark is `web/src/components/Mark.tsx`, which takes `currentColor` for
the shell and the accent token for the sky so it follows the theme. The favicons
in `web/public` use a heavier groove than the app mark: at sixteen pixels the
measured gaps close up, and a mark that fills in is worse than one drawn a little
bolder than its source.

To change the geometry, edit the tables in `trace.py` and run it — it needs only
Pillow-free CPython:

    docker run --rm -v "$PWD/docs/brand":/w -w /w python:3.12-slim python trace.py

The brief the mark was generated from is in `docs/brand-prompt.md`.
