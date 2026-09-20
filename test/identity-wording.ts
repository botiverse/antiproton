/**
 * The patterns that say WHICH advice a sentence gives, and the cases that keep
 * them honest — in one table, because a pattern and its negation cases are one
 * thing, not two lists to keep aligned.
 *
 * Two test files assert on these sentences, and a pattern per file is the copy
 * this line of work exists to remove.
 *
 * **Why the shapes.** A pattern matching the action's *word* accepts the opposite
 * advice: `/attach/` passes "attaching is not possible", and with the source
 * sentence reversed both suites stayed fully green (@Rex found the shape,
 * 2026-09-20). Matching a modal together with its verb rejects that, because a
 * negation has to sit between them.
 *
 * **The trap for whoever widens one.** The *negated modal* ("does not have to
 * write it again") is rejected only by a coincidence of conjugation, not by that
 * adjacency: the alternation lists `has to` and `needs to` while those sentences
 * use base forms. Adding `have to` for rewording tolerance — the reasonable next
 * edit — lets the negation through. `rejectsItsOwnNegation` fails when it does.
 *
 * **Why one table rather than two.** @Rex noticed that parallel arrays let a new
 * pattern be added to the recommending list and forgotten in the opposing one,
 * losing the half that matters, silently. So a pattern is *defined inside* its
 * entry and exported by lookup: there is nowhere to put a pattern that has no
 * cases, and `Case` requires both fields, so a missing half is a compile error.
 */
interface Case {
  readonly name: string;
  readonly pattern: RegExp;
  /** Sentences that give this advice. Every one must match. */
  readonly recommends: readonly string[];
  /** Sentences that give the OPPOSITE advice. None may match. Negated modals
   *  belong here: they are the cases adjacency does not cover. */
  readonly opposes: readonly string[];
}

const MODAL = "(?:has to|must|needs to)";

const CASES: readonly Case[] = [
  {
    name: "attach",
    pattern: /can attach one|attaches an account/,
    recommends: ["and a person can attach one", "until a person attaches an account"],
    opposes: ["attaching is not possible", "do not attach anything", "should not attach one here"],
  },
  {
    name: "rewrite",
    pattern: new RegExp(`${MODAL} write it again`),
    recommends: ["has to write it again", "must write it again", "needs to write it again"],
    opposes: [
      "must NOT write it again",
      "must never write it again",
      "does not have to write it again",
      "does not need to write it again",
    ],
  },
  {
    name: "deploy-config",
    pattern: new RegExp(`whoever deploys ${MODAL} configure`),
    recommends: ["whoever deploys has to configure it there", "whoever deploys must configure it there"],
    opposes: [
      "whoever deploys canNOT configure it there",
      "whoever deploys does not have to configure it",
    ],
  },
];

function pattern(name: string): RegExp {
  const found = CASES.find((c) => c.name === name);
  if (!found) throw new Error(`no wording case named ${name}`);
  return found.pattern;
}

export const RECOMMENDS_ATTACH = pattern("attach");
export const RECOMMENDS_REWRITE = pattern("rewrite");
export const RECOMMENDS_DEPLOY_CONFIG = pattern("deploy-config");

/** Every pattern accepts each sentence that recommends and rejects each that opposes. */
export function rejectsItsOwnNegation(): string | null {
  for (const { name, pattern: p, recommends, opposes } of CASES) {
    if (recommends.length === 0 || opposes.length === 0) {
      return `wording case ${name} has an empty half, so it proves nothing`;
    }
    for (const s of recommends) {
      if (!p.test(s)) return `${name} ${p} rejects a sentence that recommends: ${JSON.stringify(s)}`;
    }
    for (const s of opposes) {
      if (p.test(s)) return `${name} ${p} accepts the OPPOSITE advice: ${JSON.stringify(s)}`;
    }
  }
  return null;
}
