// A personal assistant's publish of an Artifact AS its owner (src/plugins/raft-assistant.ts `publishArtifactAsOwner`;
// SDK 0.37.0 `routes.assistant.publishArtifactAsOwner`, `POST /assistant/owner-artifact/as-owner`): offered in the
// owner's chat alone and only where the other Artifact tools are, refused anywhere else, the body Raft takes (home for
// a new one, never for a version), Raft's answers as Raft sent them with what to do next (send-as-me off, a home it
// can't use, unseen comments, the publish's limits), no answer is uncertain and never "publish again", no confirmation
// card, and trace rows that carry ids, sizes and codes, never content or the home as named.
//
// The real plugin over a real plugin database (node:sqlite) and the real SDK, with Raft as a fake `fetch` shaped like
// its contract, as test/raft-assistant-artifacts.ts does.
//
//   node test/raft-assistant-artifact-as-owner.ts
import { raftPlugin } from "../src/plugins/raft.ts";
import {
  AS_OWNER_DUPLICATE_NOTE, AS_OWNER_DUPLICATE_UNCHANGED_NOTE, AS_OWNER_REFUSAL_NOTES, AS_OWNER_UNAVAILABLE_NOTE, AS_OWNER_UNCERTAIN_NOTE, AS_OWNER_UNCERTAIN_VERSION_NOTE, AS_OWNER_VERSION_NOT_FOUND_NOTE,
  CHAT_TOOLS, CHECK_TOOLS, OWNER_ARTIFACT_TOOL, PUBLISH_ARTIFACT_AS_OWNER_TOOL, PUBLISH_ARTIFACT_TOOL, PUBLISH_QUOTA_NOTE, PUBLISH_RATE_LIMITED_NOTE,
  PUBLISH_REFUSAL_NOTES, PUBLISH_REFUSED_NOTE, assistantCheckPrompt, assistantPrecedence, assistantPrompt, assistantTools, isOwnerReadAddress, replyFallback,
} from "../src/plugins/raft-assistant.ts";
import { OWNER_ACTION_MARK } from "../src/plugins/raft-assistant-owner-actions.ts";
import { PLUGIN_TRACE_KINDS } from "../src/trace/outbox.ts";
import { setLogSink } from "../src/core/log.ts";
import { PluginDbTables } from "../src/store/plugin-db.ts";
import { sqliteHost } from "../src/store/sqlite-host.ts";
import { openPluginDatabase } from "../src/runtime/plugin-db.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void> | void) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.stack ?? e).split("\n").slice(0, 3).join("\n      ") }); }
}
function must(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }
const show = (v: unknown) => JSON.stringify(v);
const sorted = (v: unknown): unknown => Array.isArray(v) ? v.map(sorted)
  : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted((v as Record<string, unknown>)[k])])) : v;
const sameAs = (a: unknown, b: unknown) => show(sorted(a)) === show(sorted(b));
function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const OWNER = "7a0e1b2c-3d4e-4f50-8a61-72839405a6b7";
const ART_ID = "4d1c0ffe-0000-4000-8000-0000000000a1";
const HOME_ID = "c0ffee00-0000-4000-8000-0000000000d5";
const URL_ = `https://app.raft.build/artifacts/${ART_ID}`;
/** Words that are content (a title, a file, a path, the home as named): never in a trace row or a log line. */
const SECRET_TITLE = "zz-SECRET-TITLE";
const SECRET_FILE = "zz-SECRET-FILE-TEXT";
const SECRET_PATH = "zz-secret-path.html";
const SECRET_HOME = "#zz-secret-home";
const AT = "2026-11-16T09:00:00.000Z";
const AS_OWNER_PATH = "/assistant/owner-artifact/as-owner";

type Answer = { status: number; body?: unknown; code?: string; error?: string } | "drop";
const published = (o: { version?: number; unchanged?: boolean } = {}) => ({
  status: 201,
  body: { artifact: { id: ART_ID, url: URL_, version: o.version ?? 1, unchanged: o.unchanged ?? false }, home: { id: HOME_ID, ref: SECRET_HOME } },
});

