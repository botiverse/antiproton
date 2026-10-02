/**
 * One remote MCP server, as a mount. Its tools become the mount's tools,
 * `<alias>.<tool>`, called by the model directly or from run_js like any other.
 *
 * What the server offers is learned when the mount is added and when an
 * operator asks for a refresh (`snapshotTools`), and kept on the mount record;
 * every other reader — the catalogue, the gateway, `tools.describe` — reads that
 * stored list (`mountTools`). So a wake or a harness build never reaches the
 * server, and the list an agent is offered changes only when a person asked.
 *
 * Streamable HTTP only. pi-mcp's stdio transport spawns a process, which a
 * Worker cannot do. The package has no subpath for its transports, so even this
 * file's import resolves `stdio.js` and `cross-spawn` at module level; what
 * keeps them out of the Worker is the bundler dropping the unreferenced
 * `StdioTransport`, not the import list. This file imports exactly `McpClient`,
 * `StreamableHttpTransport` and `toLlmContent`, and `test/mcp-plugin.ts` checks
 * both the list and that the bundle carries no `child_process`. No OAuth: a server
 * that needs a key gets it from a header whose value names a secret the agent
 * kept (`{{name}}`), filled in server-side on every request.
 *
 * The transport has no way to take a session id from an earlier connection, so
 * every call opens a fresh connection and initializes again: one `initialize`,
 * the call, then close. A server that keeps state in its session sees a new
 * session per call. That costs a round trip per call and keeps nothing alive
 * between calls, which is also why this plugin declares no `holds`.
 *
 * What a server says about a tool can only make it more conservative here:
 * only `readOnlyHint: true` makes a tool a read, and every tool is
 * `idempotency: "none"`. A server that leaves its annotations out, or marks a
 * tool destructive, gets a write — which a mount's policy can hold for a person.
 */
import { McpClient, StreamableHttpTransport, toLlmContent } from "@earendil-works/pi-mcp";
import type { Json, MountRecord } from "../core/types.ts";
import type { ListedTools, Plugin, PluginContext, ToolSchema } from "./types.ts";
import { fillSecrets, hideSecrets } from "./http.ts";

const VERSION = "1.0.0";
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Headers the transport writes itself. A mount that set one would either be
 * overwritten or would break the protocol under the transport — a session id
 * given here would not resume anything, since `connect` initializes regardless.
 */
const RESERVED_HEADER = /^(accept|content-type|content-length|host|mcp-session-id|mcp-protocol-version|last-event-id)$/i;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** Why `value` is not a server URL this plugin will call, or null. https, or http to this machine; a path is allowed. */
export function serverUrlProblem(value: unknown): string | null {
  if (typeof value !== "string" || !value) return "url is required: the server's Streamable HTTP endpoint, such as https://mcp.example.com/mcp";
  let url: URL;
  try { url = new URL(value); } catch { return `url is not an absolute URL: ${value.slice(0, 80)}`; }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return "url must be https (http only for localhost)";
  if (url.username || url.password) return "url must not carry a user name or password; put a key in a header with {{name}}";
  if (url.hash) return "url must not have a fragment";
  return null;
}

/** `"Name: value"` lines as pairs, or the first line that is not one. */
export function parseHeaderLines(lines: unknown): { ok: true; headers: Array<[string, string]> } | { ok: false; error: string } {
  if (lines === undefined || lines === null) return { ok: true, headers: [] };
  if (!Array.isArray(lines)) return { ok: false, error: "headers must be a list of \"Name: value\" lines" };
  const out: Array<[string, string]> = [];
  for (const line of lines) {
    const text = String(line);
    const at = text.indexOf(":");
    const name = at > 0 ? text.slice(0, at).trim() : "";
    if (!HEADER_NAME.test(name)) return { ok: false, error: `header "${text.slice(0, 40)}" is not "Name: value"` };
    if (RESERVED_HEADER.test(name)) return { ok: false, error: `header ${name} is written by the MCP transport and cannot be set` };
    out.push([name, text.slice(at + 1).trim()]);
  }
  return { ok: true, headers: out };
}

/** The tool as the gateway knows it. Remote annotations may only make it more conservative. */
export function toolSchemaOf(t: {
  name: string; title?: string; description?: string; inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
}): ToolSchema {
  const read = t.annotations?.readOnlyHint === true && t.annotations?.destructiveHint !== true;
  return {
    name: t.name,
    summary: t.description ?? t.title ?? "",
    parameters: t.inputSchema as Json,
    sideEffects: read ? "read" : "write",
    idempotency: "none",
  };
}

