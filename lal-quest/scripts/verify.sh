#!/usr/bin/env bash
# Build, serve, drive the app in a real browser, tear it all down.
#
# The server is started, used and killed inside this script on purpose. Leaving
# a `next start` running in the background outlives the command that spawned it,
# which then holds the calling shell open and leaves a stale server answering
# the next run's requests — a class of confusion that cost real time here.
#
# Usage: scripts/verify.sh

set -euo pipefail

cd "$(dirname "$0")/.."

PORT="${LQ_PORT:-4311}"
LOG="$(mktemp -t lq-server-XXXXXX.log)"

cleanup() {
  if [[ -z "${SERVER_PID:-}" ]]; then return; fi

  # Kill the whole process group, not just `$SERVER_PID`. `npx next start` is a
  # wrapper that spawns `next-server` as a child; killing only the wrapper
  # leaves the server holding the port, and the next run then refuses to start —
  # or worse, silently tests against yesterday's build.
  kill -TERM -- "-$SERVER_PID" 2>/dev/null || kill -TERM "$SERVER_PID" 2>/dev/null || true

  for _ in $(seq 1 20); do
    kill -0 "$SERVER_PID" 2>/dev/null || break
    sleep 0.25
  done
  kill -KILL -- "-$SERVER_PID" 2>/dev/null || kill -KILL "$SERVER_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# Fail fast and loudly if a previous run leaked a server. Doing this before the
# build means the message arrives before a two-minute build rather than after.
if curl -fsS -m 2 -o /dev/null "http://localhost:$PORT/" 2>/dev/null; then
  echo "something is already serving :$PORT — stop it, or set LQ_PORT" >&2
  exit 1
fi

echo "== typecheck"
npm run --silent typecheck

echo
echo "== unit checks"
npm run --silent check

echo
echo "== build"
npx next build 2>&1 | tail -n 3

echo
echo "== serving on :$PORT"

# `setsid` puts the server in its own process group so cleanup can take the
# whole tree down, wrapper included.
setsid npx next start --port "$PORT" >"$LOG" 2>&1 &
SERVER_PID=$!

# Poll rather than sleep a fixed amount: on a cold page cache the server can take
# several seconds, and a fixed sleep is either flaky or needlessly slow.
ready=0
for _ in $(seq 1 60); do
  if curl -fsS -m 2 -o /dev/null "http://localhost:$PORT/"; then ready=1; break; fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "server exited early:"
    cat "$LOG"
    exit 1
  fi
  sleep 0.5
done

if [[ "$ready" != "1" ]]; then
  echo "  FAIL server never became ready on :$PORT"
  cat "$LOG"
  exit 1
fi

# Confirm we are talking to *our* server, not a squatter that won the race.
if ! grep -q "Ready" "$LOG"; then
  echo "  FAIL :$PORT answered but our server never logged Ready"
  cat "$LOG"
  exit 1
fi

echo
echo "== browser smoke"
LQ_BASE="http://localhost:$PORT" node scripts/smoke.mjs

echo
echo "== 404 boundary"
# An unknown slug must render the not-found page quietly. Without app/not-found.tsx
# this logs an internal NoFallbackError instead, which is what this asserts.
for path in /cities/atlantis /place/lisbon/not-a-real-place /nope; do
  code=$(curl -s -m 5 -o /dev/null -w '%{http_code}' "http://localhost:$PORT$path")
  echo "  $path -> $code"
  if [[ "$code" != "404" ]]; then
    echo "  FAIL expected 404 for $path"
    exit 1
  fi
done

if grep -q "NoFallbackError" "$LOG"; then
  echo "  FAIL the server logged NoFallbackError for an unknown slug"
  grep -n "NoFallbackError" "$LOG"
  exit 1
fi
echo "  ok    no NoFallbackError in the server log"

echo
echo "ALL GREEN"
