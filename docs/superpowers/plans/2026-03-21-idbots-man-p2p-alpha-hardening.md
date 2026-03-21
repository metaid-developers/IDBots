# IDBots man-p2p Alpha Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden the IDBots-side `man-p2p` integration so local-first reads, P2P status/config handling, and centralized fallback all match the approved Alpha contract.

**Architecture:** Keep the existing Electron subprocess model and local proxy layer, but tighten the contract at the edges: local JSON fetches must treat only `HTTP 2xx + code=1` as a hit, content fetches must treat `metadata-only` as a miss for body bytes, P2P status must unwrap MAN envelopes and surface runtime truth, and runtime config files must include Alpha-critical fields such as `p2p_enable_chain_source` and `p2p_own_addresses`.

**Tech Stack:** TypeScript, Electron main/preload/renderer, React, Node `node:test`, ESLint

---

### Task 1: Harden local-first proxy semantics to the Alpha contract

**Files:**
- Modify: `src/main/services/localIndexerProxy.ts`
- Modify: `tests/localIndexerProxy.test.mjs`

- [ ] **Step 1: Write a failing test for local JSON `code != 1` fallback**

Add a test proving `fetchFromLocalOrFallback('/api/pin/abc', ...)` falls back when the local node returns `HTTP 200` but JSON envelope `{"code":0}`.

- [ ] **Step 2: Run the targeted proxy test to verify it fails**

Run: `npm run compile:electron && node --test tests/localIndexerProxy.test.mjs`
Expected: FAIL because the current implementation treats any local `2xx` as a hit.

- [ ] **Step 3: Write a failing test for metadata-only content fallback**

Add a test proving `fetchContentWithFallback()` falls back when the local node returns:

```http
HTTP/1.1 200 OK
X-Man-Content-Status: metadata-only
Content-Length: 0
```

- [ ] **Step 4: Run the targeted proxy test to verify it fails**

Run: `npm run compile:electron && node --test tests/localIndexerProxy.test.mjs`
Expected: FAIL because the current implementation does not inspect `X-Man-Content-Status`.

- [ ] **Step 5: Write a failing test for real local content with missing `content-length`**

Add a test proving `fetchContentWithFallback()` keeps the local response when:

```http
HTTP/1.1 200 OK
Content-Type: text/plain
```

and the cloned body bytes are non-empty even though `content-length` is absent.

- [ ] **Step 6: Run the targeted proxy test to verify it fails**

Run: `npm run compile:electron && node --test tests/localIndexerProxy.test.mjs`
Expected: FAIL because the current implementation falls back whenever `content-length` is missing.

- [ ] **Step 7: Implement the minimal proxy changes**

Update `src/main/services/localIndexerProxy.ts` to:

```ts
function isJsonApiPath(localPath: string): boolean {
  return localPath.startsWith('/api/');
}

async function isSuccessfulEnvelope(localRes: Response): Promise<boolean> {
  const cloned = localRes.clone();
  const json = await cloned.json() as { code?: unknown };
  return json?.code === 1;
}
```

and enforce:

- JSON local hit only when `HTTP 2xx` and envelope `code === 1`
- Content local hit only when `HTTP 200`, not `metadata-only`, and cloned body has bytes
- fallback on timeout, transport error, non-2xx, envelope miss, or metadata-only

- [ ] **Step 8: Re-run the proxy tests**

Run: `npm run compile:electron && node --test tests/localIndexerProxy.test.mjs`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add src/main/services/localIndexerProxy.ts tests/localIndexerProxy.test.mjs
git commit -m "fix: harden IDBots local-first proxy contract"
```

### Task 2: Normalize P2P status and peers handling around MAN envelopes

**Files:**
- Modify: `src/main/services/p2pIndexerService.ts`
- Modify: `src/main/main.ts`
- Modify: `src/renderer/components/p2p/P2PStatusBadge.tsx`
- Modify: `src/renderer/types/electron.d.ts`
- Modify: `tests/p2pIndexerService.test.mjs`

- [ ] **Step 1: Write a failing test for status envelope unwrapping**

Add a unit test around an exported helper from `src/main/services/p2pIndexerService.ts` that proves this payload:

```json
{
  "code": 1,
  "message": "ok",
  "data": {
    "peerCount": 2,
    "storageLimitReached": false,
    "storageUsedBytes": 1024,
    "syncMode": "self",
    "runtimeMode": "p2p-only",
    "peerId": "peer-123",
    "listenAddrs": ["/ip4/127.0.0.1/tcp/4001"]
  }
}
```

is normalized into the cached renderer-facing status shape.

- [ ] **Step 2: Run the targeted status test to verify it fails**

Run: `npm run compile:electron && node --test tests/p2pIndexerService.test.mjs`
Expected: FAIL because the current implementation looks for `peerCount` on the top-level response body.

- [ ] **Step 3: Write a failing test for peers envelope unwrapping**

Add a test for an exported helper proving:

```json
{ "code": 1, "message": "ok", "data": ["peer-a", "peer-b"] }
```

becomes `['peer-a', 'peer-b']`.

- [ ] **Step 4: Run the targeted status test to verify it fails**

Run: `npm run compile:electron && node --test tests/p2pIndexerService.test.mjs`
Expected: FAIL because peers are not currently unwrapped from the MAN envelope.

- [ ] **Step 5: Implement the minimal status/peer normalization**

In `src/main/services/p2pIndexerService.ts`, add helpers like:

```ts
export function unwrapApiData(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object') return undefined;
  return (payload as { data?: unknown }).data;
}

