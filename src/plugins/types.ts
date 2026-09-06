import type { Json } from "../core/types.ts";

export interface ToolSchema {
  name: string;
  summary: string;
  parameters: Json;
  sideEffects: "read" | "write";
  /** Whether the plugin can make this call idempotent (§8.3). */
  idempotency: "native" | "key" | "none";
}

export interface PluginContext {
  /** Resolved server-side; the agent never sees the credential itself. */
  credential: string | null;
  publicConfig: Record<string, Json>;
}

export interface Plugin {
  id: string;
  version: string;
  tools: ToolSchema[];
  invoke(tool: string, args: Json, ctx: PluginContext): Promise<Json>;
}
