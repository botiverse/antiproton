/**
 * An agent's own switches, kept in its object: features an operator turns on for one agent at a time, read by the
 * runtime when it builds a turn's tools. Not the agent's record (`config`), which provisioning rewrites on a re-adopt
 * (cf/src/provision/steps.ts), so a switch kept there could be lost by a rename; not the control plane, which a turn
 * would then have to ask on every open.
 *
 * Every setting is declared here with its type and default, and a write naming anything else is refused: a key this
 * does not read is a key someone believed did something. Set through `/admin/agent-settings` (cf/src/index.ts;
 * docs/runbook.md, "Subagents").
 */
type Sql = { exec(query: string, ...bindings: unknown[]): { toArray(): unknown[] } };

/**
 * The settings there are, each a boolean, and its default where the runtime names none (`agentSettings`'s `defaults`).
 * `subagents`' default is the runtime's to give: on for every hosted agent (cf/src/index.ts), off for the bench, whose
 * arms must not change under a measurement; a stored `false` is the per-agent kill switch.
 */
export const AGENT_SETTINGS = {
  /** Offer `send_to_agent` (src/runtime/subagents.ts) to the agent's own conversations. */
  subagents: false,
} as const;

/**
 * The deployment-wide kill switch: `SUBAGENTS_DISABLED` exactly "1" in the Worker's vars turns subagents off for every
 * agent, whatever an agent's setting says, without a code change. Unset, or anything else, leaves them as the settings say.
 */
export function subagentsDisabledBy(env: { SUBAGENTS_DISABLED?: unknown }): boolean {
  return env.SUBAGENTS_DISABLED === "1";
}

/** What each setting does, as whoever reads or changes it is told (`/admin/agent-settings`, `about`). */
export const AGENT_SETTING_ABOUT: { [K in keyof typeof AGENT_SETTINGS]: string } = {
  subagents: "The agent may delegate work to subagents (send_to_agent). Subagents can read and research but cannot change " +
    "anything or act as this agent: no writes, no messages, no shell. Give them reading tasks and do the changes yourself.",
};

export type AgentSettingName = keyof typeof AGENT_SETTINGS;
export type AgentSettings = { [K in AgentSettingName]: boolean };

const TABLE = "CREATE TABLE IF NOT EXISTS agent_settings (name TEXT PRIMARY KEY, value TEXT NOT NULL, set_by TEXT, set_at INTEGER NOT NULL)";

/** Every setting as it is in force: the stored value, else `defaults`, else the declared default. Reads without making the table. */
export function agentSettings(sql: Sql, defaults: Partial<AgentSettings> = {}): AgentSettings {
  const out: AgentSettings = { ...AGENT_SETTINGS, ...defaults };
  if (sql.exec("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'agent_settings'").toArray().length === 0) return out;
  for (const r of sql.exec("SELECT name, value FROM agent_settings").toArray() as Array<{ name: string; value: string }>) {
    if (!(r.name in AGENT_SETTINGS)) continue;
    try { out[r.name as AgentSettingName] = JSON.parse(String(r.value)) === true; } catch { /* a value this cannot read is the default */ }
  }
  return out;
}

/**
 * Apply `patch` (a JSON object of setting names to booleans): all of it or none. Answers the settings in force after,
 * and which names changed, or why the patch was refused.
 */
export function updateAgentSettings(sql: Sql, patch: unknown, who: string, now = Date.now(), defaults: Partial<AgentSettings> = {}):
  { ok: true; settings: AgentSettings; changed: AgentSettingName[] } | { ok: false; error: string } {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return { ok: false, error: "settings is an object of setting names to true or false" };
  const entries = Object.entries(patch as Record<string, unknown>);
  if (!entries.length) return { ok: false, error: "settings names no setting" };
  for (const [k, v] of entries) {
    if (!(k in AGENT_SETTINGS)) return { ok: false, error: `no agent setting ${JSON.stringify(k.slice(0, 64))}; there are: ${Object.keys(AGENT_SETTINGS).join(", ")}` };
    if (typeof v !== "boolean") return { ok: false, error: `${k} is true or false` };
  }
  const before = agentSettings(sql, defaults);
  sql.exec(TABLE);
  const changed: AgentSettingName[] = [];
  for (const [k, v] of entries as Array<[AgentSettingName, boolean]>) {
    if (before[k] !== v) changed.push(k);
    sql.exec("INSERT INTO agent_settings(name, value, set_by, set_at) VALUES (?,?,?,?) ON CONFLICT(name) DO UPDATE SET value = excluded.value, set_by = excluded.set_by, set_at = excluded.set_at",
      k, JSON.stringify(v), who, now);
  }
  return { ok: true, settings: agentSettings(sql, defaults), changed };
}
