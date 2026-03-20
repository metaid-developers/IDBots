# IDBots P2P Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate man-p2p Go binary into IDBots as a managed subprocess, replace all manapi.metaid.io/file.metaid.io/man.metaid.io calls with local localhost:7281 (with centralized API fallback), and add P2P status UI.

**Architecture:** New p2pIndexerService.ts manages the Go subprocess lifecycle. All external MetaID API calls are routed through a local proxy layer that tries localhost:7281 first, falls back to original URLs. New IPC channels expose P2P status and config to the renderer.

**Tech Stack:** TypeScript, Electron (main + renderer + preload), React, Redux Toolkit, Tailwind CSS

---

## Task 1: p2pIndexerService.ts — subprocess lifecycle management

**File:** `src/main/services/p2pIndexerService.ts` (new)

- [ ] Create `src/main/services/p2pIndexerService.ts`
- [ ] Implement `start(dataDir: string, configPath: string): Promise<void>` — resolves binary path from `process.resourcesPath`, spawns man-p2p with `--data-dir` and `--config` args, pipes stderr/stdout to console
- [ ] Implement `stop(): Promise<void>` — sends SIGTERM, waits up to 5s, then SIGKILL
- [ ] Implement `healthCheck(): Promise<boolean>` — `GET http://localhost:7281/health`, 2s timeout, returns true on 200
- [ ] Implement crash-restart loop: exponential backoff (1s, 2s, 4s, 8s, 16s), max 5 retries; after max retries emit `p2p:statusUpdate` with `{ running: false, error: 'max retries exceeded' }` to all renderer windows
- [ ] Register `app.on('before-quit')` handler that calls `stop()` before quit proceeds
- [ ] Export `getP2PStatus(): P2PStatus` returning current running state, peer count (from last health poll), data source

Binary path resolution (matches existing `createPinWorker` pattern):

```typescript
function resolveBinaryPath(): string {
  const platform = process.platform;
  const arch = process.arch;
  const names: Record<string, string> = {
    'darwin-arm64': 'man-p2p-darwin-arm64',
    'darwin-x64':   'man-p2p-darwin-x64',
    'win32-x64':    'man-p2p-win32-x64.exe',
    'linux-x64':    'man-p2p-linux-x64',
  };
  const key = `${platform}-${arch}`;
  const name = names[key] ?? `man-p2p-${key}`;
  return path.join(process.resourcesPath, name);
}
```

- [ ] Write test `tests/p2pIndexerService.test.mjs` using `node:test`:
  - Mock binary path to a non-existent file → `start()` should reject with a clear error
  - `healthCheck()` when nothing is listening on 7281 → returns `false` (no throw)
- [ ] Commit: `feat: add p2pIndexerService subprocess lifecycle manager`

---

## Task 2: P2P config management

**Files:** `src/main/services/p2pConfigService.ts` (new), `src/main/sqliteStore.ts` (modify)

- [ ] Add `getP2PConfig()` and `setP2PConfig(config: P2PConfig)` to `src/main/sqliteStore.ts` — reads/writes JSON blob under key `p2p_config` in the existing `kv` table
- [ ] Create `src/main/services/p2pConfigService.ts`:
  - Export `P2PConfig` interface matching the spec schema:
    ```typescript
    export interface P2PConfig {
      p2p_sync_mode: 'self' | 'selective' | 'full';
      p2p_selective_addresses?: string[];
      p2p_selective_paths?: string[];
      p2p_block_addresses?: string[];
      p2p_block_paths?: string[];
      p2p_max_content_size_kb?: number;
      p2p_bootstrap_nodes: string[];
      p2p_enable_relay: boolean;
      p2p_storage_limit_gb: number;
    }
    ```
  - Export `DEFAULT_P2P_CONFIG: P2PConfig` = `{ p2p_sync_mode: 'self', p2p_bootstrap_nodes: [], p2p_enable_relay: true, p2p_storage_limit_gb: 10 }`
  - Export `getConfig(store: SqliteStore): P2PConfig` — reads from SQLite, merges with defaults
  - Export `setConfig(store: SqliteStore, config: Partial<P2PConfig>): P2PConfig` — merges with existing, writes to SQLite
  - Export `writeConfigFile(config: P2PConfig, configPath: string): void` — writes JSON to temp file for man-p2p `--config` arg
  - Export `reloadConfig(): Promise<void>` — `POST http://localhost:7281/api/config/reload`, 3s timeout, swallows errors if man-p2p not running
