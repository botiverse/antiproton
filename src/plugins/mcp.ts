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
 * `StreamableHttpTransport` and `toLlmContent` (and the type `McpFetch`, which
 * leaves nothing in the bundle), and `test/mcp-plugin.ts` checks
 * both the list and that the bundle carries no `child_process`. No OAuth: a server
 * that needs a key gets it from a header whose value names a secret (`{{name}}`)
 * the owner kept from the console or the agent kept itself, filled in
 * server-side on every request.
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
import type { McpFetch } from "@earendil-works/pi-mcp";
import type { Json, MountRecord } from "../core/types.ts";
import { headerLines, type ListedTools, type Plugin, type PluginContext, type ToolSchema } from "./types.ts";
import { fillSecrets, hideSecrets, internalHost } from "./http.ts";

const VERSION = "1.0.0";
const DEFAULT_TIMEOUT_MS = 30_000;
/**
 * The longest one request may wait. A call holds the agent's turn while it
 * waits, and the gateway has no deadline of its own for a plugin, so an
 * unbounded setting would let one slow server hold a turn for as long as it
 * likes.
 */
const MAX_TIMEOUT_MS = 60_000;

/**
 * Why `value` is not a server URL this plugin will call, or null: https to a
 * public host, a path allowed. Asked on every connection, so a stored value
 * that predates this rule is refused too; `mcpConfigProblem` is the same rule
 * for the moment a mount is written.
 *
 * Not http even to localhost: a mount is written by whoever may add one, and
 * on a host that runs beside other services, loopback is those services.
 */
export function serverUrlProblem(value: unknown): string | null {
  if (typeof value !== "string" || !value) return "url is required: the server's Streamable HTTP endpoint, such as https://mcp.example.com/mcp";
  let url: URL;
  try { url = new URL(value); } catch { return `url is not an absolute URL: ${value.slice(0, 80)}`; }
  if (url.protocol !== "https:") return "url must be https";
  if (internalHost(url.hostname)) return `url must be a public host, not ${url.hostname}`;
  if (url.username || url.password) return "url must not carry a user name or password; put a key in a header with {{name}}";
  if (url.hash) return "url must not have a fragment";
  return null;
}

/**
 * Why a mount's settings are not ones this plugin will call with, or
 * undefined. The url rule above; the header and timeout rules are already the
 * fields' own (`format`, `min`/`max`).
 */
export function mcpConfigProblem(config: Record<string, unknown>): string | undefined {
  return serverUrlProblem(config.url) ?? undefined;
}

/**
 * fetch for pi-mcp's transport, refusing every redirect instead of following
 * it. The url was checked; where a redirect leads was not, and a public server
 * answering 307 to 169.254.169.254 would otherwise be followed there, carrying
 * the mount's headers. A server that has moved is reported with where to, so
 * the mount can be pointed there and checked like any other url.
 * `globalThis.fetch` is read per request and called without a receiver
 * (Workers refuse a platform fetch called on another object).
 */
const noRedirectFetch: McpFetch = async (input, init) => {
  const fetch = globalThis.fetch;
  const res = await fetch(input, { ...init, redirect: "manual" });
  if (res.status >= 300 && res.status < 400) {
    await res.body?.cancel().catch(() => {});
    // Whole, not cut: the caller's `failure` masks kept secrets in this text, and a cut through one would leave its head unmasked.
    const to = res.headers.get("location");
    throw new Error(`the server answered ${res.status} redirect${to ? ` to ${to}` : ""}; redirects are not followed — set url to the address it moved to`);
  }
  return res;
};

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

/**
 * Open a connection and initialize, filling `{{name}}` headers into `kept`.
 *
 * `kept` belongs to the caller and is filled before anything is sent, so every
 * failure from here on — `initialize` included, whose error carries up to 500
 * characters of the server's response body, which may echo the header back —
 * is hidden by the caller's `failure`. A client that failed to initialize is
 * closed here, since the caller never receives it.
 */
async function connect(ctx: PluginContext, kept: Map<string, string>): Promise<McpClient> {
  const cfg = ctx.publicConfig ?? {};
  const bad = serverUrlProblem(cfg.url);
  if (bad) throw new Error(`the ${ctx.alias} mount is misconfigured: ${bad}`);
  const parsed = headerLines(cfg.headers);
  if (!parsed.ok) throw new Error(`the ${ctx.alias} mount is misconfigured: ${parsed.error}`);
  const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (typeof timeoutMs !== "number" || !(timeoutMs >= 1 && timeoutMs <= MAX_TIMEOUT_MS)) {
    throw new Error(`the ${ctx.alias} mount is misconfigured: timeoutMs must be between 1 and ${MAX_TIMEOUT_MS}`);
  }
  // `{{name}}`: the owner's secret of that name first, then the agent's own. The owner's wins so
  // that the agent cannot shadow it with a `secret_put` of the same name; the url is the mount's
  // setting, not a call's argument, which is what lets an owner's secret go there at all.
  const lookup = { agentSecret: async (n: string) => (await ctx.ownerSecret?.(n)) ?? ctx.agentSecret(n) };
  const headers: Record<string, string> = {};
  for (const [name, spec] of parsed.headers) headers[name] = await fillSecrets(spec, kept, lookup);
  const client = new McpClient({ name: "antiproton", version: VERSION, requestTimeoutMs: timeoutMs });
  try {
    // No GET stream: nothing here listens between calls, and the connection is closed after one.
    await client.connect(new StreamableHttpTransport({ url: String(cfg.url), headers, openGetStream: false, fetch: noRedirectFetch }));
  } catch (e) {
    await client.close().catch(() => {});
    throw e;
  }
  return client;
}

