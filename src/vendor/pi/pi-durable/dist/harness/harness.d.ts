/**
 * Types of the vendored ./harness.js (antiproton's, not upstream's): upstream's `Harness`, with the one option
 * and the one inspection field the patch adds. See the header of ./scheduler.js.
 */
import type { Context } from "@earendil-works/chord";
import type {
  ConversationId, Harness as UpstreamHarness, HarnessOptions as UpstreamHarnessOptions, Storage, TaskId,
  ToolRegistration,
} from "@earendil-works/pi-durable";

/** A task's invocation started `runtime.sleep(until)`: until then it runs no code. */
export type SleepNotice = { readonly taskId: TaskId; readonly conversationId: ConversationId; readonly until: number };

export type HarnessOptions<Tool extends ToolRegistration = ToolRegistration> = UpstreamHarnessOptions<Tool> & {
  /** Called synchronously, once per sleep, when a task's invocation starts sleeping. Must not throw or block. */
  readonly onSleep?: (sleep: SleepNotice) => void;
};

/** What `inspect()` adds to a running task: present exactly while its invocation is inside `runtime.sleep`. */
export type RunningSleep = { readonly kind: "running"; readonly sleepingUntil?: number };

export type Harness = UpstreamHarness;
export declare const Harness: {
  open<Tool extends ToolRegistration>(storage: Storage, options: HarnessOptions<Tool>, context: Context): Promise<Harness>;
};
