#!/usr/bin/env python3
"""
validate-task-draft.py — generalized pre-publish dry-run validator for ANY
competitive-mode MetaTask campaign drafts file (the metatask_publish /
metatask_publish_spec draftsFile shape).

This is the generalized successor of scripts/metatask-v13-pilot/
validate-pilot-drafts.py: same writer-side invariant discipline, but bound to
no pilot content — it validates whatever draft you point it at. It refuses
(exit 1) unless every invariant the tools enforce holds in the draft, PLUS the
v1.3 competitive-mode graph invariants from the protocol draft
(docs/metaid_protocols/metatask-protocol-v1.3-competitive-draft.md §3.3),
PLUS rubric-quality lints (advisory WARNs — the human decides):

  * file shape: top-level specs{} map + tasks[] array (campaign drafts shape)
  * no staging/template keys leak into the final draft (scriptFile and
    friends, snake_case policy keys) — annotation keys starting with "_" are
    tolerated everywhere (the publish tools read fields by name and drop the
    rest)
  * every spec is tool-shaped (name/lang/entry/script inline + input/output +
    the three-item validation block: null_tolerance boolean true,
    enumeration_closure with a closure string + integer self-check counts,
    proposition_fidelity referencing an INDEPENDENT correspondence artifact —
    a pin://|metafile:// ref or a documented PLACEHOLDER, never a
    self-attested boolean)
  * workspace/result contract: workspace.type git implies the git-bundle
    submission contract (baseRef a pin ref or placeholder, baseCommit 40-hex
    or null for greenfield, METATASK_COMMIT in the input descriptor);
    non-git specs must declare METATASK_ARTIFACT_URI
  * competitive graph invariants (draft §3.3): policy.finalnode names a live
    node; deps reference existing nodes and are acyclic; exactly ONE deps
    sink and it IS finalnode; every node reachable from an entry node and
    able to reach finalnode; every node carries a non-empty params.rubric
    (string array, >= 1 non-empty entry)
  * tool-policy shape: camelCase keys only (the terminal-node key is the
    tool's own spelling "finalnode", all lowercase — "finalNode" is accepted
    with a WARN); mode competitive; verifyQuorum integer >= 1 (1 = WARN);
    challengeTtlDays positive; rewardSat 0 (no escrow in v1.3);
    claimTtlHours/verifyWindowHours 0 (no semantics in competitive mode,
    draft §3.10); submitterShareBP in [6000, 9000] at policy top level (the
    tool lands it as split.submitterShareBP on-chain) or nested under split
  * weights are integers in [1, 10000] summing to exactly 10000; a single
    node over 4000 WARNs (consider splitting into multiple independent
    tasks); more than 10 nodes WARNs (race windows fragment)
  * rubric lint (WARN, heuristic): fewer than 2 entries; an entry shorter
    than 12 characters (slogan suspect — undecidable); an entry carrying
    unjudgeable wording ("做好/完成/优化/合适", "improve/optimize/
    appropriate/reasonable/polish", ...) with no concrete anchor (a number,
    a comparison, a quoted identifier, an enumeration)
  * spec references: every node specid is null (inherits the task root
    spec), a SPEC_PIN:<key> placeholder resolving into specs{}, or a
    pin://|metafile:// ref; every task's rootSpec exists in specs{}
  * every placeholder is inventoried at the end (SPEC_PIN:<key> is resolved
    at publish time via specPinByKey; ARTIFACT_PIN:/BASE_BUNDLE_URI:/
    *_URI-style tokens must be backfilled into the file, then re-validate)

Usage:
  python3 scripts/metatask-wizard/validate-task-draft.py <draft.json> [--task <taskId>]

Exit 0 prints TASK DRAFT READY (WARNs allowed — they are advisory); exit 1
prints every failure and TASK DRAFT NOT READY.
"""
import json
import os
import re
import sys

