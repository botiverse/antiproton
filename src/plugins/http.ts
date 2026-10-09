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

/**
 * Whether `hostname`, as `URL` writes it, names somewhere inward by
 * construction: a name with no dot, a name under a suffix reserved for a local
 * network, or an address in a range that is not the public internet — v4, or
 * v4 carried inside v6. The cloud metadata address (169.254.169.254) is the one
 * most worth refusing. `URL` has already turned every IPv4 spelling (hex, or
 * one 32-bit number) into dotted decimal, so only that form is read.
 *
 * A public name that resolves inward is not seen here; nothing before the
 * request can see that. One case is refused anyway: a name whose labels spell
 * an inward v4 in dotted or dashed decimal (10.0.0.1.nip.io, 10-0-0-1.sslip.io),
 * the common spellings of services that resolve such names back to the address.
 * Only those two spellings; the same services also accept hex and v6 forms
 * (a9fea9fe.nip.io, fe80--1.sslip.io), so the services whose only purpose is
 * to resolve a name to an address written in it, or to loopback, are refused
 * by suffix whatever the spelling (`RESOLVER_SUFFIX`). That list is the ones
 * known here, not all that exist: someone else's wildcard DNS passes like any
 * other name that resolves inward. The rule also refuses a public name that
 * merely contains such a run (node-10-1-2-3.example.com); the refusal names
 * the host.
 */
/** Public DNS services that answer with the address written in the name, or with loopback for any name. */
const RESOLVER_SUFFIX = /(^|\.)(nip\.io|sslip\.io|xip\.io|traefik\.me|localtest\.me|lvh\.me|localho\.st|localhost\.direct|lacolhost\.com)$/;

export function internalHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.+$/, "");
  if (h.startsWith("[")) return internalV6(h.slice(1, -1));
  // A name with no dot is only ever found through a local search domain
  // (`localhost`, `internal`, `metadata`); no public server is reached that way.
  if (!h.includes(".")) return true;
  if (/\.(localhost|local|internal|home\.arpa)$/.test(h)) return true;
  if (RESOLVER_SUFFIX.test(h)) return true;
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (v4) return internalV4(v4.slice(1, 5).map(Number));
  for (const m of h.matchAll(/(?:^|[.-])(\d{1,3})[.-](\d{1,3})[.-](\d{1,3})[.-](\d{1,3})(?=[.-]|$)/g)) {
    const quad = m.slice(1, 5).map(Number);
    if (quad.every((n) => n <= 255) && internalV4(quad)) return true;
  }
  return false;
}

/** Not the public internet: this-network, private, shared, loopback, link-local, benchmarking, multicast, reserved. */
function internalV4([a, b]: number[]): boolean {
  return a === 0 || a === 10 || a === 127 || a! >= 224 || (a === 169 && b === 254) || (a === 172 && b! >= 16 && b! <= 31) ||
    (a === 192 && b === 168) || (a === 100 && b! >= 64 && b! <= 127) || (a === 198 && (b === 18 || b === 19));
}

/** The eight 16-bit groups of an IPv6 address as `URL` writes it (no embedded dotted quad), or null. */
function groupsOf(v6: string): number[] | null {
  const halves = v6.split("::");
  if (halves.length > 2) return null;
  const part = (s: string) => (s ? s.split(":").map((g) => parseInt(g, 16)) : []);
  const head = part(halves[0]!), tail = halves.length === 2 ? part(halves[1]!) : [];
  const fill = 8 - head.length - tail.length;
  if (fill < 0 || (halves.length === 1 && fill !== 0) || [...head, ...tail].some((g) => !(g >= 0 && g <= 0xffff))) return null;
  return [...head, ...Array(fill).fill(0), ...tail];
}

/**
 * Loopback, unspecified, unique-local, link- and site-local, multicast, and
 * every form that carries a v4 address — compatible (::/96), mapped
 * (::ffff:0:0/96), translated (::ffff:0:0:0/96), NAT64 (64:ff9b::/96), 6to4
 * (2002::/16) — judged by the v4 it carries. 64:ff9b:1::/48 is local-use NAT64
 * with no fixed place for the v4, so the whole prefix is refused. Unparseable
 * is refused: `URL` only hands over what it parsed.
 */
