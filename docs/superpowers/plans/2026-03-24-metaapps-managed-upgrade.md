# METAAPPs Managed Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade packaged `METAAPPs` from bootstrap-copy behavior to version-driven managed replacement so bundled IDBots MetaApps install when missing, replace whole local directories only when bundled versions increase, and never silently overwrite same-version or external-source MetaApps.

**Architecture:** Keep the implementation centered in `MetaAppManager` so the storage boundary remains unchanged: packaged runtime still reads and serves `userData/METAAPPs`, while bundled `METAAPPs` remains only the seed source. Add a lightweight `metaapps.config.json` registry plus richer `APP.md` frontmatter (`version`, `creator-metaid`, `source-type`), then teach `syncBundledMetaAppsToUserData()` to compare bundled metadata with local registry metadata before deciding between install, full-directory replacement, or no-op.

**Tech Stack:** Electron main process, Node `fs`/`path`, existing packaged startup sync flow in `main.ts`, TypeScript, Node built-in test runner

---

## File Structure

### New files

- `METAAPPs/metaapps.config.json`
  Bundled seed registry for IDBots-managed MetaApps. Stores per-app defaults such as `version`, `creator-metaid`, `source-type`, `installedAt`, and `updatedAt`.

- `docs/superpowers/plans/2026-03-24-metaapps-managed-upgrade.md`
  This implementation plan. Note: `docs/` is ignored by git in this clone, so commits must use `git add -f`.

### Modified files

- `src/main/metaAppManager.ts`
  Extend `MetaAppRecord`, parse the new frontmatter fields, load/merge `metaapps.config.json`, classify source ownership, compare versions, and replace the current packaged sync logic with managed install/upgrade/no-op behavior.

- `tests/metaAppManager.test.mjs`
  Expand coverage from basic registration to managed metadata parsing and packaged upgrade behavior: install, upgrade, no-op, conflict, external-source preservation, and stale-file cleanup.

- `METAAPPs/buzz/APP.md`
  Add `version`, `creator-metaid`, and `source-type: bundled-idbots` so the bundled sample is a valid managed MetaApp.

- `METAAPPs/chat/APP.md`
  Add the same managed frontmatter fields as `buzz`.

## Implementation Notes

- Keep the live packaged read path unchanged: packaged runtime still scans `userData/METAAPPs`, not bundled `resources/METAAPPs`.
- Preserve the current `buildCoworkAutoRoutingPrompt()` behavior; the managed upgrade work should not change Cowork routing text or `open_metaapp`.
- Implement whole-directory replacement by removing the target directory before copying the new version. Do not rely on `fs.cpSync(..., { force: true })` alone, because it will leave stale files behind.
- Use the registry to classify management responsibility:
  - `bundled-idbots` and `chain-idbots` are IDBots-managed
  - `chain-community` and `manual` are external and must never be auto-overwritten by bundled sync
- Same-version local directories must not be overwritten even if their contents differ.
- Do not add UI, toast notifications, or conflict dialogs in this change.

### Task 1: Add managed MetaApp metadata and fixture coverage

**Files:**
- Create: `METAAPPs/metaapps.config.json`
- Modify: `METAAPPs/buzz/APP.md`
- Modify: `METAAPPs/chat/APP.md`
- Modify: `src/main/metaAppManager.ts`
- Test: `tests/metaAppManager.test.mjs`

- [ ] **Step 1: Write the failing metadata tests**

Add or extend `tests/metaAppManager.test.mjs` with cases like:

```js
test('listMetaApps exposes version, creator-metaid, and source-type from APP.md', () => {
  // Arrange a temp METAAPPs root with APP.md frontmatter:
  // version: 1.2.0
  // creator-metaid: idbots
  // source-type: bundled-idbots
  // Assert listMetaApps()[0] includes those fields.
});

test('packaged sync seeds metaapps.config defaults for bundled-idbots apps', () => {
  // Arrange packaged bundled root with METAAPPs/metaapps.config.json.
  // Assert syncBundledMetaAppsToUserData() creates the user config.
});
```

- [ ] **Step 2: Run the targeted tests to verify they fail**

Run:

```bash
npm run compile:electron
node --test tests/metaAppManager.test.mjs
```

Expected: FAIL because `MetaAppRecord` does not expose the new metadata yet, bundled sample `APP.md` files do not contain the new fields, and no `metaapps.config.json` support exists.

- [ ] **Step 3: Add the bundled registry and manifest fields**

Create `METAAPPs/metaapps.config.json` with a minimal structure like:

```json
{
  "version": 1,
  "description": "Default MetaApp configuration for IDBots",
  "defaults": {
    "buzz": {
      "version": "1.0.0",
      "creator-metaid": "idbots",
      "source-type": "bundled-idbots",
      "installedAt": 1774224000000,
      "updatedAt": 1774224000000
    },
    "chat": {
      "version": "1.0.0",
      "creator-metaid": "idbots",
      "source-type": "bundled-idbots",
      "installedAt": 1774224000000,
      "updatedAt": 1774224000000
    }
  }
}
```

Update `METAAPPs/buzz/APP.md` and `METAAPPs/chat/APP.md` frontmatter to include:

```md
version: 1.0.0
creator-metaid: idbots
source-type: bundled-idbots
```

- [ ] **Step 4: Implement metadata parsing in `MetaAppManager`**

Extend `src/main/metaAppManager.ts` so `MetaAppRecord` includes at least:

```ts
type MetaAppSourceType = 'bundled-idbots' | 'chain-idbots' | 'chain-community' | 'manual';

export type MetaAppRecord = {
  id: string;
  name: string;
  description: string;
  updatedAt: number;
  entry: string;
  appPath: string;
  appRoot: string;
  prompt: string;
  version: string;
  creatorMetaId: string;
  sourceType: MetaAppSourceType;
  managedByIdbots: boolean;
};
```

Implement frontmatter fallback rules:

- `version` defaults to `'0'`
- `creator-metaid` defaults to `''`
- `source-type` defaults to `'manual'`

Add registry helpers inside this file:

```ts
type MetaAppDefaultConfig = {
  version?: string;
  'creator-metaid'?: string;
  'source-type'?: string;
  installedAt?: number;
  updatedAt?: number;
};

type MetaAppsConfig = {
  version?: number;
  description?: string;
  defaults: Record<string, MetaAppDefaultConfig>;
};
```

Add `loadMetaAppDefaultsFromRoot(root)` and `resolveMetaAppsConfigPath(root)` helpers mirroring the `SKILLs` pattern, but keep the implementation local to `metaAppManager.ts`.

- [ ] **Step 5: Run the metadata tests again**

Run:

```bash
npm run compile:electron
node --test tests/metaAppManager.test.mjs
```

Expected: the new metadata tests pass, while upgrade-policy tests added in later tasks are still pending.

- [ ] **Step 6: Commit the metadata task**

Run:

```bash
git add METAAPPs/metaapps.config.json METAAPPs/buzz/APP.md METAAPPs/chat/APP.md src/main/metaAppManager.ts tests/metaAppManager.test.mjs
git commit -m "feat: add managed metaapp metadata"
```

### Task 2: Implement version-driven packaged sync policy

**Files:**
- Modify: `src/main/metaAppManager.ts`
- Test: `tests/metaAppManager.test.mjs`

- [ ] **Step 1: Write the failing packaged-sync behavior tests**

Extend `tests/metaAppManager.test.mjs` with packaged temp-root cases covering:

```js
test('packaged sync installs missing bundled-idbots apps into userData', () => {
  // bundled version 1.0.0, no local app -> copied
});

test('packaged sync upgrades bundled-idbots app when bundled version is higher', () => {
  // local 1.0.0, bundled 1.1.0 -> replaced
});

test('packaged sync does not overwrite same-version local app', () => {
  // local 1.0.0 with user edit, bundled 1.0.0 -> preserve local file contents
});

test('packaged sync does not downgrade when bundled version is lower', () => {
  // local 1.2.0, bundled 1.1.0 -> preserve local
});

test('packaged sync does not overwrite when creator-metaid differs', () => {
  // same id, different creator-metaid -> preserve local
});

test('packaged sync does not overwrite chain-community or manual local apps', () => {
  // local source-type manual / chain-community -> preserve local
});
```

- [ ] **Step 2: Run the targeted tests to verify they fail**

Run:

```bash
npm run compile:electron
node --test tests/metaAppManager.test.mjs
```

Expected: FAIL because `syncBundledMetaAppsToUserData()` currently only copies missing directories and has no version/source/creator comparison logic.

- [ ] **Step 3: Add comparison helpers to `MetaAppManager`**

Inside `src/main/metaAppManager.ts`, add minimal helpers such as:

```ts
const compareVersions = (a: string | undefined, b: string | undefined): number => { /* semver-like compare */ };

const isIdbotsManagedSource = (sourceType: string | undefined): boolean =>
  sourceType === 'bundled-idbots' || sourceType === 'chain-idbots';
```

Also add config writers/mergers:

```ts
private writeMetaAppsConfig(root: string, config: MetaAppsConfig): void;
private mergeBundledMetaAppDefaults(userRoot: string, bundledRoot: string, syncedAppIds: Set<string>): void;
```

The merge rule should preserve existing local metadata keys unless a bundled sync explicitly updated that app, similar in spirit to `SkillManager.mergeBundledSkillDefaults`.

