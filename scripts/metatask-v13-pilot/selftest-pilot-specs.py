#!/usr/bin/env python3
"""
selftest-pilot-specs.py — runs every MetaTask v1.3 pilot spec script against
locally built fixtures and asserts exit codes + evidence lines.

All fixtures are built in a temp dir from the pilot materials themselves:
  * S2a/S2b/S2c fixtures clone the pinned base bundles (base-repos/ → bundles/)
    and add a toy "pseudo-passing" implementation commit (the S2c toy runs the
    REAL vendored reference engine through tsx).
  * S3 fixtures carry the repo's real 16-vector legacy set (byte copy) plus 8
    toy competitive vectors and three toy engine bundles.
  * S5 fixtures package the three toy engines + mini vector set with real
    sha256 checksums.

No network. Toolchain notes: git + python3 are assumed; the S2b and S5-go legs
need go, the S2c and S5-ts legs need node (+ pnpm for S2c, resolved from a
node24 toolchain dir injected into PATH). A missing optional toolchain marks
the affected legs SKIP (reported, not failed); on the pilot authoring machine
everything runs green.

Usage: python3 scripts/metatask-v13-pilot/selftest-pilot-specs.py
"""
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tarfile
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
BUNDLES = os.path.join(HERE, "bundles")
LEGACY_SET = os.path.join(REPO, "tests", "fixtures", "metatask", "conformance-vectors.json")

PYTHON = sys.executable
failures = []
skips = []


# ---------------------------------------------------------------------------
# shared helpers
# ---------------------------------------------------------------------------

