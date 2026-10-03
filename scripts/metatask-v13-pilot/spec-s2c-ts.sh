#!/usr/bin/env bash
# spec-s2c-ts.sh — S2c (TS adapter over the vendored reference engine) verifier.
#
# MetaTask v1.3 pilot spec script (protocol draft §4.3 CI-style verifier contract).
# Template family: spec-s2-engine (see spec-s2a-python.sh for the shared
# skeleton documentation). S2c adds the adapter-discipline gates: the pinned
# base bundle is cloned and vendor/metatask-engine/ must be BYTE-IDENTICAL
# (the node is an adapter task; engine edits belong to an S4 report).
#
# Environment (§4.3): METATASK_ARTIFACT_URI / METATASK_COMMIT /
# METATASK_BASE_COMMIT / METATASK_NODE / METATASK_TASKID /
# METATASK_DOWNLOAD_BASE / METATASK_VECTOR_SET_URI (override).
#
# Toolchain: git + node + npx REQUIRED (this node's spec is allowed node+npx
# per the pilot task sheet); a machine without them reports invalid (exit 2),
# never fail. pnpm is resolved as: pnpm on PATH → corepack pnpm → npx pnpm
# (the resolution path is recorded in the evidence log).
#
# The embedded VECTOR_SET_URI / BASE_BUNDLE_URI below are PUBLISH-TIME
# PLACEHOLDERS: unresolved placeholder → invalid (exit 2), never fail.
#
# Exit codes: 0 pass · 1 fail · 2 invalid. Check counter asserted against
# EXPECTED_CHECKS on the pass path (enumeration closure self-check).
set -uo pipefail

readonly VECTOR_SET_URI="VECTOR_SET_URI"     # PLACEHOLDER — backfilled with metafile://… at publish
readonly BASE_BUNDLE_URI="BASE_BUNDLE_URI"   # PLACEHOLDER — backfilled with the s2c-ts-harness-base bundle metafile://… at publish
EXPECTED_CHECKS=20

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
tool git git --version && tool node node --version && tool npx npx --version && tool python3 python3 --version && tools_bad=0
gate "toolchain: git + node + npx (+ python3 plumbing)" "$tools_bad" "spec-s2c requires git and node+npx; without them the verdict is invalid, never fail"

PNPM=""
if command -v pnpm >/dev/null 2>&1; then PNPM="pnpm"
elif command -v corepack >/dev/null 2>&1 && corepack pnpm --version >/dev/null 2>&1; then PNPM="corepack pnpm"
elif command -v npx >/dev/null 2>&1; then PNPM="npx --yes pnpm"
fi
pnpm_version="$($PNPM --version 2>/dev/null || echo unavailable)"
note "[tool] pnpm resolved as: ${PNPM:-none} ($pnpm_version)"

VECTOR_URI="${METATASK_VECTOR_SET_URI:-$VECTOR_SET_URI}"
vec_bad=0
case "$VECTOR_URI" in *VECTOR_SET_URI*|"") vec_bad=1 ;; esac
gate "vector set reference resolved" "$vec_bad" "VECTOR_SET_URI placeholder not backfilled and no METATASK_VECTOR_SET_URI override"

BASE_URI="${METATASK_BASE_BUNDLE_URI:-$BASE_BUNDLE_URI}"
base_bad=0
case "$BASE_URI" in *BASE_BUNDLE_URI*|"") base_bad=1 ;; esac
gate "base bundle reference resolved" "$base_bad" "BASE_BUNDLE_URI placeholder not backfilled and no METATASK_BASE_BUNDLE_URI override"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/metatask-s2c.XXXXXX")"
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

fetch_artifact "$BASE_URI" "$WORK/base.bundle"
gate "base bundle fetched" "$([ -s "$WORK/base.bundle" ] && echo 0 || echo 1)" "$BASE_URI"

git bundle verify "$WORK/base.bundle" >/dev/null 2>&1 && git clone -q "$WORK/base.bundle" "$WORK/base" 2>/dev/null
check "base bundle verifies and clones" "$([ -d "$WORK/base/.git" ] && echo 0 || echo 1)" "$BASE_URI"

vendor_diff="$(diff -r "$WORK/base/vendor/metatask-engine" "$WORK/repo/vendor/metatask-engine" 2>&1)"
check "vendored engine byte-untouched (vendor/metatask-engine diff vs pinned base)" "$([ -z "$vendor_diff" ] && [ -d "$WORK/repo/vendor/metatask-engine" ] && echo 0 || echo 1)" "$(printf '%s' "$vendor_diff" | head -2)"

install_rc=0
if [ -f "$WORK/repo/pnpm-lock.yaml" ]; then
  ( cd "$WORK/repo" && $PNPM install --frozen-lockfile ) > "$WORK/install.log" 2>&1
  install_rc=$?
elif [ -f "$WORK/repo/package-lock.json" ]; then
  ( cd "$WORK/repo" && npm ci ) > "$WORK/install.log" 2>&1
  install_rc=$?
elif [ -f "$WORK/repo/package.json" ]; then
  ( cd "$WORK/repo" && $PNPM install ) > "$WORK/install.log" 2>&1
  install_rc=$?
else
  echo "no package.json" > "$WORK/install.log"
  install_rc=3
fi
check "dependency install (frozen when a lockfile ships)" "$install_rc" "$(tail -1 "$WORK/install.log")"

build_rc=0
if [ -f "$WORK/repo/package.json" ] && python3 -c 'import json,sys; sys.exit(0 if "build" in (json.load(open(sys.argv[1])).get("scripts") or {}) else 1)' "$WORK/repo/package.json"; then
  ( cd "$WORK/repo" && $PNPM run build ) > "$WORK/build.log" 2>&1
  build_rc=$?
  note "[build] npm run build exit=$build_rc"
elif ( cd "$WORK/repo" && $PNPM run typecheck ) > "$WORK/build.log" 2>&1; then
  note "[build] pnpm run typecheck clean"
else
  build_rc=$?
  note "[build] typecheck exit=$build_rc: $(tail -1 "$WORK/build.log")"
fi
check "build/typecheck clean" "$build_rc" "$(tail -1 "$WORK/build.log" 2>/dev/null)"

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

engine_line="$(grep -E '^ENGINE \S+ idbots-metatask-engine/' "$WORK/run1.log" | tail -1)"
engine_bad=1
printf '%s' "$engine_line" | grep -qE ' idbots-metatask-engine/1\.3\.0$' && engine_bad=0
check "engineAlgoVersion reported correctly (idbots-metatask-engine/1.3.0 on the competitive set)" "$engine_bad" "${engine_line:-<no ENGINE line>}"

if [ "$CHECKS" != "$EXPECTED_CHECKS" ]; then
  invalid "check-counter mismatch: ran $CHECKS, spec declares $EXPECTED_CHECKS (script bug)"
fi
json_line pass "S2c green: vendor engine byte-untouched, install+build ok; vector set $VECTOR_URI passed twice; canonical digest ${d1}"
exit 0
