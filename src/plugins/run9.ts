import type { Json } from "../core/types.ts";
import type { Plugin, PluginContext } from "./types.ts";

/**
 * A real Node runtime, as a mount.
 *
 * Deliberately not the JsExecutor. The sandbox the harness runs `run_js` in has
 * no network and no filesystem, and the only way out of it is the gateway —
 * three of the nine executor contract cases exist to hold that line. A run9 box
 * always has egress (both `normal` and `managed` reach the open internet, which
 * was measured, not assumed), so putting the tool bridge inside one would let
 * an injected agent post its tool results anywhere. It cannot today.
 *
 * As a mount it is strictly additive and the shape is in our favour: the box
 * runs on someone else's machine and holds none of our credentials, so it sits
 * outside the trust boundary exactly like GitHub or an outbound fetch. What it
 * buys is everything QuickJS cannot do — npm packages, a filesystem, minutes of
 * compute instead of five seconds.
 *
 * The box is per mount and kept in connection state, so a package installed by
 * one call is still there for the next.
 */
export interface Run9Config {
  endpoint?: string;
  /** Any image with node on the PATH. */
  image?: string;
  project?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  /** Where commands run. A prepared image usually has its own checkout. */
  workdir?: string;
  shape?: string;
  /** Shell binary. A prepared image often needs bash, not sh. */
  shell?: string;
  /**
   * Run before every command, to enter the image's environment.
   *
   * Prepared images frequently put their real toolchain behind an activation
   * step declared in `.bashrc` — which `sh -lc` never reads. Without this the
   * commands run against whatever the system happens to ship, which for a
   * SWE-bench image means a Python with no pytest, so neither the agent nor the
   * grader can run the test suite.
   */
  shellPrefix?: string;
}

interface Run9Credential { ak: string; sk: string }
interface BoxState { boxId: string; createdAt: number; lastUsedAt: number }

const DEFAULTS = {
  /** Installs and scripts share one directory, or Node resolves modules from
   *  wherever the script sits and cannot find what npm just installed. */
  workdir: "/work",
  shell: "/bin/sh",
  shellPrefix: "",
  endpoint: "https://api.run.sys9.ai",
  image: "public.ecr.aws/docker/library/node:22-alpine",
  project: "default",
  timeoutMs: 120_000,
  maxOutputBytes: 24_000,
};

/**
 * Hand the box back for real.
 *
 * `stop` is not release: it returns 200, halts the runtime, and leaves the box
 * and its storage in place — the state stays `ready` and storage keeps being
 * billed, which is the largest component of the quota. Only `DELETE` actually
 * frees it. Stopping first is a courtesy so nothing is killed mid-write.
 *
 * Failures are reported rather than swallowed. An earlier version buried them
 * on the theory that "the box stops itself eventually"; the result was thirteen
 * live boxes and a release path that had been announcing success the whole time.
 */
async function stopBox(ctx: PluginContext): Promise<{ boxId: string; freed: boolean; error?: string } | null> {
  const state = (await ctx.connection.get()) as BoxState | null;
  if (!state?.boxId || !ctx.credential) return null;
  const cfg = { ...DEFAULTS, ...(ctx.publicConfig as Run9Config) };
  const cred = JSON.parse(ctx.credential) as Run9Credential;
  const auth = "Basic " + btoa(`${cred.ak}:${cred.sk}`);
  const base = `${cfg.endpoint}/projects/${cfg.project}/workspace/boxes/${state.boxId}`;
  let error: string | undefined;
  try {
    await fetch(`${base}/stop`, { method: "POST", headers: { authorization: auth },
      signal: AbortSignal.timeout(20_000) }).catch(() => {});
    const res = await fetch(base, { method: "DELETE", headers: { authorization: auth },
      signal: AbortSignal.timeout(30_000) });
    if (!res.ok) error = `delete returned ${res.status}: ${(await res.text()).slice(0, 120)}`;
  } catch (e) {
    error = String((e as Error)?.message ?? e).slice(0, 160);
  }
  // The record goes either way: keeping a pointer to a box we failed to delete
  // only means the next call tries to reuse something that may not be there.
  await ctx.connection.set(null);
  return { boxId: state.boxId, freed: !error, error };
}

