/**
 * The patterns that say WHICH advice a sentence gives, in one place, with the
 * check that keeps them honest.
 *
 * Two test files assert on these sentences, and a pattern per file is the copy
 * this whole line of work exists to remove. They live here so widening one
 * widens the check with it.
 *
 * Why these shapes: a pattern matching the action's *word* accepts the opposite
 * advice — `/attach/` passes "attaching is not possible", and with the source
 * sentence reversed both suites stayed fully green (@Rex found the shape,
 * 2026-09-20). Matching the modal together with its verb rejects that, because
 * a negation has to sit between them.
 *
 * And the trap for whoever widens these: the *negated modal* ("does not have to
 * write it again") is rejected by a coincidence of conjugation, not by that
 * adjacency — the current alternations list `has to` and `needs to`, and the
 * sentence uses the base forms. Add `have to` or `need to` for rewording
 * tolerance and the negation passes. `rejectsItsOwnNegation` below fails when
 * that happens, so the next edit hears about it from a test rather than from a
 * reader of a badge.
 */
const MODAL = "(?:has to|must|needs to)";

/** Recommends attaching an account. */
export const RECOMMENDS_ATTACH = /can attach one|attaches an account/;
/** Recommends writing the mount's credential again. */
export const RECOMMENDS_REWRITE = new RegExp(`${MODAL} write it again`);
/** Recommends that whoever deploys configures it. */
export const RECOMMENDS_DEPLOY_CONFIG = new RegExp(`whoever deploys ${MODAL} configure`);

/** Sentences that recommend, which every pattern above must accept. */
const RECOMMENDING: Array<[RegExp, string[]]> = [
  [RECOMMENDS_ATTACH, ["and a person can attach one", "until a person attaches an account"]],
  [RECOMMENDS_REWRITE, ["has to write it again", "must write it again", "needs to write it again"]],
  [RECOMMENDS_DEPLOY_CONFIG, [
    "whoever deploys has to configure it there",
    "whoever deploys must configure it there",
  ]],
];

/**
 * Sentences that give the OPPOSITE advice, which no pattern may accept.
 *
 * The negated modals are here on purpose: they are the cases adjacency does not
 * cover, so they are the ones a widening breaks first.
 */
const OPPOSING: Array<[RegExp, string[]]> = [
  [RECOMMENDS_ATTACH, ["attaching is not possible", "do not attach anything", "should not attach one here"]],
  [RECOMMENDS_REWRITE, [
    "must NOT write it again",
    "must never write it again",
    "does not have to write it again",
    "does not need to write it again",
  ]],
  [RECOMMENDS_DEPLOY_CONFIG, [
    "whoever deploys canNOT configure it there",
    "whoever deploys does not have to configure it",
  ]],
];

/** Every pattern accepts every recommending form and rejects every opposing one. */
export function rejectsItsOwnNegation(): string | null {
  for (const [pattern, sentences] of RECOMMENDING) {
    for (const s of sentences) {
      if (!pattern.test(s)) return `${pattern} rejects a sentence that recommends: ${JSON.stringify(s)}`;
    }
  }
  for (const [pattern, sentences] of OPPOSING) {
    for (const s of sentences) {
      if (pattern.test(s)) return `${pattern} accepts the OPPOSITE advice: ${JSON.stringify(s)}`;
    }
  }
  return null;
}
