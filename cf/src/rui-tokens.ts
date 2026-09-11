/**
 * rUI's tokens, inlined for the console: all three themes.
 *
 * The console is one Worker serving HTML from strings, so it cannot link a
 * stylesheet file; the token scopes are a string here instead. They are
 * copied verbatim from raft-ui 0.5.11's dist/styles.css: the Brutal scope,
 * and the Elegant family's scopes (light, the explicit .light and .dark
 * classes, and the prefers-color-scheme fallback). Ahead of them sits a
 * :root block carrying the ramp values the scopes reference from the
 * package's theme block, the solid state colours, and the shades the
 * console's own recipes use, so every var() resolves in plain CSS; then the
 * two families' font names. The page sets data-theme on <html> to "brutal"
 * or "elegant" and, for elegant, a .light or .dark class, from the viewer's
 * stored choice among rUI's three themes. Re-copy from the package on
 * upgrade rather than editing here.
 *
 * The report page carries its own copy of the Elegant blocks in
 * report/public/rui-foundation.css. As of #57 the two carried the same values
 * for every name they share; nothing keeps them in step, and the report's
 * copy is Dora's, so a change here is a change to tell her about.
 */
export const RUI_TOKENS = `:root{
  --color-black: oklch(0 0 0);
  --color-brutal-cyan-100: oklch(0.945 0.033 226.27);
  --color-brutal-cyan-200: oklch(0.892 0.07 224.23);
  --color-brutal-cyan-400: oklch(0.783 0.135 219.2);
  --color-brutal-cyan-800: oklch(0.348 0.06 219.02);
  --color-brutal-pink-100: oklch(0.936 0.034 2.02);
  --color-brutal-pink-200: oklch(0.871 0.073 0.34);
  --color-brutal-pink-300: oklch(0.808 0.116 0.76);
  --color-brutal-pink-400: oklch(0.749 0.162 0.71);
  --color-brutal-pink-50: oklch(0.968 0.017 359.4);
  --color-brutal-pink-500: oklch(0.662 0.244 0.59);
  --color-brutal-pink-600: oklch(0.565 0.226 0.56);
  --color-brutal-pink-700: oklch(0.456 0.182 0.91);
  --color-brutal-pink-800: oklch(0.354 0.142 0.38);
  --color-brutal-pink-900: oklch(0.246 0.098 0.96);
  --color-brutal-pink-950: oklch(0.198 0.08 359.99);
  --color-brutal-red-100: oklch(0.926 0.034 20.05);
  --color-brutal-red-200: oklch(0.854 0.072 22.92);
  --color-brutal-red-800: oklch(0.331 0.11 33.1);
  --color-brutal-stone-100: oklch(0.947 0.003 67.83);
  --color-brutal-stone-200: oklch(0.896 0.008 73.73);
  --color-brutal-stone-300: oklch(0.845 0.014 71.31);
  --color-brutal-stone-400: oklch(0.789 0.014 71.29);
  --color-brutal-stone-50: oklch(0.974 0.002 67.9);
  --color-brutal-stone-500: oklch(0.682 0.012 76.55);
  --color-brutal-stone-600: oklch(0.569 0.01 67.63);
  --color-brutal-stone-700: oklch(0.466 0.008 67.63);
  --color-brutal-stone-800: oklch(0.354 0.007 67.62);
  --color-brutal-stone-900: oklch(0.249 0.005 67.61);
  --color-brutal-stone-950: oklch(0.187 0.003 67.68);
  --color-brutal-yellow-100: oklch(0.975 0.027 85.64);
  --color-brutal-yellow-200: oklch(0.94 0.066 86.23);
  --color-brutal-yellow-300: oklch(0.913 0.103 88.02);
  --color-brutal-yellow-400: oklch(0.883 0.162 91.89);
  --color-brutal-yellow-50: oklch(0.984 0.017 84.56);
  --color-brutal-yellow-500: oklch(0.759 0.155 92.93);
  --color-brutal-yellow-600: oklch(0.637 0.13 92.64);
  --color-brutal-yellow-700: oklch(0.508 0.104 92.9);
  --color-brutal-yellow-800: oklch(0.388 0.08 93.41);
  --color-brutal-yellow-900: oklch(0.26 0.053 92.86);
  --color-brutal-yellow-950: oklch(0.199 0.041 93.21);
  --primary-400: var(--color-brutal-yellow-400);
  --primary: var(--primary-400);
  --primary-950: var(--color-brutal-yellow-950);
  --accent-400: var(--color-brutal-pink-400);
  --accent: var(--accent-400);
  --accent-500: var(--color-brutal-pink-500);
  --accent-950: var(--color-brutal-pink-950);
  --info: var(--color-brutal-cyan-400);
  --success: oklch(0.714 0.176 153.079);
  --success-foreground: oklch(1 0 0);
  --warning: oklch(0.7 0.202 44.441);
  --warning-foreground: oklch(1 0 0);
  --danger: oklch(0.616 0.249 26.758);
  --danger-foreground: oklch(1 0 0);
}
[data-theme="brutal"]{
  --heading-font: "Hanken Grotesk", system-ui, sans-serif;
  --sans-font: "Hanken Grotesk", system-ui, sans-serif;
  --mono-font: "Geist Mono", ui-monospace, monospace;
}
[data-theme="elegant"]{
  --heading-font: "Inter", system-ui, sans-serif;
  --sans-font: "Geist", system-ui, sans-serif;
  --mono-font: "Geist Mono", ui-monospace, monospace;
}
[data-theme="brutal"] {
  --foreground: oklch(0.18 0.006 25);
  --foreground-strong: oklch(0.18 0.006 25);
  --foreground-muted: oklch(0.18 0.006 25 / 0.6);
  --foreground-hint: oklch(0.48 0 0);
  --foreground-icon: oklch(0.18 0.006 25 / 0.68);
  --foreground-placeholder: oklch(0.18 0.006 25 / 0.5);
  --foreground-disabled: oklch(0.18 0.006 25 / 0.3);
  --foreground-inverse: oklch(1 0 0);
  --foreground-active: oklch(0.38 0.006 106.42);
  --foreground-hover: oklch(0.42 0.006 106.42);

  --layer-canvas: oklch(1 0 0);
  --layer-canvas-muted: oklch(1 0 0);
  --layer-panel: oklch(1 0 0);
  --layer-popover: oklch(1 0 0);
  --layer-backdrop: oklch(0 0 0 / 0.65);
  /* inset = recessed zone inside a surface (code blocks, dialog header/footer
     bands, attachment wells); card = bordered embed sitting on a surface
     (message embeds, reply/quote previews). */
  --layer-inset: oklch(0.99 0.002 84.559);
  --layer-card: oklch(0.985 0.003 84.559);
  --layer-hud: oklch(0.263 0.009 294.9);
  --layer-hud-foreground: oklch(0.965 0.002 286);

  /* The fills are the old brutal alpha washes flattened over white
     (gamma-space, pixel-identical on white). */
  --fill-muted: oklch(0.9645 0.0002 25);
  --fill-strong: oklch(0.9389 0 0);

  --line-strong: oklch(0.18 0.006 25);
  --line: oklch(0.18 0.006 25);
  --line-muted: oklch(0.18 0.006 25 / 0.3);
  --line-hairline: oklch(0.18 0.006 25 / 0.15);

  /* Field-scoped tokens shared by input, input-group, and textarea. */
  --line-field: var(--ink-8);
  --line-field-hover: var(--ink-10);

  /* Ink overlay ramp — step suffix = alpha %. For fills, hairlines, hover/active washes. */
  --ink: oklch(0 0 0);
  --ink-2: oklch(0 0 0 / 0.02);
  --ink-4: oklch(0 0 0 / 0.04);
  --ink-6: oklch(0 0 0 / 0.06);
  --ink-8: oklch(0 0 0 / 0.08);
  --ink-10: oklch(0 0 0 / 0.1);
  --ink-16: oklch(0 0 0 / 0.16);
  --ink-20: oklch(0 0 0 / 0.2);
  --ink-30: oklch(0 0 0 / 0.3);
  --ink-40: oklch(0 0 0 / 0.4);

  --primary-50: var(--color-brutal-yellow-50);
  --primary-100: var(--color-brutal-yellow-100);
  --primary-200: var(--color-brutal-yellow-200);
  --primary-300: var(--color-brutal-yellow-300);
  --primary-400: var(--color-brutal-yellow-400);
  --primary-500: var(--color-brutal-yellow-500);
  --primary-600: var(--color-brutal-yellow-600);
  --primary-700: var(--color-brutal-yellow-700);
  --primary-800: var(--color-brutal-yellow-800);
  --primary-900: var(--color-brutal-yellow-900);
  --primary-950: var(--color-brutal-yellow-950);

  --accent-50: var(--color-brutal-pink-50);
  --accent-100: var(--color-brutal-pink-100);
  --accent-200: var(--color-brutal-pink-200);
  --accent-300: var(--color-brutal-pink-300);
  --accent-400: var(--color-brutal-pink-400);
  --accent-500: var(--color-brutal-pink-500);
  --accent-600: var(--color-brutal-pink-600);
  --accent-700: var(--color-brutal-pink-700);
  --accent-800: var(--color-brutal-pink-800);
  --accent-900: var(--color-brutal-pink-900);
  --accent-950: var(--color-brutal-pink-950);

  --secondary-50: var(--color-brutal-stone-50);
  --secondary-100: var(--color-brutal-stone-100);
  --secondary-200: var(--color-brutal-stone-200);
  --secondary-300: var(--color-brutal-stone-300);
  --secondary-400: var(--color-brutal-stone-400);
  --secondary-500: var(--color-brutal-stone-500);
  --secondary-600: var(--color-brutal-stone-600);
  --secondary-700: var(--color-brutal-stone-700);
  --secondary-800: var(--color-brutal-stone-800);
  --secondary-900: var(--color-brutal-stone-900);
  --secondary-950: var(--color-brutal-stone-950);

  /* State families — brutal-parity slot values. Solids and -foreground are
     theme-invariant; each theme re-tunes the ladder steps. */
  --info: var(--color-brutal-cyan-400);
  --info-strong: var(--color-brutal-cyan-800);
  --info-muted: var(--color-brutal-cyan-200);
  --info-soft: var(--color-brutal-cyan-100);

  --success: oklch(0.714 0.176 153.079);
  --success-foreground: oklch(1 0 0);
  --success-strong: oklch(0.366 0.09 153.079);
  --success-muted: oklch(0.91 0.149 153.079);
  --success-soft: oklch(0.949 0.079 153.079);

  --warning: oklch(0.7 0.202 44.441);
  --warning-foreground: oklch(1 0 0);
  --warning-strong: oklch(0.366 0.106 44.441);
  --warning-muted: oklch(0.91 0.05 44.441);
  --warning-soft: oklch(0.949 0.027 44.441);

  --danger: oklch(0.616 0.249 26.758);
  --danger-foreground: oklch(1 0 0);
  --danger-strong: var(--color-brutal-red-800);
  --danger-muted: var(--color-brutal-red-200);
  --danger-soft: var(--color-brutal-red-100);

  --inactive: oklch(0.573 0 0);
  --inactive-foreground: oklch(0.946 0 0);

  /* Brand ladder steps + the shared primary ring edge. */
  --primary-strong: oklch(0.44 0.09 91.39);
  --primary-soft: oklch(0.955 0.067 93.62);
  --primary-edge: oklch(0.83 0.14 91.89 / 0.7);
  --primary-glow: oklch(0.85 0.162 91.89);
  --accent-strong: oklch(0.543 0.215 359.77);
  --accent-soft: oklch(0.914 0.048 358.59);

  /* Interaction axis — resting color ⊕ ink, resolves per-theme at use point.
     Families opt in as components need them; an opted-in family always gets the full hover/active pair. */
  --primary-hover: color-mix(in srgb-linear, var(--primary-400) 92%, var(--ink));
  --primary-active: color-mix(in srgb-linear, var(--primary-400) 84%, var(--ink));
  --accent-hover: color-mix(in srgb-linear, var(--accent-400) 92%, var(--ink));
  --accent-active: color-mix(in srgb-linear, var(--accent-400) 84%, var(--ink));
  --info-hover: color-mix(in srgb-linear, var(--info) 84%, var(--ink));
  --info-active: color-mix(in srgb-linear, var(--info) 76%, var(--ink));
  --warning-hover: color-mix(in srgb-linear, var(--warning) 84%, var(--ink));
  --warning-active: color-mix(in srgb-linear, var(--warning) 76%, var(--ink));
  --danger-hover: color-mix(in srgb-linear, var(--danger) 84%, var(--ink));
  --danger-active: color-mix(in srgb-linear, var(--danger) 76%, var(--ink));

  --theme-shadow-xs: 1px 1px 0px var(--line-strong);
  --theme-shadow-sm: 2px 2px 0px var(--line-strong);
  --theme-shadow-md: 4px 4px 0px var(--line-strong);
  --theme-shadow-lg: 4px 4px 0px var(--color-black);
  --theme-shadow-xl: 6px 6px 0px var(--line-strong);
  /* Field metrics — see the Field metric axis note in @theme inline. */
  --field-font-size: 16px;
  --field-font-weight: 400;
  --field-line-height: 24px;
  /* Card-title metrics — see the Card-title metric axis note in @theme inline. */
  --card-title-font-size: 18px;
  --card-title-font-weight: 700;
  --card-title-line-height: 20px;
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
