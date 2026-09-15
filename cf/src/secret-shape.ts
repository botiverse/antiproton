/**
 * Whether text a person is about to send an agent looks like a credential.
 *
 * In one agent's conversation (task #19) the user pasted a GitHub token and a
 * database connection string with its password into chat. Both went into the
 * transcript and to the model provider, and the model repeated them twelve more
 * times, including in commands. A credential belongs in a mount's credential
 * form, where the model never sees it. So text is checked before it reaches the
 * agent, and one that looks like a credential is refused with the kind it
 * looks like and never the text itself.
 *
 * Shapes only, chosen to be specific: a false positive costs one deliberate
 * "send anyway", a false negative costs a leaked secret, and a shape so loose it
 * refuses ordinary text would teach people to send anyway by reflex.
 */

export type SecretKind =
  | "github-token"
  | "api-key"
  | "aws-access-key"
  | "private-key"
  | "slack-token"
  | "url-with-password"
  | "neon-password";

const SHAPES: ReadonlyArray<readonly [SecretKind, RegExp]> = [
  // Classic and fine-grained GitHub tokens: a fixed prefix and a long random body.
  ["github-token", /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})/],
  // OpenAI-style and Anthropic keys.
  ["api-key", /\bsk-(?:ant-[a-z0-9]+-|proj-)?[A-Za-z0-9_-]{32,}/],
  ["aws-access-key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["private-key", /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/],
  ["slack-token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  // scheme://user:password@host — a user alone (git@github.com, https://user@host) is not a credential.
  ["url-with-password", /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]{8,}@[^\s/@]+/i],
  ["neon-password", /\bnpg_[A-Za-z0-9]{12,}/],
];

/** The kind of credential the text looks like, or null. Never returns any of the text. */
export function secretShape(text: string): SecretKind | null {
  for (const [kind, shape] of SHAPES) if (shape.test(text)) return kind;
  return null;
}

/**
 * The console's refusal: 422 with the kind, and nothing of the text, so the page can keep what the person
 * typed, say where a credential goes, and offer to send it anyway. `allow` is that deliberate second send.
 */
export function refuseSecret(text: string, allow: boolean): Response | null {
  if (allow) return null;
  const kind = secretShape(text);
  if (!kind) return null;
  return Response.json({
    // Not every kind has a mount to go to (none takes a database connection string, Piper): the line says so.
    error: `This looks like a ${kind}. It was not sent. A credential belongs in the credential form of the mount that uses it `
      + `(the plugins page), where the agent can use it and the model never sees it; if no mount takes this kind, `
      + `do not paste it here. If it is not a credential, send it anyway.`,
    secret: true,
    kind,
  }, { status: 422, headers: { "cache-control": "no-store" } });
}
