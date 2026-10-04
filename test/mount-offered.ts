/**
 * What the kernel tells a plugin about the tools its mount offers, and how a mount's stored list keeps up with the
 * build: `PluginContext.offered`, `Plugin.toolsBasis` and `ToolSnapshot.basis` (src/plugins/types.ts).
 *
 * The gateway rows drive a real `ToolGateway` over node:sqlite with a plugin that records the context it was handed.
 * The runtime rows drive the real `AgentRuntime` (cf/src/runtime.ts) with a plugin that lists its tools, counts every
 * listing, and can be made to fail or hang: its `toolsBasis` is changed between steps, which is what a deploy that
 * moves a plugin's tool set looks like to a mount whose list was taken before it.
 */
import { AgentRuntime, RETAKE_BACKOFF_MS, RETAKE_TIMEOUT_MS } from "../cf/src/runtime.ts";
import { interrupt, toolsOf, type Plugin, type PluginContext, type ToolSchema } from "../src/plugins/types.ts";
import { ToolGateway, type CallContext } from "../src/runtime/gateway.ts";
import { admitTools } from "../src/runtime/mount-tools.ts";
import { sqliteHost } from "../src/store/sqlite-host.ts";
import { SqliteStore } from "../src/store/sqlite.ts";
import { standInLoader } from "./spec/worker-stand-in.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.stack ?? e).split("\n").slice(0, 3).join("\n      ") }); }
}
function must(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }
const show = (v: unknown) => JSON.stringify(v);

const tool = (name: string): ToolSchema =>
  ({ name, summary: `Tool ${name}.`, parameters: { type: "object", properties: {} }, sideEffects: "read", idempotency: "none" }) as never;

/**
 * A plugin whose mounts differ: `mountTools` offers what the snapshot lists, of the names this build has (`all`), and
 * every one of them when there is no snapshot. Records every context it is handed, by where.
 */
function lister(opts: { credential?: boolean } = {}) {
  const s = {
    all: ["a", "b", "c"], listed: ["a"], basis: "basis-1" as string | undefined,
    fail: null as null | "throw" | "hang" | "hold", listings: 0,
    /** Releases the listings held under `fail: "hold"`; each answers with the list as it was when it started. */
    release: [] as Array<() => void>,
    /** Makes reading `toolsBasis` throw, so a re-take pass rejects as a whole rather than failing one mount. */
    basisThrows: false,
    /** Whether `receive` hands the agent what arrived. */
    deliver: false,
    seen: [] as Array<{ where: string; offered: readonly string[] | undefined; has: boolean }>,
  };
  const note = (where: string, c: PluginContext) => s.seen.push({ where, offered: c.offered, has: "offered" in c });
  const plugin: Plugin = {
    id: "lister", version: "1.0.0",
    get tools() { return s.all.map(tool); },
    get toolsBasis() { if (s.basisThrows) throw new Error("the basis could not be read"); return s.basis; },
    mountTools(mount) {
      const snap = mount.toolSnapshot;
      if (!snap) return s.all.map(tool);
      const on = new Set(snap.tools.map((t) => t.name));
      return s.all.filter((n) => on.has(n)).map(tool);
    },
    async snapshotTools(c) {
      s.listings++;
      note("snapshotTools", c);
      if (s.fail === "throw") throw new Error("the far end is down");
      if (s.fail === "hang") return new Promise(() => {});
      const answer = { tools: s.listed.map(tool) };
      if (s.fail === "hold") return new Promise((resolve) => { s.release.push(() => resolve(answer)); });
      return answer;
    },
    ...(opts.credential ? { credential: { required: true, summary: "a key", shape: "token" } as never } : {}),
    async invoke(name, _args, c) {
      note(`invoke:${name}`, c);
      if (name === "b") return interrupt({ question: "go on?", answer: { choices: ["yes", "no"] }, state: { n: 1 } });
      return { ok: name };
    },
    interrupts: {
      async resume(name, _state, answer, c) { note(`resume:${name}`, c); return { answered: answer }; },
      async cancel(name, _state, c) { note(`cancel:${name}`, c); },
    },
    background: {
      async poll(_h, c) { note("poll", c); return { done: false as const }; },
      async cancel(_h, c) { note("bgcancel", c); },
    },
    async receive(_e, _sec, c) { note("receive", c); return (s.deliver ? { deliver: true, text: "pushed" } : { deliver: false }) as never; },
    async reportActivity(_e, c) { note("reportActivity", c); return { sent: 0 }; },
  };
  return { s, plugin };
}

