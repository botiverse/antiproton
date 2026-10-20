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
import { headerLinesProblem, originProblem, type ConfigField, type Plugin } from "../plugins/types.ts";
import type { Json } from "../core/types.ts";

/**
 * One setting's value, of a declared `ConfigField["type"]`. Narrower than `Json` on purpose: a result that carries
 * settings across a Durable Object stub (`PATCH /admin/mounts`) has to be a type the RPC layer can serialize, and the
 * recursive `Json` is not one to it, which drops that variant of the result from the stub's type.
 */
export type SettingValue = string | number | boolean | string[] | null;

export interface MountProblem {
  key?: string;
  message: string;
}

/**
 * The `ConfigField["type"]` a value is, or `"unknown"`.
 *
 * Exported because the deletion in `MountSettingsPatch` rests on what it answers:
 * `null` is an operation rather than a value only while it is `"unknown"` here.
 * `test/mount-settings.ts` asks it directly, so a type that could hold null
 * reddens there instead of making `null` mean two things.
 */
export const settingType = (v: unknown): ConfigField["type"] | "unknown" => {
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
  plugin: Pick<Plugin, "id" | "config" | "credential" | "configProblem">,
  publicConfig: Record<string, Json> | null | undefined,
  secretRef: string | null | undefined,
): MountProblem[] {
  const problems: MountProblem[] = [];
  const fields = plugin.config ?? [];
  const known = new Map(fields.map((f) => [f.name, f]));
  const given = publicConfig ?? {};

  for (const [key, value] of Object.entries(given)) {
    // `account` belongs to no plugin, and not to the console either: the catalogue writes it
    // (`DEFAULT_MOUNTS`, cf/src/runtime.ts), the model reads it as that mount's `label`
    // (`tools.mounts` in src/plugins/builtin.ts), and an operator reads it in `/admin/diagnose`.
    // The console's own panel filters it out of the settings rows and shows instead whether an
    // account is attached, so "the console relies on it" would name a reader that does not exist.
    if (key === "account") continue;
    const field = known.get(key);
    if (!field) {
      // A plugin that declares no settings takes none. This used to accept every
      // key, on the reasoning that refusing them would break mounts that already
      // carry one (#994) — but a setting is public: it is rendered in the console
      // and handed to the model by `tools.mounts` (src/plugins/builtin.ts), so
      // "nothing is declared, so nothing is checked" left the one promise that
      // makes a setting safe unguarded on exactly the plugins nobody was looking
      // at (github, artifacts, tools, demo). `account` stays: it belongs to no plugin, it is the
      // catalogue's label for who a mount is (see above).
      if (!fields.length) {
        problems.push({ key, message: `${plugin.id} takes no settings, so a mount of it cannot carry "${key}"` });
        continue;
      }
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
    const actual = settingType(value);
    if (actual !== field.type) {
      problems.push({ key, message: `"${key}" should be ${field.type}, got ${actual}` });
      continue;
    }
    if (field.choices && !field.choices.includes(String(value))) {
      problems.push({ key, message: `"${key}" should be one of ${field.choices.join(", ")}` });
    }
    const bad = field.format === "origin" && typeof value === "string" ? originProblem(value) : null;
    if (bad) problems.push({ key, message: `"${key}" ${bad}` });
    if (field.format === "header-lines") {
      const lines = headerLinesProblem(value);
      if (lines) problems.push({ key, message: `"${key}": ${lines}` });
    }
    if (typeof value === "number" && ((field.min !== undefined && value < field.min) || (field.max !== undefined && value > field.max))) {
      problems.push({ key, message: `"${key}" must be between ${field.min ?? "-∞"} and ${field.max ?? "∞"}, got ${value}` });
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
  // `secretRef` here is the NAME in the mount record, never the result of resolving it. That is what
  // lets this sentence say "has no secret_ref" and be true: EVERY caller passes the stored row rather
  // than a resolved value. The callers live in `cf/src/index.ts` and `cf/src/runtime.ts`, plus the
  // forward from `assertMountConfig` below, and the set is closed because neither name is re-exported
  // or alias-bound.
  //
  // No count and no command here, and that is the third try. "Five call sites" was wrong (six, if the
  // forward counts, which is itself the ambiguity). Then a `git grep` was offered as "the whole set" —
  // but unscoped it returns 34 lines, mostly from a test; and once scoped, THE COMMENT ITSELF MATCHED
  // THE PATTERN, so the sentence changed its own answer from eight to nine. A number invites a reader
  // to doubt it; a command invites them to run it and hand back something that looks like an answer.
  // A reference that exists but cannot be
  // read is a different situation with a different person to fetch, and `credentialState()` in
  // src/plugins/types.ts is what says that one — not this.
  if (cred?.required && !secretRef) {
    problems.push({
      message: `${plugin.id} needs an account and this mount has no secret_ref — ${cred.summary}`,
    });
  }

  // The plugin's own rule (`Plugin.configProblem`), asked here so that every path that judges a
  // mount's settings asks it too: adding one (console, `/admin/mounts`), seeding one
  // (`assertMountConfig` in provisioning), reconciling one, attaching a credential to one, and the
  // console's problems column. Only once every setting is declared, typed and present, which is what
  // the hook is promised; a missing account is not about the settings and does not hold it back.
  if (plugin.configProblem && !problems.some((p) => p.key !== undefined)) {
    const own = plugin.configProblem(given);
    if (own) problems.push({ message: own });
  }

  return problems;
}

/** The same check, as the thing a caller actually wants to do with it. */
export function assertMountConfig(
  plugin: Pick<Plugin, "id" | "config" | "credential" | "configProblem">,
  publicConfig: Record<string, Json> | null | undefined,
  secretRef: string | null | undefined,
): void {
  const problems = validateMount(plugin, publicConfig, secretRef);
  if (problems.length) {
    throw new Error(`cannot mount ${plugin.id}: ${problems.map((p) => p.message).join("; ")}`);
  }
}

/**
 * A mount's settings from a form (`/ui/mount/add`): one field per declared
 * setting, each a string, coerced to the type the plugin declared, so the
 * result is judged by `validateMount` like any other config.
 *
 * - `string`: trimmed.
 * - `string[]`: one entry per line, each trimmed, blank lines dropped.
 * - `number`: `Number()` of the trimmed text; anything that is not a finite
 *   number is refused here, because `NaN` is a number to the type check and
 *   slips past `min`/`max`, every comparison with it being false.
 * - `boolean`: `true`/`on`/`1` or `false`/`off`/`0`.
 *
 * Empty after that means absent, so a field left blank takes the plugin's
 * default. Only declared settings are read: the form's other fields (the
 * alias, the plugin, the agent) are not settings.
 */
export function configFromForm(
  fields: readonly ConfigField[], form: Readonly<Record<string, string>>,
): { ok: true; config: Record<string, Json> } | { ok: false; error: string } {
  const config: Record<string, Json> = {};
  for (const f of fields) {
    const raw = form[f.name];
    if (typeof raw !== "string") continue;
    const text = raw.trim();
    if (f.type === "string[]") {
      const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
      if (lines.length) config[f.name] = lines;
      continue;
    }
    if (!text) continue;
    if (f.type === "number") {
      const n = Number(text);
      if (!Number.isFinite(n)) return { ok: false, error: `"${f.name}" should be a number, got ${JSON.stringify(text.slice(0, 40))}` };
      config[f.name] = n;
    } else if (f.type === "boolean") {
      const b = /^(true|on|1)$/i.test(text) ? true : /^(false|off|0)$/i.test(text) ? false : null;
      if (b === null) return { ok: false, error: `"${f.name}" should be true or false` };
      config[f.name] = b;
    } else {
      config[f.name] = text;
    }
  }
  return { ok: true, config };
}

/**
 * Whether adding `asked` repeats the mount stored as `have`: every setting it
 * names is stored with that value, and every stored setting it does not name
 * is one an operator may change in place (`ConfigField.changeable`). So a
 * setting changed through `PATCH /admin/mounts` is kept when the mount is
 * asked for again without it — provisioning re-adopts the raft mount with
 * `serverUrl` alone on every PATCH of an agent — while a request that names a
 * different value, or a stored setting that is the mount's identity, is still
 * another mount.
 */
export function repeatsMount(
  plugin: Pick<Plugin, "config"> | undefined,
  have: Record<string, Json> | null | undefined,
  asked: Record<string, Json> | null | undefined,
): boolean {
  const stored = have ?? {}, wanted = asked ?? {};
  const changeable = new Set((plugin?.config ?? []).filter((f) => f.changeable).map((f) => f.name));
  for (const [key, value] of Object.entries(wanted)) {
    if (!(key in stored) || JSON.stringify(stored[key]) !== JSON.stringify(value)) return false;
  }
  return Object.keys(stored).every((key) => key in wanted || changeable.has(key));
}

/**
 * A change to a mount's settings: what an operator sends to
 * `PATCH /admin/mounts`, keyed by setting name.
 *
 * **`null` is an operation, not a value.** A key left out means "leave it as
 * it is"; a key given `null` means "remove it"; a key given a value means "set
 * it". That reading is only unambiguous because **no `ConfigField["type"]` can
 * hold null** (`src/plugins/types.ts`) — `settingType(null)` answers `"unknown"`
 * — so a null could never have meant "the value is null". (`SettingValue` does
 * list `null`: it is the type a setting's value crosses a Durable Object stub as.
 * But it is not a *declared* field type: no `ConfigField` may say `null`, which is
 * the half this rule rests on.) A
 * nullable field type would break this, which is why `test/mount-settings.ts`
 * asks `settingType(null)` directly: the day a type can be null, that case reddens
 * and this rule has to be decided again rather than silently doing one thing
 * where the caller meant the other.
 *
 * The point of the delete is repair, not tidiness. A mount can hold a key its
 * plugin never declared — `POST /admin/mounts` writes the body through, and an
 * older build may have declared a setting since removed — and until #994
 * nothing could take one back out: `PATCH` refused every key it could not type,
 * and `addMount` refuses to overwrite a mount that differs. So one stray key
 * froze the mount's *every* setting, because the merged whole is validated and
 * the stray key failed it whatever else the patch named.
 */
export type MountSettingsPatch = Partial<Record<string, SettingValue | null>>;

/**
 * A mount's settings with `settings` merged in, for an operator changing them
 * on a mount that exists (`PATCH /admin/mounts`), with `MountSettingsPatch`'s
 * reading of `null` as a deletion. For a key the plugin declares: only
 * `changeable` ones, each of its declared type. For one it does not declare:
 * only a deletion, since a key it never declared is a spelling mistake or a
 * row from an older build, and deleting it is the only sensible thing to do
 * with it. The merged whole is then judged by `validateMount` as any other
 * write is, which is what makes "delete the stray key and change a setting in
 * one patch" work: the two are merged before either is judged. `changed` is
 * the keys whose value moved, a removed key included. A mount with no
 * credential yet is judged without the account rule, as `addMount` judges one,
 * since attaching it re-judges the settings.
 *
 * `settings` is `unknown` and not the patch type because this is where JSON off
 * the wire is judged: the type says what a well-formed change is, and a caller
 * that could promise that would not need this function.
 */
export function mergeMountSettings(
  plugin: Pick<Plugin, "id" | "config" | "credential" | "configProblem">,
  have: { publicConfig: Json | null; secretRef: string | null },
  settings: unknown,
): { ok: true; config: Record<string, Json>; changed: string[] } | { ok: false; error: string } {
  if (typeof settings !== "object" || settings === null || Array.isArray(settings) || !Object.keys(settings).length) {
    return { ok: false, error: "settings is an object naming at least one setting" };
  }
  const fields = plugin.config ?? [];
  const changeable = fields.filter((f) => f.changeable).map((f) => f.name);
  const canSay = changeable.length ? `only ${changeable.join(", ")} can` : "none can";
  const patch = settings as MountSettingsPatch;
  const removed = new Set<string>();
  for (const [key, value] of Object.entries(patch)) {
    const field = fields.find((f) => f.name === key);
    // `account` belongs to no plugin (see `validateMount` above), so neither the undeclared-key deletion below nor
    // the "no such setting" refusal fits it and it gets its own answer. It has two readers and only one of them is a
    // person looking at something: the model (`tools.mounts`) and `/admin/diagnose`. Deleting it would hand the model
    // an unnamed mount, while the console — which does not show this field — looked exactly the same.
    if (key === "account" && value === null) {
      return { ok: false, error: `"account" is the mount's label and cannot be removed` };
    }
    if (!field) {
      // Not this plugin's setting: a spelling mistake, or a row an older build
      // wrote. Deleting it is the one thing an operator may do to it — and the
      // one thing that gets a mount carrying such a key moving again.
      if (value === null) { removed.add(key); continue; }
      return { ok: false, error: `${plugin.id} has no setting "${key}"; ${canSay} be changed on an existing mount` };
    }
    // A setting the plugin does not mark `changeable` is what the mount IS
    // connected to (raft's `serverUrl`): moving it in place would carry the
    // credential and the stored state to another server. Deleting it is the
    // same move in the other direction, so it is refused the same way.
    if (!field.changeable) {
      return { ok: false, error: `"${key}" cannot be changed on an existing ${plugin.id} mount (${canSay}): ` +
        "a mount with another value of it is another mount" };
    }
    if (value === null) { removed.add(key); continue; }
    const actual = settingType(value);
    if (actual !== field.type) return { ok: false, error: `"${key}" must be a ${field.type}, got ${actual}` };
  }
  const stored = (have.publicConfig && typeof have.publicConfig === "object" && !Array.isArray(have.publicConfig)
    ? have.publicConfig : {}) as Record<string, Json>;
  const config: Record<string, Json> = { ...stored, ...(patch as Record<string, Json>) };
  for (const key of removed) delete config[key];
  const accountLater = plugin.credential && !have.secretRef ? { ...plugin, credential: { ...plugin.credential, required: false } } : plugin;
  const problems = validateMount(accountLater, config, have.secretRef);
  if (problems.length) {
    // A key the plugin does not declare that is still in the merged settings came from the stored row (the patch
    // itself may only delete one), and it fails every patch that leaves it there. Say how to get out, naming the
    // key and never its value: settings are public, and the value may be exactly what should not have been there.
    const stray = Object.keys(config).filter((k) => k !== "account" && !fields.some((f) => f.name === k));
    const way = stray.length ? ` — delete ${stray.map((k) => `"${k}"`).join(", ")} by sending it as null, in this patch or before it` : "";
    return { ok: false, error: `cannot change ${plugin.id}'s settings: ${problems.map((p) => p.message).join("; ")}${way}` };
  }
  const changed = Object.keys(patch).filter((k) => JSON.stringify(stored[k]) !== JSON.stringify(config[k]));
  return { ok: true, config, changed };
}