TOOL_SPEC_FIELDS = {"name", "lang", "entry", "script", "input", "output", "validation", "workspace"}
TOOL_TASK_FIELDS = {"title", "brief", "nodes", "policy", "tags"}
TOOL_NODE_FIELDS = {"id", "parent", "title", "kind", "specid", "params", "deps", "weight"}
TOOL_POLICY_FIELDS = {"mode", "finalnode", "finalNode", "claimTtlHours", "verifyQuorum",
                      "verifyWindowHours", "rewardSat", "challengeTtlDays", "submitterShareBP", "split"}
SPLIT_FIELDS = {"submitterShareBP", "rosterid"}
STAGING_KEYS = {"scriptFile", "script_file", "policyOverride", "claim_ttl_hours", "verify_window_hours",
                "verify_quorum", "reward_sat", "challenge_ttl_days", "specId", "final_node"}
VALIDATION_ITEMS = ("null_tolerance", "enumeration_closure", "proposition_fidelity")
# v1.3.0 registration (2026-10-04) closed the enum including 'metaapp'.
WORKSPACE_TYPES = ("git", "metafile", "inline", "pin", "metaapp")
PIN_REF_RE = re.compile(r"^(pin://|metafile://)\S+$")
GIT_COMMIT_RE = re.compile(r"^[0-9a-f]{40}$")
SPEC_PIN_PREFIX = "SPEC_PIN:"
# PREFIX:key placeholder families that must be backfilled before publish
# (SPEC_PIN is the exception: resolved at publish time via specPinByKey).
PREFIX_PLACEHOLDER_RE = re.compile(r"\b(SPEC_PIN|ARTIFACT_PIN|BASE_BUNDLE_URI):[A-Za-z0-9._-]+")
# Bare ALL-CAPS placeholder tokens (VECTOR_SET_URI style): ends in _URI or
# _PIN, never the METATASK_* verifier environment contract, and never the
# family half of a PREFIX:key token (that is caught whole by the regex above).
BARE_PLACEHOLDER_RE = re.compile(r"\b(?!METATASK_)[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*(?:_URI|_PIN)\b(?!:)")
# Rubric lint vocabularies.
UNJUDGEABLE_ZH = ("做好", "做完", "完成好", "优化", "合适", "完善", "改进", "尽量", "高质量",
                  "好用", "美观", "合理", "完成", "弄好", "搞好")
UNJUDGEABLE_EN_RE = re.compile(
    r"\b(improve|improvement|optimize|optimise|optimization|optimisation|appropriate|appropriately|"
    r"reasonable|reasonably|polish|polished|user-friendly|high-quality|good quality|best practice|"
    r"as needed|if necessary|properly|nicely)\b", re.IGNORECASE)
# A concrete anchor rescues an otherwise suspicious rubric entry: a number, a
# comparison/percentage, a quoted identifier, or an enumeration after a colon.
ANCHOR_RE = re.compile(r"[0-9≥≤<>±%×$]|`[^`]+`|「[^」]+」|\"[^\"]+\"|'[^']+'|[:：]\s*\S")
MIN_RUBRIC_ENTRY_LEN = 12
MAX_NODE_WEIGHT = 4000
MAX_NODES = 10

errors = []
warnings = []
checks = []


def ok(name, detail=""):
    checks.append("OK   %s%s" % (name, (" — " + detail) if detail else ""))


def bad(name, detail):
    errors.append("%s: %s" % (name, detail))
    checks.append("FAIL %s: %s" % (name, detail))


def warn(name, detail):
    warnings.append("%s: %s" % (name, detail))
    checks.append("WARN %s: %s" % (name, detail))


def check(condition, name, detail=""):
    if condition:
        ok(name, detail)
    else:
        bad(name, detail)
    return bool(condition)


def known_keys_only(mapping, allowed, where):
    """FAIL on keys outside the tool shape; '_'-prefixed annotation keys pass."""
    unknown = sorted(key for key in mapping if key not in allowed and not key.startswith("_"))
    check(not unknown, "%s: only tool-shaped keys" % where,
          "" if not unknown else "unknown %s" % unknown)


def walk_strings(node, path="$"):
    if isinstance(node, dict):
        for key, value in node.items():
            yield from walk_strings(value, "%s.%s" % (path, key))
    elif isinstance(node, list):
        for index, value in enumerate(node):
            yield from walk_strings(value, "%s[%d]" % (path, index))
    elif isinstance(node, str):
        yield path, node