// ---- the gateway: `offered` on a mount's contexts, and the basis on a snapshot ----------------------------------

async function gatewayWorld() {
  const l = lister();
  const store = new SqliteStore(":memory:");
  await store.init();
  await store.createAgent("t", "a");
  await store.addMount({
    tenantId: "t", agentId: "a", alias: "m", plugin: "lister", installationId: "i", connectionId: null,
    toolVersion: "1.0.0", publicConfig: {}, secretRef: null, policy: null,
  });
  const gw = new ToolGateway(store, [l.plugin], new Set(["lister"]), { async resolve() { return null; } });
  const ctx: CallContext = { tenantId: "t", agentId: "a", taskId: "k" };
  return { l, store, gw, ctx };
}

await check("a call's context carries `offered`: exactly the mount's own tools, narrower than the plugin's, on invoke, resume, cancel, poll, receive and the activity report", async () => {
  const w = await gatewayWorld();
  // The mount's list is a and b of the plugin's a, b, c: what `toolsOf` answers is what `offered` must say.
  w.l.s.listed = ["a", "b"];
  const r = await w.gw.refreshMountTools("t", "a", "m");
  must(r.ok, `listing: ${show(r)}`);
  const mount = (await w.store.getMountByAlias("t", "a", "m"))!;
  const want = toolsOf(w.l.plugin, mount).map((t) => t.name);
  must(show(want) === show(["a", "b"]), `control: the mount's list is ${show(want)}`);
  w.l.s.seen.length = 0;
  await w.gw.invoke(w.ctx, "m.a", {});
  const asked: any = await w.gw.invoke(w.ctx, "m.b", {});
  must(asked.interrupt, `control: b asks: ${show(asked)}`);
  await w.gw.resumeInterrupt(w.ctx, asked.interrupt, "yes");
  await w.gw.cancelInterrupt(w.ctx, asked.interrupt);
  await w.gw.pollBackground(w.ctx, "m", { h: 1 });
  await w.gw.cancelBackground(w.ctx, "m", { h: 1 });
  await w.gw.receive("t", "a", "m", { headers: {}, body: new Uint8Array(1) } as never, "s");
  await w.gw.reportActivity("t", "a", []);
  const where = ["invoke:a", "invoke:b", "resume:b", "cancel:b", "poll", "bgcancel", "receive", "reportActivity"];
  must(show(w.l.s.seen.map((x) => x.where)) === show(where), `control: reached ${show(w.l.s.seen.map((x) => x.where))}`);
  const wrong = w.l.s.seen.filter((x) => show(x.offered) !== show(want));
  must(wrong.length === 0, `offered was not the mount's list on: ${show(wrong)}`);
  // It follows the mount, not the plugin: the same plugin's mount with no list is offered all three.
  await w.store.updateMountToolSnapshot("t", "a", "m", null);
  w.l.s.seen.length = 0;
  await w.gw.invoke(w.ctx, "m.a", {});
  must(show(w.l.s.seen[0]?.offered) === show(["a", "b", "c"]), `with no list: ${show(w.l.s.seen)}`);
});

await check("the listing's own context has no `offered`: it is asking what the list should be", async () => {
  const w = await gatewayWorld();
  await w.gw.refreshMountTools("t", "a", "m");
  const listing = w.l.s.seen.filter((x) => x.where === "snapshotTools");
  must(listing.length === 1 && !listing[0]!.has, `snapshotTools was handed: ${show(listing)}`);
});

await check("every snapshot the gateway takes records the plugin's basis, and a basis that moved is written even when the list did not", async () => {
  const w = await gatewayWorld();
  const first = await w.gw.refreshMountTools("t", "a", "m");
  const kept = (await w.store.getMountByAlias("t", "a", "m"))!.toolSnapshot;
  must(first.ok && kept?.basis === "basis-1", `first: ${show(first)} ${show(kept)}`);
  // The same list under a new basis: the hash is the same, the record moves, so the next turn does not ask again.
  w.l.s.basis = "basis-2";
  const second = await w.gw.refreshMountTools("t", "a", "m");
  const now = (await w.store.getMountByAlias("t", "a", "m"))!.toolSnapshot;
  must(second.ok && second.changed && now?.basis === "basis-2" && now.hash === kept!.hash, `second: ${show(second)} ${show(now)}`);
  // Control: the same list under the same basis changes nothing.
  const third = await w.gw.refreshMountTools("t", "a", "m");
  must(third.ok && !third.changed, `third: ${show(third)}`);
  // A plugin that declares no basis gets a snapshot with none.
  w.l.s.basis = undefined;
  w.l.s.listed = ["a", "c"];
  await w.gw.refreshMountTools("t", "a", "m");
  const none = (await w.store.getMountByAlias("t", "a", "m"))!.toolSnapshot;
  must(none && !("basis" in none), `no basis declared: ${show(none)}`);
});

