#!/usr/bin/env python3
"""
spec-s1-lint.py — S1 (behavior-spec baseline) verifier.

MetaTask v1.3 pilot spec script (protocol draft §4.3 CI-style verifier contract).

Artifact contract (acceptance-sheet.md §S1): the submission attachment is a
metafile pointing at a .tar.gz or .zip with three members (top level, or under
a single top-level directory):
  behavior-spec.md   numbered normative clauses as headings `### C-NN(: ...)` —
                     NN decimal, unique, sequential from C-01; >= 40 clauses
  vector-schema.json JSON Schema for the vector format; must carry an
                     `engineAlgoVersion` property; hand-checked minimal
                     structural validation (no third-party validator)
  test-plan.md       named cases as headings `#### TP-NN(: ...)`; each case
                     body cites >= 1 clause id `C-NN`; >= 24 cases

Environment (§4.3):
  METATASK_ARTIFACT_URI  metafile://… (or file:// / local path in offline runs)
  METATASK_NODE          node id (expected: S1)
  METATASK_TASKID        task root pinId
  METATASK_DOWNLOAD_BASE base URL for metafile resolution: the script fetches
                         <base>/file/<urlencoded metafile URI> (pilot-local
                         convention — see acceptance-sheet.md "Open items").

Exit codes: 0 pass (evidence log on stdout) · 1 fail (reason on stderr) ·
2 invalid (null/empty/unresolvable input; the JSON verdict line is on stdout).
The script keeps a check counter and asserts the enumeration closure
(EXPECTED_CHECKS) on the pass path.
"""
import hashlib
import io
import json
import os
import re
import sys
import tarfile
import zipfile

EXPECTED_CHECKS = 9
MIN_CLAUSES = 40
MIN_CASES = 24

CLAUSE_RE = re.compile(r"^#{2,4}\s+C-(\d{2,})\b")
CASE_RE = re.compile(r"^#{3,5}\s+TP-(\d{2,})\b")
CLAUSE_REF_RE = re.compile(r"\bC-(\d{2,})\b")

checks_done = 0
evidence = []


def note(line):
    evidence.append(line)
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
    """Count one machine check; a false outcome is a FAIL verdict (exit 1)."""
    global checks_done
    checks_done += 1
    note("[check %d] %s: %s%s" % (checks_done, name, "ok" if ok else "FAIL", (" — " + detail) if detail else ""))
    if not ok:
        fail("%s — %s" % (name, detail))


def gate(name, ok, detail=""):
    """Count one gating check; a false outcome is an INVALID verdict (exit 2)
    (null/unresolvable input — the null_tolerance branch of the contract)."""
    global checks_done
    checks_done += 1
    note("[check %d] %s: %s%s" % (checks_done, name, "ok" if ok else "INVALID", (" — " + detail) if detail else ""))
    if not ok:
        invalid("%s — %s" % (name, detail))


def resolve_artifact(uri):
    """Return a local file path for the artifact URI, or None (caller decides invalid)."""
    if uri.startswith("file://"):
        return uri[len("file://"):]
    if os.path.isfile(uri):
        return uri
    if uri.startswith("metafile://") or uri.startswith("pin://"):
        base = os.environ.get("METATASK_DOWNLOAD_BASE", "").strip()
        if not base:
            note("[fetch] %s requires METATASK_DOWNLOAD_BASE (not set) — cannot resolve" % uri)
            return None
        from urllib.parse import quote
        from urllib.request import urlopen

        url = "%s/file/%s" % (base.rstrip("/"), quote(uri, safe=""))
        target = os.path.join(os.environ.get("TMPDIR", "/tmp"), "metatask-fetch-%s" % hashlib.sha256(uri.encode()).hexdigest()[:16])
        try:
            with urlopen(url, timeout=60) as response:
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
    """Return {member_name: bytes} with any single top-level directory stripped."""
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
    # Strip a single shared top-level directory prefix, if every member shares one.
    prefixes = set(name.split("/")[0] for name in raw_members if "/" in name)
    bare = [name for name in raw_members if "/" not in name]
    if not bare and len(prefixes) == 1:
        prefix = list(prefixes)[0] + "/"
        raw_members = {name[len(prefix):]: data for name, data in raw_members.items()}
    return raw_members


