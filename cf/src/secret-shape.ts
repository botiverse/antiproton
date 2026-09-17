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
 *
 * Two sources. A plugin that takes a credential declares what it looks like
 * (CredentialSpec.looksLike, #349), so a match names the mount it belongs in and
 * the shape lives in one place, beside the form that takes it. What no plugin
 * takes stays in the generic list below, and matches it with no plugin: there is
 * nowhere to put it, and the refusal says so.
 */
import { recogniseCredentials, type Plugin } from "../../src/plugins/types.ts";
import { githubPlugin } from "../../src/plugins/github.ts";
import { raftPlugin } from "../../src/plugins/raft.ts";

/**
 * The plugins whose credential declares what it looks like. Recognition runs in the
 * Worker, before an Agents API session exists (a refused request leaves nothing), where
 * the runtime's own plugin list is not at hand. test/secret-shape.ts fails when a plugin
 * under src/plugins declares `looksLike` and is missing here.
 */
export const SHAPE_DECLARING_PLUGINS: ReadonlyArray<Pick<Plugin, "id" | "credential">> = [githubPlugin, raftPlugin];

/** Credentials no plugin takes, so none declares them. */
const GENERIC_SHAPES: ReadonlyArray<readonly [string, RegExp]> = [
  // OpenAI-style and Anthropic keys.
  ["api-key", /\bsk-(?:ant-[a-z0-9]+-|proj-)?[A-Za-z0-9_-]{32,}/],
  ["aws-access-key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["private-key", /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/],
  ["slack-token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  // scheme://user:password@host — a user alone (git@github.com, https://user@host) is not a credential.
  ["url-with-password", /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]{8,}@[^\s/@]+/i],
  ["neon-password", /\bnpg_[A-Za-z0-9]{12,}/],
];

/**
 * What the text looks like, and which plugins' mounts take that kind (empty when none does).
 * Never returns any of the text.
 */
export function secretMatch(text: string): { kind: string; plugins: string[] } | null {
  const declared = recogniseCredentials(text, [...SHAPE_DECLARING_PLUGINS]);
  if (declared.length) {
    const kind = declared[0]!.kind;
    return { kind, plugins: [...new Set(declared.filter((d) => d.kind === kind).map((d) => d.plugin))] };
  }
  for (const [kind, shape] of GENERIC_SHAPES) if (shape.test(text)) return { kind, plugins: [] };
  return null;
}

/** The kind of credential the text looks like, or null. Never returns any of the text. */
export function secretShape(text: string): string | null {
  return secretMatch(text)?.kind ?? null;
}

/**
 * The console's refusal: 422 with the kind and the plugins that take it, and nothing of the text,
 * so the page can keep what the person typed, point at the mount that takes it (or say none does),
 * and offer to send it anyway. `allow` is that deliberate second send.
 */
export function refuseSecret(text: string, allow: boolean): Response | null {
  if (allow) return null;
  const match = secretMatch(text);
  if (!match) return null;
  const where = match.plugins.length
    ? `It belongs in the credential form of a ${match.plugins.join(" or ")} mount (the plugins page), where the agent can use it and the model never sees it.`
    // No plugin takes a database connection string, for one (Piper): there is nowhere to put it.
    : "No mount here takes this kind of credential, so do not paste it into chat.";
  return Response.json({
    error: `This looks like a ${match.kind}. It was not sent. ${where} If it is not a credential, send it anyway.`,
    secret: true,
    kind: match.kind,
    plugins: match.plugins,
  }, { status: 422, headers: { "cache-control": "no-store" } });
}
