import type { Json } from "../core/types.ts";

export interface ToolSchema {
  name: string;
  summary: string;
  parameters: Json;
  sideEffects: "read" | "write";
  /** Whether the plugin can make this call idempotent (§8.3). */
  idempotency: "native" | "key" | "none";
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
  /** Resolved server-side; the agent never sees the credential itself. */
  credential: string | null;
  publicConfig: Record<string, Json>;
  /** Survives across calls and across executions; never reaches the model. */
  connection: ConnectionState;
  /**
   * Another mount of the same agent, by alias.
   *
   * Some actions genuinely need two connected accounts — "file this receipt
   * into my drive" touches the store and the drive. Without this the plugin
   * would have to ask the model for the second credential, which is the leak
   * config-time binding exists to prevent. Scoped to this agent's own mounts,
   * so it grants nothing the agent was not already configured to use.
   */
  sibling(alias: string): Promise<{ credential: string | null; connection: ConnectionState } | null>;
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

export interface Plugin {
  id: string;
  version: string;
  tools: ToolSchema[];
  /**
   * Whether two calls to this plugin may overlap for one mount.
   *
   * Most plugins are fine concurrently — two HTTP fetches do not interfere.
   * A plugin whose mount owns a shared resource is not: run9 keeps one
   * container per mount and creates it if absent, so two calls arriving
   * together both find nothing and both create one. Only the last write to the
   * connection state survives; the rest become containers nobody will ever
   * release, billed by the second for as long as they exist.
   *
   * Fifteen of them accumulated before the meter made it visible.
   */
  exclusive?: boolean;
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
  invoke(tool: string, args: Json, ctx: PluginContext): Promise<Json>;
  /**
   * Let go of anything held on the task's behalf, once the task is over.
   *
   * Some mounts reserve something real and metered — a container, a session, a
   * lease — and without a point to hand it back, it is held until something
   * else notices. Called on a terminal task; must be safe to call twice.
   *
   * It may throw, and should, when it could not let go of something that is
   * still being billed. What must not happen is a finished task failing over
   * tidying up, and that is the gateway's job rather than this one's: it
   * records the failure and carries on. Returning `false` means there was
   * nothing to release, which is not a failure.
   */
  release?(ctx: PluginContext): Promise<boolean | void>;
}