- [ ] **Step 4: Replace `syncBundledMetaAppsToUserData()` with managed rules**

Implement the new decision tree:

```ts
if (!targetExists) install();
else if (creatorMismatch) noop();
else if (!isIdbotsManagedSource(localSourceType)) noop();
else if (compareVersions(bundledVersion, localVersion) > 0) replaceWholeDirectory();
else noop();
```

When install or upgrade happens:

- copy the bundled directory into `userData/METAAPPs/<id>`
- update `metaapps.config.json`
- set `installedAt` when first installed
- bump `updatedAt` on any managed sync

Do not overwrite when versions are equal.

- [ ] **Step 5: Run the packaged-sync tests again**

Run:

```bash
npm run compile:electron
node --test tests/metaAppManager.test.mjs
```

Expected: all install/upgrade/no-op/conflict tests pass.

- [ ] **Step 6: Commit the sync-policy task**

Run:

```bash
git add src/main/metaAppManager.ts tests/metaAppManager.test.mjs
git commit -m "feat: add managed metaapp sync policy"
```

### Task 3: Guarantee whole-directory replacement semantics

**Files:**
- Modify: `src/main/metaAppManager.ts`
- Test: `tests/metaAppManager.test.mjs`

- [ ] **Step 1: Write the failing stale-file cleanup test**

Add a test like:

```js
test('managed metaapp upgrade removes files that exist only in the old local directory', () => {
  // local buzz/app/legacy.js exists only in old version
  // bundled 1.1.0 omits legacy.js
  // after upgrade, legacy.js should be gone
});
```

- [ ] **Step 2: Run the targeted tests to verify they fail**

Run:

```bash
npm run compile:electron
node --test tests/metaAppManager.test.mjs
```

Expected: FAIL because copying over an existing directory with `fs.cpSync(... force: true)` does not remove stale files.

- [ ] **Step 3: Implement safe whole-directory replacement**

In `src/main/metaAppManager.ts`, add a helper like:

```ts
const replaceDirContents = (sourceDir: string, targetDir: string): void => {
  fs.rmSync(targetDir, { recursive: true, force: true });
  fs.cpSync(sourceDir, targetDir, {
    recursive: true,
    dereference: true,
    force: false,
    errorOnExist: false,
  });
};
```

Use this helper only for the approved upgrade path, not for no-op cases.

- [ ] **Step 4: Run the test suite again**

Run:

```bash
npm run compile:electron
node --test tests/metaAppManager.test.mjs
node --test tests/metaAppCoworkPrompt.test.mjs tests/metaAppOpenService.test.mjs tests/metaAppLocalServer.test.mjs
```

Expected: PASS, proving the managed upgrade work did not regress Cowork routing or local open behavior.

- [ ] **Step 5: Commit the whole-directory replacement task**

Run:

```bash
git add src/main/metaAppManager.ts tests/metaAppManager.test.mjs
git commit -m "fix: replace managed metaapps by whole directory"
```

### Task 4: Final verification and packaged acceptance notes

**Files:**
- Modify: `docs/superpowers/specs/2026-03-24-metaapps-managed-upgrade-design.md` only if the implementation revealed a spec correction
- No production-file changes expected if previous tasks are green

- [ ] **Step 1: Run the complete focused verification set**

Run:

```bash
npm run compile:electron
node --test tests/metaAppManager.test.mjs tests/metaAppLocalServer.test.mjs tests/metaAppOpenService.test.mjs tests/metaAppCoworkPrompt.test.mjs tests/superpowersCoworkPrompt.test.mjs
```

Expected: PASS.

- [ ] **Step 2: Run a packaged-startup smoke check in dev runtime**

Use a temp packaged-style `MetaAppManager` test or a one-off node/electron smoke if needed to confirm:

- missing bundled MetaApps install,
- higher bundled versions replace local ones,
- same-version local edits survive.

If a new automated test already proves these, do not add redundant manual instrumentation.

- [ ] **Step 3: Check git status and record the final commit chain**

Run:

```bash
git status --short
git log --oneline --decorate -n 5
```

Expected: clean worktree with the metadata, sync-policy, and whole-directory replacement commits present.

- [ ] **Step 4: Commit any final plan-aligned touch-ups**

Only if needed:

```bash
git add <exact files>
git commit -m "test: finalize managed metaapp upgrade coverage"
```

- [ ] **Step 5: Save or update the implementation plan in git**

Because `docs/` is ignored in this clone, use:

```bash
git add -f docs/superpowers/plans/2026-03-24-metaapps-managed-upgrade.md
git commit -m "docs: add metaapps managed upgrade plan"
```

Skip this commit if the plan document was already committed unchanged before execution.
