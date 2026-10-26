/**
 * The part of `@botiverse/stamp-sdk/client` the stamp plugin uses. The SDK is
 * plain JavaScript with no declarations of its own, so its shape is written
 * here; `test/stamp-plugin.ts` runs the plugin against the real package, which
 * is what catches this drifting from it.
 */
declare module "@botiverse/stamp-sdk/client" {
  /** A local or transport failure; `code` is the SDK's catalog key (`refresh_lost`, `injected_session_missing` …). */
  export class AgentError extends Error {
    code: string;
    details: Record<string, any>;
  }
  /** The gateway answered with a status that is not 2xx; `body` is its JSON, or null. */
  export class ApiError extends Error {
    status: number;
    body: unknown;
    requestId: string;
  }
  export interface InjectedAgentAuth {
    mode: "agent";
    apiBase: string;
    token(): Promise<string>;
    retryToken(used: string): Promise<string>;
  }
  export function injectedAgentAuth(options: {
    apiBase: string;
    getSession: () => Promise<Record<string, any> | null>;
    onSession: (session: any) => Promise<void>;
    fetchImpl?: (url: string | URL, init?: RequestInit) => Promise<Response>;
    now?: () => number;
    skewMs?: number;
    deadlineMs?: number;
  }): InjectedAgentAuth;
  export function makeClient(
    auth: InjectedAgentAuth,
    fetchImpl?: (url: string | URL, init?: RequestInit) => Promise<Response>,
    options?: { retryReads?: boolean; readRetries?: number; retryDelayMs?: number; sleep?: (ms: number) => Promise<void> },
  ): (method: string, path: string, body?: unknown) => Promise<any>;
}
