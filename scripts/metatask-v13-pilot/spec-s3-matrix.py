#!/usr/bin/env python3
"""
spec-s3-matrix.py — S3 (conformance vectors + 3-engine results matrix) verifier.

MetaTask v1.3 pilot spec script (protocol draft §4.3 CI-style verifier contract).

Artifact contract (acceptance-sheet.md §S3): the submission attachment is a
metafile pointing at a .tar.gz with members (top level or one shared top dir):
  legacy-vectors.json        byte copy of the announced v1.2.1 conformance set
                             (canonJ sha256 must equal LEGACY_CANONICAL_SHA256)
  competitive-vectors.json   the NEW competitive-mode vectors (>= 8), same
                             set-file shape {protocolVersion, vectors: [...]}
  runner                     executable: `runner --engine <python|go|ts>
                             --vectors <dir>` prints `CANONICAL_SHA256 <hex>`
  matrix.md                  `| vector | python | go | ts |` table covering
                             every vector id, plus one digest line per engine:
                             `engine <name> canonical sha256: <64hex>`
  engines/python.bundle, engines/go.bundle, engines/ts.bundle
                             the three S2 winning git bundles

Environment (§4.3, non-git node): METATASK_ARTIFACT_URI / METATASK_NODE /
METATASK_TASKID (+ METATASK_DOWNLOAD_BASE for metafile resolution).

Toolchain: python3 always. node+npx / go are used when present to reproduce the
ts / go matrix columns from scratch; an absent optional toolchain is recorded
as SKIP evidence (the hard cross-engine invariant — digest equality — is
checked regardless). A reproduction mismatch is a fail, never a skip.

Exit codes: 0 pass · 1 fail · 2 invalid. Check counter asserted against
EXPECTED_CHECKS on the pass path (enumeration closure self-check).
"""
import hashlib
import io
import json
import os
import re
import subprocess
import sys
import tarfile
import zipfile

EXPECTED_CHECKS = 11
LEGACY_CANONICAL_SHA256 = "106aa1f3bee8ebd48339ceb65f97a12e54247e1e831296a394a974c9cb22f2c4"
LEGACY_VECTOR_COUNT = 16
MIN_COMPETITIVE_VECTORS = 8

REQUIRED_MEMBERS = ["legacy-vectors.json", "competitive-vectors.json", "runner", "matrix.md"]
ENGINE_BUNDLES = ["engines/python.bundle", "engines/go.bundle", "engines/ts.bundle"]
DIGEST_LINE_RE = re.compile(r"^engine\s+(python|go|ts)\s+canonical sha256:\s*([0-9a-f]{64})\s*$", re.IGNORECASE)

checks_done = 0


def note(line):
    print(line)


def emit(verdict, detail):
    print(json.dumps({"verdict": verdict, "detail": detail, "checks": checks_done}, ensure_ascii=False))


def invalid(detail):
    emit("invalid", detail)
    sys.exit(2)


def fail(detail):
    emit("fail", detail)
    print("FAIL: %s" % detail, file=sys.stderr)
    sys.exit(1)


def check(name, ok, detail=""):
    global checks_done
    checks_done += 1
    note("[check %d] %s: %s%s" % (checks_done, name, "ok" if ok else "FAIL", (" — " + detail) if detail else ""))
    if not ok:
        fail("%s%s" % (name, (" — " + detail) if detail else ""))


def gate(name, ok, detail=""):
    global checks_done
    checks_done += 1
    note("[check %d] %s: %s%s" % (checks_done, name, "ok" if ok else "INVALID", (" — " + detail) if detail else ""))
    if not ok:
        invalid("%s%s" % (name, (" — " + detail) if detail else ""))


def resolve_artifact(uri):
    if uri.startswith("file://"):
        return uri[len("file://"):]
    if os.path.isfile(uri):
        return uri
    if uri.startswith("metafile://") or uri.startswith("pin://"):
        base = os.environ.get("METATASK_DOWNLOAD_BASE", "").strip()
        if not base:
            note("[fetch] %s requires METATASK_DOWNLOAD_BASE (not set)" % uri)
            return None
        from urllib.parse import quote
        from urllib.request import urlopen

        url = "%s/file/%s" % (base.rstrip("/"), quote(uri, safe=""))
        target = os.path.join(os.environ.get("TMPDIR", "/tmp"), "metatask-fetch-%s" % hashlib.sha256(uri.encode()).hexdigest()[:16])
        try:
            with urlopen(url, timeout=120) as response:
                data = response.read()
            with open(target, "wb") as handle:
                handle.write(data)
            note("[fetch] %s → %s (%d bytes)" % (uri, url, len(data)))
            return target
        except Exception as err:
            note("[fetch] %s via %s failed: %s" % (uri, url, err))
            return None
    note("[fetch] unrecognized artifact URI scheme: %s" % uri)
    return None


