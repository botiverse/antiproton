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

/**
 * HTML in, readable text out.
 *
 * Returning raw markup and truncating from the top is the worst possible slice:
 * the first 24 KB of a real page is `<head>` boilerplate, so the agent receives
 * no content at all. Watched live, it spent three turns writing progressively
 * more elaborate regexes to dig a description out of truncated markup, failed
 * every time, and only succeeded by abandoning the page for a JSON API.
 *
 * Scripts, styles and markup come out; the title and description come out
 * separately because they are small and often answer the question on their own.
 * Raw markup is still available on request for the cases that need it.
 */
export function htmlToText(html: string): { title: string; description: string; text: string } {
  const pick = (re: RegExp) => (re.exec(html)?.[1] ?? "").trim();
  const title = pick(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const description =
    pick(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i) ||
    pick(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)["']/i);

  const text = html
    // Anything whose contents are not prose, removed with its contents.
    .replace(/<(script|style|noscript|svg|template|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    // Block boundaries become line breaks so the shape of the page survives.
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|br)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();

  return { title: decodeEntities(title), description: decodeEntities(description), text };
}

const decodeEntities = (s: string) =>
  s.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
   .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");

export const httpPlugin: Plugin = {
  id: "http",
  version: "1.0.0",
  tools: [
    {
      name: "get",
      summary:
        "Fetch a URL over HTTP(S). HTML comes back as readable text with the page title and " +
        "description; JSON and plain text come back as-is. Pass raw:true for the markup.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "absolute http(s) url" },
          accept: { type: "string", description: "optional Accept header" },
          headers: {
            type: "object",
            description: "extra request headers; credentials are not accepted here",
          },
          raw: { type: "boolean", description: "return the markup instead of extracted text" },
        },
        required: ["url"],
      },
      sideEffects: "read",
      idempotency: "native",
    },
    {
      name: "send",
      summary:
        "POST, PUT, PATCH or DELETE to a URL — for APIs that need more than a GET. The response " +
        "comes back like get. This changes things on the far end, so a mount may hold it for a " +
        "person to approve. It carries no credentials: authentication belongs to a mount with a " +
        "secret, not to a header you write.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "absolute http(s) url" },
          method: { type: "string", description: "POST | PUT | PATCH | DELETE (default POST)" },
          body: { description: "string, or an object which is sent as JSON" },
          headers: { type: "object", description: "extra request headers; credentials are not accepted" },
          accept: { type: "string" },
        },
        required: ["url"],
      },
      // A write, so the policy layer can gate it: reads of the open web are one
      // thing, changing something on the far end is another.
      sideEffects: "write",
      idempotency: "none",
    },
  ],

  async invoke(tool: string, args: Json, ctx: PluginContext): Promise<Json> {
    if (tool !== "get" && tool !== "send") throw new Error(`unknown tool: ${tool}`);
    const cfg = (ctx.publicConfig ?? {}) as HttpConfig;
    const allowed = cfg.allowedHosts;
    const maxBytes = cfg.maxBytes ?? 64 * 1024;
    const a = (args ?? {}) as {
      url?: string; accept?: string; raw?: boolean;
      headers?: Record<string, unknown>; method?: string; body?: unknown;
    };

    /**
     * Headers the model asked for, minus the ones that carry identity.
     *
     * The whole point of the mount design is that a credential is dereferenced
     * server-side and never reaches the model. A model that can set
     * `authorization` can smuggle one back out, or fool itself into thinking it
     * has authenticated. Those headers belong to a mount with a secret_ref.
     */
    const FORBIDDEN = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key)$/i;
    const extra: Record<string, string> = {};
    const refused: string[] = [];
    for (const [k, v] of Object.entries(a.headers ?? {})) {
      if (FORBIDDEN.test(k)) { refused.push(k); continue; }
      if (typeof v === "string" || typeof v === "number") extra[k.toLowerCase()] = String(v);
    }

    let target = String(a.url ?? "");
    const hops: string[] = [];
    // Redirects are followed by hand so every hop is checked, not just the first.
    for (let hop = 0; hop < 4; hop++) {
      const check = checkUrl(target, allowed);
      if (!check.ok) throw new Error(check.why);
      hops.push(check.url.toString());

      const method = tool === "send"
        ? String(a.method ?? "POST").toUpperCase()
        : "GET";
      if (tool === "send" && !["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
        throw new Error(`send does not do ${method}; use web.get for reads`);
      }
      const jsonBody = a.body !== undefined && typeof a.body !== "string";
      const res = await fetch(check.url, {
        method,
        redirect: "manual",
        headers: {
          accept: a.accept ?? "text/plain, text/html;q=0.9, application/json;q=0.9, */*;q=0.1",
          "user-agent": "antiproton/0.1",
          ...(jsonBody ? { "content-type": "application/json" } : {}),
          ...extra,
        },
        ...(a.body !== undefined
          ? { body: jsonBody ? JSON.stringify(a.body) : String(a.body) }
          : {}),
        signal: AbortSignal.timeout(cfg.timeoutMs ?? 15_000),
      });

      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location) {
        target = new URL(location, check.url).toString();
        continue;
      }

      const payload = await res.text();
      const type = res.headers.get("content-type") ?? "";
      const isHtml = /html|xml/i.test(type) || /^\s*<(!doctype|html)/i.test(payload);

      if (isHtml && !a.raw) {
        const { title, description, text } = htmlToText(payload);
        const body = text.slice(0, maxBytes);
        return {
          status: res.status, url: check.url.toString(), contentType: type,
          title, description,
          bytes: payload.length, textBytes: text.length,
        ...(refused.length ? { refusedHeaders: refused } : {}),
          truncated: text.length > body.length,
          hops: hops.length > 1 ? hops : undefined,
          text: body,
        };
      }

      const body = payload.slice(0, maxBytes);
      return {
        status: res.status,
        url: check.url.toString(),
        contentType: type,
        bytes: payload.length,
        ...(refused.length ? { refusedHeaders: refused } : {}),
        truncated: payload.length > body.length,
        hops: hops.length > 1 ? hops : undefined,
        body,
      };
    }
    throw new Error(`too many redirects from ${a.url}`);
  },
};
