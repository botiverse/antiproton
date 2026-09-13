/**
 * The ratchet is plain JavaScript so it can run before anything is built.
 * This says what the one function a test needs looks like, rather than letting
 * the import arrive as `any` — an untyped import would be a new baseline entry
 * in the very file that counts them.
 */
export function baselineSignatures(text: string): string[];
export function baselineReasons(text: string): Map<string, string>;
export function rewriteBaseline(
  now: string[],
  priorText: string | undefined,
): { text: string; carried: [string, string][]; dropped: [string, string][] };
export function signatures(output: string): string[];
export function compare(now: string[], baselineText: string): { base: Set<string>; fresh: string[]; gone: string[] };
export function boundary(
  programs: Record<string, { files: Set<string>; roots: Set<string> }>,
  sources: string[],
): string[];
export const PROGRAMS: { name: string; config: string; baseline: string }[];
