# IDBots P2P Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate man-p2p Go binary into IDBots as a managed subprocess, replace all manapi.metaid.io/file.metaid.io/man.metaid.io calls with local localhost:7281 (with centralized API fallback), and add P2P status UI.

**Architecture:** New p2pIndexerService.ts manages the Go subprocess lifecycle. All external MetaID API calls are routed through a local proxy layer that tries localhost:7281 first, falls back to original URLs. New IPC channels expose P2P status and config to the renderer.

**Tech Stack:** TypeScript, Electron (main + renderer + preload), React, Redux Toolkit, Tailwind CSS

**Important Notes:**
- MAN API routes use `/api/` prefix: e.g., `/api/pin/:numberOrId`, `/api/pin/path/list`
- Local URLs must include this prefix: `http://localhost:7281/api/pin/{pinId}`
- Alias routes for user-info: `/api/v1/users/info/metaid/:metaId`, `/api/v1/users/info/address/:address`
- Content endpoint has NO `/api/` prefix: `GET /content/{pinId}`
- Response envelope: `{ code: 1, message: "ok", data: {...} }` — success code is `1`
- `P2P_LOCAL_PORT` constant should be defined once and reused everywhere

---

## Task 1: p2pIndexerService.ts — subprocess lifecycle management

**File:** `src/main/services/p2pIndexerService.ts` (new)

- [ ] Create `src/main/services/p2pIndexerService.ts`
- [ ] Define `P2P_LOCAL_PORT = 7281` and `P2P_LOCAL_BASE = 'http://localhost:7281'` as exported constants
- [ ] Implement `start(dataDir: string, configPath: string): Promise<void>` — resolves binary path from `process.resourcesPath`, spawns man-p2p with `--data-dir` and `--p2p-config` args, pipes stderr/stdout to console
- [ ] Implement `stop(): Promise<void>` — sends SIGTERM, waits up to 5s, then SIGKILL
- [ ] Implement `healthCheck(): Promise<boolean>` — `GET http://localhost:7281/health`, 2s timeout, returns true on 200
- [ ] Implement crash-restart loop: exponential backoff (1s, 2s, 4s, 8s, 16s), max 5 retries; after max retries emit `p2p:statusUpdate` with `{ running: false, error: 'max retries exceeded' }` to all renderer windows
- [ ] Implement status polling: every 30s, `GET http://localhost:7281/api/p2p/status`, emit `p2p:statusUpdate` event to all renderer windows with the response data
- [ ] Register `app.on('before-quit')` handler that calls `stop()` before quit proceeds
- [ ] Export `getP2PStatus(): P2PStatus` returning current running state + last polled status

Binary path resolution (matches existing `createPinWorker` pattern):

```typescript
import { P2P_LOCAL_PORT } from './p2pIndexerService';

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
  - Export `P2PConfig` interface:
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
  - Export `writeConfigFile(config: P2PConfig, configPath: string): void` — writes JSON to file for man-p2p `--p2p-config` arg
  - Export `reloadConfig(): Promise<boolean>` — `POST http://localhost:7281/api/config/reload`, 3s timeout, returns success/failure (does not throw)
- [ ] Commit: `feat: add p2pConfigService and SQLite p2p_config storage`

---

## Task 3: Local API proxy layer

**File:** `src/main/services/localIndexerProxy.ts` (new)

- [ ] Create `src/main/services/localIndexerProxy.ts`
- [ ] Import `P2P_LOCAL_BASE` from `./p2pIndexerService`
- [ ] Export `fetchFromLocalOrFallback(localPath: string, fallbackUrl: string, options?: RequestInit): Promise<Response>`:
  - Construct local URL: `${P2P_LOCAL_BASE}${localPath}`
  - Attempt `fetch(localUrl, { ...options, signal: AbortSignal.timeout(2000) })` (2s timeout, not 500ms — avoids unnecessary fallbacks under load)
  - On success (any 2xx): return the response
  - On non-2xx, timeout, or network error: fall through to `fetch(fallbackUrl, options)`
  - Log which path was taken: `[p2p-proxy] local hit` / `[p2p-proxy] fallback: <reason>`
- [ ] Export `fetchContentWithFallback(pinId: string, fallbackUrl: string): Promise<Response>`:
  - Special handler for content requests — if local returns 200 but body is empty (content_fetched=false PIN), fall through to fallback URL
  - `GET ${P2P_LOCAL_BASE}/content/${pinId}` with 2s timeout
  - If response body is empty or content-length is 0: fetch from fallbackUrl instead
  - This handles the case where man-p2p has PIN metadata but not content bytes (oversized PIN)
