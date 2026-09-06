const BASE = process.env.CF_BASE ?? "https://agent-harness-p0.botiverse.workers.dev";
const WS = BASE.replace(/^http/, "ws");
const TEXT = process.argv[2] ?? "nodejs/node 最新 5 个 open issue 的编号和标题，简短列出即可。";

const { taskId } = await (await fetch(`${BASE}/agent/message`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ text: TEXT, taskId: `ws_${Math.random().toString(36).slice(2, 8)}` }),
})).json();
console.log(`\n  task ${taskId}: ${TEXT}\n  ws ${WS}/agent/events?after=0\n  ${"─".repeat(66)}`);

const ws = new WebSocket(`${WS}/agent/events?after=0`);
let done = false;
ws.addEventListener("message", (ev) => {
  const e = JSON.parse(ev.data);
  if (e.kind === "model.response") {
    const u = e.payload.usage ?? {};
    console.log(`  [${e.id}] model     prompt ${u.promptTokens} (cached ${u.cachedPromptTokens}) / out ${u.completionTokens}`);
  } else if (e.kind === "js.result") {
    console.log(`  [${e.id}] js        ${e.payload.status}${e.payload.acceptedOperationIds?.length ? `, ${e.payload.acceptedOperationIds.length} op(s)` : ""}`);
  } else {
    console.log(`  [${e.id}] ${e.kind}`);
  }
});
ws.addEventListener("open", () => console.log("  ws open (hibernation-capable)"));
const deadline = Date.now() + 240_000;
while (Date.now() < deadline && !done) {
  await new Promise((r) => setTimeout(r, 3000));
  const st = await (await fetch(`${BASE}/agent/state?taskId=${taskId}`)).json();
  if (["completed", "failed", "blocked"].includes(st.status)) {
    done = true;
    console.log(`  ${"─".repeat(66)}\n  ANSWER:\n${String(st.answer).split("\n").map((l) => "    " + l).join("\n")}`);
    console.log(`\n  status=${st.status}  events=${st.events.length}\n`);
  }
}
ws.close();
