/**
 * `POST /admin/migrate-engine?tenantId=&agentId=[&op=migrate|revert][&dryRun=1]` (operator token only): move one agent
 * from the pi085 engine to pd, or a migrated one back (src/runtime/pd-migrate.ts says what moves and what is dropped).
 * `dryRun` reports what would be imported or dropped and writes nothing.
 *
 * Both ids are required, never defaulted: this route writes, and an agent named by a default is one nobody chose.
 * With no operator token configured it refuses, as the read routes do (admin-read.ts). The object answers null for an
 * agent it does not hold (404), and a refusal — the agent is busy, or was created on pd — is a 409 with the reason.
 */
import { isOperator } from "./auth.ts";
import { answer } from "./admin-read.ts";
import { agentObjectName } from "./object-name.ts";

export type MigrateOp = "migrate" | "revert";

export interface EngineMigration {
  /** Null when the object holds no such agent. */
  migrateEngine(tenantId: string, agentId: string, op: MigrateOp, dryRun: boolean): Promise<{ ok: boolean } | null>;
}

export async function adminMigrateEngine(
  request: Request,
  token: string | undefined,
  open: (tenantId: string, agentId: string) => EngineMigration,
): Promise<Response> {
  if (!isOperator(token, request.headers.get("x-harness-token"))) return answer({ error: "unauthorized" }, 401);
  if (request.method !== "POST") return answer({ error: "POST" }, 405, { allow: "POST" });
  const url = new URL(request.url);
  const tenantId = url.searchParams.get("tenantId") ?? "";
  const agentId = url.searchParams.get("agentId") ?? "";
  const op = url.searchParams.get("op") ?? "migrate";
  if (op !== "migrate" && op !== "revert") return answer({ error: `op is migrate or revert, not ${JSON.stringify(op)}` }, 400);
  const dry = url.searchParams.get("dryRun");
  if (dry !== null && !["1", "true", "0", "false"].includes(dry)) return answer({ error: "dryRun is 1, true, 0 or false" }, 400);
  if (!tenantId || !agentId) return answer({ error: "tenantId and agentId are required" }, 400);
  try {
    agentObjectName(tenantId, agentId);
  } catch (e) {
    return answer({ error: String((e as Error)?.message ?? e) }, 400);
  }
  const out = await open(tenantId, agentId).migrateEngine(tenantId, agentId, op, dry === "1" || dry === "true");
  if (out === null) return answer({ error: `no such agent: ${tenantId}/${agentId}` }, 404);
  return answer(out, out.ok ? 200 : 409);
}
