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

# yok ls starts a server in the empty home, and the server opens yok.db with its migration.
home="$tmp/home"
trap 'YOK_HOME="$home" "$bin" server stop >/dev/null 2>&1 || true' EXIT
YOK_HOME="$home" "$bin" ls --json >/dev/null
[ "$(ls -l "$home/yok.db" | cut -c1-10)" = "-rw-------" ] ||
  { echo "the binary did not create yok.db with mode 0600" >&2; exit 1; }

echo "ok: $bin $version runs without bun"
