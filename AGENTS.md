# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Commit and Merge Rules

- If you notice unfamiliar or unrelated file changes, continue working and stay focused on your own scoped edits unless the user asks you to inspect them.
- Before creating a new git worktree or branch, ask for explicit user confirmation first.
- Every new branch must be created together with a dedicated local worktree; use one worktree working directory per branch, and do not create or switch branches in the main working directory.
- All feature or temporary branches must branch directly from `main`; never create a new branch from another branch. Branch depth is capped at 1.
- When the user says "commit", stage and commit only the files you changed and understand.
- After each commit, do not push to the remote GitHub repository unless the user explicitly asks you to push.
- Prefer small, frequent commits. Commit each independent, verifiable unit of work as soon as it is complete.
- ** For every modification or newly added feature, create one commit. **
- For every commit, use Codex's `metabot-post-buzz` skill (not this repository's `SKILLs/metabot-post-buzz` implementation) to post a detailed development-journal entry on-chain describing the change.
- Use commit messages in the format `<type>: <short description>`, where `<type>` is one of `feat`, `fix`, `refactor`, `docs`, or `chore`.
- Before committing, make sure the relevant local tests or verification steps pass for your changes.
- When merging completed work into `main`, use `git merge --no-ff` to preserve the feature merge point.

## Important Runtime Rules

- Windows NSIS uninstall policy is to preserve user data (`electron-builder.json` -> `nsis.deleteAppDataOnUninstall=false`); do not flip this unless a release explicitly requires destructive uninstall behavior.
- The team preference is `main` as the only long-lived shared branch. Temporary branches should be short-lived and deleted after merge.

## Database Upgrade Safety

- Treat user-directory SQLite databases as persistent upgrade state. Auto-update does not replace or reset them.
- Any database schema change must include a safe, idempotent first-run migration path so upgraded users get required tables, columns, indexes, and defaults before new code depends on them.
- Any change to field meaning, data shape, or storage semantics must include an explicit migration or compatibility strategy for existing user data on first launch after upgrade.
- Do not delete, reset, or casually discard user data. Maintain old-user database continuity across releases unless a deliberate, well-documented migration plan says otherwise.
