#!/bin/bash
# Create a scheduled task via IDBots internal API.
# Usage: bash "$SKILLS_ROOT/scheduled-task/scripts/create-task.sh" '<json_payload>'
#
# The JSON payload should follow ScheduledTaskInput schema.
# Returns JSON response: { "success": true, "task": { ... } } or { "success": false, "error": "..." }
#
# Session binding:
#   "sessionId": "current"  -> runs in the session this script is called from
#                              (resolved here from IDBOTS_COWORK_SESSION_ID)
#   "sessionId": "<uuid>"   -> runs in that session
#   "sessionId": null       -> runs in a NEW session each time (explicit opt-out
#                              of the one-shot default below)
#   omitted or ""           -> default by schedule type:
#                              - one-shot ("schedule.type": "at") created inside
#                                a session binds to that session
#                                (IDBOTS_COWORK_SESSION_ID)
#                              - recurring (interval / cron) runs in the task's
#                                STANDING conversation ("[定时] <name>") — the
#                                same conversation every fire; pass
#                                "sessionMode": "fresh" for a new session
#                                each time
#   An explicit sessionId always wins over the default. The defaulting is
#   announced on stderr; pass "sessionId": null to opt a one-shot task out.
#   If the bound session is missing or archived at run time, the task falls
#   back to its standing conversation. The API response may add a
#   "sessionWarning" field when the sessionId does not resolve to a usable
#   session.
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

# Provenance stamping (2026-10-24): the API stamps every task it creates as
# agent-origin; the creating session id is injected HERE from the env (the
# HTTP layer never sees the env) unless the payload already carries one. The
# host derives the origin context (a2a / group-task:<id> / chat) from this id.
inject_origin_session_id_into_payload() {
  local BODY="$1"
  local SESSION_ID="$2"

  if [ -z "$SESSION_ID" ]; then
    printf '%s' "$BODY"
    return 0
  fi

  if ! resolve_http_node_runtime; then
    printf '%s' "$BODY"
    return 0
  fi

  env "${HTTP_NODE_ENV_PREFIX[@]}" "$HTTP_NODE_CMD" "${HTTP_NODE_ARGS[@]}" - "$BODY" "$SESSION_ID" <<'NODE'
const [body, sessionId] = process.argv.slice(2);

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

if (!parsed.originSessionId && typeof parsed.originSessionId !== 'string') {
  parsed.originSessionId = sessionId;
}

process.stdout.write(JSON.stringify(parsed));
NODE
}

# `sessionId: "current"` means "the session this bot is running in". The HTTP
# layer never resolves it (it would store the literal), so resolve it here from
# the env IDBots injects into every cowork subprocess; without that env var the
# key is dropped so the task runs in a new session instead.
resolve_current_session_id_in_payload() {
  local BODY="$1"

  if ! resolve_http_node_runtime; then
    # No JSON runtime available: leave the payload alone. The API treats an
    # unresolved "current" as omitted and reports it in "sessionWarning".
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
      "Warning: sessionId 'current' requested but IDBOTS_COWORK_SESSION_ID is not set; task will run in a new session\n"
    );
  }
}

process.stdout.write(JSON.stringify(parsed));
NODE
}

# One-shot tasks created inside a session default to that session: a follow-up
# ("check the release I just started") belongs in the conversation that asked for
# it. Recurring tasks default to their standing conversation ("[定时] <name>") —
# the same conversation every fire, so results across days stay in one place and
# the host rotates to a fresh "（2）" conversation when it outgrows its budget.
# An explicit sessionId always wins; an explicit null opts a one-shot task out
# of the default; an explicit "sessionMode": "fresh" restores the one-off
# session-per-fire behavior for tasks that truly need isolation.
apply_default_session_binding() {
  local BODY="$1"

  if ! resolve_http_node_runtime; then
    # No JSON runtime available: leave the payload alone. The API then sees an
    # absent sessionId and keeps its own no-binding default.
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

const sessionIdAbsent =
  !Object.prototype.hasOwnProperty.call(parsed, 'sessionId') || parsed.sessionId === '';
const scheduleType =
  parsed.schedule && typeof parsed.schedule === 'object' ? parsed.schedule.type : undefined;

if (sessionIdAbsent && scheduleType === 'at') {
  const sessionId = String(process.env.IDBOTS_COWORK_SESSION_ID ?? '').trim();
  if (sessionId) {
    parsed.sessionId = sessionId;
    process.stderr.write(
      `Note: one-shot task defaults to current session ${sessionId}; pass "sessionId": null to run in a new session\n`
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
PAYLOAD="$(inject_origin_session_id_into_payload "$PAYLOAD" "${IDBOTS_COWORK_SESSION_ID:-}")"
PAYLOAD="$(resolve_current_session_id_in_payload "$PAYLOAD")"
PAYLOAD="$(apply_default_session_binding "$PAYLOAD")"

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
