import type { Json, MountPolicy, MountRecord } from "../core/types.ts";
import type { AnswerSpec } from "../core/execution.ts";

export interface ToolSchema {
  name: string;
  summary: string;
  parameters: Json;
  sideEffects: "read" | "write";
  /** Whether the plugin can make this call idempotent (§8.3). */
  idempotency: "native" | "key" | "none";
  /**
   * This tool can hand back a result the runtime parked because it was too big.
   *
   * Declared on the TOOL rather than on the plugin, because that is what it is
   * about: one tool reads a parked value, the rest of the mount does not. The
   * runtime used to find it by taking the plugin id `artifacts` and appending
   * `.read`, which meant the reader had to be that plugin and had to keep that
   * tool name; with this, an operator may mount it under any alias and a second
   * plugin may offer the same service.
   */
  reads?: "parked-result";
  /**
   * `"never"`: do not run this tool again on its own after an interruption,
   * whatever `sideEffects` and `idempotency` say.
   *
   * `sideEffects: "read"` normally means a repeat is harmless, and the runtime
   * replays reads freely (`replayPolicy`, src/runtime/pi-tools.ts). That rests
   * on whoever wrote the declaration being the one who knows. A tool whose
   * schema came from a remote server was declared by that server — its
   * `readOnlyHint` is a claim, not something this repository reviewed — so the
   * kernel sets this on every snapshot tool (`admitTools`) and the claim keeps
   * the read policy without earning a silent second run. Checked before
   * anything else wherever a replay is decided.
   */
  replay?: "never";
  /**
   * Only the model may call this tool. Refused with `not_from_a_program` on the
   * two roads that reach a plugin with no model reading the result:
   * - a run_js program's call, under any name the gateway resolves — its
   *   offered name, its address, or `plugin.tool` — refused by the gateway on
   *   `InvokeOpts.fromProgram` (`ToolGateway` `#invoke`), which run_js sets
   *   where the program cannot clear it (`runJsTool`, src/runtime/pi-tools.ts,
   *   which also answers an offered name early);
   * - a call held for approval, which would then run on its own: refused when
   *   it would be held (`#invoke`), and, for one held before, when approved
   *   (`ToolGateway.applyApproval`).
   *
   * For a tool whose result only counts once the model has read it. Raft's
   * `receive_events` is the case: the call acknowledges the previous batch and
   * records what it hands over as seen, which a later send attests. From a
   * program the batch goes to code the model may never print, so the model
   * would have acknowledged and attested messages it never saw — and skipped
   * the question a send asks when something new arrived, which is the model's
   * to answer (docs/ax-design.md §3, "Code cannot skip it"). Raft's
   * `read_messages` is the other: Raft marks what a history read returns as
   * read.
   *
   * Not a policy: an operator cannot allow it from code, because what it
   * protects is what the model saw, not what the operator permits.
   */
  modelOnly?: true;
}

/**
 * The tools one mount offers when its plugin cannot know them in advance: what
 * a remote server listed when the operator last asked, kept on the mount record.
 *
 * Stored, not fetched on demand, because the catalogue and the gateway read a
 * mount's tools on every harness build and every call, and neither may wait on
 * somebody else's server; a wake that reached the network to learn its own
 * tool list would also offer a different list each time the server moved.
 *
 * `tools` is already admitted: every name in it is addressable, so every
 * reader of {@link toolsOf} sees the same list. What was left out is in
 * `skipped`, with the reason, for the person reading the mount's page.
 *
 * `hash` covers `tools` and `skipped` and nothing else, so a refresh that finds
 * the same list changes nothing — not the record, and not the harness cache key.
 * It is not the version pin: `toolVersion` stays the plugin's version, which is
 * what the gateway compares and `repinMounts` rewrites.
 */
export interface ToolSnapshot {
  hash: string;
  tools: ToolSchema[];
  skipped: Array<{ name: string; reason: string }>;
  takenAt: number;
}

/**
 * What a plugin's `snapshotTools` lists, before the kernel admits it. Anything
 * the plugin itself chose to leave out goes in `skipped` with its reason.
 */
export interface ListedTools {
  tools: ToolSchema[];
  skipped?: Array<{ name: string; reason: string }>;
}

/**
 * A key in a plugin database: a string or a finite number, ordered the way
 * IndexedDB orders them — every number before every string, numbers by value,
 * strings by code unit. Arrays and dates are not keys here; the store is
 * SQLite, whose own ordering of numbers before text is what makes ranges over
 * mixed keys cost nothing to implement and impossible to get subtly wrong.
 */
export type DbKey = string | number;

/**
 * A range of keys, in `IDBKeyRange`'s vocabulary: build one with
 * {@link KeyRange}. `lower`/`upper` absent means unbounded on that side.
 */
export interface DbKeyRange {
  readonly lower?: DbKey;
  readonly upper?: DbKey;
  readonly lowerOpen: boolean;
  readonly upperOpen: boolean;
}

const keyOf = (k: DbKey, what: string): DbKey => {
  if (typeof k === "string" || (typeof k === "number" && Number.isFinite(k))) return k;
  throw new Error(`${what} must be a string or a finite number`);
};

/** `IDBKeyRange`'s four constructors, over {@link DbKey}. */
export const KeyRange = {
  bound(lower: DbKey, upper: DbKey, lowerOpen = false, upperOpen = false): DbKeyRange {
    return { lower: keyOf(lower, "range lower bound"), upper: keyOf(upper, "range upper bound"), lowerOpen, upperOpen };
  },
  lowerBound(lower: DbKey, open = false): DbKeyRange {
    return { lower: keyOf(lower, "range lower bound"), lowerOpen: open, upperOpen: false };
  },
  upperBound(upper: DbKey, open = false): DbKeyRange {
    return { upper: keyOf(upper, "range upper bound"), lowerOpen: false, upperOpen: open };
  },
  only(key: DbKey): DbKeyRange {
    const k = keyOf(key, "range key");
    return { lower: k, upper: k, lowerOpen: false, upperOpen: false };
  },
};

export type DbQuery = DbKey | DbKeyRange | null | undefined;

/**
 * The operations a plugin database offers, in idb's calling convention:
 * `get(store, key)`, `put(store, value, key?)`, `delete(store, key | range)`,
 * `getAll(store, query?, count?)`, `getAllFromIndex(store, index, query?,
 * count?)`, `count(store, query?)`. Reads come back `unknown`: data outlives
 * the code that wrote it, so no reader is promised a shape, and the reader
 * verifies (`asBoxState` in the sandbox plugin is the pattern). Values are
 * JSON; `put` refuses anything else. A store with a `keyPath` takes its key
 * from the value and refuses an explicit one; a store without one requires it.
 * `get` of a missing key is `undefined`, as in IndexedDB.
 *
 * The synchronous form is what a {@link PluginDatabase.transaction} callback
 * and an `upgrade` are handed: the same operations, answering directly. They
 * are synchronous because the database is SQLite inside the agent's own
 * object and a transaction is a lock held while the callback runs; an `await`
 * inside it would hold that lock across I/O nothing else could proceed past.
 * IndexedDB has the same rule in a less visible form — a transaction that is
 * awaited across anything but its own requests has already committed. The
 * rule is enforced, not only typed: a callback that returns a promise is
 * refused inside the transaction, so its synchronous writes roll back, and
 * a handle kept past its callback refuses every call. A transaction reaches
 * only the stores it named.
 */
export interface DbOperations {
  get(store: string, key: DbKey): unknown;
  put(store: string, value: Json, key?: DbKey): DbKey;
  delete(store: string, query: DbKey | DbKeyRange): void;
  getAll(store: string, query?: DbQuery, count?: number): unknown[];
  getAllFromIndex(store: string, index: string, query?: DbQuery, count?: number): unknown[];
  count(store: string, query?: DbQuery): number;
}

/**
 * What a plugin is handed as `ctx.db`: its own mount's database, declared in
 * {@link Plugin.database}, opened by the kernel. The plugin holds no database
 * name and no other path to storage, so it cannot name another mount's data;
 * the same plugin mounted twice is two databases.
 *
 * Every method is its own transaction. `transaction` runs a callback that
 * sees and changes the database atomically — read, decide, write — and undoes
 * everything if the callback throws. The callback is synchronous; the reason
 * is on {@link DbOperations}.
 */
export interface PluginDatabase {
  get(store: string, key: DbKey): Promise<unknown>;
  put(store: string, value: Json, key?: DbKey): Promise<DbKey>;
  delete(store: string, query: DbKey | DbKeyRange): Promise<void>;
  getAll(store: string, query?: DbQuery, count?: number): Promise<unknown[]>;
  getAllFromIndex(store: string, index: string, query?: DbQuery, count?: number): Promise<unknown[]>;
  count(store: string, query?: DbQuery): Promise<number>;
  transaction<T>(stores: string | readonly string[], mode: "readonly" | "readwrite", fn: (tx: DbOperations) => T): Promise<T>;
}

/** One object store of a plugin database; see {@link Plugin.database}. */
export interface DbStoreSpec {
  /**
   * Where the key lives inside each value (`"id"`, or a dotted path). Absent
   * means the caller supplies the key to `put`.
   */
  keyPath?: string;
  /**
   * Index name → key path inside the value. A value whose path is missing or
   * not a {@link DbKey} is stored but not indexed, as IndexedDB does. One
   * index per store in this version: an implementation limit, not a rule of
   * the shape.
   */
  indexes?: Record<string, string>;
  /**
   * Keys whose NAME may be shown outside the object, meaning "this exists":
   * a diagnosis lists them with whether they are present. Never their values,
   * and never to the model. Keys not named here are private; a store that
   * omits this lists no key. What is always shown, `listed` or not, is the
   * store's name, how many keys it holds and when one last changed — the
   * operator's storage page reads those counts from the rows directly.
   */
  listed?: readonly DbKey[];
}

