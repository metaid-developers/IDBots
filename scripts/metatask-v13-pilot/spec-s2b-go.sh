#!/usr/bin/env bash
# spec-s2b-go.sh — S2b (Go replay engine) verifier.
#
# MetaTask v1.3 pilot spec script (protocol draft §4.3 CI-style verifier contract).
# Template family: spec-s2-engine (see spec-s2a-python.sh for the shared
# skeleton documentation).
#
# Environment (§4.3): METATASK_ARTIFACT_URI / METATASK_COMMIT /
# METATASK_BASE_COMMIT (empty|null = greenfield) / METATASK_NODE /
# METATASK_TASKID / METATASK_DOWNLOAD_BASE / METATASK_VECTOR_SET_URI (override).
#
# Toolchain: git + go REQUIRED — a reviewer machine without go cannot
# adjudicate this node; the script reports invalid (exit 2) with evidence.
#
# The embedded VECTOR_SET_URI below is a PUBLISH-TIME PLACEHOLDER: unresolved
# placeholder → invalid (exit 2), never a fail verdict.
#
# Exit codes: 0 pass · 1 fail · 2 invalid. Check counter asserted against
# EXPECTED_CHECKS on the pass path (enumeration closure self-check).
set -uo pipefail

readonly VECTOR_SET_URI="VECTOR_SET_URI"   # PLACEHOLDER — backfilled with metafile://… at publish
EXPECTED_CHECKS=17

CHECKS=0

json_line() { python3 -c 'import json,sys; print(json.dumps({"verdict":sys.argv[1],"detail":sys.argv[2],"checks":int(sys.argv[3])}))' "$1" "$2" "$CHECKS"; }
note() { printf '%s\n' "$1"; }
fail() { json_line fail "$1"; printf 'FAIL: %s\n' "$1" >&2; exit 1; }
invalid() { json_line invalid "$1"; exit 2; }
check() {
  CHECKS=$((CHECKS+1))
  if [ "$2" = "0" ]; then note "[check $CHECKS] $1: ok${3:+ — $3}"; else note "[check $CHECKS] $1: FAIL${3:+ — $3}"; fail "$1${3:+ — $3}"; fi
}
gate() {
  CHECKS=$((CHECKS+1))
  if [ "$2" = "0" ]; then note "[check $CHECKS] $1: ok${3:+ — $3}"; else note "[check $CHECKS] $1: INVALID${3:+ — $3}"; invalid "$1${3:+ — $3}"; fi
}
tool() {
  if command -v "$1" >/dev/null 2>&1; then
    note "[tool] $1: $("$@" 2>&1 | head -1)"
    return 0
  fi
  note "[tool] $1: MISSING"
  return 1
}

fetch_artifact() {
  local uri="$1" dest="$2"
  case "$uri" in
    file://*) cp "${uri#file://}" "$dest" 2>/dev/null && return 0 ;;
    metafile://*|pin://*)
      local base="${METATASK_DOWNLOAD_BASE:-}"
      if [ -z "$base" ]; then note "[fetch] $uri requires METATASK_DOWNLOAD_BASE (not set)"; return 1; fi
      if FETCH_URI="$uri" FETCH_BASE="$base" FETCH_DEST="$dest" python3 - <<'PYEOF'
import os, sys
from urllib.parse import quote
from urllib.request import urlopen
uri, base, dest = os.environ["FETCH_URI"], os.environ["FETCH_BASE"].rstrip("/"), os.environ["FETCH_DEST"]
url = "%s/file/%s" % (base, quote(uri, safe=""))
try:
    with urlopen(url, timeout=120) as response:
        data = response.read()
    with open(dest, "wb") as handle:
        handle.write(data)
    print("[fetch] %s → %s (%d bytes)" % (uri, url, len(data)))
except Exception as err:
    print("[fetch] %s via %s failed: %s" % (uri, url, err))
    sys.exit(1)
PYEOF
      then return 0; else return 1; fi ;;
    *) [ -f "$uri" ] && cp "$uri" "$dest" && return 0 ;;
  esac
  return 1
}

ARTIFACT_URI="${METATASK_ARTIFACT_URI:-}"
COMMIT="${METATASK_COMMIT:-}"
BASE_COMMIT="${METATASK_BASE_COMMIT:-}"
NODE="${METATASK_NODE:-}"
TASKID="${METATASK_TASKID:-}"

note "[env] node=${NODE:-<missing>} taskid=${TASKID:-<missing>}"
note "[env] artifact=${ARTIFACT_URI:-<missing>} commit=${COMMIT:-<missing>} base=${BASE_COMMIT:-<greenfield>}"

env_bad=1
[ -n "$ARTIFACT_URI" ] && [ -n "$COMMIT" ] && [ -n "$NODE" ] && [ -n "$TASKID" ] && env_bad=0
gate "env contract present (ARTIFACT_URI/COMMIT/NODE/TASKID)" "$env_bad"
commit_bad=1
printf '%s' "$COMMIT" | grep -qE '^[0-9a-fA-F]{40}$' && commit_bad=0
gate "commit under test is 40-hex" "$commit_bad" "$COMMIT"

tools_bad=1
tool git git --version && tool go go version && tool python3 python3 --version && tools_bad=0
gate "toolchain: git + go (+ python3 for fetch/JSON plumbing)" "$tools_bad" "spec-s2b requires git and go; without them the verdict is invalid, never fail"

