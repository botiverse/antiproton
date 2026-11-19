/**
 * `dialogueOf` (bench/tau2/episode.ts): a failing τ² row's conversation, rebuilt from the simulator's
 * message list, where the agent speaks as `user` and the customer as `assistant`. The object's transcript
 * is unreadable once a run ends, so this is what a failure gets classified from; a role swapped here would
 * put the customer's words in the agent's mouth.
 */
import { dialogueOf, DIALOGUE_LINE_MAX } from "../bench/tau2/episode.ts";

let passed = 0, failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) passed++; else { failed++; console.log(`FAIL ${name} ${detail}`); }
}

const sim = [
  { role: "system" as const, content: "you are a customer" },
  { role: "user" as const, content: "Hi! How can I help you today?" },
  { role: "assistant" as const, content: "I want to exchange two items." },
  { role: "user" as const, content: "Sure, which order?" },
  { role: "assistant" as const, content: "###TRANSFER###" },
];

const d = dialogueOf(sim);
check("drops the simulator's system prompt", d.length === 4, JSON.stringify(d));
check("simulator user is the agent", d[0].who === "agent" && d[0].text === "Hi! How can I help you today?");
check("simulator assistant is the customer", d[1].who === "customer" && d[3].text === "###TRANSFER###");
check("keeps order", d.map((l) => l.who).join(",") === "agent,customer,agent,customer");

const p = dialogueOf(sim, "Your exchange is done.");
check("pending agent line goes last", p.length === 5 && p[4].who === "agent" && p[4].text === "Your exchange is done.");

const long = dialogueOf([{ role: "assistant", content: "x".repeat(DIALOGUE_LINE_MAX + 50) }]);
check("caps a line", long[0].text.length === DIALOGUE_LINE_MAX);

check("does not change its input", sim.length === 5 && sim[0].role === "system");

console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
