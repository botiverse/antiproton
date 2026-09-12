/**
 * What the broker allows, and what it refuses.
 *
 * The point of the broker is that "you cannot touch another tenant's
 * container" stops being a property of our filtering and becomes a property of
 * what the caller can express. So these are the tests for that sentence: a
 * list is answered, never forwarded; an id the caller did not create is not
 * theirs; and a path nobody has reasoned about is not served at all.
 */
import { decide, presented, type Owned } from "../broker/src/route.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
function check(name: string, fn: () => void) {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}

const PROJECT = "proj";
const P = `/projects/${PROJECT}/workspace`;
/** A caller who created box b-mine, exec x-mine and snap s-mine, and nothing else. */
const mine: Owned = {
  box: (id) => id === "b-mine",
  exec: (id) => id === "x-mine",
  snap: (id) => id === "s-mine",
};

check("列表永远不转发 —— 它由我们自己的记录回答", () => {
  const d = decide("GET", `${P}/boxes`, mine, PROJECT);
  if (d.kind !== "answer") throw new Error(`a list would have been forwarded: ${JSON.stringify(d)}`);
  // Forwarding and then filtering is what the plugin does today under the
  // shared key. It is correct only while every caller remembers; the whole
  // point of this service is that the boundary holds without remembering.
});

check("别人的盒子:操作被拒,而不是拿回来再过滤", () => {
  for (const [method, path] of [
    ["DELETE", `${P}/boxes/b-theirs`],
    ["GET", `${P}/boxes/b-theirs`],
    ["POST", `${P}/boxes/b-theirs/stop`],
    ["POST", `${P}/boxes/b-theirs/execs`],
    ["POST", `${P}/boxes/b-theirs/secrets`],
  ] as const) {
    const d = decide(method, path, mine, PROJECT);
    if (d.kind !== "refuse") throw new Error(`${method} ${path} was allowed through`);
  }
});

check("拒绝时说的是【没有这个东西】,而不是【这不是你的】", () => {
  // Otherwise the difference between the two answers is an oracle: a caller
  // could walk ids and learn which ones exist in other tenants.
  const theirs = decide("DELETE", `${P}/boxes/b-theirs`, mine, PROJECT);
  const nothing = decide("DELETE", `${P}/boxes/b-never-existed`, mine, PROJECT);
  if (theirs.kind !== "refuse" || nothing.kind !== "refuse") throw new Error("expected both to be refused");
  if (theirs.status !== nothing.status || theirs.reason.replace("b-theirs", "X") !== nothing.reason.replace("b-never-existed", "X")) {
    throw new Error(`the two answers differ, so ids can be probed: ${theirs.reason} vs ${nothing.reason}`);
  }
});

check("自己的盒子照常放行,并记下该记的那一行", () => {
  const create = decide("POST", `${P}/boxes`, mine, PROJECT);
  if (create.kind !== "forward" || create.record?.of !== "box-created") throw new Error(JSON.stringify(create));

  const del = decide("DELETE", `${P}/boxes/b-mine`, mine, PROJECT);
  if (del.kind !== "forward" || del.record?.of !== "box-gone") throw new Error(JSON.stringify(del));

  const exec = decide("POST", `${P}/boxes/b-mine/execs`, mine, PROJECT);
  if (exec.kind !== "forward" || exec.record?.of !== "exec-created") throw new Error(JSON.stringify(exec));

  const stop = decide("POST", `${P}/boxes/b-mine/stop`, mine, PROJECT);
  if (stop.kind !== "forward" || stop.record) throw new Error(`stopping is not a fact worth a row: ${JSON.stringify(stop)}`);
});

check("exec 用自己的 id 寻址,所以归属在创建时就记下,不是读时推出来", () => {
  // `/execs/{id}` does not carry the box it belongs to, so ownership cannot be
  // derived at read time. That is why creating one writes a row.
  if (decide("GET", `${P}/execs/x-mine`, mine, PROJECT).kind !== "forward") throw new Error("my own command was refused");
  if (decide("POST", `${P}/execs/x-mine/kill`, mine, PROJECT).kind !== "forward") throw new Error("killing my own command was refused");
  if (decide("GET", `${P}/execs/x-theirs`, mine, PROJECT).kind !== "refuse") throw new Error("another tenant's command was readable");
  if (decide("POST", `${P}/execs/x-theirs/kill`, mine, PROJECT).kind !== "refuse") throw new Error("another tenant's command could be killed");
});

