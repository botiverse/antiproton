/**
 * rUI's Elegant dark tokens, inlined for the console.
 *
 * The console is one Worker serving HTML from strings, so it cannot link a
 * stylesheet file; the token scope is a string here instead. It is the
 * [data-theme="elegant"].dark block of raft-ui 0.5.11's dist/styles.css,
 * copied verbatim onto :root (the console is dark only), plus the Source
 * Yellow and pink ramp values those tokens reference and the Elegant font
 * names. Re-copy from the package on upgrade rather than editing here; the
 * report page vendors the same blocks in report/public/rui-foundation.css.
 */
export const RUI_DARK_TOKENS = `:root{
  --color-brutal-yellow-400: oklch(0.883 0.162 91.89);
  --primary-400: var(--color-brutal-yellow-400);
  --primary: var(--primary-400);
  --color-brutal-pink-400: oklch(0.749 0.162 0.71);
  --accent-400: var(--color-brutal-pink-400);
  --accent: var(--accent-400);
  --heading-font: "Inter", system-ui, sans-serif;
  --sans-font: "Geist", system-ui, sans-serif;
  --mono-font: "Geist Mono", ui-monospace, monospace;
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
}`;
