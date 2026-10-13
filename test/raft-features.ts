/**
 * The Server's rollout flags (the credential context's `features`, Raft SDK 0.16.0) as a hosted agent is told them:
 * the raft mount's prompt paragraph (src/plugins/raft.ts `featuresParagraph`, `promptContribution`), the flags it is
 * built from and who keeps them (`CONTEXT_STORE`: the listing, and a pull once they are old), and the two promises
 * around it — with every flag off, or a Server older than the field, the prompt is byte for byte what it was; and a
 * flag that flips mid-conversation reaches the model as a notice, never by rewriting the prompt
 * (src/runtime/prompt-context.ts). Also the 0.16.0 tool-schema change the generated `actions_prepare` picks up.
 */
import {
  CONTEXT_STORE, FEATURES_KEY, FEATURES_REFRESH_MS, VAULT_LINE, createRaftPlugin, featuresOf, featuresParagraph, raftPlugin as raftWithoutStorage,
} from "../src/plugins/raft.ts";
import { PluginDbTables } from "../src/store/plugin-db.ts";
import { sqliteHost } from "../src/store/sqlite-host.ts";
import { openPluginDatabase } from "../src/runtime/plugin-db.ts";
import { SqliteStore } from "../src/store/sqlite.ts";
import { ToolGateway } from "../src/runtime/gateway.ts";
import { statePlugin } from "../src/plugins/state.ts";
import { systemPrompt } from "../src/runtime/pi-prompt.ts";
import { promptContextFor, takeContextChange, type PromptContext } from "../src/runtime/prompt-context.ts";
import type { Plugin } from "../src/plugins/types.ts";

const raftPlugin = createRaftPlugin({ artifacts: { async put() { throw new Error("test: nothing should be stored here"); } } });
const originalFetch = globalThis.fetch;
const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void> | void) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
const must = (c: unknown, why: string) => { if (!c) throw new Error(why); };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const CREDENTIAL = "sk_agent_test_1234567890";
/** The Agent API's credential context; `features` left out is a Server older than the field. */
function context(features?: unknown) {
  return json(200, {
    agent: { id: "agent-1", name: "raft-bot", displayName: null, description: null, runtime: "antiproton", external: true },
    server: { id: "server-1", slug: "s", name: "S" }, credential: { capabilities: ["read", "send"] }, prompt: null,
    ...(features === undefined ? {} : { features }),
  });
}
/** Answers every request from `route`, and records the paths asked. */
function serve(route: (path: string) => Response) {
  const asked: string[] = [];
  globalThis.fetch = (async (url: any) => { const p = new URL(String(url)).pathname; asked.push(p); return route(p); }) as any;
  return asked;
}
const EMPTY_PULL = () => json(200, { events: [], last_seen_msgId: null, last_seen_seq: null, reply_target: null, has_more: false, ack_mode: "cursor" });

function mountDb() {
  const tables = new PluginDbTables(sqliteHost()).ensure();
  const scope = { tenantId: "tenant", agentId: "agent", alias: "raft", plugin: raftPlugin.id };
  return { tables, scope, db: openPluginDatabase(tables, scope, raftPlugin.database) };
}
function ctx(db: unknown) {
  return {
    caller: { tenantId: "tenant", agentId: "agent", taskId: "task" }, alias: "raft", credential: CREDENTIAL,
    publicConfig: { serverUrl: "https://raft.example" }, db, sibling: async () => null, sandboxForms: async () => [],
  } as any;
}

const REMINDERS = /^Reminders: /m;

await check("the paragraph: nothing with both flags off or none given; the reminder section, the Vault line, or both, as the flags say", () => {
  must(featuresParagraph({ reminderApp: false, vaultApp: false }, "raft") === null, "both off says something");
  must(featuresParagraph(featuresOf(undefined), "raft") === null, "no features (an older Server) says something");
  // Only `true` turns a flag on: a Server's "yes" or 1 is not the contract's boolean.
  must(featuresParagraph(featuresOf({ reminderApp: "yes", vaultApp: 1 }), "raft") === null, "a non-boolean turned a flag on");
  const reminder = featuresParagraph({ reminderApp: true, vaultApp: false }, "inbox")!;
  must(REMINDERS.test(reminder) && !reminder.includes(VAULT_LINE), reminder);
  // The app is found in the installed list and named by what that list shows, on this mount's alias; no id is written in.
  must(/`integrations_list` on `inbox`/.test(reminder) && /never an id from memory/.test(reminder), reminder);
  must(/ask an admin to install the Reminder app/.test(reminder) && /`raft reminder` command is not available to you/.test(reminder), reminder);
  must(!/reminder-[0-9a-f]{6}/.test(reminder), `an app id is written in: ${reminder}`);
  must(featuresParagraph({ reminderApp: false, vaultApp: true }, "raft") === VAULT_LINE, "the Vault line alone is not Raft's sentence");
  must(VAULT_LINE === "When a new secret needs storing, keep it out of chat: if you choose the value (e.g. a signing secret), create it in the Vault " +
    "yourself (`create-vault`, then `generate`); if a human holds it (e.g. a third-party API key), ask them to add it in the Vault web page and share access with you.",
  `the Vault line moved from Raft's wording: ${VAULT_LINE}`);
  const both = featuresParagraph({ reminderApp: true, vaultApp: true }, "raft")!;
  must(both === `${featuresParagraph({ reminderApp: true, vaultApp: false }, "raft")}\n\n${VAULT_LINE}`, both);
});

