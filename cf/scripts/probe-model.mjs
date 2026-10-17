#!/usr/bin/env node
// Probe one model through the deployment's Cloudflare AI Gateway, the way the queue consumer calls it, before it is
// offered: plain text, a tool call answered and continued, an image in a user message and inside a tool result, and the
// same long prefix sent twice to see the cache written then read. Prints, per probe, only the HTTP status, the usage the
// provider reported, and a pass flag; never a key, a prompt or an answer. Exits 1 when any probe fails.
//
//   AI_GATEWAY_TOKEN=… node cf/scripts/probe-model.mjs claude-haiku-5-5
//   AI_GATEWAY_TOKEN=… node cf/scripts/probe-model.mjs claude-haiku-5-5 --binding    # also preserved thinking (below)
//   options: --route anthropic (the default: <gateway>/anthropic/v1/messages, Anthropic's protocol)
//            --route compat    (<gateway>/compat/chat/completions; give the model as vendor/model)
//            --config cf/wrangler.jsonc   (whose gateway; the preview deployment's, cf/wrangler.preview.jsonc, by default)
//
// `--binding` (anthropic route; a model with adaptive thinking): a turn whose answer has thinking blocks is written to a
// transcript and sent back through this branch's own `fromResponse` and `toAnthropicRequest`, with
// `thinking.block_binding.prefix_mismatch_behavior: "error"` and the `thinking-binding-controls-2026-08-01` beta, which
// opts the request into preserved thinking's check whatever the account's default. It passes when that replay is a 200
// with nothing transformed AND the same replay with an earlier message edited is refused (400, "bound to a different
// conversation"): the edit is the control that shows the check ran. A model that wrote no thinking block has nothing to
// bind, and the line says `inconclusive`.
//
// This spends a few cents on the gateway's account. It calls no agent and touches no object.
import { readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { fromResponse, toAnthropicRequest } from "../../src/model/pi-bridge.ts";
import { readMessage } from "../../src/model/anthropic-messages.ts";

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args.splice(i, 2)[1]; };
const route = flag("--route") ?? "anthropic";
const config = flag("--config") ?? "cf/wrangler.preview.jsonc";
const binding = args.includes("--binding");
const model = args.find((a) => !a.startsWith("--"));
const token = process.env.AI_GATEWAY_TOKEN;
if (!model || !token || !["anthropic", "compat"].includes(route)) {
  console.error("usage: AI_GATEWAY_TOKEN=… node cf/scripts/probe-model.mjs <model> [--route anthropic|compat] [--config <wrangler file>] [--binding]");
  process.exit(2);
}
const compat = readFileSync(config, "utf8").match(/"baseUrl": "(https:\/\/gateway\.ai\.cloudflare\.com\/v1\/[0-9a-f]+\/[^/"]+)\/compat"/)?.[1];
if (!compat) { console.error(`no gateway /compat provider in ${config}`); process.exit(2); }
const url = route === "anthropic" ? `${compat}/anthropic/v1/messages` : `${compat}/compat/chat/completions`;
const headers = { "content-type": "application/json", "cf-aig-authorization": `Bearer ${token}`, ...(route === "anthropic" ? { "anthropic-version": "2023-06-01" } : {}) };

// A 64x64 PNG: the digits 47 in black on yellow, generated so nothing is read from disk.
function png() {
  const FONT = { 4: ["101", "101", "111", "001", "001"], 7: ["111", "001", "010", "010", "010"] };
  const W = 64, H = 64, px = Buffer.alloc(W * H * 3);
  for (let i = 0; i < W * H; i++) { px[i * 3] = 255; px[i * 3 + 1] = 220; px[i * 3 + 2] = 0; }
  [["4", 4], ["7", 36]].forEach(([ch, left]) => FONT[ch].forEach((row, y) => [...row].forEach((b, x) => {
    if (b !== "1") return;
    for (let dy = 0; dy < 8; dy++) for (let dx = 0; dx < 8; dx++) { const o = ((12 + y * 8 + dy) * W + left + x * 8 + dx) * 3; px[o] = px[o + 1] = px[o + 2] = 0; }
  })));
  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) { raw[y * (W * 3 + 1)] = 0; px.copy(raw, y * (W * 3 + 1) + 1, y * W * 3, (y + 1) * W * 3); }
  const table = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = table[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]).toString("base64");
}
const IMG = png();
const ASK = "What number is written in the image? Answer with the number only.";
const sawImage = (t) => /\b4[7T]\b/.test(t);