def open_archive(path):
    raw_members = {}
    with open(path, "rb") as handle:
        blob = handle.read()
    if tarfile.is_tarfile(path):
        with tarfile.open(fileobj=io.BytesIO(blob)) as tar:
            for member in tar.getmembers():
                if member.isfile():
                    raw_members[member.name] = tar.extractfile(member).read()
    elif zipfile.is_zipfile(io.BytesIO(blob)):
        with zipfile.ZipFile(io.BytesIO(blob)) as zf:
            for name in zf.namelist():
                if not name.endswith("/"):
                    raw_members[name] = zf.read(name)
    else:
        fail("artifact is neither a tar archive nor a zip file")
    prefixes = set(name.split("/")[0] for name in raw_members if "/" in name)
    bare = [name for name in raw_members if "/" not in name]
    if not bare and len(prefixes) == 1:
        prefix = list(prefixes)[0] + "/"
        raw_members = {name[len(prefix):]: data for name, data in raw_members.items()}
    return raw_members


def canonJ(obj):
    return json.dumps(obj, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def main():
    artifact = os.environ.get("METATASK_ARTIFACT_URI", "").strip()
    node = os.environ.get("METATASK_NODE", "").strip()
    taskid = os.environ.get("METATASK_TASKID", "").strip()
    note("[env] node=%s taskid=%s" % (node or "<missing>", taskid or "<missing>"))
    note("[env] artifact=%s" % (artifact or "<missing>"))
    note("[tool] python3: %s" % sys.version.split()[0])

    gate("env contract present", bool(artifact and node and taskid),
         "METATASK_ARTIFACT_URI / METATASK_NODE / METATASK_TASKID must all be non-empty")

    local = resolve_artifact(artifact)
    gate("artifact resolves", local is not None, artifact)
    if os.path.getsize(local) == 0:
        invalid("artifact is an empty file (0 bytes): %s" % artifact)

    members = open_archive(local)
    note("[archive] members: %s" % ", ".join(sorted(members)))
    missing = [name for name in REQUIRED_MEMBERS + ENGINE_BUNDLES if name not in members]
    check("required members present (vectors×2, runner, matrix.md, engines/*.bundle)",
          not missing, "missing: %s" % ", ".join(missing) if missing else "all present")
    if any(name in members and len(members[name].strip()) == 0 for name in REQUIRED_MEMBERS):
        invalid("a required member is empty")

    # Legacy set identity: canonJ sha256 of the parsed member == the announced constant.
    legacy_ok = False
    legacy_detail = ""
    try:
        legacy = json.loads(members["legacy-vectors.json"].decode("utf-8"))
        digest = hashlib.sha256(canonJ(legacy)).hexdigest()
        count = len(legacy.get("vectors", []))
        legacy_ok = digest == LEGACY_CANONICAL_SHA256 and count == LEGACY_VECTOR_COUNT
        legacy_detail = "canonical sha256 %s, %d vectors" % (digest, count)
    except Exception as err:
        legacy_detail = "legacy-vectors.json does not parse: %s" % err
    check("legacy v1.2.1 set included byte-identical (canonical equality)", legacy_ok, legacy_detail)

    # New competitive vectors: >= 8, unique ids, each with events + expect.
    comp_detail = ""
    comp_ok = False
    comp_ids = []
    try:
        comp = json.loads(members["competitive-vectors.json"].decode("utf-8"))
        vectors = comp.get("vectors", [])
        comp_ids = [v.get("id") for v in vectors if isinstance(v, dict)]
        malformed = [i for i, v in enumerate(vectors)
                     if not isinstance(v, dict) or not v.get("id")
                     or not isinstance(v.get("events"), list) or not isinstance(v.get("expect"), dict)]
        comp_ok = len(vectors) >= MIN_COMPETITIVE_VECTORS and len(set(comp_ids)) == len(comp_ids) and not malformed
        comp_detail = "%d competitive vectors, ids unique: %s, malformed: %s" % (
            len(vectors), len(set(comp_ids)) == len(comp_ids), malformed[:3] or "none")
    except Exception as err:
        comp_detail = "competitive-vectors.json does not parse: %s" % err
    check("competitive vector set: >= %d well-formed new vectors" % MIN_COMPETITIVE_VECTORS, comp_ok, comp_detail)

    # Matrix digest lines.
    matrix_text = members["matrix.md"].decode("utf-8")
    digests = {}
    for line in matrix_text.splitlines():
        match = DIGEST_LINE_RE.match(line.strip())
        if match:
            digests[match.group(1).lower()] = match.group(2).lower()
    check("matrix digest lines parse (python/go/ts, 64-hex)",
          sorted(digests) == ["go", "python", "ts"],
          "found engines: %s" % (", ".join(sorted(digests)) or "none"))

    check("canonical sha256 equal across the three engines",
          len(set(digests.values())) == 1 and len(digests) == 3,
          "python=%s go=%s ts=%s" % (digests.get("python", "?")[:12], digests.get("go", "?")[:12], digests.get("ts", "?")[:12]))

    # Matrix table covers every vector id.
    legacy_ids = [v.get("id") for v in legacy.get("vectors", [])] if isinstance(legacy, dict) else []
    wanted = set(legacy_ids) | set(comp_ids)
    table_ids = set()
    in_table = False
    for line in matrix_text.splitlines():
        stripped = line.strip()
        if stripped.startswith("|") and stripped.endswith("|"):
            cells = [cell.strip() for cell in stripped.strip("|").split("|")]
            if cells and cells[0].lower() == "vector":
                in_table = True
                continue
            if in_table and cells and not set(cells[0]) <= set("-: "):
                table_ids.add(cells[0])
    missing_rows = sorted(wanted - table_ids)
    check("matrix table covers every vector id (%d legacy + %d competitive)" % (len(legacy_ids), len(comp_ids)),
          not missing_rows and len(wanted) > 0,
          "missing rows: %s" % ", ".join(missing_rows[:5]) if missing_rows else "%d rows" % len(table_ids))

    # Engine bundles verify.
    bundle_detail = []
    bundles_ok = True
    tmp = os.path.join(os.environ.get("TMPDIR", "/tmp"), "metatask-s3-%d" % os.getpid())
    os.makedirs(tmp, exist_ok=True)
    for name in ENGINE_BUNDLES:
        path = os.path.join(tmp, name.replace("/", "-"))
        with open(path, "wb") as handle:
            handle.write(members[name])
        proc = subprocess.run(["git", "bundle", "verify", path], capture_output=True, text=True)
        bundle_detail.append("%s:%s" % (name.split("/")[-1], "ok" if proc.returncode == 0 else "BAD"))
        bundles_ok = bundles_ok and proc.returncode == 0
    check("engines/*.bundle all pass git bundle verify", bundles_ok, ", ".join(bundle_detail))

    # Matrix reproduction, toolchain-gated.
    vectors_dir = os.path.join(tmp, "vectors")
    os.makedirs(vectors_dir, exist_ok=True)
    for name in ("legacy-vectors.json", "competitive-vectors.json"):
        with open(os.path.join(vectors_dir, name), "wb") as handle:
            handle.write(members[name])
    runner_path = os.path.join(tmp, "runner")
    with open(runner_path, "wb") as handle:
        handle.write(members["runner"])
    os.chmod(runner_path, 0o755)

    def reproduce(engine):
        proc = subprocess.run([runner_path, "--engine", engine, "--vectors", vectors_dir],
                              capture_output=True, text=True, timeout=600)
        digest_line = [line for line in proc.stdout.splitlines() if line.startswith("CANONICAL_SHA256 ")]
        digest = digest_line[-1].split()[1] if digest_line else None
        return proc.returncode, digest

    rc, py_digest = reproduce("python")
    check("runner reproduces the python column from scratch",
          rc == 0 and py_digest == digests.get("python"),
          "runner exit=%d digest=%s matrix=%s" % (rc, (py_digest or "<none>")[:12], digests.get("python", "?")[:12]))

    have_node = subprocess.run(["bash", "-c", "command -v node"], capture_output=True).returncode == 0
    have_go = subprocess.run(["bash", "-c", "command -v go"], capture_output=True).returncode == 0
    skip_note = []
    repro_ok = True
    for engine, present in (("ts", have_node), ("go", have_go)):
        if not present:
            skip_note.append("%s toolchain absent" % ("node" if engine == "ts" else "go"))
            note("[check 11] SKIP %s reproduction: %s toolchain absent (digest-equality check 7 still applies)" % (engine, "node" if engine == "ts" else "go"))
            continue
        rc, digest = reproduce(engine)
        if not (rc == 0 and digest == digests.get(engine)):
            repro_ok = False
            note("[check 11] %s reproduction MISMATCH: exit=%d digest=%s matrix=%s" % (engine, rc, (digest or "<none>")[:12], digests.get(engine, "?")[:12]))
    check("runner reproduces ts/go columns under available toolchains",
          repro_ok, "skipped: %s" % ", ".join(skip_note) if skip_note else "ts + go reproduced")

    if checks_done != EXPECTED_CHECKS:
        invalid("check-counter mismatch: ran %d, spec declares %d (script bug)" % (checks_done, EXPECTED_CHECKS))
    emit("pass", "S3 green: legacy set byte-identical, %d competitive vectors, matrix digest %s across python/go/ts" % (
        len(comp_ids), digests.get("python", "?")[:16]))


if __name__ == "__main__":
    main()
