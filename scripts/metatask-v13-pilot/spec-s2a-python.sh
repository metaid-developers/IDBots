#!/usr/bin/env bash
# spec-s2a-python.sh — S2a (Python replay engine) verifier.
#
# MetaTask v1.3 pilot spec script (protocol draft §4.3 CI-style verifier contract).
# Template family: spec-s2-engine (S2a python / S2b go / S2c ts share the
# skeleton: env contract → toolchain evidence → artifact fetch → bundle clone →
# base-ancestry → language build gate → vector runs ×2 → determinism).
#
# Environment (§4.3):
#   METATASK_ARTIFACT_URI    metafile://<submission git bundle> (file:// / local
#                            path accepted for offline runs)
#   METATASK_COMMIT          commit under test (40-hex)
#   METATASK_BASE_COMMIT     declared base commit; empty/null = greenfield
#                            (ancestry check skipped WITH EVIDENCE, §4.4)
#   METATASK_NODE / METATASK_TASKID
#   METATASK_DOWNLOAD_BASE   metafile resolution base: fetch
#                            <base>/file/<urlencoded URI> (pilot-local
#                            convention — acceptance-sheet.md "Open items")
#   METATASK_VECTOR_SET_URI  overrides the embedded vector-set pin (offline/test
#                            use; production runs use the backfilled constant)
#
# The embedded VECTOR_SET_URI below is a PUBLISH-TIME PLACEHOLDER: until the
# pilot vector-set metafile is uploaded and its URI backfilled, resolution
# fails and this script reports invalid (exit 2) — never a fail verdict.
#
# Exit codes: 0 pass (evidence on stdout) · 1 fail (reason on stderr) ·
# 2 invalid (null/empty/unresolvable input). The script keeps a check counter
# and asserts the enumeration closure (EXPECTED_CHECKS) on the pass path.
set -uo pipefail

readonly VECTOR_SET_URI="VECTOR_SET_URI"   # PLACEHOLDER — backfilled with metafile://… at publish
EXPECTED_CHECKS=15

CHECKS=0

json_line() { python3 -c 'import json,sys; print(json.dumps({"verdict":sys.argv[1],"detail":sys.argv[2],"checks":int(sys.argv[3])}))' "$1" "$2" "$CHECKS"; }
note() { printf '%s\n' "$1"; }
fail() { json_line fail "$1"; printf 'FAIL: %s\n' "$1" >&2; exit 1; }
invalid() { json_line invalid "$1"; exit 2; }
check() { # check <name> <ok 0|1> [detail]
  CHECKS=$((CHECKS+1))
  if [ "$2" = "0" ]; then note "[check $CHECKS] $1: ok${3:+ — $3}"; else note "[check $CHECKS] $1: FAIL${3:+ — $3}"; fail "$1${3:+ — $3}"; fi
}
gate() { # gate <name> <ok 0|1> [detail] — false outcome = invalid (null_tolerance)
  CHECKS=$((CHECKS+1))
  if [ "$2" = "0" ]; then note "[check $CHECKS] $1: ok${3:+ — $3}"; else note "[check $CHECKS] $1: INVALID${3:+ — $3}"; invalid "$1${3:+ — $3}"; fi
}
tool() { # tool <name> <command…> — record version evidence; return 1 if missing
  if command -v "$1" >/dev/null 2>&1; then
    note "[tool] $1: $("$@" 2>&1 | head -1)"
    return 0
  fi
  note "[tool] $1: MISSING"
  return 1
}

# fetch_artifact <uri> <dest-file> — metafile:// via METATASK_DOWNLOAD_BASE,
# file:// / local path direct. Empty dest on failure.
fetch_artifact() {
  local uri="$1" dest="$2"
  case "$uri" in
    file://*) cp "${uri#file://}" "$dest" 2>/dev/null && return 0 ;;
    metafile://*|pin://*)
      local base="${METATASK_DOWNLOAD_BASE:-}"
      if [ -z "$base" ]; then note "[fetch] $uri requires METATASK_DOWNLOAD_BASE (not set)"; return 1; fi
      if FETCH_URI="$uri" FETCH_BASE="$base" FETCH_DEST="$dest" python3 - <<'PYEOF'
import hashlib, os, sys
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
tool git git --version && tool python3 python3 --version && tools_bad=0
gate "toolchain: git + python3" "$tools_bad" "spec-s2a requires git and python3"

VECTOR_URI="${METATASK_VECTOR_SET_URI:-$VECTOR_SET_URI}"
vec_bad=0
case "$VECTOR_URI" in *VECTOR_SET_URI*|"") vec_bad=1 ;; esac
gate "vector set reference resolved" "$vec_bad" "VECTOR_SET_URI placeholder not backfilled and no METATASK_VECTOR_SET_URI override — publish the vector-set metafile first"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/metatask-s2a.XXXXXX")"
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

