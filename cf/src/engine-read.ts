/**
 * What the console and the operator read about an agent's engine: its model jobs, what is still owed an answer, its
 * compactions, what its lane is doing, the runs that failed with no entry, and which tables hold all that.
 *
 * Each read asks the engine first (`isPd`) and goes to that engine's own records. An agent on `pd` keeps them in
 * pi-durable's tables and `ap_*` (src/runtime/pd-transcript.ts); pi 0.85's tables exist for it too and stay empty, so a
 * read that went to them would show a pd agent with no jobs, no compactions and nothing outstanding rather than fail.
 *
 * The pd arms are the readers; the pi085 arms are kept apart at the bottom of this file, each a function of its own
 * that nothing else calls, so removing pi 0.85 removes that block and the `isPd` test above each call. Every read is a
 * SELECT, and a table that is not there reads as empty.
 */
import { recordedEngine } from "../../src/runtime/durable-agent.ts";
import {
  pdFailedRuns, pdOutstandingJobs, readPdCompactions, readPdLiveTasks, readPdModelJobs,
} from "../../src/runtime/pd-transcript.ts";
import { prefixedNamespace } from "../../src/store/sql-namespace.ts";
import { PI_DURABLE_TABLES } from "../../src/store/pi-durable-sqlite.ts";
import { AP_TABLES } from "../../src/store/ap-store.ts";
import { failedRuns } from "../../src/runtime/pi-agent.ts";
import type { SqlHost } from "../../src/store/pi-storage.ts";

type Sql = SqlHost["sql"];
type ReadSql = Parameters<typeof readPdModelJobs>[0];
const pd = (sql: Sql) => sql as unknown as ReadSql;

/** Whether this object's agent runs on the pd engine; a plain read, as `recordedEngine` says. */
export function isPd(sql: Sql): boolean {
  return recordedEngine(sql as Parameters<typeof recordedEngine>[0]) === "pd";
}

/** A model job as the console lists it: the row's own column names, which the pi085 rows have always had. */
export interface ModelJobRow { id: string; created_at: number; answered_at: number | null; request_bytes: number }

/** A run that ended failed and left no transcript entry, shown in the transcript as `model.failed`. */
export interface FailedRun { seq: number; operationId: string; code: string; message: string; at: number }

/** The object's last `limit` model jobs, newest first, answered ones included. */
export function readModelJobs(sql: Sql, limit: number): ModelJobRow[] {
  if (!isPd(sql)) return pi085ModelJobs(sql, limit);
  return readPdModelJobs(pd(sql), limit)
    .map((j) => ({ id: j.id, created_at: j.createdAt, answered_at: j.answeredAt, request_bytes: j.requestBytes }));
}

/** How many model jobs are still owed an answer, counted as the engine counts them. */
export function outstandingModelJobs(sql: Sql): number {
  return isPd(sql) ? pdOutstandingJobs(pd(sql)) : pi085OutstandingJobs(sql);
}

/** Compaction entries, newest first, at most 20, with the size of each stored entry. */
export function readCompactions(sql: Sql, session: string): Array<{ id: string; seq: number; timestamp: number; bytes: number }> {
  return isPd(sql) ? readPdCompactions(pd(sql), session, 20) : pi085Compactions(sql);
}

/** What the lane is doing: pd's unfinished tasks, or pi 0.85's lane values. */
export function readLane(sql: Sql): unknown[] {
  return isPd(sql) ? readPdLiveTasks(pd(sql), 40) : pi085Lane(sql);
}

/** Runs of `session` that failed before leaving any entry, oldest first. */
export function readFailedRuns(sql: Sql, session: string): FailedRun[] {
  return isPd(sql) ? pdFailedRuns(pd(sql), session) : failedRuns(sql, session);
}

/** The engine's own tables, for the console's table counts. */
export function engineTables(sql: Sql): string[] {
  if (!isPd(sql)) return PI085_TABLES;
  return [
    ...AP_TABLES.map((t) => prefixedNamespace("ap").qualify(t, "table")),
    ...PI_DURABLE_TABLES.map((t) => prefixedNamespace("pd").qualify(t, "table")),
  ];
}

/**
 * The console's storage panel (`AgentDO.uiStorage`), the part of it that is the engine's: its tables, its lane, its
 * last 20 model jobs, `session`'s compactions, and how many jobs are still owed an answer.
 */
export function readEngineStorage(sql: Sql, session: string) {
  return {
    tables: engineTables(sql),
    lane: readLane(sql),
    modelJobs: readModelJobs(sql, 20),
    compactions: readCompactions(sql, session),
    outstanding: outstandingModelJobs(sql),
  };
}

const hasTable = (sql: Sql, name: string) =>
  sql.exec("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", name).toArray().length > 0;

// ---- pi 0.85 -----------------------------------------------------------------------------------------------------
// Read only for an agent that is not on pd. pi 0.85's console has always read the main conversation's tables here,
// whatever conversation was asked about, and these keep doing exactly that.

const PI085_TABLES = ["pi_entries", "pi_usage", "pi_values", "pi_list", "pi_meta", "pi_model_jobs"];

function pi085ModelJobs(sql: Sql, limit: number): ModelJobRow[] {
  return hasTable(sql, "pi_model_jobs")
    ? sql.exec(`SELECT id, created_at, answered_at, LENGTH(request) AS request_bytes
                  FROM pi_model_jobs ORDER BY created_at DESC LIMIT ?`, limit).toArray() as any[]
    : [];
}

function pi085OutstandingJobs(sql: Sql): number {
  return hasTable(sql, "pi_model_jobs")
    ? Number((sql.exec("SELECT COUNT(*) AS n FROM pi_model_jobs WHERE answer IS NULL").toArray()[0] as any ?? {}).n ?? 0)
    : 0;
}

function pi085Compactions(sql: Sql): Array<{ id: string; seq: number; timestamp: number; bytes: number }> {
  return hasTable(sql, "pi_entries")
    ? sql.exec(`SELECT id, seq, timestamp, LENGTH(body) AS bytes FROM pi_entries
                  WHERE type='compaction' ORDER BY seq DESC LIMIT 20`).toArray() as any[]
    : [];
}

function pi085Lane(sql: Sql): unknown[] {
  return hasTable(sql, "pi_values")
    ? sql.exec("SELECT namespace, key, seq FROM pi_values WHERE namespace LIKE 'pi.%' LIMIT 40").toArray()
    : [];
}
