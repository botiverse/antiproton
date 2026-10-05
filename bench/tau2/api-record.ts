/**
 * The Agents API runner's record (bench/tau2/api.ts): the per-row figures, read from what the API and the
 * operator's routes answer, and the record body, written by the same `recordRun` as the `/bench` runner's.
 *
 * The goal is the `/bench` record's shape, field for field, so the series continues and is split only by
 * `runnerMethod`. The fields the two compute differently, and how, are listed where each is computed:
 *   usage, byTool, toolErrors   from the session's turns and items (`rowFigures`)
 *   kinds                       from the object's own entries, through `/admin/transcript` (`kindsOf`)
 *   provider                    from the agent's usage ledger, checked against the agent (`taskProvider`)
 *
 * Pure functions over the responses, so a test can hold each one to fixtures.
 */
import type { ApiItem, ApiTurn } from "./api-turn.ts";
import { seqOf } from "./api-turn.ts";
import { passRecord } from "./passk.ts";
import { endingsAllRows, failingRowsByEndingAndCause } from "./endings.ts";
import { sumActivity } from "../objects.ts";

/** Which way a record's rows were driven. A record without the field was driven over `/bench`. */
export const RUNNER_METHOD = "agents-api";

/** A record's method, reading an absent field as the only method there was before it existed. */
export const runnerMethodOf = (record: { runnerMethod?: unknown }): string =>
  typeof record.runnerMethod === "string" ? record.runnerMethod : "bench";

/**
 * Usage, and the calls by tool, from the session's turns and items.
 *
 *   prompt, completion   the turns' `input_tokens` and `output_tokens`, which sum the same `usage.input` and
 *                        `usage.output` of the assistant entries as `/bench/result` did (cf/src/agents-api/
 *                        transcript.ts, cf/src/pi-view.ts `model.response`)
 *   calls                the assistant entries, counted as the distinct sequences among the items they
 *                        produced (`item_<seq>_r`, `_m`, `_c<n>`). An entry with no text, no reasoning and
 *                        no call produces no item and is missed; the parallel run checks the two agree.
 *   byTool               `function_call_output` items, named by their `function_call`
 *   toolErrors           those with status `failed`, which is `isError` (transcript.ts)
 */
export function rowFigures(items: readonly ApiItem[], turns: readonly ApiTurn[]) {
  let prompt = 0, completion = 0;
  for (const t of turns) { prompt += Number(t.usage?.input_tokens ?? 0); completion += Number(t.usage?.output_tokens ?? 0); }
  const assistant = new Set(items.filter((i) => i.type === "reasoning" || i.type === "function_call"
    || (i.type === "message" && i.role === "assistant")).map((i) => seqOf(i.id)));
  const nameOf = new Map(items.filter((i) => i.type === "function_call").map((i) => [String(i.call_id), String(i.name)]));
  const byTool: Record<string, number> = {};
  let toolErrors = 0;
  for (const i of items) {
    if (i.type !== "function_call_output") continue;
    const name = nameOf.get(String(i.call_id)) ?? "unknown";
    byTool[name] = (byTool[name] ?? 0) + 1;
    if (i.status === "failed") toolErrors += 1;
  }
  return { usage: { prompt, completion, calls: assistant.size }, byTool, toolErrors };
}

/** One event as `/admin/transcript` answers it (cf/src/transcript-read.ts `transcriptEvents`). */
export interface TranscriptEvent { sequence: number; kind: string; payload?: any }

/**
 * The events `/bench/result` counted, out of what `/admin/transcript` answers for the session.
 *
 * Both project the object's entries with the same function (cf/src/pi-view.ts `entriesToEvents`), but the
 * operator's read differs in two ways that would make the counts disagree for reasons unrelated to the agent:
 *   - It reads every entry, not the branch the model's context is built from. A caller's function pauses its
 *     turn by recording a placeholder result and resumes on a new branch from the call (src/runtime/
 *     client-calls.ts), so every call has its placeholder off the branch as well as its real result on it.
 *     One result per call is kept: the last, which is the one on the branch.
 *   - It adds runs that failed before their first model call, from the engine's outcome records (cf/src/
 *     engine-read.ts `readFailedRuns`), as `model.failed` events carrying an `operationId`. `/bench/result`
 *     never counted those; they are left out here too, so `kinds` stays the same count.
 */