- [ ] Commit: `feat: add p2pConfigService and SQLite p2p_config storage`

---

## Task 3: Local API proxy layer

**File:** `src/main/services/localIndexerProxy.ts` (new)

- [ ] Create `src/main/services/localIndexerProxy.ts`
- [ ] Export `fetchFromLocalOrFallback(localUrl: string, fallbackUrl: string, options?: RequestInit): Promise<Response>`:
  - Attempt `fetch(localUrl, { ...options, signal: AbortSignal.timeout(500) })`
  - On success (any 2xx): return the response
  - On non-2xx, timeout, or network error: fall through to `fetch(fallbackUrl, options)`
  - Log which path was taken at debug level: `[p2p-proxy] local ok` / `[p2p-proxy] fallback: <reason>`
- [ ] Write test `tests/localIndexerProxy.test.mjs`:
  - Local returns 200 → proxy returns local response (fallback never called)
  - Local returns 500 → proxy calls fallback
  - Local times out (mock AbortSignal) → proxy calls fallback
- [ ] Commit: `feat: add localIndexerProxy with 500ms local timeout and fallback`

---

## Task 4: Replace metaidCore.ts manapi calls

**File:** `src/main/services/metaidCore.ts` (modify)

Context: `getPinData()` at line 709 fetches `${MANAPI_BASE}/pin/${encodeURIComponent(pinId)}` when the pin is not in SQLite cache.

- [ ] Import `fetchFromLocalOrFallback` from `./localIndexerProxy`
- [ ] In `getPinData()`, replace the direct `fetch(url)` call with:
  ```typescript
  const localUrl = `http://localhost:7281/pin/${encodeURIComponent(pinId)}`;
  const fallbackUrl = `${MANAPI_BASE}/pin/${encodeURIComponent(pinId)}`;
  const res = await fetchFromLocalOrFallback(localUrl, fallbackUrl);
  ```
- [ ] Keep all existing SQLite L1 cache logic and persist-on-miss behavior unchanged
- [ ] Verify `npm run lint` passes
- [ ] Commit: `refactor: route metaidCore getPinData through local p2p proxy`

---

## Task 5: Replace main.ts manapi calls (4 call sites for /pin/path/list)

**File:** `src/main/main.ts` (modify)

The 4 call sites are at lines 485, 627, 674, 3056 — all construct `new URL('https://manapi.metaid.io/pin/path/list')` and call `fetch(url.toString())`.

- [ ] Import `fetchFromLocalOrFallback` at the top of `main.ts`
- [ ] For each of the 4 call sites, replace the `fetch(url.toString())` call with a proxy call:
  ```typescript
  // Before:
  const response = await fetch(url.toString());
  // After:
  const localUrl = url.toString().replace('https://manapi.metaid.io', 'http://localhost:7281');
  const response = await fetchFromLocalOrFallback(localUrl, url.toString());
  ```
- [ ] Ensure error handling around each call site is unchanged (existing `if (!response.ok)` guards remain)
- [ ] Verify `npm run lint` passes
- [ ] Commit: `refactor: route main.ts pin/path/list calls through local p2p proxy`

---

## Task 6: Replace skillSyncService.ts calls

**File:** `src/main/services/skillSyncService.ts` (modify)

Two call sites:
- Line 138: `session.defaultSession.fetch(url)` where `url` = `${MANAPI_BASE}/address/pin/list/${OFFICIAL_ADDRESS}?...`
- Line 243: `session.defaultSession.fetch(url)` where `url` = `${MAN_CONTENT_BASE}/${pinId}` (i.e. `https://man.metaid.io/content/${pinId}`)