- [ ] Write test `tests/localIndexerProxy.test.mjs`:
  - Local returns 200 → proxy returns local response (fallback never called)
  - Local returns 500 → proxy calls fallback
  - Local times out → proxy calls fallback
- [ ] Commit: `feat: add localIndexerProxy with 2s local timeout, content fallback for oversized PINs`

---

## Task 4: Replace metaidCore.ts manapi calls

**File:** `src/main/services/metaidCore.ts` (modify)

Context: `getPinData()` at line 709 fetches `${MANAPI_BASE}/pin/${encodeURIComponent(pinId)}` when not in SQLite cache.

- [ ] Import `fetchFromLocalOrFallback` from `./localIndexerProxy`
- [ ] In `getPinData()`, replace the direct `fetch(url)` call with:
  ```typescript
  const localPath = `/api/pin/${encodeURIComponent(pinId)}`;
  const fallbackUrl = `${MANAPI_BASE}/pin/${encodeURIComponent(pinId)}`;
  const res = await fetchFromLocalOrFallback(localPath, fallbackUrl);
  ```
  Note: local path includes `/api/` prefix to match MAN's route group.
- [ ] Keep all existing SQLite L1 cache logic and persist-on-miss behavior unchanged
- [ ] Verify `npm run lint` passes
- [ ] Commit: `refactor: route metaidCore getPinData through local p2p proxy`

---

## Task 5: Replace main.ts manapi calls (4 sites for /pin/path/list)

**File:** `src/main/main.ts` (modify)

The 4 call sites at lines 485, 627, 674, 3056 all construct `new URL('https://manapi.metaid.io/pin/path/list')` and call `fetch(url.toString())`.

- [ ] Import `fetchFromLocalOrFallback` at the top of `main.ts`
- [ ] For each of the 4 call sites, replace `fetch(url.toString())` with:
  ```typescript
  // The URL object contains query params like ?metaid=...&path=...&page=...
  // Extract the path + query string for local request
  const parsedUrl = new URL(url.toString());
  const localPath = `/api/pin/path/list${parsedUrl.search}`;
  const response = await fetchFromLocalOrFallback(localPath, url.toString());
  ```
  Note: `/api/pin/path/list` — includes `/api/` prefix.
- [ ] Ensure error handling around each call site is unchanged
- [ ] Verify `npm run lint` passes
- [ ] Commit: `refactor: route main.ts pin/path/list calls through local p2p proxy`

---

## Task 6: Replace skillSyncService.ts calls

**File:** `src/main/services/skillSyncService.ts` (modify)

Two call sites:
- Line 138: `/address/pin/list/{address}?...` (manapi.metaid.io)
- Line 243: `/content/{pinId}` (man.metaid.io)

- [ ] Import `fetchFromLocalOrFallback`, `fetchContentWithFallback` from `./localIndexerProxy`
- [ ] Line 138 (`getOfficialSkillsStatus`): replace with:
  ```typescript
  const localPath = `/api/address/pin/list/${OFFICIAL_ADDRESS}?cursor=0&size=200&path=/protocols/metabot-skill`;
  const response = await fetchFromLocalOrFallback(localPath, url);
  ```
  Note: `/api/address/pin/list/` — includes `/api/` prefix.
- [ ] Line 243 (`installOfficialSkill`): replace with:
  ```typescript
  const response = await fetchContentWithFallback(pinId, url);
  ```
  Note: `/content/{pinId}` has NO `/api/` prefix (this is a content serving route, not a JSON API route).
- [ ] Verify `npm run lint` passes
- [ ] Commit: `refactor: route skillSyncService calls through local p2p proxy`

---

## Task 7: Replace metabotRestoreService.ts calls

**File:** `src/main/services/metabotRestoreService.ts` (modify)

Three call sites:
- `fetchMetaidInfoByAddress`: `file.metaid.io/metafile-indexer/api/v1/info/address/{address}`
- `fetchMetaidInfoByMetaid`: `file.metaid.io/metafile-indexer/api/v1/info/metaid/{metaid}`
- `fetchAvatarDataUrl`: `file.metaid.io/metafile-indexer/content/{pinId}`

