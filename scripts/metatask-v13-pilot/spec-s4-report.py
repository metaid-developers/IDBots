#!/usr/bin/env python3
"""
spec-s4-report.py — S4 (divergence root-cause report) verifier.

MetaTask v1.3 pilot spec script (protocol draft §4.3 CI-style verifier contract).

Artifact contract (acceptance-sheet.md §S4): the submission attachment is a
metafile pointing at a .tar.gz with members:
  matrix.md   the S3 results matrix (same format as §S3): a table
              `| vector | python | go | ts |` whose cells are PASS | RED |
              AMBER, plus the per-engine digest lines
  report.md   the divergence report. Every RED/AMBER matrix cell is attributed
              by a section heading `#### ATTR: <vector-id> / <engine>` whose
              body carries a `severity: low|medium|high|critical` line and
              cites >= 1 spec clause `C-NN`.

These are STRUCTURAL checks: whether an attribution is correct (engine bug vs
spec ambiguity, fix implementability) is the reviewer rubric's job.

Environment (§4.3, non-git node): METATASK_ARTIFACT_URI / METATASK_NODE /
METATASK_TASKID (+ METATASK_DOWNLOAD_BASE for metafile resolution).

Exit codes: 0 pass · 1 fail · 2 invalid. Check counter asserted against
EXPECTED_CHECKS on the pass path (enumeration closure self-check).
"""
import hashlib
import io
import json
import os
import re
import sys
import tarfile
import zipfile

EXPECTED_CHECKS = 7
CELL_VALUES = {"pass", "red", "amber"}
ATTR_RE = re.compile(r"^#{3,5}\s+ATTR:\s*(\S+)\s*/\s*(python|go|ts)\s*$", re.IGNORECASE)
SEVERITY_RE = re.compile(r"^severity:\s*(low|medium|high|critical)\s*$", re.IGNORECASE | re.MULTILINE)
CLAUSE_REF_RE = re.compile(r"\bC-\d{2,}\b")

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


def parse_matrix_cells(matrix_text):
    """Return (cells, divergent) where cells = {(vector, engine): value}."""
    cells = {}
    in_table = False
    engines = []
    for line in matrix_text.splitlines():
        stripped = line.strip()
        if not (stripped.startswith("|") and stripped.endswith("|")):
            continue
        parts = [cell.strip() for cell in stripped.strip("|").split("|")]
        if parts and parts[0].lower() == "vector":
            engines = [part.lower() for part in parts[1:]]
            in_table = True
            continue
        if in_table and parts and not set(parts[0]) <= set("-: "):
            if len(parts) != len(engines) + 1:
                return None, "row %r has %d cells, expected %d" % (parts[0], len(parts) - 1, len(engines))
            for engine, value in zip(engines, parts[1:]):
                if value.lower() not in CELL_VALUES:
                    return None, "cell %s/%s has value %r (want PASS|RED|AMBER)" % (parts[0], engine, value)
                cells[(parts[0], engine)] = value.lower()
    if not cells:
        return None, "no matrix table found"
    divergent = sorted([key for key, value in cells.items() if value in ("red", "amber")])
    return (cells, divergent)


def parse_attributions(report_text):
    """Return { (vector, engine): section_body }."""
    attributions = {}
    current_key = None
    current_body = []
    for line in report_text.splitlines():
        match = ATTR_RE.match(line.strip())
        if match:
            if current_key is not None:
                attributions[current_key] = "\n".join(current_body)
            current_key = (match.group(1), match.group(2).lower())
            current_body = []
        elif current_key is not None:
            if re.match(r"^#{1,5}\s", line.strip()) and not ATTR_RE.match(line.strip()):
                attributions[current_key] = "\n".join(current_body)
                current_key = None
                current_body = []
            else:
                current_body.append(line)
    if current_key is not None:
        attributions[current_key] = "\n".join(current_body)
    return attributions


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
    missing = [name for name in ("report.md", "matrix.md") if name not in members]
    check("report.md + matrix.md present", not missing, "missing: %s" % ", ".join(missing) if missing else "present")
    if not members["report.md"].strip() or not members["matrix.md"].strip():
        invalid("report.md or matrix.md is empty")

    cells, divergent = parse_matrix_cells(members["matrix.md"].decode("utf-8"))
    check("matrix table parses; every cell is PASS|RED|AMBER", cells is not None,
          "%d cells, %d divergent" % (len(cells), len(divergent)) if cells is not None else divergent)

    attributions = parse_attributions(members["report.md"].decode("utf-8"))
    missing_attr = [key for key in divergent if key not in attributions]
    extra_attr = [key for key in attributions if key not in divergent]
    check("every RED/AMBER cell has exactly one ATTR section (count matches)",
          not missing_attr and not extra_attr,
          ("missing: %s " % ", ".join("%s/%s" % k for k in missing_attr[:4]) if missing_attr else "")
          + ("extra: %s" % ", ".join("%s/%s" % k for k in extra_attr[:4]) if extra_attr else "")
          or "%d divergent cells, %d attributions" % (len(divergent), len(attributions)))

    no_severity = [key for key, body in attributions.items() if not SEVERITY_RE.search(body)]
    check("every attribution declares severity (low|medium|high|critical)",
          not no_severity, "missing severity: %s" % ", ".join("%s/%s" % k for k in no_severity[:4]) if no_severity else "all severed")

    no_clause = [key for key, body in attributions.items() if not CLAUSE_REF_RE.search(body)]
    check("every attribution cites >= 1 spec clause (C-NN)",
          not no_clause, "no clause citation: %s" % ", ".join("%s/%s" % k for k in no_clause[:4]) if no_clause else "all cited")

    if checks_done != EXPECTED_CHECKS:
        invalid("check-counter mismatch: ran %d, spec declares %d (script bug)" % (checks_done, EXPECTED_CHECKS))
    emit("pass", "S4 structure green: %d matrix cells, %d divergent, all attributed with severity + clause citations"
         % (len(cells), len(divergent)))


if __name__ == "__main__":
    main()
