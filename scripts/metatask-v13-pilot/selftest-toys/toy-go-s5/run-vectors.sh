#!/usr/bin/env bash
# Toy S5 go-module run-vectors.sh — selftest fixture ONLY.
# Prefers the packaged prebuilt binary; falls back to the go toolchain.
set -uo pipefail
DIR="${1:?usage: run-vectors.sh <vectors-dir>}"
cd "$(dirname "$0")"
os="$(uname -s | tr 'A-Z' 'a-z')"
arch="$(uname -m)"
[ "$arch" = "x86_64" ] && arch="x86_64"
[ "$arch" = "arm64" ] && arch="arm64"
bin="bin/metatask-replay-go-${os}-${arch}"
if [ -x "$bin" ]; then
  exec "$bin" run-vectors "$DIR"
fi
if command -v go >/dev/null 2>&1; then
  exec go run . run-vectors "$DIR"
fi
echo "no prebuilt binary for ${os}-${arch} and no go toolchain" >&2
exit 4
