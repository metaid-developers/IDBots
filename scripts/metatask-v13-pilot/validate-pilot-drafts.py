#!/usr/bin/env python3
"""
validate-pilot-drafts.py — pre-publish validator for the MetaTask v1.3 pilot
campaign materials (scripts/metatask-v13-pilot/).

Mirrors the wave-1 validator's job for the competitive-mode pilot: it refuses
(exit 1) unless every publish invariant the built-in metatask_publish /
metatask_publish_spec tools enforce holds in the drafts, PLUS the v1.3
competitive-mode invariants from the protocol draft:

  * no staging keys leak into the final drafts (scriptFile and friends live
    only in the template; embed-specs.py strips them)
  * every spec is tool-shaped (name/lang/entry/script inline + input/output +
    the three-item validation block) and its inline script is byte-identical
    to the standalone file of the same name
  * the script's EXPECTED_CHECKS constant matches the validation block's
    enumeration_closure selfcheck.expected_count (enumeration closure
    self-check, mechanically reconciled)
  * workspace/artifact consistency: S2 specs declare workspace.type git with a
    40-hex baseCommit equal to the pinned base bundle's tip and a baseRef that
    is a real pin://|metafile:// ref or the documented BASE_BUNDLE_URI:<key>
    placeholder; S1/S3/S4 declare metafile; S5 declares metaapp (pilot
    extension of the draft §4.1 enum, flagged in acceptance-sheet.md)
  * competitive graph invariants (draft §3.3): policy.finalnode names a live
    node; deps acyclic; exactly ONE deps sink and it IS finalnode; every node
    reachable from an entry node and able to reach finalnode; every node
    carries a non-empty params.rubric (string array, >= 1 non-empty entry)
  * tool-policy shape: camelCase keys only; verifyQuorum >= 1; rewardSat 0;
    submitterShareBP in [6000, 9000]; claim/verify windows 0 (competitive §3.10)
  * weights are integers in [1, 10000] summing to exactly 10000, and match the
    task sheet (S1 1500, S2a/S2b 2000, S2c 1000, S3 2000, S4 800, S5 700)
  * every placeholder is documented and inventoried (VECTOR_SET_URI,
    BASE_BUNDLE_URI:<key>, ARTIFACT_PIN:acceptance-sheet, SPEC_PIN:<key>)
  * the pinned base bundles exist, pass git bundle verify, and their
    .base-commit files match the workspace.baseCommit values
  * acceptance-sheet.md (the proposition_fidelity correspondence artifact)
    names every node, every spec's check count, and every placeholder family

Usage: python3 scripts/metatask-v13-pilot/validate-pilot-drafts.py
Exit 0 prints PILOT DRAFTS READY; exit 1 lists every failure.
"""
import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DRAFTS = os.path.join(HERE, "pilot-task-drafts.json")
SHEET = os.path.join(HERE, "acceptance-sheet.md")
BUNDLES = os.path.join(HERE, "bundles")

TOOL_TASK_FIELDS = {"title", "brief", "nodes", "policy", "tags"}
TOOL_NODE_FIELDS = {"id", "parent", "title", "kind", "specid", "params", "deps", "weight"}
TOOL_SPEC_FIELDS = {"name", "lang", "entry", "script", "input", "output", "validation", "workspace"}
TOOL_POLICY_FIELDS = {"mode", "finalnode", "claimTtlHours", "verifyQuorum", "verifyWindowHours",
                      "rewardSat", "challengeTtlDays", "submitterShareBP"}
STAGING_KEYS = {"scriptFile", "script_file", "policyOverride", "claim_ttl_hours", "verify_window_hours",
                "verify_quorum", "reward_sat", "challenge_ttl_days", "specId"}
VALIDATION_ITEMS = ("null_tolerance", "enumeration_closure", "proposition_fidelity")
COVERAGE_ITEMS = ["statement", "definitions", "proof-direction"]
PIN_REF_RE = re.compile(r"^(pin://|metafile://)\S+$")
BASE_REF_PLACEHOLDER_RE = re.compile(r"^BASE_BUNDLE_URI:(s2a-python-base|s2b-go-base|s2c-ts-harness-base)$")
GIT_COMMIT_RE = re.compile(r"^[0-9a-f]{40}$")
EXPECTED_CHECKS_RE = re.compile(r"^EXPECTED_CHECKS\s*=\s*(\d+)\s*$", re.MULTILINE)