def walk_keys(node):
    if isinstance(node, dict):
        for key, value in node.items():
            yield key
            yield from walk_keys(value)
    elif isinstance(node, list):
        for value in node:
            yield from walk_keys(value)


def find_int_counts(node):
    found = []
    if isinstance(node, dict):
        for value in node.values():
            found.extend(find_int_counts(value))
    elif isinstance(node, list):
        for value in node:
            found.extend(find_int_counts(value))
    elif isinstance(node, int) and not isinstance(node, bool):
        found.append(node)
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


def is_placeholder_ref(value):
    return bool(PREFIX_PLACEHOLDER_RE.search(value) or BARE_PLACEHOLDER_RE.search(value))


def validate_specs(drafts):
    specs = drafts.get("specs")
    if not check(isinstance(specs, dict) and bool(specs), "drafts.specs: non-empty specs{} map"):
        return {}
    for key, spec in sorted(specs.items()):
        where = "spec %s" % key
        if not check(isinstance(spec, dict), "%s: spec entry is an object" % where):
            continue
        known_keys_only(spec, TOOL_SPEC_FIELDS, where)
        check(spec.get("name") == key, "%s: name == spec key" % where, "got %r" % (spec.get("name"),))
        check(isinstance(spec.get("lang"), str) and spec["lang"].strip(), "%s: lang present" % where)
        check(isinstance(spec.get("entry"), str) and spec["entry"].strip(), "%s: entry present" % where)
        check(isinstance(spec.get("script"), str) and spec["script"].strip(),
              "%s: script inlined (draftsFile mode publishes the inline text)" % where)
        check(spec.get("input") not in (None, ""), "%s: input descriptor present" % where)
        check(spec.get("output") not in (None, ""), "%s: output descriptor present" % where)

        validation = spec.get("validation")
        if not check(isinstance(validation, dict), "%s: validation block present" % where):
            validation = None
        if validation is not None:
            missing = [item for item in VALIDATION_ITEMS if item not in validation]
            check(not missing, "%s: validation carries all three protocol items" % where,
                  "" if not missing else "missing %s" % missing)
            check(validation.get("null_tolerance") is True, "%s: null_tolerance is boolean true" % where)
            closure = validation.get("enumeration_closure")
            if isinstance(closure, dict):
                check(isinstance(closure.get("closure"), str) and closure["closure"].strip(),
                      "%s: enumeration_closure declares the closure" % where)
                check(bool(find_int_counts(closure.get("selfcheck"))),
                      "%s: enumeration_closure carries integer self-check counts" % where)
            elif "enumeration_closure" in validation:
                bad(where, "enumeration_closure must be an object")
            fidelity = validation.get("proposition_fidelity")
            if isinstance(fidelity, dict):
                check(len(list(find_bools(fidelity))) == 0,
                      "%s: proposition_fidelity declares no self-attested boolean" % where)
                correspondence = fidelity.get("correspondence")
                artifact_pin = fidelity.get("artifactPin")
                check(isinstance(correspondence, str) and correspondence == artifact_pin,
                      "%s: correspondence and artifactPin agree" % where)
                if isinstance(correspondence, str):
                    check(PIN_REF_RE.match(correspondence) is not None or is_placeholder_ref(correspondence),
                          "%s: correspondence is an independent artifact (pin://|metafile:// ref or a documented placeholder)" % where,
                          "got %r" % (correspondence,))
            elif "proposition_fidelity" in validation:
                bad(where, "proposition_fidelity must be an object")

        workspace = spec.get("workspace")
        if not check(isinstance(workspace, dict), "%s: workspace declared (draft §4.1)" % where):
            continue
        wtype = workspace.get("type")
        if wtype not in WORKSPACE_TYPES:
            warn("%s: workspace.type" % where,
                 "%r is outside the draft §4.1 enum %s — a deliberate extension must say so in the task sheet"
                 % (wtype, "/".join(WORKSPACE_TYPES)))
        input_text = json.dumps(spec.get("input"), ensure_ascii=False)
        if wtype == "git":
            if "baseCommit" not in workspace:
                bad("%s: workspace.baseCommit" % where, "git workspace must declare baseCommit (40-hex, or null for a greenfield node, draft §4.4)")
            else:
                base_commit = workspace.get("baseCommit")
                check(base_commit is None or (isinstance(base_commit, str) and GIT_COMMIT_RE.match(base_commit)),
                      "%s: workspace.baseCommit is a 40-hex commit or null (greenfield)" % where,
                      "got %r" % (base_commit,))
            base_ref = workspace.get("baseRef")
            if base_ref is None:
                if workspace.get("baseCommit"):
                    bad("%s: workspace.baseRef" % where, "missing while baseCommit is set — pin the base repository as a git-bundle metafile (draft §4.4)")
                else:
                    warn("%s: workspace.baseRef" % where,
                         "absent with null baseCommit — implicit greenfield; pinning an empty-tree base bundle is cleaner (draft §4.4)")
            else:
                check(isinstance(base_ref, str) and (PIN_REF_RE.match(base_ref) or is_placeholder_ref(base_ref)),
                      "%s: workspace.baseRef is a pin://|metafile:// ref or a documented placeholder" % where,
                      "got %r" % (base_ref,))
            if "METATASK_COMMIT" in input_text:
                ok("%s: git workspace declares the git-bundle result contract (METATASK_COMMIT in the input descriptor)" % where)
            else:
                warn("%s: workspace/result contract" % where,
                     "workspace.type git implies result.type git-bundle — the input descriptor should name METATASK_COMMIT/METATASK_BASE_COMMIT (draft §4.2/§4.3)")
        else:
            if "METATASK_ARTIFACT_URI" in input_text:
                ok("%s: input descriptor names METATASK_ARTIFACT_URI (the submission artifact)" % where)
            else:
                warn("%s: workspace/result contract" % where,
                     "non-git workspace — the input descriptor should name METATASK_ARTIFACT_URI so reviewers know how the artifact arrives")
    return specs


