#!/usr/bin/env node
// What happened, from the deployment's log store (Workers Logs), without a tail opened beforehand.
//
//   node cf/scripts/logs.mjs [--preview] --agent <agentId | Raft agent id> [--since 60m]
//   node cf/scripts/logs.mjs [--preview] --trace <X-Raft-Trace-Id>
//   node cf/scripts/logs.mjs [--preview] --request <X-Request-Id>
//
// Needs CF_API_TOKEN (Workers Observability read) and R2_ACCOUNT_ID (the account) in the environment,
// as ~/.secrets/antiproton.env provides. Prints one line per event, oldest first. The lines are the
// ones src/core/log.ts writes: http, trace, raft.call, alarm.*, connect.*.
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const script = args.includes("--preview") ? "antiproton-preview" : "antiproton";
const sinceArg = opt("--since") ?? "60m";
const unit = { s: 1, m: 60, h: 3600, d: 86400 }[sinceArg.slice(-1)] ?? 60;
const sinceMs = Number.parseFloat(sinceArg) * unit * 1000;
let key, value;
if (opt("--agent")) {
  key = "agentId"; value = opt("--agent");
  if (!value.startsWith("raft_") && /^[0-9a-f-]{36}$/.test(value)) value = `raft_${value}`;
} else if (opt("--trace")) { key = "traceId"; value = opt("--trace"); }
else if (opt("--request")) { key = "requestId"; value = opt("--request"); }
else { console.error("give --agent, --trace or --request"); process.exit(2); }

const { CF_API_TOKEN: token, R2_ACCOUNT_ID: account } = process.env;
if (!token || !account) { console.error("CF_API_TOKEN and R2_ACCOUNT_ID are required"); process.exit(2); }
const now = Date.now();
const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/workers/observability/telemetry/query`, {
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify({
    queryId: `logs-${key}`, view: "events", limit: 500,
    timeframe: { from: now - sinceMs, to: now },
    parameters: { filters: [
      { key, operation: "eq", type: "string", value },
      { key: "$metadata.service", operation: "eq", type: "string", value: script },
    ] },
  }),
});
const body = await res.json();
if (!body.success) { console.error(JSON.stringify(body.errors)); process.exit(1); }
const events = (body.result?.events?.events ?? []).sort((a, b) => a.timestamp - b.timestamp);
for (const e of events) {
  const { evt, ...rest } = e.source ?? {};
  const t = new Date(e.timestamp).toISOString().slice(11, 23);
  const fields = Object.entries(rest).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => `${k}=${v}`).join(" ");
  console.log(`${t} ${String(evt ?? e.$workers?.eventType ?? "?").padEnd(16)} ${fields}`);
}
if (!events.length) console.log(`no events for ${key}=${value} on ${script} in the last ${sinceArg}`);
