/**
 * The sandbox broker: our key, their boundary.
 *
 * run9 issues one key for one project, and every agent's container lives in it.
 * Under that key our code can see every box in the project and chooses to look
 * only at its own — a boundary made of our own care, which holds until the day
 * someone writes the filter wrong. This service replaces the care with a
 * refusal: a tenant presents a token we issued, and an id it did not create is
 * not addressable, so there is nothing to remember to filter.
 *
 * It is also the only place that sees both the key and the box, which is why
 * the audit lives here. Container lifetimes are already recorded — inside each
 * agent's own object, where nothing can add them up.
 *
 * Deliberately small: an allowlist of the paths the sandbox plugin calls
 * (`route.ts`), one table of boxes (`ledger.ts`), and the forwarding below.
 * No prices, no quotas, no invoices — quantities only.
 */
import { DurableObject } from "cloudflare:workers";
import { decide } from "./route.ts";
import { Ledger, usage } from "./ledger.ts";

export interface Env {
  LEDGER: DurableObjectNamespace;
  /** The shared run9 key. Only this Worker ever holds it. */
  RUN9_AK: string;
  RUN9_SK: string;
  /** Where run9 actually is, and the one project this key belongs to. */
  RUN9_ENDPOINT: string;
  RUN9_PROJECT: string;
  /** Lets an operator issue a tenant a token. Never a tenant's own token. */
  ADMIN_TOKEN?: string;
}

/** A token is recognised, never reproduced: only its hash is kept. */
export async function hash(token: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export class LedgerObject extends DurableObject {
  #ledger: Ledger;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#ledger = new Ledger((ctx.storage as any).sql);
  }

  async call(method: keyof Ledger | "usage", ...args: any[]): Promise<any> {
    if (method === "usage") return usage(this.#ledger.since(Number(args[0] ?? 0)), Date.now());
    return (this.#ledger as any)[method](...args);
  }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const ledger = env.LEDGER.get(env.LEDGER.idFromName("ledger")) as any;
    const bearer = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();

    // Operator routes first, and separated by their own secret: issuing a token
    // and using one are different authorities, and a service that muddles them
    // lets a tenant mint a tenant.
    if (url.pathname === "/admin/token" && request.method === "POST") {
      if (!env.ADMIN_TOKEN || bearer !== env.ADMIN_TOKEN) return json({ error: "not an operator" }, 401);
      const body = (await request.json().catch(() => null)) as any;
      if (!body?.tenantId || !body?.agentId || !body?.token) {
        return json({ error: "tenantId, agentId and token are required" }, 400);
      }
      await ledger.call("issue", await hash(String(body.token)), String(body.tenantId), String(body.agentId), body.note ?? null);
      // The token is not echoed. Whoever posted it already has it, and a
      // service that reads credentials back is one leak away from handing them
      // to whoever can reach this route next.
      return json({ issued: true });
    }

    if (url.pathname === "/admin/usage" && request.method === "GET") {
      if (!env.ADMIN_TOKEN || bearer !== env.ADMIN_TOKEN) return json({ error: "not an operator" }, 401);
      return json({ since: Number(url.searchParams.get("since") ?? 0), tenants: await ledger.call("usage", url.searchParams.get("since") ?? 0) });
    }

    if (!bearer) return json({ error: "no token" }, 401);
    const caller = await ledger.call("tokenFor", await hash(bearer));
    if (!caller) return json({ error: "invalid api key" }, 401);

    // "Does my key work" is now a question about the token we issued, not about
    // run9's key, so it is answered here rather than forwarded. The plugin used
    // to ask by requesting a box id that cannot exist, reading run9's "box not
    // found" as proof the key was good — under a broker that request is
    // indistinguishable from reaching for someone else's box, and answering it
    // truthfully would mean telling a caller whether an id it does not own is
    // real.
    if (url.pathname === "/credential" && request.method === "GET") {
      return json({ ok: true, account: caller.tenantId });
    }

    const owned = await ledger.call("owned", caller.tenantId);
    const d = decide(request.method, url.pathname, {
      box: (id: string) => owned.boxes.has(id),
      exec: (id: string) => owned.execs.has(id),
      snap: (id: string) => owned.snaps.has(id),
    }, env.RUN9_PROJECT);

    if (d.kind === "refuse") return json({ error: d.reason }, d.status);
    if (d.kind === "answer") {
      // The plugin reads `box_id` off these, so the shape is run9's, filled
      // from what we know rather than from what run9 would have told us about
      // everyone.
      const boxes = await ledger.call("boxesOf", caller.tenantId);
      return json(boxes.map((b: any) => ({ box_id: b.boxId, created_at: b.startedAt })));
    }

    const upstream = await fetch(`${env.RUN9_ENDPOINT}${url.pathname}${url.search}`, {
      method: request.method,
      headers: {
        authorization: "Basic " + btoa(`${env.RUN9_AK}:${env.RUN9_SK}`),
        ...(request.headers.get("content-type") ? { "content-type": request.headers.get("content-type")! } : {}),
      },
      body: request.method === "GET" || request.method === "DELETE" ? undefined : await request.text(),
    });

    const text = await upstream.text();
    // Recorded only when it happened. A row written before the call would claim
    // a box that run9 may have refused to start, and the ledger would be
    // reporting containers nobody was ever charged for.
    if (upstream.ok && d.record) await record(ledger, caller, d.record, text);
    return new Response(text, { status: upstream.status, headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" } });
  },
};

async function record(ledger: any, caller: any, r: any, body: string) {
  let parsed: any = null;
  try { parsed = JSON.parse(body); } catch { /* run9 answers some calls in text */ }
  if (r.of === "box-created" && parsed?.box_id) await ledger.call("boxCreated", caller, String(parsed.box_id));
  if (r.of === "box-gone") await ledger.call("boxGone", r.id);
  if (r.of === "exec-created" && parsed?.exec_id) await ledger.call("execCreated", caller, r.box, String(parsed.exec_id));
  if (r.of === "snap-created" && parsed?.snap_id) await ledger.call("snapCreated", caller, String(parsed.snap_id));
}