NODE_IDS = ["S1", "S2a", "S2b", "S2c", "S3", "S4", "S5"]
EXPECTED_WEIGHTS = {"S1": 1500, "S2a": 2000, "S2b": 2000, "S2c": 1000, "S3": 2000, "S4": 800, "S5": 700}
NODE_KINDS = {"S1": "formalize", "S2a": "implement", "S2b": "implement", "S2c": "implement",
              "S3": "aggregate", "S4": "triage", "S5": "publish"}
EXPECTED_COUNTS = {"s1-behavior-spec-lint": 9, "s2a-python-engine": 15, "s2b-go-engine": 17,
                   "s2c-ts-adapter": 20, "s3-matrix-check": 11, "s4-report-structure": 7,
                   "s5-release-verify": 10}
ARTIFACT_PLACEHOLDER = "ARTIFACT_PIN:acceptance-sheet"
SPEC_PIN_PREFIX = "SPEC_PIN:"
PLAN_STANDALONE = "PUBLISH_SPEC_FIRST"
PLAN_BY_PUBLISH = "PUBLISHED_BY_METATASK_PUBLISH"

errors = []
checks = []


def ok(name, detail=""):
    checks.append("OK   %s%s" % (name, (" — " + detail) if detail else ""))


def bad(name, detail):
    errors.append("%s: %s" % (name, detail))
    checks.append("FAIL %s: %s" % (name, detail))


def check(condition, name, detail=""):
    if condition:
        ok(name, detail)
    else:
        bad(name, detail)
    return bool(condition)


def walk_keys(node, path=""):
    if isinstance(node, dict):
        for key, value in node.items():
            yield path, key, value
            yield from walk_keys(value, "%s.%s" % (path, key))
    elif isinstance(node, list):
        for index, value in enumerate(node):
            yield from walk_keys(value, "%s[%d]" % (path, index))


def find_int_counts(node, key="expected_count"):
    found = []
    if isinstance(node, dict):
        for k, value in node.items():
            if k == key and isinstance(value, int) and not isinstance(value, bool):
                found.append(value)
            found.extend(find_int_counts(value, key))
    elif isinstance(node, list):
        for value in node:
            found.extend(find_int_counts(value, key))
    return found


def find_bools(node):
    if isinstance(node, dict):
        for value in node.values():
            yield from find_bools(value)
    elif isinstance(node, list):
        for value in node:
            yield from find_bools(value)
    elif isinstance(node, bool):
        yield node


def validate_workspace(spec_key, spec, bundle_tips):
    where = "spec %s" % spec_key
    workspace = spec.get("workspace")
    if not check(isinstance(workspace, dict), "%s: workspace declared (draft §4.1)" % where):
        return
    wtype = workspace.get("type")
    expected_type = "git" if spec_key.startswith("s2") else ("metaapp" if spec_key == "s5-release-verify" else "metafile")
    check(wtype == expected_type, "%s: workspace.type is %r" % (where, expected_type), "got %r" % (wtype,))
    if wtype != "git":
        return
    base_ref = workspace.get("baseRef")
    check(isinstance(base_ref, str) and (PIN_REF_RE.match(base_ref) or BASE_REF_PLACEHOLDER_RE.match(base_ref)),
          "%s: workspace.baseRef is a pin://|metafile:// ref or the documented BASE_BUNDLE_URI:<key> placeholder" % where,
          "got %r" % (base_ref,))
    base_commit = workspace.get("baseCommit")
    check(isinstance(base_commit, str) and GIT_COMMIT_RE.match(base_commit),
          "%s: workspace.baseCommit is a 40-hex commit" % where, "got %r" % (base_commit,))
    if isinstance(base_ref, str) and BASE_REF_PLACEHOLDER_RE.match(base_ref or ""):
        bundle_key = base_ref.split(":", 1)[1]
        tip = bundle_tips.get(bundle_key)
        check(tip is not None and tip == base_commit,
              "%s: workspace.baseCommit matches bundles/%s.base-commit" % (where, bundle_key),
              "workspace=%s bundle=%s" % (base_commit, tip))