/**
 * The database a plugin keeps per mount. Declared here, statically, rather than
 * opened in a call the way idb's `openDB` is — the one place this contract
 * departs from idb's calling convention. Two readers need the declaration
 * without running the plugin: the check that no credential-class key name is
 * `listed` (test/plugin-db.ts), and a diagnosis, which lists what exists. And
 * an upgrade needs one definite moment: the kernel runs `upgrade` once, before
 * this mount's first use of the database in a call, never "whichever tool
 * call arrives first".
 *
 * The database is stored with the id of the plugin that owns it. Opened under
 * another plugin id it is an empty database, and old rows are never handed
 * over: isolation does not rest on "a mount alias is never re-pointed", which
 * nothing guarantees.
 *
 * The version is stored with the rows, in the same transaction as the upgrade
 * that produced it, so `oldVersion` is read, never guessed; a fresh database
 * sees `oldVersion` 0, as in IndexedDB, which is where a plugin seeds. An
 * `upgrade` that throws advances nothing: this use is refused with the reason,
 * and the next use runs `upgrade` again — so it must be re-runnable, and its
 * changes land with the version, all or nothing, or half-migrated rows would
 * read as the new version. A stored version HIGHER than the declared one (a
 * rollback) opens normally, runs no `upgrade`, and is never lowered: lowering
 * would re-run the migration when the newer code returns. Old code reads new
 * data because reads are `unknown` and the reader verifies.
 */
export interface DbSpec {
  /** Bumped when `stores` or the shape of stored values changes; `upgrade` sees the version the data was written under. */
  version: number;
  stores: Record<string, DbStoreSpec>;
  /** Runs once, inside the transaction that records `version`, when the stored version is lower. */
  upgrade?(db: DbOperations, oldVersion: number): void;
}

export interface PluginContext {
  /** Read-only identity of the caller. Plugins cannot use it to escalate. */
  caller: {
    tenantId: string;
    agentId: string;
    taskId: string;
    /**
     * Present, and true, exactly when this call came from a run_js program rather than from the model's own tool
     * call: set from `InvokeOpts.fromProgram`, which run_js sets after the program's options so a program cannot
     * clear it. Absent for the model's calls, an approved call's replay, provisioning and bench shells. A tool a
     * program must never reach declares `ToolSchema.modelOnly` instead; this is for a tool that may run from a
     * program but has to treat the result as not yet seen by the model.
     */
    fromProgram?: true;
    /**
     * An opaque id for the model's current context window in this agent's session: the same on every call while
     * what the model read earlier in the session is still in its context, and different after a new session, a
     * reset or a compaction. Never per turn, and recomputed from durable state, so a restart does not move it.
     * Absent when the call is not made in a session's turn (an approved call's replay, provisioning, a bench shell,
     * a background job's poll). Compare it for equality only: how it is made is not part of the contract
     * (src/runtime/context-id.ts). It can change when nothing was lost; it does not stay when something was.
     */
    contextId?: string;
  };
  /**
   * The name this mount was given, which is the only name the model knows.
   *
   * The harness dispatches on `<alias>.<tool>`, and the alias is the operator's
   * to choose — so a plugin that writes "delete something with state.forget"
   * into an error or a prompt is naming a tool nobody promised it. Supplied
   * here because the gateway is the only place that knows it: `sibling(alias)`
   * already hands a plugin another mount's name, and this is its own.
   */
  alias: string;
  /** Resolved server-side; the agent never sees the credential itself. */
  credential: string | null;
  /**
   * What kind of credential this mount names — never which one, and never its
   * value. `"none"` means it names none.
   *
   * The reason a plugin needs it: `credential` is null for several different
   * reasons, and they are fixed by different people. The mount names nothing,
   * so its owner attaches an account. It names `agent:<name>` and that row is
   * gone (`agentSecrets` answers a missing row with `return null`), so whoever
   * holds that credential writes it again. It names `operator:` or `env:` and
   * this deployment does not hold it, so whoever deploys configures it — which
   * is the state of every operator-referencing mount on a preview Worker today.
   * All three arrive as the same null, so a plugin holding only `credential`
   * that says "this mount has no account" is guessing, and the advice that
   * follows the guess sends the wrong person to fix it.
   *
   * The kind rather than the reference, because the reference is a name with
   * structure: `src/store/refs.ts` exists because raw references named the
   * bucket, the tenant and the agent in every result that carried one. A plugin
   * writes its state into messages a model reads, so it is handed the one part
   * that changes what to do and nothing that identifies where the agent lives.
   * `secretRefKind` in `src/runtime/secrets.ts` computes it and inspects only
   * the prefix; `test/mount-config.ts` pins the two lists together.
   *
   * Optional because absent has to keep meaning "not reported": a caller that
   * does not supply it must not be read as saying no credential is named.
   */
  credentialRefKind?: CredentialRefKind;
  publicConfig: Record<string, Json>;
  /**
   * This mount's database, as declared in {@link Plugin.database}. Survives
   * across calls and across executions; never reaches the model. A plugin that
   * declares no database is refused on every call.
   */
  db: PluginDatabase;
  /**
   * This mount's inbound hooks. Present only for a plugin that implements
   * `receive`, on a deployment that can take pushed events.
   *
   * Rules for a plugin using them (from the #388 review):
   * - **The secret and the URL never go into a tool result or an error**:
   *   what `invoke` returns lands in the transcript. The secret is handed to
   *   the service and nowhere else, `ctx.db` included.
   * - **Keep the live `hookId` in `ctx.db`**, and revoke the previous
   *   one once a new one is registered: every `create()` is another address
   *   that stays valid until something revokes it, and only the plugin knows it.
   * - **If registering with the service definitely fails, revoke the new hook.**
   * - **A tool that calls `create()` is not natively idempotent**: a replay
   *   makes another hook. Declare it `idempotency: "none"` or key it yourself.
   * - **A mount holds at most `INBOUND_HOOKS_PER_MOUNT` live hooks**; `create()`
   *   past that is refused, so a leak stops at a few addresses.
   */
  inbound?: InboundHooks;
  /**
   * Another mount of the same agent, by alias.
   *
   * Some actions genuinely need two connected accounts — "file this receipt
   * into my drive" touches the store and the drive. Without this the plugin
   * would have to ask the model for the second credential, which is the leak
   * config-time binding exists to prevent. Scoped to this agent's own mounts,
   * so it grants nothing the agent was not already configured to use.
   */
  sibling(alias: string): Promise<{
    credential: string | null;
    /** As on this mount: what kind of credential that mount names, so a null
     *  one can be reported as unreadable rather than absent. */
    credentialRefKind?: CredentialRefKind;
    /** That mount's database, opened under that mount's plugin. */
    db: PluginDatabase;
    /**
     * Which plugin that mount is. A credential is only meaningful to the service
     * it was issued for, so a plugin that hands one to a particular host checks
     * this rather than trusting that an alias still names what it used to.
     */
    plugin: string;
    /**
     * That mount's policy. The gateway enforces it on calls that pass through
     * the gateway; a plugin that lets something act for that mount by another
     * route has to honour it itself, or the route skips it.
     */
    policy: MountPolicy | null;
  } | null>;
  /**
   * This agent's mounts whose plugin declares a {@link SandboxForm}, with each
   * one's credential, for the plugin that runs the agent's container.
   *
   * Found by the declaration, never by a plugin's name or an alias: which
   * services a container can act as is decided by what is mounted, and a new
   * plugin that declares a form is wired in with no change to the container.
   * Switched-off plugins are left out. Grants nothing `sibling` does not.
   */
  sandboxForms(): Promise<Array<{
    alias: string; plugin: string; form: SandboxForm; credential: string | null;
    /**
     * Record that the credential was put to work. Reading it here records
     * nothing, because the container re-reads before every command only to
     * notice a change; call this when it is registered with a container, so
     * the mount's "last used" still means used.
     */
    used(): Promise<void>;
  }>>;
  /**
   * A secret the agent kept itself (`secret_put`), by the name it chose; null
   * when there is none. Never a mount's credential or a hook's secret: only the
   * agent's own rows are reachable this way.
   *
   * For a plugin that uses a secret where the agent directs, so the model can
   * name it instead of reading it into the conversation. The value goes where
   * the call says and nowhere else: not into a result, an error, or `ctx.db`.
   */
  agentSecret(name: string): Promise<string | null>;
  /**
   * A secret the agent's owner kept from the console (`/ui/secret`), by name;
   * null when there is none. The model can neither read nor change these
   * through its tools. What the far end sends back is another matter: a plugin
   * using one masks it in everything it returns (`hideSecrets`, verbatim only),
   * so a server that echoes it encoded still shows it to the model.
   *
   * Only for a value sent where the mount's own settings say — the mount's
   * server, in a header its settings name — and never where a tool call's
   * arguments say: a plugin that let the agent choose the destination would
   * hand the agent an owner's credential to send anywhere, which is the one
   * thing keeping these apart from `agentSecret` exists to prevent. As with
   * `agentSecret`, the value goes nowhere else: not into a result, an error,
   * or `ctx.db`.
   *
   * Absent where a context has no owner secrets to offer (a credential check,
   * a diagnosis), and for every plugin that does not declare
   * {@link Plugin.readsOwnerSecrets}; a plugin reads its absence as "none".
   */
  ownerSecret?(name: string): Promise<string | null>;
}

/**
 * Which identity a call was made with, as the plugin is able to know it.
 *
 * - **`attached`** — a credential reached this call, so whatever the service
 *   answered is about that account, not about a missing one.
 * - **`none`** — the mount names no credential. Anonymous on purpose; a person
 *   attaches one.
 * - **`unreadable`** — the mount names a credential and it did not arrive. Also
 *   anonymous, but nothing is missing from the mount: the secret behind the
 *   reference has to be written again, and attaching a second token fixes
 *   nothing.
 * - **`unreported`** — the caller did not say whether one is named, so the two
 *   anonymous cases cannot be told apart here. A plugin must not resolve this
 *   to either one; say both are possible, or say nothing.
 *
 * Why a plugin should reach for this rather than `credential` alone: the two
 * anonymous cases produce the same failure from the service, so a message that
 * names one of them guesses — and a guess written as a fact is how a person
 * spends an afternoon attaching a token to a mount that already has one
 * (read from a production trajectory, 2026-09-20).
 */
export type CredentialState = "attached" | "none" | "unreadable" | "unreported";

/**
 * Whose credential a reference names, never which one. The same five values
 * `secretRefKind` returns, declared here because the contract cannot depend on
 * the runtime that fills it; `test/mount-config.ts` fails if the two drift.
 */
export type CredentialRefKind = "none" | "agent" | "operator" | "env" | "other";

export function credentialState(
  ctx: Pick<PluginContext, "credential" | "credentialRefKind">,
): CredentialState {
  if (ctx.credential) return "attached";
  if (ctx.credentialRefKind === undefined) return "unreported";
  return ctx.credentialRefKind === "none" ? "none" : "unreadable";
}

