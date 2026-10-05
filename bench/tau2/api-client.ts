/**
 * The requests the Agents API runner makes (bench/tau2/api.ts), over a `fetch` it is handed — the network's,
 * or a Worker's own `fetch` in a test — so the runner can be driven end to end without a deployment.
 *
 * Two credentials, kept apart: the API key minted for the run authenticates `/v1`, as any API caller's would;
 * the operator's token reads what an API caller cannot (`/admin/models`, `/admin/transcript`, the object's
 * activity) and mints and revokes the key. Neither is ever put in an error, a log line or the record: an
 * error says which request failed and what the server answered, and the server's answer never echoes a
 * credential header.
 */
import { sseEvents, type SessionEvent } from "./api-turn.ts";

/** A non-2xx answer: the status and the parsed body, so a caller can tell a refused model from a broken request. */
export class ApiError extends Error {
  readonly status: number;
  readonly body: any;
  constructor(message: string, status: number, body: any) { super(message); this.status = status; this.body = body; }
}

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface ApiClient {
  /** A JSON request under `/v1`, with the run's key. Rejects on a non-2xx answer. */
  v1(method: string, path: string, body?: unknown): Promise<any>;
  /** Every element of a `/v1` cursor list, walked with `after`. */
  v1All(path: string): Promise<any[]>;
  /** A GET with the operator's token. Rejects on a non-2xx answer. */
  operator(path: string): Promise<any>;
  /** The session's event stream, opened: resolves once the server has answered (after its baseline read). */
  openStream(sessionId: string): Promise<{ events: AsyncIterable<SessionEvent>; close(): void }>;
  /** Mint the run's key (POST /admin/api-keys). */
  issueKey(tenantId: string, ownerAgentId: string, label: string): Promise<void>;
  /** Revoke it. Resolves false when the deployment cannot (an older one answers the body as a mint request). */
  revokeKey(): Promise<boolean>;
}

export function apiClient(o: { base: string; harnessToken: string; fetch?: Fetch; timeoutMs?: number }): ApiClient {
  const f: Fetch = o.fetch ?? ((url, init) => fetch(url, init));
  let key: string | null = null;
  const timeout = () => AbortSignal.timeout(o.timeoutMs ?? 120_000);

  async function json(method: string, path: string, headers: Record<string, string>, body?: unknown): Promise<any> {
    const r = await f(o.base + path, {
      method,
      headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: timeout(),
    });
    const text = await r.text();
    if (!r.ok) {
      let body: any = null;
      try { body = JSON.parse(text); } catch { /* not JSON: the message carries the text */ }
      throw new ApiError(`${method} ${path} → ${r.status}: ${text.slice(0, 300)}`, r.status, body);
    }
    return text ? JSON.parse(text) : null;
  }
  const bearer = () => {
    if (!key) throw new Error("no API key: issueKey first");
    return { authorization: `Bearer ${key}` };
  };
  const operatorHeaders = () => ({ "x-harness-token": o.harnessToken });

  return {
    v1: (method, path, body) => json(method, `/v1${path}`, bearer(), body),
    async v1All(path) {
      const out: any[] = [];
      let after: string | null = null;
      for (;;) {
        const sep = path.includes("?") ? "&" : "?";
        const page: any = await json("GET", `/v1${path}${sep}order=asc&limit=100${after ? `&after=${encodeURIComponent(after)}` : ""}`, bearer());
        out.push(...(page?.data ?? []));
        if (!page?.has_more || !page.last_id) return out;
        after = page.last_id;
      }
    },
    operator: (path) => json("GET", path, operatorHeaders()),
    async openStream(sessionId) {
      const ctl = new AbortController();
      const r = await f(`${o.base}/v1/agents/sessions/${encodeURIComponent(sessionId)}/events`, {
        headers: { ...bearer(), accept: "text/event-stream" }, signal: ctl.signal,
      });
      if (!r.ok || !r.body) throw new Error(`GET events → ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`);
      const reader = r.body.getReader();
      return {
        events: sseEvents(reader),
        // Both: the abort ends a network request, the cancel ends a stream a Worker in this process is writing.
        close: () => { ctl.abort(); reader.cancel().catch(() => {}); },
      };
    },
    async issueKey(tenantId, ownerAgentId, label) {
      const r = await json("POST", "/admin/api-keys", operatorHeaders(), { tenantId, ownerAgentId, label });
      if (typeof r?.key !== "string") throw new Error("POST /admin/api-keys answered without a key");
      key = r.key;
    },
    async revokeKey() {
      if (!key) return true;
      const r = await f(`${o.base}/admin/api-keys`, {
        method: "POST", headers: { ...operatorHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ revoke: key }), signal: timeout(),
      }).catch(() => null);
      const body: any = r ? await r.json().catch(() => null) : null;
      if (r?.ok && body?.revoked === true) { key = null; return true; }
      return false;
    },
  };
}
