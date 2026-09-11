# antiproton brand — candidate 1

The mark is the physics symbol for the antiproton: a **p with a bar over it**
(p̄). The bar is also the product's story — the line above the agent that
nothing crosses: the gateway holding a call, the credential that never comes
down into context. The wordmark carries the same bar over its own p, so mark
and name share one device.

Chosen by @tygg on 2026-09-11 from three directions as the first candidate.
Not final: a second candidate may follow, and the palette below is the report
page's, pending a decision on adopting rUI (whose tokens would change the
colours, not the shapes).

## Files

| File | Use |
|---|---|
| `antiproton-mark.svg` | The mark alone. Draws in `currentColor`; set `color` on it or a parent. |
| `antiproton-wordmark.svg` | "antiproton" in Familjen Grotesk 600 with the bar over the p, outlined to paths (no font needed). `currentColor`. |
| `antiproton-lockup.svg` | Mark and wordmark together, mark at full wordmark height, one x-height of gap. `currentColor`. |
| `favicon.svg`, `favicon-{16,32,48,180,512}.png` | Accent tile with a white mark. 180 is the Apple touch icon size, 512 the web-manifest size. |
| `antiproton-tile-dark.svg` | The same tile for dark surfaces: dark ground, light accent mark. |
| `antiproton-lockup.png`, `antiproton-lockup-dark.png` | Raster lockups for places that cannot take SVG (light and dark). |

## Construction

100-unit box. Stroke 14 throughout (a third of the x-height, matching the
weight of Familjen Grotesk 600's stems). Stem at x=34 from y=30 to y=96, bowl
centred (56, 52) with radius 22, bar from x=27 to x=81 at y=15. Butt caps. The
bar spans stem-left to bowl-right, as the physics notation centres it over the
glyph.

## Colours

From `report/public/index.html`: ink `#131C1B`, accent `#0E6E63` (light);
ink `#E1EAE8`, accent `#4FC9B7`, ground `#0E1413` (dark). The mark is one
colour; the favicon puts a white mark on the accent.

## Regenerating

The generator lives with the designer (Nova) rather than in the repo: it
depends on font files fetched from Google Fonts and on `opentype.js`, neither
of which belongs in this package. Ask in `#design` for a re-cut.
