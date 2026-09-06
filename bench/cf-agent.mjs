const BASE = process.env.CF_BASE ?? "https://agent-harness-p0.botiverse.workers.dev";
const TEXT = process.argv[2] ??
  "查一下 nodejs/node 仓库当前 open 的 issue，把标题以 'deps:' 开头的挑出来，给我编号和标题。你需要先自己发现有哪些可用工具。";

const post = await fetch(`${BASE}/agent/message`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ text: TEXT }),
});
const { taskId } = await post.json();
console.log(`\n  POST /agent/message -> ${taskId}\n  task: ${TEXT}\n  ${"─".repeat(70)}`);

let seen = 0;
const deadline = Date.now() + 300_000;
while (Date.now() < deadline) {
  const st = await (await fetch(`${BASE}/agent/state?taskId=${taskId}`)).json();
  for (const e of st.events.slice(seen)) {
    if (e.kind === "model.response") {
      const u = e.usage ?? {};
      console.log(`  [${e.sequence}] model     prompt ${u.promptTokens} (cached ${u.cachedPromptTokens}) / out ${u.completionTokens}`);
    } else if (e.kind === "js.result") {
      console.log(`  [${e.sequence}] js        ${e.jsStatus}${e.ops?.length ? `, ops ${e.ops.join(",")}` : ""}`);
    } else {
      console.log(`  [${e.sequence}] ${e.kind}`);
    }
  }
  seen = st.events.length;
  if (["completed", "failed", "blocked"].includes(st.status)) {
    console.log(`  ${"─".repeat(70)}\n  ANSWER:\n${String(st.answer).split("\n").map((l) => "    " + l).join("\n")}`);
    console.log(`\n  status=${st.status}  checkpoint v${st.checkpointVersion}  events=${st.events.length}\n`);
    break;
  }
  await new Promise((r) => setTimeout(r, 2000));
}
