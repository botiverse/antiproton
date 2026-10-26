/**
 * What the object says it started, held against what the runner asked for. An older Worker ignores `provider` and
 * `engine` and answers without them, which is run9 and the object's default engine: an arm that ran on the wrong
 * provider or engine would otherwise read as a result.
 */
export function startedAs(started: { provider?: string; engine?: string } | undefined, asked: { provider: string; engine: string }): { provider: string; engine: string | null } {
  const provider = started?.provider ?? "run9";
  if (provider !== asked.provider) throw new Error(`asked for provider ${asked.provider}, the object runs ${provider}`);
  const engine = started?.engine ?? (asked.engine === "pi085" ? "pi085" : null);
  if (engine !== asked.engine) throw new Error(`asked for ${asked.engine}, the object runs ${engine ?? "an engine it did not name"}`);
  return { provider, engine };
}
