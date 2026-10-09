/**
 * The two rules of the state plugin (src/plugins/state.ts) that a key written from outside the plugin must follow
 * too: what a key may look like, and the size above which a value is spilled to object storage rather than kept in
 * its row. A workspace file seeded through the provider route (src/store/seed-files.ts) becomes a working copy at
 * key = its path, read back by the plugin's `get`, so a path the plugin would refuse, or a value kept inline that the
 * plugin would have spilled, would be a key that behaves differently from one the agent wrote itself.
 *
 * src/plugins/state.ts still declares its own `KEY` and `INLINE_MAX` with these values; test/eval-seed.ts holds the
 * two to the same answers by asking the plugin itself, until state.ts imports them from here.
 */

/** A state key: a letter or digit, then up to 127 of letters, digits, `.`, `_`, `/` and `-`. */
export const STATE_KEY = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;

/** Above this length of the value's JSON, the plugin spills the value to object storage and keeps a reference. */
export const STATE_INLINE_MAX = 32 * 1024;
