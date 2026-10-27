/**
 * The part of `@botiverse/stamp-sdk/client` the stamp plugin uses: the client that sends a request and shapes its
 * errors, and those errors. The session stays the plugin's own (src/plugins/stamp.ts `accessToken`); the SDK's
 * session handling (`injectedAgentAuth`, `refreshSession`) is not used, so it is not declared. The SDK is plain
 * JavaScript with no declarations of its own; `test/stamp-plugin.ts` runs the plugin against the real package,
 * which is what catches this drifting from it.
 */
declare module "@botiverse/stamp-sdk/client" {
  /** A local mistake; `code` is the SDK's catalog key. */
  export class AgentError extends Error {
    code: string;
    details: Record<string, any>;
  }
  /** The request did not reach the gateway (a transport failure, never an HTTP status). */
  export class NetworkError extends AgentError {}
  /** The gateway answered with a status that is not 2xx; `body` is its JSON, or null. */
  export class ApiError extends Error {
    status: number;
    body: unknown;
    requestId: string;
  }
  /** What the client asks of an auth: the token to send, and the one to retry a 401 with (null: no retry). */
  export interface ClientAuth {
    mode: "agent";
    apiBase: string;
    token(): Promise<string>;
    retryToken(used: string): Promise<string | null>;
  }
  export function makeClient(
    auth: ClientAuth,
    fetchImpl?: (url: string | URL, init?: RequestInit) => Promise<Response>,
    options?: { retryReads?: boolean; readRetries?: number; retryDelayMs?: number; sleep?: (ms: number) => Promise<void> },
  ): (method: string, path: string, body?: unknown) => Promise<any>;
}
