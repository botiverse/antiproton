/**
 * One structured line per event worth finding afterwards, for the deployment's log store (Workers Logs
 * indexes the JSON fields). Silent until a deployment installs a sink, so tests and local runs print
 * nothing; cf/src/index.ts installs `console.log`.
 *
 * Never a credential, a code, a state or a hook id: fields name what happened and to whom, and a URL
 * is logged as its route, not as sent.
 */
export type LogFields = Record<string, string | number | boolean | null | undefined>;

let sink: ((line: string) => void) | null = null;

export function setLogSink(write: ((line: string) => void) | null): void {
  sink = write;
}

export function logEvent(evt: string, fields: LogFields = {}): void {
  if (!sink) return;
  try {
    sink(JSON.stringify({ evt, ...fields }));
  } catch {
    // A log line is never worth a failed request.
  }
}

/** A path with its ids and secrets folded, so a line can be grouped by route and carries nothing that opens anything. */
export function routeOf(path: string): string {
  return path
    .replace(/^\/hooks\/[^/]+/, "/hooks/:hook")
    .replace(/\/(raft_[^/]+|[0-9a-f]{8}-[0-9a-f-]{27,}|[0-9A-HJKMNP-TV-Z]{26}|con_[A-Za-z0-9]+|evt_[A-Za-z0-9]+)(?=\/|$)/g, "/:id");
}