VECTOR_URI="${METATASK_VECTOR_SET_URI:-$VECTOR_SET_URI}"
vec_bad=0
case "$VECTOR_URI" in *VECTOR_SET_URI*|"") vec_bad=1 ;; esac
gate "vector set reference resolved" "$vec_bad" "VECTOR_SET_URI placeholder not backfilled and no METATASK_VECTOR_SET_URI override — publish the vector-set metafile first"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/metatask-s2b.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

fetch_artifact "$ARTIFACT_URI" "$WORK/submission.bundle"
gate "artifact fetched" "$([ -s "$WORK/submission.bundle" ] && echo 0 || echo 1)" "$ARTIFACT_URI"

git bundle verify "$WORK/submission.bundle" >/dev/null 2>&1 && git clone -q "$WORK/submission.bundle" "$WORK/repo" 2>/dev/null
check "git bundle verifies and clones" "$([ -d "$WORK/repo/.git" ] && echo 0 || echo 1)" "$ARTIFACT_URI"

git -C "$WORK/repo" checkout -q "$COMMIT" 2>/dev/null
check "checkout METATASK_COMMIT" "$([ "$(git -C "$WORK/repo" rev-parse HEAD 2>/dev/null)" = "$(printf '%s' "$COMMIT" | tr 'A-F' 'a-f')" ] && echo 0 || echo 1)" "$COMMIT"

if [ -z "$BASE_COMMIT" ] || [ "$BASE_COMMIT" = "null" ]; then
  CHECKS=$((CHECKS+1)); note "[check $CHECKS] base-commit ancestry: ok — greenfield node (baseCommit null), ancestry skipped per draft §4.4"
else
  git -C "$WORK/repo" merge-base --is-ancestor "$BASE_COMMIT" "$COMMIT" 2>/dev/null
  check "declared baseCommit is an ancestor of commit" "$([ $? -eq 0 ] && echo 0 || echo 1)" "base=$BASE_COMMIT"
fi

# Language gate: stdlib-only go.mod (no external require directives).
require_lines="$(grep -cE '^[[:space:]]*require[[:space:]]' "$WORK/repo/go.mod" 2>/dev/null || true)"
require_block="$(awk '/^require \(/,0' "$WORK/repo/go.mod" 2>/dev/null | grep -cE '^[[:space:]]*[a-z0-9.-]+/' || true)"
check "go.mod declares no external requires (stdlib-only)" "$([ "${require_lines:-0}" = "0" ] && [ "${require_block:-0}" = "0" ] && echo 0 || echo 1)" "require lines: ${require_lines:-0}, block entries: ${require_block:-0}"

( cd "$WORK/repo" && go build ./... ) > "$WORK/build.log" 2>&1
check "go build ./... clean" "$?" "$(tail -1 "$WORK/build.log")"

( cd "$WORK/repo" && go vet ./... ) > "$WORK/vet.log" 2>&1
check "go vet ./... clean" "$?" "$(tail -1 "$WORK/vet.log")"

( cd "$WORK/repo" && CGO_ENABLED=0 go build -o "$WORK/metatask-replay-static" . ) > "$WORK/static.log" 2>&1
check "static binary builds (CGO_ENABLED=0)" "$?" "$(tail -1 "$WORK/static.log")"

[ -f "$WORK/repo/run-vectors.sh" ]
check "run-vectors.sh present" "$?" "contract: README.md vector runner"

fetch_artifact "$VECTOR_URI" "$WORK/vector-set.tar.gz"
[ -s "$WORK/vector-set.tar.gz" ] && mkdir -p "$WORK/vectors" && tar -xzf "$WORK/vector-set.tar.gz" -C "$WORK/vectors" 2>/dev/null
gate "vector set fetched and extracted" "$([ -d "$WORK/vectors" ] && ls "$WORK/vectors"/*.json >/dev/null 2>&1 && echo 0 || echo 1)" "$VECTOR_URI"

( cd "$WORK/repo" && bash ./run-vectors.sh "$WORK/vectors" ) > "$WORK/run1.log" 2>&1
run1_rc=$?
note "[run 1] exit=$run1_rc"; sed 's/^/[run 1] /' "$WORK/run1.log" | tail -6
check "vector run 1 green" "$run1_rc" "run-vectors.sh exit code"

( cd "$WORK/repo" && bash ./run-vectors.sh "$WORK/vectors" ) > "$WORK/run2.log" 2>&1
run2_rc=$?
note "[run 2] exit=$run2_rc"; sed 's/^/[run 2] /' "$WORK/run2.log" | tail -3
check "vector run 2 green" "$run2_rc" "run-vectors.sh exit code"

d1="$(grep -E '^CANONICAL_SHA256 [0-9a-f]{64}$' "$WORK/run1.log" | tail -1 | awk '{print $2}')"
d2="$(grep -E '^CANONICAL_SHA256 [0-9a-f]{64}$' "$WORK/run2.log" | tail -1 | awk '{print $2}')"
check "determinism: two runs byte-identical canonical digest" "$([ -n "$d1" ] && [ "$d1" = "$d2" ] && echo 0 || echo 1)" "run1=${d1:-<none>} run2=${d2:-<none>}"

if [ "$CHECKS" != "$EXPECTED_CHECKS" ]; then
  invalid "check-counter mismatch: ran $CHECKS, spec declares $EXPECTED_CHECKS (script bug)"
fi
json_line pass "S2b green: clone+build+vet+static gates ok; vector set $VECTOR_URI passed twice; canonical digest ${d1}"
exit 0