export function branchEvents(events: readonly TranscriptEvent[]): TranscriptEvent[] {
  const lastResult = new Map<string, number>();
  events.forEach((e, i) => {
    if ((e.kind === "tool.result" || e.kind === "js.result") && e.payload?.callId !== undefined) lastResult.set(String(e.payload.callId), i);
  });
  return events.filter((e, i) => {
    if (e.kind === "model.failed" && e.payload && "operationId" in e.payload) return false;
    if ((e.kind === "tool.result" || e.kind === "js.result") && e.payload?.callId !== undefined) return lastResult.get(String(e.payload.callId)) === i;
    return true;
  });
}

/** `kinds`, as `/bench/result` built it: one count per event kind. */
export function kindsOf(events: readonly TranscriptEvent[]): Record<string, number> {
  const kinds: Record<string, number> = {};
  for (const e of branchEvents(events)) kinds[e.kind] = (kinds[e.kind] ?? 0) + 1;
  return kinds;
}

/**
 * `usage`, `byTool` and `toolErrors` the way `/bench/result` computed them, over the same events: what
 * `rowFigures` derives from the items is checked against this in the log, so a difference in the derivation
 * is seen on the run that has it rather than argued afterwards.
 */
export function exactFigures(events: readonly TranscriptEvent[]) {
  const usage = { prompt: 0, completion: 0, calls: 0 };
  const byTool: Record<string, number> = {};
  let toolErrors = 0;
  for (const e of branchEvents(events)) {
    const u = e.payload?.usage;
    if (u) { usage.prompt += u.promptTokens ?? 0; usage.completion += u.completionTokens ?? 0; usage.calls += 1; }
    if (e.kind === "tool.result" || e.kind === "js.result") {
      const name = String(e.payload?.tool);
      byTool[name] = (byTool[name] ?? 0) + 1;
      if (e.payload?.isError) toolErrors += 1;
    }
  }
  return { usage, byTool, toolErrors };
}

// ---- provider ---------------------------------------------------------------

/** What `/admin/models` lists: the deployment's providers, and the options an owner may pick. */
export interface ModelsList {
  providers: Array<{ id: string; endpoint: string }>;
  options?: Array<{ id: string; provider: string; model: string }>;
}

/**
 * The provider and model an agent's API name stands for (cf/src/agents-api/model.ts `modelName`): an offered
 * option's id, else `<provider>/<model>`. Null when it is neither, which the caller refuses.
 */
export function resolveApiModel(name: string, list: ModelsList): { provider: string; model: string; endpoint: string } | null {
  const endpoint = (provider: string) => list.providers.find((p) => p.id === provider)?.endpoint;
  const option = (list.options ?? []).find((o) => o.id === name);
  if (option) {
    const e = endpoint(option.provider);
    return e === undefined ? null : { provider: option.provider, model: option.model, endpoint: e };
  }
  const cut = name.indexOf("/");
  if (cut <= 0) return null;
  const provider = name.slice(0, cut), e = endpoint(provider);
  return e === undefined ? null : { provider, model: name.slice(cut + 1), endpoint: e };
}

/** The models the ledger saw this agent's tokens under (`model.tokens` rows, keyed by `dimensions.model`). */
export function ledgerModels(usage: { rows?: Array<{ resource?: string; dimensions?: Record<string, string> }> }): string[] {
  return [...new Set((usage.rows ?? []).filter((r) => r.resource === "model.tokens" && r.dimensions?.model)
    .map((r) => r.dimensions!.model!))].sort();
}

export type Provider = { name: string; endpoint: string };

/**
 * One task's provider: the model the ledger counted its tokens under — which is the model its calls were
 * made with (src/store/pi-storage.ts `#modelOf`, the answer's `model`) — and the endpoint of the provider the
 * agent's own model names. The two are checked against each other, and a disagreement is a refusal: a row
 * that says "this ran on Luna" must not rest on a request when the ledger says otherwise.
 *
 * A ledger with nothing in it (the customer ended before the agent ran) is no provider and no refusal.
 */
