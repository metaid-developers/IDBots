---
name: "Superpowers Workflow"
description: "IDBots-native superpowers bootstrap. Use when the user explicitly asks to use superpowers, wants a more process-driven engineering workflow, or when you need to decide whether another `superpowers-*` skill should govern the task before doing anything else."
official: true
---

# Superpowers Workflow

Use this skill to route into the rest of the `superpowers-*` workflow before you start acting.

## Rules

- Check whether another `superpowers-*` skill applies before taking action.
- User instructions, repository instructions, and app policy override skill rules.
- In IDBots, skills are executed by reading `SKILL.md` and following it with `Read + Bash`.
- Do not attempt to call a `Skill` tool in this environment.

## Process Priority

1. Use `superpowers-systematic-debugging` for bugs, failing tests, build failures, or unexpected behavior.
2. Use `superpowers-brainstorming` before adding features, changing behavior, or making product/design decisions.
3. Use `superpowers-writing-plans` after a design is approved or when a multi-step implementation needs an explicit plan.
4. Use `superpowers-test-driven-development` before writing implementation code for a feature or bugfix.
5. Use `superpowers-using-git-worktrees` when the work should happen in an isolated workspace.
6. Use `superpowers-verification-before-completion` before claiming success.

## IDBots Adaptation

- Prefer the existing Cowork skill registry over plugin-specific mechanisms.
- Treat `superpowers-*` skills as a coordinated workflow, not as unrelated utilities.
- If the user explicitly says "use superpowers", prefer a matching `superpowers-*` skill over a non-superpowers alternative when both fit.