def validate_policy(policy, task_where):
    check(isinstance(policy, dict), "%s: policy object present" % task_where)
    if not isinstance(policy, dict):
        return None
    known_keys_only(policy, TOOL_POLICY_FIELDS, "%s policy" % task_where)
    if "finalNode" in policy:
        if "finalnode" in policy:
            bad("%s policy" % task_where, "both finalnode and finalNode present — keep exactly one (the tool's spelling is finalnode, all lowercase)")
        else:
            warn("%s policy" % task_where, "finalNode accepted, but the tool's input spelling is finalnode (all lowercase) — rename before publish")
    finalnode = policy.get("finalnode", policy.get("finalNode"))
    check(policy.get("mode") == "competitive", "%s policy: mode is competitive" % task_where,
          "got %r" % (policy.get("mode"),))
    check(isinstance(finalnode, str) and finalnode.strip(), "%s policy: finalnode names the terminal node" % task_where)
    quorum = policy.get("verifyQuorum")
    check(isinstance(quorum, int) and not isinstance(quorum, bool) and quorum >= 1,
          "%s policy: verifyQuorum is an integer >= 1" % task_where, "got %r" % (quorum,))
    if quorum == 1:
        warn("%s policy: verifyQuorum" % task_where, "1 means a single reviewer is the whole adjudication — 2+ is the pilot floor, 3 is the production suggestion")
    ttl = policy.get("challengeTtlDays")
    if ttl is not None:
        check(isinstance(ttl, int) and not isinstance(ttl, bool) and ttl > 0,
              "%s policy: challengeTtlDays is a positive integer" % task_where, "got %r" % (ttl,))
    reward = policy.get("rewardSat")
    check(reward in (None, 0), "%s policy: rewardSat is 0 (no escrow in the v1.3 draft; settlement is shareBP only)" % task_where,
          "got %r" % (reward,))
    for key in ("claimTtlHours", "verifyWindowHours"):
        value = policy.get(key)
        check(value in (None, 0), "%s policy: %s is 0 (no semantics in competitive mode, draft §3.10 — set 0 to signal intent)" % (task_where, key),
              "got %r" % (value,))
    top_share = policy.get("submitterShareBP")
    split = policy.get("split")
    if split is not None:
        check(isinstance(split, dict), "%s policy: split is an object" % task_where)
        if isinstance(split, dict):
            known_keys_only(split, SPLIT_FIELDS, "%s policy.split" % task_where)
            if "rosterid" in split:
                warn("%s policy: split.rosterid" % task_where,
                     "a publisher-set roster narrows the reviewer pool — the pilot omitted it deliberately so any non-publisher bot may verify")
    nested_share = split.get("submitterShareBP") if isinstance(split, dict) else None
    if top_share is not None and nested_share is not None:
        bad("%s policy" % task_where, "submitterShareBP set both at policy top level and under split — keep exactly one (top level is the tool's input shape)")
    share = top_share if top_share is not None else nested_share
    if share is None:
        ok("%s policy: submitterShareBP" % task_where, "absent — the tool default 8000 applies")
    else:
        check(isinstance(share, int) and not isinstance(share, bool) and 6000 <= share <= 9000,
              "%s policy: submitterShareBP in [6000, 9000] (lands as split.submitterShareBP on-chain)" % task_where,
              "got %r" % (share,))
    return finalnode if isinstance(finalnode, str) else None