/**
 * The state as a clause a person can act on, so two plugins do not invent two
 * sentences for one state — and the identity belongs on the failed CALL
 * rather than on the mount, since that is what a reader of a failure is
 * holding.
 *
 * **One wording per state, per layer — and where a second surface needs its
 * own, pin them on the ACTION rather than the words.** Two copies of one
 * sentence are not a duplication a reader notices: each reads as complete, and
 * nothing depends on the other for a test to fail, so one improves and the
 * other keeps the old text silently. But sharing is not automatically the
 * repair. A console change in review when this was written (#445) carried its
 * own text for all four states; the `none` one had been a word-for-word copy,
 * and that was the defect — while its `attached` one carried a clause these
 * sentences do not, because a badge someone glances at and a sentence in a
 * failure are not the same job. Forcing one string on both would have cost the
 * badge that clause or stretched this one to fit a tooltip. The reason
 * underneath: identity crosses to a page as a FIELD — `identity`,
 * `credentialRef` — precisely so a page never has to read or reproduce this
 * prose. So what is pinned there is that both name the same action (`attach` · `write it again` · `whoever deploys`), with
 * literal copying refused — which makes "just share the string" fail the check rather than pass
 * it. **The action pattern has to match the action, not either side's current
 * phrasing**, or the refusal never runs: @Nova first matched on their own
 * wording, @Vera planted a verbatim copy of these sentences, and it went red
 * saying "the card does not name the action" — of a sentence that names it
 * plainly. The copy had tripped the phrasing check first, so the assertion
 * written for copies was never asked. **And "matches the action" means matches
 * the RECOMMENDATION of it**: `/attach/` was loose enough to pass
 * "attaching is not possible", so an assertion whose whole job is to say which
 * advice was given accepted the opposite advice — @Vera planted exactly that
 * sentence and the suites stayed green, which is what sent the pattern to the
 * recommending forms. A pattern wide enough to
 * survive a rewording is also wide enough to swallow its own negation — the
 * two pressures pull opposite ways, and only the second one fails quietly.
 *
 * A clause about the mount rather than a whole sentence about the call: the
 * caller frames it, because "this call was anonymous" belongs in a failure and
 * not in the answer to "who am I here?". Each state ends with the action it
 * implies, and `none` and `unreadable` imply opposite ones — attach an account,
 * versus write the credential of the account already attached.
 */
export function identityNote(ctx: Pick<PluginContext, "credential" | "credentialRefKind" | "alias">): string {
  const mount = `the \`${ctx.alias}\` mount`;
  switch (credentialState(ctx)) {
    case "attached":
      // Passive, so the one clause reads inside a failure, a refusal and an
      // answer to "who am I here?" without three wordings of one fact.
      return `${mount}'s account was used`;
    case "none":
      return `${mount} has no account attached, and a person can attach one`;
    case "unreadable":
      // Nothing is missing from the mount here, so "attach an account" is the
      // one piece of advice that must not appear. Who to send instead depends
      // on whose credential it is, which is what the kind says.
      return ctx.credentialRefKind === "operator" || ctx.credentialRefKind === "env"
        ? `${mount} names a credential this deployment holds for everyone, and this deployment does not` +
          ` have it, so whoever deploys has to configure it there, and attaching an account to the mount will not fix it`
        : `${mount} names an account whose credential could not be read, so whoever holds that credential` +
          ` has to write it again rather than another account being attached`;
    case "unreported":
      // Says both, and still names an action: a state nobody reported is not a
      // reason to leave the reader with nothing to do.
      return `either ${mount} has no account, or the credential it names could not be read, and a person` +
        ` has to look at the mount to tell which`;
  }
}

/**
 * What a plugin may attach to an `Error` it throws, for the layers above it.
 *
 * A sentence is for a person; a field is for a page. The console renders stored
 * events, so a badge it draws by matching prose is one rewording away from
 * showing the wrong thing with no way for the reader to notice — the failure
 * mode of measuring a page with a remembered phrase, which cost a wrong reading
 * the same morning this was written. So the state travels as
 * data beside the message, and the message stays the wording.
 *
 * The gateway copies these into the failure it records (`ToolError` in
 * `src/core/tools.ts`, which has to declare them to receive them); a field it
 * does not copy is simply absent, and absent is a state readers already handle.
 */
export interface PluginErrorFields {
  /**
   * Which identity the call was made with. Same value as `credentialState`, so
   * a reader badging a failure does not derive it from the sentence.
   */
  identity?: CredentialState;
  /** Whose credential the mount names, which is who can fix an unreadable one. */
  credentialRef?: CredentialRefKind;
  /**
   * Trying the same call again may succeed on its own: a 429, an exhausted rate
   * limit that resets, a 5xx. A property of the error.
   *
   * Says nothing about whether the last attempt took effect — that is the other
   * question, and a 5xx answers yes to both.
   */
  transient?: boolean;
  /**
   * The last attempt may already have taken effect, and nobody can say: a 5xx,
   * a connection that failed before any response, an acknowledgement that was
   * lost. A state of the world rather than a property of the error.
   *
   * What follows is not "do not retry" but "a blind retry can repeat a side
   * effect", so what it needs is an idempotency key or a read that checks
   * first. This is the question an operation's `unknown` status is about.
   *
   * **Set it only when it is true.** An explicit `false` is a claim that
   * nothing landed, and it also defeats a consumer reading
   * `mayHaveLanded ?? retryable` during the transition below: `false ?? x` is
   * `false`, so a site that wrote `false` where it means "not reported" would
   * silently change what the gateway records.
   */
  mayHaveLanded?: boolean;
  /**
   * The single flag the two above replace, kept because `gateway.ts` still
   * reads it. Set it exactly where it was set before, so declaring the two
   * changes nothing until its consumer moves.
   *
   * It could not keep both meanings: `github.ts` sets it for a 429 and for a
   * 5xx, `appworld.ts` sets it for a 5xx with the comment "5xx may have
   * landed", and `raft.ts` sets it for an uncertain delivery with the comment
   * "It does not mean callers may retry". One boolean, three answers to two
   * different questions, and the consumer reads only the second question
   * (@Vera's count, 2026-09-20).
   */
  retryable?: boolean;
}

/**
 * An error carrying them, which is what every plugin throws.
 *
 * Not `ToolError`: that name is taken by the *recorded* failure in
 * `src/core/tools.ts` — `{ code, message, … }`, what the gateway hands back and
 * a page reads. This is the thrown side. Naming both of them `ToolError` is the
 * defect this whole line of work is about, one directory apart, and it cost a
 * typecheck to notice.
 */
export type PluginError = Error & PluginErrorFields;

/**
 * Stamp the identity a call was made with onto the error it failed with.
 *
 * Returns the same error, so it reads at the throw site: the fields and the
 * sentence are set in one place and cannot describe different states.
 */
export function markIdentity<E extends Error>(
  error: E, ctx: Pick<PluginContext, "credential" | "credentialRefKind">,
): E & PluginErrorFields {
  const marked = error as E & PluginErrorFields;
  marked.identity = credentialState(ctx);
  if (ctx.credentialRefKind !== undefined) marked.credentialRef = ctx.credentialRefKind;
  return marked;
}

/**
 * Reading the capability groups.
 *
 * Kept as three functions after the flat members are gone, rather than every
 * consumer writing `plugin.holds` itself, for the reason they existed in the
 * first place: they are the one place the question is asked, so the next change
 * to what "holds something" means has one edit and not nine.
 *
 * `isExclusive` is the one that is a derivation rather than an accessor:
 * holding something IS the reason to serialise calls on a mount, so the answer
 * comes from `holds` and there is no second field that could disagree with it.
 */
export function holdingOf(p: Pick<Plugin, "holds">): Holding | null {
  return p.holds ?? null;
}

export function backgroundOf(p: Pick<Plugin, "background">): Backgrounding | null {
  return p.background ?? null;
}

export function interruptsOf(p: Pick<Plugin, "interrupts">): Interrupting | null {
  return p.interrupts ?? null;
}

export function isExclusive(p: Pick<Plugin, "holds">): boolean {
  return !!p.holds;
}

/**
 * Whether one call reads or writes, for choosing a mount policy's half. The
 * declared `sideEffects` is the ceiling: a declared read is a read, and the
 * plugin's {@link Plugin.classify} is not asked; a declared write is lowered to
 * a read only when `classify` answers exactly "read", and stays a write for
 * anything else — `undefined`, another value, a throw, or a `classify` that
 * throws on being read. One function, so the rule is stated once.
 */
export function callSideEffects(
  p: Pick<Plugin, "classify">, tool: string, args: Json, declared: "read" | "write",
): "read" | "write" {
  if (declared === "read") return "read";
  try {
    const classify = p.classify;
    if (!classify) return "write";
    return classify.call(p, tool, args) === "read" ? "read" : "write";
  } catch {
    return "write";
  }
}

/**
 * The tools one mount offers: the plugin's answer for that mount when it gives
 * one, its static list otherwise.
 *
 * Every reader that is about a specific mount asks this rather than reading
 * `plugin.tools`, because for a plugin whose tools come from a remote server
 * the static list is empty and only the mount knows. A reader that asked
 * `plugin.tools` would offer nothing or refuse everything for such a mount,
 * and two readers that asked differently would disagree about one name — the
 * catalogue offering a tool the gateway calls unknown.
 */
export function toolsOf(p: Pick<Plugin, "tools" | "mountTools">, mount: MountRecord): ToolSchema[] {
  return p.mountTools?.(mount) ?? p.tools;
}

/** The most live hooks one mount may hold; see `InboundHooks`. */
export const INBOUND_HOOKS_PER_MOUNT = 3;

/**
 * A mount's own inbound hooks: public URLs a service pushes events to (see
 * `Plugin.receive`). Offered only to a plugin that can receive, and only for
 * the mount being called, so a plugin can register its hook with the service
 * itself using the mount's own account, the way a GitHub webhook is set up
 * (the case was Raft push).
 */
export interface InboundHooks {
  /**
   * A new hook for this mount. The secret is generated here, sealed in the
   * agent's store, and returned this once: the plugin hands it to the service
   * and keeps no copy. Refused while the mount cannot take events.
   */
  create(): Promise<{ hookId: string; url: string; secret: string }>;
  /** Revoke one of this mount's hooks, secret included. Whether it was live; another mount's hook is never touched. */
  revoke(hookId: string): Promise<boolean>;
}