function internalV6(v6: string): boolean {
  const g = groupsOf(v6);
  if (!g) return true;
  const v4 = (hi: number, lo: number) => internalV4([hi >> 8, hi & 255, lo >> 8, lo & 255]);
  const zeros = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  if (g[0]! >= 0xfc00 && g[0]! <= 0xfdff) return true;
  if (g[0]! >= 0xfe80 && g[0]! <= 0xffff) return true; // link-local, site-local, multicast
  // :: and ::1 included: they read as 0.0.0.0 and 0.0.0.1, both in this-network.
  if (zeros(0, 6)) return v4(g[6]!, g[7]!);
  if (zeros(0, 5) && g[5] === 0xffff) return v4(g[6]!, g[7]!);
  if (zeros(0, 4) && g[4] === 0xffff && g[5] === 0) return v4(g[6]!, g[7]!);
  if (g[0] === 0x64 && g[1] === 0xff9b && zeros(2, 6)) return v4(g[6]!, g[7]!);
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) return true;
  if (g[0] === 0x2002) return v4(g[1]!, g[2]!);
  return false;
}

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
  if (internalHost(url.hostname)) {
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

/** `{{name}}` in a header value: where a secret the agent kept is filled in. */
const SECRET_SLOT = /\{\{([^}]*)\}\}/;

/**
 * The value of a secret the agent kept, read once per request and remembered
 * in `kept` so the same name costs one read and `hideSecrets` knows every value
 * that went out. A name with no secret behind it is the agent's to fix, so the
 * message says how.
 */
export async function keptSecret(name: string, kept: Map<string, string>, ctx: Pick<PluginContext, "agentSecret">): Promise<string> {
  const have = kept.get(name);
  if (have !== undefined) return have;
  const value = await ctx.agentSecret(name);
  if (value === null) throw new Error(`no secret named ${name}; keep one with secret_put, or see secret_list`);
  kept.set(name, value);
  return value;
}

/**
 * Text with every `{{name}}` replaced by the secret the agent kept under that
 * name, resolved server-side at the moment of the request. Most services want
 * `Bearer <key>` and what an agent keeps is the bare key, which is why this is
 * a template and not a name.
 */
export async function fillSecrets(spec: string, kept: Map<string, string>, ctx: Pick<PluginContext, "agentSecret">): Promise<string> {
  for (const m of spec.matchAll(new RegExp(SECRET_SLOT.source, "g"))) await keptSecret(m[1]!.trim(), kept, ctx);
  return spec.replace(new RegExp(SECRET_SLOT.source, "g"), (_, n: string) => kept.get(n.trim())!);
}

/**
 * Every verbatim appearance of a value in `kept` replaced with its name. Only
 * verbatim: a server that encodes the value (URL, JSON escapes, base64) is not
 * recognised, so this narrows the leak and does not close it. Values shorter
 * than four characters are left alone, or every `a` in a page would be a secret.
 * Longest first: a value that contains another is longer than it, so the
 * container is always masked before the part could split it — the whole
 * containment case, not a usual one. In insertion order the shorter could go
 * first and leave the rest of the longer in the text.
 */
export function hideSecrets(text: string, kept: Map<string, string>): string {
  return replaceSecrets(text, kept, 4, (name) => `[secret ${name}]`).text;
}

/**
 * `hideSecrets` with the shortest value it replaces and the mark it leaves chosen by the caller, and how many
 * appearances it replaced. It sorts `kept` on every call, which is right for one response; the evaluation export
 * (cf/src/eval-read.ts `credentialRedactor`) walks thousands of strings, so it prepares its own patterns once instead.
 */