export function taskProvider(agentModel: string, ledger: readonly string[], list: ModelsList):
  { ok: true; provider: Provider | null } | { ok: false; why: string } {
  if (ledger.length === 0) return { ok: true, provider: null };
  if (ledger.length > 1) return { ok: false, why: `the ledger counted this agent's tokens under ${ledger.length} models: ${ledger.join(", ")}` };
  const resolved = resolveApiModel(agentModel, list);
  if (!resolved) return { ok: false, why: `the agent's model ${JSON.stringify(agentModel)} names no option or provider /admin/models lists, so the ledger's ${ledger[0]} cannot be checked against it` };
  if (resolved.model !== ledger[0]) return { ok: false, why: `the agent reads as ${agentModel} (${resolved.provider}/${resolved.model}), the ledger counted ${ledger[0]}` };
  return { ok: true, provider: { name: ledger[0]!, endpoint: resolved.endpoint } };
}

/**
 * The run's provider: every row's, when they agree. Rows with none are left out of the comparison (they ran
 * no model call); rows that disagree make the run something other than a one-provider run, and it is refused
 * rather than written under one of them.
 */
export function runProvider(rows: ReadonlyArray<{ provider?: Provider | null }>):
  { ok: true; provider: Provider | null } | { ok: false; why: string } {
  const seen = new Map<string, Provider>();
  for (const r of rows) if (r.provider) seen.set(JSON.stringify([r.provider.name, r.provider.endpoint]), r.provider);
  if (seen.size > 1) return { ok: false, why: `rows ran on ${seen.size} providers: ${[...seen.values()].map((p) => `${p.name} at ${p.endpoint}`).join("; ")}` };
  return { ok: true, provider: [...seen.values()][0] ?? null };
}

// ---- the record ---------------------------------------------------------------

/**
 * The run's record body, or why there is none.
 *
 * Field for field the `/bench` runner's (bench/tau2/cf.ts), with two added — `runnerMethod`, and
 * `modelRequested` beside `model` — and these values set differently:
 *   model      the model the rows ran on, from the ledger (`provider.name`), so the DeepSeek arm still reads
 *              `deepseek-flash` as the `/bench` rows did; what was asked for is `modelRequested`
 *   provider   the rows' own, when they agree (`runProvider`); a run whose rows disagree has no record
 *   engine     what the rows observed (`pi085` when a function was called), not what was asked for
 *   objects    always `per-task`: every task is an agent, and so an object, of its own
 *   object     `api:<tenant>/<owner>`; each row names its agent
 *   wait       `sse`
 *   activity   summed over the rows' objects, as the `/bench` runner does per task; its `pollMs` is 0, since
 *              the stream is read in the Worker and never wakes the object the way `/bench/poll` did
 */
export function apiRunRecord(i: {
  base: string; build: string | null; driver: unknown; tenantId: string; owner: string;
  modelRequested: string; sim: unknown; tasks: unknown[]; trials: number; order: string;
  ignoreAnswers?: string; startedAt: string; results: any[];
}): { ok: true; body: Record<string, unknown> } | { ok: false; why: string } {
  const provider = runProvider(i.results);
  if (!provider.ok) return provider;
  const tools: Record<string, number> = {};
  for (const r of i.results) for (const [n, c] of Object.entries(r.byTool ?? {})) tools[n] = (tools[n] ?? 0) + (c as number);
  const engines = new Set(i.results.map((r) => r.engine).filter(Boolean));
  return {
    ok: true,
    body: {
      bench: "tau2-retail", runnerMethod: RUNNER_METHOD, base: i.base, build: i.build, driver: i.driver,
      object: `api:${i.tenantId}/${i.owner}`, engine: engines.size === 1 ? [...engines][0] : null, objects: "per-task",
      model: provider.provider?.name ?? null, modelRequested: i.modelRequested, wait: "sse", sim: i.sim,
      provider: provider.provider,
      tasks: i.tasks, trials: i.trials, order: i.order,
      ...(i.ignoreAnswers ? { ignoreAnswers: i.ignoreAnswers } : {}),
      startedAt: i.startedAt,
      results: i.results, ...passRecord(i.results, i.trials),
      tools, endingsAllRows: endingsAllRows(i.results), failingRowsByEndingAndCause: failingRowsByEndingAndCause(i.results),
      activity: sumActivity(i.results.map((r) => r.activity)),
    },
  };
}