- [ ] Import `fetchFromLocalOrFallback` from `./localIndexerProxy`
- [ ] Line 138 (`getOfficialSkillsStatus`): replace `session.defaultSession.fetch(url)` with:
  ```typescript
  const localUrl = `http://localhost:7281/address/pin/list/${OFFICIAL_ADDRESS}?cursor=0&size=200&path=/protocols/metabot-skill`;
  const response = await fetchFromLocalOrFallback(localUrl, url);
  ```
- [ ] Line 243 (`installOfficialSkill`): replace `session.defaultSession.fetch(url)` with:
  ```typescript
  const localUrl = `http://localhost:7281/content/${pinId}`;
  const response = await fetchFromLocalOrFallback(localUrl, url);
  ```
  Note: `fetchFromLocalOrFallback` uses the global `fetch`; the `session.defaultSession.fetch` was used to bypass CSP. Since this runs in the main process (no CSP), the global `fetch` is equivalent.
- [ ] Verify `npm run lint` passes
- [ ] Commit: `refactor: route skillSyncService calls through local p2p proxy`

---

## Task 7: Replace metabotRestoreService.ts calls

**File:** `src/main/services/metabotRestoreService.ts` (modify)

Three call sites (all use global `fetch`):
- `fetchMetaidInfoByAddress`: `${METAID_INFO_BY_ADDRESS}/${address}` → `https://file.metaid.io/metafile-indexer/api/v1/info/address/{address}`
- `fetchMetaidInfoByMetaid`: `${METAID_INFO_BY_METAID}/${metaid}` → `https://file.metaid.io/metafile-indexer/api/v1/info/metaid/{metaid}`
- `fetchAvatarDataUrl`: `${METAID_CONTENT_BASE}/${pinId}` → `https://file.metaid.io/metafile-indexer/content/{pinId}`

The local man-p2p endpoints (per spec section 5.2):
- `/api/v1/users/info/address/{address}`
- `/api/v1/users/info/metaid/{metaId}` (note: spec uses `metaId` not `metaid`)
- `/content/{pinId}`

- [ ] Import `fetchFromLocalOrFallback` from `./localIndexerProxy`
- [ ] In `fetchMetaidInfo(url)`, replace `fetch(url)` with proxy call:
  ```typescript
  // url is already the full file.metaid.io URL; derive local equivalent
  const localUrl = url
    .replace('https://file.metaid.io/metafile-indexer/api/v1/info/address', 'http://localhost:7281/api/v1/users/info/address')
    .replace('https://file.metaid.io/metafile-indexer/api/v1/info/metaid', 'http://localhost:7281/api/v1/users/info/metaid');
  const res = await fetchFromLocalOrFallback(localUrl, url);
  ```
- [ ] In `fetchAvatarDataUrl(pinId)`, replace `fetch(url)` with:
  ```typescript
  const localUrl = `http://localhost:7281/content/${encodeURIComponent(trimmed)}`;
  const res = await fetchFromLocalOrFallback(localUrl, url);
  ```
- [ ] Verify `npm run lint` passes
- [ ] Commit: `refactor: route metabotRestoreService calls through local p2p proxy`

---

## Task 8: New IPC channels — main + preload

**Files:** `src/main/main.ts` (modify), `src/main/preload.ts` (modify)

New IPC handlers to add in `main.ts`:

- [ ] `p2p:getStatus` → calls `p2pIndexerService.getP2PStatus()`, returns `P2PStatus`
- [ ] `p2p:getConfig` → calls `p2pConfigService.getConfig(getStore())`
- [ ] `p2p:setConfig` → calls `p2pConfigService.setConfig(getStore(), config)`, then `p2pConfigService.reloadConfig()`; returns updated config
- [ ] `p2p:getPeers` → `GET http://localhost:7281/api/p2p/peers`, returns parsed JSON or `[]` on error
- [ ] `metaid:getUserInfo` → accepts `{ globalMetaId: string }`, proxies to `http://localhost:7281/api/v1/users/info/metaid/{id}` with fallback to `https://file.metaid.io/metafile-indexer/api/v1/info/metaid/{id}`; returns `MetaidInfoResult`

