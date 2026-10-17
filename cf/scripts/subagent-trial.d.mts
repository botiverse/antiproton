/** Types of cf/scripts/subagent-trial.mjs's exports, for the test that imports them (test/subagent-trial.ts). */
export interface TrialRow { at: number; kind: string; status?: string; spanId?: string; parentId?: string; attrs?: Record<string, unknown> }
export interface TrialSummary {
  modelCalls: { main: number; sub: number };
  inputTokens: { main: number; sub: number };
  outputTokens: { main: number; sub: number };
  mainInputTokens: { median: number | null; p90: number | null; calls: number };
  rebuilds: number;
  delegations: { spawn: number; follow_up: number; wake: number };
  childTurns: { done: number; failed: number; cancelled: number; stopped: number };
  reportChars: { total: number; median: number | null; reports: number };
}
export function quantile(values: readonly number[], q: number): number | null;
export function summarize(rows: readonly TrialRow[], window?: { from?: number; to?: number }): { days: Array<{ day: string } & TrialSummary>; total: TrialSummary };
