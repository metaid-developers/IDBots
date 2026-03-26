# MetaApp Section Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a new top-level `元应用` section that lists local MetaApps, reserves a `推荐` tab shell, and lets users either open a MetaApp directly or start a Cowork session around it.

**Architecture:** Reuse the existing MetaAppManager / openMetaApp backend contract and extend the renderer-facing IPC surface so the UI can list, open, and subscribe to MetaApp changes. Keep the view shape close to the Skills section by building a parallel `MetaAppsView` / `MetaAppsManager` pair and small pure presentation helpers for filtering, empty states, and prompt text.

**Tech Stack:** Electron IPC, React 18, TypeScript, Redux, Heroicons, Node `--test`

---

### Task 1: Expose a Complete MetaApp Renderer Contract

**Files:**
- Modify: `tests/metaAppCoworkPrompt.test.mjs`
- Modify: `src/main/main.ts`
- Modify: `src/main/preload.ts`
- Modify: `src/renderer/types/electron.d.ts`
- Modify: `src/renderer/services/metaApp.ts`

- [ ] **Step 1: Write the failing preload / IPC contract test**

Add assertions to `tests/metaAppCoworkPrompt.test.mjs` so the preload-exposed `window.electron.metaapps` API must include list, open, resolveUrl, and onChanged in addition to autoRoutingPrompt.

```js
assert.equal(typeof exposedApi.metaapps?.list, 'function');
assert.equal(typeof exposedApi.metaapps?.open, 'function');
assert.equal(typeof exposedApi.metaapps?.resolveUrl, 'function');
assert.equal(typeof exposedApi.metaapps?.onChanged, 'function');
```

- [ ] **Step 2: Run the targeted test to verify it fails**

Run: `npm run compile:electron && node --test tests/metaAppCoworkPrompt.test.mjs`

Expected: FAIL because preload / main / type contract does not expose the new MetaApp API surface yet.

- [ ] **Step 3: Implement the minimal MetaApp IPC contract**

Update the main/preload/renderer surface so the renderer can list and open MetaApps through a single namespace.

```ts
ipcMain.handle('metaapps:list', () => {
  return { success: true, apps: getMetaAppManager().listMetaApps() };
});

ipcMain.handle('metaapps:open', async (_event, input) => {
  return openMetaApp({
    appId: input.appId,
    targetPath: input.targetPath,
    manager: getMetaAppManager(),
    ensureServerReady: ensureMetaAppServerReady,
    shellOpenExternal: shell.openExternal,
  });
});
```

```ts
metaapps: {
  list: () => ipcRenderer.invoke('metaapps:list'),
  open: (input) => ipcRenderer.invoke('metaapps:open', input),
  resolveUrl: (input) => ipcRenderer.invoke('metaapps:resolveUrl', input),
  autoRoutingPrompt: () => ipcRenderer.invoke('metaapps:autoRoutingPrompt'),
  onChanged: (callback) => { /* subscribe to metaapps:changed */ },
}
```

```ts
class MetaAppService {
  async listMetaApps() { /* call window.electron.metaapps.list() */ }
  async openMetaApp(appId: string, targetPath?: string) { /* call open */ }
  async resolveMetaAppUrl(appId: string, targetPath?: string) { /* call resolveUrl */ }
  onMetaAppsChanged(callback: () => void) { return window.electron.metaapps.onChanged(callback); }
}
```

- [ ] **Step 4: Run the targeted test to verify it passes**

Run: `npm run compile:electron && node --test tests/metaAppCoworkPrompt.test.mjs`

Expected: PASS with the expanded MetaApp renderer contract available.

- [ ] **Step 5: Commit**

```bash
git add tests/metaAppCoworkPrompt.test.mjs src/main/main.ts src/main/preload.ts src/renderer/types/electron.d.ts src/renderer/services/metaApp.ts
git commit -m "feat: expose metaapp renderer APIs"
```

### Task 2: Add Pure MetaApp Presentation Helpers With TDD

**Files:**
- Create: `tests/metaAppPresentation.test.mjs`
- Create: `src/renderer/components/metaapps/metaAppPresentation.js`

- [ ] **Step 1: Write the failing presentation tests**

Create `tests/metaAppPresentation.test.mjs` to cover:
- filtering by `name` and `description`
- building the `使用该应用` prompt
- recommended-tab empty-state copy

```js
assert.deepEqual(filterMetaApps(apps, 'buzz').map((app) => app.id), ['buzz']);
assert.match(buildUseMetaAppPrompt({ name: 'Buzz' }), /使用本地元应用 Buzz/);
assert.equal(getRecommendedMetaAppsEmptyState('zh').title, '推荐元应用即将开放');
```

- [ ] **Step 2: Run the targeted test to verify it fails**

Run: `node --test tests/metaAppPresentation.test.mjs`

Expected: FAIL because `metaAppPresentation.js` does not exist yet.

- [ ] **Step 3: Implement the minimal helper module**

Create a focused helper module used by the UI.

```js
export function filterMetaApps(apps, query) {
  const normalized = String(query ?? '').trim().toLowerCase();
  if (!normalized) return apps;
  return apps.filter((app) =>
    app.name.toLowerCase().includes(normalized) ||
    app.description.toLowerCase().includes(normalized)
  );
}

export function buildUseMetaAppPrompt(app) {
  return `请帮我使用本地元应用 ${app.name}。如果需要，请直接打开它，并基于这个应用继续协助我完成任务。`;
}
```