/** An answer to the read as SDK 0.37.0's contract has it, for the UNSEEN_CHANGES round trip. */
function readAnswer(position: number) {
  const actor = { type: "user", name: "ana" };
  return {
    owner: { userId: OWNER },
    artifact: {
      id: ART_ID, url: URL_, title: SECRET_TITLE, description: null,
      home: { kind: "conversation", conversation: { id: HOME_ID, type: "channel", target: SECRET_HOME } },
      author: actor, version: 3, latestVersion: 3, commentCount: 1, position, createdAt: AT, updatedAt: AT,
    },
    versions: [{ number: 3, publisher: actor, createdAt: AT, note: null, changedPaths: [SECRET_PATH] }],
    files: [{ path: SECRET_PATH, sizeBytes: SECRET_FILE.length, kind: "html", entry: true }],
    file: { kind: "text", path: SECRET_PATH, entry: true, contentType: "text/html", sizeBytes: SECRET_FILE.length, content: SECRET_FILE, truncated: false },
    comments: { items: [{ id: "cm-1", author: actor, version: 3, path: null, anchor: null, replyTo: null, body: "a comment", createdAt: AT, editedAt: null }], olderCursor: null, newestPosition: position },
  };
}

/** Raft as an assistant's credential meets it: its context, the read and the publish as the owner, recording every request. */
function raft(o: { owner?: boolean } = {}) {
  const r = {
    owner: o.owner ?? true,
    publishes: [] as any[],
    answers: [] as Answer[],
    readAnswer: { status: 200, body: readAnswer(19) } as Answer,
    /** Every request the plugin made, as `METHOD path`. */
    requests: [] as string[],
  };
  globalThis.fetch = (async (url: any, init?: any) => {
    const u = new URL(String(url));
    const path = u.pathname.replace("/internal/agent-api", "");
    const method = init?.method ?? "GET";
    r.requests.push(`${method} ${path}`);
    if (path === "/context") {
      return json(200, {
        agent: { id: "agent-1", name: "ada-assistant", displayName: null, description: null, runtime: "external", external: true,
          assistantOf: r.owner ? { userId: OWNER, timezone: "Europe/Berlin", dmTarget: "dm:@ada" } : null },
        server: { id: "server-1", slug: "s", name: "S" }, credential: { capabilities: ["read", "send", "reactions"] }, prompt: null,
      });
    }
    const reply = (a: Answer) => {
      if (a === "drop") throw new TypeError("fetch failed");
      if (a.status >= 300) return json(a.status, { error: a.error, ...(a.code ? { code: a.code } : {}), ...(a.body ? a.body as object : {}) });
      return json(a.status, a.body);
    };
    if (path === "/assistant/owner-artifact" && method === "GET") return reply(r.readAnswer);
    if (path === AS_OWNER_PATH && method === "POST") {
      r.publishes.push(JSON.parse(String(init?.body ?? "{}")));
      return reply(r.answers.shift() ?? published());
    }
    return json(404, { error: "not found", code: "NOT_FOUND" });
  }) as any;
  return r;
}

function mount() {
  const tables = new PluginDbTables(sqliteHost()).ensure();
  const scope = { tenantId: "tenant", agentId: "agent", alias: "raft", plugin: raftPlugin.id };
  const traced: Array<{ kind: string; status: string; verdict: string; attrs: Record<string, any> }> = [];
  const ctx = {
    caller: { tenantId: "tenant", agentId: "agent", taskId: "main", contextId: "ctx_turn", turnId: "turn-1" } as Record<string, unknown>,
    alias: "raft", credential: "sk_agent_test_1234567890", publicConfig: { serverUrl: "https://raft.example" },
    db: openPluginDatabase(tables, scope, raftPlugin.database), offered: raftPlugin.tools.map((t) => t.name),
    sibling: async () => null, sandboxForms: async () => [], trace: (row: any) => traced.push(row),
  } as any;
  return { ctx, traced };
}