def canonJ(obj):
    return json.dumps(obj, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def sha256_hex(data):
    if isinstance(data, str):
        data = data.encode("utf-8")
    return hashlib.sha256(data).hexdigest()


def run(cmd, cwd=None, env=None, ok_codes=(0,)):
    proc = subprocess.run(cmd, cwd=cwd, env=env, capture_output=True, text=True, timeout=600)
    if proc.returncode not in ok_codes:
        raise RuntimeError("command %s exited %d\nstdout: %s\nstderr: %s" % (cmd, proc.returncode, proc.stdout[-800:], proc.stderr[-800:]))
    return proc


def have(tool):
    return shutil.which(tool) is not None


def find_node24_bin():
    """The pilot authoring machine runs pnpm via nvm's node 24."""
    for candidate in (os.path.expanduser("~/.nvm/versions/node/v24.13.1/bin"),):
        if os.path.isfile(os.path.join(candidate, "node")):
            return candidate
    which_node = shutil.which("node")
    if which_node:
        return os.path.dirname(which_node)
    return None


def git_init_commit(repo, message="toy implementation"):
    run(["git", "init", "-q", "-b", "main"], cwd=repo)
    run(["git", "add", "-A"], cwd=repo)
    run(["git", "-c", "user.name=Toy", "-c", "user.email=toy@pilot.local", "commit", "-q", "-m", message], cwd=repo)
    return run(["git", "rev-parse", "HEAD"], cwd=repo).stdout.strip()


def make_bundle(repo, dest):
    run(["git", "bundle", "create", dest, "--all"], cwd=repo)


def clone_bundle(bundle, dest):
    run(["git", "clone", "-q", bundle, dest])


# ---------------------------------------------------------------------------
# mini vector set (shared by the S2/S5 fixtures)
# ---------------------------------------------------------------------------

HASH_INPUT = {"type": "metafile", "note": "pilot-mini"}


def inner_hash(result):
    core = {k: v for k, v in result.items() if k != "hash"}
    return sha256_hex(canonJ(core))


def outer_hash(result):
    return sha256_hex(canonJ(result))


def mini_replay_vector():
    sub_a = {"taskid": "mini-task0i0", "node": "a", "result": {"type": "metafile"},
             "contentType": "application/json;utf-8", "attachment": None, "childids": []}
    sub_r = {"taskid": "mini-task0i0", "node": "r", "result": {"type": "metafile"},
             "contentType": "application/json;utf-8", "attachment": None, "childids": [],
             "parentrefs": {"a": "mini-suba0i0"}}
    sub_a["hash"] = inner_hash(sub_a["result"])
    sub_r["hash"] = inner_hash(sub_r["result"])
    return {
        "id": "mini-02-competitive-settles",
        "events": [
            {"pinId": "mini-tree0i0", "path": "tree", "author": "idq1publisher", "height": 191590, "txIndex": 0, "timestampMs": 1790000000000,
             "body": {"root": "r", "nodes": [
                 {"id": "r", "parent": None, "title": "terminal", "kind": "aggregate", "specid": None, "params": {}, "deps": ["a"], "weight": 4000},
                 {"id": "a", "parent": "r", "title": "entry", "kind": "proof", "specid": None, "params": {}, "deps": [], "weight": 6000}]}},
            {"pinId": "mini-task0i0", "path": "task", "author": "idq1publisher", "height": 191591, "txIndex": 0, "timestampMs": 1790000000001,
             "body": {"title": "mini", "brief": "", "treeid": "mini-tree0i0", "tags": [],
                      "policy": {"mode": "competitive", "finalnode": "r", "verify_quorum": 1, "challenge_ttl_days": 14,
                                 "reward_sat": 0, "claim_ttl_hours": 0, "verify_window_hours": 0,
                                 "split": {"submitterShareBP": 8000}}}},
            {"pinId": "mini-suba0i0", "path": "submission", "author": "idq1submitterA", "height": 191600, "txIndex": 0, "timestampMs": 1790000001000, "body": sub_a},
            {"pinId": "mini-votea0i0", "path": "verify", "author": "idq1reviewer1", "height": 191601, "txIndex": 0, "timestampMs": 1790000001001,
             "body": {"targetid": "mini-suba0i0", "verdict": "pass", "method": "mini", "semantic_check": "mini"}},
            {"pinId": "mini-subr0i0", "path": "submission", "author": "idq1submitterB", "height": 191602, "txIndex": 0, "timestampMs": 1790000001002, "body": sub_r},
            {"pinId": "mini-voter0i0", "path": "verify", "author": "idq1reviewer1", "height": 191603, "txIndex": 0, "timestampMs": 1790000001003,
             "body": {"targetid": "mini-subr0i0", "verdict": "pass", "method": "mini", "semantic_check": "mini"}},
        ],
        "options": {"now": 1790001000000},
        "expect": {"nodes": {"a": "verified", "r": "verified"}, "taskComplete": True,
                   "engineAlgoVersion": "idbots-metatask-engine/1.3.0"},
    }


def mini_vector_set(work):
    """Write mini-vectors.json + mini-vectors.tar.gz into work; return tarball path."""
    inner = inner_hash(HASH_INPUT)
    vectors = {
        "setId": "pilot-selftest-mini",
        "protocolVersion": "1.3.0-draft",
        "vectors": [
            {"id": "mini-01-hash", "kind": "hash", "input": HASH_INPUT,
             "expectInner": inner, "expectOuter": outer_hash(dict(HASH_INPUT, hash=inner))},
            mini_replay_vector(),
        ],
    }
    set_path = os.path.join(work, "mini-vectors.json")
    with open(set_path, "w", encoding="utf-8") as handle:
        json.dump(vectors, handle, indent=1)
    tarball = os.path.join(work, "mini-vectors.tar.gz")
    with tarfile.open(tarball, "w:gz") as tar:
        tar.add(set_path, arcname="mini-vectors.json")
    return tarball


# ---------------------------------------------------------------------------
# S1 fixtures
# ---------------------------------------------------------------------------

def build_s1_artifact(work, clauses=40, cases=24, drop=None, dangling_ref=False, empty_member=False):
    """Build an S1 artifact tar.gz; return its path."""
    os.makedirs(work, exist_ok=True)
    spec_lines = ["# behavior-spec", "", "Normative clauses for the pilot engine behavior.", ""]
    for i in range(1, clauses + 1):
        spec_lines.append("### C-%02d: clause %d" % (i, i))
        spec_lines.append("")
        spec_lines.append("The engine MUST behave per clause %d." % i)
        spec_lines.append("")
    schema = {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": {
            "id": {"type": "string"},
            "engineAlgoVersion": {"type": "string"},
            "events": {"type": "array", "items": {"type": "object"}},
            "expect": {"type": "object"},
        },
        "required": ["id", "engineAlgoVersion", "events", "expect"],
    }
    plan_lines = ["# test-plan", ""]
    for i in range(1, cases + 1):
        clause_ref = ((i - 1) % clauses) + 1
        plan_lines.append("#### TP-%02d: case %d" % (i, i))
        plan_lines.append("")
        plan_lines.append("Clauses: C-%02d%s" % (clause_ref, ", C-99" if dangling_ref and i == 1 else ""))
        plan_lines.append("")
        plan_lines.append("Expected outcome: the vector passes.")
        plan_lines.append("")
    members = {
        "behavior-spec.md": "\n".join(spec_lines).encode(),
        "vector-schema.json": json.dumps(schema, indent=1).encode(),
        "test-plan.md": "\n".join(plan_lines).encode(),
    }
    if drop:
        members.pop(drop)
    if empty_member:
        members["behavior-spec.md"] = b""
    artifact = os.path.join(work, "s1-artifact.tar.gz")
    with tarfile.open(artifact, "w:gz") as tar:
        for name, data in members.items():
            info = tarfile.TarInfo(name)
            info.size = len(data)
            tar.addfile(info, io_bytes(data))
    return artifact


