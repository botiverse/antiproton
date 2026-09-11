/**
 * rUI's Elegant tokens, inlined for the console.
 *
 * The console is one Worker serving HTML from strings, so it cannot link a
 * stylesheet file; the token scopes are a string here instead. They are the
 * Elegant family's scopes of raft-ui 0.5.11's dist/styles.css, copied
 * verbatim (light, the explicit .light and .dark classes, and the
 * prefers-color-scheme fallback), plus the Source Yellow and pink ramp
 * values those scopes reference and the Elegant font names. The page puts
 * data-theme="elegant" on <html> and a .light or .dark class from the
 * viewer's stored choice; with neither, the system decides. Re-copy from the
 * package on upgrade rather than editing here; the report page vendors the
 * same blocks in report/public/rui-foundation.css.
 */
export const RUI_TOKENS = `[data-theme="elegant"]{
  --color-brutal-yellow-400: oklch(0.883 0.162 91.89);
  --primary-400: var(--color-brutal-yellow-400);
  --primary: var(--primary-400);
  --color-brutal-pink-400: oklch(0.749 0.162 0.71);
  --accent-400: var(--color-brutal-pink-400);
  --accent: var(--accent-400);
  --heading-font: "Inter", system-ui, sans-serif;
  --sans-font: "Geist", system-ui, sans-serif;
  --mono-font: "Geist Mono", ui-monospace, monospace;
}
[data-theme="elegant"] {
  --foreground: oklch(0.21 0.006 106.42);
  --foreground-strong: oklch(0.145 0 0);
  --foreground-muted: oklch(0.36 0.006 106.42);
  --foreground-hint: oklch(0.48 0 0);
  --foreground-icon: oklch(0.36 0.006 106.42 / 0.68);
  --foreground-placeholder: oklch(0.58 0.006 106.42);
  --foreground-disabled: oklch(0.7 0.006 106.42);
  --foreground-inverse: oklch(1 0 0);
  --foreground-active: oklch(0.38 0.006 106.42);
  --foreground-hover: oklch(0.42 0.006 106.42);

  --layer-canvas: oklch(1 0 0);
  --layer-canvas-muted: oklch(0.97885053 0.00132105 106.423534);
  --layer-panel: oklch(1 0 0);
  --layer-popover: oklch(1 0 0);
  --layer-backdrop: oklch(0 0 0 / 0.35);
  --layer-inset: oklch(0.99 0.001 106.42);
  --layer-card: oklch(0.985 0.003 84.559);
  --layer-hud: oklch(0.263 0.009 294.9);
  --layer-hud-foreground: oklch(0.965 0.002 286);

  --fill-muted: oklch(0.96743433 0.00132586 106.423534);
  --fill-strong: oklch(0.94883828 0.00133136 106.424517);

  --line-strong: oklch(0.21 0.006 106.42);
  --line: oklch(0.84 0.006 106.42);
  --line-muted: oklch(0.92 0.004 106.42);
  --line-hairline: var(--ink-8);
  --line-field: var(--ink-8);
  --line-field-hover: var(--ink-10);

  --ink: oklch(0.21 0.006 106.42);
  --ink-2: oklch(0.21 0.006 106.42 / 0.02);
  --ink-4: oklch(0.21 0.006 106.42 / 0.04);
  --ink-6: oklch(0.21 0.006 106.42 / 0.06);
  --ink-8: oklch(0.21 0.006 106.42 / 0.08);
  --ink-10: oklch(0.21 0.006 106.42 / 0.1);
  --ink-16: oklch(0.21 0.006 106.42 / 0.16);
  --ink-20: oklch(0.21 0.006 106.42 / 0.2);
  --ink-30: oklch(0.21 0.006 106.42 / 0.3);
  --ink-40: oklch(0.21 0.006 106.42 / 0.4);

  /* Elegant re-tunes the ladder steps; solids and -foreground stay shared. */
  --info-strong: oklch(0.441 0.078 221.2);
  --info-muted: oklch(0.87 0.07 224);
  --info-soft: oklch(0.91 0.056 224.02);
  --success-strong: oklch(0.425 0.113 151.2);
  --success-muted: oklch(0.875 0.13 160);
  --success-soft: oklch(0.913 0.11 159.9);
  --warning-strong: oklch(0.59 0.2 40.57);
  --warning-muted: oklch(0.92 0.045 44.4);
  --warning-soft: oklch(0.95 0.03 44.33);
  --danger-strong: oklch(0.445 0.153 32.91);
  --danger-muted: oklch(0.862 0.065 22.7);
  --danger-soft: oklch(0.898 0.05 22.7);

  --inactive: oklch(0.573 0 0);
  --inactive-foreground: oklch(0.946 0 0);

  --primary-strong: oklch(0.44 0.09 91.39);
  --primary-soft: oklch(0.955 0.067 93.62);
  --primary-edge: oklch(0.83 0.14 91.89 / 0.7);
  --accent-strong: oklch(0.543 0.215 359.77);
  --accent-soft: oklch(0.914 0.048 358.59);

  --theme-shadow-xs: oklch(0.145 0.002 106.42 / 0.071) 0px 0.5px 0px;
  --theme-shadow-sm:
    oklch(0.145 0.002 106.42 / 0.071) 0px 0.5px 0px,
    oklch(0.145 0.002 106.42 / 0.012) 0px 5px 4px -2px,
    oklch(0.145 0.002 106.42 / 0.02) 0px 3px 3px -1px,
    oklch(0.145 0.002 106.42 / 0.039) 0px 1px 2px -1px;
  --theme-shadow-md:
    oklch(0.145 0.002 106.42 / 0.071) 0px 0.5px 0px,
    oklch(0.145 0.002 106.42 / 0.02) 0px 8px 8px -4px,
    oklch(0.145 0.002 106.42 / 0.027) 0px 5px 5px -2px,
    oklch(0.145 0.002 106.42 / 0.039) 0px 2px 3px -1px;
  --theme-shadow-lg:
    0px 1px 1px oklch(0.21 0.006 106.42 / 0.1), 0px 0px 0px 1px oklch(0.21 0.006 106.42 / 0.04),
    0px 2px 12px -4px oklch(0.21 0.006 106.42 / 0.16);
  --theme-shadow-xl:
    oklch(0.145 0.002 106.42 / 0.071) 0px 0.5px 0px,
    0px 0px 0px 1px oklch(0.21 0.006 106.42 / 0.08),
    oklch(0.145 0.002 106.42 / 0.031) 0px 18px 24px -12px,
    oklch(0.145 0.002 106.42 / 0.039) 0px 12px 12px -6px,
    oklch(0.145 0.002 106.42 / 0.039) 0px 4px 6px -3px;
  /* Field metrics — see the Field metric axis note in @theme inline. */
  --field-font-size: 14px;
  --field-font-weight: 400;
  --field-line-height: 20px;
  /* Card-title metrics — see the Card-title metric axis note in @theme inline. */
  --card-title-font-size: 16px;
  --card-title-font-weight: 500;
  --card-title-line-height: 22px;
}

/* Native controls, scrollbars, and portaled scopes follow the stamped class even
   when it disagrees with an ancestor's scheme. */
[data-theme="elegant"].light {
  color-scheme: light;
}

/* Explicit dark tokens are canonical. The media fallback below mirrors this
   block for pre-hydration scopes without a mode class. */
[data-theme="elegant"].dark {
  color-scheme: dark;

  --foreground: oklch(0.88 0.004 106.42);
  --foreground-strong: oklch(0.92 0.003 106.42);
  --foreground-muted: oklch(0.82 0.005 106.42);
  --foreground-hint: oklch(0.76 0.005 106.42);
  --foreground-icon: oklch(0.82 0.005 106.42 / 0.68);
  --foreground-placeholder: oklch(0.72 0.005 106.42);
  --foreground-disabled: oklch(0.65 0.005 106.42);
  --foreground-inverse: oklch(0.145 0 0);
  --foreground-active: oklch(0.88 0.004 106.42);
  --foreground-hover: oklch(0.85 0.004 106.42);

  /* Place ladder: canvas-muted < inset < canvas < card < panel < popover; the fill pair sits
     just above popover. Dark elevation is surface lightness first; shadows are
     a secondary cue. Dark shares the light theme's warm stone hue (106.42) so
     both modes read as the same material. */
  --layer-canvas: oklch(0.19 0.005 106.42);
  --layer-canvas-muted: oklch(0.16 0.005 106.42);
  --layer-panel: oklch(0.26 0.004 106.42);
  --layer-popover: oklch(0.28 0.004 106.42);
  --layer-backdrop: oklch(0 0 0 / 0.6);
  --layer-inset: oklch(0.185 0.003 106.42);
  --layer-card: oklch(0.22 0.004 106.42);
  --layer-hud: oklch(0.23 0.01 294.8);
  --layer-hud-foreground: oklch(0.78 0.006 294.8);

  --fill-muted: oklch(0.315 0.005 106.42);
  --fill-strong: oklch(0.345 0.005 106.42);

  --line-strong: oklch(0.95 0.003 106.42);
  --line: oklch(0.56 0.005 106.42);
  --line-muted: var(--ink-10);
  --line-hairline: var(--ink-6);
  --line-field: var(--ink-16);
  --line-field-hover: var(--ink-20);

  --ink: oklch(0.985 0.004 106.42);
  --ink-2: oklch(0.985 0.004 106.42 / 0.02);
  --ink-4: oklch(0.985 0.004 106.42 / 0.04);
  --ink-6: oklch(0.985 0.004 106.42 / 0.06);
  --ink-8: oklch(0.985 0.004 106.42 / 0.08);
  --ink-10: oklch(0.985 0.004 106.42 / 0.1);
  --ink-16: oklch(0.985 0.004 106.42 / 0.16);
  --ink-20: oklch(0.985 0.004 106.42 / 0.2);
  --ink-30: oklch(0.985 0.004 106.42 / 0.3);
  --ink-40: oklch(0.985 0.004 106.42 / 0.4);

  /* State washes: alpha values composite correctly on page, panel, and
     popover alike. -strong lifts to ~L0.80. */
  --info-strong: oklch(0.8 0.1 220);
  --info-muted: oklch(0.52 0.1 222 / 0.28);
  --info-soft: oklch(0.45 0.09 224 / 0.18);
  --success-strong: oklch(0.8 0.14 153);
  --success-muted: oklch(0.52 0.13 153 / 0.28);
  --success-soft: oklch(0.5 0.12 153 / 0.18);
  --warning-strong: oklch(0.82 0.12 55);
  --warning-muted: oklch(0.55 0.13 50 / 0.28);
  --warning-soft: oklch(0.52 0.12 50 / 0.18);
  --danger-strong: oklch(0.8 0.1 25);
  --danger-muted: oklch(0.58 0.19 29 / 0.3);
  --danger-soft: oklch(0.55 0.19 29 / 0.18);

  --inactive: oklch(0.65 0.004 106.42);
  --inactive-foreground: oklch(0.145 0.002 106.42);

  --primary-strong: oklch(0.88 0.13 92);
  --primary-soft: oklch(0.55 0.1 92 / 0.16);
  --primary-edge: oklch(0.88 0.15 92 / 0.4);
  --accent-strong: oklch(0.84 0.11 0);
  --accent-soft: oklch(0.6 0.18 0 / 0.16);

  /* Dark small elevations follow a top-left light model (lab01 btn-primary):
     a dark outer ring cuts the seam against the background, white lives only
     inside (top-edge light + inner hairline), drops fall off near-to-far.
     lg/xl keep heavy drops — real overlays still need page separation. */
  --theme-shadow-xs:
    inset 0 1px 0 oklch(0.985 0.004 106.42 / 0.045), 0 0 0 1px oklch(0 0 0 / 0.4),
    0 1px 3px oklch(0 0 0 / 0.22);
  --theme-shadow-sm:
    inset 0 1px 0 oklch(0.985 0.004 106.42 / 0.05),
    inset 0 0 0 1px oklch(0.985 0.004 106.42 / 0.03), 0 0 0 1px oklch(0 0 0 / 0.45),
    0 6px 6px -2px oklch(0 0 0 / 0.15), 0 2px 4px oklch(0 0 0 / 0.25);
  --theme-shadow-md:
    inset 0 1px 0 oklch(0.985 0.004 106.42 / 0.05),
    inset 0 0 0 1px oklch(0.985 0.004 106.42 / 0.03), 0 0 0 1px oklch(0 0 0 / 0.45),
    0 10px 10px -4px oklch(0 0 0 / 0.16), 0 4px 6px -2px oklch(0 0 0 / 0.2),
    0 1px 2px oklch(0 0 0 / 0.25);
  --theme-shadow-lg:
    inset 0 1px 0 oklch(0.985 0.004 106.42 / 0.06),
    inset 0 0 0 1px oklch(0.985 0.004 106.42 / 0.04), 0 0 0 1px oklch(0 0 0 / 0.55),
    0 10px 20px -6px oklch(0 0 0 / 0.45), 0 4px 8px -3px oklch(0 0 0 / 0.35);
  --theme-shadow-xl:
    inset 0 1px 0 oklch(0.985 0.004 106.42 / 0.06),
    inset 0 0 0 1px oklch(0.985 0.004 106.42 / 0.04), 0 0 0 1px oklch(0 0 0 / 0.6),
    0 24px 44px -12px oklch(0 0 0 / 0.5), 0 10px 16px -6px oklch(0 0 0 / 0.45),
    0 4px 6px -3px oklch(0 0 0 / 0.4);
}

/* Pre-hydration system fallback; explicit mode classes opt out. Keep this block
   mechanically identical to the explicit dark block above. */
@media (prefers-color-scheme: dark) {
  [data-theme="elegant"]:not(.light):not(.dark) {
    color-scheme: dark;

    --foreground: oklch(0.88 0.004 106.42);
    --foreground-strong: oklch(0.92 0.003 106.42);
    --foreground-muted: oklch(0.82 0.005 106.42);
    --foreground-hint: oklch(0.76 0.005 106.42);
    --foreground-icon: oklch(0.82 0.005 106.42 / 0.68);
    --foreground-placeholder: oklch(0.72 0.005 106.42);
    --foreground-disabled: oklch(0.65 0.005 106.42);
    --foreground-inverse: oklch(0.145 0 0);
    --foreground-active: oklch(0.88 0.004 106.42);
    --foreground-hover: oklch(0.85 0.004 106.42);

    --layer-canvas: oklch(0.19 0.005 106.42);
    --layer-canvas-muted: oklch(0.16 0.005 106.42);
    --layer-panel: oklch(0.26 0.004 106.42);
    --layer-popover: oklch(0.28 0.004 106.42);
    --layer-backdrop: oklch(0 0 0 / 0.6);
    --layer-inset: oklch(0.185 0.003 106.42);
    --layer-card: oklch(0.22 0.004 106.42);
    --layer-hud: oklch(0.23 0.01 294.8);
    --layer-hud-foreground: oklch(0.78 0.006 294.8);

    --fill-muted: oklch(0.315 0.005 106.42);
    --fill-strong: oklch(0.345 0.005 106.42);

    --line-strong: oklch(0.95 0.003 106.42);
    --line: oklch(0.56 0.005 106.42);
    --line-muted: var(--ink-10);
    --line-hairline: var(--ink-6);
    --line-field: var(--ink-16);
    --line-field-hover: var(--ink-20);

    --ink: oklch(0.985 0.004 106.42);
    --ink-2: oklch(0.985 0.004 106.42 / 0.02);
    --ink-4: oklch(0.985 0.004 106.42 / 0.04);
    --ink-6: oklch(0.985 0.004 106.42 / 0.06);
    --ink-8: oklch(0.985 0.004 106.42 / 0.08);
    --ink-10: oklch(0.985 0.004 106.42 / 0.1);
    --ink-16: oklch(0.985 0.004 106.42 / 0.16);
    --ink-20: oklch(0.985 0.004 106.42 / 0.2);
    --ink-30: oklch(0.985 0.004 106.42 / 0.3);
    --ink-40: oklch(0.985 0.004 106.42 / 0.4);

    --info-strong: oklch(0.8 0.1 220);
    --info-muted: oklch(0.52 0.1 222 / 0.28);
    --info-soft: oklch(0.45 0.09 224 / 0.18);
    --success-strong: oklch(0.8 0.14 153);
    --success-muted: oklch(0.52 0.13 153 / 0.28);
    --success-soft: oklch(0.5 0.12 153 / 0.18);
    --warning-strong: oklch(0.82 0.12 55);
    --warning-muted: oklch(0.55 0.13 50 / 0.28);
    --warning-soft: oklch(0.52 0.12 50 / 0.18);
    --danger-strong: oklch(0.8 0.1 25);
    --danger-muted: oklch(0.58 0.19 29 / 0.3);
    --danger-soft: oklch(0.55 0.19 29 / 0.18);

    --inactive: oklch(0.65 0.004 106.42);
    --inactive-foreground: oklch(0.145 0.002 106.42);

    --primary-strong: oklch(0.88 0.13 92);
    --primary-soft: oklch(0.55 0.1 92 / 0.16);
    --primary-edge: oklch(0.88 0.15 92 / 0.4);
    --accent-strong: oklch(0.84 0.11 0);
    --accent-soft: oklch(0.6 0.18 0 / 0.16);

    --theme-shadow-xs:
      inset 0 1px 0 oklch(0.985 0.004 106.42 / 0.045), 0 0 0 1px oklch(0 0 0 / 0.4),
      0 1px 3px oklch(0 0 0 / 0.22);
    --theme-shadow-sm:
      inset 0 1px 0 oklch(0.985 0.004 106.42 / 0.05),
      inset 0 0 0 1px oklch(0.985 0.004 106.42 / 0.03), 0 0 0 1px oklch(0 0 0 / 0.45),
      0 6px 6px -2px oklch(0 0 0 / 0.15), 0 2px 4px oklch(0 0 0 / 0.25);
    --theme-shadow-md:
      inset 0 1px 0 oklch(0.985 0.004 106.42 / 0.05),
      inset 0 0 0 1px oklch(0.985 0.004 106.42 / 0.03), 0 0 0 1px oklch(0 0 0 / 0.45),
      0 10px 10px -4px oklch(0 0 0 / 0.16), 0 4px 6px -2px oklch(0 0 0 / 0.2),
      0 1px 2px oklch(0 0 0 / 0.25);
    --theme-shadow-lg:
      inset 0 1px 0 oklch(0.985 0.004 106.42 / 0.06),
      inset 0 0 0 1px oklch(0.985 0.004 106.42 / 0.04), 0 0 0 1px oklch(0 0 0 / 0.55),
      0 10px 20px -6px oklch(0 0 0 / 0.45), 0 4px 8px -3px oklch(0 0 0 / 0.35);
    --theme-shadow-xl:
      inset 0 1px 0 oklch(0.985 0.004 106.42 / 0.06),
      inset 0 0 0 1px oklch(0.985 0.004 106.42 / 0.04), 0 0 0 1px oklch(0 0 0 / 0.6),
      0 24px 44px -12px oklch(0 0 0 / 0.5), 0 10px 16px -6px oklch(0 0 0 / 0.45),
      0 4px 6px -3px oklch(0 0 0 / 0.4);
  }
}

*,
::before,
::after {
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

body {
  position: relative;
}

`;