def lint_rubric(node_where, rubric):
    entries = [entry for entry in rubric if isinstance(entry, str) and entry.strip()]
    if len(entries) < 2:
        warn("%s: rubric lint" % node_where,
             "only %d entr%s — a single-line rubric collapses adjudication to one judgeable axis; aim for 3-7 decidable entries"
             % (len(entries), "y" if len(entries) == 1 else "ies"))
    for index, entry in enumerate(entries, 1):
        stripped = entry.strip()
        if len(stripped) < MIN_RUBRIC_ENTRY_LEN:
            warn("%s: rubric lint" % node_where,
                 "entry %d is %d chars (<%d) — slogan suspect, too short to be decidable: %r"
                 % (index, len(stripped), MIN_RUBRIC_ENTRY_LEN, stripped))
        zh_hit = next((word for word in UNJUDGEABLE_ZH if word in stripped), None)
        en_hit = UNJUDGEABLE_EN_RE.search(stripped)
        if (zh_hit or en_hit) and not ANCHOR_RE.search(stripped):
            warn("%s: rubric lint" % node_where,
                 "entry %d carries unjudgeable wording (%r) with no concrete anchor — a reviewer cannot objectively pass/fail it: %r"
                 % (index, zh_hit or en_hit.group(0), stripped))


def validate_nodes(publish, finalnode, specs, task_where):
    nodes = publish.get("nodes")
    if not check(isinstance(nodes, list) and bool(nodes), "%s: publish.nodes is a non-empty array" % task_where):
        return
    by_id = {}
    ids = []
    for node in nodes:
        if isinstance(node, dict) and isinstance(node.get("id"), str) and node["id"].strip():
            if node["id"] in by_id:
                bad(task_where, "duplicate node id %r" % node["id"])
            by_id[node["id"]] = node
            ids.append(node["id"])
        else:
            bad(task_where, "a node is missing a non-empty string id")
    check(len(set(ids)) == len(ids), "%s: node ids unique" % task_where)
    if len(nodes) > MAX_NODES:
        warn("%s: node count" % task_where,
             "%d nodes (>%d) — race windows fragment; consider splitting into multiple independent tasks" % (len(nodes), MAX_NODES))

    for node in nodes:
        if not isinstance(node, dict):
            continue
        node_id = node.get("id") if isinstance(node.get("id"), str) else "<?>"
        node_where = "%s node %s" % (task_where, node_id)
        known_keys_only(node, TOOL_NODE_FIELDS, node_where)
        check(isinstance(node.get("title"), str) and node["title"].strip(), "%s: title present" % node_where)
        if not (isinstance(node.get("kind"), str) and (node.get("kind") or "").strip()):
            warn("%s: kind" % node_where, "missing — declare a node kind (formalize/implement/aggregate/triage/publish, or your own)")
        parent = node.get("parent")
        if parent is not None and parent not in by_id:
            bad(node_where, "unknown parent %r" % (parent,))
        deps = node.get("deps")
        if not check(isinstance(deps, list), "%s: deps is an array (entry nodes use [])" % node_where):
            deps = []
        else:
            for dep in deps:
                if dep not in by_id:
                    bad(node_where, "unknown dep %r" % (dep,))
            if len(set(deps)) != len(deps):
                warn("%s: deps" % node_where, "duplicate entries in deps")
        weight = node.get("weight")
        check(isinstance(weight, int) and not isinstance(weight, bool) and 1 <= weight <= 10000,
              "%s: weight is an integer in [1, 10000]" % node_where, "got %r" % (weight,))
        if isinstance(weight, int) and not isinstance(weight, bool) and weight > MAX_NODE_WEIGHT:
            warn("%s: weight" % node_where,
                 "%d/10000 (>%d) on one node — that much share on a single judgment concentrates settlement risk; consider splitting into multiple independent tasks"
                 % (weight, MAX_NODE_WEIGHT))
        params = node.get("params")
        rubric = params.get("rubric") if isinstance(params, dict) else None
        rubric_ok = (isinstance(rubric, list)
                     and all(isinstance(entry, str) for entry in rubric)
                     and any(entry.strip() for entry in rubric))
        check(rubric_ok,
              "%s: params.rubric is a string array with >= 1 non-empty entry (draft §3.3 — the reviewer's acceptance checklist)" % node_where,
              "%d entries" % len(rubric) if isinstance(rubric, list) else "got %r" % (rubric,))
        if rubric_ok:
            lint_rubric(node_where, rubric)
        specid = node.get("specid")
        if specid is None:
            ok("%s: specid" % node_where, "null — inherits the task root spec")
        elif isinstance(specid, str) and specid.startswith(SPEC_PIN_PREFIX):
            key = specid[len(SPEC_PIN_PREFIX):]
            check(key in specs, "%s: specid placeholder SPEC_PIN:%s resolves into specs{}" % (node_where, key))
        elif isinstance(specid, str) and PIN_REF_RE.match(specid):
            ok("%s: specid" % node_where, "already-published spec ref")
        else:
            bad(node_where, "specid must be null, SPEC_PIN:<key>, or a pin://|metafile:// ref — got %r" % (specid,))

    # ---- tree shape (parent graph) ------------------------------------------
    roots = [node["id"] for node in nodes if isinstance(node, dict) and node.get("parent") is None and isinstance(node.get("id"), str)]
    check(len(roots) == 1, "%s: exactly one tree root (parent: null)" % task_where, "roots=%s" % roots)
    cyclic = []
    for node_id in ids:
        seen = set()
        cursor = node_id
        while cursor is not None:
            if cursor in seen:
                cyclic.append(node_id)
                break
            seen.add(cursor)
            cursor = (by_id.get(cursor) or {}).get("parent")
    check(not cyclic, "%s: parent graph acyclic" % task_where, "" if not cyclic else "cycles at %s" % sorted(set(cyclic)))

    # ---- competitive graph invariants (draft §3.3) ---------------------------
    check(finalnode in by_id, "%s: finalnode %r names a live node" % (task_where, finalnode))
    if finalnode in by_id and roots and roots[0] != finalnode:
        warn("%s: tree root" % task_where,
             "root is %r but finalnode is %r — the pilot convention puts the tree root ON the terminal node so the chain view reads left-to-right"
             % (roots[0], finalnode))
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

    check(all(acyclic(node_id) for node_id in ids if node_id in by_id),
          "%s: deps graph acyclic (competitive mode enforces the partial order)" % task_where)
    referenced = {dep for node in nodes if isinstance(node, dict) for dep in (node.get("deps") or [])}
    sinks = sorted(node_id for node_id in ids if node_id not in referenced)
    check(sinks == [finalnode], "%s: exactly one deps sink and it IS finalnode" % task_where,
          "sinks=%s finalnode=%r" % (sinks, finalnode))
    entries = [node_id for node_id in ids if not (by_id[node_id].get("deps") or [])]
    check(bool(entries), "%s: at least one entry node (deps: [])" % task_where)

    dependents = {}
    for node in nodes:
        if not isinstance(node, dict):
            continue
        for dep in node.get("deps") or []:
            dependents.setdefault(dep, []).append(node.get("id"))
    from_entry = set()
    queue = list(entries)
    while queue:
        current = queue.pop()
        if current in from_entry:
            continue
        from_entry.add(current)
        queue.extend(dependents.get(current, []))
    check(from_entry == set(ids), "%s: every node reachable from an entry node" % task_where,
          "" if from_entry == set(ids) else "unreachable: %s" % sorted(set(ids) - from_entry))
    to_final = set()
    stack = [finalnode] if finalnode in by_id else []
    while stack:
        current = stack.pop()
        if current in to_final:
            continue
        to_final.add(current)
        stack.extend((by_id.get(current) or {}).get("deps") or [])
    check(to_final == set(ids), "%s: every node can reach the final node" % task_where,
          "" if to_final == set(ids) else "cannot reach %r: %s" % (finalnode, sorted(set(ids) - to_final)))

    total = sum(node.get("weight", 0) for node in nodes
                if isinstance(node, dict) and isinstance(node.get("weight"), int) and not isinstance(node.get("weight"), bool))
    check(total == 10000, "%s: weights sum to exactly 10000" % task_where, "got %d" % total)


