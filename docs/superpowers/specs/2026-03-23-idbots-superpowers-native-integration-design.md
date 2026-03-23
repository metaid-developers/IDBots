# IDBots Superpowers Native Integration Design

## Goal

Add a stable, IDBots-native subset of `obra/superpowers` so Cowork users can explicitly select superpowers skills or have Cowork auto-route into them, without depending on plugin hooks or unfinished subagent infrastructure.

## Constraints

- IDBots does not have a plugin `sessionStart` hook.
- IDBots does not expose a working `Skill` tool. Skills run through the existing `Read + Bash` workflow.
- IDBots subagent and parallel-agent infrastructure is not ready for production use in this integration phase.
- The integration must not change group-chat orchestration or other non-Cowork agent flows.

## Phase 1 Scope

Ship a compatible subset as built-in namespaced skills:

- `superpowers-using-superpowers`
- `superpowers-brainstorming`
- `superpowers-writing-plans`
- `superpowers-test-driven-development`
- `superpowers-systematic-debugging`
- `superpowers-using-git-worktrees`
- `superpowers-verification-before-completion`

Defer skills that depend on subagents or code-review worker flows.

## UX Model

### Explicit use

Users can select `superpowers-*` skills from the existing Skills popover. Names stay namespaced so the source and intent are obvious.

### Automatic use

Cowork already injects an `<available_skills>` prompt when the user has not manually selected a skill. Phase 1 extends that Cowork-only prompt with a short superpowers bootstrap block that:

- explains that `superpowers-*` skills are a coordinated workflow,
- maps common situations to the right process skill,
- reminds the model that IDBots uses `Read + Bash`, not a `Skill` tool,
- preserves repository and user instructions as the highest priority.

## Non-Goals

- no plugin system,
- no new runtime tool type,
- no changes to group-chat orchestrator skill routing,
- no subagent execution support,
- no attempt to mirror the full upstream repo verbatim.

## Implementation Notes

- Vendor the compatible subset into `SKILLs/` under `superpowers-*` folder names.
- Default-enable them in `SKILLs/skills.config.json`.
- Add a Cowork-specific prompt builder in `SkillManager` so the bootstrap text is only used where intended.
- Keep the existing generic auto-routing prompt unchanged for other services.
