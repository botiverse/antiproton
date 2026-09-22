/**
 * How the contract page names a plugin's capabilities, and nothing else.
 *
 * Its own module because `scripts/plugin-map.ts` prints a page when it is
 * imported, so a test cannot reach the list in there without also emitting
 * 80 KB of HTML into the suite's output. Here it is a value, and a test can run
 * it over a plugin it made up.
 *
 * That mattered the moment the page guard was written (@Rex, 2026-09-22): the
 * guard over the real registry cannot distinguish a column that is stuck on
 * `true` from a column that is right, because every capability we ship today is
 * declared by exactly one plugin — the sandbox — so `declared` is `true` for
 * all three and a hardcoded tag agrees with the truth everywhere. The missing
 * input is a plugin that declares SOME of them, and that is a fixture, not a
 * deployment we have to wait for.
 */
import { backgroundOf, holdingOf, isExclusive, type Plugin } from "../src/plugins/types.ts";

export interface Capability {
  /** The overview's column header, or null for a capability shown only as a tag. */
  label: string | null;
  /** The tag on a plugin's own section, or null when it is a column only. */
  tag: string | null;
  of: (p: Plugin) => boolean;
}

/**
 * Asked through the adapters rather than by name.
 *
 * This list used to say `"exclusive"` and `"release"` and look each up with a
 * string key, so when the 2026-09 refactor moved both inside `holds` every mark
 * and both tags went blank and the page began saying that nothing in the
 * registry holds anything — for two commits, because a string key cannot be
 * wrong at compile time. A function per capability fixes the class: regroup
 * again and this file stops compiling instead of quietly emptying a column.
 */
export const CAPABILITIES: readonly Capability[] = [
  { label: "holds", tag: "holds something releasable", of: (p) => !!holdingOf(p) },
  { label: "background", tag: "can work in the background", of: (p) => !!backgroundOf(p) },
  { label: "provides", tag: null, of: (p) => !!p.provides?.length },
  // A tag and no column: serialisation is DERIVED from `holds` (`isExclusive` is
  // `!!p.holds`), so a column for it would be the `holds` column drawn twice,
  // and two identical columns invite a reader to look for the case where they
  // differ.
  { label: null, tag: "one call at a time", of: isExclusive },
];

/** The column subset, in the order the overview prints them. */
export const CAPABILITY_COLUMNS = CAPABILITIES.filter((c) => c.label);

/** The tags one plugin earns, in list order — what its section is headed with. */
export function capabilityTags(p: Plugin): string[] {
  return CAPABILITIES.filter((c) => c.tag && c.of(p)).map((c) => c.tag!);
}
