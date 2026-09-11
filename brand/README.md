# antiproton brand

The mark is the physics symbol for the antiproton: a **p with a bar over it**
(p̄). The bar is also the product's story — the line above the agent that
nothing crosses: the gateway holding a call, the credential that never comes
down into context. The wordmark carries the same bar over its own p, so mark
and name share one device.

Cut in the **Brutal** language of rUI, Raft's design system: ink outline,
cream body, the bar in Source Yellow, a hard offset shadow, and the wordmark
in Hanken Grotesk. Every colour is an rUI token converted from oklch. Chosen
by @tygg on 2026-09-11 from the outlined cut of direction A.

## Files

| File | Use |
|---|---|
| `antiproton-mark.svg` | The mark, outlined, self-coloured. The primary form at 32 px and above on light surfaces. |
| `antiproton-mark-flat.svg` | One-colour mark in `currentColor`. For small sizes, dark surfaces, and anywhere the outline cannot hold. |
| `antiproton-wordmark.svg` | "antiproton" outlined, with the bar over the p. Type is outlined to paths; no font needed. |
| `antiproton-wordmark-flat.svg` | One-colour wordmark, `currentColor`. |
| `antiproton-lockup.svg` | Mark and wordmark together, outlined. |
| `antiproton-lockup-flat.svg` | Same lockup, one colour, `currentColor`. Use on dark surfaces. |
| `favicon.svg`, `favicon-{16,32,48,180,512}.png` | Source Yellow tile with an ink flat mark and an ink border, square corners. 180 is the Apple touch icon, 512 the web-manifest size. |
| `antiproton-tile-dark.svg` | The tile for dark surfaces: Elegant-dark canvas, light mark, yellow bar. |
| `antiproton-lockup.png`, `antiproton-lockup-dark.png` | Raster lockups for places that cannot take SVG. |

## Rules

- The outlined cut belongs on light surfaces. On dark surfaces use the flat
  files; Brutal has no dark mode, and an ink outline on ink is nothing.
- Below about 32 px use the flat mark. The outline is five units on a hundred;
  at favicon size it is under a pixel.
- The bar is Source Yellow only in the outlined cut and on tiles. In the flat
  cut the bar is the same colour as the mark, or `--primary-strong` on the
  Elegant themes, never yellow on white.
- Do not restyle the shapes per surface. The geometry is one thing; only the
  treatment (outlined or flat) changes.

## Construction

100-unit box, stroke 14, round caps. Bar from x=27 to x=81 at y=9. Stem at
x=34 from y=36 to y=96. Bowl centred (56, 58), radius 22. Outlined cut: ink
stroke 24 under a body stroke 14, shadow offset (5, 5), and the bowl's hole
knocked out at radius 10 so the stem's outline cannot intrude. The bar's ink
bottom clears the bowl's ink top by three units.

Wordmark: Hanken Grotesk 800, tracking −0.02 em, bar over the p at ascender
height, outlined with the same 10-unit ink stroke.

## Colours (rUI tokens, `raft-ui` 0.5.11 `styles.css`)

| Role | Token | Hex |
|---|---|---|
| ink | `--foreground` (brutal) | `#141110` |
| body | `--layer-card` (brutal) | `#fbfaf8` |
| bar | `--primary-400` Source Yellow | `#ffd441` |
| dark canvas | `--layer-canvas` (elegant dark) | `#141411` |
| dark foreground | `--foreground` (elegant dark) | `#d8d8d5` |
| dark bar | `--primary-strong` (elegant dark) | `#f6d56b` |

## Regenerating

The generator lives with the designer (Nova); it depends on font files fetched
from Google Fonts and on `opentype.js`, neither of which belongs in this
package. Ask in `#design` for a re-cut.
