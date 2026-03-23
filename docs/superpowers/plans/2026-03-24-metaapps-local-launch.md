# METAAPPs Local Launch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a first-phase `METAAPPs` runtime for Cowork so the model can detect local app-opening intent, read `APP.md`, validate a target path, ensure a localhost static server is running, open the app in the user's browser, and include the opened URL in the reply.

**Architecture:** Mirror the `SKILLs` storage boundary without cloning every Skill feature. A new `MetaAppManager` owns runtime roots, bundled-to-userData sync, `APP.md` scanning, and Cowork prompt generation. A dedicated localhost static server serves the active `METAAPPs` root, and a separate open service validates `targetPath`, ensures the server exists, and calls `shell.openExternal`. Cowork receives a parallel MetaApp routing prompt and a new `open_metaapp` tool wired through `CoworkRunner`.

**Tech Stack:** Electron main process, Node HTTP server, TypeScript, existing CoworkRunner Claude SDK tool integration, renderer IPC/preload bindings, Node built-in test runner

---

## File Structure

### New files

- `src/main/metaAppManager.ts`
  Runtime root resolution, bundled sync, `APP.md` parsing, registry listing, Cowork MetaApp prompt builder, directory watching.

- `src/main/services/metaAppLocalServer.ts`
  Demand-started `127.0.0.1` static server for the active `METAAPPs` root, health endpoint, safe path mapping, lifecycle helpers.

- `src/main/services/metaAppOpenService.ts`
  Deterministic `open_metaapp` execution: look up MetaApp, validate `targetPath`, ensure server, build final URL, call `shell.openExternal`, return structured result.

- `src/renderer/services/metaApp.ts`
  Renderer wrapper for MetaApp prompt IPC, mirroring the existing `skillService` pattern.

- `tests/metaAppManager.test.mjs`
  Manager scan, fallback fields, `entry` validation, bundled-vs-userData root behavior, Cowork prompt output.

- `tests/metaAppLocalServer.test.mjs`
  Local server health endpoint, static file serving, traversal rejection, root identity checks.

- `tests/metaAppOpenService.test.mjs`
  `open_metaapp` validation and browser-open orchestration with mocked `shell.openExternal`.

### Modified files

- `electron-builder.json`
  Bundle `METAAPPs` through `extraResources`, parallel to `SKILLs`.

- `METAAPPs/buzz/APP.md`
  Add `entry` frontmatter and body guidance that matches the agreed contract.

- `METAAPPs/chat/APP.md`
  Replace the empty file with a valid `APP.md` so `chat` can register in Phase 1.

- `src/main/main.ts`
  Add `MetaAppManager` singleton, packaged startup sync/watch, CoworkRunner dependency injection, IPC surface for Cowork prompt retrieval, and app-shutdown cleanup for the local server.

- `src/main/preload.ts`
  Expose MetaApp prompt IPC to the renderer.

- `src/main/libs/coworkRunner.ts`
  Register the `open_metaapp` Claude SDK tool and call the injected open handler.

- `src/renderer/types/electron.d.ts`
  Add MetaApp IPC types.

- `src/renderer/components/cowork/CoworkView.tsx`
  Always combine `metaAppPrompt + effectiveSkillPrompt + config.systemPrompt` for Cowork starts and continues.

---

### Task 1: Package and register METAAPPs

**Files:**
- Modify: `electron-builder.json`
- Create: `src/main/metaAppManager.ts`
- Modify: `src/main/main.ts`
- Modify: `METAAPPs/buzz/APP.md`
- Modify: `METAAPPs/chat/APP.md`
- Test: `tests/metaAppManager.test.mjs`

- [ ] **Step 1: Write the failing manager tests**

Create `tests/metaAppManager.test.mjs` covering:

```js
test('listMetaApps registers valid APP.md entries and skips missing/invalid entry values', () => {
  // Arrange temp METAAPPs root with valid buzz/chat APP.md files and one invalid app.
  // Assert listMetaApps() only returns valid apps.
});

test('buildCoworkAutoRoutingPrompt emits <available_metaapps> with location and entry', () => {
  // Assert prompt contains the metaapp section, id, description, entry, and APP.md path.
});

test('packaged root prefers userData and sync copies bundled METAAPPs into it', () => {
  // Mock packaged app paths and assert syncBundledMetaAppsToUserData() seeds userData/METAAPPs.
});
```

- [ ] **Step 2: Run the new test file to verify it fails**

Run:

```bash
npm run compile:electron
node --test tests/metaAppManager.test.mjs
```

Expected: FAIL because `src/main/metaAppManager.ts` and its exported API do not exist yet.

- [ ] **Step 3: Implement `MetaAppManager`**

Create `src/main/metaAppManager.ts` with:

- `getMetaAppsRoot()`
- `ensureMetaAppsRoot()`
- `getBundledMetaAppsRoot()`
- `syncBundledMetaAppsToUserData()`
- `listMetaApps()`
- `buildCoworkAutoRoutingPrompt()`
- `startWatching()` / `stopWatching()`

Use the current lightweight `SkillManager` style:

- parse frontmatter scalars only,
- derive `id` from folder name,
- keep `entry` as the required deterministic open field,
- keep `prompt` as the post-frontmatter body,
- emit `metaapps:changed` if watcher notifications are added now.

- [ ] **Step 4: Wire startup and singleton access in `main.ts`**

Add:

- `let metaAppManager: MetaAppManager | null = null;`
- `const getMetaAppManager = () => ...`
- packaged startup calls to:

```ts
const metaAppManager = getMetaAppManager();
metaAppManager.syncBundledMetaAppsToUserData();
metaAppManager.startWatching();
```

Place this near the existing `SkillManager` startup wiring so the storage pattern stays parallel.

- [ ] **Step 5: Make the sample MetaApps valid**

Update `METAAPPs/buzz/APP.md` to include:

```md
entry: /buzz/app/index.html
```

Replace `METAAPPs/chat/APP.md` with a valid contract, for example:

```md
---
name: chat-app
description: chat 是一个链上聊天应用，支持群聊与私聊入口
official: true
entry: /chat/app/chat.html
---
```

Add a short `When To Use` / `Examples` body so Cowork has enough guidance.

- [ ] **Step 6: Run the manager tests again**

Run:

```bash
npm run compile:electron
node --test tests/metaAppManager.test.mjs
```

Expected: PASS with the new manager behavior and valid sample `APP.md` files.

- [ ] **Step 7: Commit the registration task**

Run:

```bash
git add electron-builder.json METAAPPs/buzz/APP.md METAAPPs/chat/APP.md src/main/metaAppManager.ts src/main/main.ts tests/metaAppManager.test.mjs
git commit -m "feat: add metaapp registry and packaging"
```

### Task 2: Add the localhost MetaApp static server

**Files:**
- Create: `src/main/services/metaAppLocalServer.ts`
- Modify: `src/main/main.ts`
- Test: `tests/metaAppLocalServer.test.mjs`

- [ ] **Step 1: Write the failing local-server tests**

Create `tests/metaAppLocalServer.test.mjs` covering:

```js
test('ensureMetaAppServerReady starts a 127.0.0.1 server with a health endpoint', async () => {
  // Assert /__idbots/metaapps/health reports the active root.
});

test('server serves a valid app file from the active METAAPPs root', async () => {
  // Fetch /buzz/app/index.html and assert the HTML is returned.
});

test('server rejects traversal outside METAAPPs', async () => {
  // Fetch '/../package.json' and assert 400/404.
});
```

- [ ] **Step 2: Run the server test file to verify it fails**

Run:

```bash
npm run compile:electron
node --test tests/metaAppLocalServer.test.mjs
```

Expected: FAIL because `metaAppLocalServer.ts` does not exist yet.

- [ ] **Step 3: Implement `metaAppLocalServer.ts`**

Create a singleton-style service with:

- `ensureMetaAppServerReady(root: string): Promise<{ baseUrl: string; port: number }>`
- `getMetaAppBaseUrl(): string | null`
- `stopMetaAppServer(): Promise<void>`

Implementation requirements:

- bind only to `127.0.0.1`,
- choose an ephemeral port by listening on port `0`,
- serve only `GET` / `HEAD`,
- expose `GET /__idbots/metaapps/health`,
- map `/<appId>/...` safely into `<root>/<appId>/...`,
- reject traversal and missing files.

- [ ] **Step 4: Add lifecycle cleanup in `main.ts`**

On app shutdown / cleanup paths, ensure the MetaApp server is stopped alongside other long-lived services.

- [ ] **Step 5: Run the server tests again**

Run:

```bash
npm run compile:electron
node --test tests/metaAppLocalServer.test.mjs
```

Expected: PASS with health, serving, and traversal protection covered.

- [ ] **Step 6: Commit the local-server task**

Run:

```bash
git add src/main/services/metaAppLocalServer.ts src/main/main.ts tests/metaAppLocalServer.test.mjs
git commit -m "feat: serve local metaapps over localhost"
```

### Task 3: Add a deterministic MetaApp open service

**Files:**
- Create: `src/main/services/metaAppOpenService.ts`
- Test: `tests/metaAppOpenService.test.mjs`

- [ ] **Step 1: Write the failing open-service tests**

Create `tests/metaAppOpenService.test.mjs` covering:

```js
test('openMetaApp resolves a valid targetPath, ensures the server, and opens the final URL', async () => {
  // Mock listMetaApps(), ensureMetaAppServerReady(), and shell.openExternal().
});

test('openMetaApp falls back to record.entry when targetPath is empty', async () => {
  // Assert empty or omitted targetPath still opens the registered entry.
});

test('openMetaApp rejects invalid app ids and cross-app target paths', async () => {
  // Assert /chat/... is rejected when appId is buzz.
});
```

- [ ] **Step 2: Run the open-service tests to verify they fail**

Run:

```bash
npm run compile:electron
node --test tests/metaAppOpenService.test.mjs
```

Expected: FAIL because `metaAppOpenService.ts` does not exist yet.

- [ ] **Step 3: Implement `metaAppOpenService.ts`**

Export a helper shaped roughly like:

```ts
export async function openMetaApp(input: {
  appId: string;
  targetPath?: string;
  manager: Pick<MetaAppManager, 'listMetaApps'>;
  ensureServerReady: (root: string) => Promise<{ baseUrl: string }>;
  shellOpenExternal: (url: string) => Promise<void>;
}): Promise<{ success: boolean; appId?: string; name?: string; url?: string; error?: string }>
```

Rules:

- resolve `appId` from the manager,
- validate `targetPath` starts with `/${appId}/`,
- allow fallback to `record.entry`,
- preserve query/hash only after validating the path portion,
- call `shell.openExternal(finalUrl)`,
- return structured success/failure for the tool layer.

- [ ] **Step 4: Run the open-service tests again**

Run:

```bash
npm run compile:electron
node --test tests/metaAppOpenService.test.mjs
```

Expected: PASS with deterministic URL generation and rejection behavior.

- [ ] **Step 5: Commit the open-service task**

Run:

```bash
git add src/main/services/metaAppOpenService.ts tests/metaAppOpenService.test.mjs
git commit -m "feat: add validated metaapp open service"
```

### Task 4: Inject MetaApp routing into Cowork and add the `open_metaapp` tool

**Files:**
- Modify: `src/main/libs/coworkRunner.ts`
- Modify: `src/main/main.ts`
- Modify: `src/main/preload.ts`
- Modify: `src/renderer/types/electron.d.ts`
- Create: `src/renderer/services/metaApp.ts`
- Modify: `src/renderer/components/cowork/CoworkView.tsx`
- Test: `tests/metaAppCoworkPrompt.test.mjs`

- [ ] **Step 1: Write the failing Cowork MetaApp prompt/tool tests**

Create `tests/metaAppCoworkPrompt.test.mjs` covering two things:

```js
test('buildCoworkAutoRoutingPrompt emits the MetaApps section with available_metaapps entries', () => {
  // Assert the manager prompt contains metaapp instructions and APP.md locations.
});

test('open_metaapp tool schema is registered when CoworkRunner starts a local Claude session', async () => {
  // Stub loadClaudeSdk() and assert a tool named open_metaapp is registered.
});
```

- [ ] **Step 2: Run the Cowork MetaApp test file to verify it fails**

Run:

```bash
npm run compile:electron
node --test tests/metaAppCoworkPrompt.test.mjs
```

Expected: FAIL because neither the MetaApp prompt wiring nor the tool registration exists yet.

- [ ] **Step 3: Add main/preload/renderer prompt wiring**

Implement:

- `ipcMain.handle('metaapps:autoRoutingPrompt', ...)` in `src/main/main.ts`
- `window.electron.metaapps.autoRoutingPrompt()` in `src/main/preload.ts`
- matching types in `src/renderer/types/electron.d.ts`
- `src/renderer/services/metaApp.ts` mirroring `skillService.getAutoRoutingPrompt()`

Then update `src/renderer/components/cowork/CoworkView.tsx` so both start and continue flows combine:

```ts
const combinedSystemPrompt = [metaAppPrompt, effectiveSkillPrompt, config.systemPrompt]
  .filter((p) => p?.trim())
  .join('\n\n') || undefined;
```