/**
 * One thing a person may set when mounting this plugin.
 *
 * Flat on purpose. A mount's `publicConfig` is key and value, and describing it
 * with a full JSON Schema would be describing a shape it cannot have. What this
 * buys is that a console can render the settings, and that a typo is refused
 * when the mount is created rather than surfacing as a strange failure on the
 * first call.
 */
export interface ConfigField {
  name: string;
  type: "string" | "number" | "boolean" | "string[]";
  /** What it does, for someone who has never read the plugin. */
  summary: string;
  default?: Json;
  required?: boolean;
  /**
   * Required only once the mount carries a credential.
   *
   * Some settings are advice on an anonymous mount and a boundary on one
   * holding a key. `http`'s `allowedHosts` is the case this exists for: for
   * every other credential plugin the host is fixed by the plugin, while there
   * the *agent* chooses the URL, so an unset allowlist means a key that travels
   * wherever the agent points it. Declaring it here makes the difference a rule
   * the validator applies rather than a hazard the next person inherits.
   *
   * For a `string[]` an empty list counts as unset for this purpose: it is not
   * a boundary anyone chose, and a mount that can reach nothing cannot be what
   * was meant.
   */
  requiredWithCredential?: boolean;
  /** When the value is one of a fixed set. */
  choices?: string[];
  /**
   * Say so when a setting's vocabulary is about credentials while its values
   * are not one.
   *
   * A setting is public by definition — rendered in the console and handed to
   * the agent by the builtin `tools.mounts` — so a credential *value* in one is
   * always a mistake, and there is deliberately no way to declare that it is
   * intended. run9's `secrets` is the legitimate case: it names which secrets
   * to inject, and the values come from the mount's credential. This marker is
   * how such a field says it names rather than holds, and the mount tests
   * refuse a credential-shaped name that does not carry it.
   */
  references?: "credential";
  /** For a `number`: the smallest and largest value a mount may set, checked when the mount is written. */
  min?: number;
  max?: number;
  /**
   * What a `string` value has to look like, checked when the mount is written.
   *
   * `"origin"` is where a plugin sends its credential: an absolute `https:`
   * origin — scheme, host and optional port, with no credentials, path, query
   * or fragment — or `http:` to a loopback host, for a server on the same
   * machine. Without it a setting like `https://api.example.com/x` was accepted
   * at mount time and refused only when an agent called something, where no
   * person is reading — seen on the raft plugin's `serverUrl`, 2026-09-17.
   *
   * The plugin should read the value through the same `originProblem` at call
   * time too, so the two checks cannot disagree.
   *
   * `"header-lines"` is for a `string[]` of HTTP headers the plugin sends on
   * the mount's behalf, one `"Name: value"` per entry; see
   * `headerLinesProblem`, which the plugin reads the value through too.
   */
  format?: "origin" | "header-lines";
}

/**
 * Headers the client writes itself: HTTP framing, and the Streamable HTTP
 * session headers. A mount that set one would be overwritten or would break the
 * protocol underneath — a session id set here resumes nothing, since an MCP
 * client initializes on every connection regardless.
 */
const CLIENT_HEADER = /^(accept|content-type|content-length|host|mcp-session-id|mcp-protocol-version|last-event-id)$/i;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
/** `{{name}}`: a slot filled from a secret the agent kept, at the moment of the request. */
const SECRET_SLOT = /\{\{[^}]*\}\}/;
/** Header names whose value is a credential by convention. */
const CREDENTIAL_HEADER = /^(authorization|proxy-authorization|cookie|x-api-key|api-key|x-auth-token)$/i;
/** A value written as an HTTP auth scheme followed by a token. */
const AUTH_SCHEME_VALUE = /^(bearer|basic|token)\s+\S/i;

/**
 * `"Name: value"` lines as pairs, or why one is not acceptable. One function
 * for the mount-time check (`format: "header-lines"`) and the plugin's own.
 *
 * A setting is public — shown in the console and handed to the agent by
 * `tools.mounts` — so a credential written into one is published. The rule is
 * deliberately narrow, so it refuses what is certainly a key and nothing
 * else: a value with **no** `{{name}}` in it is refused when its header is one
 * that carries a credential by convention (`Authorization`,
 * `Proxy-Authorization`, `Cookie`, `X-Api-Key`, `Api-Key`, `X-Auth-Token`), or
 * when the value itself reads as an auth scheme and a token (`Bearer …`,
 * `Basic …`, `Token …`) under any header name. A value with a slot in it is
 * accepted as written: `Bearer {{key}}` is the form this is steering toward.
 * A key under an unconventional name with no scheme word is not recognised;
 * nothing here can tell it from an ordinary value.
 */
export function headerLines(lines: unknown): { ok: true; headers: Array<[string, string]> } | { ok: false; error: string } {
  if (lines === undefined || lines === null) return { ok: true, headers: [] };
  if (!Array.isArray(lines)) return { ok: false, error: "headers must be a list of \"Name: value\" lines" };
  const out: Array<[string, string]> = [];
  for (const line of lines) {
    const text = String(line);
    const at = text.indexOf(":");
    const name = at > 0 ? text.slice(0, at).trim() : "";
    if (!HEADER_NAME.test(name)) return { ok: false, error: `header "${text.slice(0, 40)}" is not "Name: value"` };
    if (CLIENT_HEADER.test(name)) return { ok: false, error: `header ${name} is written by the client itself and cannot be set` };
    const value = text.slice(at + 1).trim();
    if (!SECRET_SLOT.test(value) && (CREDENTIAL_HEADER.test(name) || AUTH_SCHEME_VALUE.test(value))) {
      return {
        ok: false,
        error: `header ${name} carries a credential written out, and settings are public; keep the value as a secret ` +
          `(secret_put) and write its name instead, such as "${name}: ${/authorization$/i.test(name) ? "Bearer {{name}}" : "{{name}}"}"`,
      };
    }
    out.push([name, value]);
  }
  return { ok: true, headers: out };
}

