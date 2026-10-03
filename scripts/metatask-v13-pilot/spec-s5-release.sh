#!/usr/bin/env bash
# spec-s5-release.sh — S5 (packaging & release, terminal node) verifier.
#
# MetaTask v1.3 pilot spec script (protocol draft §4.3 CI-style verifier contract).
#
# Artifact contract (acceptance-sheet.md §S5): the submission attachment is a
# metafile pointing at the release package, a .tar.gz with members:
#   CHECKSUMS.txt       sha256sum-format lines `<64hex>  <relpath>` listing
#                       EVERY other member file
#   python-skill.zip    packaged python engine skill (extract → run-vectors.sh)
#   ts-harness.tar.gz   packaged TS adapter harness (extract → run-vectors.sh)
#   go-module.tar.gz    packaged Go engine module (extract → run-vectors.sh;
#                       ships bin/metatask-replay-go-<os>-<arch> prebuilt for
#                       the pilot platforms and/or builds via the go toolchain)
#   vectors.tar.gz      the conformance vector set (the S3 set)
#   docs/install.md     install/usage docs
#   metaapp/index.html  the release index page (published as the metaapp payload)
#
# The script verifies every checksum, unpacks each engine package into a fresh
# temp dir, and runs each packaged vector runner once against the packaged
# vectors: exit 0 required, and the three CANONICAL_SHA256 digests must agree
# (fresh-environment reproduction of S3's matrix claim).
#
# Environment (§4.3, non-git node): METATASK_ARTIFACT_URI / METATASK_NODE /
# METATASK_TASKID (+ METATASK_DOWNLOAD_BASE for metafile resolution).
# Toolchain: python3 + node are REQUIRED (this node's spec is allowed node+npx
# per the pilot task sheet); go is never invoked by this script directly (the
# go package's own runner chooses prebuilt binary vs toolchain).
#
# Exit codes: 0 pass · 1 fail · 2 invalid. Check counter asserted against
# EXPECTED_CHECKS on the pass path (enumeration closure self-check).
set -uo pipefail

EXPECTED_CHECKS=10

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

ARTIFACT_URI="${METATASK_ARTIFACT_URI:-}"
NODE="${METATASK_NODE:-}"
TASKID="${METATASK_TASKID:-}"

note "[env] node=${NODE:-<missing>} taskid=${TASKID:-<missing>}"
note "[env] artifact=${ARTIFACT_URI:-<missing>}"

env_bad=1
[ -n "$ARTIFACT_URI" ] && [ -n "$NODE" ] && [ -n "$TASKID" ] && env_bad=0
gate "env contract present (ARTIFACT_URI/NODE/TASKID)" "$env_bad"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/metatask-s5.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

case "$ARTIFACT_URI" in
  file://*) cp "${ARTIFACT_URI#file://}" "$WORK/release.tar.gz" 2>/dev/null ;;
  metafile://*|pin://*)
    base="${METATASK_DOWNLOAD_BASE:-}"
    if [ -z "$base" ]; then note "[fetch] $ARTIFACT_URI requires METATASK_DOWNLOAD_BASE (not set)"; fi
    if [ -n "$base" ]; then
      FETCH_URI="$ARTIFACT_URI" FETCH_BASE="$base" FETCH_DEST="$WORK/release.tar.gz" python3 - <<'PYEOF'
import os, sys
from urllib.parse import quote
from urllib.request import urlopen
uri, base, dest = os.environ["FETCH_URI"], os.environ["FETCH_BASE"].rstrip("/"), os.environ["FETCH_DEST"]
url = "%s/file/%s" % (base, quote(uri, safe=""))
try:
    with urlopen(url, timeout=300) as response:
        data = response.read()
    with open(dest, "wb") as handle:
        handle.write(data)
    print("[fetch] %s → %s (%d bytes)" % (uri, url, len(data)))
except Exception as err:
    print("[fetch] %s via %s failed: %s" % (uri, url, err))
    sys.exit(1)
