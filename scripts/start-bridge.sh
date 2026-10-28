#!/usr/bin/env bash
# Start the phone bridge in one terminal.
# Starts opencode, the phone server, the Cloudflare tunnel, caffeinate,
# and the context snapshot refresher.
# Ctrl-C stops all of them.

set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

for cmd in opencode node cloudflared; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "error: $cmd not found in PATH" >&2
    exit 1
  fi
done

for port in 4096 8787; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "error: port $port is already in use; stop the old bridge first" >&2
    exit 1
  fi
done

if [[ ! -f "$HOME/.cloudflared/config.yml" ]]; then
  echo "error: $HOME/.cloudflared/config.yml not found" >&2
  exit 1
fi

pids=()

kill_tree() {
  local pid=$1 child
  for child in $(pgrep -P "$pid" 2>/dev/null); do
    kill_tree "$child"
  done
  kill "$pid" 2>/dev/null
}

cleanup() {
  trap - INT TERM EXIT
  echo
  echo "Stopping bridge..."
  for pid in "${pids[@]}"; do
    kill_tree "$pid"
  done
  wait 2>/dev/null
  echo "Bridge stopped."
}

trap cleanup INT TERM EXIT

echo "Starting bridge from $ROOT"

/usr/bin/caffeinate -i &
pids+=($!)

# Refresh once before the phone server starts, then keep it fresh.
echo "Refreshing context snapshot..."
if ! node scripts/context.mjs --once; then
  echo "warning: snapshot refresh failed; using existing context/snapshot.md" >&2
fi

CONTEXT_INTERVAL_SECONDS="${CONTEXT_INTERVAL_SECONDS:-300}"
export CONTEXT_INTERVAL_SECONDS

opencode serve --hostname 127.0.0.1 --port 4096 &
pids+=($!)

node scripts/phone-server.mjs &
pids+=($!)

cloudflared tunnel --config "$HOME/.cloudflared/config.yml" run marchforth-phone &
pids+=($!)

node scripts/context.mjs &
pids+=($!)

echo "PIDs: ${pids[*]}"
echo "Press Ctrl-C to stop everything."

wait
