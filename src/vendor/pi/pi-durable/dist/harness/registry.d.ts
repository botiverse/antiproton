/**
 * Types of the vendored ./registry.js (antiproton's, not upstream's): upstream's, unchanged. Only the built-in
 * compaction task it holds differs, and a task definition's type does not show its phases.
 */
import type { createRegistry as upstreamCreateRegistry } from "@earendil-works/pi-durable";

export declare const createRegistry: typeof upstreamCreateRegistry;
