/**
 * Web search through Exa, as a mount that holds a key.
 *
 * Why this is its own plugin rather than a key on an `http` mount: the hazard
 * `http` documents in its own config is that the agent chooses the URL, so a
 * credential on that mount goes wherever the agent points it, and
 * `allowedHosts` is the only thing bounding it. Here the host is fixed by the
 * plugin and there is no tool that takes a URL, so the key can only ever reach
 * Exa. That is the same shape every other credential plugin has, and it is why
 * this one may declare a credential while `http` still declares none.
 *
 * The result shape is `http.search`'s, field for field, so moving an agent
 * from the keyless path to this one changes what comes back but not how it is
 * read.
 */
import type { Json } from "../core/types.ts";
import type { Plugin, PluginContext } from "./types.ts";
import { credentialState, identityNote, markIdentity } from "./types.ts";

const API = "https://api.exa.ai/search";
const DEFAULT_TIMEOUT_MS = 15_000;
/** `http.search`'s default and ceiling, because the two answer the same tool call. */
const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 20;
/**
 * How much of one result's highlighted passages comes back.
 *
 * Exa's highlights are long: three live results for "Cloudflare Durable
 * Objects alarms" carried 5,962 / 2,520 / 5,002 characters, so eight uncapped
 * would be ~36 KB in one tool result. Past `PARK_BYTES` (4 KB) a result is
 * parked and the model gets a preview, which for a list meant to be scanned
 * costs the turn the search was supposed to save.
 *
 * The number is measured against that line, at `limit` 8, on two queries:
 *
 *     cap   "…Durable Objects alarms"   "typescript structural typing…"
 *     500        4,793                       5,548      both parked
 *     400        4,080                       4,738      one parked
 *     320        3,512                       4,095      one byte under
 *     256        3,060                       3,566      clear
 *
 * 320 fits by a byte on one query, which is the same as not fitting: the next
 * query decides it. 256 is the first value with room, so it is the default.
 *
 * Cut here rather than asked for smaller, because Exa's highlight options are
 * a request-shaping decision and how many characters survive is ours. `cut`
 * reports how many were shortened, so the loss is visible the way
 * `http.get`'s `bytes` makes its own truncation visible.
 */
const DEFAULT_SNIPPET_CHARS = 256;

