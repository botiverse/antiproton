import type { CredentialCheck } from "../types.ts";

/**
 * What the sandbox plugin asks of whoever runs its containers.
 *
 * The plugin (src/plugins/sandbox.ts) keeps everything that is about the agent: the record of its machines, the
 * lease, held time, the tools and what they say. A provider is the other half, and it is only as wide as the
 * plugin's calls: a method is here because the plugin calls it. Two levels, because a credential has to be
 * judged before it can be used: `SandboxBackend` answers for a stored credential that may not even parse, and
 * `open` binds one that does to a `SandboxProvider` the plugin's calls go through.
 *
 * Nothing outside an adapter reads a provider's error text or its field names. A refusal arrives as a
 * `ProviderError` whose `code` says what kind it is; its message is the adapter's own wording, which results and
 * release facts carry as they always have.
 */
export interface SandboxBackend {
  id: "run9";
  caps: ProviderCaps;
  /**
   * The provider bound to a mount's settings and credential. Throws when the stored credential does not parse:
   * that is a broken mount, and the caller reports it rather than talking to the provider with nothing.
   */
  open(settings: ProviderSettings, credential: string): SandboxProvider;
  /** Does this credential work, asked when a person pastes it (`Plugin.checkCredential`). */
  checkCredential(settings: ProviderSettings, credential: string): Promise<CredentialCheck>;
  /**
   * The account these keys act on, so a replaced key on the same account keeps the boxes (`Plugin.credentialAccount`).
   * Null when it cannot be told; throws when the provider did not answer, which is not "no account".
   */
  account(settings: ProviderSettings, credential: string): Promise<string | null>;
}

/** What a provider can do, declared so the plugin can ask rather than assume. Nothing reads these yet. */
export interface ProviderCaps {
  /** What switching an idle box off keeps: its memory (resumes where it was) or only its disk. */
  pause: "memory" | "disk";
  /** Whether a filesystem can be kept while the box runs, only once it is stopped, or not at all. */
  snapshot: "live" | "stopped" | null;
  /** Whether the provider runs a command detached and lets it be killed, or the adapter has to emulate that. */
  backgroundExec: "native" | "emulated";
  /** Whether a port in the box can be reached from outside. */
  publicPorts: boolean;
  /** Whether the provider can restrict where a box connects to. */
  egressPolicy: boolean;
  /** Whether held time is the provider's own reading or our estimate from when the box existed. */
  usageMeter: "provider" | "estimate";
}

/** The mount settings an adapter reads; the plugin's config with its defaults filled in. */
export interface ProviderSettings {
  endpoint: string;
  project: string;
  /** How long one request may take. */
  timeoutMs: number;
  /** Who answers whether the credential works: the provider's API, or the endpoint's own `/credential`. */
  verifyWith: "provider" | "endpoint";
}

/**
 * A box as its provider sees it, in one vocabulary: `running` is awake (a command or a file read goes straight
 * to it), `stopped` exists but is not awake, `gone` is not there at all.
 */
export type BoxState = "starting" | "running" | "paused" | "stopped" | "gone";

/** How a refusal is told apart without reading its text. */
export type ProviderErrorCode =
  /** No machine of that shape could be had now. */
  | "no_capacity"
  /** Asked too often. */
  | "rate_limited"
  /** The box has to be running for this. */
  | "not_running"
  /** The provider has no such thing. */
  | "not_found"
  /** It already exists, or the provider is busy with it. */
  | "conflict"
  /** The credential was not accepted. */
  | "auth"
  /** A refusal of the request itself, which asking again will not change. */
  | "refused"
  /** The provider had trouble (a 5xx, a timeout, an answer that does not read); asking again may work. */
  | "transient";

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  /** True when asking again will not change the answer: what an operator's `forget` may act on. */
  readonly definitive: boolean;
  /** The provider's HTTP status, when it answered with one. */
  readonly status?: number;
  /** What the provider said, untrimmed; the message carries the part a reader is shown. */
  readonly detail: string;
  constructor(message: string, o: { code: ProviderErrorCode; definitive: boolean; status?: number; detail?: string }) {
    super(message);
    this.code = o.code;
    this.definitive = o.definitive;
    if (o.status !== undefined) this.status = o.status;
    this.detail = o.detail ?? "";
  }
}

/**
 * An execution as the provider reports it. `state` is in the vocabulary results carry to the model (`queued`,
 * `running`, then one of `TERMINAL_EXEC_STATES`); an adapter whose provider names them otherwise maps them.
 * The other fields are as the provider gave them, unconverted: the plugin decides how each reads.
 */
export interface ExecStatus {
  state: string;
  exitCode: unknown;
  output: unknown;
  reason: unknown;
  /** The provider could not start it in the directory it was given, which the plugin answers by name. */
  couldNotStart: boolean;
}

/**
 * The states of an execution that will not change again.
 *
 * `error` included: run9 documents it as platform trouble rather than an app exit, and an exec that could not
 * start (a working directory that does not exist, measured 2026-09-15) sits in it for good. Left out, such an exec
 * was never finished: the call handed it over as a job and every poll said "not yet".
 */
export const TERMINAL_EXEC_STATES: readonly string[] = ["succeeded", "failed", "killed", "cancelled", "timeout", "error"];

/** One credential registered with the provider's egress for one box: the box holds only the placeholder. */
export interface EgressSecret { name: string; value: string; placeholder: string; header: string; hosts: string[] }

/** What a new box starts from and how it is set up. */
export interface BoxSpec {
  /** The box's id, chosen by the plugin. */
  id: string;
  /** A kept filesystem to start from, or else `image`. */
  fromSnapshot?: string;
  image: string;
  /** Whether egress secrets will be registered, which needs the provider's proxy in the path. */
  egressSecrets: boolean;
  shape?: string;
  description: string;
}

/** A limit on one request: a deadline the whole operation shares, or a timeout of its own. */
export interface Within { deadline?: number; timeoutMs?: number }

/**
 * One mount's provider, bound to its credential. Every method talks to the provider and reports a refusal as a
 * `ProviderError`; a failure to reach it at all (a timeout, a refused connection) is thrown as it came.
 */
export interface SandboxProvider {
  /** Creates the box. A box that already exists under this id is a `conflict`. */
  create(spec: BoxSpec): Promise<void>;
  /** Where the box is, read without waking it. */
  status(id: string, within?: Within): Promise<BoxState>;
  /** Starts a command, detached so it can be killed; its execution id. */
  execBackground(id: string, req: { argv: string[]; workdir?: string | null }, within?: Within): Promise<string>;
  poll(execId: string, within?: Within): Promise<ExecStatus>;
  kill(execId: string): Promise<void>;
  /** Copies a file in, and resolves once the provider has finished taking it. */
  upload(id: string, path: string, bytes: Uint8Array): Promise<void>;
  /** A file, or with `archive` a directory as a tar, as a response whose body has not been read. */
  download(id: string, path: string, o: { archive?: boolean; timeoutMs: number }): Promise<Response>;
  /** Switches the box off, keeping it to be started again. */
  stop(id: string): Promise<void>;
  /** Deletes the box: what actually frees it. */
  delete(id: string): Promise<void>;
  /** Keeps the box's filesystem under a new snapshot id; `caps.snapshot` says whether the box stays up. */
  snapshot(id: string, description: string): Promise<string>;
  addSecret(id: string, secret: EgressSecret): Promise<void>;
  listSecrets(id: string): Promise<Array<{ name: unknown; id: unknown }>>;
  removeSecret(id: string, secretId: unknown): Promise<void>;
}
