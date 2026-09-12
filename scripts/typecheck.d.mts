/**
 * The ratchet is plain JavaScript so it can run before anything is built.
 * This says what the one function a test needs looks like, rather than letting
 * the import arrive as `any` — an untyped import would be a new baseline entry
 * in the very file that counts them.
 */
export function baselineSignatures(text: string): string[];
export function baselineReasons(text: string): Map<string, string>;
