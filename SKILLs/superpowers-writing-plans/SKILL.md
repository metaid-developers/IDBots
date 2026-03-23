---
name: "Superpowers Writing Plans"
description: "Use when you have an approved design or a clearly multi-step coding task and need a concrete implementation plan before editing code."
official: true
---

# Superpowers Writing Plans

Create an implementation plan that is concrete enough to execute without guessing.

## When To Use

- after `superpowers-brainstorming` approval,
- before substantial implementation,
- when the user explicitly asks for a plan,
- when the task spans multiple files or verification steps.

## Required Output

Write the plan to `docs/superpowers/plans/YYYY-MM-DD-<topic>.md` when the task is substantial.

The plan should include:

- goal and scope,
- likely files to create or modify,
- ordered implementation steps,
- validation commands,
- edge cases or risks,
- any open questions that remain.

## Planning Rules

- Prefer exact file paths.
- Break work into small, verifiable steps.
- Include at least one validation step.
- Mention migration or rollout considerations when relevant.
- Do not hide uncertainty. Call it out.

## Execution Handoff

- Once the plan is approved, move into implementation.
- Use `superpowers-test-driven-development` for behavior changes and bugfixes.
- Use `superpowers-verification-before-completion` before claiming the plan is complete.