export const run9Plugin: Plugin = {
  id: "run9",
  version: "1.0.0",
  tools: [
    {
      name: "run",
      summary:
        "LAST RESORT for JavaScript. Prefer run_js, which is instant and free; this starts a metered " +
        "container and cannot call your other tools. Use it only when you genuinely need npm packages, " +
        "a real filesystem, or more than a few seconds of compute. Call release when you are done with it.",
      parameters: {
        type: "object",
        properties: {
          code: { type: "string", description: "JavaScript, run with `node -e`" },
          install: {
            type: "array", items: { type: "string" },
            description: "npm packages to install first, e.g. ['zod']",
          },
        },
        required: ["code"],
      },
      // Arbitrary code with network and a filesystem: whether that needs a
      // person is the operator's call, and this is where they make it.
      sideEffects: "write",
      idempotency: "none",
    },
    {
      name: "shell",
      summary:
        "Shell in the same metered container as node.run — only for what needs a real machine " +
        "(builds, tests, git). The default image is node:22-alpine: Node and npm are present, " +
        "Python and gcc are NOT, and `apk add --no-cache <pkg>` installs more. An operator may " +
        "have configured a different image; every result reports which one is running, so read " +
        "that instead of probing for it. Call release when finished.",
      parameters: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
      sideEffects: "write",
      idempotency: "none",
    },
    {
      name: "release",
      summary:
        "Destroy the container and everything in it, freeing its compute and storage. Safe to call " +
        "any time; the next run starts a fresh one. Call it as soon as you no longer need the sandbox.",
      parameters: { type: "object", properties: {} },
      sideEffects: "read",
      idempotency: "native",
    },
  ],

  /** Called by the framework when the task ends, so an idle box is not left
   *  running on the tenant's quota because nobody thought to stop it. */
  async release(ctx: PluginContext): Promise<boolean> {
    const r = await stopBox(ctx);
    return r !== null && r.freed;
  },

  async invoke(tool: string, args: Json, ctx: PluginContext): Promise<Json> {
    if (tool === "release") {
      const r = await stopBox(ctx);
      if (!r) return { released: false, note: "nothing was running" };
      return r.freed
        ? { released: true, box: r.boxId, note: "the container and its files are gone; the next run starts fresh" }
        : { released: false, box: r.boxId, error: r.error };
    }
    const cfg = { ...DEFAULTS, ...(ctx.publicConfig as Run9Config) };
    if (!ctx.credential) throw new Error("run9 mount has no credential");
    const cred = JSON.parse(ctx.credential) as Run9Credential;
    const auth = "Basic " + btoa(`${cred.ak}:${cred.sk}`);

    const api = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(cfg.endpoint + path, {
        method,
        headers: { authorization: auth, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(cfg.timeoutMs),
      });
      const text = await res.text();
      let parsed: any = text;
      try { parsed = JSON.parse(text); } catch { /* plain text error */ }
      if (!res.ok) throw new Error(`run9 ${method} ${path} -> ${res.status}: ${String(text).slice(0, 200)}`);
      return parsed;
    };

    // One box per mount, remembered, so an install survives to the next call.
    let state = (await ctx.connection.get()) as BoxState | null;
    if (!state) {
      const boxId = `h-${ctx.caller.tenantId}-${ctx.caller.agentId}`
        .toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 40) + `-${Date.now().toString(36)}`;
      await api("POST", `/projects/${cfg.project}/workspace/boxes`, {
        box_id: boxId, source_image_ref: cfg.image,
        ...(cfg.shape ? { desired_shape: cfg.shape } : {}),
        description: `antiproton ${ctx.caller.tenantId}/${ctx.caller.agentId}`,
      });
      state = { boxId, createdAt: Date.now(), lastUsedAt: Date.now() };
      await ctx.connection.set(state as unknown as Json);
    }

    const wd = cfg.workdir;
    const a = (args ?? {}) as { code?: string; install?: string[]; command?: string };
    let command: string;
    if (tool === "run") {
      if (!a.code) throw new Error("code is required");
      // Install and run in the same directory, or Node resolves modules from
      // wherever the script happens to sit and cannot find what was installed.
      const install = a.install?.length
        ? `npm install --prefix ${wd} --no-audit --no-fund --silent ` +
          `${a.install.map((p) => `'${p.replace(/'/g, "")}'`).join(" ")} >/dev/null 2>&1; `
        : "";
      // The extension picks the module system, and picking it wrongly is not a
      // detail: .mjs makes `require` undefined, and a model writing Node by hand
      // reaches for `require` first. CommonJS is the forgiving default because
      // dynamic `import()` still works inside it; only static `import`/`export`
      // syntax needs ESM, and that is what this looks for.
      const esm = /^\s*(import\s[\s\S]*?from\s|import\s*[{("']|export\s)/m.test(a.code);
      const file = esm ? `${wd}/run.mjs` : `${wd}/run.cjs`;
      // Written to a file rather than passed inline, so quoting cannot mangle it.
      const b64 = btoa(unescape(encodeURIComponent(a.code)));
      command = `mkdir -p ${wd} && cd ${wd} && ${install}` +
        `echo '${b64}' | base64 -d > ${file} && node ${file}`;
    } else if (tool === "shell") {
      if (!a.command) throw new Error("command is required");
      command = `mkdir -p ${wd} && cd ${wd} && ${a.command}`;
    } else {
      throw new Error(`unknown tool: ${tool}`);
    }

    const started = await api(
      "POST", `/projects/${cfg.project}/workspace/boxes/${state.boxId}/execs`,
      { command: [cfg.shell, "-lc", cfg.shellPrefix ? `${cfg.shellPrefix}${command}` : command] },
    );
    const execId = started.exec_id as string;

    const deadline = Date.now() + cfg.timeoutMs;
    for (;;) {
      const rec = await api("GET", `/projects/${cfg.project}/workspace/execs/${execId}`);
      if (["succeeded", "failed", "killed", "cancelled", "timeout"].includes(rec.state)) {
        const out = String(rec.output_summary ?? "");
        await ctx.connection.set({ ...state, lastUsedAt: Date.now() } as unknown as Json);
        return {
          state: rec.state,
          exitCode: rec.exit_code ?? null,
          reminder: "call run9.release when you no longer need the sandbox",
          output: out.slice(0, cfg.maxOutputBytes),
          truncated: out.length > cfg.maxOutputBytes,
          box: state.boxId,
          // So the agent learns the environment from a result it already has,
          // instead of spending turns probing for an interpreter.
          image: cfg.image,
        };
      }
      if (Date.now() > deadline) {
        // Leaving it running would burn the tenant's quota unattended.
        await api("POST", `/projects/${cfg.project}/workspace/execs/${execId}/kill`).catch(() => {});
        throw new Error(`run9 exec ${execId} exceeded ${cfg.timeoutMs}ms and was killed`);
      }
      await new Promise((r) => setTimeout(r, 1200));
    }
  },
};
