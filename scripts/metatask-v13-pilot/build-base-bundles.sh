#!/usr/bin/env bash
# build-base-bundles.sh — (re)build the three S2 base repositories and their
# git bundles, deterministically.
#
# Sources are authored under base-repos/sources/<name>/ (committed plain
# files). This script materializes each as a fresh git repository under
# .build/<name>/ (gitignored scratch), commits with pinned author/committer
# identity + dates (so the commit sha1 is reproducible byte-for-byte), and
# writes:
#   bundles/<name>.bundle        git bundle of all refs (the pinned artifact)
#   bundles/<name>.base-commit   the tip commit sha1 (workspace.baseCommit)
#
# Usage: bash scripts/metatask-v13-pilot/build-base-bundles.sh
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$HERE/base-repos/sources"
BUILD="$HERE/.build"
OUT="$HERE/bundles"

export GIT_AUTHOR_NAME="MetaTask Pilot"
export GIT_AUTHOR_EMAIL="metatask-pilot@idbots.local"
export GIT_COMMITTER_NAME="MetaTask Pilot"
export GIT_COMMITTER_EMAIL="metatask-pilot@idbots.local"
export GIT_AUTHOR_DATE="2026-10-03T00:00:00Z"
export GIT_COMMITTER_DATE="2026-10-03T00:00:00Z"

NAMES="s2a-python-base s2b-go-base s2c-ts-harness-base"

rm -rf "$BUILD"
mkdir -p "$BUILD" "$OUT"

for name in $NAMES; do
  work="$BUILD/$name"
  mkdir -p "$work"
  # Copy sources (excluding anything gitignored for the repo itself, like
  # node_modules produced while generating the lockfile).
  (cd "$SRC/$name" && tar -cf - --exclude=node_modules --exclude=.DS_Store .) | (cd "$work" && tar -xf -)
  git -C "$work" init -q -b main
  git -C "$work" add -A
  git -C "$work" commit -q -m "chore: pin $name skeleton (MetaTask v1.3 pilot base)"
  tip="$(git -C "$work" rev-parse HEAD)"
  git -C "$work" bundle create "$OUT/$name.bundle" --all
  printf '%s\n' "$tip" > "$OUT/$name.base-commit"
  echo "built $name: base-commit $tip"
done

echo "bundles written to $OUT"