await check("the listing keeps the flags from the context it already reads, and the mount's paragraph is built from them", async () => {
  for (const [features, expect] of [
    [{ reminderApp: true, vaultApp: true }, featuresParagraph({ reminderApp: true, vaultApp: true }, "raft")],
    [{ reminderApp: false, vaultApp: true }, VAULT_LINE],
    [{ reminderApp: false, vaultApp: false }, null],
    [undefined, null],
  ] as const) {
    const { db } = mountDb();
    must(await raftPlugin.promptContribution!(ctx(db)) === null, "a mount with nothing kept says something");
    const asked = serve(() => context(features));
    await raftPlugin.snapshotTools!(ctx(db));
    must(asked.length === 1 && asked[0] === "/internal/agent-api/context", `one request, the one it made before: ${asked.join(", ")}`);
    const said = await raftPlugin.promptContribution!(ctx(db));
    must(said === expect, `features ${JSON.stringify(features)}: ${JSON.stringify(said)}`);
  }
});

await check("a pull reads the flags again once they are older than the refresh age, beside the pull, and never fails for it", async () => {
  const { tables, scope, db } = mountDb();
  // Fresh flags: the pull asks Raft for the inbox and nothing else.
  tables.put(scope, CONTEXT_STORE, FEATURES_KEY, { reminderApp: false, vaultApp: false, at: Date.now() }, null);
  let asked = serve((p) => (p.endsWith("/context") ? context({ reminderApp: true, vaultApp: false }) : EMPTY_PULL()));
  await raftPlugin.invoke("receive_events", {}, ctx(db));
  must(!asked.some((p) => p.endsWith("/context")), `fresh flags were read again: ${asked.join(", ")}`);
  // Old flags: read again, kept, and the paragraph follows.
  tables.put(scope, CONTEXT_STORE, FEATURES_KEY, { reminderApp: false, vaultApp: false, at: Date.now() - FEATURES_REFRESH_MS - 1 }, null);
  asked = serve((p) => (p.endsWith("/context") ? context({ reminderApp: true, vaultApp: false }) : EMPTY_PULL()));
  await raftPlugin.invoke("receive_events", {}, ctx(db));
  must(asked.filter((p) => p.endsWith("/context")).length === 1, `old flags were not read again: ${asked.join(", ")}`);
  must(REMINDERS.test(await raftPlugin.promptContribution!(ctx(db)) ?? ""), "the flipped flag did not reach the paragraph");
  // Raft failing the context read keeps what was kept, and the pull still answers.
  tables.put(scope, CONTEXT_STORE, FEATURES_KEY, { reminderApp: true, vaultApp: false, at: Date.now() - FEATURES_REFRESH_MS - 1 }, null);
  serve((p) => (p.endsWith("/context") ? json(503, { error: "down" }) : EMPTY_PULL()));
  const out: any = await raftPlugin.invoke("receive_events", {}, ctx(db));
  must(out && typeof out === "object", `the pull failed: ${JSON.stringify(out)}`);
  must(REMINDERS.test(await raftPlugin.promptContribution!(ctx(db)) ?? ""), "a failed read dropped the kept flags");
});

