/** Types of the vendored ./migrations.js (antiproton's, not upstream's). See its header. */
import type { SqliteMigration } from "@earendil-works/pi-durable/storage/sqlite";
import type { SqliteSyncDatabase } from "./storage.js";

export type { SqliteMigration };
export declare const SQLITE_MIGRATIONS: readonly SqliteMigration[];
export declare const CURRENT_SQLITE_SCHEMA_VERSION: number;
/** Apply all pending schema migrations atomically, in one synchronous transaction. */
export declare function applySqliteMigrations(database: SqliteSyncDatabase, migrations?: readonly SqliteMigration[]): Promise<void>;
