# Evidence Report — feat/legacy-data-recovery (Windows reinstall / data-directory drift data recovery)

Branch: `feat/legacy-data-recovery` (baseline `223a341f9`), worktree `.worktrees/wt-legacy-data-recovery`.
Scope honored: **copy & create only — zero deletion logic in all new/changed code** (verified by scan, see V7). Not committed, not pushed — left for Mon (Twin) to close out.

## 1. Changed files

| File | Kind | Purpose |
|---|---|---|
| `src/main/services/dataRecoveryService.ts` | NEW (~700 lines) | Core module: read-only candidate probe (immutable URI), candidate discovery/ranking, 5-slot rotating backups, version marker, data-directory override marker, startup guard orchestration. Electron-free (dependency-injected) → unit-testable under plain `node --test`. |
| `src/main/main.ts` | MOD (+117) | ① guard wiring after `store ready` (skipped in server mode / `NODE_ENV=test`); ③ version-change backup wiring; ② `app:getDataDirectory` IPC; `configureUserDataPath` honors the persisted switch marker unless an env override is present. |
| `src/main/preload.ts` | MOD (+5) | `window.electron.appInfo.getDataDirectory()` bridge. |
| `src/main/gateway/allowlist.ts` | MOD (+1) | `'app:getDataDirectory': { tier: 'N', ... }` (desktop-only, default-deny gate satisfied). |
| `src/mobile/generated/ipc-contract.json` | MOD (+6) | Regenerated via `scripts/generate-ipc-contract.mjs` (433 methods). |
| `src/renderer/types/electron.d.ts` | MOD (+5) | `appInfo.getDataDirectory` typing. |
| `src/renderer/components/Settings.tsx` | MOD (+48) | ② Settings → General tab: "Data directory" section — full userData path (selectable) + Open button (reuses `shell:openPath`), error surfaced via existing banner. |
| `src/renderer/services/i18n.ts` | MOD (+8) | 4 new keys × zh/en (`settingsDataDirectory*`). |
| `scripts/nsis-installer.nsh` | MOD (+17) | ④ `customInit`: existing `%APPDATA%\IDBots\idbots.sqlite` notice + Windows.old recovery-hint notice. |
| `tests/dataRecoveryService.test.mjs` | NEW (16 tests) | Unit suite. **gitignored** (`tests/*` whitelist scheme) → Mon must `git add -f tests/dataRecoveryService.test.mjs`. |

## 2. Behavior → verification (command + exit code, all run in the worktree on 2026-11-01)

### ① Startup guard (empty-library scan + 3-choice dialog + persisted skip)
- `node --test tests/dataRecoveryService.test.mjs` → **exit 0, 16/16 pass**. Covers: discovery across `%APPDATA%\IDBots*` / `%LOCALAPPDATA%\IDBots*` / `C:\Windows.old\Users\*\AppData\Roaming\IDBots` (injectable root) / legacy `OctoBot`/`octobot` dirs; current-userData exclusion; empty-DB filtering; ranking (most bots → newest `updated_at`); skip persistence + no re-prompt; import flow (pre-action backup → close → copy → stale-sidecar neutralize → relaunch); switch flow (marker write, current DB untouched, relaunch); no-candidates no-op.
- Read-only probe is ZERO-POLLUTION: a plain `{ readOnly: true }` node:sqlite open of a WAL-mode DB **creates** `-shm` (32 KB) / `-wal` (0 B) in the candidate directory — caught by a failing assertion during development, fixed by switching the probe to SQLite `immutable=1` file-URI (per-segment percent-encoded; Windows drive segment kept literal). Regression test asserts the candidate directory is byte-identical after probing. Trade-off documented in code: immutable ignores an un-checkpointed WAL tail (probe may undercount); the import copies the full trio so WAL content still comes across.
- macOS real-world smoke (this machine): `resolveWindowsOldUsersRoot() → null`, real `~/Library/Application Support` scan → `[]` candidates, no throw (`MACOS_SMOKE_OK`). Dev flows using `IDBOTS_APP_DATA_PATH`/`IDBOTS_USER_DATA_PATH` overrides keep scanning their overridden (empty) roots — no dialogs in `electron:dev:dsh`.

