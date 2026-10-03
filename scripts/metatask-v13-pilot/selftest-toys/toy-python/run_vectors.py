#!/usr/bin/env python3
"""
Toy vector runner (S2a selftest fixture) — drives the toy python engine over a
vector-set directory per the pilot runner contract: PASS/FAIL per vector, then
ENGINE + CANONICAL_SHA256 lines; exit 0 iff all pass.

Canonical per-vector output:
  hash vector:   {"id", "inner", "outer"}
  replay vector: {"id", "nodes": {id: status}, "taskComplete", "engineAlgoVersion"}
"""
import hashlib
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import metatask_replay  # noqa: E402


def canonJ(obj):
    return json.dumps(obj, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha256_hex(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def inner_hash(result):
    return sha256_hex(canonJ({k: v for k, v in result.items() if k != "hash"}))


def outer_hash(result):
    return sha256_hex(canonJ(result))


def main():
    vectors_dir = sys.argv[1]
    outputs = []
    failed = 0
    for name in sorted(os.listdir(vectors_dir)):
        if not name.endswith(".json"):
            continue
        with open(os.path.join(vectors_dir, name), "r", encoding="utf-8") as handle:
            vector_set = json.load(handle)
        for vector in vector_set.get("vectors", []):
            vector_id = vector.get("id")
            expect = vector.get("expect") or {}
            notes = []
            if vector.get("kind") == "hash":
                inner = inner_hash(vector.get("input") or {})
                outer = outer_hash(dict(vector.get("input") or {}, hash=inner))
                if inner != vector.get("expectInner"):
                    notes.append("inner mismatch")
                if outer != vector.get("expectOuter"):
                    notes.append("outer mismatch")
                outputs.append({"id": vector_id, "inner": inner, "outer": outer})
            else:
                root = None
                for event in vector.get("events") or []:
                    if isinstance(event, dict) and event.get("path") == "task":
                        root = event.get("pinId")
                projection = metatask_replay.replay(vector.get("events") or [], root,
                                                    now=(vector.get("options") or {}).get("now"))
                nodes = {k: v.get("status") for k, v in projection["nodeStates"].items()}
                for node_id, wanted in (expect.get("nodes") or {}).items():
                    if nodes.get(node_id) != wanted:
                        notes.append("%s=%s want %s" % (node_id, nodes.get(node_id), wanted))
                if "taskComplete" in expect and projection["taskComplete"] != expect["taskComplete"]:
                    notes.append("taskComplete=%s want %s" % (projection["taskComplete"], expect["taskComplete"]))
                algo = (projection.get("settlement") or {}).get("engineAlgoVersion")
                if "engineAlgoVersion" in expect and algo != expect["engineAlgoVersion"]:
                    notes.append("engineAlgoVersion=%s want %s" % (algo, expect["engineAlgoVersion"]))
                outputs.append({"id": vector_id, "nodes": nodes, "taskComplete": projection["taskComplete"],
                                "engineAlgoVersion": algo})
            if notes:
                failed += 1
                print("FAIL %s: %s" % (vector_id, "; ".join(notes)))
            else:
                print("PASS %s" % vector_id)
    # ENGINE line: the engineAlgoVersion this engine reports for competitive-mode
    # tasks (1.3.0 when any replay vector exercised competitive mode).
    seen = {output.get("engineAlgoVersion") for output in outputs if output.get("engineAlgoVersion")}
    algo_line = "idbots-metatask-engine/1.3.0" if "idbots-metatask-engine/1.3.0" in seen else "idbots-metatask-engine/1.2.1"
    print("ENGINE metatask-replay-python %s" % algo_line)
    print("CANONICAL_SHA256 %s" % sha256_hex(canonJ(outputs)))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
