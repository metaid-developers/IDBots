---
name: "Superpowers Test-Driven Development"
description: "Use before implementing any feature, bugfix, or behavior change. Enforces write-the-test-first red/green/refactor discipline."
official: true
---

# Superpowers Test-Driven Development

Write the failing test first. Watch it fail. Then write the minimum code to make it pass.

## Iron Law

No production code without a failing test first.

If you wrote implementation code before the test, discard that approach and restart from the failing test.

## Cycle

1. Red: write one small failing test for the desired behavior.
2. Verify Red: run the test and confirm it fails for the expected reason.
3. Green: write the minimum implementation to pass.
4. Verify Green: run the test again and confirm it passes.
5. Refactor: clean up only after green.

## Rules

- One behavior per test.
- Use real behavior assertions, not vague smoke checks.
- Do not bundle multiple fixes into one green step.
- If the test passes before the implementation exists, the test is wrong.

## Exceptions

Only skip TDD if the user explicitly chooses a different approach or the change is pure configuration/documentation with no executable behavior.
