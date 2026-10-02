/**
 * The half of the workspace and usage reads that runs inside the agent's own object: its state rows,
 * the files its mounts hold, and the usage it has not sent yet. Each is one RPC on the object
 * (cf/src/index.ts `surface*`); none writes.
 */
import type { AgentRuntime } from "../runtime.ts";
import type { HeldListing, HeldRead } from "../../../src/plugins/types.ts";

/** The task id a look is made under: no task is running for it, and no row records it. */
const LOOK = "workspace-look";

export async function stateList(rt: AgentRuntime, tenantId: string, agentId: string, prefix: string, limit: number) {
  await rt.ready();
  return (await rt.store.listState(tenantId, agentId, prefix, limit)).map((r) => ({ key: r.key, bytes: r.bytes, updatedAt: r.updatedAt }));
}

export async function stateGet(rt: AgentRuntime, tenantId: string, agentId: string, key: string) {
  await rt.ready();
  const got = await rt.store.getState(tenantId, agentId, key);
  return got ? { value: got.value, ref: got.ref, bytes: got.bytes, updatedAt: got.updatedAt } : null;
}

export async function heldFiles(
  rt: AgentRuntime, tenantId: string, agentId: string,
  op: { op: "list"; path: string } | { op: "read"; path: string; maxBytes: number },
): Promise<HeldListing | HeldRead> {
  await rt.ready();
  return rt.gateway().heldFiles({ tenantId, agentId, taskId: LOOK }, op);
}
