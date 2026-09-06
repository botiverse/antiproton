import type { Json } from "./types.ts";

/**
 * One result channel, not two. The plan's §5.3 had pre-acceptance failures throw
 * as JS exceptions while post-acceptance failures came back as a status union —
 * which forces every agent-written snippet to both try/catch and check .status.
 * "rejected" is the pre-acceptance case and carries no operationId, because no
 * operation was ever created.
 */
export type ToolResult =
  | { status: "succeeded"; operationId: string; result: Json }
  | { status: "pending" | "running"; operationId: string }
  | { status: "failed" | "cancelled" | "unknown"; operationId: string; error?: ToolError }
  | { status: "rejected"; error: ToolError };

export interface ToolError {
  code: string;
  message: string;
  /** For ambiguous mount references: the aliases the agent could have meant. */
  candidates?: string[];
  /** For unauthorized/unmounted plugins: a link a human can act on. */
  authorizationUrl?: string;
}

export interface ToolRef {
  /** Mount alias, or a bare plugin id when the agent did not disambiguate. */
  head: string;
  /** Remainder, e.g. "issues.list". */
  tool: string;
}

export function parseToolRef(raw: string): ToolRef | null {
  const trimmed = raw.trim();
  if (!/^[a-z0-9_]+(\.[a-z0-9_]+)+$/i.test(trimmed)) return null;
  const [head, ...rest] = trimmed.split(".");
  return { head: head!, tool: rest.join(".") };
}

/**
 * Parses the single agent-facing call form:  tool`<name> ${args}`  or
 * tool`<name> ${args} ${opts}`. The tool name must be a literal in strings[0];
 * platform-level knobs live in the optional second slot so the argument object
 * stays 100% plugin schema (no reserved-word collisions).
 */
export interface ParsedCall {
  ref: ToolRef;
  args: Json;
  opts: { idempotencyKey?: string; timeoutMs?: number };
}

export function parseTemplateCall(
  strings: readonly string[],
  values: readonly unknown[],
): ParsedCall | { error: ToolError } {
  const name = strings[0]?.trim() ?? "";
  const ref = parseToolRef(name);
  if (!ref) return { error: { code: "bad_tool_name", message: `not a tool name: ${JSON.stringify(name)}` } };
  for (let i = 1; i < strings.length; i++) {
    if (strings[i]!.trim() !== "") {
      return { error: { code: "unexpected_text", message: "only interpolated values may follow the tool name" } };
    }
  }
  if (values.length < 1 || values.length > 2) {
    return { error: { code: "bad_arity", message: "expected an argument object, plus optional call options" } };
  }
  const [args, opts] = values;
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    return { error: { code: "bad_arguments", message: "arguments must be a JSON object" } };
  }
  const reserved = ["connection", "installation", "tenant", "agent"];
  const hit = reserved.find((k) => k in (args as object));
  if (hit) {
    return {
      error: {
        code: "reserved_argument",
        message: `"${hit}" is bound at configuration time, not passed per call — address a mount alias instead`,
      },
    };
  }
  return { ref, args: args as Json, opts: (opts as ParsedCall["opts"]) ?? {} };
}
