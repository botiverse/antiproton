/**
 * Check a mount's settings against what its plugin says it takes.
 *
 * The failure this exists for is the quiet one. A mount carrying `timeout_ms`
 * where the plugin reads `timeoutMs` is not rejected by anything — the plugin
 * simply uses its default, for ever, and the symptom shows up somewhere else
 * entirely as "why is this timing out at two minutes". The same goes for a
 * mount whose plugin needs an account and has no `secret_ref`: it looks exactly
 * like a working mount until an agent calls something and gets a 401 it cannot
 * do anything about.
 *
 * So the check runs when the mount is written, where a person is present to
 * read the answer, rather than at dispatch where only the agent is.
 *
 * Unknown keys are refused rather than warned about. A typo that is tolerated
 * is a typo that survives, and there is no case where silently ignoring a
 * setting someone deliberately wrote is the helpful thing to do.
 */
import type { ConfigField, Plugin } from "../plugins/types.ts";
import type { Json } from "../core/types.ts";

export interface MountProblem {
  key?: string;
  message: string;
}

const typeOf = (v: unknown): ConfigField["type"] | "unknown" => {
  if (typeof v === "string") return "string";
  if (typeof v === "number") return "number";
  if (typeof v === "boolean") return "boolean";
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) return "string[]";
  return "unknown";
};

/** Levenshtein distance, capped: only used to say "did you mean". */
function near(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > 3) return 99;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j]! + 1, cur[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[n]!;
}

export function validateMount(
  plugin: Pick<Plugin, "id" | "config" | "credential">,
  publicConfig: Record<string, Json> | null | undefined,
  secretRef: string | null | undefined,
): MountProblem[] {
  const problems: MountProblem[] = [];
  const fields = plugin.config ?? [];
  const known = new Map(fields.map((f) => [f.name, f]));
  const given = publicConfig ?? {};

  for (const [key, value] of Object.entries(given)) {
    // `account` is the console's own label for who a mount belongs to and is
    // set on every mount, including plugins that declare no settings at all.
    if (key === "account") continue;
    const field = known.get(key);
    if (!field) {
      // Nothing declared means the plugin takes no settings yet, and refusing
      // every key would break every mount that already carries one.
      if (!fields.length) continue;
      const guess = [...known.keys()]
        .map((k) => [k, near(key, k)] as const)
        .filter(([, d]) => d <= 2)
        .sort((a, b) => a[1] - b[1])[0];
      problems.push({
        key,
        message: `${plugin.id} has no setting "${key}"` + (guess ? ` — did you mean "${guess[0]}"?` : ""),
      });
      continue;
    }
    if (value === null || value === undefined) continue;
    const actual = typeOf(value);
    if (actual !== field.type) {
      problems.push({ key, message: `"${key}" should be ${field.type}, got ${actual}` });
      continue;
    }
    if (field.choices && !field.choices.includes(String(value))) {
      problems.push({ key, message: `"${key}" should be one of ${field.choices.join(", ")}` });
    }
  }

  for (const f of fields) {
    if (f.required && given[f.name] === undefined) {
      problems.push({ key: f.name, message: `${plugin.id} needs "${f.name}": ${f.summary}` });
    }
    // A setting that is advice without a key and a boundary with one. Checked
    // against the mount's `secret_ref` rather than against the plugin's
    // declaration, because what matters is whether *this* mount holds a
    // credential, not whether the plugin can take one.
    if (f.requiredWithCredential && secretRef) {
      const v = given[f.name];
      const missing = v === undefined || v === null || (Array.isArray(v) && v.length === 0);
      if (missing) {
        problems.push({
          key: f.name,
          message: `${plugin.id} carries a credential, so "${f.name}" must be set: ${f.summary}`,
        });
      }
    }
  }

  const cred = plugin.credential;
  if (cred?.required && !secretRef) {
    problems.push({
      message: `${plugin.id} needs an account and this mount has no secret_ref — ${cred.summary}`,
    });
  }

  return problems;
}

/** The same check, as the thing a caller actually wants to do with it. */
export function assertMountConfig(
  plugin: Pick<Plugin, "id" | "config" | "credential">,
  publicConfig: Record<string, Json> | null | undefined,
  secretRef: string | null | undefined,
): void {
  const problems = validateMount(plugin, publicConfig, secretRef);
  if (problems.length) {
    throw new Error(`cannot mount ${plugin.id}: ${problems.map((p) => p.message).join("; ")}`);
  }
}
