#!/usr/bin/env bash
# Start/stop the two AppWorld servers deterministically.
#
# Written after losing an hour to it: servers started in an earlier shell kept
# holding 8799/8800, later ones failed to bind and died, and every test silently
# hit the OLD process — including one running pre-patch code. Always free the
# ports by listener, never by process-name pattern.
#
#   bench/appworld/serve.sh start|stop|status
set -u
VENV="${APPWORLD_VENV:-$HOME/appworld-env}"
ROOT="${APPWORLD_ROOT:-$HOME}"
LOGS="${APPWORLD_LOGS:-/tmp/appworld-logs}"
API_PORT="${AW_API_PORT:-8800}"
ENV_PORT="${AW_ENV_PORT:-8799}"

free_port() {
  local port=$1 pids
  pids=$( (ss -ltnp 2>/dev/null || netstat -ltnp 2>/dev/null) \
          | grep -oE "[0-9.]+:$port .*pid=[0-9]+" | grep -oE "pid=[0-9]+" | cut -d= -f2 | sort -u )
  for p in $pids; do kill "$p" 2>/dev/null; done
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    (ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null) | grep -q ":$port " || return 0
    sleep 1
  done
  for p in $pids; do kill -9 "$p" 2>/dev/null; done
  sleep 1
}

case "${1:-status}" in
  stop) free_port "$API_PORT"; free_port "$ENV_PORT"; echo "stopped" ;;
  start)
    mkdir -p "$LOGS"
    free_port "$API_PORT"; free_port "$ENV_PORT"
    cd "$ROOT" || exit 1
    "$VENV/bin/appworld" serve apis --port "$API_PORT" --no-show-usage > "$LOGS/apis.log" 2>&1 &
    "$VENV/bin/appworld" serve environment --port "$ENV_PORT" --no-show-usage > "$LOGS/env.log" 2>&1 &
    for _ in $(seq 1 40); do
      if curl -sf -o /dev/null "http://localhost:$API_PORT/" \
         && curl -sf -o /dev/null "http://localhost:$ENV_PORT/"; then
        echo "ready: apis=$API_PORT env=$ENV_PORT (logs in $LOGS)"; exit 0
      fi
      sleep 1
    done
    echo "servers did not become ready; see $LOGS" >&2; exit 1 ;;
  status)
    (ss -ltnp 2>/dev/null || netstat -ltnp 2>/dev/null) | grep -E ":$API_PORT |:$ENV_PORT " || echo "not running" ;;
esac
