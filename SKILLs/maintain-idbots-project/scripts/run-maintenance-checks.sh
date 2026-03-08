#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT_DIR"

fail() {
  echo "[FAIL] $1" >&2
  exit 1
}

require_pattern() {
  local pattern="$1"
  local file="$2"
  local description="$3"
  if ! rg -n --quiet "$pattern" "$file"; then
    fail "Missing required guard: $description ($file)"
  fi
}

forbid_pattern() {
  local pattern="$1"
  local file="$2"
  local description="$3"
  if rg -n --quiet "$pattern" "$file"; then
    fail "Forbidden pattern found: $description ($file)"
  fi
}

echo "[1/4] Running lint"
npm run lint

echo "[2/4] Running build"
npm run build

echo "[3/4] Running core maintenance tests"
npm run test:memory
npm run test:wallet
npm run test:subsidy

echo "[4/4] Verifying security and suspension guardrails"
forbid_pattern "connect-src \\*" "src/main/main.ts" "overly permissive CSP connect-src"
forbid_pattern "ipcRenderer\\s*:" "src/main/preload.ts" "generic ipcRenderer exposure in preload"
forbid_pattern "ipcRenderer\\.invoke\\('mcp:" "src/main/preload.ts" "MCP API exposure in preload"
forbid_pattern "ipcMain\\.handle\\('mcp:" "src/main/main.ts" "MCP IPC handlers exposed in main"

require_pattern "disableLinuxSandbox" "src/main/main.ts" "linux no-sandbox must be gated"
require_pattern "isAllowedExternalUrl" "src/main/main.ts" "external URL allowlist helper"
require_pattern "isAllowedRemoteFetchUrl" "src/main/main.ts" "remote fetch URL validator"
require_pattern "setWindowOpenHandler" "src/main/main.ts" "popup blocking handler"
require_pattern "will-navigate" "src/main/main.ts" "navigation guard"

echo "[OK] Maintenance checks passed"
