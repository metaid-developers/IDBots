---
name: "Superpowers Git Worktrees"
description: "Use when starting feature work that should be isolated from the current checkout, or when the user explicitly wants an isolated branch/worktree before implementation."
official: true
---

# Superpowers Git Worktrees

Set up isolated git work so feature implementation does not disturb the current checkout.

## Priority

1. Reuse `.worktrees/` if the repository already uses it.
2. Otherwise reuse `worktrees/` if that is the existing convention.
3. If neither exists, use the user's preference.

## Safety

- For project-local worktree directories, verify they are ignored before creating the worktree.
- Use a branch name with the `codex/` prefix unless the user requested a different naming scheme.
- Verify the baseline status before starting implementation.

## Baseline Checks

After creating the worktree:

1. install project dependencies if needed,
2. run the relevant baseline test/build command,
3. report any existing failures before adding new changes.

## If The User Only Asked For A Branch

It is acceptable to create a normal branch in the current checkout when a worktree would add unnecessary overhead and the workspace is already clean.