check("快照同样按归属,fork 记下新的那一个", () => {
  const fork = decide("POST", `${P}/snaps/s-mine/fork`, mine, PROJECT);
  if (fork.kind !== "forward" || fork.record?.of !== "snap-created") throw new Error(JSON.stringify(fork));
  if (decide("POST", `${P}/snaps/s-theirs/fork`, mine, PROJECT).kind !== "refuse") throw new Error("another tenant's filesystem could be forked");
});

check("没被推理过的路径一律不服务,包括对面【以后】新增的", () => {
  // An allowlist, not a proxy. A proxy inherits every endpoint run9 ever adds,
  // and inherits it in the open state.
  for (const path of [
    `${P}/projects`, `${P}/boxes/b-mine/exec`, "/projects/proj/billing",
    `${P}/volumes`, "/", "/projects/other/workspace/boxes/b-mine",
  ]) {
    const d = decide("GET", path, mine, PROJECT);
    if (d.kind === "forward") throw new Error(`${path} was forwarded, and nobody has reasoned about it`);
  }
});

check("项目名是我们的,不是调用方的 —— 换一个项目名就不服务", () => {
  // Found by this test before any of it ran in production: the patterns took
  // any project, so `/projects/other/.../boxes/b-mine` was forwarded, because
  // the box id really was the caller's. But an id is only unique inside its
  // project, and the shared key belongs to one project — so that request would
  // have pointed our key somewhere nobody meant it to go.
  const elsewhere = `/projects/other/workspace/boxes/b-mine`;
  if (decide("GET", elsewhere, mine, PROJECT).kind === "forward") {
    throw new Error("a path naming another project was forwarded under our key");
  }
  if (decide("DELETE", elsewhere, mine, PROJECT).kind === "forward") {
    throw new Error("another project's box could be deleted with our key");
  }
});

check("方法也在白名单里 —— 路径对、动词不对,不放行", () => {
  if (decide("DELETE", `${P}/boxes`, mine, PROJECT).kind !== "refuse") throw new Error("DELETE on the collection was allowed");
  if (decide("PUT", `${P}/boxes/b-mine`, mine, PROJECT).kind !== "refuse") throw new Error("PUT on a box was allowed");
  if (decide("GET", `${P}/boxes/b-mine/stop`, mine, PROJECT).kind !== "refuse") throw new Error("GET on stop was allowed");
});

check("插件发什么头,broker 就认什么头", () => {
  // The plugin sends `Basic base64(ak:sk)` on every call, because that is
  // run9's scheme and this service is a drop-in `endpoint`. My first version
  // read `Bearer`, which nothing sends: the two halves would not have spoken
  // on the very first call, and no test I had written would have noticed —
  // the route layer and the ledger were both fine.
  if (presented("Basic " + btoa("ak-1:sk-1")) !== "ak-1:sk-1") throw new Error("the plugin's own header was not understood");
  if (presented("Bearer tok-1") !== "tok-1") throw new Error("a bearer token was not understood");
  // The pair is the credential. Splitting it would invite a lookup on the half
  // that is not the secret one.
  if (presented("Basic " + btoa("ak-1:sk-1")) === "ak-1") throw new Error("only the public half was taken");
  for (const bad of [null, "", "Basic", "Basic !!!not base64", "Digest xyz"]) {
    if (presented(bad as any)) throw new Error(`${JSON.stringify(bad)} was accepted as a credential`);
  }
});

console.log(`\n  What the broker allows\n  ${"─".repeat(56)}`);
for (const r of results) {
  console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
}
const pass = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${pass} passed, ${results.length - pass} failed\n`);
process.exit(pass === results.length ? 0 : 1);