def parse_clauses(text):
    """behavior-spec.md -> ordered list of clause numbers (NN strings)."""
    clauses = []
    for line in text.splitlines():
        match = CLAUSE_RE.match(line.strip())
        if match:
            clauses.append(match.group(1))
    return clauses


def validate_schema(node, path, problems, depth=0):
    """Minimal hand-written JSON Schema structural check (no third-party libs)."""
    if depth > 24:
        problems.append("%s: schema nesting deeper than 24" % path)
        return
    if isinstance(node, bool):
        return  # boolean schemas are legal
    if not isinstance(node, dict):
        problems.append("%s: schema must be an object or boolean" % path)
        return
    TYPES = {"object", "array", "string", "number", "integer", "boolean", "null"}
    t = node.get("type")
    if t is not None:
        values = t if isinstance(t, list) else [t]
        for value in values:
            if value not in TYPES:
                problems.append("%s.type: %r is not a JSON Schema primitive type" % (path, value))
    props = node.get("properties")
    if props is not None:
        if not isinstance(props, dict):
            problems.append("%s.properties: must be an object" % path)
        else:
            for key, sub in props.items():
                validate_schema(sub, "%s.properties.%s" % (path, key), problems, depth + 1)
    required = node.get("required")
    if required is not None:
        if not isinstance(required, list) or not all(isinstance(item, str) for item in required):
            problems.append("%s.required: must be a list of strings" % path)
        elif isinstance(props, dict):
            for item in required:
                if item not in props:
                    problems.append("%s.required: %r is not declared in properties" % (path, item))
    items = node.get("items")
    if items is not None:
        if isinstance(items, list):
            for i, sub in enumerate(items):
                validate_schema(sub, "%s.items[%d]" % (path, i), problems, depth + 1)
        else:
            validate_schema(items, "%s.items" % path, problems, depth + 1)
    for keyword in ("additionalProperties", "patternProperties", "anyOf", "oneOf", "allOf", "$defs", "definitions"):
        value = node.get(keyword)
        if isinstance(value, dict):
            if keyword in ("anyOf", "oneOf", "allOf"):
                problems.append("%s.%s: must be an array of schemas" % (path, keyword))
            else:
                for key, sub in value.items():
                    validate_schema(sub, "%s.%s.%s" % (path, keyword, key), problems, depth + 1)
        elif isinstance(value, list) and keyword in ("anyOf", "oneOf", "allOf"):
            for i, sub in enumerate(value):
                validate_schema(sub, "%s.%s[%d]" % (path, keyword, i), problems, depth + 1)


def parse_cases(text):
    """test-plan.md -> list of (case NN, [clause refs])."""
    cases = []
    current = None
    for line in text.splitlines():
        heading = CASE_RE.match(line.strip())
        if heading:
            current = (heading.group(1), [])
            cases.append(current)
            continue
        if current is not None and not CLAUSE_RE.match(line.strip()):
            current[1].extend(CLAUSE_REF_RE.findall(line))
    return cases