async function assistant(r = raft()) {
  const m = mount();
  const listed = await raftPlugin.snapshotTools!(m.ctx);
  m.ctx.offered = listed.tools.map((t) => t.name);
  m.traced.length = 0;
  r.requests.length = 0;
  return { ...m, r, listed: listed.tools.map((t) => t.name) };
}

const asOwner = (a: { ctx: unknown }, args: unknown) => raftPlugin.invoke(PUBLISH_ARTIFACT_AS_OWNER_TOOL, args, a.ctx as never) as Promise<any>;
const read = (a: { ctx: unknown }, args: unknown) => raftPlugin.invoke(OWNER_ARTIFACT_TOOL, args, a.ctx as never) as Promise<any>;
const NEW = { home: SECRET_HOME, title: SECRET_TITLE, description: "Q4 numbers", files: [{ path: SECRET_PATH, content: SECRET_FILE }, { path: "logo.png", content_base64: "iVBORw0KGgo=" }] };
const VERSION = { artifact: ART_ID, base: 3, note: "fixed the totals", files: [{ path: SECRET_PATH, content: SECRET_FILE }], delete: ["old.css"] };

async function logged<T>(fn: () => Promise<T>): Promise<{ out: T; lines: string[] }> {
  const lines: string[] = [];
  setLogSink((l) => lines.push(l));
  try { return { out: await fn(), lines }; } finally { setLogSink(null); }
}
function noContent(where: string, rows: unknown, lines: string[] = []) {
  const all = show(rows) + lines.join("\n");
  for (const s of [SECRET_TITLE, SECRET_FILE, SECRET_PATH, SECRET_HOME, "fixed the totals", "Q4 numbers"]) must(!all.includes(s), `${where}: carries ${s}: ${all}`);
}

// ---- where it is offered ---------------------------------------------------------------------------------------------

await check("offered: the chat's and never a check's, listed only for an agent that is someone's assistant, exactly where the other Artifact tools are", async () => {
  const name = PUBLISH_ARTIFACT_AS_OWNER_TOOL;
  must(CHAT_TOOLS.includes(name) && !CHECK_TOOLS.includes(name), `chat ${CHAT_TOOLS.includes(name)}, check ${CHECK_TOOLS.includes(name)}`);
  must(assistantTools([{ address: `raft.${name}` }], "raft", "chat").length === 1, "the chat is not offered it");
  must(assistantTools([{ address: `raft.${name}` }], "raft", "check").length === 0, "a check is offered it");
  const a = await assistant();
  must([OWNER_ARTIFACT_TOOL, PUBLISH_ARTIFACT_TOOL, name].every((n) => a.listed.includes(n)), `an assistant's listing: ${show(a.listed)}`);
  const b = await assistant(raft({ owner: false }));
  must(![OWNER_ARTIFACT_TOOL, PUBLISH_ARTIFACT_TOOL, name].some((n) => b.listed.includes(n)), `not an assistant, listed: ${show(b.listed)}`);
  const t = raftPlugin.tools.find((x) => x.name === name)!;
  must(t.sideEffects === "write" && t.idempotency === "none" && t.modelOnly === true, show(t));
  must(!isOwnerReadAddress(`raft.${name}`), "a write is not an owner read");
  must((PLUGIN_TRACE_KINDS as readonly string[]).includes(`raft.${name}`), "the gateway would drop the rows");
});

await check("a mount whose list does not name the tool is refused before any request to Raft", async () => {
  const a = await assistant();
  a.ctx.offered = (a.ctx.offered as string[]).filter((n) => n !== PUBLISH_ARTIFACT_AS_OWNER_TOOL);
  const e = await asOwner(a, NEW).then(() => null, (x) => x as Error);
  must(e && /is not offered on this mount/.test(e.message), `${e?.message}`);
  must(a.r.requests.length === 0, `requests: ${show(a.r.requests)}`);
});