def validate_task(task, specs):
    task_id = task.get("id", task.get("taskId")) if isinstance(task, dict) else None
    task_where = "task %s" % (task_id or "<?>")
    check(isinstance(task_id, str) and task_id.strip(), "tasks[] entry: non-empty id present")
    if not isinstance(task, dict):
        bad("tasks[] entry", "not an object")
        return
    root_spec = task.get("rootSpec")
    check(isinstance(root_spec, str) and root_spec in specs,
          "%s: rootSpec names a specs{} entry (the task root verifier spec)" % task_where,
          "got %r" % (root_spec,))
    publish = task.get("publish")
    if not check(isinstance(publish, dict), "%s: publish object present" % task_where):
        return
    known_keys_only(publish, TOOL_TASK_FIELDS, "%s publish" % task_where)
    check(isinstance(publish.get("title"), str) and publish["title"].strip(), "%s: title present" % task_where)
    check(isinstance(publish.get("brief"), str) and publish["brief"].strip(), "%s: brief present" % task_where)
    tags = publish.get("tags")
    check(isinstance(tags, list) and all(isinstance(tag, str) for tag in tags), "%s: tags are strings" % task_where)
    finalnode = validate_policy(publish.get("policy"), task_where)
    validate_nodes(publish, finalnode, specs, task_where)
    referenced = {root_spec} if isinstance(root_spec, str) else set()
    for node in publish.get("nodes") or []:
        if isinstance(node, dict):
            specid = node.get("specid")
            if isinstance(specid, str) and specid.startswith(SPEC_PIN_PREFIX):
                referenced.add(specid[len(SPEC_PIN_PREFIX):])
    unreferenced = sorted(key for key in specs if key not in referenced)
    if unreferenced:
        warn("%s: specs{} coverage" % task_where,
             "specs never referenced by this task (rootSpec or node specid): %s — stray specs are never published"
             % ", ".join(unreferenced))