MetaApp prompt should be fetched regardless of whether a manual skill prompt is present.

- [ ] **Step 4: Add `open_metaapp` tool registration in `CoworkRunner`**

Extend `CoworkRunnerOptions` with an injected handler, for example:

```ts
openMetaApp?: (input: { appId: string; targetPath?: string }) => Promise<{ success: boolean; url?: string; error?: string; name?: string }>
```

Register the tool beside the existing in-process tools in `runClaudeCodeLocal()` using the same Claude SDK `tool(...)` API.

Tool schema:

```ts
{
  appId: z.string().min(1),
  targetPath: z.string().optional(),
}
```

Tool result text should be concise and machine-stable, for example:

```text
Opened metaapp "buzz-app" at http://127.0.0.1:38421/buzz/app/index.html?view=hot
```

- [ ] **Step 5: Inject the open handler from `main.ts`**

When constructing `new CoworkRunner(...)`, pass an `openMetaApp` closure that composes:

- `getMetaAppManager()`
- `ensureMetaAppServerReady(...)`
- `openMetaApp(...)`
- `shell.openExternal(...)`

- [ ] **Step 6: Run the Cowork MetaApp tests again**

Run:

```bash
npm run compile:electron
node --test tests/metaAppCoworkPrompt.test.mjs
```

Expected: PASS with both prompt generation and tool registration covered.

- [ ] **Step 7: Verify the renderer still typechecks**

Run:

```bash
npm run build
```

Expected: successful renderer + main build with no new type errors from preload/IPC/CoworkView changes.

- [ ] **Step 8: Commit the Cowork integration task**

Run:

```bash
git add src/main/libs/coworkRunner.ts src/main/main.ts src/main/preload.ts src/renderer/types/electron.d.ts src/renderer/services/metaApp.ts src/renderer/components/cowork/CoworkView.tsx tests/metaAppCoworkPrompt.test.mjs
git commit -m "feat: route cowork into local metaapps"
```

### Task 5: Run end-to-end validation and tighten the user-facing output

**Files:**
- Modify: `src/main/libs/coworkRunner.ts`
- Modify: `src/main/services/metaAppOpenService.ts`
- Modify: `docs/superpowers/specs/2026-03-24-metaapps-local-launch-design.md` if implementation constraints differ
- Test: `tests/metaAppManager.test.mjs`
- Test: `tests/metaAppLocalServer.test.mjs`
- Test: `tests/metaAppOpenService.test.mjs`
- Test: `tests/metaAppCoworkPrompt.test.mjs`

- [ ] **Step 1: Ensure the tool result and assistant-facing URL text are concise**

Normalize the `open_metaapp` tool result text so the model can reliably echo:

- app name,
- final localhost URL,
- no extra stack traces or implementation noise.

- [ ] **Step 2: Run the focused MetaApp test suite**

Run:

```bash
npm run compile:electron
node --test tests/metaAppManager.test.mjs tests/metaAppLocalServer.test.mjs tests/metaAppOpenService.test.mjs tests/metaAppCoworkPrompt.test.mjs
```

Expected: all four test files PASS.

- [ ] **Step 3: Run the project build**

Run:

```bash
npm run build
```

Expected: successful build with no regressions in the main or renderer bundles.

- [ ] **Step 4: Perform a manual Cowork smoke**

Run:

```bash
npm run electron:dev
```

Manual check:

1. Start a Cowork session.
2. Prompt: `打开 buzz 应用，我想看热门 buzz`
3. Confirm the model uses `open_metaapp`.
4. Confirm the default browser opens a `http://127.0.0.1:<port>/buzz/app/index.html...` URL.
5. Confirm the assistant reply includes the same local URL.

- [ ] **Step 5: Update the spec only if implementation reality differs**

If any file boundary, prompt contract, or validation rule changed during implementation, update:

- `docs/superpowers/specs/2026-03-24-metaapps-local-launch-design.md`

Do not make speculative spec edits if implementation matched the design.

- [ ] **Step 6: Commit the verification task**

Run:

```bash
git add src/main/libs/coworkRunner.ts src/main/services/metaAppOpenService.ts docs/superpowers/specs/2026-03-24-metaapps-local-launch-design.md tests/metaAppManager.test.mjs tests/metaAppLocalServer.test.mjs tests/metaAppOpenService.test.mjs tests/metaAppCoworkPrompt.test.mjs
git commit -m "test: verify cowork metaapp launch flow"
```
