/**
 * One τ² retail task over the public Agents API (bench/tau2/api.ts), with everything it touches handed in: the
 * client, the simulator, the data. The driver reads secrets and files at import; this does not, so a test can
 * run a whole task against a Worker in its own process (test/bench-tau2-api-local.ts).
 *
 * The conversation is the `/bench` runner's (bench/tau2/cf.ts), step for step, and the parts both share are
 * one module (bench/tau2/episode.ts). What differs is how the agent is reached:
 *   - one agent and one session per task, both new: `POST /v1/agents`, `POST /v1/agents/sessions`;
 *   - the customer's line is an `agent.session.input.message` event;
 *   - the retail tools are the caller's functions (bench/tau2/api-tools.ts): the turn stops at
 *     `requires_action`, they run here on this task's own database, and their results go back as one
 *     `agent.session.input.tool_result` batch;
 *   - the grade is this database's hash and this task's writes, with no `/bench/result` to ask.
 */
import type { RetailDB } from "./retail.ts";
import { WRITE_TOOLS } from "./retail.ts";
import { canonJson as canon, actionMatch as grade } from "./grade.ts";
import { gold, MAX_TURNS, OPENING, SIM, SIM_LAST_MAX, sha256, simEnding, simSystem } from "./episode.ts";
import { runRetailCall, type FunctionTool } from "./api-tools.ts";
import { apiStallAtDeadline, waitForTurn, type Delivered, type Snapshot } from "./api-turn.ts";
import {
  exactFigures, kindsOf, ledgerModels, rowFigures, taskProvider, type ModelsList, type Provider, type TranscriptEvent,
} from "./api-record.ts";
import type { ApiClient } from "./api-client.ts";
import type { StallEvidence } from "../poll-fallback.ts";
import type { Activity } from "../objects.ts";

type SimMessage = { role: "system" | "user" | "assistant"; content: string };

export interface ApiTaskDeps {
  client: ApiClient;
  /** The user simulator, called with SIM (bench/tau2/episode.ts). */
  sim(messages: SimMessage[], opts: typeof SIM): Promise<{ text: string; finishReason?: string }>;
  baseDb: RetailDB;
  policy: string;
  guidelines: string;
  tools: FunctionTool[];
  /** The agent's `model`, as sent: "default" or an option's id. */
  model: string;
  /** `/admin/models`, read once for the run. */
  models: ModelsList;
  /** The tenant the run's key acts in, for the operator's reads of the agent's object. */
  tenantId: string;
  turnTimeoutMs?: number;
  lookEveryMs?: number;
  /** How long to wait for the agent's usage to reach the ledger before reading it as it is. */
  ledgerWaitMs?: number;
  deafness: { deaf(to: "socket" | "poll"): boolean; spend(): void };
  /** IGNORE_ANSWERS, for when deafness is spent (bench/tau2/cf.ts does the same). */
  deafSetting?: "socket" | "all";
  say?(line: string): void;
}

/** Thrown when a task's provider cannot be vouched for: the run stops rather than record a model it did not run. */
export class ProviderRefusal extends Error {}

const zero = (): Delivered => ({ push: 0, poll: 0, pollAnswered: 0, pollFailed: 0, dropped: 0 });

export async function runApiTask(task: any, d: ApiTaskDeps) {
  const t0 = Date.now();
  const c = d.client;
  // `name: ""`, not null: a null name is given a generated one, and "You are <name>." would then come before
  // the policy in the system prompt (cf/src/index.ts #apiPersona, src/runtime/pi-prompt.ts personaSection),
  // a line the `/bench` agent's prompt never had. An empty name adds nothing, so the policy is first.
  const agent = await c.v1("POST", "/agents", { model: d.model, name: "", instructions: d.policy, tools: d.tools });
  if (d.model !== "default" && agent.model !== d.model) {
    throw new ProviderRefusal(`asked for ${d.model}, the agent was made on ${agent.model}`);
  }
  const agentId = String(agent.id);
  let sessionId = "";
  try {
    const session = await c.v1("POST", "/agents/sessions", { agent_id: agentId, environment: { type: "none" } });
    sessionId = String(session.id);
    return await converse(task, d, t0, agentId, sessionId);
  } finally {
    // The objects keep their transcripts either way; what goes is the API's index of them.
    if (sessionId) await c.v1("DELETE", `/agents/sessions/${sessionId}`).catch((e) => d.say?.(`      (could not delete ${sessionId}: ${(e as Error).message.slice(0, 120)})`));
    await c.v1("DELETE", `/agents/${agentId}`).catch((e) => d.say?.(`      (could not delete ${agentId}: ${(e as Error).message.slice(0, 120)})`));
  }
}