def placeholder_inventory(drafts):
    """Return {family: {token: [json paths]}} for every placeholder token.

    PREFIX:key tokens (SPEC_PIN:/ARTIFACT_PIN:/BASE_BUNDLE_URI:) are always
    tooling placeholders. A bare ALL-CAPS *_URI/*_PIN token only counts when
    it appears in a self-referential position — a string whose whole value IS
    the token ("baseRef": "VECTOR_SET_URI") or an assignment quoting the
    token as its own value (readonly VECTOR_SET_URI="VECTOR_SET_URI") — which
    is how publish-time placeholders are seeded. Shell locals like
    ARTIFACT_URI="$METATASK_ARTIFACT_URI" never self-reference and stay out.
    """
    strings = list(walk_strings(drafts))
    families = {}

    def record(token, path):
        family = token.split(":", 1)[0] if ":" in token else token
        families.setdefault(family, {}).setdefault(token, []).append(path)

    bare_candidates = set()
    for path, text in strings:
        for match in PREFIX_PLACEHOLDER_RE.finditer(text):
            record(match.group(0), path)
        for match in BARE_PLACEHOLDER_RE.finditer(text):
            bare_candidates.add(match.group(0))
    for token in sorted(bare_candidates):
        assignment = re.compile(r"(?:=|:)\s*\"%s\"(?![\w$])" % re.escape(token))
        genuine_paths = [path for path, text in strings
                         if text.strip() == token or assignment.search(text)]
        for path in genuine_paths:
            record(token, path)
    return families


