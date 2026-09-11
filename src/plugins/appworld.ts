import type { Json } from "../core/types.ts";
import type { Plugin, PluginContext, ToolSchema } from "./types.ts";

/**
 * AppWorld as ordinary mounts.
 *
 * AppWorld's own interface hands the agent a Python REPL and expects it to read
 * the supervisor's passwords, call each app's login, and carry the access token
 * in its own context — 362 of its 457 APIs sit behind that token. That puts nine
 * services' credentials through the model's prompt, which is precisely what
 * config-time binding exists to prevent.
 *
 * So this is not an adapter written for a benchmark: it is the same shape every
 * other integration has. One plugin per app, one mount per account, credentials
 * resolved from `secret_ref`, the derived session token kept in the mount's
 * connection state, and the model addressing `spotify.search_songs` with no idea
 * that a token exists at all.
 */

export interface ApiDoc {
  app_name: string;
  api_name: string;
  path: string;
  method: string;
  description: string;
  parameters: Array<{
    name: string;
    type: string;
    required: boolean;
    description: string;
    default: Json;
    constraints: unknown[];
  }>;
  response_schemas?: Json;
}

export type Catalogue = Record<string, { description: string; apis: ApiDoc[] }>;

export interface AppWorldConfig {
  /** The AppWorld API server, e.g. http://localhost:8800 */
  apiBaseUrl: string;
  /** Apps to expose. Defaults to every app in the catalogue. */
  apps?: string[];
}

/** The one tool the harness must not hand to the agent: it hands out the
 *  passwords the harness is holding on its behalf. */
const WITHHELD = new Set(["show_account_passwords"]);

const JSON_TYPE: Record<string, string> = {
  string: "string", integer: "integer", number: "number",
  boolean: "boolean", array: "array", object: "object", null: "null",
};

/** Every token parameter the harness supplies rather than the model.
 *  `access_token` is this app's own; `<app>_access_token` belongs to a sibling
 *  mount — an action that touches two connected accounts. */
const tokenParam = (name: string): string | null =>
  name === "access_token" ? "" : name.endsWith("_access_token") ? name.slice(0, -"_access_token".length) : null;

function toSchema(doc: ApiDoc): ToolSchema {
  const properties: Record<string, Json> = {};
  const required: string[] = [];
  for (const p of doc.parameters) {
    // No token ever appears in the model's schema: the harness supplies them.
    if (tokenParam(p.name) !== null) continue;
    properties[p.name] = {
      type: JSON_TYPE[p.type] ?? "string",
      ...(p.description ? { description: p.description } : {}),
      ...(p.default !== null && p.default !== undefined ? { default: p.default } : {}),
    };
    if (p.required) required.push(p.name);
  }
  const write = doc.method.toUpperCase() !== "GET";
  return {
    name: doc.api_name,
    summary: doc.description,
    parameters: { type: "object", properties, ...(required.length ? { required } : {}) },
    sideEffects: write ? "write" : "read",
    // AppWorld's APIs are not idempotent by key; a repeated POST repeats the effect.
    idempotency: write ? "none" : "native",
  };
}

interface Session { token: string; obtainedAt: number }

/** What the mount's secret_ref must resolve to. The agent never sees it. */
interface AppCredential { username: string; password: string }