// The two protocols, as the consumer speaks them.
const A = {
  text: (text) => ({ type: "text", text }),
  image: () => ({ type: "image", source: { type: "base64", media_type: "image/png", data: IMG } }),
  tool: { name: "get_weather", description: "The weather in a city.", input_schema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } },
  body: (o) => ({ model, max_tokens: 1024, ...o }),
  read: (j) => ({
    text: (j.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join(""),
    calls: (j.content ?? []).filter((c) => c.type === "tool_use"),
    thinking: (j.content ?? []).filter((c) => c.type === "thinking" || c.type === "redacted_thinking").length,
    usage: { input: j.usage?.input_tokens, cacheWrite: j.usage?.cache_creation_input_tokens, cacheRead: j.usage?.cache_read_input_tokens, output: j.usage?.output_tokens },
  }),
};
const C = {
  tool: { type: "function", function: { name: "get_weather", description: "The weather in a city.", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } } },
  body: (o) => ({ model, max_tokens: 1024, ...o }),
  read: (j) => ({
    text: j.choices?.[0]?.message?.content ?? "", calls: j.choices?.[0]?.message?.tool_calls ?? [], thinking: 0,
    usage: { input: j.usage?.prompt_tokens, cacheRead: j.usage?.prompt_tokens_details?.cached_tokens, output: j.usage?.completion_tokens },
  }),
};

let failed = 0;
async function call(body, extra = {}) {
  const res = await fetch(url, { method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify(body) });
  let j = {};
  try { j = await res.json(); } catch { /* status says enough */ }
  return { status: res.status, ...(res.ok ? (route === "anthropic" ? A : C).read(j) : { text: "", calls: [], thinking: 0, usage: null }) };
}
function report(probe, r, pass, more = {}) {
  if (!pass) failed++;
  console.log(JSON.stringify({ probe, status: r.status, usage: r.usage, pass, ...more }));
}

const words = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa".split(" ");
const PREFIX = `[probe ${Date.now()}] Reference list.\n` + Array.from({ length: 700 }, (_, i) => `${i}: ${words[i % 16]} ${words[(i * 7) % 16]} ${words[(i * 11) % 16]} item.`).join("\n");