def main():
    with open(DRAFTS, "r", encoding="utf-8") as handle:
        drafts = json.load(handle)

    # ---- staging keys ------------------------------------------------------
    offending = sorted({key for _, key, _ in walk_keys(drafts) if key in STAGING_KEYS})
    check(not offending, "drafts: no staging keys leak into the final file",
          "" if not offending else "found %s (they belong to the template only)" % offending)

    # ---- base bundles ------------------------------------------------------
    bundle_tips = {}
    for key in ("s2a-python-base", "s2b-go-base", "s2c-ts-harness-base"):
        bundle = os.path.join(BUNDLES, key + ".bundle")
        tip_file = os.path.join(BUNDLES, key + ".base-commit")
        bundle_ok = os.path.isfile(bundle)
        proc = subprocess.run(["git", "bundle", "verify", bundle], capture_output=True, text=True) if bundle_ok else None
        verified = proc is not None and proc.returncode == 0
        tip = None
        if os.path.isfile(tip_file):
            with open(tip_file) as handle:
                tip = handle.read().strip()
        if verified and tip:
            bundle_tips[key] = tip
        check(verified and tip and GIT_COMMIT_RE.match(tip) is not None,
              "bundles/%s: bundle verifies and carries a 40-hex base commit" % key,
              "tip=%s" % (tip or "<missing>"))

    # ---- specs -------------------------------------------------------------
    specs = drafts.get("specs") or {}
    check(set(specs) == set(EXPECTED_COUNTS), "drafts.specs: exactly the seven node specs",
          "got %s" % sorted(specs))
    plan = drafts.get("specPinPlan") or {}
    check(set(plan) == set(specs), "drafts.specPinPlan: one plan entry per spec key")

    placeholders = {"VECTOR_SET_URI": 0, "BASE_BUNDLE_URI": set(), "ARTIFACT_PIN": set(), "SPEC_PIN": set()}

    for key, spec in sorted(specs.items()):
        where = "spec %s" % key
        unknown = sorted(set(spec) - TOOL_SPEC_FIELDS)
        check(not unknown, "%s: only tool spec fields (+ workspace, draft §4.1)" % where,
              "" if not unknown else "unknown keys %s" % unknown)
        check(spec.get("name") == key, "%s: name == spec key" % where)
        entry = spec.get("entry")
        script = spec.get("script")
        standalone = os.path.join(HERE, entry) if isinstance(entry, str) else None
        if check(isinstance(script, str) and script.strip() != "", "%s: script inlined" % where):
            if standalone and os.path.isfile(standalone):
                with open(standalone, "r", encoding="utf-8") as handle:
                    check(handle.read() == script, "%s: inline script is byte-identical to %s" % (where, entry))
            else:
                bad(where, "entry %r has no standalone file" % entry)
        check(spec.get("input") not in (None, ""), "%s: input descriptor present" % where)
        check(spec.get("output") not in (None, ""), "%s: output descriptor present" % where)

        if isinstance(script, str):
            match = EXPECTED_CHECKS_RE.search(script)
            declared = EXPECTED_COUNTS.get(key)
            check(match is not None and declared is not None and int(match.group(1)) == declared,
                  "%s: script EXPECTED_CHECKS == %d (enumeration closure self-check)" % (where, declared or -1),
                  "script declares %s" % (match.group(1) if match else "<none>"))
            if key.startswith("s2"):
                check("VECTOR_SET_URI" in script, "%s: script carries the VECTOR_SET_URI placeholder" % where)
                placeholders["VECTOR_SET_URI"] += script.count("VECTOR_SET_URI")
            if key == "s2c-ts-adapter":
                check("BASE_BUNDLE_URI" in script, "%s: script carries the BASE_BUNDLE_URI placeholder" % where)

        validation = spec.get("validation")
        if not check(isinstance(validation, dict), "%s: validation block present" % where):
            continue
        missing = [item for item in VALIDATION_ITEMS if item not in validation]
        check(not missing, "%s: validation carries all three protocol items" % where,
              "" if not missing else "missing %s" % missing)
        check(validation.get("null_tolerance") is True, "%s: null_tolerance is boolean true" % where)
        closure = validation.get("enumeration_closure")
        if isinstance(closure, dict):
            check(isinstance(closure.get("closure"), str) and closure["closure"].strip(),
                  "%s: enumeration_closure declares the closure" % where)
            counts = find_int_counts(closure)
            check(bool(counts), "%s: enumeration_closure carries integer self-check counts" % where)
            selfcheck = closure.get("selfcheck") or {}
            check(selfcheck.get("expected_count") == EXPECTED_COUNTS.get(key),
                  "%s: selfcheck.expected_count == %d" % (where, EXPECTED_COUNTS.get(key) or -1),
                  "got %r" % (selfcheck.get("expected_count"),))
        else:
            bad(where, "enumeration_closure must be an object")
        fidelity = validation.get("proposition_fidelity")
        if not isinstance(fidelity, dict):
            bad(where, "proposition_fidelity must be an object")
        else:
            check(len(list(find_bools(fidelity))) == 0,
                  "%s: proposition_fidelity declares no self-attested boolean" % where)
            correspondence = fidelity.get("correspondence")
            artifact_pin = fidelity.get("artifactPin")
            check(correspondence == artifact_pin and isinstance(correspondence, str),
                  "%s: correspondence and artifactPin agree" % where)
            is_placeholder = correspondence == ARTIFACT_PLACEHOLDER
            check(is_placeholder or (isinstance(correspondence, str) and PIN_REF_RE.match(correspondence)),
                  "%s: correspondence is the documented placeholder or a pin://|metafile:// ref" % where,
                  "got %r" % (correspondence,))
            if is_placeholder:
                placeholders["ARTIFACT_PIN"].add(key)
            check(fidelity.get("artifactKey") == "acceptance-sheet",
                  "%s: artifactKey names the acceptance sheet" % where)
            check(fidelity.get("coverage") == COVERAGE_ITEMS,
                  "%s: fidelity coverage is the protocol's three items" % where)

        validate_workspace(key, spec, bundle_tips)

    for key, plan_value in sorted(plan.items()):
        check(plan_value in (PLAN_STANDALONE, PLAN_BY_PUBLISH),
              "specPinPlan %s: known plan" % key, "got %r" % (plan_value,))

    # ---- task --------------------------------------------------------------
    tasks = drafts.get("tasks") or []
    check(isinstance(tasks, list) and len(tasks) == 1 and tasks[0].get("id") == "metatask-v13-pilot",
          "drafts.tasks: exactly the pilot task")
    task = tasks[0]
    check(task.get("rootSpec") == "s1-behavior-spec-lint",
          "task rootSpec is s1-behavior-spec-lint (S1 inherits it; S5 is the tree root)")
    publish = task.get("publish") or {}
    unknown = sorted(set(publish) - TOOL_TASK_FIELDS)
    check(not unknown, "task.publish: only tool fields", "" if not unknown else "unknown %s" % unknown)
    check(isinstance(publish.get("title"), str) and publish["title"].strip(), "task.publish: title present")
    check(isinstance(publish.get("brief"), str) and publish["brief"].strip(), "task.publish: brief present")
    check(isinstance(publish.get("tags"), list) and all(isinstance(tag, str) for tag in publish["tags"]),
          "task.publish: tags are strings")

    policy = publish.get("policy") or {}
    unknown = sorted(set(policy) - TOOL_POLICY_FIELDS)
    check(not unknown, "policy: tool-shaped camelCase keys only", "" if not unknown else "unknown %s" % unknown)
    check(policy.get("mode") == "competitive", "policy.mode is competitive")
    check(policy.get("finalnode") == "S5", "policy.finalnode is S5 (tool key spelling: finalnode, all lowercase)")
    check(policy.get("verifyQuorum") == 2, "policy.verifyQuorum == 2 (pilot pragmatism, task sheet §4)")
    check(policy.get("challengeTtlDays") == 14, "policy.challengeTtlDays == 14")
    check(policy.get("rewardSat") == 0, "policy.rewardSat == 0 (no escrow, pilot tests mechanism not money)")
    check(policy.get("claimTtlHours") == 0 and policy.get("verifyWindowHours") == 0,
          "policy claim/verify windows are 0 (no semantics in competitive mode, draft §3.10)")
    check(policy.get("submitterShareBP") == 8000, "policy.submitterShareBP == 8000 (top-level tool key; lands as split.submitterShareBP on-chain)")
    check("split" not in policy and "rosterid" not in json.dumps(policy),
          "policy carries no split/rosterid (pilot adjudication: no same-side roster pin)")

    nodes = publish.get("nodes") or []
    ids = [node.get("id") for node in nodes]
    check(sorted(ids) == NODE_IDS and len(set(ids)) == len(ids), "nodes: exactly S1..S5 with the S2 split, unique ids")
    by_id = {node["id"]: node for node in nodes}
    for node in nodes:
        node_where = "node %s" % node.get("id")
        unknown = sorted(set(node) - TOOL_NODE_FIELDS)
        check(not unknown, "%s: tool-shaped keys" % node_where, "" if not unknown else "unknown %s" % unknown)
        check(node.get("kind") == NODE_KINDS.get(node.get("id")),
              "%s: kind matches the task sheet (%s)" % (node_where, NODE_KINDS.get(node.get("id"))))
        check(node.get("weight") == EXPECTED_WEIGHTS.get(node.get("id")),
              "%s: weight == %d (task sheet §3)" % (node_where, EXPECTED_WEIGHTS.get(node.get("id")) or -1))
        check(isinstance(node.get("title"), str) and node["title"].strip(), "%s: title present" % node_where)
        for dep in node.get("deps") or []:
            if dep not in by_id:
                bad(node_where, "unknown dep %r" % dep)
        parent = node.get("parent")
        if parent is not None and parent not in by_id:
            bad(node_where, "unknown parent %r" % (parent,))
        rubric = (node.get("params") or {}).get("rubric")
        rubric_ok = (isinstance(rubric, list)
                     and any(isinstance(entry, str) and entry.strip() for entry in rubric))
        check(rubric_ok, "%s: params.rubric is a string array with >= 1 non-empty entry (draft §3.3)" % node_where,
              "%d entries" % len(rubric) if isinstance(rubric, list) else "got %r" % (rubric,))
        specid = node.get("specid")
        if node.get("id") == "S1":
            check(specid is None, "node S1: specid null (inherits the task root spec)")
        elif isinstance(specid, str) and specid.startswith(SPEC_PIN_PREFIX):
            key = specid[len(SPEC_PIN_PREFIX):]
            placeholders["SPEC_PIN"].add(key)
            check(key in specs, "%s: specid placeholder resolves to a spec" % node_where, key)
            check(plan.get(key) == PLAN_STANDALONE,
                  "%s: spec %s is planned as a standalone pre-pass pin" % (node_where, key))
        else:
            bad(node_where, "specid must be SPEC_PIN:<key> (only S1 inherits the root spec), got %r" % (specid,))

    roots = [node for node in nodes if node.get("parent") is None]
    check(len(roots) == 1 and roots[0].get("id") == "S5",
          "nodes: exactly one root and it is S5 (the terminal/sink carries the tree root, v1.3 fixture convention)")
    total = sum(node.get("weight", 0) for node in nodes)
    check(total == 10000, "nodes: weights sum to exactly 10000", "got %d" % total)

    # parent-graph acyclicity
    cyclic = []
    for node in nodes:
        seen = set()
        cursor = node["id"]
        while cursor is not None:
            if cursor in seen:
                cyclic.append(node["id"])
                break
            seen.add(cursor)
            cursor = (by_id.get(cursor) or {}).get("parent")
    check(not cyclic, "nodes: parent graph acyclic", "" if not cyclic else "cycles at %s" % sorted(set(cyclic)))

    # competitive graph invariants (draft §3.3): finalnode live, deps acyclic,
    # exactly one sink == finalnode, entry reachability both ways.
    check(policy.get("finalnode") in by_id, "competitive: finalnode names a live node")
    deps_ok = all(isinstance(node.get("deps"), list) for node in nodes)
    state = {}

    def acyclic(node_id):
        mark = state.get(node_id)
        if mark == 2:
            return True
        if mark == 1:
            return False
        state[node_id] = 1
        for dep in by_id[node_id].get("deps") or []:
            if dep in by_id and not acyclic(dep):
                return False
        state[node_id] = 2
        return True

    check(deps_ok and all(acyclic(node["id"]) for node in nodes), "competitive: deps graph acyclic")
    referenced = {dep for node in nodes for dep in (node.get("deps") or [])}
    sinks = sorted(node["id"] for node in nodes if node["id"] not in referenced)
    check(sinks == ["S5"], "competitive: exactly one deps sink and it IS finalnode", "sinks=%s" % sinks)

    dependents = {}
    for node in nodes:
        for dep in node.get("deps") or []:
            dependents.setdefault(dep, []).append(node["id"])
    from_entry = set()
    queue = [node["id"] for node in nodes if not (node.get("deps") or [])]
    while queue:
        current = queue.pop()
        if current in from_entry:
            continue
        from_entry.add(current)
        queue.extend(dependents.get(current, []))
    check(from_entry == set(ids), "competitive: every node reachable from an entry node (S1)")

    to_final = set()
    stack = ["S5"]
    while stack:
        current = stack.pop()
        if current in to_final:
            continue
        to_final.add(current)
        stack.extend((by_id.get(current) or {}).get("deps") or [])
    check(to_final == set(ids), "competitive: every node can reach the final node S5")

    # spec root plan consistency
    check(plan.get("s1-behavior-spec-lint") == PLAN_BY_PUBLISH,
          "specPinPlan: the root spec is published by metatask_publish")

    # ---- acceptance sheet ---------------------------------------------------
    with open(SHEET, "r", encoding="utf-8") as handle:
        sheet = handle.read()
    for node_id in NODE_IDS:
        check(("## %s " % node_id) in sheet or ("## %s—" % node_id) in sheet or re.search(r"^## %s\b" % node_id, sheet, re.MULTILINE) is not None,
              "acceptance-sheet.md: names node %s" % node_id)
    for key, count in sorted(EXPECTED_COUNTS.items()):
        check(str(count) in sheet, "acceptance-sheet.md: documents the %s check count (%d)" % (key, count))
    for token in ("VECTOR_SET_URI", "BASE_BUNDLE_URI", "ARTIFACT_PIN:acceptance-sheet", "SPEC_PIN"):
        check(token in sheet, "acceptance-sheet.md: documents placeholder family %s" % token)
        check(token in json.dumps(drafts), "drafts: placeholderTokens documents %s" % token)

    # ---- placeholder inventory ---------------------------------------------
    inventory = []
    inventory.append("VECTOR_SET_URI: embedded in the 3 S2 spec scripts (%d occurrences) — backfill after uploading vector-set/vector-set.tar.gz"
                     % placeholders["VECTOR_SET_URI"])
    for key, spec in sorted(specs.items()):
        base_ref = ((spec.get("workspace") or {}).get("baseRef"))
        if isinstance(base_ref, str) and base_ref.startswith("BASE_BUNDLE_URI:"):
            inventory.append("%s: workspace.baseRef of spec %s — backfill after uploading bundles/%s.bundle"
                             % (base_ref, key, base_ref.split(":", 1)[1]))
    for key in sorted(placeholders["ARTIFACT_PIN"]):
        inventory.append("ARTIFACT_PIN:acceptance-sheet: validation.proposition_fidelity of spec %s — backfill after uploading acceptance-sheet.md" % key)
    for key in sorted(placeholders["SPEC_PIN"]):
        inventory.append("SPEC_PIN:%s: node specid override — backfill from metatask_publish_spec" % key)

    print("\n".join(checks))
    print("\nplaceholder inventory (%d backfill items):" % len(inventory))
    for item in inventory:
        print("  - %s" % item)
    if errors:
        print("\nPILOT DRAFTS NOT READY — %d failure(s):" % len(errors))
        for message in errors:
            print("  - %s" % message)
        return 1
    print("\nPILOT DRAFTS READY — every check passed (%d checks, %d placeholders pending backfill)"
          % (len(checks), len(inventory)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
