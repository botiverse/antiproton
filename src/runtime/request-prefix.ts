/**
 * What one pi085 model call shares with the call before it in the same conversation, as hashes and counts: the
 * reading that tells a provider's cache miss caused by a changed prefix from one that was not.
 *
 * Written when the job row is (src/runtime/pi-agent.ts `#startJob`) and carried on the call's `model.call` trace row
 * when its answer lands (src/store/pi-storage.ts), so it reaches the production export with no content: the system
 * prompt's and the tool list's sha256, how many messages the request has and how many of them, from the front, are the
 * previous request's messages byte for byte, and what broke the prefix when something did.
 */
import { createHash } from "node:crypto";
import { canonJson } from "../core/canon-json.ts";

type Sql = { exec(query: string, ...bindings: unknown[]): { toArray(): any[] } };

export interface RequestPrefix {
  systemSha256: string;
  toolsSha256: string;
  /** Messages in this request, and their characters (as JSON). */
  messages: number;
  chars: number;
  /** Leading messages identical to the previous request's, and their characters; 0 when the system prompt or the tools moved. */
  sharedMessages: number;
  sharedChars: number;
  /**
   * Where this request stops being the previous one followed by more: `system` or `tools` when either moved,
   * `message` when an earlier message did, null when the previous request is all a prefix of this one (or there was
   * none: `first`).
   */
  broken: "system" | "tools" | "message" | null;
  first: boolean;
}

const TABLE = `CREATE TABLE IF NOT EXISTS model_request_prefix (
  conversation TEXT PRIMARY KEY, system TEXT NOT NULL, tools TEXT NOT NULL, messages TEXT NOT NULL)`;

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/**
 * The prefix reading of `context` against the last request recorded for `conversation`, which it then replaces.
 * Message hashes are kept 16 hex characters long: a reading, not an identity, and a long conversation keeps one per
 * message.
 */
export function recordRequestPrefix(
  sql: Sql, conversation: string,
  context: { systemPrompt?: unknown; messages?: unknown[]; tools?: unknown },
): RequestPrefix {
  sql.exec(TABLE);
  const systemSha256 = sha(String(context.systemPrompt ?? ""));
  const toolsSha256 = sha(canonJson(context.tools ?? []));
  // Plain JSON, not canonical: a message is serialised by the same code on every call (pi's context, as the job row
  // stores it), so its key order is the same each time, and canonicalising a long conversation costs three times as much.
  const items = (context.messages ?? []).map((m) => { const j = JSON.stringify(m) ?? ""; return [sha(j).slice(0, 16), j.length] as [string, number]; });
  const prev = sql.exec("SELECT system, tools, messages FROM model_request_prefix WHERE conversation = ?", conversation).toArray()[0];
  let sharedMessages = 0, sharedChars = 0;
  let broken: RequestPrefix["broken"] = null;
  if (prev) {
    const before = JSON.parse(String(prev.messages)) as string[];
    if (String(prev.system) !== systemSha256) broken = "system";
    else if (String(prev.tools) !== toolsSha256) broken = "tools";
    else {
      while (sharedMessages < before.length && sharedMessages < items.length && before[sharedMessages] === items[sharedMessages]![0]) {
        sharedChars += items[sharedMessages]![1];
        sharedMessages++;
      }
      if (sharedMessages < before.length) broken = "message";
    }
  }
  sql.exec("INSERT INTO model_request_prefix(conversation, system, tools, messages) VALUES (?,?,?,?)" +
    " ON CONFLICT(conversation) DO UPDATE SET system = excluded.system, tools = excluded.tools, messages = excluded.messages",
    conversation, systemSha256, toolsSha256, JSON.stringify(items.map((i) => i[0])));
  return {
    systemSha256, toolsSha256, messages: items.length, chars: items.reduce((n, i) => n + i[1], 0),
    sharedMessages, sharedChars, broken, first: !prev,
  };
}
