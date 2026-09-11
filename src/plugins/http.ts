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
  /**
   * Where a search goes. Keyless by default, because a capability that needs an
   * account before it works is a capability nobody turns on. An operator who
   * wants a real search API points this at one; the shape is the same.
   */
  searchEndpoint?: string;
  /** Exact hostnames; no wildcards, since a wildcard is how an allowlist stops
   *  being one. Omit the field entirely to allow any public host. */
  allowedHosts?: string[];
  maxBytes?: number;
  timeoutMs?: number;
}

const PRIVATE_HOST =
  /^(localhost|.*\.local|.*\.internal|0\.0\.0\.0|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?|\[?f[cd])/i;

/**
 * The response headers, minus the ones that are a credential in disguise.
 *
 * Half of working with an API lives here: `link` carries pagination, the
 * `x-ratelimit-*` family says when to stop, `etag` and `last-modified` make a
 * second fetch cheap, `retry-after` says how long to wait, `location` explains
 * a redirect. Dropping them left the agent guessing at all of it.
 *
 * `set-cookie` is withheld for the same reason `authorization` is refused on
 * the way out: a session token handed to the model is a credential the model
 * holds, and it could replay it.
 */
function responseHeaders(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((v, k) => {
    if (/^set-cookie$/i.test(k)) { out["set-cookie"] = "(withheld)"; return; }
    out[k.toLowerCase()] = v.length > 400 ? `${v.slice(0, 400)}…` : v;
  });
  return out;
}

/** Tags out, entities in: search titles and snippets arrive as markup. */
function stripTags(x: string): string {
  return x
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

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

/** Declared on the setting and applied in the code, from one place, because a
 *  console showing a blank default for a setting that has one is how a person
 *  learns the wrong number. */
const DEFAULT_MAX_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;

export const httpPlugin: Plugin = {
  id: "http",
  config: [
    // "Unset means any public host" is the right default for an anonymous
    // mount and the wrong one for a mount holding a key, and the difference is
    // structural rather than a matter of care: for every other credential
    // plugin the host is fixed by the plugin, while here the agent chooses the
    // URL. So a credential on an http mount goes wherever the agent points it,
    // and this setting is the only thing that bounds it.
    //
    // No http mount can carry a credential today — the plugin declares none.
    // If that ever changes, the allowlist stops being advice: a
    // credential-bearing mount should be refused at mount time when this is
    // empty, rather than documented as a hazard someone configuring in a hurry
    // will inherit. Written here because this is the line that would be
    // inherited.
    { name: "allowedHosts", type: "string[]", summary: "When set, only these hosts may be reached. Unset means any public host." },
    // Nothing parks anything: this plugin has no object storage to park into,
    // and never had. What the setting decides is how much of the body comes
    // back; the result reports the full size beside it so the loss is visible.
    //
    // Named in bytes and applied in UTF-16 code units: `text.slice(0, maxBytes)`
    // counts units, so 24,000 units of CJK is 72,000 bytes. Measured and left
    // alone deliberately — the tool-result offload counts the same unit
    // (`JSON.stringify(result).length` in cf/src/runtime.ts), so both sides are
    // wrong in the same direction and agree, and a rename would refuse every
    // mount already carrying the old key.
    { name: "maxBytes", type: "number", default: DEFAULT_MAX_BYTES,
      summary: "How much of a response body is returned. The rest is cut and discarded, not kept anywhere; `bytes` reports the full size, so a truncated result says how much went." },
    { name: "timeoutMs", type: "number", default: DEFAULT_TIMEOUT_MS, summary: "How long one request may take." },
    { name: "searchEndpoint", type: "string", summary: "Where the search tool sends its query." },
  ],
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
          method: { type: "string", description: "GET (default), HEAD or OPTIONS" },
          follow: {
            type: "boolean",
            description: "false to see the redirect itself rather than where it leads",
          },
        },
        required: ["url"],
      },
      sideEffects: "read",
      idempotency: "native",
    },
    {
      name: "send",
      summary:
        "POST, PUT, PATCH or DELETE to a URL — for APIs that need more than a GET. An object body " +
        "is sent as JSON; set form:true to send it url-encoded instead. The response comes back " +
        "like get, with its status and headers. This changes things on the far end, so a mount " +
        "may hold it for a person to approve. It carries no credentials: authentication belongs " +
        "to a mount with a secret, not to a header you write.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "absolute http(s) url" },
          method: { type: "string", description: "POST | PUT | PATCH | DELETE (default POST)" },
          body: { description: "string, or an object which is sent as JSON" },
          headers: { type: "object", description: "extra request headers; credentials are not accepted" },
          accept: { type: "string" },
          form: { type: "boolean", description: "send an object body as application/x-www-form-urlencoded" },
          follow: { type: "boolean", description: "false to see a redirect rather than follow it" },
        },
        required: ["url"],
      },
      // A write, so the policy layer can gate it: reads of the open web are one
      // thing, changing something on the far end is another.
      sideEffects: "write",
      idempotency: "none",
    },
    {
      name: "search",
      summary:
        "Search the web and get back titles, urls and snippets. Use it when you do not already " +
        "know which page to read — guessing a url and fetching it is how a search becomes three " +
        "wasted turns. Then read the ones that look right with web.get.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          limit: { type: "integer", description: "default 8, at most 20" },
        },
        required: ["query"],
      },
      sideEffects: "read",
      idempotency: "native",
    },
  ],

  async invoke(tool: string, args: Json, ctx: PluginContext): Promise<Json> {
    if (!["get", "send", "search"].includes(tool)) throw new Error(`unknown tool: ${tool}`);
    const cfg = (ctx.publicConfig ?? {}) as HttpConfig;
    const allowed = cfg.allowedHosts;
    const maxBytes = cfg.maxBytes ?? DEFAULT_MAX_BYTES;
    const a = (args ?? {}) as {
      url?: string; accept?: string; raw?: boolean;
      headers?: Record<string, unknown>; method?: string; body?: unknown;
      form?: boolean; follow?: boolean;
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

    if (tool === "search") {
      const q = String((args as any)?.query ?? "").trim();
      if (!q) throw new Error("query is required");
      const limit = Math.min(Math.max(Number((args as any)?.limit ?? 8), 1), 20);
      // Two endpoints, because a keyless one is a keyless one: it answers a
      // few queries and then starts serving a captcha. An operator who wants
      // reliability points searchEndpoint at an API with a key.
      const endpoints = cfg.searchEndpoint
        ? [cfg.searchEndpoint]
        : ["https://html.duckduckgo.com/html/?q=", "https://lite.duckduckgo.com/lite/?q="];
      let page = "";
      let refused = "";
      for (const endpoint of endpoints) {
        const res = await fetch(endpoint + encodeURIComponent(q), {
          headers: {
            // Without a browser-shaped agent the endpoint answers with a page
            // that has no results in it.
            "user-agent":
              "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
            accept: "text/html",
          },
          signal: AbortSignal.timeout(cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        });
        if (!res.ok) { refused = `HTTP ${res.status}`; continue; }
        const body = await res.text();
        // A challenge page is not an empty result set, and reporting it as one
        // tells the agent the thing it asked about does not exist. It comes
        // back as HTTP 202 with a captcha in it, so the status is no help.
        if (/complete the following challenge|bots use DuckDuckGo|captcha/i.test(body)) {
          refused = "the search endpoint served a bot challenge";
          continue;
        }
        page = body;
        break;
      }
      if (!page) {
        throw new Error(
          `search is unavailable: ${refused}. This is a rate limit, not an empty result — ` +
          `do not conclude the subject does not exist. Try again, or fetch a likely url directly.`,
        );
      }
      const results: Array<{ title: string; url: string; snippet: string }> = [];
      const link = /result__a"\s+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
      const snips = [...page.matchAll(/result__snippet"[^>]*>([\s\S]*?)<\/a>/g)]
        .map((m) => stripTags(m[1]!));
      for (let m = link.exec(page); m && results.length < limit; m = link.exec(page)) {
        // The href is a redirector; the real destination is a parameter on it.
        const direct = /[?&]uddg=([^&"]+)/.exec(m[1]!);
        const url = direct ? decodeURIComponent(direct[1]!) : m[1]!;
        if (!/^https?:\/\//.test(url)) continue;
        // The same rules as a fetch: an allowlisted mount does not get to
        // search its way around its own allowlist.
        if (!checkUrl(url, allowed).ok) continue;
        results.push({ title: stripTags(m[2]!), url, snippet: snips[results.length] ?? "" });
      }
      // Zero results has two very different causes, and reporting them the same
      // way is how an agent concludes a subject does not exist. A real results
      // page says so itself; a page this parser cannot read says nothing, and
      // that is the one that must not be called "no results". Endpoint markup
      // changes, so this is a guard against the future as much as the present.
      if (!results.length && !/no results|did not match|result__a|result-link/i.test(page)) {
        throw new Error(
          "search could not read the results page — the endpoint's format may have changed. " +
          "This is not an empty result: do not conclude the subject does not exist.",
        );
      }
      return { query: q, count: results.length, results };
    }

    let target = String(a.url ?? "");
    const hops: string[] = [];
    // Redirects are followed by hand so every hop is checked, not just the first.
    for (let hop = 0; hop < 4; hop++) {
      const check = checkUrl(target, allowed);
      if (!check.ok) throw new Error(check.why);
      hops.push(check.url.toString());

      const method = String(a.method ?? (tool === "send" ? "POST" : "GET")).toUpperCase();
      // The split is what lets the policy layer gate one and not the other, so
      // the safe verbs stay on the read tool and the rest on the write tool.
      const reads = ["GET", "HEAD", "OPTIONS"];
      if (tool === "send" && !["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
        throw new Error(`send does not do ${method}; ${reads.join(", ")} are reads — use web.get`);
      }
      if (tool === "get" && !reads.includes(method)) {
        throw new Error(`get does ${reads.join(", ")}; ${method} changes things — use web.send`);
      }
      const objectBody = a.body !== undefined && typeof a.body !== "string";
      const formBody = objectBody && a.form === true;
      const jsonBody = objectBody && !formBody;
      const res = await fetch(check.url, {
        method,
        redirect: "manual",
        headers: {
          accept: a.accept ?? "text/plain, text/html;q=0.9, application/json;q=0.9, */*;q=0.1",
          "user-agent": "antiproton/0.1",
            ...(jsonBody ? { "content-type": "application/json" } : {}),
          ...(formBody ? { "content-type": "application/x-www-form-urlencoded" } : {}),
          ...extra,
        },
        ...(a.body !== undefined
          ? {
              body: formBody
                ? new URLSearchParams(
                    Object.entries(a.body as Record<string, unknown>)
                      .map(([k, v]) => [k, String(v)]),
                  ).toString()
                : jsonBody ? JSON.stringify(a.body) : String(a.body),
            }
          : {}),
        signal: AbortSignal.timeout(cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });

      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location && a.follow !== false) {
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
          status: res.status, statusText: res.statusText,
          url: check.url.toString(), contentType: type,
          headers: responseHeaders(res.headers),
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
        statusText: res.statusText,
        url: check.url.toString(),
        contentType: type,
        headers: responseHeaders(res.headers),
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