PYEOF
    fi ;;
  *) [ -f "$ARTIFACT_URI" ] && cp "$ARTIFACT_URI" "$WORK/release.tar.gz" ;;
esac
gate "release package fetched" "$([ -s "$WORK/release.tar.gz" ] && echo 0 || echo 1)" "$ARTIFACT_URI"

mkdir -p "$WORK/pkg"
tar -xzf "$WORK/release.tar.gz" -C "$WORK/pkg" 2>/dev/null
# Unwrap a single shared top-level directory, if present.
top_entries="$(ls -A "$WORK/pkg")"
if [ "$(printf '%s\n' "$top_entries" | wc -l | tr -d ' ')" = "1" ] && [ -d "$WORK/pkg/$top_entries" ]; then
  mv "$WORK/pkg/$top_entries" "$WORK/pkg-inner" && mv "$WORK/pkg-inner" "$WORK/pkg2" && rm -rf "$WORK/pkg" && mv "$WORK/pkg2" "$WORK/pkg"
fi
required="CHECKSUMS.txt python-skill.zip ts-harness.tar.gz go-module.tar.gz vectors.tar.gz docs/install.md metaapp/index.html"
missing=""
for member in $required; do [ -e "$WORK/pkg/$member" ] || missing="$missing $member"; done
check "required members present (CHECKSUMS.txt, 3 engine packages, vectors, docs, metaapp)" "$([ -z "$missing" ] && echo 0 || echo 1)" "missing:${missing:-none}"

# Member-set equality: CHECKSUMS.txt lists exactly the shipped files.
( cd "$WORK/pkg" && find . -type f ! -name CHECKSUMS.txt | sed 's|^\./||' | LC_ALL=C sort ) > "$WORK/actual.txt"
grep -E '^[0-9a-f]{64}  ' "$WORK/pkg/CHECKSUMS.txt" | sed 's|^[0-9a-f]\{64\}  *||' | LC_ALL=C sort > "$WORK/listed.txt"
if diff -q "$WORK/actual.txt" "$WORK/listed.txt" >/dev/null 2>&1; then sets_equal=0; else sets_equal=1; fi
check "CHECKSUMS.txt member set == shipped member set" "$sets_equal" "$(diff "$WORK/actual.txt" "$WORK/listed.txt" | head -4 | tr '\n' ' ')"

# Checksum verification (python3 — sha256sum is not portable).
( cd "$WORK/pkg" && python3 - <<'PYEOF'
import hashlib, os, sys
bad = []
count = 0
for line in open("CHECKSUMS.txt", "r", encoding="utf-8"):
    line = line.rstrip("\n")
    if not line.strip():
        continue
    digest, sep, rel = line[:64], line[64:66], line[66:]
    rel = rel.strip()
    if len(digest) != 64 or any(c not in "0123456789abcdef" for c in digest):
        bad.append("malformed line: %r" % line)
        continue
    if not os.path.isfile(rel):
        bad.append("listed but missing: %s" % rel)
        continue
    with open(rel, "rb") as handle:
        actual = hashlib.sha256(handle.read()).hexdigest()
    count += 1
    if actual != digest:
        bad.append("checksum mismatch: %s (%s != %s)" % (rel, actual[:12], digest[:12]))
if bad:
    print("\n".join(bad))
    sys.exit(1)
print("verified %d members" % count)
PYEOF
) > "$WORK/checksums.log" 2>&1
check "sha256 verification of every listed member" "$?" "$(tail -1 "$WORK/checksums.log")"

# No machine-absolute paths in distributed text artifacts.
abs_hits="$(grep -rIlE '/Users/|/home/|C:\\\\Users' "$WORK/pkg" 2>/dev/null | head -5 | tr '\n' ' ')"
check "no machine-absolute paths in distributed artifacts" "$([ -z "$abs_hits" ] && echo 0 || echo 1)" "${abs_hits:-clean}"