def main(argv):
    if len(argv) < 2 or argv[1] in ("-h", "--help"):
        print(__doc__.strip().splitlines()[0])
        print("Usage: python3 %s <draft.json> [--task <taskId>]" % os.path.basename(argv[0]))
        return 1
    draft_path = argv[1]
    only_task = None
    if "--task" in argv:
        index = argv.index("--task")
        if index + 1 >= len(argv):
            print("--task requires a taskId")
            return 1
        only_task = argv[index + 1]
    try:
        with open(draft_path, "r", encoding="utf-8") as handle:
            drafts = json.load(handle)
    except (OSError, ValueError) as err:
        print("FAIL cannot read draft %s: %s" % (draft_path, err))
        print("\nTASK DRAFT NOT READY")
        return 1
    if not isinstance(drafts, dict):
        print("FAIL draft %s must contain a JSON object" % draft_path)
        print("\nTASK DRAFT NOT READY")
        return 1

    # ---- staging keys --------------------------------------------------------
    offending = sorted({key for key in walk_keys(drafts) if key in STAGING_KEYS})
    check(not offending, "drafts: no staging/template keys leak into the final file",
          "" if not offending else "found %s (template/staging only — embed values inline)" % offending)

    # ---- specs ---------------------------------------------------------------
    specs = validate_specs(drafts)

    # ---- tasks ---------------------------------------------------------------
    tasks = drafts.get("tasks")
    if check(isinstance(tasks, list) and bool(tasks), "drafts.tasks: non-empty tasks[] array"):
        seen_ids = set()
        for task in tasks:
            if isinstance(task, dict):
                task_id = task.get("id", task.get("taskId"))
                if task_id in seen_ids:
                    bad("drafts.tasks", "duplicate task id %r" % (task_id,))
                seen_ids.add(task_id)
        selected = [task for task in tasks
                    if only_task is None or (isinstance(task, dict) and only_task in (task.get("id"), task.get("taskId")))]
        if only_task is not None and not selected:
            bad("drafts.tasks", "no tasks[] entry with id %r" % only_task)
        for task in selected:
            validate_task(task, specs)

    # ---- placeholder inventory -----------------------------------------------
    families = placeholder_inventory(drafts)
    inventory = []
    for family in sorted(families):
        tokens = families[family]
        count = sum(len(paths) for paths in tokens.values())
        for token in sorted(tokens):
            paths = tokens[token]
            inventory.append("%s ×%d — first seen at %s" % (token, len(paths), paths[0]))
        if family == SPEC_PIN_PREFIX[:-1]:
            ok("placeholders: SPEC_PIN family", "%d token(s), resolved at publish time via specPinByKey" % count)
        else:
            warn("placeholders: %s family" % family,
                 "%d occurrence(s) pending backfill (%s) — edit the drafts file with the real pin/URI, then re-validate"
                 % (count, ", ".join(sorted(tokens)[:4])))

    print("\n".join(checks))
    print("\nplaceholder inventory (%d backfill/resolution items):" % len(inventory))
    for item in inventory:
        print("  - %s" % item)
    if errors:
        print("\nTASK DRAFT NOT READY — %d failure(s), %d warning(s):" % (len(errors), len(warnings)))
        for message in errors:
            print("  - %s" % message)
        return 1
    print("\nTASK DRAFT READY — every blocking check passed (%d checks, %d warning(s), %d placeholder(s) pending)"
          % (len(checks), len(warnings), len(inventory)))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
