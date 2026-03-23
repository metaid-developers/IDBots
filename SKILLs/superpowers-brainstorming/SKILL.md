---
name: "Superpowers Brainstorming"
description: "Use before creating features, changing behavior, adding workflows, or making product/design decisions. This is the superpowers design-first workflow for IDBots and should be used before implementation whenever the task changes behavior."
official: true
---

# Superpowers Brainstorming

Turn a rough implementation idea into an approved design before code changes start.

## Hard Gate

Do not write implementation code or change files until you have:

1. explored the current project context,
2. clarified the user's goal and constraints,
3. proposed concrete approaches with trade-offs,
4. presented the recommended design,
5. received user approval.

## Workflow

1. Explore the local context first.
   Read the obvious docs, the current implementation area, and any nearby tests.
2. Ask clarifying questions one at a time.
   Focus on purpose, constraints, risks, and success criteria.
3. Propose 2-3 approaches.
   Lead with the recommended option and explain the trade-offs.
4. Present the design in sections scaled to the task.
   Cover architecture, file boundaries, data flow, failure handling, and validation.
5. Get explicit approval before implementation.
6. Write the approved design to `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md` when the task is substantial.
7. After approval, move to `superpowers-writing-plans` if the work is multi-step.

## Design Principles

- Prefer small, focused units with clear responsibilities.
- Follow existing repository patterns unless they actively block the task.
- Avoid unrelated refactors.
- Remove speculative scope. YAGNI applies during design too.
