import type { Json } from "./types.ts";
import type { ToolResult } from "./tools.ts";

export interface ExecutionLimits {
  wallTimeMs: number;
  memoryBytes: number;
  maxStackBytes: number;
  maxHostCalls: number;
  maxConcurrentHostCalls: number;
  maxOutputBytes: number;
}

export const DEFAULT_LIMITS: ExecutionLimits = {
  wallTimeMs: 5_000,
  memoryBytes: 64 * 1024 * 1024,
  maxStackBytes: 1024 * 1024,
  maxHostCalls: 64,
  maxConcurrentHostCalls: 8,
  maxOutputBytes: 64 * 1024,
};

export interface ExecutorHost {
  invoke(call: { tool: string; args: Json; opts: Record<string, Json> }): Promise<ToolResult>;
}

export interface ExecutionResult {
  status: "completed" | "failed" | "interrupted";
  outputs: Json[];
  acceptedOperationIds: string[];
  hostCalls: number;
  error?: { code: string; message: string };
}

/**
 * The seam §15 asked for. QuickJS satisfies it in Node; Cloudflare Dynamic
 * Workers satisfy it at the edge. Both must pass test/spec/executor-spec.ts.
 */
export interface JsExecutor {
  execute(
    source: string,
    host: ExecutorHost,
    limits?: ExecutionLimits,
    signal?: AbortSignal,
  ): Promise<ExecutionResult>;
}
