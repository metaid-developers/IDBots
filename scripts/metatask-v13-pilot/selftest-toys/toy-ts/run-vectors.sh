#!/usr/bin/env bash
# Toy run-vectors.sh (S2c selftest fixture) — contract per README.md.
set -uo pipefail
DIR="${1:?usage: run-vectors.sh <vectors-dir>}"
cd "$(dirname "$0")"
if [ -x node_modules/.bin/tsx ]; then
  exec node_modules/.bin/tsx src/run-vectors.ts "$DIR"
fi
exec npx tsx src/run-vectors.ts "$DIR"