# Unpack vectors + the three engine packages, run each packaged runner once.
mkdir -p "$WORK/vectors"
tar -xzf "$WORK/pkg/vectors.tar.gz" -C "$WORK/vectors" 2>/dev/null
run_engine() { # run_engine <name> <package> <format: zip|tgz>
  local name="$1" package="$2" format="$3"
  local dest="$WORK/engine-$name"
  mkdir -p "$dest"
  if [ "$format" = zip ]; then
    ( cd "$dest" && python3 -c 'import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall()' "$package" ) 2>/dev/null
  else
    tar -xzf "$package" -C "$dest" 2>/dev/null
  fi
  # Unwrap a single shared top-level directory inside the engine package.
  local entries; entries="$(ls -A "$dest")"
  if [ "$(printf '%s\n' "$entries" | wc -l | tr -d ' ')" = "1" ] && [ -d "$dest/$entries" ]; then
    mv "$dest" "$dest-wrap" && mv "$dest-wrap/$entries" "$dest" && rm -rf "$dest-wrap"
  fi
  if [ ! -f "$dest/run-vectors.sh" ]; then
    echo "engine package $name has no run-vectors.sh at its root"
    return 4
  fi
  ( cd "$dest" && bash ./run-vectors.sh "$WORK/vectors" ) > "$WORK/run-$name.log" 2>&1
  return $?
}

run_engine python "$WORK/pkg/python-skill.zip" zip
py_rc=$?
note "[engine python] exit=$py_rc"; sed 's/^/[engine python] /' "$WORK/run-python.log" 2>/dev/null | tail -4
check "packaged python engine runs the vector runner, exit 0" "$py_rc" "exit=$py_rc"

tool node node --version
node_ok=$?
if [ "$node_ok" != "0" ]; then invalid "node is required for the S5 ts-harness leg (this node's spec allows node+npx) — rerun on a machine with node"; fi
run_engine ts "$WORK/pkg/ts-harness.tar.gz" tgz
ts_rc=$?
note "[engine ts] exit=$ts_rc"; sed 's/^/[engine ts] /' "$WORK/run-ts.log" 2>/dev/null | tail -4
check "packaged ts engine runs the vector runner, exit 0" "$ts_rc" "exit=$ts_rc"

run_engine go "$WORK/pkg/go-module.tar.gz" tgz
go_rc=$?
note "[engine go] exit=$go_rc"; sed 's/^/[engine go] /' "$WORK/run-go.log" 2>/dev/null | tail -4
check "packaged go engine runs the vector runner, exit 0 (prebuilt binary or toolchain)" "$go_rc" "exit=$go_rc"

d_py="$(grep -E '^CANONICAL_SHA256 [0-9a-f]{64}$' "$WORK/run-python.log" 2>/dev/null | tail -1 | awk '{print $2}')"
d_ts="$(grep -E '^CANONICAL_SHA256 [0-9a-f]{64}$' "$WORK/run-ts.log" 2>/dev/null | tail -1 | awk '{print $2}')"
d_go="$(grep -E '^CANONICAL_SHA256 [0-9a-f]{64}$' "$WORK/run-go.log" 2>/dev/null | tail -1 | awk '{print $2}')"
check "fresh-environment digest equality across the three packaged engines" \
  "$([ -n "$d_py" ] && [ "$d_py" = "$d_ts" ] && [ "$d_ts" = "$d_go" ] && echo 0 || echo 1)" \
  "python=${d_py:-<none>} ts=${d_ts:-<none>} go=${d_go:-<none>}"

if [ "$CHECKS" != "$EXPECTED_CHECKS" ]; then
  invalid "check-counter mismatch: ran $CHECKS, spec declares $EXPECTED_CHECKS (script bug)"
fi
json_line pass "S5 green: checksums verified, three packaged engines replay the vector set, digest ${d_py}"
exit 0