export function replaceSecrets(
  text: string, kept: Map<string, string>, min: number, mark: (name: string) => string,
): { text: string; count: number } {
  let count = 0;
  const out = [...kept].sort(([, a], [, b]) => b.length - a.length).reduce((t, [name, value]) => {
    if (value.length < min) return t;
    const parts = t.split(value);
    count += parts.length - 1;
    return parts.length > 1 ? parts.join(mark(name)) : t;
  }, text);
  return { text: out, count };
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
    // The refusal is declared anyway, because the hazard belongs to the
    // *mount* rather than to the plugin: `secret_ref` is a mount field, so a
    // mount of this plugin can carry a key before the plugin ever declares
    // one. `requiredWithCredential` is what turns the paragraph above from
    // advice a future author has to remember into a rule the validator
    // applies.
    { name: "allowedHosts", type: "string[]", requiredWithCredential: true,
      summary: "When set, only these hosts may be reached. Unset means any public host — which is why a mount holding a credential must set it." },
    // Nothing parks anything: this plugin has no object storage to park into,
    // and never had. What the setting decides is how much of the body comes
    // back; the result reports the full size beside it so the loss is visible.
    //
    // Named in bytes and applied in UTF-16 code units: `text.slice(0, maxBytes)`
    // counts units, so 24,000 units of CJK is 72,000 bytes. Measured and left
    // alone deliberately — the tool-result offload counts the same unit, so
    // both sides are wrong in the same direction and therefore agree, and a
    // rename would refuse every mount already carrying the old key.
    //
    // Quoted rather than paraphrased, so the citation can be grepped:
    //     cf/src/runtime.ts   const body = JSON.stringify(res.result);
    //     cf/src/runtime.ts   if (body.length <= offloadLimit(readBack)) return res;
    { name: "maxBytes", type: "number", default: DEFAULT_MAX_BYTES,
      summary: "How much of a response body is returned. The rest is cut and discarded, not kept anywhere; `bytes` reports the full size, so a truncated result says how much went." },
    { name: "timeoutMs", type: "number", default: DEFAULT_TIMEOUT_MS, summary: "How long one request may take." },
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
            description: "extra request headers; credentials go in secretHeaders instead",
          },
          secretHeaders: {
            type: "object", additionalProperties: { type: "string" },
            description: "header → the name of a secret you kept with secret_put, or text with {{name}} in it: " +
              "{\"x-api-key\": \"openai\"}, {\"authorization\": \"Bearer {{openai}}\"}. " +
              "Sent to this URL's host only, never after a redirect elsewhere; the value never comes back to you.",
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
        "may hold it for a person to approve. A credential is never a header you write: name a " +
        "secret you kept in secretHeaders and it is filled in on the way out.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "absolute http(s) url" },
          method: { type: "string", description: "POST | PUT | PATCH | DELETE (default POST)" },
          body: { description: "string, or an object which is sent as JSON" },
          headers: { type: "object", description: "extra request headers; credentials go in secretHeaders instead" },
          secretHeaders: {
            type: "object", additionalProperties: { type: "string" },
            description: "header → the name of a secret you kept with secret_put, or text with {{name}} in it: " +
              "{\"x-api-key\": \"openai\"}, {\"authorization\": \"Bearer {{openai}}\"}. " +
              "Sent to this URL's host only, never after a redirect elsewhere; the value never comes back to you.",
          },
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
  ],

  async invoke(tool: string, args: Json, ctx: PluginContext): Promise<Json> {
    if (!["get", "send"].includes(tool)) throw new Error(`unknown tool: ${tool}`);
    const cfg = (ctx.publicConfig ?? {}) as HttpConfig;
    const allowed = cfg.allowedHosts;
    const maxBytes = cfg.maxBytes ?? DEFAULT_MAX_BYTES;
    const a = (args ?? {}) as {
      url?: string; accept?: string; raw?: boolean;
      headers?: Record<string, unknown>; secretHeaders?: Record<string, unknown>; method?: string; body?: unknown;
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

    /**
     * Headers whose value is a secret the agent kept, named rather than written.
     *
     * The rule above is about the model HOLDING a credential, not about using
     * one: a key the agent was given and kept with `secret_put` is used here by
     * name and filled in server-side, so it never has to pass through the
     * conversation to reach the service. Only on the first URL's own origin, as
     * a browser drops `authorization` on a cross-origin redirect: the model
     * chose where the key goes, a redirect did not. And an echo of it in the
     * response is replaced with its name before the model reads it — only a
     * verbatim echo: one the server encoded (URL, JSON escapes, base64) is not
     * recognised, so this narrows the leak and does not close it.
     *
     * A value is a name, or text with `{{name}}` in it, because most APIs want
     * `Bearer <key>` and what an agent keeps is the bare key.
     */
    const kept = new Map<string, string>();
    const secret: Record<string, { as: string; value: string }> = {};
    for (const [header, spec] of Object.entries(a.secretHeaders ?? {})) {
      if (typeof spec !== "string") throw new Error(`secretHeaders.${header} must be the name of a secret you kept, or text with {{name}} in it`);
      if (spec.includes("{{") && !SECRET_SLOT.test(spec)) throw new Error(`secretHeaders.${header} has no {{name}} in it`);
      const value = spec.includes("{{") ? await fillSecrets(spec, kept, ctx) : await keptSecret(spec, kept, ctx);
      secret[header.toLowerCase()] = { as: spec, value };
    }
    const hide = (text: string) => hideSecrets(text, kept);
    const hideHeaders = (h: Record<string, string>) =>
      Object.fromEntries(Object.entries(h).map(([k, v]) => [k, hide(v)]));
    let target = String(a.url ?? "");
    const hops: string[] = [];
    let origin: string | null = null;
    // Once a hop leaves the first origin the secret stays behind, even if a later hop comes back:
    // a redirect chain that returns was still steered by somebody else.
    let carry = true;
    let dropped: string | null = null;
    // Which secret went in which header, by name, and where it was held back.
    const secretNote = () => Object.keys(secret).length ? {
      secretHeaders: Object.fromEntries(Object.entries(secret).map(([h, s]) => [h, s.as])),
      ...(dropped ? { secretHeadersNotSentTo: dropped } : {}),
    } : {};
    // Redirects are followed by hand so every hop is checked, not just the first.
    for (let hop = 0; hop < 4; hop++) {
      const check = checkUrl(target, allowed);
      if (!check.ok) throw new Error(check.why);
      hops.push(check.url.toString());
      origin ??= check.url.origin;
      if (check.url.origin !== origin) carry = false;
      if (!carry && Object.keys(secret).length) dropped ??= check.url.host;

      const method = String(a.method ?? (tool === "send" ? "POST" : "GET")).toUpperCase();
      // The split is what lets the policy layer gate one and not the other, so
      // the safe verbs stay on the read tool and the rest on the write tool.
      const reads = ["GET", "HEAD", "OPTIONS"];
      if (tool === "send" && !["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
        throw new Error(`send does not do ${method}; ${reads.join(", ")} are reads — use the \`get\` tool on \`${ctx.alias}\``);
      }
      if (tool === "get" && !reads.includes(method)) {
        throw new Error(`get does ${reads.join(", ")}; ${method} changes things — use the \`send\` tool on \`${ctx.alias}\``);
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
          ...(carry ? Object.fromEntries(Object.entries(secret).map(([h, s]) => [h, s.value])) : {}),
        },
        ...(a.body !== undefined
          ? {
              body: formBody
                ? new URLSearchParams(
                    // A pair, said as a pair. `.map` widens `[k, String(v)]` to
                    // `string[]`, and only one of the two runtimes' types accepts
                    // that — which is why this was invisible until the programs
                    // were split. The runtime value never changed; the type was
                    // simply less specific than the thing it described.
                    Object.entries(a.body as Record<string, unknown>)
                      .map(([k, v]): [string, string] => [k, String(v)]),
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
          url: hide(check.url.toString()), contentType: type,
          headers: hideHeaders(responseHeaders(res.headers)),
          title: hide(title), description: hide(description),
          bytes: payload.length, textBytes: text.length,
          ...(refused.length ? { refusedHeaders: refused } : {}),
          ...secretNote(),
          truncated: text.length > body.length,
          hops: hops.length > 1 ? hops.map(hide) : undefined,
          text: hide(body),
        };
      }

      const body = payload.slice(0, maxBytes);
      return {
        status: res.status,
        statusText: res.statusText,
        url: hide(check.url.toString()),
        contentType: type,
        headers: hideHeaders(responseHeaders(res.headers)),
        bytes: payload.length,
        ...(refused.length ? { refusedHeaders: refused } : {}),
        ...secretNote(),
        truncated: payload.length > body.length,
        hops: hops.length > 1 ? hops.map(hide) : undefined,
        body: hide(body),
      };
    }
    throw new Error(`too many redirects from ${a.url}`);
  },
};
