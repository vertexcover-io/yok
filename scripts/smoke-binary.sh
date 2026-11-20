#!/usr/bin/env bash
# Runs a release binary the way a user's machine would: no bun, no node_modules, no source tree on PATH.
# Usage: smoke-binary.sh PATH_TO_BINARY VERSION
set -euo pipefail

bin="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
version="$2"
cd "$(dirname "$0")/.."

if command -v bun >/dev/null 2>&1; then
  echo "bun is on PATH; this check needs a machine without it" >&2
  exit 1
fi

printed=$("$bin" --version)
[ "$printed" = "$version" ] || { echo "--version printed $printed, not $version" >&2; exit 1; }

YOK_SKILLS_DIR="$PWD/skills" "$bin" verify workflows/task.yaml

tmp=$(mktemp -d)
printf '%s\n' 'import { z } from "zod";' 'export const main = () => { console.log(z.number().parse(6 * 7)); };' >"$tmp/answer.ts"
answer=$("$bin" orchestrate script "$tmp/answer.ts")
[ "$answer" = "42" ] || { echo "the binary did not run a script with its own zod" >&2; exit 1; }

"$bin" sqlite-check || { echo "the binary refused this machine's SQLite" >&2; exit 1; }

# yok ls starts a server in the empty home, and the server opens yok.db with its migration.
home="$tmp/home"
trap 'YOK_HOME="$home" "$bin" server stop >/dev/null 2>&1 || true' EXIT
YOK_HOME="$home" "$bin" ls --json >/dev/null
[ "$(ls -l "$home/yok.db" | cut -c1-10)" = "-rw-------" ] ||
  { echo "the binary did not create yok.db with mode 0600" >&2; exit 1; }

# A home whose .env sets SERVER_DOMAIN is a gated server: every route but a few needs a caller.
# yok ls starts the server; with no login it is refused, which is the point.
gated="$tmp/gated"
mkdir -p "$gated"
printf '%s\n' 'SERVER_DOMAIN=yok.example.com' >"$gated/.env"
trap 'YOK_HOME="$home" "$bin" server stop >/dev/null 2>&1 || true; YOK_HOME="$gated" "$bin" server stop >/dev/null 2>&1 || true' EXIT
YOK_HOME="$gated" "$bin" ls --json >/dev/null 2>&1 || true
port=$(cat "$gated/server.port")
api="http://127.0.0.1:$port"

status() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

[ "$(status "$api/api/runs")" = "401" ] ||
  { echo "a gated server did not answer a bare /api/runs with 401" >&2; exit 1; }
[ "$(status "$api/api/health")" = "200" ] ||
  { echo "a gated server did not answer /api/health with 200" >&2; exit 1; }

# The terminal websocket is refused before the upgrade, so the client gets a plain 401, not a 101.
upgrade=$(status --http1.1 -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  "$api/api/runs/r-smoke/terminal")
[ "$upgrade" = "401" ] ||
  { echo "a websocket upgrade with no caller got $upgrade, not 401 before the upgrade" >&2; exit 1; }

echo "ok: $bin $version runs without bun"