async function login(base: string, app: string, cred: AppCredential): Promise<string> {
  // OAuth2 password flow, form-encoded: the app's declared securityScheme.
  const res = await fetch(`${base}/${app}/auth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: cred.username, password: cred.password }).toString(),
  });
  if (!res.ok) throw new Error(`login ${app} failed: ${res.status} ${(await res.text()).slice(0, 160)}`);
  const body = (await res.json()) as { access_token?: string };
  if (!body.access_token) throw new Error(`login ${app} returned no access_token`);
  return body.access_token;
}

async function callApi(
  base: string, doc: ApiDoc, args: Record<string, Json>, token: string | null,
): Promise<{ status: number; body: Json }> {
  // Path parameters are substituted, the rest go to the query string for GET and
  // to a JSON body otherwise — AppWorld's own convention.
  let path = doc.path;
  const rest: Record<string, Json> = {};
  for (const [k, v] of Object.entries(args)) {
    if (path.includes(`{${k}}`)) path = path.replace(`{${k}}`, encodeURIComponent(String(v)));
    else rest[k] = v;
  }
  const method = doc.method.toUpperCase();
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;

  let url = `${base}/${doc.app_name}${path}`;
  let body: string | undefined;
  if (method === "GET" || method === "DELETE") {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(rest)) {
      if (v !== undefined && v !== null) q.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
    }
    if ([...q].length) url += `?${q.toString()}`;
  } else {
    headers["content-type"] = "application/json";
    body = JSON.stringify(rest);
  }
  const res = await fetch(url, { method, headers, body });
  const text = await res.text();
  let parsed: Json = text;
  try { parsed = JSON.parse(text); } catch { /* some endpoints answer in plain text */ }
  return { status: res.status, body: parsed };
}

export function appworldPlugins(catalogue: Catalogue, cfg: AppWorldConfig): Plugin[] {
  const apps = cfg.apps ?? Object.keys(catalogue);
  return apps.map((app) => {
    const entry = catalogue[app];
    if (!entry) throw new Error(`no such app in catalogue: ${app}`);
    const docs = new Map<string, ApiDoc>();
    const tools: ToolSchema[] = [];
    for (const d of entry.apis) {
      if (WITHHELD.has(d.api_name)) continue;
      // login/logout are the harness's job, not the agent's.
      if (d.path === "/auth/token") continue;
      docs.set(d.api_name, d);
      tools.push(toSchema(d));
    }

    const needsAuth = (d: ApiDoc) => d.parameters.some((p) => p.name === "access_token");
    /** Sibling-account tokens this call needs: param name -> app alias. */
    const siblingTokens = (d: ApiDoc): Array<[string, string]> =>
      d.parameters
        .map((p) => [p.name, tokenParam(p.name)] as const)
        .filter((x): x is readonly [string, string] => !!x[1])
        .map(([n, a]) => [n, a] as [string, string]);

    async function session(ctx: PluginContext, force = false): Promise<string> {
      if (!force) {
        const cached = (await ctx.connection.get()) as Session | null;
        if (cached?.token) return cached.token;
      }
      if (!ctx.credential) {
        throw new Error(`mount for ${app} has no credential; the harness cannot authenticate`);
      }
      const cred = JSON.parse(ctx.credential) as AppCredential;
      const token = await login(cfg.apiBaseUrl, app, cred);
      await ctx.connection.set({ token, obtainedAt: Date.now() } satisfies Session);
      return token;
    }

    return {
      id: app,
      version: "1.0.0",
      /**
       * Declared, not discovered. Without this a mount with no `secret_ref`
       * passes validation and fails on the agent's first authenticated call,
       * and a console rendering the credential form has nothing to draw.
       */
      credential: {
        required: true,
        summary: `The AppWorld account this mount acts as: its username and password, as JSON.`,
        shape: { keys: [
          { name: "username", summary: "Username of the account.", secret: false },
          { name: "password", summary: "Its password. Exchanged for a token server-side; the agent sees neither." },
        ] },
        grants: "acting as that account — everything the app lets its owner do, reads and writes alike.",
      },
      tools,
      /**
       * The check this plugin already performs, moved to where a person is.
       *
       * `login` is exactly "do these credentials work" and it ran on the first
       * authenticated call — which is to say, after the mount looked fine and
       * an agent had already started a task. Doing it at attach time costs the
       * same one request and answers while somebody is still looking at the
       * form.
       *
       * It names the username, which is the account these credentials are, and
       * the one string on the page a person can check against what they typed.
       */
      async checkCredential(ctx: PluginContext) {
        if (!ctx.credential) {
          return { ok: false as const, kind: "rejected" as const, reason: `no credentials: this mount cannot act as a ${app} account` };
        }
        let cred: AppCredential;
        try {
          cred = JSON.parse(ctx.credential) as AppCredential;
        } catch {
          return { ok: false as const, kind: "rejected" as const, reason: "the stored value is not JSON; this needs an object with username and password" };
        }
        if (!cred.username || !cred.password) {
          return { ok: false as const, kind: "rejected" as const, reason: "both a username and a password are needed; one of them is missing" };
        }
        try {
          await login(cfg.apiBaseUrl, app, cred);
          return { ok: true as const, account: cred.username };
        } catch (e) {
          const reason = String((e as Error)?.message ?? e);
          // `login` puts the status in the message when the server answered.
          // Only a 401 is the account saying no; a 5xx or a fetch that never
          // arrived leaves the credentials unjudged.
          const status = Number(/failed: (\d{3})/.exec(reason)?.[1] ?? 0);
          const rejected = status === 401 || status === 403;
          return { ok: false as const, kind: rejected ? "rejected" as const : "unreachable" as const, reason };
        }
      },

      async invoke(tool: string, args: Json, ctx: PluginContext): Promise<Json> {
        const doc = docs.get(tool);
        if (!doc) throw new Error(`unknown tool: ${app}.${tool}`);
        const params = (args ?? {}) as Record<string, Json>;

        let token: string | null = null;
        if (needsAuth(doc)) token = await session(ctx);

        // An action spanning two accounts gets the second token from the other
        // mount, not from the model.
        for (const [param, otherApp] of siblingTokens(doc)) {
          const other = await ctx.sibling(otherApp);
          if (!other?.credential) continue; // optional parameter; leave it unset
          const cached = (await other.connection.get()) as Session | null;
          let t = cached?.token;
          if (!t) {
            t = await login(cfg.apiBaseUrl, otherApp, JSON.parse(other.credential) as AppCredential);
            await other.connection.set({ token: t, obtainedAt: Date.now() } satisfies Session);
          }
          params[param] = t;
        }

        let r = await callApi(cfg.apiBaseUrl, doc, params, token);
        if (r.status === 401 && needsAuth(doc)) {
          // A stale session is the normal case after a restart, not an error to
          // report to the agent: re-authenticate once and retry.
          token = await session(ctx, true);
          r = await callApi(cfg.apiBaseUrl, doc, params, token);
        }
        if (r.status >= 400) {
          const err = new Error(
            `${app}.${tool} -> ${r.status}: ${JSON.stringify(r.body).slice(0, 300)}`,
          ) as Error & { retryable?: boolean };
          // 5xx may have landed; the gateway reports that as `unknown`, not `failed`.
          err.retryable = r.status >= 500;
          throw err;
        }
        return r.body;
      },
    } satisfies Plugin;
  });
}