def io_bytes(data):
    import io
    return io.BytesIO(data)


# ---------------------------------------------------------------------------
# S2 fixtures: clone a base bundle, add a toy implementation, bundle the result
# ---------------------------------------------------------------------------

def build_s2_fixture(work, base_name, toy_files):
    os.makedirs(work, exist_ok=True)
    """Clone bundles/<base_name>.bundle, overlay toy files, commit, rebundle.
    Returns (submission_bundle_path, tip_commit, base_commit)."""
    base_bundle = os.path.join(BUNDLES, base_name + ".bundle")
    with open(os.path.join(BUNDLES, base_name + ".base-commit")) as handle:
        base_commit = handle.read().strip()
    repo = os.path.join(work, base_name + "-submission")
    clone_bundle(base_bundle, repo)
    toys = os.path.join(HERE, "selftest-toys")
    for rel, content_from in toy_files.items():
        dest = os.path.join(repo, rel)
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        shutil.copyfile(os.path.join(toys, content_from), dest)
        if rel.endswith(".sh"):
            os.chmod(dest, 0o755)
    tip = git_init_commit_add(repo)
    submission_bundle = os.path.join(work, base_name + "-submission.bundle")
    make_bundle(repo, submission_bundle)
    return submission_bundle, tip, base_commit


def git_init_commit_add(repo):
    run(["git", "add", "-A"], cwd=repo)
    run(["git", "-c", "user.name=Toy", "-c", "user.email=toy@pilot.local", "commit", "-q", "-m", "toy pseudo-passing implementation"], cwd=repo)
    return run(["git", "rev-parse", "HEAD"], cwd=repo).stdout.strip()


# ---------------------------------------------------------------------------
# S3 fixtures
# ---------------------------------------------------------------------------