Add `window.electron.p2p` namespace in `preload.ts`:

```typescript
p2p: {
  getStatus: () => ipcRenderer.invoke('p2p:getStatus'),
  getConfig: () => ipcRenderer.invoke('p2p:getConfig'),
  setConfig: (config: any) => ipcRenderer.invoke('p2p:setConfig', config),
  getPeers: () => ipcRenderer.invoke('p2p:getPeers'),
  getUserInfo: (params: { globalMetaId: string }) =>
    ipcRenderer.invoke('metaid:getUserInfo', params),
  onStatusUpdate: (callback: (status: any) => void) => {
    const handler = (_event: any, status: any) => callback(status);
    ipcRenderer.on('p2p:statusUpdate', handler);
    return () => ipcRenderer.removeListener('p2p:statusUpdate', handler);
  },
  onSyncProgress: (callback: (data: any) => void) => {
    const handler = (_event: any, data: any) => callback(data);
    ipcRenderer.on('p2p:syncProgress', handler);
    return () => ipcRenderer.removeListener('p2p:syncProgress', handler);
  },
},
```

- [ ] Add the 5 `ipcMain.handle` registrations in `main.ts`
- [ ] Add `p2p` namespace to `preload.ts` `contextBridge.exposeInMainWorld` call
- [ ] Verify TypeScript compiles: `npm run compile:electron`
- [ ] Commit: `feat: add p2p IPC channels in main and preload`

---

## Task 9: Replace renderer metabotInfoService.ts

**File:** `src/renderer/services/metabotInfoService.ts` (modify)

Currently calls `fetch('https://file.metaid.io/metafile-indexer/api/v1/info/metaid/{id}')` directly from the renderer. Renderer cannot reach localhost:7281 (context isolation), so this must go through IPC.

- [ ] Replace the `fetch(url)` call in `fetchMetaidInfoByGlobalId` with:
  ```typescript
  const result = await window.electron.p2p.getUserInfo({ globalMetaId: id });
  return result as MetaidInfoResult;
  ```
- [ ] Remove the now-unused `METAFILE_INFO_BASE` and `METAFILE_CONTENT_BASE` constants (or keep `METAFILE_CONTENT_BASE` if still used for avatar URL construction in `resolveAvatarUrl`)
- [ ] Check if `resolveAvatarUrl` still needs `METAFILE_CONTENT_BASE` for constructing thumbnail URLs — if the IPC response already returns a resolved `avatarUrl`, simplify accordingly
- [ ] Verify `npm run lint` passes
- [ ] Commit: `refactor: route renderer metabotInfoService through p2p IPC`

---

## Task 10: electron-builder.json extraResources

**File:** `electron-builder.json` (modify)

Current `extraResources` has SKILLs, tray, and mingit entries. Add man-p2p binaries for all 4 platforms.

- [ ] Add a new entry to `extraResources` for each binary:
  ```json
  {
    "from": "resources/man-p2p/man-p2p-darwin-arm64",
    "to": "man-p2p-darwin-arm64"
  },
  {
    "from": "resources/man-p2p/man-p2p-darwin-x64",
    "to": "man-p2p-darwin-x64"
  },
  {
    "from": "resources/man-p2p/man-p2p-win32-x64.exe",
    "to": "man-p2p-win32-x64.exe"
  },
  {
    "from": "resources/man-p2p/man-p2p-linux-x64",
    "to": "man-p2p-linux-x64"
  }
  ```
  Note: use `filter: ["**/*"]` is not needed for single files; the `from`/`to` pair is sufficient.
