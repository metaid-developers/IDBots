#!/bin/bash
# Update an existing scheduled task via IDBots internal API.
# Usage: bash "$SKILLS_ROOT/scheduled-task/scripts/update-task.sh" <task_id> '<json_payload>'
#    or: bash "$SKILLS_ROOT/scheduled-task/scripts/update-task.sh" <task_id> @/tmp/update.json
#
# The JSON payload should contain only the fields to update (partial update).
# Returns JSON response: { "success": true, "task": { ... } } or { "success": false, "error": "..." }
#
# Session binding ("sessionId"):
#   "current"  -> runs in the session this script is called from (resolved here
#                 from IDBOTS_COWORK_SESSION_ID)
#   "<uuid>"   -> runs in that session
#   null or "" -> CLEARS an existing binding (task falls back to its standing
#                 conversation, or a fresh session per fire for "sessionMode":
#                 "fresh")
#   omitted    -> keeps the current binding (no defaulting here — only
#                 create-task.sh defaults one-shot "at" tasks to the current session)
#   If the bound session is missing or archived at run time, the task falls back
#   to its standing conversation. The API response may add a "sessionWarning"
#   field when the sessionId does not resolve to a usable session.
#
# Session mode ("sessionMode", recurring tasks only):
#   "series" -> all fires continue one standing conversation "[定时] <name>"
#               (the default; the host rotates to "（2）", "（3）"… when it
#               outgrows its budget)
#   "fresh"  -> a new session for every fire (one-off sessions, nothing kept)
#
# Lifecycle fields (partial-update like any other field):
#   exitCondition -> revise the retire clause (natural language)
#   maxFires      -> raise/lower the total fire budget (positive integer);
#                    combined with re-enabling a retired task this is the
#                    explicit renewal path (fire counter resets on re-enable)
#   origin / originSessionId / originContext are host-stamped provenance and
#   are silently ignored on update — provenance never changes after create.
#
# Environment variables (set automatically by IDBots cowork session):
#   IDBOTS_API_BASE_URL - Internal proxy URL (always points to local proxy)
#   IDBOTS_COWORK_SESSION_ID - id of the session this script runs in

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

http_put_json() {
  local URL="$1"
  local BODY="$2"

  # On Windows Git Bash, prefer Node fetch to avoid locale/codepage issues
  # that can corrupt non-ASCII JSON payloads when piping through curl/wget.
  if ! is_windows_bash; then
    if command -v curl > /dev/null 2>&1; then
      if curl -s -f -X PUT "$URL" \
        -H "Content-Type: application/json" \
        -d "$BODY"; then
        return 0
      fi
    fi

    # Note: BusyBox wget does not support --method for PUT, skip wget for PUT requests
  fi

  if ! resolve_http_node_runtime; then
    return 127
  fi

  env "${HTTP_NODE_ENV_PREFIX[@]}" "$HTTP_NODE_CMD" "${HTTP_NODE_ARGS[@]}" - "$URL" "$BODY" <<'NODE'
const [url, body] = process.argv.slice(2);

(async () => {
  try {
    const response = await fetch(url, {
      method: 'PUT',
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

# `sessionId: "current"` means "the session this bot is running in". The HTTP
# layer never resolves it (it would store the literal), so resolve it here from
# the env IDBots injects into every cowork subprocess; without that env var the
# key is dropped so the binding is left untouched.
resolve_current_session_id_in_payload() {
  local BODY="$1"

  if ! resolve_http_node_runtime; then
    # No JSON runtime available: leave the payload alone. The API treats an
    # unresolved "current" as "keep the existing binding" and reports it in
    # "sessionWarning".
    printf '%s' "$BODY"
    return 0
  fi

  env "${HTTP_NODE_ENV_PREFIX[@]}" "$HTTP_NODE_CMD" "${HTTP_NODE_ARGS[@]}" - "$BODY" <<'NODE'
const [body] = process.argv.slice(2);

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

if (parsed.sessionId === 'current') {
  const sessionId = String(process.env.IDBOTS_COWORK_SESSION_ID ?? '').trim();
  if (sessionId) {
    parsed.sessionId = sessionId;
  } else {
    delete parsed.sessionId;
    process.stderr.write(
      "Warning: sessionId 'current' requested but IDBOTS_COWORK_SESSION_ID is not set; the existing session binding is kept\n"
    );
  }
}

process.stdout.write(JSON.stringify(parsed));
NODE
}

if [ -z "$IDBOTS_API_BASE_URL" ]; then
  echo '{"success":false,"error":"IDBOTS_API_BASE_URL not set. This script must run inside a IDBots cowork session."}'
  exit 1
fi

if [ -z "$1" ]; then
  echo '{"success":false,"error":"No task ID provided. Usage: update-task.sh <task_id> '\''<json>'\'' or update-task.sh <task_id> @/path/to/file.json"}'
  exit 1
fi

if [ -z "$2" ]; then
  echo '{"success":false,"error":"No JSON payload provided. Usage: update-task.sh <task_id> '\''<json>'\'' or update-task.sh <task_id> @/path/to/file.json"}'
  exit 1
fi

TASK_ID="$1"
PAYLOAD="$2"

# Support @file syntax to avoid command-line encoding issues with non-ASCII text.
# Example:
#   bash update-task.sh <task_id> @/tmp/update.json
if [ "${PAYLOAD#@}" != "$PAYLOAD" ]; then
  PAYLOAD_FILE="${PAYLOAD#@}"
  if [ ! -f "$PAYLOAD_FILE" ]; then
    echo "{\"success\":false,\"error\":\"Payload file not found: ${PAYLOAD_FILE}\"}"
    exit 1
  fi
  PAYLOAD="$(cat "$PAYLOAD_FILE")"
fi

PAYLOAD="$(resolve_current_session_id_in_payload "$PAYLOAD")"

# IDBOTS_API_BASE_URL always points to the local proxy: http://127.0.0.1:PORT
BASE_URL="${IDBOTS_API_BASE_URL%/}"

RESPONSE="$(http_put_json "${BASE_URL}/api/scheduled-tasks/${TASK_ID}" "$PAYLOAD")"
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