async function converse(task: any, d: ApiTaskDeps, t0: number, agentId: string, sessionId: string) {
  const c = d.client;
  const db = structuredClone(d.baseDb);
  const performed: Array<{ name: string; args: any }> = [];
  const delivered = zero();
  const answered = new Set<string>();
  const snapshot = async (): Promise<Snapshot> => {
    const [session, turns, items] = await Promise.all([
      c.v1("GET", `/agents/sessions/${sessionId}`), c.v1All(`/agents/sessions/${sessionId}/turns`), c.v1All(`/agents/sessions/${sessionId}/items`),
    ]);
    return { session, turns, items };
  };
  const waitDeps = {
    open: () => c.openStream(sessionId),
    snapshot,
    count: (what: keyof Delivered) => { delivered[what] += 1; },
    deaf: (to: "socket" | "poll") => d.deafness.deaf(to),
    say: d.say,
    lookEveryMs: d.lookEveryMs,
  };
  const events = (body: unknown) => c.v1("POST", `/agents/sessions/${sessionId}/events`, body).then(() => {});

  const sim: SimMessage[] = [{ role: "system", content: simSystem(task, d.guidelines) }];
  let agentSaid = OPENING;
  let turns = 0, simCalls = 0, ended = "max_turns";
  let simLast = "";
  let stall: string | undefined;
  let stallWhy: StallEvidence | undefined;
  /** The sequence of the last answer taken, so no read can hand it back again. */
  let seen = -1;

  while (turns++ < MAX_TURNS) {
    sim.push({ role: "user", content: agentSaid });
    const u = await d.sim(sim, SIM);
    simCalls += 1;
    sim.push({ role: "assistant", content: u.text });
    // Verbatim, stop tag included, as the `/bench` row keeps it.
    simLast = u.text;
    d.say?.(`    user  > ${u.text.replace(/\s+/g, " ").slice(0, 130)}`);
    const simEnded = simEnding(u);
    if (simEnded) { ended = simEnded; break; }

    const deadline = Date.now() + (d.turnTimeoutMs ?? 300_000);
    let start: (() => Promise<void>) | null = () => events({ events: [{ type: "agent.session.input.message", input: u.text }] });
    let outcome = await waitForTurn(seen, deadline, start, waitDeps, answered);
    // The caller's functions, until the turn answers, fails or runs out of time.
    while (outcome?.kind === "actions") {
      const results: Array<Record<string, unknown>> = [];
      for (const call of outcome.calls) {
        const r = await runRetailCall(call, db, performed);
        answered.add(call.call_id);
        results.push({ type: "agent.session.input.tool_result", turn_id: call.turn_id, call_id: call.call_id, ...r });
      }
      start = () => events({ events: results });
      outcome = await waitForTurn(seen, deadline, start, waitDeps, answered);
    }
    if (outcome?.kind === "answer") {
      seen = outcome.seen;
      if (d.deafSetting === "socket") d.deafness.spend();
      agentSaid = outcome.text;
      d.say?.(`    agent > ${agentSaid.replace(/\s+/g, " ").slice(0, 130)}`);
      continue;
    }
    if (outcome?.kind === "failed") ended = `model: ${outcome.message}`.slice(0, 60);
    else {
      ended = "agent_stalled";
      ({ stall, stallWhy } = await apiStallAtDeadline(snapshot, seen));
      // The hole is spent whether or not it produced the stall, so a round injects exactly one.
      d.deafness.spend();
    }
    break;
  }
  const conversationEnded = Date.now();

  const { hash, expected } = gold(task, d.baseDb);
  const writes = performed.filter((w) => WRITE_TOOLS.has(w.name));
  const dbMatch = sha256(canon(db)) === hash;
  const actionMatch = grade(expected, writes);

  const final = await snapshot();
  const figures = rowFigures(final.items, final.turns);
  const owner = `tenantId=${encodeURIComponent(d.tenantId)}&agentId=${encodeURIComponent(agentId)}`;
  const transcript: { events?: TranscriptEvent[] } | null = await c.operator(`/admin/transcript?${owner}&taskId=${encodeURIComponent(sessionId)}`)
    .catch((e) => { d.say?.(`      (no transcript: ${(e as Error).message.slice(0, 120)})`); return null; });
  const kinds = transcript?.events ? kindsOf(transcript.events) : null;
  if (transcript?.events) {
    // The derivation from items, against the computation `/bench/result` made over the same entries.
    const exact = exactFigures(transcript.events);
    if (canon(exact) !== canon(figures)) d.say?.(`      items and entries disagree: items ${JSON.stringify(figures)} entries ${JSON.stringify(exact)}`);
  }
  const activity: Activity | null = await c.operator(`/agent/activity?${owner}`).catch(() => null);
  const provider = await providerOf(d, agentId, t0, conversationEnded);

  const object = `api:${d.tenantId}/${agentId}`;
  return {
    id: task.id, taskId: sessionId, agentId, sessionId,
    // Client functions are offered off pd only (cf/src/runtime.ts), so a call made says which engine ran.
    engine: Object.keys(figures.byTool).length ? "pi085" : null,
    object, activity, provider,
    reward: dbMatch && actionMatch ? 1 : 0, dbMatch, actionMatch, ended, stall, stallWhy,
    simLast: simLast.slice(0, SIM_LAST_MAX),
    delivered, turns: turns - 1, simCalls,
    usage: figures.usage, kinds, byTool: figures.byTool, toolErrors: figures.toolErrors,
    seconds: Math.round((Date.now() - t0) / 1000),
    expectedWrites: expected.map((e) => e.name),
    performedWrites: writes.map((w) => w.name),
    expectedArgs: expected, performedArgs: writes.map((w) => ({ name: w.name, args: w.args })),
  };
}

