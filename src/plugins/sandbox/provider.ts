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
  id: "run9" | "instabox";
  /** How results and refusals name the provider to a reader. */
  name: string;
  caps: ProviderCaps;
  /**
   * What a command is started under when the mount has no network (`network: "none"`): a prefix of the argv that
   * puts it in an empty network namespace, as the box's own user can.
   */
  isolateNetwork: readonly string[];
  /** The prefix for a mount with these settings, where it is not always `isolateNetwork`. */
  isolateNetworkFor?(settings: ProviderSettings): readonly string[];
  /**
   * The provider bound to a mount's settings and credential. Throws when the stored credential does not parse:
   * that is a broken mount, and the caller reports it rather than talking to the provider with nothing.
   *
   * `wake: false` for a caller that must never start a box (the workspace view): a box that is not running is
   * then refused rather than woken. Otherwise a provider that does not wake a box on use (InstaBox) wakes it
   * itself when a request finds it paused or stopped.
   */
  open(settings: ProviderSettings, credential: string, o?: { wake?: boolean }): SandboxProvider;
  /** Does this credential work, asked when a person pastes it (`Plugin.checkCredential`). */
  checkCredential(settings: ProviderSettings, credential: string): Promise<CredentialCheck>;
  /**
   * The account these keys act on, so a replaced key on the same account keeps the boxes (`Plugin.credentialAccount`).
   * Null when it cannot be told; throws when the provider did not answer, which is not "no account".
   */
  account(settings: ProviderSettings, credential: string): Promise<string | null>;
}

/**
 * What a provider can do, declared so the plugin can ask rather than assume. Every member has a reader in the plugin:
 * `pause` (which idle schedule a box is on), `snapshot` (whether `keep` may wake a box), `billing` (what the tools say
 * a box costs) and `boxSecrets` (whether accounts are wired). One is added with the code that reads it, never ahead
 * of it (test/sandbox-provider-caps.ts). Whether commands can reach the network is not one: it is `isolateNetwork`,
 * which the plugin applies to every command.
 */
export interface ProviderCaps {
  /** What switching an idle box off keeps: its memory (resumes where it was) or only its disk. */
  pause: "memory" | "disk";
  /** Whether a filesystem can be kept while the box runs, only once it is stopped, or not at all. */
  snapshot: "live" | "stopped" | null;
  /** What a box is billed for: every second it exists (run9), or compute only while running and storage otherwise. */
  billing: "exists" | "running";
  /**
   * Whether a credential can be registered for one box only, swapped in on its way out (`addSecret`). Without it
   * no account is wired into a container.
   */
  boxSecrets: boolean;
}

/** The mount settings an adapter reads; the plugin's config with its defaults filled in. */
export interface ProviderSettings {
  endpoint: string;
  project: string;
  /** The machine size, as `<vcpus>c<GiB>g`; absent: the provider's default. */
  shape?: string;
  /** InstaBox: the template a new box starts from. */
  template?: string;
  /** InstaBox: the image the box's commands run in, as a container inside the machine; empty or absent: none. */
  image?: string;
  /** InstaBox, with an image: the container's network, closed unless "open". */
  network?: string;
  /** InstaBox, with an image: the container's working directory. */
  workdir?: string;
  /** InstaBox: the server-side deletion every box is created with, in hours (at most 24, the API's limit). */
  maxLifetimeHours?: number;
  /** InstaBox: the longest a box runs without a pause, in minutes, enforced by InstaBox. */
  maxRunMinutes?: number;
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
  /** How long the provider asked to wait before asking again, when it said. */
  readonly retryAfterMs?: number;
  constructor(message: string, o: { code: ProviderErrorCode; definitive: boolean; status?: number; detail?: string; retryAfterMs?: number }) {
    super(message);
    this.code = o.code;
    this.definitive = o.definitive;
    if (o.status !== undefined) this.status = o.status;
    this.detail = o.detail ?? "";
    if (o.retryAfterMs !== undefined) this.retryAfterMs = o.retryAfterMs;
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
  /**
   * The plugin's name for the box, unique per creation. run9 takes it as the box's id; InstaBox mints its own id
   * and takes this as the machine's name and the create's idempotency key.
   */
  id: string;
  /** Labels the box carries at the provider (tenant, agent, mount, machine), by which it can be found again. */
  labels: Record<string, string>;
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
  /**
   * Creates the box: its id at the provider, which the plugin records, and when the provider will delete it on
   * its own, if it will. A box that already exists under this name is a `conflict`.
   */
  create(spec: BoxSpec): Promise<{ id: string; deleteAt?: number }>;
  /** After a create answered `conflict`: the id of the box this spec made, when one is there, else null. */
  adopt(spec: BoxSpec): Promise<string | null>;
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
  /** Pauses the box with its memory kept (`caps.pause` "memory"); absent where the provider cannot. */
  pause?(id: string): Promise<void>;
  /** Brings a paused or stopped box back; absent where the next request does that by itself (run9). */
  wake?(id: string): Promise<void>;
  /** Deletes the box: what actually frees it. */
  delete(id: string): Promise<void>;
  /** Keeps the box's filesystem under a new snapshot id; `caps.snapshot` says whether the box stays up. */
  snapshot(id: string, description: string): Promise<string>;
  /** Deletes a kept snapshot; absent where the plugin has never deleted one (run9). */
  deleteSnapshot?(snapId: string): Promise<void>;
  /** The boxes carrying every one of these labels: never the whole account. */
  list?(labels: Record<string, string>): Promise<Array<{ id: string; name: string; state: BoxState; labels: Record<string, string> }>>;
  /** What the provider metered for this box, where it meters one. */
  usage?(id: string): Promise<{ runningSeconds: number; vcpuSeconds: number; memGiBSeconds: number; diskGiBSeconds: number }>;
  /** Registered for this box alone (box scope), never for the project: see `listProjectSecrets`. */
  addSecret(id: string, secret: EgressSecret): Promise<void>;
  /** This box's registrations, as the provider lists them. Throws on any answer it cannot read as that list. */
  listSecrets(id: string): Promise<Array<{ name: unknown; id: unknown; placeholder?: unknown }>>;
  /**
   * The project's own registrations, which a provider may inject into boxes it labels without listing them on the
   * box (run9's project scope). Metadata only. Absent where the provider has none. Throws on an answer it cannot read.
   */
  listProjectSecrets?(): Promise<Array<{ name: unknown; id: unknown; placeholder: unknown; boxLabel: unknown; scope: unknown }>>;
  removeSecret(id: string, secretId: unknown): Promise<void>;
}
