#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT_DIR="${OUT_DIR:-$ROOT_DIR/sandbox/runtime/out}"

ARCH_INPUT="${ARCH:-$(uname -m)}"
case "$ARCH_INPUT" in
  arm64|aarch64)
    ARCH="arm64"
    QEMU_BIN="qemu-system-aarch64"
    ;;
  x86_64|amd64|x64)
    ARCH="x64"
    QEMU_BIN="qemu-system-x86_64"
    ;;
  *)
    echo "Unsupported ARCH: $ARCH_INPUT" >&2
    exit 1
    ;;
esac

if ! command -v brew >/dev/null 2>&1; then
  echo "Homebrew not found. Install Homebrew and qemu first." >&2
  exit 1
fi

BREW_PREFIX="${BREW_PREFIX:-$(brew --prefix qemu 2>/dev/null || true)}"
if [[ -z "$BREW_PREFIX" || ! -d "$BREW_PREFIX" ]]; then
  echo "qemu not installed. Run: brew install qemu" >&2
  exit 1
fi

if [[ ! -x "$BREW_PREFIX/bin/$QEMU_BIN" ]]; then
  echo "Expected $BREW_PREFIX/bin/$QEMU_BIN not found." >&2
  echo "If building x64 on arm64, install x86 Homebrew under /usr/local and set BREW_PREFIX." >&2
  exit 1
fi

if ! command -v dylibbundler >/dev/null 2>&1; then
  echo "dylibbundler not found. Run: brew install dylibbundler" >&2
  exit 1
fi

STAGING="$(mktemp -d "${TMPDIR:-/tmp}/idbots-runtime-${ARCH}.XXXXXX")"
trap 'rm -rf "$STAGING"' EXIT

mkdir -p "$STAGING/bin" "$STAGING/lib" "$STAGING/share"
cp "$BREW_PREFIX/bin/$QEMU_BIN" "$STAGING/bin/"
cp -R "$BREW_PREFIX/share/qemu" "$STAGING/share/"

BIN="$STAGING/bin/$QEMU_BIN"

dylibbundler -b -x "$BIN" -d "$STAGING/lib" -p "@rpath" \
  -s "$BREW_PREFIX/lib" -s "$BREW_PREFIX/opt" \
  -s "/usr/local/lib" -s "/opt/homebrew/lib"

install_name_tool -add_rpath "@loader_path/../lib" "$BIN"

DEST_DIR="$OUT_DIR/runtime-darwin-$ARCH"
rm -rf "$DEST_DIR"
mkdir -p "$OUT_DIR"
cp -R "$STAGING/." "$DEST_DIR/"

TARBALL="$OUT_DIR/runtime-darwin-$ARCH.tar.gz"
tar -czf "$TARBALL" -C "$DEST_DIR" .

if command -v shasum >/dev/null 2>&1; then
  shasum -a 256 "$TARBALL" > "$TARBALL.sha256"
  echo "SHA256: $(cat "$TARBALL.sha256")"
fi

echo "Output: $TARBALL"
