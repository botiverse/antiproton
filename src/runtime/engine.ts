/**
 * What the rest of the system may ask of one agent's engine — one session's
 * transcript and the loop that drives it — and nothing more.
 *
 * `PiAgent` (pi-agent.ts, on pi-agent-core 0.85) is the only engine today. A
 * second engine will implement this same interface, and `AgentRuntime.agent()`
 * (cf/src/runtime.ts) returns this type rather than either class, so a caller
 * that needs something not listed here is reaching into one engine's internals:
 * the fix is a method here, implemented by every engine.
 *
 * Building an engine is not on the interface: what it is built from (tools, the
 * model binding, the dispatch) is the runtime's, and each engine is opened by
 * its own constructor.
 */
import type { Entry, EntryScan } from "@earendil-works/pi-agent-core/harness/session";
import type { AnsweredMessage } from "../model/pi-bridge.ts";

/** A transcript entry as the console and the bench read it. */
export type EngineEntry = Entry;
export type EngineEntryScan = EntryScan;

export interface StepOutcome {
  /** Operations still open after this pass. */
  open: number;
  /** When to come back, in ms from now, or null if nothing is pending. */
  wakeInMs: number | null;
  settled: Array<{ operationId: string; status: string }>;
}

/**
 * An engine that cannot compact says so with this, and nothing is written: no
 * operation, no entry, no model job. The caller turns it into a refusal its own
 * caller can read (cf/src/index.ts `uiCompact`), not a 500. The class does not
 * survive a Durable Object RPC boundary, so it is caught on the object's side.
 */
export class CompactionUnavailable extends Error {
  override name = "CompactionUnavailable";
}

/** What the debugging endpoints show. `detail` is the engine's own record, passed through unread. */
export interface EngineStatus {
  running: boolean;
  model: unknown;
  detail: unknown;
}

export interface AgentEngine {
  /** A person's message; durable before it returns. */
  say(text: string, mode?: "prompt" | "steer" | "followUp"): Promise<unknown>;
  /** Cancel the run in flight, writing a `marker` entry naming it. Null when nothing was running. */
  cancel(marker: string): Promise<string | null>;
  /** A `marker` entry for a turn that ended with no run to abort (a pause for the caller's functions). */
  markCancelled(marker: string): Promise<void>;
  compact(): Promise<unknown>;
  /** One pass: drive what is open until it settles or waits, and say when to come back. */
  step(): Promise<StepOutcome>;
  /** Continue a turn paused for an API caller once every result is in (client-calls.ts). True when a run started. */
  resumeClientCalls(): Promise<boolean>;
  /** Function calls this session waits on its API caller for, oldest first. */
  waitingClientCalls(): Promise<Array<{ call_id: string; name: string; arguments: string }>>;
  /** The API caller's results, kept also for a call not run yet; a result for a call that already has one is ignored. */
  answerClientCalls(results: ReadonlyArray<{ callId: string; output: string; isError: boolean }>): Promise<void>;
  /** Forget this session's client calls, when its turn is cancelled. How many were still waiting. */
  dropClientCalls(): Promise<number>;
  /** Whether a run is in flight. */
  running(): Promise<boolean>;
  status(): Promise<EngineStatus>;
  /** Every entry of this session's transcript. */
  entries(query: EngineEntryScan): Promise<EngineEntry[]>;
  /** The current branch, oldest first: what the model's context is built from. */
  branch(): Promise<EngineEntry[]>;
  /** The tools the model is offered. */
  tools(): Promise<Array<{ name: string }>>;
  /**
   * The worker's side of an offloaded model call: the request (null once answered), then the answer. A value or a promise of one.
   * `taker` is the queue message that will call the model with it; pd refuses a job another message took recently (`PdHost.takeJob`).
   */
  takeJob(id: string, taker?: string): unknown;
  deliver(id: string, answer: AnsweredMessage): boolean | Promise<boolean>;
  close(): Promise<void>;
}
