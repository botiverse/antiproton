import type { Json } from "../core/types.ts";
import type { Plugin, PluginContext } from "./types.ts";

/**
 * Outbound HTTP, as a mount rather than a capability.
 *
 * Open by default, restricted by configuration. That is a deliberate reversal
 * of my first instinct, and worth writing down: an allowlist is weaker medicine
 * than it looks. It decides *who* may inject content into the model's context,
 * not whether injection works — and what actually bounds the damage here is
 * that the agent never holds a credential and that writes need a human. On
 * Cloudflare the SSRF story is also weak on its own: egress leaves through
 * Cloudflare's network, so RFC1918 and loopback go nowhere, and there is no
 * instance-metadata endpoint of the EC2/GCP kind to reach.
 *
 * So `allowedHosts` is opt-in: omit it and any public host is reachable; set it
 * (even to an empty list) and only those hosts are. Two tenants can differ,
 * because it is per mount.
 *
 * Two things it refuses regardless, because they are about reachability rather
 * than intent and cost nothing to keep:
 *
 *   - anything that is not http(s) — no file:, no data:, no gopher:
 *   - hosts that resolve inward by construction: localhost, .local, .internal,
 *     and IP literals in loopback, link-local or RFC1918 space. The cloud
 *     metadata address is the specific one worth naming: 169.254.169.254.
 *   - redirects, which are followed manually so the destination is checked
 *     against the same allowlist rather than trusted because the first hop was.
 *
 * Fetched text lands in the model's context, so it is attacker-controlled input
 * by definition. The body is capped and returned as data, never as instructions.
 */
export interface HttpConfig {
  /** Exact hostnames; no wildcards, since a wildcard is how an allowlist stops
   *  being one. Omit the field entirely to allow any public host. */
  allowedHosts?: string[];
  maxBytes?: number;
  timeoutMs?: number;
}

const PRIVATE_HOST =
  /^(localhost|.*\.local|.*\.internal|0\.0\.0\.0|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?|\[?f[cd])/i;

export function checkUrl(
  raw: string,
  /** undefined means unrestricted; an array — even an empty one — restricts. */
  allowed: string[] | undefined,
): { ok: true; url: URL } | { ok: false; why: string } {
  let url: URL;
  try { url = new URL(raw); } catch { return { ok: false, why: `not a url: ${raw.slice(0, 80)}` }; }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, why: `refused scheme ${url.protocol}` };
  }
  if (PRIVATE_HOST.test(url.hostname)) {
    return { ok: false, why: `refused internal host ${url.hostname}` };
  }
  if (allowed && !allowed.includes(url.hostname)) {
    return {
      ok: false,
      why: `${url.hostname} is not in this mount's allowlist (${allowed!.join(", ") || "empty"})`,
    };
  }
  return { ok: true, url };
}

export const httpPlugin: Plugin = {
  id: "http",
  version: "1.0.0",
  tools: [
    {
      name: "get",
      summary: "Fetch a URL over HTTP(S). Only hosts this mount allows; returns text, truncated.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "absolute http(s) url" },
          accept: { type: "string", description: "optional Accept header" },
        },
        required: ["url"],
      },
      sideEffects: "read",
      idempotency: "native",
    },
  ],

  async invoke(tool: string, args: Json, ctx: PluginContext): Promise<Json> {
    if (tool !== "get") throw new Error(`unknown tool: ${tool}`);
    const cfg = (ctx.publicConfig ?? {}) as HttpConfig;
    const allowed = cfg.allowedHosts;
    const maxBytes = cfg.maxBytes ?? 64 * 1024;
    const a = (args ?? {}) as { url?: string; accept?: string };

    let target = String(a.url ?? "");
    const hops: string[] = [];
    // Redirects are followed by hand so every hop is checked, not just the first.
    for (let hop = 0; hop < 4; hop++) {
      const check = checkUrl(target, allowed);
      if (!check.ok) throw new Error(check.why);
      hops.push(check.url.toString());

      const res = await fetch(check.url, {
        redirect: "manual",
        headers: {
          accept: a.accept ?? "text/plain, text/html;q=0.9, application/json;q=0.9, */*;q=0.1",
          "user-agent": "agent-harness/0.1",
        },
        signal: AbortSignal.timeout(cfg.timeoutMs ?? 15_000),
      });

      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location) {
        target = new URL(location, check.url).toString();
        continue;
      }

      const raw = await res.text();
      const body = raw.slice(0, maxBytes);
      return {
        status: res.status,
        url: check.url.toString(),
        contentType: res.headers.get("content-type"),
        bytes: raw.length,
        truncated: raw.length > body.length,
        hops: hops.length > 1 ? hops : undefined,
        body,
      };
    }
    throw new Error(`too many redirects from ${a.url}`);
  },
};