The local man-p2p alias endpoints:
- `/api/v1/users/info/address/{address}`
- `/api/v1/users/info/metaid/{metaId}`
- `/content/{pinId}`

- [ ] Import `fetchFromLocalOrFallback`, `fetchContentWithFallback` from `./localIndexerProxy`
- [ ] In `fetchMetaidInfoByAddress(address)`:
  ```typescript
  const localPath = `/api/v1/users/info/address/${encodeURIComponent(address)}`;
  const res = await fetchFromLocalOrFallback(localPath, originalUrl);
  ```
- [ ] In `fetchMetaidInfoByMetaid(metaid)`:
  ```typescript
  const localPath = `/api/v1/users/info/metaid/${encodeURIComponent(metaid)}`;
  const res = await fetchFromLocalOrFallback(localPath, originalUrl);
  ```
- [ ] In `fetchAvatarDataUrl(pinId)`:
  ```typescript
  const res = await fetchContentWithFallback(trimmedPinId, originalUrl);
  ```
- [ ] Verify `npm run lint` passes
- [ ] Commit: `refactor: route metabotRestoreService calls through local p2p proxy`

---

## Task 8: New IPC channels — main + preload

**Files:** `src/main/main.ts` (modify), `src/main/preload.ts` (modify)

- [ ] Add 5 `ipcMain.handle` registrations in `main.ts`:
  ```typescript
  ipcMain.handle('p2p:getStatus', () => p2pIndexerService.getP2PStatus());
  ipcMain.handle('p2p:getConfig', () => p2pConfigService.getConfig(getStore()));
  ipcMain.handle('p2p:setConfig', async (_e, config) => {
    const updated = p2pConfigService.setConfig(getStore(), config);
    p2pConfigService.writeConfigFile(updated, configPath);
    await p2pConfigService.reloadConfig();
    return updated;
  });
  ipcMain.handle('p2p:getPeers', async () => {
    try {
      const res = await fetch(`${P2P_LOCAL_BASE}/api/p2p/peers`, { signal: AbortSignal.timeout(2000) });
      return await res.json();
    } catch { return []; }
  });
  ipcMain.handle('metaid:getUserInfo', async (_e, params: { globalMetaId: string }) => {
    const localPath = `/api/v1/users/info/metaid/${encodeURIComponent(params.globalMetaId)}`;
    const fallbackUrl = `https://file.metaid.io/metafile-indexer/api/v1/info/metaid/${encodeURIComponent(params.globalMetaId)}`;
    const res = await fetchFromLocalOrFallback(localPath, fallbackUrl);
    return await res.json();
  });
  ```
- [ ] Add `p2p` namespace to `preload.ts` `contextBridge.exposeInMainWorld` call:
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
- [ ] Verify TypeScript compiles: `npm run compile:electron`
- [ ] Commit: `feat: add p2p IPC channels in main and preload`

---

## Task 9: Replace renderer metabotInfoService.ts

**File:** `src/renderer/services/metabotInfoService.ts` (modify)

Currently calls `fetch('https://file.metaid.io/...')` directly from renderer. Must go through IPC since renderer cannot reach localhost:7281 (context isolation).

- [ ] Replace the `fetch(url)` call in `fetchMetaidInfoByGlobalId` with:
  ```typescript
  const result = await window.electron.p2p.getUserInfo({ globalMetaId: id });
  return result as MetaidInfoResult;
  ```
- [ ] Remove unused constants that pointed to `file.metaid.io` info endpoints
- [ ] Keep `METAFILE_CONTENT_BASE` if still used for avatar URL construction in `resolveAvatarUrl`
- [ ] Verify `npm run lint` passes
- [ ] Commit: `refactor: route renderer metabotInfoService through p2p IPC`

---

## Task 10: electron-builder extraResources (platform-specific)

**File:** `electron-builder.json` (modify)

- [ ] Add platform-specific binary entries to `electron-builder.json`:
  ```json
  "mac": {
    "extraResources": [
      {
        "from": "resources/man-p2p/man-p2p-darwin-${arch}",
        "to": "man-p2p-darwin-${arch}"
      }
    ]
  },
  "win": {
    "extraResources": [
      {
        "from": "resources/man-p2p/man-p2p-win32-x64.exe",
        "to": "man-p2p-win32-x64.exe"
      }
    ]
  },
  "linux": {
    "extraResources": [
      {
        "from": "resources/man-p2p/man-p2p-linux-x64",
        "to": "man-p2p-linux-x64"
      }
    ]
  }
  ```
  This ensures each platform's installer only includes its own binary, not all 4.
- [ ] Check `build/entitlements.mac.plist` — add if not already present:
  ```xml
  <key>com.apple.security.cs.allow-jit</key>
  <true/>
  <key>com.apple.security.cs.disable-library-validation</key>
  <true/>
  ```
  `allow-jit` may already exist — only add `disable-library-validation` if missing.
- [ ] Create placeholder `resources/man-p2p/.gitkeep` so the path exists in repo
- [ ] Commit: `chore: add platform-specific man-p2p extraResources config and macOS entitlements`

---

## Task 11: Wire up p2pIndexerService in main.ts startup

**File:** `src/main/main.ts` (modify)

- [ ] Import `p2pIndexerService`, `P2P_LOCAL_BASE` from `./services/p2pIndexerService`
- [ ] Import `p2pConfigService` from `./services/p2pConfigService`
- [ ] In the `app.whenReady()` block (after `getStore()` is initialized), add:
  ```typescript
  // Start man-p2p local indexer
  try {
    const store = getStore();
    const config = p2pConfigService.getConfig(store);
    const dataDir = path.join(app.getPath('userData'), 'man-p2p');
    const configPath = path.join(app.getPath('userData'), 'man-p2p-config.json');
    fs.mkdirSync(dataDir, { recursive: true });
    p2pConfigService.writeConfigFile(config, configPath);
    await p2pIndexerService.start(dataDir, configPath);
    console.log('[p2p] man-p2p started');
  } catch (err) {
    console.warn('[p2p] man-p2p failed to start, continuing without local indexer:', err);
    // Non-fatal: app continues using centralized API fallback
  }
  ```
- [ ] Ensure `app.on('before-quit')` handler (registered inside `p2pIndexerService.start`) fires before quit
- [ ] Verify `npm run compile:electron` succeeds
- [ ] Commit: `feat: start man-p2p subprocess on app ready with graceful failure`

---

## Task 12: P2P status UI

**File:** `src/renderer/components/p2p/P2PStatusBadge.tsx` (new)

- [ ] Create `src/renderer/components/p2p/P2PStatusBadge.tsx`
- [ ] Component subscribes to `window.electron.p2p.onStatusUpdate` for push updates AND polls `window.electron.p2p.getStatus()` every 30s as fallback
- [ ] Clean up listeners in `useEffect` cleanup:
  ```typescript
  useEffect(() => {
    const unsubscribe = window.electron.p2p.onStatusUpdate(setStatus);
    const interval = setInterval(async () => {
      const s = await window.electron.p2p.getStatus();
      setStatus(s);
    }, 30_000);
    return () => {
      unsubscribe();
      clearInterval(interval);
    };
  }, []);
  ```
- [ ] Display logic:
  - `!running`: grey dot + "P2P offline"
  - `running && peerCount === 0`: yellow dot + "Connecting..."
  - `running && peerCount > 0`: green dot + `{peerCount} peers`
  - `storageLimitReached`: orange warning icon + "Storage full"
  - `dataSource` shown as small badge: "P2P" / "Cache" / "API"
- [ ] Tailwind utility classes, no bespoke CSS
- [ ] Commit: `feat: add P2PStatusBadge component with push + polling`

---

## Task 13: P2P config UI

**File:** `src/renderer/components/p2p/P2PConfigPanel.tsx` (new)

- [ ] Create `src/renderer/components/p2p/P2PConfigPanel.tsx`
- [ ] On mount, call `window.electron.p2p.getConfig()` and populate local state
- [ ] UI sections:
  - **Sync mode**: radio group — Self / Selective / Full (with descriptions)
  - **Selective addresses**: textarea (one per line), shown only when mode = `selective`
  - **Selective paths**: textarea (one per line), shown only when mode = `selective`
  - **Block addresses**: textarea (one per line)
  - **Block paths**: textarea (one per line)
  - **Max content size (KB)**: number input, default 512
  - **Bootstrap nodes**: textarea (one multiaddr per line)
  - **Enable relay**: checkbox
  - **Storage limit (GB)**: number input, default 10
- [ ] Save button: calls `window.electron.p2p.setConfig(config)`, shows success/error toast
- [ ] Tailwind utility classes, match existing settings panel style (see `src/renderer/components/mcp/`)
- [ ] Commit: `feat: add P2PConfigPanel settings UI`