- [ ] **Step 4: Run the targeted test to verify it passes**

Run: `node --test tests/metaAppPresentation.test.mjs`

Expected: PASS with filtering, prompt text, and recommended empty-state copy covered.

- [ ] **Step 5: Commit**

```bash
git add tests/metaAppPresentation.test.mjs src/renderer/components/metaapps/metaAppPresentation.js
git commit -m "feat: add metaapp presentation helpers"
```

### Task 3: Add MetaApp View Components and Navigation

**Files:**
- Create: `src/renderer/components/metaapps/index.ts`
- Create: `src/renderer/components/metaapps/MetaAppsView.tsx`
- Create: `src/renderer/components/metaapps/MetaAppsManager.tsx`
- Modify: `src/renderer/App.tsx`
- Modify: `src/renderer/components/Sidebar.tsx`
- Modify: `src/renderer/services/i18n.ts`

- [ ] **Step 1: Write the failing navigation / render test**

Add a focused render test that proves the sidebar includes `元应用` before `技能`, and a MetaApps view can render its heading.

```tsx
const markup = renderToStaticMarkup(
  <Provider store={store}>
    <Sidebar activeView="metaapps" ... />
  </Provider>
);

assert.ok(markup.indexOf('元应用') < markup.indexOf('技能'));
```

- [ ] **Step 2: Run the targeted test to verify it fails**

Run: `node --test tests/metaAppSidebar.test.tsx`

Expected: FAIL because the `metaapps` view and sidebar entry do not exist yet.

- [ ] **Step 3: Implement the MetaApps page and navigation**

Create a `MetaAppsView` that mirrors `SkillsView`, and a `MetaAppsManager` that mirrors the Skills page layout but only keeps the required tabs, search, empty states, errors, and two item actions.

```tsx
const [activeTab, setActiveTab] = useState<'local' | 'recommended'>('local');
const [apps, setApps] = useState<MetaAppRecord[]>([]);
const filteredApps = useMemo(() => filterMetaApps(apps, searchQuery), [apps, searchQuery]);
```

```tsx
<button onClick={() => handleUseMetaApp(app)}>{i18nService.t('metaAppUse')}</button>
<button onClick={() => handleOpenMetaApp(app)}>{i18nService.t('metaAppOpen')}</button>
```

Also:
- extend `mainView` to include `'metaapps'`
- add `handleShowMetaApps`
- wire the new page into `App.tsx`
- add sidebar nav item before Skills
- add all new i18n strings in zh/en

- [ ] **Step 4: Run the targeted render test to verify it passes**

Run: `node --test tests/metaAppSidebar.test.tsx`

Expected: PASS with the new sidebar order and MetaApps heading present.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/metaapps/index.ts src/renderer/components/metaapps/MetaAppsView.tsx src/renderer/components/metaapps/MetaAppsManager.tsx src/renderer/App.tsx src/renderer/components/Sidebar.tsx src/renderer/services/i18n.ts tests/metaAppSidebar.test.tsx
git commit -m "feat: add metaapp section UI"
```

### Task 4: Wire Up MetaApp Actions and Run Full Verification

**Files:**
- Modify: `src/renderer/components/metaapps/MetaAppsManager.tsx`
- Modify: `src/renderer/App.tsx`
- Test: `tests/metaAppCoworkPrompt.test.mjs`
- Test: `tests/metaAppPresentation.test.mjs`
- Test: `tests/metaAppSidebar.test.tsx`
- Test: `tests/metaAppLocalServer.test.mjs`
- Test: `tests/metaAppOpenService.test.mjs`

- [ ] **Step 1: Write the failing interaction test**

Extend the MetaApp UI coverage so `使用该应用` must create a Cowork prompt using the helper and `打开` must call the MetaApp service.

```js
assert.match(buildUseMetaAppPrompt({ name: 'Chat' }), /Chat/);
assert.equal(typeof metaAppService.openMetaApp, 'function');
```

- [ ] **Step 2: Run the targeted tests to verify the missing behavior**

Run:

```bash
npm run compile:electron
node --test tests/metaAppPresentation.test.mjs tests/metaAppCoworkPrompt.test.mjs tests/metaAppOpenService.test.mjs
```

Expected: FAIL or remain incomplete until the UI handlers are wired to the Cowork / MetaApp services.

- [ ] **Step 3: Implement the minimal action wiring**

For `使用该应用`:
- clear the current session the same way `handleNewChat` does
- switch to Cowork
- create a new session with the MetaApp prompt via `coworkService.startSession(...)`

For `打开`:
- call `metaAppService.openMetaApp(app.id, app.entry)`
- surface failures through the existing in-page error mechanism

```ts
const prompt = buildUseMetaAppPrompt(app);
const session = await coworkService.startSession({ prompt });
if (session) setMainView('cowork');
```

- [ ] **Step 4: Run the full verification suite**

Run:

```bash
npm run compile:electron
node --test tests/metaAppCoworkPrompt.test.mjs tests/metaAppPresentation.test.mjs tests/metaAppOpenService.test.mjs tests/metaAppLocalServer.test.mjs tests/quickActionPresentation.test.mjs
npm run lint
```

Expected:
- Electron compile succeeds
- MetaApp-related tests pass
- lint exits 0

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/metaapps/MetaAppsManager.tsx src/renderer/App.tsx
git commit -m "feat: wire metaapp actions into cowork"
```