/** Why a `"header-lines"` value is not acceptable, or null. */
export function headerLinesProblem(lines: unknown): string | null {
  const r = headerLines(lines);
  return r.ok ? null : r.error;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Why `value` is not an origin in the sense of `ConfigField.format`, or null
 * if it is. One function for the mount-time check and the plugin's own, so a
 * value the console accepted is a value the plugin can use.
 */
export function originProblem(value: string): string | null {
  let url: URL;
  try { url = new URL(value); }
  catch { return "must be an absolute URL such as https://api.example.com"; }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) {
    return "must be https (http only for localhost)";
  }
  if (url.username || url.password) return "must not carry a user name or password";
  if (url.pathname !== "/" || url.search || url.hash || /[?#]/.test(value)) {
    return `must be an origin with no path, query or fragment, such as ${url.origin}`;
  }
  // Written exactly as the origin, so a plugin that pastes the string into a
  // URL gets what one that parses it gets: `https:x.test`, a trailing space,
  // `/.` or `:443` all parse to the right place and read as something else.
  if (value !== url.origin && value !== `${url.origin}/`) return `must be written as ${url.origin}`;
  return null;
}

/**
 * One value that makes up a credential.
 *
 * A list of key names is enough for a plugin, which parses them and needs
 * nothing else. It is not enough for a page that has to ask a person for them:
 * it can draw the boxes and has nothing to label them with but the key.
 *
 * `secret` is the part worth being explicit about. Not every value in a
 * credential is a secret — an account or a project id is an identifier — and
 * rendering one as dots makes it unverifiable at exactly the moment someone is
 * checking they pasted the right thing.
 */
export interface CredentialField {
  /** Key in the JSON object the secret resolves to. */
  name: string;
  /** What to paste, for someone who has never read the plugin. */
  summary: string;
  /** Default true. False for an identifier, which may be shown in clear. */
  secret?: boolean;
  /** Default true. False when the plugin works without this one. */
  required?: boolean;
}

/**
 * What a plugin can say about a credential it has just been handed.
 *
 * A failure says which of two things happened, because they are not the same
 * news for the person who just pasted a key:
 *
 * - **`rejected`** — a definitive negative. Somebody answered, and the answer
 *   was no: the key is wrong, or the account it names cannot do this. Storing
 *   it would store something known not to work.
 * - **`unreachable`** — no answer at all. A timeout, a refused connection, a
 *   provider returning 500. The key is not the suspect, and refusing it tells
 *   a person their key is bad when what is bad is the weather.
 *
 * Required rather than optional. An absent field defaulting to "rejected"
 * would make the dangerous reading the silent one, which is the mistake
 * `secret` and `accountRequired` were each fixed for.
 */
export type CredentialCheck =
  | { ok: true; account?: string }
  | { ok: false; kind: "rejected" | "unreachable"; reason: string };

/**
 * A credential nobody can paste.
 *
 * OAuth is a flow rather than a value: the person is sent to the provider,
 * consents, and the provider calls back with a short-lived access token and a
 * refresh token. The refresh then happens server-side, later, with nobody
 * present — so what is kept is a grant that changes over time, not something
 * someone typed. Asking a person to paste one is asking them to do the
 * provider's job, and what they paste stops working within the hour.
 *
 * **Declared, not implemented.** Nothing reads this yet and no plugin declares
 * it. It exists so that a page built from these declarations has a way to know
 * the difference: it can show "Connect with GitHub", disabled, instead of a
 * text box that produces a mount which dies in an hour. Without it every
 * plugin looks like a paste, and the page carries that assumption silently.
 *
 * When the flow is built, what it needs — the authorization and token
 * endpoints, the scopes — belongs here, beside the name of the thing being
 * connected.
 */
export interface SignIn {
  /** The account being connected, as a person would name it: "GitHub". */
  provider: string;
  /** What consenting will grant, in words someone can weigh. */
  grants?: string;
}

/**
 * The credential a mount of this plugin needs, if it needs one.
 *
 * Declared rather than discovered. Without this, a mount with no `secret_ref`
 * looks identical to a correctly configured one until the agent calls something
 * and gets a 401 it cannot act on — and a person reading the console cannot
 * tell which mounts are actually connected.
 *
 * The value itself never appears here or anywhere near the model. This says
 * what to put in the secret store and what having it buys; the reference is
 * dereferenced server-side at dispatch.
 */
export interface CredentialSpec {
  /** False when the plugin still works without one, in a reduced form. */
  required: boolean;
  /** What to store, in words someone can act on. */
  summary: string;
  /**
   * A bare token, a JSON object carrying these fields, or a sign-in completed
   * at the provider rather than typed here.
   */
  shape: "token" | { keys: CredentialField[] } | { signIn: SignIn };
  /** What an account can do here that an anonymous mount cannot. */
  grants?: string;
  /** Where to get one. */
  docs?: string;
  /**
   * What this credential looks like when someone pastes it where it does not
   * belong, so a message carrying one can be stopped before an agent reads it
   * and the person sent to this plugin's form instead (task #19). Patterns are
   * strings because the declaration travels to the console as JSON. Declare
   * only shapes that are recognisable: a bare run of letters and digits matches
   * every hash, and a guess that fires on ordinary text teaches people to
   * click past it.
   */
  looksLike?: Array<{ kind: string; pattern: string }>;
}

/**
 * What a page has to put in front of a person, for one plugin.
 *
 * There are three credential shapes and only two of them have fields, so every
 * reader has to ask which it is holding. `shape.keys` on a sign-in is a
 * `TypeError`, and the first place that would happen is the form someone uses
 * to connect an account — the worst place to find out. So the shape is read
 * once, here, and a caller switches on `kind` instead of narrowing a union it
 * has to remember the members of.
 *
 * A bare token comes back as a single field rather than as its own case: it is
 * one box with a label, which is what `keys` already describes, and a page that
 * special-cases it grows two code paths for one question.
 *
 * `accountRequired` is deliberately not called `required`, because a caller sees
 * it beside `CredentialField.required` and the two answer different questions:
 * whether this mount needs an account at all, and whether one box of a
 * credential the person has chosen to give may be left empty. `github` is the
 * case that separates them — it reads public repositories with no account, so
 * the mount is optional while the token, if given, is a token. A form that took
 * the field's answer for the mount's would mark the box mandatory on a mount
 * documented as optional. "Account" is the word the console already uses for
 * the mount-level question, in the "account required" / "account optional" tag.
 */
export type CredentialForm =
  /** The plugin never uses a credential. Ask for nothing. */
  | { kind: "none" }
  /** Ask for these, in this order. */
  | { kind: "fields"; fields: CredentialField[]; accountRequired: boolean }
  /** Nothing to type: send the person to the provider. */
  | { kind: "signIn"; signIn: SignIn; accountRequired: boolean };

/**
 * A field with its defaults filled in, because "absent means true" is a rule a
 * caller has to know and `undefined` is falsy.
 *
 * `secret` is the one that matters. It defaults to true — most of a credential
 * is secret — but a page writing the obvious `if (field.secret) mask()` against
 * an unset value shows the input in clear, and the values that ship unset today
 * are run9's secret key and AppWorld's password. The declaration was right and
 * the reading of it was a plaintext password on screen, so the default is
 * resolved here rather than left for every caller to remember.
 *
 * Stated the safe way round: only an explicit `secret: false` reveals a field.
 */
const resolved = (f: CredentialField): CredentialField => ({
  ...f,
  secret: f.secret !== false,
  required: f.required !== false,
});

/**
 * What one agent has said about one plugin.
 *
 * `"inherit"` and "no record at all" are the same answer and both are spelled
 * out: the console needs a value it can put on a control, and the store has
 * nothing to write for a preference that was never expressed.
 */
/**
 * What anything asking "is this mount busy?" needs to know, and nothing more.
 *
 * A rename moves a mount's rows; the console draws a panel; the idle sweep
 * decides whether to ask. All three want the same fact and none of them should
 * learn a plugin's private state to get it — the console knowing run9 keeps
 * `boxId` and `sessions` is the coupling this shape exists to end. It is
 * deliberately the smallest thing the callers share, so `meter()` can return it
 * later without any of them changing.
 */
export interface MountActivity {
  /** What this mount is keeping alive at a cost, or null when nothing. */
  live: {
    id: string;
    startedAt: number;
    lastUsedAt: number;
    /**
     * This thing's own idle schedule, where it differs from the deployment's
     * (src/runtime/idle-lease.ts `scheduleOf`). Absent: the deployment's
     * numbers and its generic warning.
     *
     * Per thing rather than per plugin because what `holds.release` does can
     * depend on the state the thing is in: a step that loses nothing needs no
     * warning (`warnMs: 0`), and a final one may need a longer wait and its
     * own words for what will be lost. The framework keeps the schedule; the
     * plugin only says which numbers and sentences apply now.
     */
    lease?: {
      /** Idle this long, and `holds.release` is called. */
      maxMs?: number;
      /** How long before that the agent is told; 0 means it is not told. */
      warnMs?: number;
      /** What the release does, said in place of "what it is holding will be released". */
      consequence?: string;
      /** What to do before then, said after the cost; the plugin's own tool names. */
      advice?: string;
      /** The longest single postponement the postpone tool accepts for this thing now, in minutes. */
      maxPostponeMinutes?: number;
    };
    /**
     * What the agent calls this thing, when a mount holds several (`Holding.activities`) or this one is
     * not the mount's default. Said beside the id in the holding sentences, so an agent holding two can
     * tell which one a warning is about. Absent: the mount's only, default thing.
     */
    name?: string;
    /**
     * What the release and postpone tools must be passed to act on this thing rather than the mount's
     * default one; the plugin's own parameter names. The holding sentences quote it after the tool's
     * name. Absent: the tools act on this thing when called with no such argument.
     */
    args?: Record<string, Json>;
  } | null;
  /** Until when the agent asked not to be reminded about it, if it did. */
  quietUntil?: number | null;
  /**
   * How this is charged, in a sentence a person reads.
   *
   * Here rather than in the console because the plugin is the only thing that
   * knows: "billed for every second it exists, not per call" is true of a
   * container and false of an API key, and a page that writes that sentence
   * itself has to know which mounts are which — the coupling this interface
   * exists to end.
   */
  billing?: string;
  /**
   * Entries of this mount's record it could not read and ignored, and the
   * record itself when that is what did not read; absent when none. A record is
   * read leniently so one bad entry cannot lose a running container, and this
   * keeps that leniency from being silent. The row counts too because a reader
   * that only asks about the fields inside a record can never report that the
   * record was not a record — and that is the case where a
   * mount looks idle while whatever its id named goes unreleased.
   *
   * **Read it as a predicate, not a quantity.** The number mixes kinds that are
   * not commensurable with anything a consumer displays: one unreadable entry
   * in a saved-environment list costs no container seconds at all, while one
   * unreadable record costs a whole mount's live box and history at once, and
   * both add exactly 1. So `unreadable > 0` answers "is what I am about to show
   * a lower bound" — which is the question all three consumers turned out to
   * have — and the count itself answers nothing a reader can act on. Printing
   * it beside a figure invites the conversion that does not exist, because two
   * numbers side by side are assumed to share a unit.
   *
   * And it is about the record NOW. A consumer that has to say whether some
   * past window was complete cannot get that from here: damage seen on one pass
   * and repaired before the next leaves a hole in whatever was recorded
   * meanwhile, and this field will have stopped mentioning it. A window's
   * completeness has to be recorded by whoever records the window.
   */
  unreadable?: number;
}

/** One finished stretch of whatever a mount keeps alive. */
export interface MountUsage {
  id: string;
  startedAt: number;
  endedAt: number;
  /** When it was last actually used, so idle time is computable after the fact. */
  lastUsedAt: number;
  /** How many times it was used, when the mount counts that. */
  uses?: number;
  /** What was carried out of it, when anything was. */
  kept?: string[];
}

/** Whether a mount can be renamed right now, and if not, what to say. */
export type RenameSafety =
  | { safe: true }
  | { safe: false; reason: string; live: { id: string; idleMs: number } };

/**
 * Renaming moves a mount's rows; a live resource under the old name is the one
 * thing that makes that dangerous.
 *
 * Not because the move is hard — it is one transaction — but because the thing
 * being moved is not only rows: a container keeps running while its state is
 * being re-keyed, and a half-moved mount leaves it billing with nothing able to
 * release it. So the answer is "wait", not "try carefully".
 *
 * A pure function because the decision is worth testing and the operation that
 * uses it is not: it needs a store, a transaction and a live agent. This is the
 * same split as `idleDecision` and for the same reason — the rule can go red on
 * its own.
 */
export function renameSafety(activity: MountActivity | null | undefined, now: number): RenameSafety {
  const live = activity?.live;
  if (!live) return { safe: true };
  return {
    safe: false,
    // The message is for a person, and the number is the one they will ask for
    // next: not "it is busy" but "it was last used this long ago", which is
    // what tells them whether to wait or to release it.
    reason: "something is still running under this mount; release it or wait until it is idle",
    live: { id: live.id, idleMs: Math.max(0, now - live.lastUsedAt) },
  };
}

export type PluginChoice = "enable" | "disable" | "inherit";

/**
 * The two layers resolved into the only question anyone asks: does this agent
 * have this plugin?
 *
 * One function rather than a rule each caller applies, because there are at
 * least three callers — provisioning decides whether to create the mount, the
 * gateway decides whether to offer the tools, and the console decides what to
 * show — and a rule stated three times is three chances to state it
 * differently. The order matters and is the whole design: **an agent's own
 * answer wins, and only silence inherits.** A plugin whose default flips must
 * not move an agent that has already chosen.
 *
 * `seeded` is "is this plugin in the operator's catalogue", and it arrives as a
 * value rather than being read off the plugin. Who should have a plugin is a
 * product decision, and it used to be declared by the plugin itself — two
 * places for one fact, kept in step by a test. The catalogue
 * (`AgentRuntime.DEFAULT_MOUNTS`) is now the only one.
 *
 * A boolean rather than the plugin, deliberately: the parameter changing type
 * makes the compiler name every caller. Had this kept taking the plugin and
 * merely read a different field, every call site would have stayed legal and
 * finding them would have been a search — which is how three readers of
 * `exclusive` were nearly missed in step 1 of this refactor.
 */
export function pluginEnabled(
  seeded: boolean,
  choice: PluginChoice | null | undefined,
): boolean {
  if (choice === "enable") return true;
  if (choice === "disable") return false;
  return seeded;
}

/**
 * Which plugins' credentials a piece of text appears to contain.
 *
 * Answers with the plugin and the kind, never the text that matched: whatever
 * reports this is about to refuse a message, and repeating the credential in
 * the refusal would put it exactly where the refusal keeps it out of. A match
 * is a guess, which is why the caller offers to send anyway.
 */
export function recogniseCredentials(
  text: string, plugins: Array<{ id: string; credential?: CredentialSpec | null }>,
): Array<{ plugin: string; kind: string }> {
  const found: Array<{ plugin: string; kind: string }> = [];
  for (const p of plugins) {
    for (const s of p.credential?.looksLike ?? []) {
      if (new RegExp(s.pattern).test(text) && !found.some((f) => f.plugin === p.id && f.kind === s.kind)) {
        found.push({ plugin: p.id, kind: s.kind });
      }
    }
  }
  return found;
}

export function credentialForm(credential: CredentialSpec | undefined | null): CredentialForm {
  if (!credential) return { kind: "none" };
  const { shape, required, summary } = credential;
  if (shape === "token") {
    return {
      kind: "fields",
      accountRequired: required,
      // The declaration's own words: a plugin saying "a GitHub personal access
      // token" has already written the label, and repeating it generically as
      // "Token" throws away the only sentence written for this plugin.
      fields: [resolved({ name: "token", summary, secret: true, required: true })],
    };
  }
  if ("keys" in shape) {
    return { kind: "fields", fields: shape.keys.map(resolved), accountRequired: required };
  }
  return { kind: "signIn", signIn: shape.signIn, accountRequired: required };
}

/**
 * What a tool returns when the work has started and will not finish inside
 * this call: the handle the plugin needs to find it again, and a line for the
 * model about what is now running.
 *
 * A class rather than a shape, because a tool's result is arbitrary `Json`
 * and any agreed key can occur in real data — a result that happened to
 * contain `background` would be read as a job that does not exist, silently
 * and rarely. `instanceof` cannot be produced by data, so the signal and the
 * data cannot be confused no matter what a tool returns (Piper, cody,
 * 2026-09-14, `83f0658d`).
 *
 * The handle is the plugin's own business and is stored as given: for a
 * container it is the box and the execution. It must never carry a
 * credential — polling happens inside the agent's object with the same
 * `PluginContext` the call had, so the secret is already there and does not
 * need to travel in the handle.
 */
export class Backgrounded {
  // Written out rather than declared in the constructor: Node runs this as
  // strip-only TypeScript, where a parameter property is a syntax error.
  readonly handle: Json;
  readonly note?: string;
  constructor(handle: Json, note?: string) {
    this.handle = handle;
    if (note !== undefined) this.note = note;
  }
}

/**
 * What a tool returns when it needs the AGENT's decision before it acts: a
 * question, what it found, and what answer it expects. The tool is then a
 * generator: it yields this, the model answers with `resume`, and the
 * plugin's {@link Interrupting.resume} takes the next step, which may return a
 * result or ask again. A model that gives up, or lets the token expire, ends
 * it through {@link Interrupting.cancel}, and nothing more runs.
 *
 * Not a person's approval: a held call (`confirm: true`, a policy) waits for a
 * human and is unchanged. This asks the model, from inside the tool, because
 * only the tool can see from its own arguments and findings that the call
 * needs a second look (a `DELETE` with no `WHERE`; a message whose
 * conversation moved on).
 *
 * A class for the reason {@link Backgrounded} is one: a result is arbitrary
 * `Json`, and no agreed key is safe from real data; `instanceof` cannot be
 * produced by data.
 *
 * `state` is the plugin's own: kept on the host beside the token, handed back
 * to `resume`/`cancel`, and never shown to the model or settable by it. It
 * lives in the object's memory only, like a suspended run_js program, so it
 * is lost when the object restarts and the model is told the token is gone;
 * correctness must not depend on it surviving. It must never carry a
 * credential: `resume` is given the same context a call is.
 */
export class Interrupt {
  readonly question: string;
  readonly context?: Json;
  readonly answer: AnswerSpec;
  readonly state: Json;
  constructor(o: { question: string; context?: Json; answer: AnswerSpec; state?: Json }) {
    this.question = o.question;
    if (o.context !== undefined) this.context = o.context;
    this.answer = o.answer;
    this.state = o.state ?? null;
  }
}

/** `return interrupt({ question, context, answer: { choices: [...] }, state })` — see {@link Interrupt}. */
export function interrupt(o: { question: string; context?: Json; answer: AnswerSpec; state?: Json }): Interrupt {
  return new Interrupt(o);
}

/**
 * The other half of a plugin whose tools may return {@link Interrupt}.
 *
 * `resume` is called once per answer, with the interrupt's `state` and an
 * `answer` the host has already checked against the interrupt's spec; it
 * returns the tool's result, or another `Interrupt`. It runs as its own
 * recorded operation of the same tool, behind the same mount lock, with the
 * same context a call gets.
 *
 * `cancel` is for a plugin that took something when it asked (a lock, a
 * reservation) and must give it back when the model cancels or the token
 * expires. Absent: nothing to give back. Best effort: a throw is reported,
 * never retried.
 *
 * Declaring it is also what tells the runtime to offer the model `resume`.
 */
export interface Interrupting {
  resume(tool: string, state: Json, answer: Json, ctx: PluginContext): Promise<Json | Interrupt>;
  cancel?(tool: string, state: Json, ctx: PluginContext): Promise<void>;
}

/**
 * One request a service sent to a mount's inbound URL, as it arrived.
 *
 * The body is bytes, not text, because services sign the bytes: GitHub's
 * signature is an HMAC of the raw body, and a body decoded and re-encoded on
 * the way in is only the same bytes when the service happened to send valid
 * UTF-8. A plugin checks the signature first and decodes after.
 *
 * Header names are lowercase, so every plugin looks one up the same way.
 */
export interface InboundEvent {
  headers: Record<string, string>;
  body: Uint8Array;
  /**
   * The hook this delivery arrived at: one of this mount's own, resolved by
   * the runtime before the plugin sees the event. Supplied because a delivery
   * that verifies against the hook's secret is proof the service still points
   * at this hook — proof a plugin can rebuild its own record from, if that
   * record is gone. That works because the secret lives at the hook layer, in
   * the agent's secret store under the hook's name (cf/src/runtime.ts
   * `receiveHook`), not in anything the plugin keeps: a change that drops
   * per-mount plugin state leaves the hook and its secret standing.
   */
  hookId: string;
}

/**
 * What the agent is doing now, in the five values the service shows beside it
 * (raft-agent-status.v1): the same set its own managed agents use.
 */
export type AgentStatus = "online" | "thinking" | "working" | "error" | "offline";

/**
 * One thing the agent did, for the service the agent belongs to (Raft's
 * raft-agent-activity-ingest.v1, 2026-09-28). Names are the service's hook
 * event names; the runtime maps its own ended spans onto them
 * (src/runtime/activity.ts). Only the fields listed exist: the service refuses
 * an unknown field with 400, so a plugin passes these through and adds none.
 */
export type ActivityEventName = "UserPromptSubmit" | "PreToolUse" | "PostToolUse" | "PostToolUseFailure" | "Stop" | "BridgeFatal" | "SessionEnd";
export interface ActivityEvent {
  /** Unique per agent for all time; the service dedupes on it. */
  eventId: string;
  /**
   * What happened. Absent on a status-only event: a change of status that no
   * activity carries (a model call starting, say).
   */
  hookEventName?: ActivityEventName;
  /** ISO 8601. */
  occurredAt: string;
  toolName?: string;
  durationMs?: number;
  errorClass?: string;
  /**
   * The agent's status after this event (raft-agent-status.v1), said by the
   * runtime that knows it. Status rides the activity log so it gets the log's
   * delivery — held on failure, resent as-is — and a replayed old status is
   * harmless because the service keeps the latest by `occurredAt`.
   */
  status?: AgentStatus;
  /** A short phrase shown with the status (at most 200 characters): what the agent is working on. */
  detail?: string;
}

/**
 * What a plugin makes of an inbound request.
 *
 * `text` is the whole of what reaches the agent, and the plugin writes it: a
 * line saying what happened, never the payload passed through. What a service
 * sends is written by whoever triggered it — anyone can comment on a public
 * issue — so the runtime delivers it labelled as outside content, and the
 * plugin keeps what it quotes short.
 *
 * `reason` is for the audit record, which is where a person looks when an
 * event they expected never arrived. It never goes into the HTTP answer.
 *
 * `rejected` says the request itself is wrong — unsigned, badly signed,
 * unreadable — and the runtime answers it with a failure the service shows in
 * its own delivery log, which is where the person setting up the webhook is
 * looking. Without it the request was fine and simply not for this mount (not
 * subscribed, the mount's own doing, a ping), and the answer is a success, so
 * the service does not report a working webhook as broken.
 *
 * `malformed` is the third answer: the request came from the right party (its
 * signature verified) and its body is not what this plugin's contract says.
 * The runtime answers 400, which a service reads as its own bug to fix, where
 * 401 reads as "not you" — and a service that stops pushing after a few 401s
 * would otherwise stop over one field. A plugin sets one of `rejected` and
 * `malformed`, not both.
 */
export type InboundResult =
  // One of `rejected` and `malformed`, and the type says so: two booleans left "set at most one" to a
  // comment, and a result with both would have been answered 401 by the runtime's first check — the
  // side `malformed` exists to avoid.
  | { deliver: false; reason: string; rejected?: true; malformed?: never }
  | { deliver: false; reason: string; malformed?: true; rejected?: never }
  | { deliver: true; text: string; dedupeKey?: string };

/** `return backgrounded({ boxId, execId }, "…")` — see {@link Backgrounded}. */
export function backgrounded(handle: Json, note?: string): Backgrounded {
  return new Backgrounded(handle, note);
}

/**
 * What a mount that HOLDS something real has to be able to do.
 *
 * Grouped rather than left as three optional methods on every plugin, because
 * they are one decision and not three: a mount either owns a resource that is
 * billed while it exists, or it does not. Declaring the group is what says so —
 * `exclusive` is derived from it rather than asserted beside it, which is why
 * there is no longer a way for the two to disagree.
 *
 * Every sentence below is carried over unchanged from the methods this
 * replaces; the wording is the contract, not decoration.
 */
/**
 * What a release just ended, in the words of the plugin that ended it.
 *
 * The framework records finished spans (`trace_outbox`), and it cannot derive
 * this one for itself: a container's start and end are known only inside the
 * release, and re-reading the mount afterwards can land on a DIFFERENT
 * container. Releases are not serialised against calls — `releaseTask` does not
 * take the per-mount lock `invoke` takes — so a command that finds no container
 * may create and record one in between, and a span built from a later read
 * would report that box's id against this box's lifetime — the same
 * interleaving `stopBox` already guards its own session against.
 *
 * **So every field here comes from the one read the release itself made.** A
 * plugin that fills these in from a fresh read of its own state has reproduced
 * the defect this shape exists to avoid.
 *
 * `startedAt`/`endedAt` rather than a duration, because the recorder asserts
 * that the duration it stores equals `endedAt - startedAt` from this same fact
 * — a span whose ms came from somewhere else joins correctly and is still
 * wrong, which no "does this row join?" check can see.
 */
export interface Released {
  /** The thing that ended, by the id the plugin's own records name it with. */
  id: string;
  /** Both instants from the release's own read; never re-read to fill these. */
  startedAt: number;
  endedAt: number;
  /** Whether the thing is actually gone. `error` carries why it is not. */
  status: "freed" | "error";
  error?: string;
}

/**
 * The key a tool result reports a `Released` under.
 *
 * Two of the sandbox's ending paths are tool calls (`release`, `start_from`)
 * and do not pass through `holds.release`, so the fact crosses the boundary in
 * two shapes: a return value, and a declared key on a result. Declared as a
 * constant because the kernel finds it by this name — the same arrangement as
 * `HELD_KEY`, and for the same reason: a name rebuilt at the reading end is
 * right only until someone renames one of the two.
 *
 * **The kernel deletes this key after recording, and that deletion is load
 * bearing.** A plugin's result object is serialised whole into the text the
 * model reads (`JSON.stringify(res.result)`, src/runtime/pi-tools.ts), so this
 * is not a field that merely sits unread on an object — left in place it is
 * tokens in the conversation, every release, forever.
 *
 * The value is a sentinel rather than a word because of that deletion, not
 * instead of it. Something removed **by name** has to carry a name no plugin
 * would choose for a field it wants the model to keep: `lease` is exactly the
 * word a future container plugin might return on purpose, and the strip would
 * eat it. `CWD_MARK` is the same shape one layer down — a marker the kernel
 * parses out of output, spelled so that nothing else can be mistaken for it.
 *
 * So the two halves answer different failures and neither replaces the other:
 * the strip keeps the key out of the model's context, and the spelling keeps
 * the strip off somebody else's field.
 */
export const LEASE_KEY = "__ap_lease__";

/**
 * Attach a `Released` to a failure, so a release that did NOT release is still
 * a recordable fact.
 *
 * `Holding.release` must throw rather than return when something billed
 * survives, which would otherwise make the most important case — the box still
 * alive and still charging — the one case that leaves no span. The thrown error
 * carries it instead, the way `markIdentity` carries the identity of a failed
 * call.
 */
export function markReleased<E extends Error, F extends Released | Released[]>(error: E, fact: F): E & { released: F } {
  const marked = error as E & { released: F };
  marked.released = fact;
  return marked;
}

export interface Holding {
  /**
   * Which of this plugin's tools lets go of the thing, and which postpones.
   *
   * A declaration, not a sentence. The runtime tells the agent how to release
   * what it is holding, and it used to build those names from the literals
   * `"release"` and `"quiet"` — so the reminder only ever worked for a plugin
   * that happened to use those words, and renaming either left the runtime
   * telling the agent to call something that does not exist. With this, a
   * releasing tool called anything at all is named correctly.
   *
   * The names are the plugin's own tool names; the runtime resolves them
   * against what the model was actually offered, because qualification
   * sanitises an alias and breaks ties at the length cap.
   *
   * `release` is required: something that can be held and never let go is not
   * what this interface describes. `postpone` is optional because a resource
   * with no lease has nothing to postpone.
   *
   * A plugin that declares this returns JSON **objects** from its tools: the
   * framework attaches the per-result "you are still holding this" line as a
   * key on the result (`withHeldNote`, src/runtime/held.ts), and an array or a
   * bare string has nowhere to put it.
   */
  tools: { release: string; postpone?: string };
  /**
   * What this mount is holding right now, without a credential and without
   * calling the far end: it is asked when nobody is using the mount and by a
   * timer, so it must be answerable from what the runtime already has.
   */
  activity(ctx: PluginContext): Promise<MountActivity>;
  /**
   * Every thing this mount is holding, each with its own activity, when it can hold more than one.
   *
   * A separate method rather than siblings inside `MountActivity`, because what differs between two held
   * things is not only `live`: each has its own postponement (`quietUntil`) and its own cost sentence
   * (`billing`) — a sandbox mount can hold one machine that is running and billed by the second beside
   * one that is switched off and only keeps a disk. A list of `live` alone would have to borrow one of
   * them for the other. `activity` stays the one answer for callers whose question is "is anything here"
   * (the console's card, rename safety); this is for the callers that act on each thing (the idle pass,
   * the holding sentences), which pass the thing's `live.id` back to `release` to act on that one only.
   *
   * Absent: the mount holds at most one thing, and `activity` is the whole answer. Same rules as
   * `activity`: no credential, no call to the far end. Entries with `live: null` are allowed and ignored.
   */
  activities?(ctx: PluginContext): Promise<MountActivity[]>;
  /**
   * What it has cost, as far as this mount can still say. A rolling window is a
   * legitimate answer: this is not a ledger, and anything that has to be
   * complete is written where it happens.
   */
  usage?(ctx: PluginContext): Promise<MountUsage[]>;
  /**
   * Let go of it. Scoped to the AGENT rather than to one task, safe to call
   * again, and it must throw rather than return if something billed could not
   * be released — a silent failure here is a resource nobody will collect.
   *
   * `reason: "idle"` is the framework's idle pass reaching the end of the thing's schedule; a plugin
   * may answer it with a gentler step (the sandbox switches a running box off and keeps it). Any other
   * caller (an operator, a benchmark, a settled turn without a lease) means let go now.
   *
   * `id` is one held thing's `live.id`, as `activity`/`activities` reported it: let go of that one only,
   * and answer `false` when nothing by that id is held any more. Absent: everything the mount holds.
   * Letting go of several may report a fact for each (an array), and a failure among them throws with
   * every fact attached (`markReleased`).
   */
  release(ctx: PluginContext, opts?: { reason?: "idle"; id?: string }): Promise<Released | Released[] | boolean | void>;
  /**
   * The files of the thing held, for a person looking at the agent's workspace (cf/src/agent-surface/
   * workspace.ts). Only while it is already running: **neither method may start it**, since starting is
   * what is billed. Not running answers `{ running: false }` and touches nothing at the far end.
   *
   * The gateway hands them the mount's own lock (`ToolGateway.heldFiles`), so a release cannot switch
   * the thing off between the plugin's "it is running" and the step that reads it. They must not write
   * the mount's state: a look is not a use, and must not postpone an idle release.
   *
   * `path` is relative to the thing's working directory, `""` for the directory itself, and has no `.`
   * or `..` segment. Absent: the mount has no files to show.
   */
  files?: HeldFiles;
}

export type HeldListing =
  | { running: false }
  | { running: true; found: false; notDirectory?: true }
  | {
    running: true; found: true;
    /** Symbolic links and other non-regular entries are listed as files, never followed. */
    entries: Array<{ name: string; isDirectory: boolean; size: number; modifiedAt: number }>;
    /** Entries exist that are not in `entries`; `omitted` says how many when it is known. */
    truncated: boolean; omitted?: number;
  };
/**
 * `kind` is what the path is: only a `file` (a regular file, reached without leaving the working
 * directory through a link) has bytes. `bytes` is null for anything else, or when the file is larger
 * than the `maxBytes` asked for; `size` is still reported.
 */
export type HeldRead =
  | { running: false }
  | { running: true; found: false }
  | { running: true; found: true; kind: "file" | "directory" | "other"; size: number; modifiedAt: number; bytes: Uint8Array | null };

export interface HeldFiles {
  /**
   * `locked` runs a step behind the mount's own lock. A plugin takes it only for the steps that must
   * not interleave with a release (deciding the thing is running and starting the read on it), not
   * for the wait on the far end, so a look never holds the agent's own calls for long.
   */
  list(ctx: PluginContext, path: string, locked: <T>(fn: () => Promise<T>) => Promise<T>): Promise<HeldListing>;
  read(ctx: PluginContext, path: string, maxBytes: number, locked: <T>(fn: () => Promise<T>) => Promise<T>): Promise<HeldRead>;
}

/**
 * What a plugin whose `invoke` may only have STARTED the work has to be able to do.
 *
 * The pair is one capability: something that can be started must be pollable
 * and stoppable, and a plugin offering one without the other leaves the runtime
 * holding a job it cannot finish or cannot end.
 */
export interface Backgrounding {
  /** Has it finished, and what did it produce? Asked with the context the call had. */
  poll(handle: Json, ctx: PluginContext): Promise<
    { done: false; progress?: Json } | { done: true; result: Json }
  >;
  /** Returning means it has actually stopped, not that a stop was requested. */
  cancel(handle: Json, ctx: PluginContext): Promise<void>;
}

/**
 * What a mount of this plugin becomes inside the agent's container: the same
 * account, reached by the service's own command-line tool instead of by this
 * plugin's tools (`gh` for the github plugin).
 *
 * The container never holds the credential. It holds a placeholder, and the
 * container's egress proxy swaps the credential in on the way out, only in the
 * header named and only on requests to the hosts named. So a declaring plugin
 * keeps "the agent never sees the credential" inside the container too.
 *
 * Declared rather than asked of the plugin at run time, so which hosts a
 * credential can reach from a container is readable without running anything.
 * A container wires in every mount whose plugin declares this and whose
 * credential is present, except where two of them claim the same name (an
 * environment variable or an egress entry): a container has one `GH_TOKEN`,
 * so two GitHub accounts are both left out rather than one picked silently.
 */
export interface SandboxForm {
  /**
   * What works in the container because of this mount, told to the model in
   * every container result while it is wired in. Say what the commands are and
   * how to get them if the image lacks them; the container adds that the
   * credential is a placeholder.
   */
  summary: string;
  /** One registration per header form the tools send; see {@link SandboxEgress}. */
  egress: readonly SandboxEgress[];
  /** The environment every command runs with, given the placeholder that stands for the credential. */
  env(placeholder: string): Record<string, string>;
}

/**
 * One header the container's egress proxy fills in. The proxy replaces
 * `placeholder(p)` where it appears verbatim in `header` with `value(credential)`,
 * on requests to `hosts` only; so a tool that encodes the credential (git's Basic
 * auth) needs its own entry, whose two functions encode both sides the same way.
 */
export interface SandboxEgress {
  /** Unique within a container; the name the registration is kept and deleted under. */
  name: string;
  header: string;
  hosts: readonly string[];
  value(credential: string): string;
  placeholder(placeholder: string): string;
}

export interface Plugin {
  id: string;
  version: string;
  /** The tools every mount of this plugin offers; see `mountTools` for a plugin whose mounts differ. */
  tools: ToolSchema[];
  /**
   * The tools one mount offers, when they differ by mount; read through
   * {@link toolsOf}, never directly.
   *
   * Synchronous and local: it reads what is on the mount record (normally its
   * {@link ToolSnapshot}) and answers. It is asked on every harness build and
   * every call, so it must not reach a server. Absent: `tools` is the answer.
   */
  mountTools?(mount: MountRecord): ToolSchema[];
  /**
   * List the tools a mount should offer, by asking whoever knows. Called when
   * the mount is created and when an operator asks for a refresh — never on a
   * wake, a harness build or a call. The kernel admits the list (names an agent
   * can address, no duplicates), hashes it and stores it on the mount as its
   * {@link ToolSnapshot}; the stored copy is replaced only when the hash moved.
   *
   * A throw leaves the stored snapshot as it was and is reported to the
   * operator who asked.
   */
  snapshotTools?(ctx: PluginContext): Promise<ListedTools>;
  /** This mount holds something real; see {@link Holding}. Declaring it is what
   *  makes the mount exclusive — ask {@link isExclusive}, never the two separately. */
  holds?: Holding;
  /** `invoke` may return {@link Backgrounded}; see {@link Backgrounding}. */
  background?: Backgrounding;
  /** `invoke` may return {@link Interrupt}; see {@link Interrupting}. */
  interrupts?: Interrupting;
  /**
   * What environment this plugin can give a session.
   *
   * Exists so the agents API can pick the mount that provides a container by
   * asking what a plugin offers rather than by matching the alias `sandbox` —
   * an alias is the operator's to choose, so matching on it makes a rename a
   * silent behaviour change.
   */
  provides?: readonly ("container")[];

  /** What a mount of this plugin may be configured with. */
  config?: ConfigField[];
  /**
   * A person may add a mount of this plugin from the console, with the settings
   * in `config` as the form (`POST /ui/mount/add`), and remove one again.
   *
   * Opt-in, and `true` or absent, because the console is the one path where a
   * signed-in owner rather than an operator chooses the settings, and that is
   * a decision about this plugin that only its author can make: the settings
   * must be ones a stranger may type, and a mount of it must be safe to delete
   * (nothing outside this agent depends on its alias). Absent: the operator's
   * route (`/admin/mounts`) is the only way to add one, as before.
   */
  consoleMount?: true;
  /**
   * The plugin's own verdict on a mount's settings, for a rule `config` cannot
   * declare. A string is the reason the mount is refused, shown to whoever
   * asked; `undefined` accepts it.
   *
   * Asked by `validateMount`, so wherever a mount's settings are judged: when
   * one is added (the console, `/admin/mounts`, provisioning's seeds), when a
   * seed is reconciled onto one, when a credential is attached to one — each
   * before anything is stored, so a refusal leaves nothing behind — and on the
   * console's mount page, for a mount stored before the rule existed. Only after
   * the declared checks have passed, so `config` holds declared settings of the
   * declared types with every required one present. Synchronous and local: it
   * must not reach a server (the tool snapshot is the step that does).
   */
  configProblem?(config: Record<string, Json>): string | undefined;
  /**
   * This plugin is handed `PluginContext.ownerSecret`; without it, it is not.
   *
   * Declare it only when every place the plugin sends an owner's secret is one
   * the mount's settings name, never one a tool call's arguments name. The grant
   * is per plugin rather than on every context so that the rule is a decision
   * someone makes where the plugin is defined, not a comment a new reader has to
   * find: a plugin that never declared it has nothing to misuse. One plugin
   * reaches the sealed store without it: `state` holds the raw store and the key
   * because it is the store's own surface, and its tools only ever read `kept:`
   * (test/console-mounts.ts trips if another entry of cf/src/runtime.ts's plugin
   * list names the key or `#secrets`, the resolver that opens what it opens; a
   * key passed under another name, or a plugin built
   * elsewhere such as an `extraPlugins` entry, is outside what it sees).
   */
  readsOwnerSecrets?: true;
  /** The database each mount of this plugin keeps; see {@link DbSpec}. */
  database?: DbSpec;
  /** What credential it needs, if any. Absent means it never uses one. */
  credential?: CredentialSpec;
  /** What a mount of this plugin becomes inside the agent's container; see {@link SandboxForm}. */
  sandboxForm?: SandboxForm;
  /**
   * Does this credential work, asked at the moment a person supplies it.
   *
   * Declaring what to store catches a mount with no credential. It does
   * nothing for a mount with the wrong one, which looks identical to a working
   * mount until an agent calls something and gets a 401 it cannot act on — the
   * same quiet failure `credential` exists to prevent, one step along.
   *
   * Operator-only. It is not a tool, the agent cannot reach it, and it runs
   * through the gateway like any other use so the record shows the credential
   * was used and by which ref. `account` is whatever a person would recognise
   * as the identity the credential grants: a login, a project. A console can
   * then say which account is attached instead of the last four characters,
   * which say nothing about whether it is the right key.
   */
  checkCredential?(ctx: PluginContext): Promise<CredentialCheck>;
  /**
   * Do the thing. Returning {@link Backgrounded} means it has started and the
   * caller should be given a job rather than a result; returning
   * {@link Interrupt} means the model must decide before it goes on — every
   * other return is the result itself.
   */
  invoke(tool: string, args: Json, ctx: PluginContext): Promise<Json | Backgrounded | Interrupt>;
  /**
   * Whether THIS call reads or writes, for a tool whose answer depends on its
   * arguments. Read through {@link callSideEffects}, never directly.
   *
   * `ToolSchema.sideEffects` is one answer per tool, and a mount's policy picks
   * its read or write half from it. That breaks for one tool that runs many
   * commands — a generic `raft` tool forwarding argv reads with one call and
   * sends with the next: declared "write", every look is held where writes are.
   * This lets a call be a read for the policy, from its arguments.
   *
   * The declared `sideEffects` is the ceiling: `classify` can only lower a
   * declared "write" to "read", never raise a declared "read", and is not even
   * asked for one. Replay and the duplicate-attempt guard keep reading the
   * declaration, so a declared read that a call raised to a write would still
   * be rerun on its own after a crash, under a new operation id, and land
   * twice. So a tool that uses this declares "write".
   *
   * Fails closed: only exactly "read" lowers; `undefined`, a throw, or any
   * other value leaves the call a write, so a command the plugin did not
   * recognise is held where writes are held. Synchronous and local: it must
   * not reach a server. Absent: the declared `sideEffects`, as before. It
   * selects the policy half and nothing else.
   */
  classify?(tool: string, args: Json): "read" | "write" | undefined;



  /**
   * A paragraph this mount adds to the agent's system prompt, or null.
   *
   * Declared rather than wired: before this, the runtime imported one plugin's
   * function by name to put the working set in the prompt, so `state` could
   * speak to the agent and no other plugin could. A mount that keeps something
   * the agent should know about at the start of every conversation says so
   * here, and the framework does not have to know which plugin that is.
   *
   * **Where it lands, and why it is not negotiable.** Contributions are
   * appended after everything static — core, persona, policy — in the order
   * the plugins are *registered*, never the order the mounts are named. The
   * prompt prefix is cached by the provider, so an operator renaming a mount
   * must not be able to reorder it: registry order is append-only, a new
   * plugin adds its paragraph at the end, and every byte before it is
   * unchanged. Alphabetical order by plugin id does not have that property —
   * one new plugin whose id sorts early moves everyone.
   *
   * For the same reason a contribution that changes often belongs after one
   * that rarely does: the working set changes whenever the agent writes to its
   * memory, and everything after it in the prompt is re-read on the next turn.
   *
   * Called once per harness open, per mount.
   */
  promptContribution?(ctx: PluginContext): Promise<string | null>;



  /**
   * A service telling this mount that something happened, without the agent
   * having asked.
   *
   * Everything else in this interface starts with the agent: a call, or work a
   * call started. This is the one way in from outside, so the plugin is the
   * gate, not a pipe:
   *
   * - **Check the signature before reading anything else.** Each service
   *   signs differently, which is why this is the plugin's job. `secret` is
   *   the one the runtime generated for this mount's inbound URL and the
   *   operator gave the service; it is not the mount's credential. A request
   *   that is unsigned, or signed with anything else, is refused.
   *
   *   Every other answer comes after that check, the harmless ones included:
   *   a ping, or an event kind the plugin does not handle, is ignored only
   *   once its signature has passed. The runtime reads anything but
   *   `rejected` as "this request came from the service", and an unsigned
   *   ping answered early would show a stranger's request as a working
   *   webhook. A runtime that holds more than one secret for a hook may
   *   also take a delivery as proof of which secret the service uses.
   * - **A refused request leaves no trace.** Nothing is written to
   *   `ctx.db` before returning `rejected`: a stranger's request must
   *   not change what the mount remembers, and a runtime holding more than
   *   one secret for a hook may offer the same request again with another.
   * - **Deliver only what this mount subscribed to**, as recorded in
   *   `ctx.db` by the plugin's own tools.
   * - **Drop what the mount's own account caused.** An agent that comments on
   *   an issue it is subscribed to would otherwise be woken by its own comment,
   *   and answer it.
   * - **Return a `dedupeKey`** when the service marks redeliveries, so a retry
   *   is not a second event.
   *
   * The service is waiting for an answer — GitHub gives up after ten seconds —
   * so this reads the mount's database and answers; it does not call the service.
   * The runtime acknowledges once the text is posted, never after the model
   * runs.
   *
   * A plugin that implements this can be woken by a stranger's text, so what
   * it returns is short and quotes rather than forwards.
   */
  receive?(event: InboundEvent, secret: string, ctx: PluginContext): Promise<InboundResult>;

  /**
   * Tell the service what the agent has been doing, so its own display of the
   * agent (status, trajectory) follows a run here. Called by the runtime on its
   * alarm pass with the events since the last call, never by the model; the
   * credential stays in the call context. A plugin whose service is not
   * listening (push off, no account) says `skipped` and the runtime moves on;
   * a throw keeps the events for the next pass.
   *
   * Not named `activity`: that was a member of the retired mount-meter shape,
   * and test/mount-config.ts keeps every retired name from coming back with a
   * new meaning (the same word would read as the old thing to anyone who knew it).
   */
  reportActivity?(events: readonly ActivityEvent[], ctx: PluginContext): Promise<{ sent: number } | { skipped: string }>;

}