// ---- the runtime: a snapshot under another basis is re-taken at the start of a turn ------------------------------

async function runtimeWorld(opts: { credential?: boolean } = {}) {
  const l = lister(opts);
  const host = sqliteHost();
  const standIn = standInLoader();
  const rt = new AgentRuntime({
    ctx: { storage: { sql: host.sql, transactionSync: host.transactionSync } },
    bucket: {} as never, bucketName: "b", models: { resolve: () => null },
    autoRelease: false, extraPlugins: [l.plugin],
    loader: standIn.loader, makeToolBinding: standIn.makeToolBinding,
    operatorModel: { baseUrl: "https://model.example/v1", apiKey: "operator-key", model: "m1" },
    offloadModel: async () => {},
    secretKek: Buffer.from(new Uint8Array(32)).toString("base64"),
  } as never);
  await rt.ready();
  await rt.store.createAgent("t", "a");
  await rt.store.setPluginChoice("t", "a", "lister", "enable");
  const added = await rt.addMount("t", "a", { alias: "m", plugin: "lister", config: {} });
  must(added.ok, `the mount was refused: ${show(added)}`);
  await rt.bindOperatorModel("t", "a");
  const mount = async () => (await rt.store.getMountByAlias("t", "a", "m"))!;
  const offered = async () => toolsOf(l.plugin, await mount()).map((t) => t.name);
  /** A new turn, as a person's message starts one. */
  const turn = (text = "hello") => rt.postMessage("t", "a", text, "prompt");
  return { l, rt, mount, offered, turn };
}

await check("a deploy that moves the basis: the next turn re-takes the list before the tools are built, and the new tool is offered", async () => {
  const w = await runtimeWorld();
  must(w.l.s.listings === 1 && show(await w.offered()) === show(["a"]) && (await w.mount()).toolSnapshot?.basis === "basis-1",
    `control: the add listed once, under basis-1: ${w.l.s.listings} ${show(await w.offered())}`);
  // The new build offers b too, and says so with a new basis.
  w.l.s.listed = ["a", "b"];
  w.l.s.basis = "basis-2";
  await w.turn();
  must(w.l.s.listings === 2, `listings after the turn: ${w.l.s.listings}`);
  must(show(await w.offered()) === show(["a", "b"]), `offered after the turn: ${show(await w.offered())}`);
  must((await w.mount()).toolSnapshot?.basis === "basis-2" && w.rt.snapshotError("m") === null, `kept: ${show((await w.mount()).toolSnapshot)} ${w.rt.snapshotError("m")}`);
});

await check("a snapshot under the plugin's own basis is not listed again: no call reaches the plugin, turn after turn", async () => {
  const w = await runtimeWorld();
  await w.turn();
  await w.rt.retakeStaleSnapshots("t", "a");
  await w.rt.retakeStaleSnapshots("t", "a");
  must(w.l.s.listings === 1, `listings: ${w.l.s.listings}`);
});

await check("a re-take that fails keeps the old list, says why on the mount's page, and is not tried again within the back-off", async () => {
  const w = await runtimeWorld();
  const before = (await w.mount()).toolSnapshot;
  w.l.s.listed = ["a", "b"];
  w.l.s.basis = "basis-2";
  w.l.s.fail = "throw";
  await w.rt.retakeStaleSnapshots("t", "a");
  must(w.l.s.listings === 2, `control: the re-take was attempted: ${w.l.s.listings}`);
  must(show((await w.mount()).toolSnapshot) === show(before) && show(await w.offered()) === show(["a"]), `the list moved: ${show((await w.mount()).toolSnapshot)}`);
  must(/the far end is down/.test(w.rt.snapshotError("m") ?? ""), `snapshotError: ${w.rt.snapshotError("m")}`);
  // Within the back-off: no attempt, whether by the step itself or by a turn.
  await w.rt.retakeStaleSnapshots("t", "a");
  await w.turn();
  must(w.l.s.listings === 2, `re-attempted within the back-off: ${w.l.s.listings}`);
  // Past it, with the far end back: asked again, and the new list is kept.
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + RETAKE_BACKOFF_MS + 1;
    w.l.s.fail = null;
    await w.rt.retakeStaleSnapshots("t", "a");
  } finally { Date.now = realNow; }
  must(w.l.s.listings === 3 && show(await w.offered()) === show(["a", "b"]) && w.rt.snapshotError("m") === null,
    `after the back-off: ${w.l.s.listings} ${show(await w.offered())} ${w.rt.snapshotError("m")}`);
});

