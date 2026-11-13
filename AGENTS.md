# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Commit and Merge Rules

- If you notice unfamiliar or unrelated file changes, continue working and stay focused on your own scoped edits unless the user asks you to inspect them.
- All IDBots-related edits must stay within this IDBots project directory; modifying files outside the IDBots project is strictly forbidden.
- Unless the user explicitly asks to work on `main`, make every change on a new branch paired with a same-named worktree (path and name following project convention — e.g. branch `fix/foo` or `feat/foo` uses worktree `.worktrees/foo`); you do not need to ask for confirmation before creating it. Edit directly on `main` only when the user explicitly says so.
- If the task is a new change request or a new feature, and the current checkout is `main`, do not start editing in that working directory. Create a new branch named for the task together with a matching local worktree, then implement the work in that worktree. Skip this only when the user explicitly instructs you to make the change on `main`.
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
- Do not merge a feature branch back into `main` on your own initiative **before the merge is requested**; the merge request is what authorizes it (see "Delivery loop" below).
- When the user asks to merge a branch back into `main`, after the merge you may delete that branch and its worktree without asking, provided the branch is now fully absorbed into `main` (safe to delete). Do not delete branches that still carry unmerged or uncommitted work.

### Delivery loop (owner ruling 2026-11-13) — test on `main`, not on the branch

The owner's standing instruction: **we test and accept on `main`. A feature that is finished but stranded on a branch is not a deliverable — it is a chore for the owner, who then has to check out a branch by hand to verify anything.** The only sanctioned loop is:

1. Branch from `main` (with its worktree, as above).
2. Write the code and commit on the branch.
3. **Request the merge.** Report the branch name, its head commit, what changed, and what you already verified. The merge request is the hand-off point.
4. Merge into `main` (once the request is authorized), then run the acceptance/tests **on `main`** and report the result with evidence: the merge commit hash, the compile exit code, and the test total/passed/failed counts.
5. Only then ask for acceptance. A branch's green tests are necessary but never sufficient.

Rules that follow from this:

- Every branch has exactly two endings: merged into `main`, or rejected and deleted. A branch left dangling with finished work in it is a defect, and must be named as such in any status report rather than described as "done".
- Do not accumulate multiple finished-but-unmerged branches. If one exists, say so and request its merge at the end of the task that produced it.
- Run the test suite with `NO_COLOR=1 FORCE_COLOR=0` so color escape codes cannot pollute assertion comparisons, and distinguish failures you introduced from failures that were already red on the `main` baseline you branched from.

### Production deployments come from `main` only

- **Every deployment to a production (or production-like staging) environment must be built from `main`. Never deploy straight off a feature branch.** One running version, one source of truth: what is live must be reconstructible by anyone who checks out `main`.
- A branch may be built and run only for local verification. The moment a branch's change is accepted, merge it into `main` and deploy from `main` — do not let an accepted-but-unmerged branch stay live, because the next rebuild from `main` silently reverts it (a fixed bug comes back with no diff to explain it).
- Acceptance is not complete until the change is in `main`. A verified fix that exists only on a branch is an unfinished delivery, and it must be called out as such in any status report.
- When a deployment has already happened from a branch, treat that as a debt to clear immediately: merge the branch into `main`, rebuild, redeploy from `main`, and confirm the running artifact matches the `main` commit.

## Language Conventions

- Write all documentation in English: Markdown docs, design notes, code comments, and commit messages.
- Default UI copy (labels, messages, and prompts shown in the app) must be in English.
- Development-journal entries posted on-chain via the `metabot-post-buzz` skill must be written in English.
- The defaults above apply unless the user explicitly requests another language for that specific artifact.
- When replying to the user or otherwise communicating with them, always use the user's own language.

## Package Manager

- Supported Node.js: `>=24 <27` (24 LTS and 26 LTS both verified; 26 verification: full `dist:mac` packaging + packaged-app smoke launch on v26.7.0).
- Package manager: pnpm only (pinned via `packageManager` in `package.json`; run `corepack enable` once). `pnpm-lock.yaml` is committed; never reintroduce `package-lock.json`.
- Four packages, four lockfiles: the repository root, `dsh-runtime/`, `SKILLs/web-search/`, and `mobile-shell/` are installed separately (`pnpm install` in each; the root `postinstall` covers only `dsh-runtime/` and `SKILLs/web-search/`). The native mobile package is never installed by root `postinstall` or packaged into Electron; install and build it explicitly from `mobile-shell/`. pnpm settings live in each directory's `pnpm-workspace.yaml` (root and nested: hoisted `nodeLinker` + overrides + build approvals) — pnpm 11 ignores `.npmrc` for settings, so do not move them there.
- `nodeLinker: hoisted` is a hard requirement, not a preference: electron-builder packages production `node_modules` into the app and copies `dsh-runtime/` + `SKILLs/` (with their `node_modules`) as extraResources — the default isolated linker would ship symlinks into the developer's pnpm store and break the packaged app. Packages are still hard-linked from the global pnpm store, so per-worktree install cost stays near zero.
- Never call `npm install` / `npm ci` anywhere in this repository (root, CI, scripts, or nested packages); use `pnpm install --frozen-lockfile` so installs stay deterministic and store-backed.