await check("refused from a check (iso_), another session or a program, before anything reaches Raft", async () => {
  for (const caller of [{ taskId: "iso_0123456789abcdef0123" }, { taskId: "sub_0123456789" }, { taskId: "main", fromProgram: true }]) {
    const a = await assistant();
    a.ctx.caller = { ...a.ctx.caller, ...caller };
    const e = await asOwner(a, NEW).then(() => null, (x) => x as Error & { retryable?: unknown });
    must(e && e.message.startsWith(`${PUBLISH_ARTIFACT_AS_OWNER_TOOL} works only`) && e.retryable === false, `${show(caller)}: ${show(e?.message)}`);
    must(a.r.requests.length === 0, `${show(caller)}: requests ${show(a.r.requests)}`);
    must(a.traced.at(-1)?.status === "refused:not_chat", `row ${show(a.traced)}`);
  }
});

await check("the chat prompt says when to publish as the owner only where offered; a check's prompt never does", () => {
  const T = "`raft__assistant_publish_artifact_as_owner`";
  const chat = assistantPrompt("raft");
  must(chat.includes(T) && /only when they explicitly ask you, in your chat with them/.test(chat) && /never on your own initiative/.test(chat) &&
    /don't confirm it yourself/.test(chat), chat);
  must(assistantPrecedence("raft").includes("you never publish as your owner unless they ask in your chat"), assistantPrecedence("raft"));
  must(!/artifact/i.test(assistantCheckPrompt("raft")), "the check prompt mentions Artifacts");
  const without = CHAT_TOOLS.filter((n) => n !== PUBLISH_ARTIFACT_AS_OWNER_TOOL);
  must(!assistantPrompt("raft", without).includes(PUBLISH_ARTIFACT_AS_OWNER_TOOL) && !/Publish an Artifact as your owner/.test(assistantPrompt("raft", without)) && !/publish as your owner/.test(assistantPrecedence("raft", without)), "named where not offered");
  // Alone, it still has its line.
  const alone = assistantPrompt("raft", CHAT_TOOLS.filter((n) => n !== OWNER_ARTIFACT_TOOL && n !== PUBLISH_ARTIFACT_TOOL));
  must(alone.includes(T) && !alone.includes("`raft__assistant_publish_artifact`"), alone);
});

// ---- the publish ------------------------------------------------------------------------------------------------------

await check("new: the body as Raft takes it, to its own route; the result names the home and says Raft posted the receipt", async () => {
  const a = await assistant();
  const { out, lines } = await logged(() => asOwner(a, NEW));
  must(show(a.r.requests) === show([`POST ${AS_OWNER_PATH}`]), `requests: ${show(a.r.requests)}`);
  must(sameAs(a.r.publishes, [NEW]), `body: ${show(a.r.publishes)}`);
  must(out.state === "published" && show(out.artifact) === show({ id: ART_ID, url: URL_, version: 1, unchanged: false }) && out.home === SECRET_HOME, show(out));
  must(out.note.includes("as your owner") && out.note.includes(SECRET_HOME) && out.note.includes("receipt") && /do not send them a confirmation/.test(out.note), out.note);
  // Raft posts the receipt: the model is not told to send the url, as the DM publish's result tells it.
  must(!out.note.includes("messages_send"), out.note);
  const row = a.traced.at(-1)!;
  must(row.kind === "raft.assistant_publish_artifact_as_owner" && row.status === "published" && row.verdict === "ok", show(row));
  must(row.attrs.kind === "new" && row.attrs.home_kind === "channel" && row.attrs.files === 2 && row.attrs.binary_files === 1 &&
    row.attrs.bytes === SECRET_FILE.length + 8 && row.attrs.artifact_id === ART_ID && row.attrs.home_id === HOME_ID && row.attrs.version === 1, show(row.attrs));
  must(lines.some((l) => l.includes("\"evt\":\"raft.assistant_publish_artifact_as_owner\"")), `log: ${lines}`);
  noContent("new", a.traced, lines);
});

await check("new version: artifact + base, no home sent; an unchanged one says not to publish again", async () => {
  const a = await assistant();
  a.r.answers.push(published({ version: 4 }));
  const out = await asOwner(a, VERSION);
  must(sameAs(a.r.publishes, [VERSION]) && !("home" in a.r.publishes[0]), `body: ${show(a.r.publishes)}`);
  must(out.state === "published" && out.artifact.version === 4 && out.note.startsWith("Version 4 is published as your owner"), show(out));
  must(a.traced.at(-1)!.attrs.kind === "version" && a.traced.at(-1)!.attrs.home_kind === null && a.traced.at(-1)!.attrs.base === 3 &&
    a.traced.at(-1)!.attrs.deletes === 1, show(a.traced.at(-1)));
  // The same publish again in a later reply (in this one it is a duplicate, refused before Raft is asked).
  a.ctx.caller = { ...a.ctx.caller, turnId: "turn-2" };
  a.r.answers.push(published({ version: 3, unchanged: true }));
  const same = await asOwner(a, VERSION);
  must(same.state === "unchanged" && same.note.includes("no new version was made") && same.note.includes("Do not publish it again"), show(same));
  noContent("version", a.traced);
});

await check("each refusal reaches the model with Raft's status, code and error and its own next step, sent once", async () => {
  const cases: Array<[Answer, string, Record<string, unknown>]> = [
    [{ status: 403, code: "assistant_send_as_owner_off", error: "Send as me is off." }, AS_OWNER_REFUSAL_NOTES.assistant_send_as_owner_off!, NEW],
    [{ status: 404, code: "TARGET_NOT_FOUND", error: "Target not found." }, AS_OWNER_REFUSAL_NOTES.TARGET_NOT_FOUND!, NEW],
    [{ status: 404, code: "TARGET_NOT_FOUND", error: "Target not found." }, AS_OWNER_VERSION_NOT_FOUND_NOTE, VERSION],
    [{ status: 403, code: "NOT_PUBLISHED_BY_ASSISTANT", error: "You didn't publish this Artifact." }, AS_OWNER_REFUSAL_NOTES.NOT_PUBLISHED_BY_ASSISTANT!, VERSION],
    [{ status: 409, code: "UNSEEN_CHANGES", error: "There are comments you have not seen.", body: { unseen: { comments: 2 }, position: 19 } }, AS_OWNER_REFUSAL_NOTES.UNSEEN_CHANGES!, VERSION],
    [{ status: 409, code: "BASE_MOVED", error: "The base moved." }, PUBLISH_REFUSAL_NOTES.BASE_MOVED!, VERSION],
    [{ status: 429, code: "RATE_LIMITED", error: "Too many Artifact writes." }, PUBLISH_RATE_LIMITED_NOTE, NEW],
    [{ status: 403, code: "FILE_UPLOAD_QUOTA_EXCEEDED", error: "The server's monthly upload quota is used up." }, PUBLISH_QUOTA_NOTE, NEW],
    [{ status: 404, code: "NOT_FOUND", error: "Not found" }, AS_OWNER_UNAVAILABLE_NOTE, NEW],
    [{ status: 400, code: "TITLE_REQUIRED", error: "A title is required." }, PUBLISH_REFUSED_NOTE, NEW],
  ];
  for (const [answer, note, args] of cases) {
    const a = await assistant();
    a.r.answers.push(answer);
    const out = await asOwner(a, args);
    const r = answer as { status: number; code: string; error: string };
    must(show(out) === show({ state: "not_published", status: r.status, code: r.code, error: r.error, note }), `${r.code}: ${show(out)}`);
    must(a.r.publishes.length === 1, `${r.code}: retried: ${a.r.publishes.length}`);
    must(a.traced.at(-1)!.status === "refused" && a.traced.at(-1)!.verdict === "blocked" && a.traced.at(-1)!.attrs.code === r.code &&
      a.traced.at(-1)!.attrs.http_status === r.status, show(a.traced.at(-1)));
  }
  // The guidance itself, as Raft's author gave it.
  const off = AS_OWNER_REFUSAL_NOTES.assistant_send_as_owner_off!;
  must(/"send as me"/.test(off) && /turn it on/.test(off) && /Do not retry/.test(off), off);
  const unseen = AS_OWNER_REFUSAL_NOTES.UNSEEN_CHANGES!;
  must(unseen.includes(OWNER_ARTIFACT_TOOL) && unseen.includes("seen") && /never what they wrote/.test(unseen) && /held again/.test(unseen), unseen);
  const target = AS_OWNER_REFUSAL_NOTES.TARGET_NOT_FOUND!;
  must(/Do not retry the same home/.test(target) && target.includes(PUBLISH_ARTIFACT_TOOL) && /joint/.test(target), target);
});

await check("UNSEEN_CHANGES, then a read, then the same publish with seen: goes through", async () => {
  const a = await assistant();
  a.r.answers.push({ status: 409, code: "UNSEEN_CHANGES", error: "There are comments you have not seen." }, published({ version: 4 }));
  const held = await asOwner(a, VERSION);
  must(held.state === "not_published" && held.code === "UNSEEN_CHANGES", show(held));
  const r = await read(a, { artifact: ART_ID });
  must(r.seen === 19, `seen: ${show(r.seen)}`);
  const out = await asOwner(a, { ...VERSION, seen: r.seen });
  must(out.state === "published" && a.r.publishes.length === 2 && a.r.publishes[1].seen === 19 && !("seen" in a.r.publishes[0]), show(a.r.publishes));
  must(a.traced.at(-1)!.attrs.has_seen === true, show(a.traced.at(-1)));
});

await check("the same publish twice in one turn: the second is refused locally (published, or uncertain), never sent", async () => {
  for (const [first, args] of [[published(), NEW], [published({ version: 4 }), VERSION], ["drop", NEW], [{ status: 502, error: "bad gateway" }, VERSION]] as const) {
    const a = await assistant();
    a.r.answers.push(first as Answer, published({ version: 5 }));
    await asOwner(a, args);
    // The same publish, with only the title, note or seen changed and the files in another order: still the same.
    const again = { ...args, title: "another title", note: "again", ...("artifact" in args ? { seen: 30 } : {}), files: [...args.files].reverse() };
    const out = await asOwner(a, again);
    must(show(out) === show({ state: "not_published", code: "duplicate_in_turn", note: AS_OWNER_DUPLICATE_NOTE }), `${show(first)}: ${show(out)}`);
    must(a.r.publishes.length === 1, `${show(first)}: sent twice: ${a.r.publishes.length}`);
    must(a.traced.at(-1)!.status === "refused:duplicate_in_turn" && a.traced.at(-1)!.verdict === "blocked", show(a.traced.at(-1)));
  }
});

await check("not a duplicate: other files, another home, a refused first try, the next turn, or no turn at all", async () => {
  const a = await assistant();
  await asOwner(a, NEW);
  await asOwner(a, { ...NEW, files: [{ path: SECRET_PATH, content: "other text" }] });
  await asOwner(a, { ...NEW, home: "#elsewhere" });
  must(a.r.publishes.length === 3, `distinct publishes refused: ${a.r.publishes.length}`);
  a.ctx.caller = { ...a.ctx.caller, turnId: "turn-2" };
  await asOwner(a, NEW);
  must(a.r.publishes.length === 4, `the next turn refused: ${a.r.publishes.length}`);
  // A refusal is not kept: the UNSEEN_CHANGES resend (its round trip above) and a plain fix-and-retry go.
  const b = await assistant();
  b.r.answers.push({ status: 403, code: "assistant_send_as_owner_off", error: "off" });
  await asOwner(b, NEW);
  const retry = await asOwner(b, NEW);
  must(retry.state === "published" && b.r.publishes.length === 2, show(retry));
  // Outside a turn nothing is kept, as for send-as-owner.
  const c = await assistant();
  delete c.ctx.caller.turnId;
  await asOwner(c, NEW);
  await asOwner(c, NEW);
  must(c.r.publishes.length === 2, `no turn: ${c.r.publishes.length}`);
});

await check("a duplicate of an unchanged publish says no receipt was posted, not that one was", async () => {
  const a = await assistant();
  a.r.answers.push(published({ version: 3, unchanged: true }));
  must((await asOwner(a, VERSION)).state === "unchanged", "control: unchanged");
  const out = await asOwner(a, VERSION);
  must(out.code === "duplicate_in_turn" && out.note === AS_OWNER_DUPLICATE_UNCHANGED_NOTE && a.r.publishes.length === 1, show(out));
  must(/posted no receipt/.test(AS_OWNER_DUPLICATE_UNCHANGED_NOTE) && !/Raft posts your owner a receipt/.test(AS_OWNER_DUPLICATE_UNCHANGED_NOTE), AS_OWNER_DUPLICATE_UNCHANGED_NOTE);
});

// ---- the turn's answer: Raft's receipt answers it, so the closing text is not sent too (`replyFallback`) ---------------

/** The turn's end after one publish answered `answer`: what `replyFallback` did, and whether it sent the closing text. */
async function fallbackAfter(answer: Answer, args: unknown = NEW) {
  const a = await assistant();
  a.r.answers.push(answer);
  const out = await asOwner(a, args);
  const sends: Array<{ target: string; content: string }> = [];
  const result = await replyFallback(a.ctx, { turnId: "turn-1", turnKey: null, finalText: "Done: I published it in #design for you.", outcome: "completed", rebuilding: false, isolated: false } as never,
    async (_c, target, content) => { sends.push({ target, content }); return { sent: true } as never; });
  return { out, result, sends, row: a.traced.find((t) => t.kind === "raft.assistant_publish_artifact_as_owner") };
}

await check("reply fallback: a publish as the owner that went through or may have answers the turn; unchanged or refused does not", async () => {
  const cases: Array<[string, Answer, unknown, string, "skipped" | "sent"]> = [
    ["published", published(), NEW, "published", "skipped"],
    ["published version", published({ version: 4 }), VERSION, "published", "skipped"],
    ["uncertain 503", { status: 503, error: "unavailable" }, NEW, "uncertain", "skipped"],
    ["uncertain no answer", "drop", NEW, "uncertain", "skipped"],
    // 201 with an empty url: the SDK's contract takes it, the tool's own check does not.
    ["malformed", { status: 201, body: { artifact: { id: ART_ID, url: "", version: 1, unchanged: false }, home: { id: HOME_ID, ref: SECRET_HOME } } }, NEW, "uncertain", "skipped"],
    ["unchanged", published({ version: 3, unchanged: true }), VERSION, "unchanged", "sent"],
    ["refused", { status: 403, code: "assistant_send_as_owner_off", error: "off" }, NEW, "not_published", "sent"],
  ];
  // Every case is run and every wrong one named, so a reverse change shows exactly which cases it turns red.
  const wrong: string[] = [];
  for (const [tag, answer, args, state, want] of cases) {
    const f = await fallbackAfter(answer, args);
    must(f.out.state === state, `${tag}: control: ${show(f.out)}`);
    if (tag === "malformed") must(f.row?.status === "malformed", `malformed: the tool's own check was not reached: ${show(f.row)}`);
    if (f.result !== want || f.sends.length !== (want === "sent" ? 1 : 0)) wrong.push(`${tag}: fallback ${f.result}, sends ${f.sends.length}`);
  }
  must(wrong.length === 0, wrong.join("; "));
  // The control: a turn with no publish at all is sent its closing text, so "skipped" above is the publish's doing.
  const a = await assistant();
  const sends: unknown[] = [];
  const none = await replyFallback(a.ctx, { turnId: "turn-1", turnKey: null, finalText: "hi", outcome: "completed", rebuilding: false, isolated: false } as never,
    async (_c, target, content) => { sends.push({ target, content }); return { sent: true } as never; });
  must(none === "sent" && sends.length === 1, `control: ${none} ${show(sends)}`);
});

await check("no answer, a 5xx or an unreadable answer is uncertain and never says to publish a new Artifact again", async () => {
  for (const [answer, args, note] of [["drop", NEW, AS_OWNER_UNCERTAIN_NOTE], [{ status: 502, error: "bad gateway" }, NEW, AS_OWNER_UNCERTAIN_NOTE],
    ["drop", VERSION, AS_OWNER_UNCERTAIN_VERSION_NOTE], [{ status: 201, body: { artifact: { id: ART_ID } } }, NEW, AS_OWNER_UNCERTAIN_NOTE]] as const) {
    const a = await assistant();
    a.r.answers.push(answer as Answer);
    const out = await asOwner(a, args);
    must(out.state === "uncertain" && out.note === note && a.r.publishes.length === 1, show(out));
    must(a.traced.at(-1)!.verdict === "failed", show(a.traced.at(-1)));
  }
  must(/Do not publish it again/.test(AS_OWNER_UNCERTAIN_NOTE) && /receipt/.test(AS_OWNER_UNCERTAIN_NOTE), AS_OWNER_UNCERTAIN_NOTE);
});

await check("a body Raft would refuse is refused here first, with nothing sent", async () => {
  const a = await assistant();
  const bad: Array<[unknown, RegExp]> = [
    [{ title: "T", files: [{ path: "a.txt", content: "x" }] }, /needs home/],
    [{ home: " ", title: "T", files: [{ path: "a.txt", content: "x" }] }, /home must be/],
    [{ home: 7, title: "T", files: [{ path: "a.txt", content: "x" }] }, /home must be/],
    [{ ...VERSION, home: "#design" }, /leave out home/],
    [{ home: "#design", files: [{ path: "a.txt", content: "x" }] }, /needs a title/],
    [{ home: "#design", title: "T", files: [] }, /at least one file/],
    [{ home: "#design", title: "T", files: [{ path: "a.txt" }] }, /exactly one of content/],
    [{ artifact: ART_ID, files: [{ path: "a.txt", content: "x" }] }, /needs base/],
    [{ home: "#design", title: "T", base: 2, files: [{ path: "a.txt", content: "x" }] }, /give artifact too/],
  ];
  for (const [args, want] of bad) {
    const e = await asOwner(a, args).then(() => null, (x) => x as Error & { retryable?: unknown });
    must(e && want.test(e.message) && e.message.endsWith("Nothing was published.") && e.retryable === false, `${show(args)}: ${show(e?.message)}`);
  }
  must(a.r.publishes.length === 0 && a.r.requests.length === 0, `requests: ${show(a.r.requests)}`);
  must(a.traced.every((t) => t.status === "refused:args"), show(a.traced));
});

await check("no confirmation card, as send- and forward-as-owner have none: one request, a plain result, no owner-action mark, nothing held", async () => {
  const a = await assistant();
  const out = await asOwner(a, NEW);
  must(show(a.r.requests) === show([`POST ${AS_OWNER_PATH}`]), `requests: ${show(a.r.requests)}`);
  must(out && typeof out === "object" && out.constructor === Object && !("interrupt" in out) && !("question" in out) && !/confirm/i.test(String(out.state ?? "")), show(out));
  const t = raftPlugin.tools.find((x) => x.name === PUBLISH_ARTIFACT_AS_OWNER_TOOL)!;
  must(!show(t.parameters).includes(OWNER_ACTION_MARK), "marked as an owner action");
  must(!a.traced.some((x) => x.kind === "raft.held"), show(a.traced));
});

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`  ${r.ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${r.name}${r.ok ? "" : `\n      \x1b[31m${r.error}\x1b[0m`}`);
console.log("  ────────────────────────────────────────────────────────");
console.log(`  ${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exit(1);