await check("a re-take with no answer is cut off at the timeout: the old list is kept and the reason says so", async () => {
  const w = await runtimeWorld();
  const before = (await w.mount()).toolSnapshot;
  w.l.s.listed = ["a", "b"];
  w.l.s.basis = "basis-2";
  w.l.s.fail = "hang";
  const started = Date.now();
  await w.rt.retakeStaleSnapshots("t", "a");
  const took = Date.now() - started;
  must(took >= RETAKE_TIMEOUT_MS - 50 && took < RETAKE_TIMEOUT_MS + 2_000, `took ${took} ms`);
  must(show((await w.mount()).toolSnapshot) === show(before), `the list moved: ${show((await w.mount()).toolSnapshot)}`);
  must(/no answer within/.test(w.rt.snapshotError("m") ?? ""), `snapshotError: ${w.rt.snapshotError("m")}`);
  await w.rt.retakeStaleSnapshots("t", "a");
  must(w.l.s.listings === 2, `re-attempted within the back-off: ${w.l.s.listings}`);
});

await check("a snapshot with no basis (taken before bases existed) is re-taken once, then left alone", async () => {
  const w = await runtimeWorld();
  const { basis: _b, ...old } = (await w.mount()).toolSnapshot!;
  await w.rt.store.updateMountToolSnapshot("t", "a", "m", old);
  must(!("basis" in (await w.mount()).toolSnapshot!), "control: the stored list has no basis");
  await w.rt.retakeStaleSnapshots("t", "a");
  await w.rt.retakeStaleSnapshots("t", "a");
  must(w.l.s.listings === 2 && (await w.mount()).toolSnapshot?.basis === "basis-1", `listings ${w.l.s.listings}, ${show((await w.mount()).toolSnapshot)}`);
});

await check("a mount with no snapshot is not listed at a turn: it is offered every tool already", async () => {
  const w = await runtimeWorld();
  await w.rt.store.updateMountToolSnapshot("t", "a", "m", null);
  w.l.s.basis = "basis-2";
  await w.turn();
  must(w.l.s.listings === 1 && (await w.mount()).toolSnapshot === null, `listings ${w.l.s.listings}, ${show((await w.mount()).toolSnapshot)}`);
  must(show(await w.offered()) === show(["a", "b", "c"]), `offered: ${show(await w.offered())}`);
});

await check("a stale list not yet re-taken offers only the tools this build still has", async () => {
  const w = await runtimeWorld();
  // Taken by a build that had a tool this one removed (z), under a basis this build does not have.
  await w.rt.store.updateMountToolSnapshot("t", "a", "m", { ...(await admitTools({ tools: [tool("a"), tool("z")] }, 0)), basis: "basis-0" });
  w.l.s.fail = "throw";
  await w.turn();
  must(show(await w.offered()) === show(["a"]), `offered: ${show(await w.offered())}`);
});

await check("a re-take never swaps a list taken under a credential for one taken without it because the credential did not resolve", async () => {
  const w = await runtimeWorld({ credential: true });
  // A credentialed list, as an attach would have left it, and a reference that no longer resolves.
  await w.rt.store.updateMountToolSnapshot("t", "a", "m", { ...(await admitTools({ tools: [tool("a"), tool("b")] }, 0)), basis: "basis-0" });
  await w.rt.store.setMountSecretRef("t", "a", "m", "agent:gone");
  const listings = w.l.s.listings;
  await w.rt.retakeStaleSnapshots("t", "a");
  must(w.l.s.listings === listings && show(await w.offered()) === show(["a", "b"]), `listings ${w.l.s.listings}, offered ${show(await w.offered())}`);
  must(/did not resolve/.test(w.rt.snapshotError("m") ?? ""), `snapshotError: ${w.rt.snapshotError("m")}`);
  // Control: a list that was itself taken without a credential is re-taken as before.
  await w.rt.store.updateMountToolSnapshot("t", "a", "m", { ...(await admitTools({ tools: [] }, 0)), basis: "basis-0", withoutCredential: true });
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + RETAKE_BACKOFF_MS + 1;
    await w.rt.retakeStaleSnapshots("t", "a");
  } finally { Date.now = realNow; }
  must(w.l.s.listings === listings + 1 && (await w.mount()).toolSnapshot?.basis === "basis-1", `control: ${w.l.s.listings} ${show((await w.mount()).toolSnapshot)}`);
});