/**
 * The task's provider, from the ledger once it has caught up with the task. The agent's object sends its
 * usage on its next alarm pass, so the read waits until the ledger speaks for the time the conversation
 * ended (`asOf`, cf/src/agent-surface/usage.ts), and reads what is there if it never does.
 */
async function providerOf(d: ApiTaskDeps, agentId: string, t0: number, ended: number): Promise<Provider | null> {
  const from = new Date(t0 - 60_000).toISOString(), until = Date.now() + (d.ledgerWaitMs ?? 60_000);
  let usage: any = null;
  for (;;) {
    const to = new Date(Date.now() + 60_000).toISOString();
    usage = await d.client.v1("GET", `/agents/${agentId}/usage?from=${from}&to=${to}&bucket=1h`).catch(() => null);
    if ((usage && Date.parse(usage.asOf) >= ended) || Date.now() >= until) break;
    await new Promise((r) => setTimeout(r, 2_000));
  }
  // Unreadable is not empty: a ledger that could not be asked cannot say the agent ran on nothing.
  if (!usage) throw new ProviderRefusal(`agent ${agentId}: its usage could not be read, so its provider cannot be vouched for`);
  const agent = await d.client.v1("GET", `/agents/${agentId}`);
  const p = taskProvider(String(agent.model), ledgerModels(usage), d.models);
  if (!p.ok) throw new ProviderRefusal(`agent ${agentId}: ${p.why}`);
  return p.provider;
}