/** A gateway over one agent with a state mount, and a raft mount when `withRaft`, as the runtime registers them. */
async function agent(withRaft: boolean) {
  const store = new SqliteStore(":memory:");
  await store.init();
  await store.createAgent("t", "a");
  const state = statePlugin(store, null, "b");
  await store.addMount({ tenantId: "t", agentId: "a", alias: "state", installationId: "i-state", connectionId: null, plugin: state.id,
    toolVersion: state.version, publicConfig: {}, secretRef: null, policy: null } as any);
  // Something in the working set, so the state mount has a paragraph for the raft one to follow.
  await store.putState("t", "a", "memory", { value: "- the deploy window is 06:53Z", ref: null, bytes: 30 });
  if (withRaft) {
    await store.addMount({ tenantId: "t", agentId: "a", alias: "raft", installationId: "i-raft", connectionId: null, plugin: raftPlugin.id,
      toolVersion: raftPlugin.version, publicConfig: { serverUrl: "https://raft.example" }, secretRef: "secret:raft", policy: null } as any);
  }
  const plugins: Plugin[] = [state, raftPlugin];
  const gw = new ToolGateway(store, plugins, new Set(plugins.map((p) => p.id)), { async resolve() { return CREDENTIAL; } } as any);
  const call = { tenantId: "t", agentId: "a", taskId: "k" } as any;
  const now = async (): Promise<PromptContext> => {
    const paragraphs = await gw.promptParagraphs(call);
    return { contributions: paragraphs.map((p) => p.text).filter(Boolean), parts: paragraphs.flatMap((p) => p.parts), held: [] };
  };
  const prompt = async () => systemPrompt({ persona: { name: "A", description: "An agent." }, contributions: (await now()).contributions });
  const list = async (features: unknown) => {
    serve(() => context(features));
    const r = await gw.refreshMountTools("t", "a", "raft");
    must(r.ok, `listing: ${JSON.stringify(r)}`);
  };
  return { gw, now, prompt, list };
}

await check("with every flag off, or none given, the system prompt is byte for byte the prompt of an agent with no raft paragraph", async () => {
  const without = await (await agent(false)).prompt();
  must(without.includes("the deploy window is 06:53Z"), `the state mount's paragraph is missing, so nothing is compared: ${without.slice(-300)}`);
  for (const features of [undefined, { reminderApp: false, vaultApp: false }]) {
    const a = await agent(true);
    must(await a.prompt() === without, "a raft mount with nothing kept moved the prompt");
    await a.list(features);
    must(await a.prompt() === without, `features ${JSON.stringify(features)} moved the prompt`);
  }
  // Control: a flag on does move it, at the end, after the state mount's paragraph.
  const on = await agent(true);
  await on.list({ reminderApp: false, vaultApp: true });
  const p = await on.prompt();
  must(p !== without && p.endsWith(`\n\n${VAULT_LINE}`), `the flag on did not add the line at the end: ${p.slice(-300)}`);
});

await check("a flag flipped mid-conversation keeps the prompt as it began and reaches the model as a notice, both ways", async () => {
  const a = await agent(true);
  await a.list({ reminderApp: false, vaultApp: false });
  const host = sqliteHost();
  const s0 = await a.now();
  must(promptContextFor(host.sql, "t/a", "main", s0, false, 1) === s0, "the conversation did not take what is now");
  await a.list({ reminderApp: true, vaultApp: false });
  const s1 = await a.now();
  must(JSON.stringify(promptContextFor(host.sql, "t/a", "main", s1, true, 2)) === JSON.stringify(s0), "a started conversation's prompt moved");
  const told = takeContextChange(host.sql, "t/a", "main", s1, "NOTICE: ");
  must(told && /What the `raft` mount told you — now reads:\nReminders: /.test(told.notice), `notice: ${told?.notice}`);
  must(takeContextChange(host.sql, "t/a", "main", s1, "NOTICE: ") === null, "told twice");
  // And back off: told as no longer applying.
  await a.list({ reminderApp: false, vaultApp: false });
  const back = takeContextChange(host.sql, "t/a", "main", await a.now(), "NOTICE: ");
  must(back && /What the `raft` mount told you — no longer applies\./.test(back.notice), `notice: ${back?.notice}`);
});

await check("actions_prepare's generated schema carries 0.16.0's hosting and model for agent:create, with no hand-written schema in between", () => {
  for (const plugin of [raftPlugin, raftWithoutStorage]) {
    const tool = plugin.tools.find((t) => t.name === "actions_prepare");
    const props = (tool?.parameters as any)?.properties?.action?.properties;
    must(props?.hosting && JSON.stringify(props.hosting.enum) === JSON.stringify(["computer", "antiproton"]), `hosting: ${JSON.stringify(props?.hosting)}`);
    must(props?.model?.type === "string" && /only with hosting antiproton/.test(props.model.description ?? ""), `model: ${JSON.stringify(props?.model)}`);
  }
});

globalThis.fetch = originalFetch;
console.log(`\n  raft features\n  ${"─".repeat(56)}`);
for (const r of results) console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
const passed = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${passed} passed, ${results.length - passed} failed\n`);
if (passed !== results.length) process.exit(1);
