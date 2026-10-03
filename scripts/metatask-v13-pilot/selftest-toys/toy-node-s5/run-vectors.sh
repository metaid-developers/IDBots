#!/usr/bin/env bash
# Toy S5 ts-harness run-vectors.sh — selftest fixture ONLY (plain node).
set -uo pipefail
DIR="${1:?usage: run-vectors.sh <vectors-dir>}"
exec node "$(dirname "$0")/runner.mjs" "$DIR"