export function normalizeStatusPayload(payload: unknown): P2PStatus {
  const data = unwrapApiData(payload) as Record<string, unknown> | undefined;
  return {
    running: true,
    peerCount: typeof data?.peerCount === 'number' ? data.peerCount : undefined,
    storageLimitReached: typeof data?.storageLimitReached === 'boolean' ? data.storageLimitReached : undefined,
    storageUsedBytes: typeof data?.storageUsedBytes === 'number' ? data.storageUsedBytes : undefined,
    dataSource: typeof data?.dataSource === 'string' ? data.dataSource : undefined,
    syncMode: typeof data?.syncMode === 'string' ? data.syncMode : undefined,
    runtimeMode: typeof data?.runtimeMode === 'string' ? data.runtimeMode : undefined,
    peerId: typeof data?.peerId === 'string' ? data.peerId : undefined,
    listenAddrs: Array.isArray(data?.listenAddrs) ? data.listenAddrs.filter((item): item is string => typeof item === 'string') : undefined,
  };
}
```

Then:

- use `normalizeStatusPayload()` inside the status polling loop
- emit `{ running: true }` immediately after a successful subprocess start
- unwrap peers in `ipcMain.handle('p2p:getPeers', ...)` in `src/main/main.ts`

- [ ] **Step 6: Update the badge and types**

Extend the renderer-facing type with:

- `syncMode`
- `runtimeMode`
- `peerId`
- `listenAddrs`

and update `P2PStatusBadge.tsx` so it shows:

- offline/error
- connecting
- online with peer count
- storage-full warning
- `runtimeMode` badge (`p2p-only` / `chain-enabled`) when available

- [ ] **Step 7: Re-run the targeted P2P service test**

Run: `npm run compile:electron && node --test tests/p2pIndexerService.test.mjs`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/main/services/p2pIndexerService.ts src/main/main.ts src/renderer/components/p2p/P2PStatusBadge.tsx src/renderer/types/electron.d.ts tests/p2pIndexerService.test.mjs
git commit -m "fix: normalize IDBots p2p status and peers envelopes"
```

### Task 3: Align runtime config with Alpha filter primitives

**Files:**
- Modify: `src/main/services/p2pConfigService.ts`
- Modify: `src/main/main.ts`
- Modify: `src/renderer/components/p2p/P2PConfigPanel.tsx`
- Modify: `src/renderer/types/electron.d.ts`
- Create: `tests/p2pConfigService.test.mjs`

- [ ] **Step 1: Write a failing test for new config defaults**

Add a test proving `DEFAULT_P2P_CONFIG` includes:

```ts
{
  p2p_sync_mode: 'self',
  p2p_bootstrap_nodes: [],
  p2p_enable_relay: true,
  p2p_storage_limit_gb: 10,
  p2p_enable_chain_source: false,
  p2p_own_addresses: [],
}
```

- [ ] **Step 2: Run the targeted config test to verify it fails**

Run: `npm run compile:electron && node --test tests/p2pConfigService.test.mjs`
Expected: FAIL because the current config model does not expose `p2p_enable_chain_source` or `p2p_own_addresses`.

- [ ] **Step 3: Write a failing test for derived own-address injection**

Add a test for an exported helper proving a list of MetaBots such as:

```ts
[
  { mvc_address: 'mvc1', btc_address: 'btc1', doge_address: 'doge1' },
  { mvc_address: 'mvc1', btc_address: 'btc2', doge_address: '' },
]
```

is converted into:

```ts
['mvc1', 'btc1', 'doge1', 'btc2']
```

with empty values removed and duplicates deduped.

- [ ] **Step 4: Run the targeted config test to verify it fails**

Run: `npm run compile:electron && node --test tests/p2pConfigService.test.mjs`
Expected: FAIL because runtime config currently never injects `p2p_own_addresses`.

- [ ] **Step 5: Implement the minimal config/runtime helpers**

Extend `src/main/services/p2pConfigService.ts` with:

```ts
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
  p2p_enable_chain_source: boolean;
  p2p_own_addresses: string[];
}
```

and add helpers like:

```ts
export function collectOwnAddresses(metabots: Array<{ mvc_address?: string; btc_address?: string; doge_address?: string }>): string[] { ... }

export function buildRuntimeConfig(config: P2PConfig, ownAddresses: string[]): P2PConfig {
  return {
    ...config,
    p2p_own_addresses: Array.from(new Set([...(config.p2p_own_addresses || []), ...ownAddresses])),
  };
}
```

- [ ] **Step 6: Wire runtime config writing through the helper**

In `src/main/main.ts`, before startup and before `p2p:setConfig` reload:

- call `getMetabotStore().listMetabots()`
- derive addresses with `collectOwnAddresses(...)`
- write `buildRuntimeConfig(...)` to `man-p2p-config.json`

This makes `self` mode work for ordinary users without manual address entry.

- [ ] **Step 7: Update the settings UI and types**

In `src/renderer/components/p2p/P2PConfigPanel.tsx`:

- add a `Blockchain source` toggle backed by `p2p_enable_chain_source`
- add an `Own addresses` textarea backed by `p2p_own_addresses`
- show explanatory copy:
  - `Self` means only local MetaBot addresses plus optional manual own-address overrides
  - `Selective` means path/address filters
  - `Full` means no allowlist restriction

- [ ] **Step 8: Re-run the targeted config test**

Run: `npm run compile:electron && node --test tests/p2pConfigService.test.mjs`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add src/main/services/p2pConfigService.ts src/main/main.ts src/renderer/components/p2p/P2PConfigPanel.tsx src/renderer/types/electron.d.ts tests/p2pConfigService.test.mjs
git commit -m "feat: align IDBots p2p config with alpha filters"
```

### Task 4: Verify local-first contract at the main-process integration points

**Files:**
- Modify: `src/main/main.ts` if needed
- Modify: `src/main/services/metaidCore.ts` if needed
- Modify: `src/main/services/metabotRestoreService.ts` if needed
- Modify: `src/main/services/skillSyncService.ts` if needed

- [ ] **Step 1: Audit the existing local-first call sites after Tasks 1-3**

Confirm each of the following paths now inherits the corrected proxy behavior without further special casing:

- `src/main/services/metaidCore.ts`
- `src/main/services/metabotRestoreService.ts`
- `src/main/services/skillSyncService.ts`
- `/api/pin/path/list` callers in `src/main/main.ts`
- `metaid:getUserInfo` IPC in `src/main/main.ts`

- [ ] **Step 2: Apply only the minimal follow-up code changes**

If any call site still bypasses the corrected proxy contract or expects unwrapped local data incorrectly, fix it in place without broad refactoring.

- [ ] **Step 3: Run compile + targeted tests**

Run:

```bash
npm run compile:electron
node --test tests/localIndexerProxy.test.mjs tests/p2pIndexerService.test.mjs tests/p2pConfigService.test.mjs
```

Expected: PASS

- [ ] **Step 4: Run lint**

Run: `npm run lint`
Expected: PASS, or only pre-existing failures unrelated to this slice

- [ ] **Step 5: Commit**

```bash
git add src/main/main.ts src/main/services/metaidCore.ts src/main/services/metabotRestoreService.ts src/main/services/skillSyncService.ts
git commit -m "refactor: tighten IDBots man-p2p alpha integration points"
```

### Task 5: Clean inherited workspace noise and leave the repo in a controlled state

**Files:**
- Modify: `.gitignore`
- Delete or retain intentionally: `.tmp-oss/`, `man_base_data_pebble/`, `"\"$PLAN_FILE\""`, `.claude/settings.local.json`

- [ ] **Step 1: Inspect the inherited dirty paths**

Classify the current non-clean items into:

- local-only artifacts that should be ignored and removed
- legitimate config/code changes that should be kept and committed

- [ ] **Step 2: Ignore local-only P2P/data artifacts**

If they are generated-only, add ignore rules such as:

```gitignore
.tmp-oss/
man_base_data_pebble/
```

and remove the local artifacts from the working tree.

- [ ] **Step 3: Remove stray temporary files**

Delete accidental files such as `"\"$PLAN_FILE\""` if they are not part of product behavior.

- [ ] **Step 4: Decide `.claude/settings.local.json` deliberately**

Either:

- restore it to `HEAD` if it is local-only editor noise, or
- keep and commit it only if it is now an intentional project setting

- [ ] **Step 5: Run the final verification set**

Run:

```bash
npm run compile:electron
node --test tests/localIndexerProxy.test.mjs tests/p2pIndexerService.test.mjs tests/p2pConfigService.test.mjs
npm run lint
git status --short
```

Expected:

- targeted tests PASS
- lint PASS, or only documented pre-existing failures
- `git status --short` shows only intentional changes for this slice

- [ ] **Step 6: Commit**

```bash
git add .gitignore
git add -u
git commit -m "chore: clean IDBots alpha integration workspace"
```