def build_s3_artifact(work, digest_tamper=False):
    os.makedirs(work, exist_ok=True)
    """Build the S3 artifact tar.gz: real legacy set + 8 toy competitive vectors
    + toy runner + matrix.md (digests computed with the toy runner recipe) +
    three toy engine bundles. Returns the artifact path."""
    pkg = os.path.join(work, "s3-pkg")
    os.makedirs(os.path.join(pkg, "engines"), exist_ok=True)

    shutil.copyfile(LEGACY_SET, os.path.join(pkg, "legacy-vectors.json"))
    with open(LEGACY_SET, "r", encoding="utf-8") as handle:
        legacy_ids = [v["id"] for v in json.load(handle)["vectors"]]

    competitive = {
        "setId": "pilot-selftest-competitive",
        "protocolVersion": "1.3.0-draft",
        "vectors": [
            {"id": "pc-%02d" % i, "events": [], "expect": {"taskComplete": False}}
            for i in range(1, 9)
        ],
    }
    with open(os.path.join(pkg, "competitive-vectors.json"), "w", encoding="utf-8") as handle:
        json.dump(competitive, handle, indent=1)

    shutil.copyfile(os.path.join(HERE, "selftest-toys", "toy-s3", "runner"), os.path.join(pkg, "runner"))
    os.chmod(os.path.join(pkg, "runner"), 0o755)

    # The toy runner recipe: sha256 over the JSON list of per-file sha256s.
    per_file = []
    for name in sorted(os.listdir(pkg)):
        if name.endswith(".json"):
            with open(os.path.join(pkg, name), "rb") as handle:
                per_file.append(sha256_hex(handle.read()))
    digest = sha256_hex(json.dumps(per_file))
    go_digest = ("0" * 64) if digest_tamper else digest

    rows = ["| vector | python | go | ts |", "| --- | --- | --- | --- |"]
    for vector_id in legacy_ids + ["pc-%02d" % i for i in range(1, 9)]:
        rows.append("| %s | PASS | PASS | PASS |" % vector_id)
    rows += [
        "",
        "engine python canonical sha256: %s" % digest,
        "engine go canonical sha256: %s" % go_digest,
        "engine ts canonical sha256: %s" % digest,
        "",
    ]
    with open(os.path.join(pkg, "matrix.md"), "w", encoding="utf-8") as handle:
        handle.write("\n".join(rows))

    manifest = {"setId": "pilot-selftest-s3", "files": {}}
    for name in sorted(os.listdir(pkg)):
        full = os.path.join(pkg, name)
        if os.path.isfile(full):
            with open(full, "rb") as handle:
                manifest["files"][name] = {"sha256": sha256_hex(handle.read()), "bytes": os.path.getsize(full)}
    with open(os.path.join(pkg, "manifest.json"), "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, indent=1, sort_keys=True)

    for engine in ("python", "go", "ts"):
        mini_repo = os.path.join(work, "engine-%s" % engine)
        os.makedirs(mini_repo)
        with open(os.path.join(mini_repo, "README.md"), "w") as handle:
            handle.write("toy engine bundle for %s\n" % engine)
        git_init_commit(mini_repo, "toy %s engine" % engine)
        make_bundle(mini_repo, os.path.join(pkg, "engines", "%s.bundle" % engine))

    artifact = os.path.join(work, "s3-artifact.tar.gz")
    with tarfile.open(artifact, "w:gz") as tar:
        for dirpath, _dirnames, filenames in os.walk(pkg):
            for name in filenames:
                full = os.path.join(dirpath, name)
                tar.add(full, arcname=os.path.relpath(full, pkg))
    return artifact


# ---------------------------------------------------------------------------
# S4 fixtures
# ---------------------------------------------------------------------------

def build_s4_artifact(work, missing_attr=False):
    os.makedirs(work, exist_ok=True)
    matrix_rows = [
        "| vector | python | go | ts |",
        "| --- | --- | --- | --- |",
        "| r01-claim-lock | PASS | RED | PASS |",
        "| pc-03-fail-cascade | PASS | PASS | AMBER |",
        "| pc-04-supersede | PASS | PASS | PASS |",
        "",
        "engine python canonical sha256: %s" % ("a" * 64),
        "engine go canonical sha256: %s" % ("b" * 64),
        "engine ts canonical sha256: %s" % ("c" * 64),
        "",
    ]
    report = [
        "# S4 divergence report",
        "",
    ]
    if not missing_attr:
        report += [
            "#### ATTR: r01-claim-lock / go",
            "",
            "severity: high",
            "",
            "The go engine reopens the node on a boundary vote, violating C-17.",
            "Minimal reproduction: run vector r01-claim-lock with quorum 2.",
            "Proposed fix: apply the C-17 last-valid-vote rule before C-31 gating.",
            "",
        ]
    report += [
        "#### ATTR: pc-03-fail-cascade / ts",
        "",
        "severity: low",
        "",
        "The ts adapter reports the cascade one boundary late (spec ambiguity at C-42).",
        "Routed to the protocol registration queue as ambiguity A-1.",
        "",
    ]
    pkg = os.path.join(work, "s4-pkg")
    os.makedirs(pkg, exist_ok=True)
    with open(os.path.join(pkg, "matrix.md"), "w", encoding="utf-8") as handle:
        handle.write("\n".join(matrix_rows))
    with open(os.path.join(pkg, "report.md"), "w", encoding="utf-8") as handle:
        handle.write("\n".join(report))
    artifact = os.path.join(work, "s4-artifact.tar.gz")
    with tarfile.open(artifact, "w:gz") as tar:
        for name in ("matrix.md", "report.md"):
            tar.add(os.path.join(pkg, name), arcname=name)
    return artifact


# ---------------------------------------------------------------------------
# S5 fixtures
# ---------------------------------------------------------------------------

def build_s5_artifact(work, vectors_tarball, checksum_tamper=False):
    os.makedirs(work, exist_ok=True)
    """Build the release package tar.gz. Requires node (ts leg) and, for the go
    leg, either go (compile the toy now) — the package ships the prebuilt."""
    pkg = os.path.join(work, "s5-pkg")
    os.makedirs(os.path.join(pkg, "docs"), exist_ok=True)
    os.makedirs(os.path.join(pkg, "metaapp"), exist_ok=True)

    # python-skill.zip
    py_dir = os.path.join(work, "s5-python")
    os.makedirs(py_dir, exist_ok=True)
    for name in ("metatask_replay.py", "run_vectors.py", "run-vectors.sh"):
        src = os.path.join(HERE, "selftest-toys", "toy-python", name)
        shutil.copyfile(src, os.path.join(py_dir, name))
    os.chmod(os.path.join(py_dir, "run-vectors.sh"), 0o755)
    with zipfile.ZipFile(os.path.join(pkg, "python-skill.zip"), "w") as zf:
        for name in sorted(os.listdir(py_dir)):
            zf.write(os.path.join(py_dir, name), arcname=name)

    # ts-harness.tar.gz
    ts_dir = os.path.join(work, "s5-ts")
    os.makedirs(ts_dir, exist_ok=True)
    for name in ("runner.mjs", "run-vectors.sh"):
        shutil.copyfile(os.path.join(HERE, "selftest-toys", "toy-node-s5", name), os.path.join(ts_dir, name))
    os.chmod(os.path.join(ts_dir, "run-vectors.sh"), 0o755)
    with tarfile.open(os.path.join(pkg, "ts-harness.tar.gz"), "w:gz") as tar:
        for name in sorted(os.listdir(ts_dir)):
            tar.add(os.path.join(ts_dir, name), arcname=name)

    # go-module.tar.gz (source + prebuilt binary for this platform)
    go_dir = os.path.join(work, "s5-go")
    os.makedirs(os.path.join(go_dir, "bin"), exist_ok=True)
    shutil.copyfile(os.path.join(HERE, "selftest-toys", "toy-go", "main.go"), os.path.join(go_dir, "main.go"))
    shutil.copyfile(os.path.join(HERE, "selftest-toys", "toy-go-s5", "run-vectors.sh"), os.path.join(go_dir, "run-vectors.sh"))
    os.chmod(os.path.join(go_dir, "run-vectors.sh"), 0o755)
    with open(os.path.join(go_dir, "go.mod"), "w") as handle:
        handle.write("module metatask-replay\n\ngo 1.21\n")
    platform_tag = run(["uname", "-s"]).stdout.strip().lower() + "-" + run(["uname", "-m"]).stdout.strip()
    run(["go", "build", "-o", os.path.join(go_dir, "bin", "metatask-replay-go-" + platform_tag), "."], cwd=go_dir)
    with tarfile.open(os.path.join(pkg, "go-module.tar.gz"), "w:gz") as tar:
        for dirpath, _dirnames, filenames in os.walk(go_dir):
            for name in filenames:
                full = os.path.join(dirpath, name)
                tar.add(full, arcname=os.path.relpath(full, go_dir))

    shutil.copyfile(vectors_tarball, os.path.join(pkg, "vectors.tar.gz"))
    with open(os.path.join(pkg, "docs", "install.md"), "w") as handle:
        handle.write("# install\n\nUnpack and run each engine's run-vectors.sh.\n")
    with open(os.path.join(pkg, "metaapp", "index.html"), "w") as handle:
        handle.write("<!doctype html><title>metatask pilot release</title><h1>pilot release</h1>\n")

    lines = []
    for dirpath, _dirnames, filenames in os.walk(pkg):
        for name in sorted(filenames):
            full = os.path.join(dirpath, name)
            rel = os.path.relpath(full, pkg)
            with open(full, "rb") as handle:
                digest = sha256_hex(handle.read())
            if checksum_tamper and rel == "vectors.tar.gz":
                digest = "0" * 64
            lines.append("%s  %s" % (digest, rel))
    with open(os.path.join(pkg, "CHECKSUMS.txt"), "w") as handle:
        handle.write("\n".join(sorted(lines)) + "\n")

    artifact = os.path.join(work, "s5-release.tar.gz")
    with tarfile.open(artifact, "w:gz") as tar:
        for dirpath, _dirnames, filenames in os.walk(pkg):
            for name in filenames:
                full = os.path.join(dirpath, name)
                tar.add(full, arcname=os.path.relpath(full, pkg))
    return artifact


# ---------------------------------------------------------------------------
# case runner
# ---------------------------------------------------------------------------

def run_spec(script, env, expect_code, expect_verdict, needles=(), forbidden=()):
    path = os.path.join(HERE, script)
    cmd = ["bash", path] if script.endswith(".sh") else [PYTHON, path]
    proc = subprocess.run(cmd, env=env, capture_output=True, text=True, timeout=900)
    out = proc.stdout + proc.stderr
    verdict = None
    for line in proc.stdout.splitlines():
        try:
            parsed = json.loads(line)
        except Exception:
            continue
        if isinstance(parsed, dict) and "verdict" in parsed:
            verdict = parsed["verdict"]
    problems = []
    if proc.returncode != expect_code:
        problems.append("exit %d want %d" % (proc.returncode, expect_code))
    if verdict != expect_verdict:
        problems.append("verdict %r want %r" % (verdict, expect_verdict))
    for needle in needles:
        if needle not in out:
            problems.append("missing evidence needle %r" % needle)
    for needle in forbidden:
        if needle in out:
            problems.append("forbidden evidence %r present" % needle)
    return problems, out


def record(name, problems, out):
    if problems:
        failures.append("%s: %s\n---- output tail ----\n%s" % (name, "; ".join(problems), out[-1500:]))
        print("FAIL %s — %s" % (name, "; ".join(problems)))
    else:
        print("OK   %s" % name)


def base_env(node, artifact, taskid="pilot-selftest"):
    env = os.environ.copy()
    env.update({
        "METATASK_ARTIFACT_URI": artifact,
        "METATASK_NODE": node,
        "METATASK_TASKID": taskid,
    })
    return env


def main():
    work = os.path.abspath(os.environ.get("PILOT_SELFTEST_WORK") or
                           os.path.join(HERE, ".selftest-work"))
    shutil.rmtree(work, ignore_errors=True)
    os.makedirs(work)
    print("selftest workdir: %s" % work)

    vectors_tarball = mini_vector_set(work)
    node_bin = find_node24_bin()

    def with_node24(env):
        if node_bin:
            env["PATH"] = node_bin + os.pathsep + env.get("PATH", "")
        return env

    # ---- S1 ---------------------------------------------------------------
    s1_ok = build_s1_artifact(os.path.join(work, "s1a"))
    record("s1: well-formed artifact passes",
           *run_spec("spec-s1-lint.py", base_env("S1", "file://" + s1_ok), 0, "pass",
                     needles=("[check 9] every test-plan case cites", '"checks": 9')))

    record("s1: dangling clause reference fails",
           *run_spec("spec-s1-lint.py",
                     base_env("S1", "file://" + build_s1_artifact(os.path.join(work, "s1b"), dangling_ref=True)),
                     1, "fail", needles=("dangling",)))

    record("s1: too few clauses fails",
           *run_spec("spec-s1-lint.py",
                     base_env("S1", "file://" + build_s1_artifact(os.path.join(work, "s1c"), clauses=30)),
                     1, "fail", needles=("clauses",)))

    record("s1: missing member fails",
           *run_spec("spec-s1-lint.py",
                     base_env("S1", "file://" + build_s1_artifact(os.path.join(work, "s1d"), drop="test-plan.md")),
                     1, "fail", needles=("missing",)))

    empty_artifact = os.path.join(work, "empty.tar.gz")
    open(empty_artifact, "wb").close()
    record("s1: empty artifact is invalid (null tolerance)",
           *run_spec("spec-s1-lint.py", base_env("S1", "file://" + empty_artifact), 2, "invalid"))

    env_no_artifact = os.environ.copy()
    env_no_artifact.update({"METATASK_NODE": "S1", "METATASK_TASKID": "pilot-selftest"})
    env_no_artifact.pop("METATASK_ARTIFACT_URI", None)
    record("s1: missing METATASK_ARTIFACT_URI is invalid",
           *run_spec("spec-s1-lint.py", env_no_artifact, 2, "invalid"))

    # ---- S2a ---------------------------------------------------------------
    s2a_bundle, s2a_tip, s2a_base = build_s2_fixture(os.path.join(work, "s2a"), "s2a-python-base", {
        "metatask_replay.py": "toy-python/metatask_replay.py",
        "run_vectors.py": "toy-python/run_vectors.py",
        "run-vectors.sh": "toy-python/run-vectors.sh",
    })
    env = base_env("S2a", "file://" + s2a_bundle)
    env.update({"METATASK_COMMIT": s2a_tip, "METATASK_BASE_COMMIT": s2a_base,
                "METATASK_VECTOR_SET_URI": "file://" + vectors_tarball})
    record("s2a: toy implementation passes (base ancestry + stdlib + vectors + determinism)",
           *run_spec("spec-s2a-python.sh", env, 0, "pass",
                     needles=("[check 8] declared baseCommit is an ancestor", "CANONICAL_SHA256", '"checks": 15')))

    # fail leg: the untouched base skeleton (run-vectors.sh exits 1)
    env_fail = dict(env, METATASK_ARTIFACT_URI="file://" + os.path.join(BUNDLES, "s2a-python-base.bundle"),
                    METATASK_COMMIT=s2a_base)
    record("s2a: unimplemented skeleton fails at vector run 1",
           *run_spec("spec-s2a-python.sh", env_fail, 1, "fail", needles=("vector run 1",)))

    env_no_vec = dict(env)
    env_no_vec.pop("METATASK_VECTOR_SET_URI", None)
    record("s2a: unresolved VECTOR_SET_URI placeholder is invalid, not fail",
           *run_spec("spec-s2a-python.sh", env_no_vec, 2, "invalid", needles=("VECTOR_SET_URI",)))

    # ---- S2b ---------------------------------------------------------------
    if not have("go"):
        skips.append("s2b legs (no go toolchain)")
        print("SKIP s2b legs — no go toolchain on this machine")
    else:
        s2b_bundle, s2b_tip, s2b_base = build_s2_fixture(os.path.join(work, "s2b"), "s2b-go-base", {
            "main.go": "toy-go/main.go",
            "run-vectors.sh": "toy-go/run-vectors.sh",
        })
        env = base_env("S2b", "file://" + s2b_bundle)
        env.update({"METATASK_COMMIT": s2b_tip, "METATASK_BASE_COMMIT": s2b_base,
                    "METATASK_VECTOR_SET_URI": "file://" + vectors_tarball})
        record("s2b: toy implementation passes (build + vet + static + vectors + determinism)",
               *run_spec("spec-s2b-go.sh", env, 0, "pass",
                         needles=("go vet", "static binary", '"checks": 17')))

        record("s2b: unresolved VECTOR_SET_URI placeholder is invalid",
               *run_spec("spec-s2b-go.sh", dict(env, METATASK_VECTOR_SET_URI=""), 2, "invalid"))

    # ---- S2c ---------------------------------------------------------------
    if not node_bin or not have("git"):
        skips.append("s2c legs (no node24/pnpm toolchain)")
        print("SKIP s2c legs — no node24/pnpm toolchain on this machine")
    else:
        s2c_bundle, s2c_tip, s2c_base = build_s2_fixture(os.path.join(work, "s2c"), "s2c-ts-harness-base", {
            "src/cli.ts": "toy-ts/cli.ts",
            "src/run-vectors.ts": "toy-ts/run-vectors.ts",
            "run-vectors.sh": "toy-ts/run-vectors.sh",
        })
        env = with_node24(base_env("S2c", "file://" + s2c_bundle))
        env.update({"METATASK_COMMIT": s2c_tip, "METATASK_BASE_COMMIT": s2c_base,
                    "METATASK_VECTOR_SET_URI": "file://" + vectors_tarball,
                    "METATASK_BASE_BUNDLE_URI": "file://" + os.path.join(BUNDLES, "s2c-ts-harness-base.bundle")})
        record("s2c: toy adapter over the REAL vendored engine passes",
               *run_spec("spec-s2c-ts.sh", env, 0, "pass",
                         needles=("vendored engine byte-untouched", "idbots-metatask-engine/1.3.0", '"checks": 20')))

        # vendor-tamper leg: modify the vendored engine → fail at the diff check
        tampered = os.path.join(work, "s2c-tampered-repo")
        clone_bundle(s2c_bundle, tampered)
        with open(os.path.join(tampered, "vendor", "metatask-engine", "canon.ts"), "a") as handle:
            handle.write("\n// tampered\n")
        tampered_tip = git_init_commit_add(tampered)
        tampered_bundle = os.path.join(work, "s2c-tampered.bundle")
        make_bundle(tampered, tampered_bundle)
        record("s2c: a tampered vendored engine fails the byte-diff",
               *run_spec("spec-s2c-ts.sh", dict(env, METATASK_ARTIFACT_URI="file://" + tampered_bundle,
                                                METATASK_COMMIT=tampered_tip),
                         1, "fail", needles=("byte-untouched",)))

    # ---- S3 ---------------------------------------------------------------
    s3_ok = build_s3_artifact(os.path.join(work, "s3a"))
    record("s3: well-formed matrix artifact passes (legacy byte-identity + equal digests)",
           *run_spec("spec-s3-matrix.py", base_env("S3", "file://" + s3_ok), 0, "pass",
                     needles=("106aa1f3", "8 competitive vectors", '"checks": 11')))

    record("s3: diverging engine digests fail",
           *run_spec("spec-s3-matrix.py",
                     base_env("S3", "file://" + build_s3_artifact(os.path.join(work, "s3b"), digest_tamper=True)),
                     1, "fail", needles=("equal across the three engines",)))

    record("s3: empty artifact is invalid",
           *run_spec("spec-s3-matrix.py", base_env("S3", "file://" + empty_artifact), 2, "invalid"))

    # ---- S4 ---------------------------------------------------------------
    s4_ok = build_s4_artifact(os.path.join(work, "s4a"))
    record("s4: fully attributed report passes",
           *run_spec("spec-s4-report.py", base_env("S4", "file://" + s4_ok), 0, "pass",
                     needles=("2 divergent", '"checks": 7')))

    record("s4: an unattributed RED cell fails",
           *run_spec("spec-s4-report.py",
                     base_env("S4", "file://" + build_s4_artifact(os.path.join(work, "s4b"), missing_attr=True)),
                     1, "fail", needles=("missing",)))

    record("s4: empty artifact is invalid",
           *run_spec("spec-s4-report.py", base_env("S4", "file://" + empty_artifact), 2, "invalid"))

    # ---- S5 ---------------------------------------------------------------
    if not node_bin or not have("go"):
        skips.append("s5 legs (needs node + go for the packaged-engine legs)")
        print("SKIP s5 legs — need node + go on this machine")
    else:
        s5_ok = build_s5_artifact(os.path.join(work, "s5a"), vectors_tarball)
        record("s5: release package verifies (checksums + three packaged engine runs)",
               *run_spec("spec-s5-release.sh", with_node24(base_env("S5", "file://" + s5_ok)), 0, "pass",
                         needles=("sha256 verification", "digest equality", '"checks": 10')))

        record("s5: a tampered checksum fails",
               *run_spec("spec-s5-release.sh",
                         with_node24(base_env("S5", "file://" + build_s5_artifact(os.path.join(work, "s5b"), vectors_tarball, checksum_tamper=True))),
                         1, "fail", needles=("sha256 verification",)))

        env_no_artifact5 = os.environ.copy()
        env_no_artifact5.update({"METATASK_NODE": "S5", "METATASK_TASKID": "pilot-selftest"})
        env_no_artifact5.pop("METATASK_ARTIFACT_URI", None)
        record("s5: missing METATASK_ARTIFACT_URI is invalid",
               *run_spec("spec-s5-release.sh", env_no_artifact5, 2, "invalid"))

    # ---- summary -----------------------------------------------------------
    print("")
    if skips:
        print("SKIPPED: %s" % "; ".join(skips))
    if failures:
        print("%d case(s) failed:\n" % len(failures))
        for failure in failures:
            print("  - %s\n" % failure)
        return 1
    print("ALL PILOT SPEC SELF-TESTS PASSED%s" % (" (with skips: %s)" % "; ".join(skips) if skips else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
