#!/usr/bin/env python3
"""
selftest-validate.py — self-test for the generalized MetaTask competitive
draft validator (scripts/metatask-wizard/validate-task-draft.py).

Runs the validator over a fixture table and asserts exit codes plus key
report wording:

  * POSITIVE: the real v1.3 pilot drafts (scripts/metatask-v13-pilot/
    pilot-task-drafts.json) must come back READY (exit 0) — warnings allowed
    (the pilot's deliberate metaapp workspace extension and its pending
    placeholder backfills are advisory, not blocking).
  * NEGATIVE fixtures (scripts/metatask-wizard/fixtures/): deps cycle,
    multi-sink graph, missing rubric, wrong weight sum, incomplete spec
    validation block — all must FAIL (exit 1) with the expected keyword.
  * WARNING fixtures: slogan rubric and a single overweight (>4000) node —
    advisory WARNs only, exit stays 0 (READY), expected keyword present.

Usage: python3 scripts/metatask-wizard/selftest-validate.py
Exit 0 prints SELFTEST GREEN; exit 1 lists every broken expectation.
"""
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
VALIDATOR = os.path.join(HERE, "validate-task-draft.py")
FIXTURES = os.path.join(HERE, "fixtures")
PILOT_DRAFTS = os.path.join(REPO, "scripts", "metatask-v13-pilot", "pilot-task-drafts.json")

# (draft file, expected exit code, [required substrings], [forbidden substrings])
CASES = [
    (PILOT_DRAFTS, 0,
     ["TASK DRAFT READY", "weights sum to exactly 10000", "exactly one deps sink and it IS finalnode"],
     ["TASK DRAFT NOT READY"]),
    (os.path.join(FIXTURES, "invalid-deps-cycle.json"), 1,
     ["acyclic", "TASK DRAFT NOT READY"], []),
    (os.path.join(FIXTURES, "invalid-multi-sink.json"), 1,
     ["sink", "TASK DRAFT NOT READY"], []),
    (os.path.join(FIXTURES, "invalid-missing-rubric.json"), 1,
     ["rubric", "TASK DRAFT NOT READY"], []),
    (os.path.join(FIXTURES, "warn-slogan-rubric.json"), 0,
     ["WARN", "slogan", "unjudgeable", "TASK DRAFT READY"], []),
    (os.path.join(FIXTURES, "invalid-weight-sum.json"), 1,
     ["10000", "TASK DRAFT NOT READY"], []),
    (os.path.join(FIXTURES, "invalid-spec-validation-missing.json"), 1,
     ["validation carries all three protocol items", "TASK DRAFT NOT READY"], []),
    (os.path.join(FIXTURES, "warn-overweight-node.json"), 0,
     ["WARN", "4000", "TASK DRAFT READY"], []),
]

failures = []


def main():
    for path, expected_code, required, forbidden in CASES:
        name = os.path.basename(path)
        proc = subprocess.run([sys.executable, VALIDATOR, path], capture_output=True, text=True)
        output = proc.stdout + proc.stderr
        problems = []
        if proc.returncode != expected_code:
            problems.append("exit %d, expected %d" % (proc.returncode, expected_code))
        for needle in required:
            if needle not in output:
                problems.append("missing expected output %r" % needle)
        for needle in forbidden:
            if needle in output:
                problems.append("forbidden output %r present" % needle)
        if problems:
            failures.append("%s: %s" % (name, "; ".join(problems)))
            print("FAIL %s — %s" % (name, "; ".join(problems)))
            tail = "\n".join("    " + line for line in output.strip().splitlines()[-8:])
            print(tail)
        else:
            print("PASS %s — exit %d as expected, %d keyword(s) matched" % (name, proc.returncode, len(required)))
    if failures:
        print("\nSELFTEST RED — %d case(s) broken:" % len(failures))
        for message in failures:
            print("  - %s" % message)
        return 1
    print("\nSELFTEST GREEN — %d cases: pilot drafts READY, every invalid fixture refused, every warning fixture advisory-only" % len(CASES))
    return 0


if __name__ == "__main__":
    sys.exit(main())
