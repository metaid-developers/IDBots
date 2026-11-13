# IDBots Release Runbook

Tracks a tag-driven IDBots release from version bump to live `update.json`.
It keeps progress in `.release-runbook.json` (gitignored), so a release can be
resumed after an interrupted session without re-reading every SOP section.

## Commands

```bash
pnpm run release:runbook -- init 0.7.0
pnpm run release:runbook -- status
pnpm run release:runbook -- next
pnpm run release:runbook -- mark bump
pnpm run release:runbook -- local
pnpm run release:runbook -- check
pnpm run release:runbook -- monitor
pnpm run release:runbook -- download
pnpm run release:runbook -- oss
pnpm run release:runbook -- website
```

## Phase map

- `init` records the target version/tag in the state file.
- `next` prints the next action for the current phase. Manual steps such as the
  version-bump commit, dev-journal Buzz, merge, and annotated tag can be marked
  with `mark bump` after they finish so the next phase starts where expected.
- `local` runs the local build/runtime gates from the release SOP. Run it from
  the release-branch worktree after the version bump, before pushing the tag.
- `check` verifies local/remote `main`, the annotated tag, and the GitHub
  Release (not draft/prerelease).
- `monitor` waits on the tag-triggered GitHub Actions run and records the
  elapsed time.
- `download` downloads the DMG/EXE/YAML assets and recomputes final sizes and
  SHA-512 values. Files whose local size already matches the Release asset are
  skipped, so a retry does not download hundreds of megabytes again.
- `oss` uploads the four objects to OSS with public-read ACL and the correct
  cache headers, starts the CDN prewarm task, and polls it to Complete/100%.
- `website` checks the live `https://idbots.ai/update.json` version against the
  runbook state.

Secrets are read from the existing local handoff docs and passed only to child
processes through environment variables; they are never stored in the state
file or printed.

## Resume

After each command completes, run `status` to see which phases are done. A
command can be re-run safely; completed phases are not erased.