/** A listed tool with every kept secret in its name, summary or parameters replaced by the secret's name. */
function maskSchema(t: ToolSchema, kept: Map<string, string>): ToolSchema {
  if (!kept.size) return t;
  return { ...t, name: hideSecrets(t.name, kept), summary: hideSecrets(t.summary, kept),
    parameters: maskJson(t.parameters ?? null, kept) };
}

/**
 * Every string in a JSON value, keys included, with kept secrets masked. On the
 * parsed value, never the JSON text: there a secret with a quote or a backslash
 * in it is written escaped and no longer matches, and a mask landing across the
 * text's syntax could leave it unparseable.
 */
function maskJson(v: Json, kept: Map<string, string>): Json {
  if (typeof v === "string") return hideSecrets(v, kept);
  if (Array.isArray(v)) return v.map((x) => maskJson(x, kept));
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [hideSecrets(k, kept), maskJson(x as Json, kept)]));
  }
  return v;
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
  // An owner may add a server from the console: the settings are a URL and header lines that hold names, never values.
  consoleMount: true,
  configProblem: mcpConfigProblem,
  // Owner secrets go only into the header lines of the mount's settings, sent to the mount's url.
  readsOwnerSecrets: true,
  // Empty on purpose: a mount's tools are what its server listed (`mountTools`).
  tools: [],
  config: [
    { name: "url", type: "string", required: true,
      summary: "The server's Streamable HTTP endpoint, such as https://mcp.example.com/mcp. https to a public host only." },
    { name: "headers", type: "string[]", format: "header-lines",
      summary: "Sent with every request, one \"Name: value\" per line. A value may contain {{name}}, filled in on each request from the secret kept under that name: the one the owner kept from the console, else the one the agent kept itself. The value is never written here." },
    { name: "timeoutMs", type: "number", default: DEFAULT_TIMEOUT_MS, min: 1, max: MAX_TIMEOUT_MS,
      summary: "How long one request to the server may take, in milliseconds; at most 60000. Listing the server's tools gets the same budget in total, however many pages it takes." },
  ],

  mountTools(mount: MountRecord): ToolSchema[] {
    return mount.toolSnapshot?.tools ?? [];
  },

  async snapshotTools(ctx: PluginContext): Promise<ListedTools> {
    const kept = new Map<string, string>();
    let client: McpClient | null = null;
    try {
      client = await connect(ctx, kept);
      // `timeoutMs` bounds each request; pi-mcp follows `nextCursor` for up to
      // 1000 pages, so the whole listing gets the same budget as one request.
      const listed = await client.listTools({ signal: AbortSignal.timeout(Number(ctx.publicConfig?.timeoutMs ?? DEFAULT_TIMEOUT_MS)) });
      // What a server lists is stored and put in the model's prompt, so a secret it echoes into a
      // tool's name, description or schema is masked here, as it is in a result or an error.
      // Verbatim only (`hideSecrets`); a name that was masked is no longer one the model can call,
      // and the kernel skips it with the reason.
      return { tools: listed.map((t) => maskSchema(toolSchemaOf(t), kept)) };
    } catch (e) {
      throw failure(e, kept, `listing ${ctx.alias}'s tools failed`, false);
    } finally {
      await client?.close().catch(() => {});
    }
  },

  async invoke(tool: string, args: Json, ctx: PluginContext): Promise<Json> {
    if (args !== undefined && args !== null && (typeof args !== "object" || Array.isArray(args))) {
      throw new Error(`${tool} takes an object of arguments`);
    }
    const kept = new Map<string, string>();
    let client: McpClient | null = null;
    let result;
    try {
      client = await connect(ctx, kept);
      result = await client.callTool(tool, (args ?? {}) as Record<string, unknown>);
    } catch (e) {
      // Only a call that got past `initialize` may have run on the far end.
      throw failure(e, kept, `${tool} on ${ctx.alias} failed`, client !== null);
    } finally {
      await client?.close().catch(() => {});
    }
    const content = toLlmContent(result).map((c) => (c.type === "text" ? { ...c, text: hideSecrets(c.text, kept) } : c));
    // The tool ran and said it failed: the model's to read, and not a transport failure to retry.
    if (result.isError) {
      const text = content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("\n");
      throw new Error(`${tool} on ${ctx.alias} reported an error: ${text || "(no message)"}`);
    }
    return { content } as Json;
  },
};
