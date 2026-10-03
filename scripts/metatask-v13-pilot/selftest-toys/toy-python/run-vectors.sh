#!/usr/bin/env bash
# Toy run-vectors.sh (S2a selftest fixture) — contract per README.md.
set -uo pipefail
DIR="${1:?usage: run-vectors.sh <vectors-dir>}"
exec python3 "$(dirname "$0")/run_vectors.py" "$DIR"