await check("only a turn's start lists again: a steer, a follow-up, opening the harness (status, transcript), a branch read and a job's take or delivery do not", async () => {
  const w = await runtimeWorld();
  await w.turn("first");
  w.l.s.listed = ["a", "b"];
  w.l.s.basis = "basis-2";
  const quiet: Array<[string, () => Promise<unknown>]> = [
    ["steer", () => w.rt.postMessage("t", "a", "and also", "steer")],
    ["followUp", () => w.rt.postMessage("t", "a", "then", "followUp")],
    ["agent (status, entries)", async () => { const a = await w.rt.agent("t", "a"); await a.running(); await a.entries({ order: "asc" }); }],
    ["branchEntries", () => w.rt.branchEntries("t", "a", "main")],
    ["takeJob", () => w.rt.takeJob("t", "a", "job-none", "taker").catch(() => null)],
    ["deliverAnswer", () => w.rt.deliverAnswer("t", "a", "job-none", "x", "taker").catch(() => null)],
  ];
  for (const [what, go] of quiet) {
    await go();
    must(w.l.s.listings === 1, `${what} listed: ${w.l.s.listings}`);
  }
  // Control: a turn's start does.
  await w.turn("second");
  must(w.l.s.listings === 2 && show(await w.offered()) === show(["a", "b"]), `the turn: ${w.l.s.listings} ${show(await w.offered())}`);
});

await check("two turns starting at once share one listing", async () => {
  const w = await runtimeWorld();
  w.l.s.listed = ["a", "b"];
  w.l.s.basis = "basis-2";
  w.l.s.fail = "hold";
  const both = Promise.all([w.rt.retakeStaleSnapshots("t", "a"), w.rt.retakeStaleSnapshots("t", "a")]);
  await new Promise((r) => setTimeout(r, 20));
  must(w.l.s.release.length === 1, `listings in flight: ${w.l.s.release.length}`);
  w.l.s.fail = null;
  w.l.s.release.splice(0).forEach((go) => go());
  await both;
  must(w.l.s.listings === 2 && show(await w.offered()) === show(["a", "b"]), `after: ${w.l.s.listings} ${show(await w.offered())}`);
  // Through the turn path too: two prompts at once, one listing.
  w.l.s.basis = "basis-3";
  w.l.s.fail = "hold";
  const turns = Promise.all([w.turn("one"), w.turn("two")]);
  await new Promise((r) => setTimeout(r, 20));
  must(w.l.s.release.length === 1, `turns' listings in flight: ${w.l.s.release.length}`);
  w.l.s.fail = null;
  w.l.s.release.splice(0).forEach((go) => go());
  await turns;
  must(w.l.s.listings === 3, `turns' listings: ${w.l.s.listings}`);
});

