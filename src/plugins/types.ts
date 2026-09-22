import type { Json, MountPolicy } from "../core/types.ts";

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
}

/** Where a plugin keeps what it derived from a credential. Scoped to one mount,
 *  so two mounts of the same plugin never share a session. */
export interface ConnectionState {
  get(): Promise<Json | null>;
  set(state: Json, expiresAt?: number | null): Promise<void>;
}

export interface PluginContext {
  /** Read-only identity of the caller. Plugins cannot use it to escalate. */
  caller: { tenantId: string; agentId: string; taskId: string };
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
  /** Survives across calls and across executions; never reaches the model. */
  connection: ConnectionState;
  /**
   * This mount's inbound hooks. Present only for a plugin that implements
   * `receive`, on a deployment that can take pushed events.
   *
   * Rules for a plugin using them (from the #388 review):
   * - **The secret and the URL never go into a tool result or an error**:
   *   what `invoke` returns lands in the transcript. The secret is handed to
   *   the service and nowhere else, `ctx.connection` included.
   * - **Keep the live `hookId` in `ctx.connection`**, and revoke the previous
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
    connection: ConnectionState;
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

export function isExclusive(p: Pick<Plugin, "holds">): boolean {
  return !!p.holds;
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
   */
  format?: "origin";
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
  live: { id: string; startedAt: number; lastUsedAt: number } | null;
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
 */
export type InboundResult =
  | { deliver: false; reason: string; rejected?: boolean }
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
   * What it has cost, as far as this mount can still say. A rolling window is a
   * legitimate answer: this is not a ledger, and anything that has to be
   * complete is written where it happens.
   */
  usage?(ctx: PluginContext): Promise<MountUsage[]>;
  /**
   * Let go of it. Scoped to the AGENT rather than to one task, safe to call
   * again, and it must throw rather than return if something billed could not
   * be released — a silent failure here is a resource nobody will collect.
   */
  release(ctx: PluginContext): Promise<boolean | void>;
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

export interface Plugin {
  id: string;
  version: string;
  tools: ToolSchema[];
  /** This mount holds something real; see {@link Holding}. Declaring it is what
   *  makes the mount exclusive — ask {@link isExclusive}, never the two separately. */
  holds?: Holding;
  /** `invoke` may return {@link Backgrounded}; see {@link Backgrounding}. */
  background?: Backgrounding;
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
  /** What credential it needs, if any. Absent means it never uses one. */
  credential?: CredentialSpec;
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
   * caller should be given a job rather than a result — every other return is
   * the result itself.
   */
  invoke(tool: string, args: Json, ctx: PluginContext): Promise<Json | Backgrounded>;



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
   *   `ctx.connection` before returning `rejected`: a stranger's request must
   *   not change what the mount remembers, and a runtime holding more than
   *   one secret for a hook may offer the same request again with another.
   * - **Deliver only what this mount subscribed to**, as recorded in
   *   `ctx.connection` by the plugin's own tools.
   * - **Drop what the mount's own account caused.** An agent that comments on
   *   an issue it is subscribed to would otherwise be woken by its own comment,
   *   and answer it.
   * - **Return a `dedupeKey`** when the service marks redeliveries, so a retry
   *   is not a second event.
   *
   * The service is waiting for an answer — GitHub gives up after ten seconds —
   * so this reads connection state and answers; it does not call the service.
   * The runtime acknowledges once the text is posted, never after the model
   * runs.
   *
   * A plugin that implements this can be woken by a stranger's text, so what
   * it returns is short and quotes rather than forwards.
   */
  receive?(event: InboundEvent, secret: string, ctx: PluginContext): Promise<InboundResult>;
}