## Worktree Closeout

- Every task branch lives in a git worktree under `.worktrees/<branch>`.
- Every automated verification flow (gate, wt, gt, rsi-audit, and similar agent-driven task runners) MUST remove its own worktree with `git worktree remove` when the task finishes — success or failure alike. Leftover worktrees are the main source of disk bloat; each one that survives keeps a full dependency checkout.
- After a branch merges back to `main`, remove its worktree and delete the branch immediately: `git worktree remove .worktrees/<branch> && git branch -d <branch>`.
- Regular maintenance entry point: `scripts/prune-worktrees.sh` lists every worktree whose branch is fully merged into `main` and, after confirmation, removes the worktrees and deletes the branches. `--dry-run` only lists; `--force` also removes merged worktrees that have uncommitted changes.
- A fresh worktree needs `pnpm install` in the root before building (the postinstall covers `dsh-runtime/` and `SKILLs/web-search/`); thanks to the shared pnpm store the install is fast and adds almost no new disk usage.

### Worktrees live on the internal disk

- `.worktrees/` is a plain, git-ignored directory in the repository root on the internal disk — not a symlink to an external volume. Always create worktrees as `git worktree add .worktrees/<name> ...`; never invent other temp directories.
- Worktrees used to live on an external exFAT SSD behind a `.worktrees` symlink (`/Volumes/Seagate/MacWork/worktrees/IDBots`). That setup was abandoned because it hurt performance: pnpm fell back from hard links to copy mode and every build and test ran against slow external I/O, on top of the exFAT workarounds the volume needed (`core.filemode false`, `._*` AppleDouble sidecars). None of that applies to a fresh worktree today: do not set `core.filemode false`, and do not expect a `Seagate` volume to be mounted.
- A few legacy worktrees may still show up under `/Volumes/Seagate/MacWork/worktrees/IDBots/` in `git worktree list`. Do not create new ones there; close them out with the normal `git worktree remove` flow once their branches are merged.

## Important Runtime Rules

- Windows NSIS uninstall policy is to preserve user data (`electron-builder.json` -> `nsis.deleteAppDataOnUninstall=false`); do not flip this unless a release explicitly requires destructive uninstall behavior.
- The team preference is `main` as the only long-lived shared branch. Temporary branches should be short-lived and deleted after merge.

## DSH Runtime Dependencies