for (const change of ["replaced", "removed"] as const) {
  await check(`a re-take still listing when the credential is ${change} does not write over the list taken for the change`, async () => {
    const w = await runtimeWorld({ credential: true });
    const first = await w.rt.attachCredential("t", "a", "m", { token: "first-credential-123456" });
    must(first.ok && show(await w.offered()) === show(["a"]), `control: attach: ${show(first)} ${show(await w.offered())}`);
    // A deploy moved the basis; the turn's re-take starts under the first credential and is held.
    w.l.s.basis = "basis-2";
    w.l.s.fail = "hold";
    const retake = w.rt.retakeStaleSnapshots("t", "a");
    await new Promise((r) => setTimeout(r, 20));
    must(w.l.s.release.length === 1, `control: the re-take is in flight: ${w.l.s.release.length}`);
    // Meanwhile the credential changes, and its own listing lands.
    w.l.s.fail = null;
    // As raft lists: the new credential reaches more; no credential lists nothing.
    w.l.s.listed = change === "replaced" ? ["a", "b", "c"] : [];
    if (change === "replaced") must((await w.rt.attachCredential("t", "a", "m", { token: "second-credential-123456" })).ok, "replace refused");
    else must(await w.rt.removeCredential("t", "a", "m"), "remove refused");
    const after = (await w.mount()).toolSnapshot;
    const want = change === "replaced" ? ["a", "b", "c"] : [];
    must(show(await w.offered()) === show(want) && after?.basis === "basis-2", `control: the change's list: ${show(await w.offered())} ${show(after)}`);
    // The held listing answers with the first credential's list, late.
    w.l.s.release.splice(0).forEach((go) => go());
    await retake;
    must(show((await w.mount()).toolSnapshot) === show(after), `the late re-take wrote: ${show((await w.mount()).toolSnapshot)}`);
    must(show(await w.offered()) === show(want), `offered: ${show(await w.offered())}`);
  });
}


const settle = () => new Promise((r) => setTimeout(r, 20));

await check("a re-take pass that throws is forgotten: the prompt goes on, and the next prompt re-takes as usual", async () => {
  const w = await runtimeWorld();
  w.l.s.listed = ["a", "b"];
  w.l.s.basis = "basis-2";
  w.l.s.basisThrows = true;
  const realError = console.error;
  console.error = () => {};
  const landed = await w.turn("first").finally(() => { console.error = realError; });
  must(landed.mode === "prompt" || landed.mode === "steer", `the prompt did not land: ${show(landed)}`);
  must(w.l.s.listings === 1, `control: the pass threw before listing: ${w.l.s.listings}`);
  w.l.s.basisThrows = false;
  await w.turn("second");
  must(w.l.s.listings === 2 && show(await w.offered()) === show(["a", "b"]), `the next prompt's re-take: ${w.l.s.listings} ${show(await w.offered())}`);
});

await check("a stale answer is no failure: it sets no back-off, so the mount is re-taken at the next turn that needs it", async () => {
  const w = await runtimeWorld();
  w.l.s.basis = "basis-2";
  w.l.s.fail = "hold";
  const retake = w.rt.retakeStaleSnapshots("t", "a");
  await settle();
  // Someone else's listing lands while the held one runs: the held one comes back stale.
  w.l.s.fail = null;
  w.l.s.listed = ["a", "b"];
  must((await w.rt.refreshMountTools("t", "a", "m")).ok, "control: the operator's refresh");
  w.l.s.release.splice(0).forEach((go) => go());
  await retake;
  must(show(await w.offered()) === show(["a", "b"]), `control: the refresh's list stood: ${show(await w.offered())}`);
  // The same basis, a snapshot that again does not carry it: listed at once, no back-off in the way.
  await w.rt.store.updateMountToolSnapshot("t", "a", "m", { ...(await w.mount()).toolSnapshot!, basis: "basis-0" });
  const before = w.l.s.listings;
  await w.rt.retakeStaleSnapshots("t", "a");
  must(w.l.s.listings === before + 1, `a stale answer backed the mount off: ${w.l.s.listings - before} listings`);
});

/**
 * A held re-take, then the mount's list replaced by one that differs from the list the re-take started from in exactly
 * one of `takenAt` or `withoutCredential` (hash and basis the same): the held answer must not be written over it.
 */
