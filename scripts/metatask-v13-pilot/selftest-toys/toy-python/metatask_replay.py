#!/usr/bin/env python3
"""
Toy S2a "pseudo-passing" engine — selftest fixture ONLY.

Implements the CLI contract from the S2a base README with minimal semantics,
just enough for the selftest mini vector set: hash vectors (canonJ inner/outer)
and a minimal competitive replay (verified = >= quorum pass votes from voters
who are neither the submitter nor the publisher; taskComplete = the finalnode
verified). It is NOT a real MetaTask engine.
"""
import argparse
import hashlib
import json
import sys


def canonJ(obj):
    return json.dumps(obj, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha256_hex(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def load_events(path):
    with open(path, "r", encoding="utf-8") as handle:
        data = json.load(handle)
    if isinstance(data, list):
        return data, {}
    if isinstance(data, dict) and isinstance(data.get("events"), list):
        return data["events"], data.get("options") or {}
    raise ValueError("events file must be a JSON array or an object with an events array")


def replay(events, root, now=None, guard=False):
    task = None
    for event in events:
        if isinstance(event, dict) and event.get("path") == "task":
            task = event  # latest task pin wins (toy)
    if task is None:
        raise ValueError("no task event found")
    tree = None
    for event in events:
        if isinstance(event, dict) and event.get("path") == "tree" and event.get("pinId") == (task.get("body") or {}).get("treeid"):
            tree = event
    if tree is None:
        raise ValueError("no tree event for task")
    policy = (task.get("body") or {}).get("policy") or {}
    quorum = int(policy.get("verify_quorum") or 1)
    publisher = task.get("author")
    finalnode = policy.get("finalnode")
    competitive = policy.get("mode") == "competitive"

    votes = {}
    for event in events:
        if isinstance(event, dict) and event.get("path") == "verify":
            body = event.get("body") or {}
            votes.setdefault(body.get("targetid"), []).append(event)

    states = {}
    for node in (tree.get("body") or {}).get("nodes") or []:
        node_id = node.get("id")
        status = "open"
        for event in events:
            if not (isinstance(event, dict) and event.get("path") == "submission"):
                continue
            body = event.get("body") or {}
            if body.get("node") != node_id or body.get("taskid") != root:
                continue
            status = "submitted"
            counted = 0
            for vote in votes.get(event.get("pinId"), []):
                vbody = vote.get("body") or {}
                if vbody.get("verdict") != "pass":
                    continue
                if vote.get("author") in (event.get("author"), publisher):
                    continue
                counted += 1
            if counted >= quorum:
                status = "verified"
        states[node_id] = {"status": status}

    complete = bool(finalnode) and states.get(finalnode, {}).get("status") == "verified"
    return {
        "nodeStates": states,
        "taskComplete": complete,
        "settlement": {
            "engineAlgoVersion": "idbots-metatask-engine/1.3.0" if competitive else "idbots-metatask-engine/1.2.1"
        } if complete else None,
    }


def main():
    parser = argparse.ArgumentParser(prog="metatask-replay")
    parser.add_argument("--events", required=True)
    parser.add_argument("--root", required=True)
    parser.add_argument("--now", type=int, default=None)
    parser.add_argument("--guard", action="store_true")
    args = parser.parse_args()
    try:
        events, options = load_events(args.events)
    except Exception as err:
        print("invalid events input: %s" % err, file=sys.stderr)
        return 2
    now = args.now if args.now is not None else options.get("now")
    try:
        projection = replay(events, args.root, now=now, guard=args.guard)
    except Exception as err:
        print(str(err), file=sys.stderr)
        return 2
    sys.stdout.write(canonJ(projection) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
