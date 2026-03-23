---
name: "Superpowers Systematic Debugging"
description: "Use for bugs, failing tests, flaky behavior, build failures, integration breakages, or any unexpected technical issue. Investigate the root cause before proposing fixes."
official: true
---

# Superpowers Systematic Debugging

Do not guess. Find the root cause before making fixes.

## Iron Law

No fixes without root-cause investigation first.

## Workflow

1. Read the error carefully.
   Capture exact messages, stack traces, exit codes, and line numbers.
2. Reproduce consistently.
   If you cannot reproduce it, gather more evidence before changing code.
3. Check recent changes.
   Compare the broken path with the last known-good path.
4. Trace the data flow.
   Follow the bad state backward until you find where it is introduced.
5. Compare with a known-good example.
   Look for a working code path in the same codebase.
6. Form one hypothesis.
   State the expected cause and test it with the smallest possible change.
7. Only after confirming the cause, implement the fix.
8. Add a regression test when the issue is testable.

## Red Flags

- "Let me try one quick fix."
- "It probably comes from X."
- stacking multiple changes before rerunning the failing case,
- claiming a fix without reproducing the original failure.

When you hit those, stop and go back to evidence gathering.
