#!/usr/bin/env python3
"""
embed-specs.py — regenerate pilot-task-drafts.json from the hand-authored
template plus the standalone spec scripts.

The published drafts file carries every spec's script INLINE (the wave-1
pattern: reviewers and the publish tool read one file), byte-identical to the
standalone script of the same name — validate-pilot-drafts.py enforces the
identity, so the workflow is: edit the standalone script, re-run this
generator, re-validate.

Usage: python3 scripts/metatask-v13-pilot/embed-specs.py [--check]
  --check   do not write; exit 1 when pilot-task-drafts.json is stale
"""
import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
TEMPLATE = os.path.join(HERE, "pilot-task-drafts.template.json")
OUTPUT = os.path.join(HERE, "pilot-task-drafts.json")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()

    with open(TEMPLATE, "r", encoding="utf-8") as handle:
        drafts = json.load(handle)

    for key, spec in sorted(drafts["specs"].items()):
        script_file = spec.pop("scriptFile", None)
        if not script_file:
            print("spec %s: missing scriptFile staging key" % key)
            return 1
        path = os.path.join(HERE, script_file)
        with open(path, "r", encoding="utf-8") as handle:
            spec["script"] = handle.read()
        # Keep the emitted key order stable: name/lang/entry/script, then the rest.
        ordered = {"name": spec["name"], "lang": spec["lang"], "entry": spec["entry"], "script": spec["script"]}
        for field in ("input", "output", "validation", "workspace"):
            if field in spec:
                ordered[field] = spec[field]
        drafts["specs"][key] = ordered

    text = json.dumps(drafts, ensure_ascii=False, indent=2) + "\n"
    if args.check:
        with open(OUTPUT, "r", encoding="utf-8") as handle:
            current = handle.read()
        if current != text:
            print("pilot-task-drafts.json is STALE — re-run embed-specs.py")
            return 1
        print("pilot-task-drafts.json is up to date")
        return 0
    with open(OUTPUT, "w", encoding="utf-8") as handle:
        handle.write(text)
    print("wrote %s (%d bytes)" % (OUTPUT, len(text.encode("utf-8"))))
    return 0


if __name__ == "__main__":
    sys.exit(main())