for (const field of ["takenAt", "withoutCredential"] as const) {
  await check(`a re-take tells the list it started from from a newer one that differs only in ${field}`, async () => {
    const w = await runtimeWorld({ credential: true });
    const realNow = Date.now;
    const at = <R>(t: number, go: () => Promise<R>): Promise<R> => { Date.now = () => t; return go().finally(() => { Date.now = realNow; }); };
    const T = realNow() + 60_000;
    must((await at(T, () => w.rt.attachCredential("t", "a", "m", { token: "first-credential-123456" }))).ok, "attach");
    const start = (await w.mount()).toolSnapshot!;
    // The re-take starts under another basis, held, and will answer with a list nobody else has.
    w.l.s.basis = "basis-2";
    w.l.s.listed = ["a", "c"];
    w.l.s.fail = "hold";
    const retake = w.rt.retakeStaleSnapshots("t", "a");
    await settle();
    must(w.l.s.release.length === 1, "control: the re-take is in flight");
    // The newer list: back to the first basis and the first names, so only the one field tells it apart.
    w.l.s.fail = null;
    w.l.s.basis = "basis-1";
    if (field === "takenAt") {
      w.l.s.listed = ["a", "b"];
      await w.rt.refreshMountTools("t", "a", "m");
      w.l.s.listed = ["a"];
      await at(T + 1_000, () => w.rt.refreshMountTools("t", "a", "m"));
    } else {
      w.l.s.listed = ["a"];
      await at(T, () => w.rt.removeCredential("t", "a", "m"));
    }
    const newer = (await w.mount()).toolSnapshot!;
    const differs = (["hash", "basis", "takenAt", "withoutCredential"] as const).filter((k) => !!start[k] !== !!newer[k] || start[k] !== newer[k]);
    must(show(differs) === show([field]), `control: the newer list differs in ${show(differs)}`);
    w.l.s.release.splice(0).forEach((go) => go());
    await retake;
    must(show((await w.mount()).toolSnapshot) === show(newer), `the held re-take wrote over the newer list: ${show((await w.mount()).toolSnapshot?.tools.map((t) => t.name))}`);
  });
}

async function hooked(w: Awaited<ReturnType<typeof runtimeWorld>>) {
  const made = await w.rt.createHookSecret("t", "a", "m", "hook-1");
  must(made.ok, `hook: ${show(made)}`);
  w.l.s.deliver = true;
  return () => w.rt.receiveHook("t", "a", "m", "hook-1", { headers: {}, body: new Uint8Array([1]) });
}

await check("an inbound push is answered at once: its turn starts the re-take without waiting, which still lands; a person's prompt waits", async () => {
  const w = await runtimeWorld();
  const push = await hooked(w);
  w.l.s.listed = ["a", "b"];
  w.l.s.basis = "basis-2";
  w.l.s.fail = "hold";
  const started = Date.now();
  const r = await push();
  const took = Date.now() - started;
  must(r.outcome === "delivered" && took < 1_000, `the push: ${show(r)} after ${took} ms`);
  must(w.l.s.release.length === 1 && show(await w.offered()) === show(["a"]), `control: the re-take is running, the list as it stood: ${w.l.s.release.length} ${show(await w.offered())}`);
  // The background pass is the agent's one pass: joining it and releasing the listing lands the new list.
  const pass = w.rt.retakeStaleSnapshots("t", "a");
  w.l.s.release.splice(0).forEach((go) => go());
  await pass;
  must(w.l.s.listings === 2 && show(await w.offered()) === show(["a", "b"]), `the background re-take: ${w.l.s.listings} ${show(await w.offered())}`);
  // A person's prompt waits for it.
  w.l.s.basis = "basis-3";
  w.l.s.fail = "hold";
  let done = false;
  const prompt = w.turn("from a person").then(() => { done = true; });
  await settle();
  must(!done && w.l.s.release.length === 1, `the person's prompt did not wait: done=${done}`);
  w.l.s.release.splice(0).forEach((go) => go());
  await prompt;
  must(done, "the person's prompt never finished");
});

await check("a background re-take that throws is caught and logged: no unhandled rejection, and the push is delivered", async () => {
  const w = await runtimeWorld();
  const push = await hooked(w);
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown) => { unhandled.push(e); };
  process.on("unhandledRejection", onUnhandled);
  const logged: unknown[][] = [];
  const realError = console.error;
  console.error = (...a: unknown[]) => { logged.push(a); };
  try {
    w.l.s.basis = "basis-2";
    w.l.s.basisThrows = true;
    const r = await push();
    await settle();
    must(r.outcome === "delivered", `the push: ${show(r)}`);
    must(unhandled.length === 0, `unhandled: ${String(unhandled[0])}`);
    must(logged.some((a) => /re-taking .*tool lists failed/.test(String(a[0]))), `nothing logged: ${show(logged.map((a) => String(a[0])))}`);
  } finally {
    console.error = realError;
    process.off("unhandledRejection", onUnhandled);
    w.l.s.basisThrows = false;
  }
});

for (const r of results) console.log(`  ${r.ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${r.name}${r.error ? `\n      ${r.error}` : ""}`);
console.log(`  ${"─".repeat(56)}\n  ${results.filter((r) => r.ok).length} passed, ${results.filter((r) => !r.ok).length} failed`);
if (results.some((r) => !r.ok)) process.exit(1);
