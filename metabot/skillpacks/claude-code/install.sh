#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST_ROOT="${METABOT_SKILL_DEST:-${CLAUDE_HOME:-$HOME/.claude}/skills}"

mkdir -p "$DEST_ROOT"

for skill_dir in "$SCRIPT_DIR"/skills/*; do
  [ -d "$skill_dir" ] || continue
  skill_name="$(basename "$skill_dir")"
  target_dir="$DEST_ROOT/$skill_name"
  rm -rf "$target_dir"
  mkdir -p "$target_dir"
  cp -R "$skill_dir"/. "$target_dir"/
done

echo "Installed MetaBot skills to $DEST_ROOT"
echo "CLI path: metabot"
echo "Compatibility manifest: metabot/release/compatibility.json"