### ② Settings data-directory visibility
- `npx -p typescript@5 tsc -p tsconfig.json` (renderer, noEmit) → **exit 0**.
- `node scripts/generate-ipc-contract.mjs --check` → **exit 0** ("generated file is fresh").
- `allowlist.lookupInvokeChannelWithSource('app:getDataDirectory')` → `{ matched: 'exact', tier: 'N' }` (same resolution the ipcContract test uses) → **exit 0**.

### ③ Version-change backup (5 retained)
- Covered by the same 16-test run: fresh install → marker only; 7 upgrades → exactly 5 `version-slot-*` dirs holding the last 5 versions with correct bytes; same-version re-run → no-op; `backup-log.txt` audit lines. Rotation is **overwrite-in-oldest-slot** — see design note below.

### ④ NSIS customInit notices
- Script self-reviewed (labels + `IfFileExists <path> <present> <absent>` + `$APPDATA`/`$SYSTEMDRIVE` vars). **NOT compile-verified**: no `makensis` on this macOS host (`which makensis` → not found) — needs the Windows/electron-builder NSIS pass at package time. Declared as gap.

### Global gates
- Main: `npx -p typescript@5 tsc --project electron-tsconfig.json` → **exit 0** (zero errors).
- Renderer: `npx -p typescript@5 tsc -p tsconfig.json` → **exit 0**.
- V7 no-delete scan: `grep -nE "rmSync|unlinkSync|rmdirSync|fs\.rm" src/main/services/dataRecoveryService.ts` → only a doc comment mentions `fs.rmSync` (as "never appears here"); zero calls. Diff of `src/main/main.ts` adds no deletion logic either.

## 3. Design decisions & declared deviations

1. **"保留最近 5 份" under a hard no-delete constraint** — implemented as 5 fixed slot directories (`version-slot-1..5` / `action-slot-1..5`); the oldest slot is OVERWRITTEN via tmp-copy+rename. `fs.rm/unlink` never appear. Repo precedent for the count: `sqliteStore.ts` `KV_ROTATING_BACKUP_SLOTS = 5` (that one is DELETE-based in-DB; the file layer uses overwrite because of this delegation's constraint). If Mon prefers unbounded accumulation, delete nothing and raise the constant.
2. **"把目标 idbots.sqlite 三件套复制进 backups/" interpretation** — "目标" read as the database at risk of being replaced: the CURRENT live trio is snapshotted before every import/switch (`action-slot-*` + log line). The candidate source is never modified by us (probe is immutable read-only; import only copies FROM it). If the intent was also snapshotting the candidate, that is one extra `copySqliteTrio` call away.
3. **Stale-sidecar neutralization on import** — after the candidate trio is copied over, a leftover non-empty `-wal`/`-shm` from the replaced empty DB would corrupt the new DB on next open. Since deletion is forbidden, stale sidecars are overwritten with zero bytes (zero-length WAL/SHM is a well-defined no-frames state). This and slot-overwrite are the only "replace" primitives; both are writes, not deletes.
4. **Switch persistence** — `data-directory-override.json` in `<appData>/IDBots/`, consumed by `configureUserDataPath` at early boot, env overrides always win (dev escape hatch), invalid marker (target gone) ignored, never deleted. Loop-safe: after switch, the new userData is non-empty so the guard never re-fires; a fresh `migrateLegacyUserData()` still runs before the store opens.
5. **Import closes the store before copying** (releases the Windows file handle — overwrite would EPERM otherwise), then relaunches (`app.relaunch()` + `app.exit(0)`). Boot after import: marker absent + non-empty imported DB ⇒ the version backup then snapshots the IMPORTED database immediately (emergent, useful).
6. **Guard skip surfaces** — desktop-only (`!isServerMode()`), suppressed under `NODE_ENV=test`. On macOS dev without env overrides, a scratch userData WOULD legitimately find the real `~/Library/Application Support/IDBots*` siblings and offer recovery — that is correct-by-design behavior (data-dir drift is not Windows-only), noted so nobody is surprised.
7. **Environment caveats** — worktree is sparse-cone (patches/scripts/src) + `tests/*` gitignored; `pnpm install --frozen-lockfile --ignore-scripts` was used (postinstall expects `SKILLs/`, absent in the cone). Full `pnpm test` was NOT runnable (tests/ not checked out; electron binary not downloaded under --ignore-scripts); the ipcContract staleness + allowlist gates were verified directly with the same code paths that test uses. Windows-only paths (LOCALAPPDATA env, `C:\Windows.old`, NSIS compile, Windows file-lock behavior) verified logically + via injectable-root unit tests, not on a Windows host.
