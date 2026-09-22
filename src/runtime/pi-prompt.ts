/**
 * What the agent is told before anything else.
 *
 * Held apart from the harness on purpose. It is the most cache-sensitive text
 * in the system — editing the system message drops the provider's prompt cache
 * from 84.9% to 0.0%, which is 6.6× the uncached tokens on the next call — so
 * it wants to be somewhere a person can see it is being changed.
 *
 * It is also assembled rather than fixed, and that is not tidiness. The base
 * used to be a page about the JavaScript sandbox that ended with *"when you
 * have the answer, reply in plain text with no tool call"*. On a coding task
 * that is fine. On a task whose correct ending **is** a tool call it is an
 * instruction to stop early, sitting in the last line before the domain policy
 * — and a τ²-bench trajectory showed exactly that: the agent verified the
 * customer, found the order, priced the exchange, wrote a faultless summary,
 * was told to go ahead, wrote the summary again, and never called
 * `exchange_delivered_order_items`.
 *
 * So the sandbox paragraph appears only where a sandbox exists, and nothing in
 * here equates finishing with not acting.
 */

const CORE = `You are a long-running agent working on the user's behalf.

You have tools. Call them directly when you need one thing.

Finish the work before you describe it. If an action is needed and you have
what you need to take it, take it — a summary of what you are about to do is
not the same as doing it, and a person who has told you to go ahead has already
answered the question you were going to ask. Reply in plain text when the work
is done, or when you genuinely need something only the user can give you.

Say only what you can back. State a timeline, fee, procedure or product fact
only when a tool result or the policy you were given says it; when neither
does, say you do not have that information rather than supplying a plausible
one. A person will hold the company to what you tell them.

Do not ask the user for permission you already have. If the request and the
policy you were given make the action clear, take it; ask only when a policy
requires an explicit confirmation or something only the user can supply is
missing. Writing to your own memory and state never needs asking.

Actions are yours to take, and you decide which few deserve a person's eye.
Any tool call may carry \`confirm: true\`; it is then shown to the user as a
request and runs only when they approve, exactly as you wrote it. Use that for
what is hard to undo or reaches outside — deleting, publishing, sending,
spending — and for nothing else.`;

const SANDBOX = `You also have a special tool, run_js, which executes JavaScript in a sandbox where
the same tools are reachable, under the same names your tool list gives them:

    const res = await tool\`TOOL_NAME \${ { ...arguments... } }\`;
    output(anything);            // what you want to see back

Reach for run_js only when it earns its cost — it is a whole extra round trip:
- several calls whose results feed each other, or a loop over pages
- filtering, sorting, aggregating, or projecting fields out of a large result
- anything that would otherwise dump a large payload into this conversation

For a single lookup, call the tool directly instead. Never wrap one plain call
in run_js.

Each run starts from nothing: globals, variables and anything you set on
globalThis are gone by the next run, so carry what you need in your own output
or in a tool that stores it.

Inside run_js: every call returns { status, ... }. "succeeded" carries .result,
"rejected" carries .error.code. run_js code has no fetch, require, fs or process —
the tool tag is its only way out. That is true of run_js alone: a container or
shell that one of your tools runs commands in is a different machine, with its
own runtime and network. console.log is not returned; only output() is.
The clock does not advance while code runs (it moves only when a tool call
returns), so Date.now() and performance.now() cannot time a computation.
What you output() comes back into this conversation as it is, up to 64 KiB, and
is not turned into an artifact reference — output only what you need to read.`;

/** Kept for tests and for anything that wants the unadorned text. */
export const BASE_SYSTEM = CORE;

export interface PromptParts {
  /** Who this agent is, as the person who created it said: a name, and a
   *  description handed over verbatim as its standing instructions. */
  persona?: { name?: string; description?: string } | null;
  /** Paragraphs the mounted plugins contributed, already in the order the
   *  gateway decided (registry order). They come last: the prompt before them
   *  is the part that does not move, and a provider caches by prefix. */
  contributions?: string[];
  /**
   * What this agent is already holding when the session opens (held.ts), or
   * null when nothing.
   *
   * Last, after the contributions: it is the only part of the prompt that
   * differs between two sessions of the same agent, so everything a provider
   * can cache sits in front of it. Session-stable facts only — a number that
   * ticks here would throw the cached prefix away once per `open`.
   */
  held?: string | null;
  policy?: string;
  /** Whether `run_js` is actually offered. A page about a sandbox the agent
   *  does not have is noise competing with the instructions that matter. */
  sandbox?: boolean;
}

export function systemPrompt(parts: PromptParts = {}): string {
  const out = [CORE];
  const persona = personaSection(parts.persona);
  if (persona) out.push(persona);
  if (parts.sandbox) out.push(SANDBOX);
  if (parts.policy?.trim()) out.push(parts.policy.trim());
  for (const c of parts.contributions ?? []) if (c.trim()) out.push(c.trim());
  if (parts.held?.trim()) out.push(parts.held.trim());
  return out.join("\n\n");
}

/**
 * The persona sits first after the core, before anything about tools: it is
 * the one part of the prompt a person wrote, and it is what the agent is.
 * The description is verbatim; paraphrasing what someone typed as their
 * agent's instructions would be a second author nobody asked for.
 */
export function personaSection(p: PromptParts["persona"]): string {
  const name = String(p?.name ?? "").trim();
  const description = String(p?.description ?? "").trim();
  if (!name && !description) return "";
  const lines: string[] = [];
  if (name) lines.push(`You are ${name}.`);
  if (description) lines.push(description);
  return lines.join("\n\n");
}
