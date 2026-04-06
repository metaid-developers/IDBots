#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST_ROOT="${METABOT_SKILL_DEST:-${CODEX_HOME:-$HOME/.codex}/skills}"
BIN_DIR="${METABOT_BIN_DIR:-$HOME/.metabot/bin}"
SOURCE_ROOT="${METABOT_SOURCE_ROOT:-}"
CLI_ENTRY="${METABOT_CLI_ENTRY:-}"

mkdir -p "$DEST_ROOT"
mkdir -p "$BIN_DIR"

resolve_cli_entry() {
  if [ -n "$CLI_ENTRY" ] && [ -f "$CLI_ENTRY" ]; then
    return 0
  fi

  if [ -n "$SOURCE_ROOT" ]; then
    if [ -f "$SOURCE_ROOT/dist/cli/main.js" ]; then
      CLI_ENTRY="$SOURCE_ROOT/dist/cli/main.js"
      return 0
    fi

    if [ -f "$SOURCE_ROOT/metabot/dist/cli/main.js" ]; then
      CLI_ENTRY="$SOURCE_ROOT/metabot/dist/cli/main.js"
      return 0
    fi
  fi

  if [ -f "$SCRIPT_DIR/runtime/metabot/dist/cli/main.js" ]; then
    CLI_ENTRY="$SCRIPT_DIR/runtime/metabot/dist/cli/main.js"
    return 0
  fi

  if [ -z "$SOURCE_ROOT" ] && [ -f "$SCRIPT_DIR/../../package.json" ]; then
    SOURCE_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
    if [ -f "$SOURCE_ROOT/dist/cli/main.js" ]; then
      CLI_ENTRY="$SOURCE_ROOT/dist/cli/main.js"
      return 0
    fi
  fi

  return 1
}

build_cli_from_source() {
  if [ -z "$SOURCE_ROOT" ]; then
    return 1
  fi

  if [ -f "$SOURCE_ROOT/package.json" ] && [ -f "$SOURCE_ROOT/tsconfig.json" ]; then
    command -v npm >/dev/null 2>&1 || {
      echo "npm is required to build the MetaBot CLI from source." >&2
      exit 1
    }
    npm --prefix "$SOURCE_ROOT" run build >/dev/null
    [ -f "$SOURCE_ROOT/dist/cli/main.js" ] || return 1
    CLI_ENTRY="$SOURCE_ROOT/dist/cli/main.js"
    return 0
  fi

  if [ -f "$SOURCE_ROOT/metabot/package.json" ] && [ -f "$SOURCE_ROOT/metabot/tsconfig.json" ]; then
    command -v npm >/dev/null 2>&1 || {
      echo "npm is required to build the MetaBot CLI from source." >&2
      exit 1
    }
    npm --prefix "$SOURCE_ROOT/metabot" run build >/dev/null
    [ -f "$SOURCE_ROOT/metabot/dist/cli/main.js" ] || return 1
    CLI_ENTRY="$SOURCE_ROOT/metabot/dist/cli/main.js"
    return 0
  fi

  return 1
}

command -v node >/dev/null 2>&1 || {
  echo "node is required to run the MetaBot CLI." >&2
  exit 1
}

if ! resolve_cli_entry; then
  build_cli_from_source || true
  resolve_cli_entry || {
    echo "MetaBot CLI entry not found. Set METABOT_SOURCE_ROOT or METABOT_CLI_ENTRY before running install.sh." >&2
    exit 1
  }
fi

for skill_dir in "$SCRIPT_DIR"/skills/*; do
  [ -d "$skill_dir" ] || continue
  skill_name="$(basename "$skill_dir")"
  target_dir="$DEST_ROOT/$skill_name"
  rm -rf "$target_dir"
  mkdir -p "$target_dir"
  cp -R "$skill_dir"/. "$target_dir"/
done

printf '%s
'   '#!/usr/bin/env bash'   'set -euo pipefail'   "exec node "$CLI_ENTRY" "\$@""   > "$BIN_DIR/metabot"

chmod +x "$BIN_DIR/metabot"

echo "Installed MetaBot skills to $DEST_ROOT"
echo "Installed MetaBot CLI shim to $BIN_DIR/metabot"
echo "CLI path: metabot"
echo "Compatibility manifest: metabot/release/compatibility.json"
echo "Bundled compatibility copy: $SCRIPT_DIR/runtime/compatibility.json"
