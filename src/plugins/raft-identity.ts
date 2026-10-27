/**
 * Which Raft agent this antiproton agent is, as its Raft mount last heard it from Raft — for a plugin that has to
 * check a credential someone hands it against that identity (stamp: a session given to the wrong agent is presented
 * by two holders, and the second refresh revokes every token of that Stamp identity, on every machine).
 *
 * Kept by the raft plugin from the `GET /context` its listing already makes (`snapshotTools`), beside a digest of the
 * credential that answered: a row whose digest is not the mount's credential now is from a credential since replaced,
 * and reads as unknown. Read by another plugin only through `ctx.sibling`, the mount's own database, so no second
 * plugin ever sends the Raft credential anywhere. Kept apart from raft.ts so a reader does not load the raft plugin.
 */
import type { Json } from "../core/types.ts";
import type { PluginContext } from "./types.ts";

/** The raft plugin's store for what `GET /context` said (raft.ts `CONTEXT_STORE`). */
export const RAFT_CONTEXT_STORE = "context";
/** The key the identity is kept under in that store. */
export const RAFT_IDENTITY_KEY = "identity";
/** Where provisioning puts an agent's Raft mount (cf/src/provision/steps.ts `PROVISION_MOUNT_ALIAS`). */
export const RAFT_MOUNT_ALIAS = "raft";

export interface RaftIdentity { agentId: string; serverId: string }

/** A credential as the row may name it: a digest, never the credential. */
async function credentialDigest(credential: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`antiproton raft identity v1\u0000${credential}`));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Keep what Raft said this mount's credential is. Never fails the caller: a missing row only makes a reader refuse. */
export async function keepRaftIdentity(ctx: PluginContext, agentId: unknown, serverId: unknown): Promise<void> {
  if (!ctx.credential || typeof agentId !== "string" || !agentId || typeof serverId !== "string" || !serverId) return;
  try {
    await ctx.db.put(RAFT_CONTEXT_STORE, {
      agentId, serverId, credential: await credentialDigest(ctx.credential), at: Date.now(),
    } as unknown as Json, RAFT_IDENTITY_KEY);
  } catch (e) {
    console.warn(`raft identity could not be kept for mount ${ctx.alias}: ${String((e as Error)?.message ?? e)}`);
  }
}

/** Whether this Raft mount has an identity kept under the credential it holds now (read from its own database). */
export async function raftIdentityKept(ctx: PluginContext): Promise<boolean> {
  if (!ctx.credential) return true;
  const row = await ctx.db.get(RAFT_CONTEXT_STORE, RAFT_IDENTITY_KEY).catch(() => null) as Record<string, unknown> | null;
  return !!row && typeof row.agentId === "string" && typeof row.serverId === "string" &&
    row.credential === await credentialDigest(ctx.credential);
}

/**
 * This agent's Raft identity, from its Raft mount, or null when it cannot be told: no mount named `raft`, a mount of
 * another plugin under that name, no credential, no kept row, or a row kept under a credential since replaced.
 */
export async function raftIdentityOf(ctx: PluginContext): Promise<RaftIdentity | null> {
  if (typeof ctx.sibling !== "function") return null;
  const raft = await ctx.sibling(RAFT_MOUNT_ALIAS).catch(() => null);
  if (!raft || raft.plugin !== "raft" || !raft.credential) return null;
  const row = await raft.db.get(RAFT_CONTEXT_STORE, RAFT_IDENTITY_KEY).catch(() => null) as Record<string, unknown> | null;
  if (!row || typeof row !== "object") return null;
  if (typeof row.agentId !== "string" || typeof row.serverId !== "string" || typeof row.credential !== "string") return null;
  if (row.credential !== await credentialDigest(raft.credential)) return null;
  return { agentId: row.agentId, serverId: row.serverId };
}
