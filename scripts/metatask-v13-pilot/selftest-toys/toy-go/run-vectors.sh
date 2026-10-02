#!/usr/bin/env bash
# Toy run-vectors.sh (S2b selftest fixture) — contract per README.md.
set -uo pipefail
DIR="${1:?usage: run-vectors.sh <vectors-dir>}"
exec go run . run-vectors "$DIR"
