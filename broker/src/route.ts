/**
 * What the broker will allow, decided before anything is forwarded.
 *
 * Separated from the Worker because this is the whole security argument, and a
 * rule that can only be exercised by standing up a Worker with a real key is a
 * rule that never goes red on its own. Four times today the same lesson: the
 * decision is a pure function, the plumbing is not.
 *
 * An allowlist, not a proxy. A general proxy inherits every endpoint run9 will
 * ever add, including the ones we have not thought about, and its ownership
 * story is "we remembered to check". This knows the seven paths the sandbox
 * plugin actually calls and refuses everything else — so a new endpoint is a
 * deliberate line here rather than a hole that was always open.
 */

/** Who a token belongs to. The broker never sees a run9 key from a caller. */
export interface Caller {
  tenantId: string;
  agentId: string;
}

/** What the broker knows it owns, asked one id at a time. */
export interface Owned {
  box(id: string): boolean;
  exec(id: string): boolean;
  snap(id: string): boolean;
}

export type Decision =
  /** Forward to run9 under the shared key, unchanged. */
  | { kind: "forward"; record?: Record }
  /** Answer from our own records; never ask run9. */
  | { kind: "answer"; answer: "list-boxes" }
  | { kind: "refuse"; status: number; reason: string };

/** A fact worth writing down when the call succeeds. */
export type Record =
  | { of: "box-created" }
  | { of: "box-gone"; id: string }
  | { of: "exec-created"; box: string }
  | { of: "snap-created"; from: string };

/**
 * The project is ours, not the caller's.
 *
 * These patterns took any project name until a test asked for
 * `/projects/other/workspace/boxes/b-mine` and got a forward. The shared key
 * belongs to one project; a path naming a different one would have used our
 * key somewhere we never meant to point it, and the ownership check would have
 * waved it through because the box id was genuinely the caller's — an id is
 * only unique within the project it lives in.
 *
 * So the broker matches its own project and nothing else. The caller still
 * writes a project into the path, because the plugin builds run9's URL shape
 * and the point is to be a drop-in `endpoint`, but it is checked rather than
 * used.
 */
const paths = (project: string) => {
  const p = project.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return {
    BOXES: new RegExp(`^/projects/${p}/workspace/boxes$`),
    BOX: new RegExp(`^/projects/${p}/workspace/boxes/([^/]+)$`),
    BOX_SUB: new RegExp(`^/projects/${p}/workspace/boxes/([^/]+)/(stop|secrets|execs)$`),
    EXEC: new RegExp(`^/projects/${p}/workspace/execs/([^/]+)$`),
    EXEC_KILL: new RegExp(`^/projects/${p}/workspace/execs/([^/]+)/kill$`),
    SNAP_FORK: new RegExp(`^/projects/${p}/workspace/snaps/([^/]+)/fork$`),
  };
};

/**
 * The one rule, stated once: an id the caller did not create is not theirs.
 *
 * Note what this is *not*: it is not "filter the answer to what belongs to
 * them". Filtering is what the plugin does today under the shared key, and it
 * is correct only for as long as every caller remembers to do it. Here the
 * request is refused, so the boundary holds without anyone remembering.
 */
export function decide(method: string, path: string, owned: Owned, project: string): Decision {
  const m = method.toUpperCase();
  const { BOXES, BOX, BOX_SUB, EXEC, EXEC_KILL, SNAP_FORK } = paths(project);

  if (BOXES.test(path)) {
    // Listing is the whole reason this exists. Forwarding it would hand back
    // every box in the shared project, which is precisely the thing a tenant
    // must not be able to see — and no amount of filtering afterwards changes
    // what was already sent to us to filter.
    if (m === "GET") return { kind: "answer", answer: "list-boxes" };
    if (m === "POST") return { kind: "forward", record: { of: "box-created" } };
    return refuse(405, m, path);
  }

  const box = BOX.exec(path);
  if (box) {
    const id = box[1]!;
    if (!owned.box(id)) return notYours("container", id);
    if (m === "DELETE") return { kind: "forward", record: { of: "box-gone", id } };
    if (m === "GET") return { kind: "forward" };
    return refuse(405, m, path);
  }

  const sub = BOX_SUB.exec(path);
  if (sub) {
    const [, id, what] = sub as unknown as [string, string, string];
    if (!owned.box(id)) return notYours("container", id);
    if (m !== "POST") return refuse(405, m, path);
    return what === "execs"
      ? { kind: "forward", record: { of: "exec-created", box: id } }
      : { kind: "forward" };
  }

  const exec = EXEC.exec(path) ?? EXEC_KILL.exec(path);
  if (exec) {
    // An exec is reachable by its own id, without naming the box it runs in.
    // So ownership of execs is recorded when one is created, rather than
    // derived at read time from a box id the path does not carry.
    const id = exec[1]!;
    if (!owned.exec(id)) return notYours("command", id);
    return { kind: "forward" };
  }

  const fork = SNAP_FORK.exec(path);
  if (fork) {
    const id = fork[1]!;
    if (!owned.snap(id)) return notYours("filesystem", id);
    if (m !== "POST") return refuse(405, m, path);
    return { kind: "forward", record: { of: "snap-created", from: id } };
  }

  // Everything else, including anything run9 adds later. A path nobody has
  // reasoned about is not a path this forwards.
  return refuse(404, m, path);
}

const notYours = (what: string, id: string): Decision => ({
  kind: "refuse",
  status: 404,
  // Deliberately the same answer as "no such thing". Distinguishing "not
  // yours" from "does not exist" would let a caller enumerate other tenants'
  // ids by reading the difference.
  reason: `no such ${what}: ${id}`,
});

const refuse = (status: number, method: string, path: string): Decision => ({
  kind: "refuse",
  status,
  reason: status === 405 ? `${method} is not allowed on ${path}` : `this service does not serve ${path}`,
});

/**
 * The credential a tenant presents, whatever header it arrives in.
 *
 * The plugin sends `Basic base64(ak:sk)` on every call, because that is run9's
 * scheme and this service is meant to be a drop-in `endpoint` — the mount's
 * credential shape is declared per plugin and we deliberately did not change
 * it. So a tenant's key is issued as an ak/sk pair like run9's, and the pair is
 * what is hashed. Written after reading Piper's plugin-side change and finding
 * that my first version read `Bearer`, which nothing sends: the two halves
 * would have failed to speak on the first call.
 *
 * `Bearer` still works, for the operator routes and for anything of ours that
 * is not the plugin.
 *
 * **Why a pair and not one token.** Issuing an ak/sk pair, shaped like run9's,
 * keeps the plugin's `CredentialSpec` — two keys — exactly as it is. A single
 * token would have been a different shape, and a different shape per
 * deployment is the thing that forces `credential` to become a per-mount
 * declaration. That change is real and is coming, but it is owed to MCP and to
 * a second sandbox provider; this service does not need it and should not be
 * the reason it arrives early (Piper, 2026-09-12).
 */
export function presented(header: string | null): string | null {
  const raw = (header ?? "").trim();
  const bearer = /^Bearer\s+(.+)$/i.exec(raw);
  if (bearer) return bearer[1]!.trim();
  const basic = /^Basic\s+(.+)$/i.exec(raw);
  if (!basic) return null;
  try {
    // `ak:sk` as one string: the pair is the credential, and splitting it would
    // invite a lookup on the half that is not secret.
    return atob(basic[1]!.trim());
  } catch {
    return null;
  }
}
