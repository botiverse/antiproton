/**
 * Types of the vendored ./compaction.js (antiproton's, not upstream's): upstream's `CompactionTask`. The `poll`
 * phase it adds is not part of the type.
 */
import type { CompactionTask as UpstreamCompactionTask } from "@earendil-works/pi-durable";

export declare const CompactionTask: typeof UpstreamCompactionTask;