- [ ] Add macOS entitlements to `build/entitlements.mac.plist` — the file already exists (referenced in `electron-builder.json`); add these two keys if not present:
  ```xml
  <key>com.apple.security.cs.allow-jit</key>
  <true/>
  <key>com.apple.security.cs.disable-library-validation</key>
  <true/>
  ```
- [ ] Create placeholder directory `resources/man-p2p/.gitkeep` so the path exists in the repo (actual binaries will be added by CI)
- [ ] Commit: `chore: add man-p2p binary extraResources config and macOS entitlements`

---

## Task 11: Wire up p2pIndexerService in main.ts startup

**File:** `src/main/main.ts` (modify)

- [ ] Import `p2pIndexerService` from `./services/p2pIndexerService`
- [ ] Import `p2pConfigService` from `./services/p2pConfigService`
- [ ] In the `app.whenReady()` block (after `getStore()` is initialized), add:
  ```typescript
  // Start man-p2p local indexer
  try {
    const store = getStore();
    const config = p2pConfigService.getConfig(store);
    const dataDir = path.join(app.getPath('userData'), 'man-p2p');
    const configPath = path.join(app.getPath('userData'), 'man-p2p-config.json');
    p2pConfigService.writeConfigFile(config, configPath);
    await p2pIndexerService.start(dataDir, configPath);
    console.log('[p2p] man-p2p started');
  } catch (err) {
    console.warn('[p2p] man-p2p failed to start, continuing without local indexer:', err);
    // Non-fatal: app continues using centralized API fallback
  }
  ```
- [ ] Ensure `app.on('before-quit')` handler (registered inside `p2pIndexerService.start`) fires before the existing quit logic
- [ ] Verify `npm run compile:electron` succeeds
- [ ] Commit: `feat: start man-p2p subprocess on app ready with graceful failure`

---

## Task 12: P2P status UI

**File:** `src/renderer/components/p2p/P2PStatusBadge.tsx` (new)

- [ ] Create `src/renderer/components/p2p/P2PStatusBadge.tsx`
- [ ] Component polls `window.electron.p2p.getStatus()` every 30s via `useEffect` + `setInterval`
- [ ] Also subscribes to `window.electron.p2p.onStatusUpdate` for push updates
- [ ] Display logic:
  - If `!running`: grey dot + "P2P offline"
  - If `running && peerCount === 0`: yellow dot + "Connecting..."
  - If `running && peerCount > 0`: green dot + `{peerCount} peers`
  - If `storageLimitReached`: orange warning icon + "Storage full"
  - `dataSource` shown as small badge: "P2P" / "Cache" / "API"
- [ ] Use Tailwind utility classes; no bespoke CSS
- [ ] Props: `className?: string`
- [ ] Export as default
- [ ] Commit: `feat: add P2PStatusBadge component with 30s polling`

---

## Task 13: P2P config UI

**File:** `src/renderer/components/p2p/P2PConfigPanel.tsx` (new)

- [ ] Create `src/renderer/components/p2p/P2PConfigPanel.tsx`
- [ ] On mount, call `window.electron.p2p.getConfig()` and populate local state
- [ ] UI sections:
  - **Sync mode**: radio group — Self / Selective / Full (with descriptions from spec table)
  - **Selective addresses**: textarea (one address per line), shown only when mode = `selective`
  - **Selective paths**: textarea (one path per line), shown only when mode = `selective`
  - **Block addresses**: textarea (one per line)
  - **Block paths**: textarea (one per line)
  - **Max content size (KB)**: number input, default 512
  - **Bootstrap nodes**: textarea (one multiaddr per line)
  - **Enable relay**: checkbox
  - **Storage limit (GB)**: number input, default 10
- [ ] Save button: calls `window.electron.p2p.setConfig(config)`, shows success/error toast using existing app toast pattern
- [ ] Use Tailwind utility classes; match existing settings panel style (see `src/renderer/components/mcp/` for reference)
- [ ] Export as default
- [ ] Commit: `feat: add P2PConfigPanel settings UI`