- `dsh-runtime/` is a nested pnpm package with its own `package.json` / `pnpm-lock.yaml` / `node_modules`; the root `pnpm install` only reinstalls it via `postinstall`, and a plain `git pull` or merge does NOT reinstall it.
- After pulling, merging, or switching to any commit that touches `dsh-runtime/package.json`, `dsh-runtime/pnpm-workspace.yaml`, or `dsh-runtime/pnpm-lock.yaml`, immediately run `pnpm --dir dsh-runtime install`. A stale `dsh-runtime/node_modules` crashes the spawned DSH runtime process at plugin-load time (`ERR_MODULE_NOT_FOUND` / "JSON-RPC input closed").
- ANY command that reinstalls `dsh-runtime/node_modules` (`pnpm --dir dsh-runtime install`, including manual invocations) wipes the kernel patches under `scripts/dsh-kernel-patches/`. Re-run `node scripts/apply-dsh-kernel-patches.cjs` after it — the root `postinstall` does this automatically, but a manual install does NOT. A missing patch keeps builds and tests green and only shows up as a runtime regression in the shipped package — and the blast radius is no longer Windows-only: the set carries the Windows console-flash fix (the v0.9.3 incident), the fail-closed browser/desktop automation approval gates, the exFAT session/attachment fixes, AND the deferred browser mount behind assistant-mode first-sentence latency (losing it silently re-locks every new session's first turn to a synchronous Chromium spawn — ~15s-class stalls on memory-tight hosts). `pnpm run check:dsh-deps` and `node scripts/apply-dsh-kernel-patches.cjs --check` both detect it. The per-patch inventory and rationale live in `scripts/dsh-kernel-patches/README.md`; release-side verification lives in the build/release SOP (`scripts/verify-dsh-kernel-patches.cjs` fingerprints).
- `pnpm run check:dsh-deps` (scripts/check-dsh-runtime-deps.cjs) verifies installed dsh-runtime packages match `package.json` AND that `dsh-runtime/pnpm-lock.yaml` is in sync with it (importer-block specs both ways + resolved versions for exact pins); it is wired as a pre-hook of `electron:dev` / `electron:dev:dsh`. Any commit that bumps dsh-runtime dependencies must keep this gate green.

### Upgrading the DSH runtime version

- To bump the `@deepseek-ai/*` kernel versions, use the one-command path: `pnpm run upgrade:dsh -- <version>` (rewrites all pins in `dsh-runtime/package.json` plus the override lines in `dsh-runtime/pnpm-workspace.yaml`, regenerates the lockfile via `pnpm --dir dsh-runtime install`, re-runs the gate). Do NOT hand-edit `dsh-runtime/package.json`, `dsh-runtime/pnpm-workspace.yaml`, or `dsh-runtime/pnpm-lock.yaml` — every historical DSH upgrade incident (stale-lock ERESOLVE, the 0.1.3-alpha.1 lockfile left behind by the 0.1.2-rc.1 pin) came from manual partial edits.
- `dsh-runtime/package.json`, `dsh-runtime/pnpm-workspace.yaml`, and `dsh-runtime/pnpm-lock.yaml` must be committed together in the SAME commit; never commit one without the others.
- Before committing a dsh-runtime version change, `pnpm run check:dsh-deps` must pass (it also validates the lockfile sync, so an inconsistent bump cannot land silently).

## Test Discipline: temp-dir cleanup must survive Windows CI

- New or changed tests that create temp directories (`mkdtempSync`) around `SqliteStore` — or anything that writes files before `rmSync` — must release the handles first (close the store) and then remove the directory best-effort: close → tolerant rm. A lingering sql.js/Defender handle turns `rmSync` into EPERM on Windows CI while macOS POSIX semantics silently succeed, so the suite stays green locally and dies only in the tag run (v1.0.9 tag run failed twice on exactly this; see `tests/metabotAutoReplyDefault.test.mjs` `disposeStore` for the house pattern and the release SOP §11.2b).
- Never let cleanup failures fail a test: leftover temp dirs are harmless and OS-swept.

## Database Upgrade Safety

- Treat user-directory SQLite databases as persistent upgrade state. Auto-update does not replace or reset them.
- Any database schema change must include a safe, idempotent first-run migration path so upgraded users get required tables, columns, indexes, and defaults before new code depends on them.
- Any change to field meaning, data shape, or storage semantics must include an explicit migration or compatibility strategy for existing user data on first launch after upgrade.
- Do not delete, reset, or casually discard user data. Maintain old-user database continuity across releases unless a deliberate, well-documented migration plan says otherwise.

## Cloud & Mobile handoff package

Any work touching the mobile client (`src/mobile/`), the control plane
(`cloud/control-plane/`), server mode / gateway (`src/main/server/`,
`src/main/gateway/`), or the tenant image (`deploy/tenant-image/`) starts at
`docs/cloud-mobile/HANDOFF.md`, then the index in `docs/cloud-mobile/README.md`
and the workstream plan in `00-program-plan.md`. Interface contracts
(`01-interface-contracts.md`, `02-ipc-allowlist-v1.md`) are frozen: propose a
change request instead of editing them. Production deploys come from `main`
only (see the rule above).

## Workspace instructions injected into cowork sessions

When a cowork session's working directory (the per-session `cwd` passed to
`session/ensure`, which bash/fs tools resolve from) has an `AGENTS.md` or
`CLAUDE.md` at its root — or anywhere between the project root and the cwd —
the DSH runtime injects those files into the conversation before the first
model request, so the agent follows the repository's conventions just like
other harness projects do.

- Mechanism: the pinned `@deepseek-ai/dsh-agent-instructions` package, mounted
  by `dsh-runtime/lib/generate-runtime-config.mjs` whenever the composition has
  a workspace (the fs provider it reads through). Same package and defaults the
  DeepSeek Harness web UI uses.
- Discovery: then the root-to-cwd ancestor chain found by walking up to the
  first `.git` marker. In each directory the ordered candidates `AGENTS.md`,
  `CLAUDE.md` (plus the `.local` overlays `AGENTS.local.md`, `CLAUDE.local.md`)
  are loaded; `AGENTS.md` renders before `CLAUDE.md`, and more specific (deeper)
  directories override broader ones.
- Boundary (product decision): ancestor discovery is intentional — a session
  may inject instruction files from OUTSIDE the user-chosen workspace (e.g.
  the git repo root above the cwd, or anything a symlinked file points at).
  This matches DeepSeek Harness behavior; the folder selector popover shows a
  hint telling users sessions follow conventions from the folder AND its
  parent Git repos. Do not silently disable ancestor discovery.
- User-global instructions are disabled by design: the host pins
  `workspaceInstructions.dshHome` to an empty directory under userData
  (`join(app.getPath('userData'), 'dsh-home')`, see `buildRuntimeConfig` in
  `coworkDshTurn.ts`), so a `~/.dsh/AGENTS.md` left over from another harness
  never enters IDBots sessions.
- Injection: rendered as a durable user-role baseline message
  (`<system-reminder>` frame, "Instructions from: <path>" per file) with a
  64 KiB byte budget; fs tool edits to instruction files are reconciled into
  the session automatically.
- Controls: `workspaceInstructions.maxBytes` / `workspaceInstructions.dshHome`
  in the runtime config input (defaults match the official bundle).
- Not injected when the session has no workspace cwd or the composition mounts
  no fs provider — providerless runs stay hermetic.

## Keeping CLAUDE.md in sync

`CLAUDE.md` is a byte-copy of this file except its first line, which addresses
Claude Code instead of Codex. When this file changes, update `CLAUDE.md` in
the same commit.
