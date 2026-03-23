#!/bin/bash
# Create a scheduled task via IDBots internal API.
# Usage: bash "$SKILLS_ROOT/scheduled-task/scripts/create-task.sh" '<json_payload>'
#
# The JSON payload should follow ScheduledTaskInput schema.
# Returns JSON response: { "success": true, "task": { ... } } or { "success": false, "error": "..." }
#
# Environment variables (set automatically by IDBots cowork session):
#   IDBOTS_API_BASE_URL - Internal proxy URL (always points to local proxy)

HTTP_NODE_CMD=""
HTTP_NODE_ARGS=()
HTTP_NODE_ENV_PREFIX=()

is_windows_bash() {
  case "$(uname -s 2>/dev/null)" in
    MINGW*|MSYS*|CYGWIN*) return 0 ;;
    *) return 1 ;;
  esac
}

resolve_http_node_runtime() {
  if [ -n "$HTTP_NODE_CMD" ]; then
    return 0
  fi

  if command -v node > /dev/null 2>&1; then
    HTTP_NODE_CMD="node"
    HTTP_NODE_ARGS=()
    HTTP_NODE_ENV_PREFIX=()
    return 0
  fi

  if [ -n "${IDBOTS_ELECTRON_PATH:-}" ] && [ -x "${IDBOTS_ELECTRON_PATH}" ]; then
    HTTP_NODE_CMD="$IDBOTS_ELECTRON_PATH"
    HTTP_NODE_ARGS=()
    HTTP_NODE_ENV_PREFIX=("ELECTRON_RUN_AS_NODE=1")
    return 0
  fi

  return 1
}

http_post_json() {
  local URL="$1"
  local BODY="$2"

  # On Windows Git Bash, prefer Node fetch to avoid locale/codepage issues
  # that can corrupt non-ASCII JSON payloads when piping through curl/wget.
  if ! is_windows_bash; then
    if command -v curl > /dev/null 2>&1; then
      if curl -s -f -X POST "$URL" \
        -H "Content-Type: application/json" \
        -d "$BODY"; then
        return 0
      fi
    fi

    if command -v wget > /dev/null 2>&1; then
      # BusyBox wget (common in sandbox environments) does not support
      # GNU-only flags like --method/--body-data.
      if wget -q -O- \
        --header "Content-Type: application/json" \
        --post-data "$BODY" \
        "$URL"; then
        return 0
      fi
    fi
  fi

  if ! resolve_http_node_runtime; then
    return 127
  fi

  env "${HTTP_NODE_ENV_PREFIX[@]}" "$HTTP_NODE_CMD" "${HTTP_NODE_ARGS[@]}" - "$URL" "$BODY" <<'NODE'
const [url, body] = process.argv.slice(2);

(async () => {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    const responseBody = await response.text();
    if (!response.ok) {
      if (responseBody) {
        process.stdout.write(responseBody);
      } else {
        process.stdout.write(
          JSON.stringify({
            success: false,
            error: `Request failed with status ${response.status}`,
          })
        );
      }
      process.exit(22);
    }
    process.stdout.write(responseBody);
  } catch (error) {
    const message =
      error && typeof error === 'object' && 'message' in error
        ? String(error.message)
        : 'HTTP request failed';
    process.stdout.write(JSON.stringify({ success: false, error: message }));
    process.exit(1);
  }
})();
NODE
}

inject_metabot_id_into_payload() {
  local BODY="$1"
  local METABOT_ID="$2"

  if [ -z "$METABOT_ID" ]; then
    printf '%s' "$BODY"
    return 0
  fi

  if ! resolve_http_node_runtime; then
    printf '%s' "$BODY"
    return 0
  fi

  env "${HTTP_NODE_ENV_PREFIX[@]}" "$HTTP_NODE_CMD" "${HTTP_NODE_ARGS[@]}" - "$BODY" "$METABOT_ID" <<'NODE'
const [body, metabotIdRaw] = process.argv.slice(2);

let parsed;
try {
  parsed = JSON.parse(body);
} catch {
  process.stdout.write(body);
  process.exit(0);
}

if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
  process.stdout.write(body);
  process.exit(0);
}

const metabotId = Number(metabotIdRaw);
if (!Number.isFinite(metabotId) || metabotId <= 0) {
  process.stdout.write(body);
  process.exit(0);
}

if (parsed.metabotId == null) {
  parsed.metabotId = Math.floor(metabotId);
}

process.stdout.write(JSON.stringify(parsed));
NODE
}

if [ -z "$IDBOTS_API_BASE_URL" ]; then
  echo '{"success":false,"error":"IDBOTS_API_BASE_URL not set. This script must run inside a IDBots cowork session."}'
  exit 1
fi

if [ -z "$1" ]; then
  echo '{"success":false,"error":"No JSON payload provided. Usage: create-task.sh '\''<json>'\''  "}'
  exit 1
fi

PAYLOAD="$1"

# Support @file syntax to avoid command-line encoding issues with non-ASCII text.
# Example:
#   bash create-task.sh @/tmp/task.json
if [ "${PAYLOAD#@}" != "$PAYLOAD" ]; then
  PAYLOAD_FILE="${PAYLOAD#@}"
  if [ ! -f "$PAYLOAD_FILE" ]; then
    echo "{\"success\":false,\"error\":\"Payload file not found: ${PAYLOAD_FILE}\"}"
    exit 1
  fi
  PAYLOAD="$(cat "$PAYLOAD_FILE")"
fi

PAYLOAD="$(inject_metabot_id_into_payload "$PAYLOAD" "${IDBOTS_METABOT_ID:-}")"

# IDBOTS_API_BASE_URL always points to the local proxy: http://127.0.0.1:PORT
BASE_URL="${IDBOTS_API_BASE_URL%/}"

RESPONSE="$(http_post_json "${BASE_URL}/api/scheduled-tasks" "$PAYLOAD")"
CODE=$?
if [ "$CODE" -ne 0 ]; then
  if [ -n "$RESPONSE" ]; then
    echo "$RESPONSE"
    exit "$CODE"
  fi

  if [ "$CODE" -eq 127 ]; then
    echo '{"success":false,"error":"No HTTP client available. Install curl/wget or ensure Node/Electron runtime is available."}'
  else
    echo "{\"success\":false,\"error\":\"Request failed with exit code ${CODE}\"}"
  fi
  exit "$CODE"
fi

echo "$RESPONSE"
