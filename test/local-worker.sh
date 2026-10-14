# Sourced by the suites that run the conformance worker under `wrangler dev` (pi-storage-do.sh,
# control-plane-d1.sh). Two things they each got wrong on a machine several agents test on at once
# (2026-09-15):
# - A fixed port. Two runs at the same time met on it, and one run's requests were answered by the
#   other's server, with the other tree's code. Unless PORT is set, a free port is taken now.
# - Cleanup by port. Killing whatever listens on the port can kill someone else's server, and killing
#   only the listener stopped workerd and left npm and wrangler running: pi-storage-do.sh left one
#   orphaned tree per run. Only the tree this run started is stopped, children first.

# A port nothing listens on at this moment.
free_port() {
  python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()'
}

kill_tree() {
  local pid="$1" child
  for child in $(pgrep -P "$pid" 2>/dev/null || true); do kill_tree "$child"; done
  kill "$pid" 2>/dev/null || true
}

# start_worker LOG ARGS...: `wrangler dev` on $PORT in the background; its pid in $WORKER_PID.
start_worker() {
  local log="$1"; shift
  npx wrangler dev --config wrangler.conformance.jsonc --local --port "$PORT" --inspector-port 0 "$@" >"$log" 2>&1 &
  WORKER_PID=$!
}

stop_worker() {
  if [ -n "${WORKER_PID:-}" ]; then kill_tree "$WORKER_PID"; WORKER_PID=""; fi
}

# await_answer PATH OUT RUN_LIMIT: GET PATH from the worker into OUT, retrying while it starts, within one
# overall deadline. It used to be 60 tries of `curl -m RUN_LIMIT`, which bounds each try and not the
# total: a worker that accepted every connection and never answered held a suite for 60 x 300 s, five
# hours (#766). The deadline keeps the old envelope instead — a minute to start, then RUN_LIMIT for the
# run — so a slow but healthy worker passes exactly as it did, and a hung one fails in minutes.
# Returns non-zero if no answer arrived in time.
await_answer() {
  local path="$1" out="$2" left deadline=$((SECONDS + 60 + $3))
  while sleep 1; left=$((deadline - SECONDS)); [ "$left" -gt 0 ]; do
    if curl -sf -m "$left" "http://127.0.0.1:$PORT$path" -o "$out"; then return 0; fi
  done
  return 1
}

PORT="${PORT:-$(free_port)}"
WORKER_PID=""