export const exaPlugin: Plugin = {
  id: "exa",
  // Not a default mount: without a key this plugin has nothing to offer, and a
  // mount that is always there and always unusable is worse than no mount —
  // the model spends a turn discovering it.
  credential: {
    required: true,
    summary: "An Exa API key, from the Exa dashboard.",
    shape: "token",
    grants: "web search: titles, urls and highlighted passages.",
    docs: "https://dashboard.exa.ai/api-keys",
    // No `looksLike`, deliberately. An Exa key is a bare UUID, which is the
    // shape of every id this system already prints: Raft message ids, agent
    // ids, task ids, request ids. The rule this spec states — declare only
    // shapes that are recognisable, because a guess that fires on ordinary
    // text teaches people to click past it — rules this one out rather than
    // being a reason to try harder. The consequence is worth stating plainly
    // where an operator will read it: a pasted Exa key cannot be caught by the
    // scanner, so it has to be handled by whoever pastes it.
  },
  config: [
    { name: "timeoutMs", type: "number", default: DEFAULT_TIMEOUT_MS, summary: "How long one search may take." },
    { name: "snippetChars", type: "number", default: DEFAULT_SNIPPET_CHARS,
      summary: "How much of each result's highlighted passages comes back. The rest is cut, and `cut` says how many results were shortened." },
  ],
  version: "1.0.0",
  tools: [
    {
      name: "search",
      summary:
        "Search the web and get back titles, urls and highlighted passages. Use it when you do not " +
        "already know which page to read — guessing a url and fetching it is how a search becomes " +
        "three wasted turns. Then read the ones that look right with `get`.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          limit: { type: "integer", description: `default ${DEFAULT_LIMIT}, at most ${MAX_LIMIT}` },
        },
        required: ["query"],
      },
      sideEffects: "read",
      idempotency: "native",
    },
  ],

  /**
   * Does this key work? Asked by the console when someone attaches one.
   *
   * There is no account to name. Exa's API exposes no identity endpoint, so a
   * working key answers "yes" and nothing more — this is the first of our
   * plugins whose successful check carries no `account`, and a page that says
   * "acting as X" has nothing to put there for this provider. The contract
   * allows it (`CredentialCheck` makes `account` optional); it is called out
   * because the alternative is inventing a label that looks like an identity
   * and is not one.
   *
   * The cheapest real call is a one-result search, which is a real search and
   * costs what one costs. There is no free ping.
   */
  async checkCredential(ctx: PluginContext) {
    if (!ctx.credential) {
      return { ok: false as const, kind: "rejected" as const, reason: "no API key — this mount cannot search" };
    }
    try {
      const res = await fetch(API, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": ctx.credential },
        body: JSON.stringify({ query: "exa", type: "auto", numResults: 1 }),
        signal: AbortSignal.timeout(((ctx.publicConfig ?? {}) as { timeoutMs?: number }).timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
      if (res.ok) return { ok: true as const };
      let tag = "";
      try { tag = String(((await res.json()) as { tag?: string })?.tag ?? ""); } catch { /* no body */ }
      // Only an answer counts as a rejection. A 401 is Exa saying no; a 429, a
      // 503 (`SERVICE_OVERLOADED`, which it returns under load) or any 5xx is
      // no verdict at all, and throwing a good key away during an outage is
      // the failure this distinction exists to prevent.
      const rejected = res.status === 401 || res.status === 403;
      return {
        ok: false as const,
        kind: rejected ? ("rejected" as const) : ("unreachable" as const),
        reason: `HTTP ${res.status}${tag ? ` ${tag}` : ""}`,
      };
    } catch (e) {
      // Never arrived: a timeout or a refused connection says nothing about
      // the key.
      return { ok: false as const, kind: "unreachable" as const, reason: String((e as Error)?.message ?? e) };
    }
  },

  async invoke(tool: string, args: Json, ctx: PluginContext): Promise<Json> {
    if (tool !== "search") throw new Error(`unknown tool: ${tool}`);
    const a = (args ?? {}) as { query?: string; limit?: number };
    const q = String(a.query ?? "").trim();
    if (!q) throw new Error("query is required");
    const limit = Math.min(Math.max(Number(a.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);

    // The key is required, so a missing one is a mount problem and the message
    // has to say whose. `identityNote` is the shared sentence: "no account
    // attached" and "names one this deployment cannot read" are fixed by
    // different people and must not arrive as one wording.
    if (!ctx.credential) {
      throw markIdentity(new Error(`exa search needs an API key: ${identityNote(ctx)}`), ctx);
    }

    const cfg = (ctx.publicConfig ?? {}) as { timeoutMs?: number; snippetChars?: number };
    let res: Response;
    try {
      res = await fetch(API, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": ctx.credential },
        // The documented recommendation and nothing else, except the count:
        // `limit` is this tool's own parameter, so passing it is the caller's
        // decision arriving rather than boilerplate. Exa's own default is 10.
        body: JSON.stringify({ query: q, type: "auto", contents: { highlights: true }, numResults: limit }),
        signal: AbortSignal.timeout(cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
    } catch (e) {
      // A timeout or a refused connection is not an empty result set, and the
      // sentence has to say so: an agent told "nothing found" concludes the
      // subject does not exist, and stops looking.
      const err = markIdentity(new Error(
        `exa search did not complete: ${String((e as Error)?.message ?? e)}. ` +
        `This is a failed request, not an empty result — do not conclude the subject does not exist.`,
      ), ctx);
      err.transient = true;
      err.retryable = true;
      throw err;
    }

    if (!res.ok) {
      // Exa names its own failure in `tag`, which is the part worth carrying:
      // SERVICE_OVERLOADED and INVALID_API_KEY arrive as the same "it did not
      // work" unless the tag travels, and they are fixed by different people.
      let tag = "", detail = "";
      try {
        const body = await res.json() as { error?: string; tag?: string };
        tag = String(body?.tag ?? "");
        detail = String(body?.error ?? "");
      } catch { detail = res.statusText; }
      const err = markIdentity(new Error(
        `exa search failed (HTTP ${res.status}${tag ? ` ${tag}` : ""}): ${detail} — ${identityNote(ctx)}. ` +
        `This is a failed request, not an empty result.`,
      ), ctx);
      // 429 and 5xx clear on their own; a rejected key does not, and saying it
      // is retryable sends an agent round a loop that cannot end.
      err.transient = res.status === 429 || res.status >= 500;
      err.retryable = err.transient;
      throw err;
    }

    const body = await res.json() as {
      results?: Array<{ title?: string; url?: string; highlights?: string[] }>;
      costDollars?: { total?: number };
    };
    const raw = Array.isArray(body.results) ? body.results : null;
    // A body without a `results` array is a shape this parser cannot read, and
    // reporting it as zero results is the same lie as reporting a timeout that
    // way. `http.search` guards the equivalent case on its HTML; this is the
    // JSON form of it.
    if (!raw) {
      throw markIdentity(new Error(
        `exa search returned no results array — the response shape may have changed. ` +
        `This is not an empty result: do not conclude the subject does not exist.`,
      ), ctx);
    }
    const cap = Math.max(Number(cfg.snippetChars ?? DEFAULT_SNIPPET_CHARS), 1);
    let cut = 0;
    const results = raw
      .filter((r) => typeof r?.url === "string" && /^https?:\/\//.test(r.url!))
      .slice(0, limit)
      .map((r) => {
        // Highlights are the passages Exa extracted; joined rather than cut to
        // the first, because the first is often a page's navigation chrome.
        const full = (r.highlights ?? []).join(" … ").trim();
        if (full.length > cap) cut++;
        return { title: String(r.title ?? ""), url: String(r.url), snippet: full.slice(0, cap) };
      });
    // `cut` rather than a per-result flag: what a reader does with it is decide
    // whether to `get` the page, and that decision is the same for all of them.
    return { query: q, count: results.length, cut, results };
  },
};