def main():
    artifact = os.environ.get("METATASK_ARTIFACT_URI", "").strip()
    node = os.environ.get("METATASK_NODE", "").strip()
    taskid = os.environ.get("METATASK_TASKID", "").strip()
    note("[env] node=%s taskid=%s" % (node or "<missing>", taskid or "<missing>"))
    note("[env] artifact=%s" % (artifact or "<missing>"))
    note("[tool] python3: %s" % sys.version.split()[0])

    gate("env contract present",
         bool(artifact and node and taskid),
         "METATASK_ARTIFACT_URI / METATASK_NODE / METATASK_TASKID must all be non-empty")

    local = resolve_artifact(artifact)
    gate("artifact resolves", local is not None, artifact)
    if os.path.getsize(local) == 0:
        invalid("artifact is an empty file (0 bytes): %s" % artifact)

    members = open_archive(local)
    names = sorted(members)
    note("[archive] members: %s" % ", ".join(names))
    required = ["behavior-spec.md", "vector-schema.json", "test-plan.md"]
    missing = [name for name in required if name not in members]
    check("three required members present", not missing, "missing: %s" % ", ".join(missing) if missing else "behavior-spec.md + vector-schema.json + test-plan.md")
    if missing:
        fail("archive misses required member(s): %s" % ", ".join(missing))
    if any(len(members[name].strip()) == 0 for name in required):
        invalid("a required member is empty: %s" % ", ".join(name for name in required if not members[name].strip()))

    spec_text = members["behavior-spec.md"].decode("utf-8")
    clauses = parse_clauses(spec_text)
    sequential = clauses == ["%02d" % (i + 1) for i in range(len(clauses))]
    check("behavior-spec clauses: unique, sequential from C-01, >= %d" % MIN_CLAUSES,
          len(clauses) >= MIN_CLAUSES and sequential,
          "%d clauses%s" % (len(clauses), "" if sequential else " (numbering broken around C-%s)" % next((c for i, c in enumerate(clauses) if c != "%02d" % (i + 1)), "??")))

    schema_problems = []
    try:
        schema = json.loads(members["vector-schema.json"].decode("utf-8"))
    except Exception as err:
        schema = None
        schema_problems.append("vector-schema.json does not parse: %s" % err)
    check("vector-schema.json parses as a JSON object", isinstance(schema, dict),
          "; ".join(schema_problems) if schema_problems else "object")
    if not isinstance(schema, dict):
        fail("vector-schema.json is not a JSON object")

    validate_schema(schema, "$", schema_problems)
    root_type = schema.get("type")
    root_types = root_type if isinstance(root_type, list) else [root_type]
    props = schema.get("properties") if isinstance(schema.get("properties"), dict) else {}
    if "object" not in root_types:
        schema_problems.append("root type must be (or include) 'object'")
    if not props:
        schema_problems.append("root must declare a non-empty properties object")
    check("vector-schema minimal self-validation (hand-written)",
          not schema_problems, "; ".join(schema_problems[:4]) if schema_problems else "types/properties/required/items consistent")

    check("vector-schema carries engineAlgoVersion",
          "engineAlgoVersion" in props,
          "properties.%s" % ("engineAlgoVersion present" if "engineAlgoVersion" in props else "engineAlgoVersion MISSING (rubric item 4)"))

    plan_text = members["test-plan.md"].decode("utf-8")
    cases = parse_cases(plan_text)
    check("test-plan cases >= %d" % MIN_CASES, len(cases) >= MIN_CASES, "%d named TP-NN cases" % len(cases))

    clause_set = set(clauses)
    dangling = []
    uncited = []
    for case_id, refs in cases:
        if not refs:
            uncited.append("TP-%s" % case_id)
        for ref in refs:
            if ref not in clause_set:
                dangling.append("TP-%s→C-%s" % (case_id, ref))
    check("every test-plan case cites >= 1 existing clause",
          not uncited and not dangling,
          ("uncited: %s " % ",".join(uncited[:5]) if uncited else "") + ("dangling: %s" % ",".join(dangling[:5]) if dangling else "") or "all %d cases traceable" % len(cases))

    if checks_done != EXPECTED_CHECKS:
        invalid("check-counter mismatch: ran %d, spec declares %d (script bug)" % (checks_done, EXPECTED_CHECKS))
    emit("pass", "S1 lint green: %d clauses, schema self-valid (engineAlgoVersion present), %d test-plan cases all traceable" % (len(clauses), len(cases)))


if __name__ == "__main__":
    main()
