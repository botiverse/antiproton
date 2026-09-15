/**
 * What the console is handed about each mount that has something to say, and the one check it passes on the way in.
 *
 * Named rather than left as `any`, because the producer *knows*: `#mountReports` (cf/src/index.ts) builds it out of
 * two contract types it already has (Rex's correction). But what reaches the page is JSON that crossed a Durable
 * Object boundary, and no type can promise what arrives. So the split is: exact where it is built, checked where it
 * is parsed — here, once, and the page reads the result (Rex and Nova, 2026-09-15).
 *
 * The check is every field the two contract types declare, so a value that passes cannot hand the page an
 * `undefined` the type says is present. What cannot be read is left out rather than repaired: a usage row that does
 * not read is dropped and the rest are kept; a mount whose activity does not read is not reported. The page then
 * draws less, never something wrong. Only declared fields are copied, so nothing else a producer attached reaches the
 * page. Depends on: src/plugins/types.ts MountActivity and MountUsage — a field added there is checked here.
 */
import type { MountActivity, MountUsage } from "../../src/plugins/types.ts";

export type MountReports = Record<string, { activity: MountActivity; usage: MountUsage[] }>;

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function asActivity(v: unknown): MountActivity | null {
  if (!isObj(v)) return null;
  let live: MountActivity["live"] = null;
  if (v.live !== null && v.live !== undefined) {
    const l = v.live;
    if (!isObj(l) || typeof l.id !== "string" || !isNum(l.startedAt) || !isNum(l.lastUsedAt)) return null;
    live = { id: l.id, startedAt: l.startedAt, lastUsedAt: l.lastUsedAt };
  }
  if (v.quietUntil !== undefined && v.quietUntil !== null && !isNum(v.quietUntil)) return null;
  if (v.billing !== undefined && typeof v.billing !== "string") return null;
  return {
    live,
    ...(v.quietUntil !== undefined ? { quietUntil: v.quietUntil as number | null } : {}),
    ...(v.billing !== undefined ? { billing: v.billing as string } : {}),
  };
}

function asUsage(v: unknown): MountUsage | null {
  if (!isObj(v)) return null;
  if (typeof v.id !== "string" || !isNum(v.startedAt) || !isNum(v.endedAt) || !isNum(v.lastUsedAt)) return null;
  if (v.uses !== undefined && !isNum(v.uses)) return null;
  if (v.kept !== undefined && !(Array.isArray(v.kept) && v.kept.every((k) => typeof k === "string"))) return null;
  return {
    id: v.id, startedAt: v.startedAt, endedAt: v.endedAt, lastUsedAt: v.lastUsedAt,
    ...(v.uses !== undefined ? { uses: v.uses as number } : {}),
    ...(v.kept !== undefined ? { kept: v.kept as string[] } : {}),
  };
}

/** The reports as the contract types describe them, or null when the payload is not a reports object at all. */
export function asMountReports(d: unknown): MountReports | null {
  if (!isObj(d)) return null;
  const out: MountReports = {};
  for (const [alias, rep] of Object.entries(d)) {
    if (!isObj(rep)) continue;
    const activity = asActivity(rep.activity);
    if (!activity) continue;
    const usage = Array.isArray(rep.usage)
      ? rep.usage.map(asUsage).filter((u): u is MountUsage => u !== null)
      : [];
    out[alias] = { activity, usage };
  }
  return out;
}