if (route === "anthropic") {
  const t = await call(A.body({ messages: [{ role: "user", content: "Say hello in three words." }] }));
  report("text", t, t.status === 200 && !!t.text);

  const ask = { role: "user", content: "What is the weather in Paris? Use the tool." };
  const t1 = await call(A.body({ tools: [A.tool], messages: [ask] }));
  const use = t1.calls[0];
  report("tool call", t1, t1.status === 200 && !!use);
  if (use) {
    const t2 = await call(A.body({ tools: [A.tool], messages: [ask, { role: "assistant", content: [use] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: use.id, content: "{\"tempC\":17,\"sky\":\"rain\"}" }] }] }));
    report("tool result", t2, t2.status === 200 && !!t2.text);
  }

  const u = await call(A.body({ messages: [{ role: "user", content: [A.text(ASK), A.image()] }] }));
  report("image in a user message", u, u.status === 200 && sawImage(u.text), { sawImage: sawImage(u.text) });
  const viewTool = { name: "attachments_view", description: "Show an attachment.", input_schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } };
  const view = { type: "tool_use", id: "toolu_probe", name: "attachments_view", input: { name: "chart.png" } };
  const r = await call(A.body({ tools: [viewTool], messages: [{ role: "user", content: `Look at chart.png with attachments_view. ${ASK}` }, { role: "assistant", content: [view] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: view.id, content: [A.text("The image:"), A.image()] }] }] }));
  report("image in a tool result", r, r.status === 200 && sawImage(r.text), { sawImage: sawImage(r.text) });

  const cached = () => call(A.body({ max_tokens: 16, system: [{ type: "text", text: PREFIX, cache_control: { type: "ephemeral" } }], messages: [{ role: "user", content: "Reply OK." }] }));
  const c1 = await cached(), c2 = await cached();
  report("cache write", c1, c1.status === 200 && (c1.usage?.cacheWrite ?? 0) > 0);
  report("cache read", c2, c2.status === 200 && (c2.usage?.cacheRead ?? 0) > 0);

  if (binding) {
    // Through this branch's own path: the request `toAnthropicRequest` builds from a transcript, and the transcript
    // `readMessage` and `fromResponse` write from each answer (src/model/pi-bridge.ts, src/model/anthropic-messages.ts),
    // so what is proven is that path's replay, not a hand-built one. `prefix_mismatch_behavior: "error"` opts the
    // request into the check whatever the account's default (an account created before 2026-08-31 is not enforced, and
    // an edited replay without the field is a 200 that lists `thinking_mismatch_allowed`).
    const beta = { "anthropic-beta": "thinking-binding-controls-2026-08-01" };
    const thinking = { type: "adaptive", block_binding: { prefix_mismatch_behavior: "error" } };
    const send = async (context) => {
      const req = toAnthropicRequest(context, model);
      const res = await fetch(url, { method: "POST", headers: { ...headers, ...beta },
        body: JSON.stringify(A.body({ max_tokens: 8192, thinking, output_config: { effort: "high" }, ...req })) });
      let j = {};
      try { j = await res.json(); } catch { /* status says enough */ }
      return { status: res.status, j };
    };
    const tool = { name: "get_weather", description: A.tool.description, parameters: A.tool.input_schema };
    const question = "Work out, step by step, which of Oslo, Copenhagen and Reykjavik has the most letters and which the fewest; " +
      "then call get_weather for those two cities, one call at a time.";
    const context = { systemPrompt: "You are careful.", tools: [tool], messages: [{ role: "user", content: question, timestamp: 1 }] };
    const first = await send(context);
    const answer = first.status === 200 ? fromResponse(readMessage(first.j), { api: "offloaded", provider: "probe", id: model }, "probe") : null;
    const calls = (answer?.content ?? []).filter((c) => c.type === "toolCall");
    const thought = (answer?.content ?? []).filter((c) => c.type === "thinking" && c.thinkingSignature).length;
    const replay = { ...context, messages: [...context.messages, answer, ...calls.map((c) => ({
      role: "toolResult", toolCallId: c.id, toolName: c.name, content: [{ type: "text", text: "{\"tempC\":11}" }], isError: false, timestamp: 3 }))] };
    const honest = calls.length ? await send(replay) : { status: 0, j: {} };
    // The negative control: the same replay with an earlier message edited. The check must refuse it, or it proved nothing.
    const edited = { ...replay, messages: [{ ...replay.messages[0], content: `${question} (edited)` }, ...replay.messages.slice(1)] };
    const refused = calls.length ? await send(edited) : { status: 0, j: {} };
    const boundElsewhere = /bound to a different conversation/.test(String(refused.j?.error?.message ?? ""));
    const transformed = honest.j?.input_transformations ?? null;
    report("preserved thinking: honest replay accepted, edited replay refused", { status: honest.status, usage: honest.j?.usage ?? null },
      first.status === 200 && thought > 0 && calls.length > 0 && honest.status === 200 && Array.isArray(transformed) && transformed.length === 0
        && refused.status === 400 && boundElsewhere,
      { first: first.status, ...(first.status !== 200 ? { firstError: String(first.j?.error?.message ?? "").slice(0, 120) } : {}), thinkingBlocks: thought, calls: calls.length, blocks: (answer?.content ?? []).map((c) => c.type),
        inputTransformations: transformed, editedStatus: refused.status, editedBoundElsewhere: boundElsewhere,
        ...(thought === 0 ? { inconclusive: "the model wrote no thinking block, so there was nothing to bind" } : {}) });
  }
} else {
  const t = await call(C.body({ messages: [{ role: "user", content: "Say hello in three words." }] }));
  report("text", t, t.status === 200 && !!t.text);
  const ask = { role: "user", content: "What is the weather in Paris? Use the tool." };
  const t1 = await call(C.body({ tools: [C.tool], messages: [ask] }));
  const use = t1.calls[0];
  report("tool call", t1, t1.status === 200 && !!use);
  if (use) {
    const t2 = await call(C.body({ tools: [C.tool], messages: [ask, { role: "assistant", content: "", tool_calls: [use] }, { role: "tool", tool_call_id: use.id, content: "{\"tempC\":17}" }] }));
    report("tool result", t2, t2.status === 200 && !!t2.text);
  }
  const u = await call(C.body({ messages: [{ role: "user", content: [{ type: "text", text: ASK }, { type: "image_url", image_url: { url: `data:image/png;base64,${IMG}` } }] }] }));
  report("image in a user message", u, u.status === 200 && sawImage(u.text), { sawImage: sawImage(u.text) });
}
process.exit(failed ? 1 : 0);
