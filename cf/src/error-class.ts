/** An error's class, for a log line that must not carry its message: a name made of letters, or `unknown`. */
export function errorClassOf(e: unknown): string {
  const name = (e as { name?: unknown } | null)?.name;
  return typeof name === "string" && /^[A-Za-z][A-Za-z0-9]{0,39}$/.test(name) ? name : "unknown";
}
