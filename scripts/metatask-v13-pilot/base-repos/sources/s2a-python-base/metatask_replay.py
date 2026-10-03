#!/usr/bin/env python3
"""
metatask_replay.py — MetaTask replay engine, Python implementation (S2a).

Contract: see README.md (CLI flags, stdout canonJ projection, exit codes).
This base is a SKELETON: argument parsing is wired, the replay is TODO.
"""
import argparse
import json
import sys


def canonJ(obj):
    """Canonical JSON per the MetaTask protocol (sorted keys, no whitespace)."""
    return json.dumps(obj, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def load_events(path):
    """Load a bare event array or a vector object {events, options}."""
    with open(path, "r", encoding="utf-8") as handle:
        data = json.load(handle)
    if isinstance(data, list):
        return data, {}
    if isinstance(data, dict) and isinstance(data.get("events"), list):
        return data["events"], data.get("options") or {}
    raise ValueError("events file must be a JSON array or an object with an events array")


def replay(events, root, now=None, guard=False):
    """Replay the event set and return the canonical projection dict.

    TODO(S2a): implement the MetaTask v1.2.1 + v1.3 competitive semantics:
    tree fold (amends), claim/release cycles, submissions, verify quorum,
    challenges, deps/parentrefs, chain-validity, winning-chain settlement.
    """
    raise NotImplementedError("replay is not implemented yet — this is the S2a base skeleton")


def main():
    parser = argparse.ArgumentParser(prog="metatask-replay", description="MetaTask replay engine (Python)")
    parser.add_argument("--events", required=True, help="JSON file: event array or {events, options}")
    parser.add_argument("--root", required=True, help="task root pinId to project")
    parser.add_argument("--now", type=int, default=None, help="fixed clock, ms epoch (omit = no expiry)")
    parser.add_argument("--guard", action="store_true", help="strict event-set validation; exit 3 on violation")
    args = parser.parse_args()

    try:
        events, options = load_events(args.events)
    except Exception as err:
        print("invalid events input: %s" % err, file=sys.stderr)
        return 2

    now = args.now if args.now is not None else options.get("now")
    try:
        projection = replay(events, args.root, now=now, guard=args.guard)
    except NotImplementedError as err:
        print(str(err), file=sys.stderr)
        return 2
    sys.stdout.write(canonJ(projection) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