# Language gate: stdlib-only. Scan every *.py for top-level imports; each must
# be the standard library or a repo-local module. Dependency manifests with
# real requirements are refused.
dep_scan="$WORK/dep-scan.py"
cat > "$dep_scan" <<'PYEOF'
import ast, os, sys
root = sys.argv[1]
try:
    STDLIB = set(sys.stdlib_module_names)
except AttributeError:  # python 3.9 fallback
    STDLIB = set("""argparse json sys os re hashlib math itertools functools collections typing dataclasses enum
pathlib subprocess tempfile shutil io base64 binascii struct time datetime copy textwrap string secrets random unittest
logging traceback contextlib abc numbers fractions statistics heapq bisect array queue threading multiprocessing socket ssl
urllib http email csv configparser sqlite3 gzip zipfile tarfile lzma bz2 glob fnmatch linecache tokenize keyword platform
getpass pprint reprlib types weakref gc inspect importlib warnings signal errno stat locale gettext ast dis code codeop
pickle marshal dbm shelve xml html ipaddress uuid hmac os.path site sysconfig builtins __future__ cmath decimal atexit
codecs encodings mmap select selectors pty fcntl timeit trace tracemalloc asyncio concurrent ctypes curses distutils
doctest fileinput filecmp optparse parser pdb plistlib posix shlex sched sndhdr tabnanny token unicodedata venv
webbrowser wsgiref zipapp zipimport zlib ftplib smtplib imaplib poplib nntplib xmlrpc mimetypes quopri uu binhex
cgi cgitb chunk colorsys imghdr mailbox crypt aifc audioop sunau wave xdrlib telnetlib msilib nis ossaudiodev spwd
syslog termios tty resource readline rlcompleter difflib""".split())
local_modules = set()
pyfiles = []
for dirpath, dirnames, filenames in os.walk(root):
    dirnames[:] = [d for d in dirnames if d not in (".git", "node_modules", "__pycache__", ".venv", "venv")]
    for name in filenames:
        if name.endswith(".py"):
            pyfiles.append(os.path.join(dirpath, name))
            rel = os.path.relpath(os.path.join(dirpath, name), root)
            parts = rel.split(os.sep)
            if len(parts) == 1:
                local_modules.add(name[:-3])
        if name == "__init__.py":
            rel = os.path.relpath(dirpath, root)
            if os.sep not in rel:
                local_modules.add(os.path.basename(dirpath))
foreign = set()
for path in pyfiles:
    with open(path, "r", encoding="utf-8") as handle:
        try:
            tree = ast.parse(handle.read())
        except SyntaxError as err:
            print("SYNTAX %s: %s" % (os.path.relpath(path, root), err))
            continue
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                foreign.add((os.path.relpath(path, root), alias.name.split(".")[0]))
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            foreign.add((os.path.relpath(path, root), node.module.split(".")[0]))
bad = sorted({"%s imports %s" % (f, m) for f, m in foreign if m not in STDLIB and m not in local_modules})
for line in bad:
    print("FOREIGN", line)
print("SCANNED %d python files, %d import roots" % (len(pyfiles), len({m for _, m in foreign})))
sys.exit(2 if bad else 0)
PYEOF
scan_out="$(python3 "$dep_scan" "$WORK/repo")"
scan_rc=$?
while IFS= read -r line; do note "[deps] $line"; done <<< "$scan_out"
manifest_bad=0
for marker in requirements.txt requirements-dev.txt Pipfile setup.py; do
  [ -f "$WORK/repo/$marker" ] && { note "[deps] forbidden dependency manifest present: $marker"; manifest_bad=1; }
done
if [ -f "$WORK/repo/pyproject.toml" ] && grep -E '^\s*dependencies\s*=\s*\[\s*[^]]' "$WORK/repo/pyproject.toml" >/dev/null 2>&1; then
  note "[deps] pyproject.toml declares dependencies"; manifest_bad=1
fi
check "stdlib-only (zero third-party deps)" "$([ "$scan_rc" = "0" ] && [ "$manifest_bad" = "0" ] && echo 0 || echo 1)" "import scan + manifest scan"

[ -f "$WORK/repo/metatask_replay.py" ]
check "CLI entry metatask_replay.py present" "$?" "contract: README.md"
[ -x "$WORK/repo/run-vectors.sh" ] || [ -f "$WORK/repo/run-vectors.sh" ]
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
json_line pass "S2a green: clone+build+stdlib gates ok; vector set $VECTOR_URI passed twice; canonical digest ${d1}"
exit 0