type Connection = { client: McpClient; kept: Map<string, string> };

/** Open a connection and initialize. Every caller closes it in a `finally`. */
async function connect(ctx: PluginContext): Promise<Connection> {
  const cfg = ctx.publicConfig ?? {};
  const bad = serverUrlProblem(cfg.url);
  if (bad) throw new Error(`the ${ctx.alias} mount is misconfigured: ${bad}`);
  const parsed = parseHeaderLines(cfg.headers);
  if (!parsed.ok) throw new Error(`the ${ctx.alias} mount is misconfigured: ${parsed.error}`);
  const kept = new Map<string, string>();
  const headers: Record<string, string> = {};
  for (const [name, spec] of parsed.headers) headers[name] = await fillSecrets(spec, kept, ctx);
  const timeoutMs = typeof cfg.timeoutMs === "number" && cfg.timeoutMs > 0 ? cfg.timeoutMs : DEFAULT_TIMEOUT_MS;
  const client = new McpClient({ name: "antiproton", version: VERSION, requestTimeoutMs: timeoutMs });
  // No GET stream: nothing here listens between calls, and the connection is closed after one.
  await client.connect(new StreamableHttpTransport({ url: String(cfg.url), headers, openGetStream: false }));
  return { client, kept };
}

/** A failure as the model reads it, with every kept secret replaced by its name. */
function failure(e: unknown, kept: Map<string, string>, what: string, mayHaveLanded: boolean): Error {
  const err = e as { message?: unknown; status?: unknown; name?: unknown };
  const status = typeof err?.status === "number" ? err.status : null;
  const out = new Error(hideSecrets(`${what}: ${String(err?.message ?? e)}`, kept)) as Error & { retryable?: boolean };
  // Sent and then lost — a timeout, a dropped connection, a server error — may
  // have run on the far end; a refusal (4xx) or a protocol error did not.
  if (mayHaveLanded && (status === null ? err?.name !== "McpError" : status >= 500)) out.retryable = true;
  return out;
}

export const mcpPlugin: Plugin = {
  id: "mcp",
  version: VERSION,
  // Empty on purpose: a mount's tools are what its server listed (`mountTools`).
  tools: [],
  config: [
    { name: "url", type: "string", required: true,
      summary: "The server's Streamable HTTP endpoint, such as https://mcp.example.com/mcp. https only (http only for localhost)." },
    { name: "headers", type: "string[]",
      summary: "Sent with every request, one \"Name: value\" per line. A value may contain {{name}}, filled in on each request from a secret the agent kept under that name; the value is never written here." },
    { name: "timeoutMs", type: "number", default: DEFAULT_TIMEOUT_MS, summary: "How long one request to the server may take." },
  ],

  mountTools(mount: MountRecord): ToolSchema[] {
    return mount.toolSnapshot?.tools ?? [];
  },

  async snapshotTools(ctx: PluginContext): Promise<ListedTools> {
    let conn: Connection | null = null;
    try {
      conn = await connect(ctx);
      const listed = await conn.client.listTools();
      return { tools: listed.map(toolSchemaOf) };
    } catch (e) {
      throw failure(e, conn?.kept ?? new Map(), `listing ${ctx.alias}'s tools failed`, false);
    } finally {
      await conn?.client.close().catch(() => {});
    }
  },

  async invoke(tool: string, args: Json, ctx: PluginContext): Promise<Json> {
    if (args !== undefined && args !== null && (typeof args !== "object" || Array.isArray(args))) {
      throw new Error(`${tool} takes an object of arguments`);
    }
    let conn: Connection | null = null;
    let sent = false;
    let result;
    try {
      conn = await connect(ctx);
      sent = true;
      result = await conn.client.callTool(tool, (args ?? {}) as Record<string, unknown>);
    } catch (e) {
      throw failure(e, conn?.kept ?? new Map(), `${tool} on ${ctx.alias} failed`, sent);
    } finally {
      await conn?.client.close().catch(() => {});
    }
    const kept = conn.kept;
    const content = toLlmContent(result).map((c) => (c.type === "text" ? { ...c, text: hideSecrets(c.text, kept) } : c));
    // The tool ran and said it failed: the model's to read, and not a transport failure to retry.
    if (result.isError) {
      const text = content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("\n");
      throw new Error(`${tool} on ${ctx.alias} reported an error: ${text || "(no message)"}`);
    }
    return { content } as Json;
  },
};
