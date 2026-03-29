# Auto Service Discovery & Delegation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable automatic on-chain service discovery and delegation within cowork sessions so Bot A can discover, recommend, and delegate tasks to remote Bot B — with payment, A2A collaboration, and result aggregation — all within a single conversational flow.

**Architecture:** Message-pattern-based delegation (`[DELEGATE_REMOTE_SERVICE]`) integrated into the existing cowork system prompt alongside local skills. Two new main-process services (heartbeatService, heartbeatPollingService) provide on-chain presence signaling and online status tracking. The delegation pipeline reuses existing A2A infrastructure (privateChatDaemon, serviceOrderLifecycleService, privateChatOrderCowork).

**Tech Stack:** Electron 40, React 18, TypeScript, SQLite (sql.js), MetaID createPin API, Metalet wallet APIs

**Spec:** `docs/superpowers/specs/2026-03-30-auto-service-discovery-design.md`

---

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `src/main/services/heartbeatService.ts` | Per-MetaBot heartbeat timer management, createPin calls for `/protocols/metabot-heartbeat` |
| `src/main/services/heartbeatPollingService.ts` | System-wide polling of service Bot online status via manapi, maintains `onlineBots` Map and `availableServices` array |
| `tests/heartbeatService.test.mjs` | Unit tests for heartbeat timer lifecycle |
| `tests/heartbeatPollingService.test.mjs` | Unit tests for online status determination logic |
| `tests/remoteDelegation.test.mjs` | Unit tests for `[DELEGATE_REMOTE_SERVICE]` pattern parsing and delegation pipeline |

### Modified Files

| File | Changes |
|------|---------|
| `src/main/sqliteStore.ts` | Idempotent migration: add `heartbeat_enabled` column to `metabots` table |
| `src/main/skillManager.ts` | New `buildRemoteServicesPrompt(availableServices)` method |
| `src/main/libs/coworkRunner.ts` | Inject remote services XML in `composeEffectiveSystemPrompt()` (~line 2170); detect `[DELEGATE_REMOTE_SERVICE]` in `finalizeStreamingContent()` (~line 4896) |
| `src/main/coworkStore.ts` | Add delegation pipeline orchestration; add blocking/unblocking state; add result injection method |
| `src/main/services/privateChatDaemon.ts` | On delivery for auto-delegated buyer order: trigger result injection into source cowork session (~line 807) |
| `src/main/main.ts` | Register IPC handlers for heartbeat toggle, online status, and delegation |
| `src/main/preload.ts` | Expose heartbeat and online status IPC to renderer |
| `src/renderer/services/i18n.ts` | Rename: MetaBot→My Bots/我的Bot, Gig Square/服务广场→Bot Hub |
| `src/renderer/components/Sidebar.tsx` | Update sidebar nav labels (~lines 162, 199) |
| `src/renderer/components/metabots/MetaBotListCard.tsx` | Add heartbeat toggle below avatar (~line 199) |
| `src/renderer/components/gigSquare/GigSquareView.tsx` | Add online/offline badges (~line 372); sort online-first |
| `src/renderer/components/cowork/CoworkSessionDetail.tsx` | Blocking/processing state UI; result display with source attribution |

---

## Task 1: UI Naming Changes (i18n + Sidebar)

**Files:**
- Modify: `src/renderer/services/i18n.ts:120-121,611,1136-1137,1627`
- Modify: `src/renderer/components/Sidebar.tsx:162,199`

- [ ] **Step 1: Update Chinese translation keys in i18n.ts**

In `src/renderer/services/i18n.ts`, update the Chinese (zh) section:
- Line ~120: `gigSquare: '服务广场'` → `gigSquare: 'Bot Hub'`
- Line ~121: `gigSquareTitle: '服务广场'` → `gigSquareTitle: 'Bot Hub'`
- Line ~124: Update `gigSquareAlphaNotice` to replace `'服务广场'` with `'Bot Hub'`
- Line ~611: `metabots: 'MetaBot'` → `metabots: '我的Bot'`

- [ ] **Step 2: Update English translation keys in i18n.ts**

In the English (en) section:
- Line ~1136: `gigSquare: 'Gig Square'` → `gigSquare: 'Bot Hub'`
- Line ~1137: `gigSquareTitle: 'Gig Square'` → `gigSquareTitle: 'Bot Hub'`
- Line ~1140: Update `gigSquareAlphaNotice` to replace `'Gig Square'` with `'Bot Hub'`
- Line ~1627: `metabots: 'MetaBot'` → `metabots: 'My Bots'`

- [ ] **Step 3: Verify sidebar labels render correctly**

Run: `npm run electron:dev`
Verify: Sidebar shows "我的Bot" / "My Bots" and "Bot Hub" in both languages.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/services/i18n.ts
git commit -m "feat: rename MetaBot to My Bots and Gig Square to Bot Hub"
```

---

## Task 2: Database Migration — heartbeat_enabled Column

**Files:**
- Modify: `src/main/sqliteStore.ts`
- Test: `tests/heartbeatService.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `tests/heartbeatService.test.mjs`:

```javascript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Test the migration logic in isolation
describe('heartbeat_enabled migration', () => {
  it('adds heartbeat_enabled column to metabots if missing', async () => {
    // Import the compiled SqliteStore
    const { SqliteStore } = await import('../dist-electron/sqliteStore.js');
    const store = new SqliteStore(':memory:');

    // After initialization, the column should exist
    const cols = store.db.exec('PRAGMA table_info(metabots)');
    const columnNames = cols[0]?.values.map(row => row[1]) || [];
    assert.ok(columnNames.includes('heartbeat_enabled'),
      'metabots table should have heartbeat_enabled column');
  });

  it('defaults heartbeat_enabled to 0', async () => {
    const { SqliteStore } = await import('../dist-electron/sqliteStore.js');
    const store = new SqliteStore(':memory:');

    // Insert a minimal metabot row (requires wallet first)
    store.db.run(`INSERT INTO metabot_wallets (mnemonic, path) VALUES ('test mnemonic', "m/44'/10001'/0'/0/0")`);
    store.db.run(`INSERT INTO metabots (wallet_id, mvc_address, btc_address, doge_address, public_key, chat_public_key, name, metaid, globalmetaid, metabot_type, created_by, role, soul, created_at, updated_at) VALUES (1, 'mvc1', 'btc1', 'doge1', 'pk1', 'cpk1', 'test', 'mid1', 'gmid1', 'worker', 'user', 'test role', 'test soul', 0, 0)`);

    const result = store.db.exec('SELECT heartbeat_enabled FROM metabots WHERE name = ?', ['test']);
    assert.equal(result[0]?.values[0]?.[0], 0, 'heartbeat_enabled should default to 0');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run compile:electron && node --test tests/heartbeatService.test.mjs`
Expected: FAIL — `heartbeat_enabled` column does not exist yet.

- [ ] **Step 3: Add migration to sqliteStore.ts**

In `src/main/sqliteStore.ts`, find the migration section (after other `PRAGMA table_info` migration blocks, around line ~870). Add:

```typescript
// --- heartbeat_enabled migration ---
try {
  const mbColsResult = this.db.exec('PRAGMA table_info(metabots)');
  const mbColumns = (mbColsResult[0]?.values?.map((row) => row[1]) || []) as string[];
  if (!mbColumns.includes('heartbeat_enabled')) {
    this.db.run('ALTER TABLE metabots ADD COLUMN heartbeat_enabled INTEGER DEFAULT 0');
    this.save();
  }
} catch (error) {
  console.warn('Failed to migrate heartbeat_enabled column:', error);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run compile:electron && node --test tests/heartbeatService.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/sqliteStore.ts tests/heartbeatService.test.mjs
git commit -m "feat: add heartbeat_enabled column migration to metabots table"
```

---

## Task 3: Heartbeat Sending Service

**Files:**
- Create: `src/main/services/heartbeatService.ts`
- Test: `tests/heartbeatService.test.mjs` (append)

- [ ] **Step 1: Write failing tests for heartbeat service**

Append to `tests/heartbeatService.test.mjs`:

```javascript
describe('HeartbeatService', () => {
  it('startHeartbeat creates a timer for the given metabot', async () => {
    const { HeartbeatService } = await import('../dist-electron/services/heartbeatService.js');

    let pinCalls = [];
    const mockCreatePin = async (store, metabotId, data) => {
      pinCalls.push({ metabotId, path: data.path, contentType: data.contentType });
      return { txids: ['tx1'], pinId: 'pin1', totalCost: 100 };
    };

    const service = new HeartbeatService({ createPin: mockCreatePin });
    service.startHeartbeat(1);

    // Should fire immediately on start
    await new Promise(r => setTimeout(r, 100));
    assert.equal(pinCalls.length, 1, 'should have fired one createPin immediately');
    assert.equal(pinCalls[0].metabotId, 1);
    assert.equal(pinCalls[0].path, '/protocols/metabot-heartbeat');
    assert.equal(pinCalls[0].contentType, 'text/plain');

    service.stopHeartbeat(1);
  });

  it('stopHeartbeat clears the timer', async () => {
    const { HeartbeatService } = await import('../dist-electron/services/heartbeatService.js');

    let pinCalls = 0;
    const mockCreatePin = async () => { pinCalls++; return { txids: [], pinId: '', totalCost: 0 }; };

    const service = new HeartbeatService({ createPin: mockCreatePin });
    service.startHeartbeat(1);
    await new Promise(r => setTimeout(r, 100));

    service.stopHeartbeat(1);
    const countAfterStop = pinCalls;

    await new Promise(r => setTimeout(r, 200));
    assert.equal(pinCalls, countAfterStop, 'no new createPin calls after stop');
  });

  it('stopAll clears all timers', async () => {
    const { HeartbeatService } = await import('../dist-electron/services/heartbeatService.js');

    const mockCreatePin = async () => ({ txids: [], pinId: '', totalCost: 0 });
    const service = new HeartbeatService({ createPin: mockCreatePin });

    service.startHeartbeat(1);
    service.startHeartbeat(2);
    assert.equal(service.activeCount(), 2);

    service.stopAll();
    assert.equal(service.activeCount(), 0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run compile:electron && node --test tests/heartbeatService.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement heartbeatService.ts**

Create `src/main/services/heartbeatService.ts`:

```typescript
import log from 'electron-log';

const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

interface HeartbeatDeps {
  createPin: (store: any, metabotId: number, data: any, options?: any) => Promise<any>;
  getMetabotStore?: () => any;
}

export class HeartbeatService {
  private timers: Map<number, ReturnType<typeof setInterval>> = new Map();
  private deps: HeartbeatDeps;

  constructor(deps: HeartbeatDeps) {
    this.deps = deps;
  }

  startHeartbeat(metabotId: number): void {
    if (this.timers.has(metabotId)) return; // already running

    // Fire immediately, then every HEARTBEAT_INTERVAL_MS
    this.sendHeartbeat(metabotId);

    const timer = setInterval(() => {
      this.sendHeartbeat(metabotId);
    }, HEARTBEAT_INTERVAL_MS);

    this.timers.set(metabotId, timer);
    log.info(`[HeartbeatService] Started heartbeat for metabot ${metabotId}`);
  }

  stopHeartbeat(metabotId: number): void {
    const timer = this.timers.get(metabotId);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(metabotId);
      log.info(`[HeartbeatService] Stopped heartbeat for metabot ${metabotId}`);
    }
  }

  stopAll(): void {
    for (const [id, timer] of this.timers) {
      clearInterval(timer);
    }
    this.timers.clear();
    log.info('[HeartbeatService] Stopped all heartbeats');
  }

  activeCount(): number {
    return this.timers.size;
  }

  isActive(metabotId: number): boolean {
    return this.timers.has(metabotId);
  }

  private async sendHeartbeat(metabotId: number): Promise<void> {
    try {
      const store = this.deps.getMetabotStore?.();
      await this.deps.createPin(store, metabotId, {
        operation: 'create',
        path: '/protocols/metabot-heartbeat',
        contentType: 'text/plain',
        payload: '',
        version: '1.0.0',
        encryption: '0',
      }, { network: 'mvc' });
      log.info(`[HeartbeatService] Heartbeat sent for metabot ${metabotId}`);
    } catch (error) {
      log.warn(`[HeartbeatService] Failed to send heartbeat for metabot ${metabotId}:`, error);
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run compile:electron && node --test tests/heartbeatService.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/services/heartbeatService.ts tests/heartbeatService.test.mjs
git commit -m "feat: implement heartbeat sending service with timer lifecycle"
```

---

## Task 4: Heartbeat Polling Service

**Files:**
- Create: `src/main/services/heartbeatPollingService.ts`
- Create: `tests/heartbeatPollingService.test.mjs`

- [ ] **Step 1: Write failing tests**

Create `tests/heartbeatPollingService.test.mjs`:

```javascript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('HeartbeatPollingService', () => {
  it('marks bot as online when heartbeat timestamp is within 6 minutes', async () => {
    const { HeartbeatPollingService } = await import('../dist-electron/services/heartbeatPollingService.js');

    const now = Date.now();
    const mockFetchHeartbeat = async (mvcAddress) => ({
      timestamp: Math.floor((now - 3 * 60 * 1000) / 1000), // 3 min ago
    });

    const service = new HeartbeatPollingService({ fetchHeartbeat: mockFetchHeartbeat });
    const result = service.checkOnlineStatus(
      Math.floor((now - 3 * 60 * 1000) / 1000)
    );
    assert.equal(result, true);
  });

  it('marks bot as offline when heartbeat timestamp exceeds 6 minutes', async () => {
    const { HeartbeatPollingService } = await import('../dist-electron/services/heartbeatPollingService.js');

    const now = Date.now();
    const service = new HeartbeatPollingService({ fetchHeartbeat: async () => null });
    const result = service.checkOnlineStatus(
      Math.floor((now - 7 * 60 * 1000) / 1000) // 7 min ago
    );
    assert.equal(result, false);
  });

  it('marks bot as offline when no heartbeat data exists', async () => {
    const { HeartbeatPollingService } = await import('../dist-electron/services/heartbeatPollingService.js');

    const service = new HeartbeatPollingService({ fetchHeartbeat: async () => null });
    const result = service.checkOnlineStatus(null);
    assert.equal(result, false);
  });

  it('pollAll populates onlineBots and availableServices', async () => {
    const { HeartbeatPollingService } = await import('../dist-electron/services/heartbeatPollingService.js');

    const now = Date.now();
    const mockFetchHeartbeat = async (addr) => {
      if (addr === 'online-addr') return { timestamp: Math.floor((now - 2 * 60 * 1000) / 1000) };
      return null;
    };

    const service = new HeartbeatPollingService({ fetchHeartbeat: mockFetchHeartbeat });
    const services = [
      { providerGlobalMetaId: 'gm1', providerAddress: 'online-addr', serviceName: 'Svc A' },
      { providerGlobalMetaId: 'gm2', providerAddress: 'offline-addr', serviceName: 'Svc B' },
    ];

    await service.pollAll(services);

    assert.equal(service.onlineBots.size, 1);
    assert.ok(service.onlineBots.has('gm1'));
    assert.equal(service.availableServices.length, 1);
    assert.equal(service.availableServices[0].serviceName, 'Svc A');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run compile:electron && node --test tests/heartbeatPollingService.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement heartbeatPollingService.ts**

Create `src/main/services/heartbeatPollingService.ts`:

```typescript
import log from 'electron-log';

const ONLINE_THRESHOLD_MS = 6 * 60 * 1000; // 6 minutes
const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const MANAPI_BASE = 'https://manapi.metaid.io';

interface HeartbeatPollingDeps {
  fetchHeartbeat: (mvcAddress: string) => Promise<{ timestamp: number } | null>;
  getListedServices?: () => any[];
}

export class HeartbeatPollingService {
  public onlineBots: Map<string, number> = new Map(); // globalMetaId → lastSeen timestamp
  public availableServices: any[] = [];
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private deps: HeartbeatPollingDeps;

  constructor(deps: HeartbeatPollingDeps) {
    this.deps = deps;
  }

  checkOnlineStatus(timestampSec: number | null): boolean {
    if (timestampSec == null) return false;
    const ageMs = Date.now() - timestampSec * 1000;
    return ageMs < ONLINE_THRESHOLD_MS;
  }

  async pollAll(services: any[]): Promise<void> {
    const newOnline = new Map<string, number>();
    const newAvailable: any[] = [];

    for (const svc of services) {
      try {
        const heartbeat = await this.deps.fetchHeartbeat(svc.providerAddress);
        const ts = heartbeat?.timestamp ?? null;
        if (this.checkOnlineStatus(ts)) {
          newOnline.set(svc.providerGlobalMetaId, ts!);
          newAvailable.push(svc);
        }
      } catch (err) {
        log.warn(`[HeartbeatPolling] Failed to check ${svc.providerAddress}:`, err);
      }
    }

    this.onlineBots = newOnline;
    this.availableServices = newAvailable;
    log.info(`[HeartbeatPolling] Poll complete: ${newOnline.size} online, ${newAvailable.length} available services`);
  }

  startPolling(getServices: () => any[]): void {
    // Immediate first poll
    this.runPoll(getServices);

    this.pollTimer = setInterval(() => {
      this.runPoll(getServices);
    }, POLL_INTERVAL_MS);
  }

  stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  markOffline(globalMetaId: string): void {
    this.onlineBots.delete(globalMetaId);
    this.availableServices = this.availableServices.filter(
      (s) => s.providerGlobalMetaId !== globalMetaId
    );
  }

  private async runPoll(getServices: () => any[]): Promise<void> {
    try {
      const services = getServices();
      await this.pollAll(services);
    } catch (err) {
      log.warn('[HeartbeatPolling] Poll error:', err);
    }
  }
}

/** Default fetcher that hits the manapi endpoint */
export async function fetchHeartbeatFromChain(mvcAddress: string): Promise<{ timestamp: number } | null> {
  const url = `${MANAPI_BASE}/address/pin/list/${mvcAddress}?cursor=0&size=1&path=/protocols/metabot-heartbeat`;
  const resp = await fetch(url);
  if (!resp.ok) return null;
  const data = await resp.json();
  const pin = data?.list?.[0] ?? data?.result?.list?.[0] ?? null;
  if (!pin || !pin.timestamp) return null;
  return { timestamp: pin.timestamp };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run compile:electron && node --test tests/heartbeatPollingService.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/services/heartbeatPollingService.ts tests/heartbeatPollingService.test.mjs
git commit -m "feat: implement heartbeat polling service with online status tracking"
```

---

## Task 5: IPC Handlers — Heartbeat & Online Status

**Files:**
- Modify: `src/main/preload.ts`
- Modify: `src/main/main.ts`

- [ ] **Step 1: Add heartbeat IPC to preload.ts**

In `src/main/preload.ts`, add a new `heartbeat` section to the `contextBridge.exposeInMainWorld('electron', ...)` object (near the existing `metabot` section):

```typescript
heartbeat: {
  toggle: (params: { metabotId: number; enabled: boolean }) =>
    ipcRenderer.invoke('heartbeat:toggle', params),
  getStatus: (metabotId: number) =>
    ipcRenderer.invoke('heartbeat:getStatus', metabotId),
  getOnlineServices: () =>
    ipcRenderer.invoke('heartbeat:getOnlineServices'),
  getOnlineBots: () =>
    ipcRenderer.invoke('heartbeat:getOnlineBots'),
},
```

- [ ] **Step 2: Register IPC handlers in main.ts**

In `src/main/main.ts`, after the existing `gigSquare:` handlers, add:

```typescript
ipcMain.handle('heartbeat:toggle', async (_event, params: { metabotId: number; enabled: boolean }) => {
  try {
    const store = getMetabotStore();
    // Update DB
    store.db.run('UPDATE metabots SET heartbeat_enabled = ? WHERE id = ?', [params.enabled ? 1 : 0, params.metabotId]);
    store.save();
    // Start or stop heartbeat timer
    if (params.enabled) {
      getHeartbeatService().startHeartbeat(params.metabotId);
    } else {
      getHeartbeatService().stopHeartbeat(params.metabotId);
    }
    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to toggle heartbeat' };
  }
});

ipcMain.handle('heartbeat:getStatus', async (_event, metabotId: number) => {
  try {
    return { success: true, active: getHeartbeatService().isActive(metabotId) };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
});

ipcMain.handle('heartbeat:getOnlineServices', async () => {
  try {
    return { success: true, services: getHeartbeatPollingService().availableServices };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
});

ipcMain.handle('heartbeat:getOnlineBots', async () => {
  try {
    const map = getHeartbeatPollingService().onlineBots;
    return { success: true, bots: Object.fromEntries(map) };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
});
```

- [ ] **Step 3: Wire up service singletons in main.ts**

Add near the other service singletons in `main.ts`:

```typescript
import { HeartbeatService } from './services/heartbeatService';
import { HeartbeatPollingService, fetchHeartbeatFromChain } from './services/heartbeatPollingService';

let heartbeatService: HeartbeatService | null = null;
let heartbeatPollingService: HeartbeatPollingService | null = null;

function getHeartbeatService(): HeartbeatService {
  if (!heartbeatService) {
    heartbeatService = new HeartbeatService({
      createPin,
      getMetabotStore: () => getMetabotStore(),
    });
  }
  return heartbeatService;
}

function getHeartbeatPollingService(): HeartbeatPollingService {
  if (!heartbeatPollingService) {
    heartbeatPollingService = new HeartbeatPollingService({
      fetchHeartbeat: fetchHeartbeatFromChain,
    });
  }
  return heartbeatPollingService;
}
```

- [ ] **Step 4: Start heartbeats and polling on app ready**

In the `app.whenReady()` block (or the existing startup sequence), add:

```typescript
// Start heartbeats for all enabled MetaBots
const allBots = getMetabotStore().listMetabots();
for (const bot of allBots) {
  if (bot.heartbeat_enabled) {
    getHeartbeatService().startHeartbeat(bot.id);
  }
}

// Start polling for online services
getHeartbeatPollingService().startPolling(() => {
  // Get all listed remote services from gigSquare sync
  try {
    // Query listed services from SQLite: SELECT * FROM remote_skill_service WHERE available = 1 AND status >= 0
    const store = getMetabotStore();
    const rows = store.db.exec('SELECT * FROM remote_skill_service WHERE available = 1 AND status >= 0');
    return rows[0]?.values?.map(/* map to ParsedRemoteSkillServiceRow */) || [];
  } catch { return []; }
});
```

- [ ] **Step 5: Compile and verify**

Run: `npm run compile:electron`
Expected: No compilation errors.

- [ ] **Step 6: Commit**

```bash
git add src/main/preload.ts src/main/main.ts
git commit -m "feat: wire heartbeat service IPC handlers and app startup"
```

---

## Task 6: MetaBot Card — Heartbeat Toggle UI

**Files:**
- Modify: `src/renderer/components/metabots/MetaBotListCard.tsx`
- Modify: `src/renderer/services/i18n.ts` (add heartbeat-related keys)

- [ ] **Step 1: Add i18n keys for heartbeat toggle**

In `src/renderer/services/i18n.ts`:

Chinese section — add near other metabot keys:
```typescript
heartbeatToggle: '链上心跳',
heartbeatConfirmTitle: '开启链上心跳？',
heartbeatConfirmMessage: '开启此功能会每 5 分钟向区块链广播一次心跳信号，增加该 Bot 在 Bot Hub 被发现的几率，但将会消耗少量的 gas（MVC）。',
heartbeatConfirmOk: '确定',
heartbeatConfirmCancel: '取消',
```

English section:
```typescript
heartbeatToggle: 'On-chain Heartbeat',
heartbeatConfirmTitle: 'Enable On-chain Heartbeat?',
heartbeatConfirmMessage: 'Enabling this will broadcast a heartbeat signal to the blockchain every 5 minutes, increasing this Bot\'s discoverability in the Bot Hub. This will consume a small amount of gas (MVC).',
heartbeatConfirmOk: 'Confirm',
heartbeatConfirmCancel: 'Cancel',
```

- [ ] **Step 2: Add heartbeat toggle to MetaBotListCard.tsx**

In `src/renderer/components/metabots/MetaBotListCard.tsx`, below the avatar area (~line 199), add a heartbeat toggle row. The toggle should:
- Show a `💓` icon and the i18n label `heartbeatToggle`
- Read initial state from `bot.heartbeat_enabled`
- On toggle: if enabling, show a confirm dialog with `heartbeatConfirmMessage`; if user confirms, call `window.electron.heartbeat.toggle({ metabotId: bot.id, enabled: true })`
- On disabling: call directly without confirmation
- Use the same toggle styling as the existing enable/disable toggle (~lines 209-226)

- [ ] **Step 3: Verify visually**

Run: `npm run electron:dev`
Verify: Each MetaBot card shows a heartbeat toggle below the avatar. Toggling ON shows confirmation dialog. Toggling OFF disables immediately.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/components/metabots/MetaBotListCard.tsx src/renderer/services/i18n.ts
git commit -m "feat: add heartbeat toggle UI to MetaBot cards"
```

---

## Task 7: Bot Hub — Online Status Badges

**Files:**
- Modify: `src/renderer/components/gigSquare/GigSquareView.tsx`
- Modify: `src/renderer/services/i18n.ts` (add online/offline keys)

- [ ] **Step 1: Add i18n keys**

Chinese: `botOnline: '在线'`, `botOffline: '离线'`
English: `botOnline: 'Online'`, `botOffline: 'Offline'`

- [ ] **Step 2: Fetch online bots in GigSquareView**

In `GigSquareView.tsx`, add a state variable and effect to fetch online bots:

```typescript
const [onlineBots, setOnlineBots] = useState<Record<string, number>>({});

useEffect(() => {
  window.electron.heartbeat.getOnlineBots().then((res) => {
    if (res.success) setOnlineBots(res.bots);
  });
  const interval = setInterval(() => {
    window.electron.heartbeat.getOnlineBots().then((res) => {
      if (res.success) setOnlineBots(res.bots);
    });
  }, 60_000); // refresh every minute
  return () => clearInterval(interval);
}, []);
```

- [ ] **Step 3: Add online/offline badge to service cards**

In the service card rendering area (~line 372, near existing badges), add:

```tsx
{/* Online status badge */}
<span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs ${
  onlineBots[service.providerGlobalMetaId]
    ? 'bg-green-900/30 text-green-400 border border-green-800'
    : 'bg-gray-900/30 text-gray-500 border border-gray-700'
}`}>
  <span className={`w-1.5 h-1.5 rounded-full ${
    onlineBots[service.providerGlobalMetaId] ? 'bg-green-400' : 'bg-gray-500'
  }`} />
  {onlineBots[service.providerGlobalMetaId] ? i18nService.t('botOnline') : i18nService.t('botOffline')}
</span>
```

- [ ] **Step 4: Sort online services first**

In the service list sorting logic, add online-first sorting before existing sort criteria:

```typescript
const isOnlineA = onlineBots[a.providerGlobalMetaId] ? 1 : 0;
const isOnlineB = onlineBots[b.providerGlobalMetaId] ? 1 : 0;
if (isOnlineB !== isOnlineA) return isOnlineB - isOnlineA; // online first
```

- [ ] **Step 5: Apply reduced opacity to offline cards**

Add `opacity-60` class to offline service cards:

```tsx
<div className={`... ${!onlineBots[service.providerGlobalMetaId] ? 'opacity-60' : ''}`}>
```

- [ ] **Step 6: Verify visually**

Run: `npm run electron:dev`
Verify: Bot Hub shows online/offline badges. Online services sort first. Offline cards are dimmed.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/components/gigSquare/GigSquareView.tsx src/renderer/services/i18n.ts
git commit -m "feat: add online/offline status badges to Bot Hub service cards"
```

---

## Task 8: Remote Services Prompt Injection

**Files:**
- Modify: `src/main/skillManager.ts`
- Modify: `src/main/libs/coworkRunner.ts`

- [ ] **Step 1: Add buildRemoteServicesPrompt() to skillManager.ts**

In `src/main/skillManager.ts`, add after `buildCoworkAutoRoutingPrompt()` (~line 1006):

```typescript
buildRemoteServicesPrompt(availableServices: any[]): string | null {
  if (!availableServices || availableServices.length === 0) return null;

  const entries = availableServices.map((svc) =>
    `  <remote_service>` +
    `<service_pin_id>${svc.pinId || svc.servicePinId || ''}</service_pin_id>` +
    `<service_name>${svc.displayName || svc.serviceName || ''}</service_name>` +
    `<description>${svc.description || ''}</description>` +
    `<price>${svc.price || ''} ${svc.currency || ''}</price>` +
    `<rating_avg>${svc.ratingAvg ?? 'N/A'}</rating_avg>` +
    `<rating_count>${svc.ratingCount ?? 0}</rating_count>` +
    `<provider_name>${svc.providerMetaBot || svc.providerName || ''}</provider_name>` +
    `<provider_global_metaid>${svc.providerGlobalMetaId || ''}</provider_global_metaid>` +
    `</remote_service>`
  ).join('\n');

  return `\n<available_remote_services>\n` +
    `  <notice>\n` +
    `    The following are on-chain services provided by remote MetaBots on the\n` +
    `    permissionless agent collaboration network.\n\n` +
    `    RULES:\n` +
    `    1. ONLY consider these when NO local skill can fulfill the user's request.\n` +
    `    2. When you find a matching remote service, present it to the user in\n` +
    `       natural language with: service name, description, price, rating, and\n` +
    `       provider Bot name. Ask the user to confirm before delegating.\n` +
    `    3. After the user confirms, output [DELEGATE_REMOTE_SERVICE] followed by\n` +
    `       a JSON object on the next line. This message will be intercepted by\n` +
    `       the system — do NOT show it to the user.\n` +
    `    4. Do NOT attempt to read SKILL.md files for remote services.\n\n` +
    `    [DELEGATE_REMOTE_SERVICE] JSON format:\n` +
    `    {"servicePinId":"...","serviceName":"...","providerGlobalMetaid":"...","price":"...","currency":"...","userTask":"summary","taskContext":"full context"}\n` +
    `    Note: providerAddress is resolved by the system using servicePinId.\n` +
    `  </notice>\n` +
    entries + '\n' +
    `</available_remote_services>\n`;
}
```

- [ ] **Step 2: Inject into composeEffectiveSystemPrompt() in coworkRunner.ts**

In `src/main/libs/coworkRunner.ts`, inside `composeEffectiveSystemPrompt()` (~line 2170), after the existing `trimmedBasePrompt` concatenation, append:

```typescript
// Inject available remote services (online ∩ listed) for auto-discovery
const remoteServicesPrompt = this.skillManager?.buildRemoteServicesPrompt?.(
  this.heartbeatPollingService?.availableServices || []
);
if (remoteServicesPrompt) {
  parts.push(remoteServicesPrompt);
}
```

The `heartbeatPollingService` reference needs to be passed to the cowork runner. Add it as a constructor/config parameter alongside the existing `skillManager` reference.

- [ ] **Step 3: Compile and verify**

Run: `npm run compile:electron`
Expected: No compilation errors.

- [ ] **Step 4: Commit**

```bash
git add src/main/skillManager.ts src/main/libs/coworkRunner.ts
git commit -m "feat: inject available remote services into cowork system prompt"
```

---

## Task 9: Delegation Pattern Detection

**Files:**
- Modify: `src/main/libs/coworkRunner.ts`
- Create: `tests/remoteDelegation.test.mjs`

- [ ] **Step 1: Write failing test for pattern parsing**

Create `tests/remoteDelegation.test.mjs`:

```javascript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('[DELEGATE_REMOTE_SERVICE] pattern parsing', () => {
  it('parses valid delegation message', async () => {
    const { parseDelegationMessage } = await import('../dist-electron/libs/coworkRunner.js');

    const content = `[DELEGATE_REMOTE_SERVICE]\n{"servicePinId":"pin123","serviceName":"Test Service","providerGlobalMetaid":"gm456","price":"200","currency":"SPACE","userTask":"translate article","taskContext":"article text here"}`;

    const result = parseDelegationMessage(content);
    assert.ok(result, 'should parse successfully');
    assert.equal(result.servicePinId, 'pin123');
    assert.equal(result.serviceName, 'Test Service');
    assert.equal(result.price, '200');
    assert.equal(result.currency, 'SPACE');
    assert.equal(result.userTask, 'translate article');
  });

  it('returns null for non-delegation messages', async () => {
    const { parseDelegationMessage } = await import('../dist-electron/libs/coworkRunner.js');

    assert.equal(parseDelegationMessage('Hello, how are you?'), null);
    assert.equal(parseDelegationMessage('[ORDER] some order'), null);
  });

  it('handles JSON embedded in surrounding text', async () => {
    const { parseDelegationMessage } = await import('../dist-electron/libs/coworkRunner.js');

    const content = `I will delegate this task.\n[DELEGATE_REMOTE_SERVICE]\n{"servicePinId":"p1","serviceName":"Svc","providerGlobalMetaid":"gm","price":"100","currency":"SPACE","userTask":"task","taskContext":"ctx"}`;

    const result = parseDelegationMessage(content);
    assert.ok(result);
    assert.equal(result.servicePinId, 'p1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run compile:electron && node --test tests/remoteDelegation.test.mjs`
Expected: FAIL — `parseDelegationMessage` not exported.

- [ ] **Step 3: Implement parseDelegationMessage**

In `src/main/libs/coworkRunner.ts`, add as an exported function:

```typescript
export interface DelegationRequest {
  servicePinId: string;
  serviceName: string;
  providerGlobalMetaid: string;
  price: string;
  currency: string;
  userTask: string;
  taskContext: string;
}

const DELEGATION_PREFIX = '[DELEGATE_REMOTE_SERVICE]';

export function parseDelegationMessage(content: string): DelegationRequest | null {
  const idx = content.indexOf(DELEGATION_PREFIX);
  if (idx === -1) return null;

  const afterPrefix = content.substring(idx + DELEGATION_PREFIX.length).trim();
  // Find the first { and last } to extract JSON
  const jsonStart = afterPrefix.indexOf('{');
  const jsonEnd = afterPrefix.lastIndexOf('}');
  if (jsonStart === -1 || jsonEnd === -1 || jsonEnd <= jsonStart) return null;

  try {
    const json = JSON.parse(afterPrefix.substring(jsonStart, jsonEnd + 1));
    if (!json.servicePinId || !json.serviceName || !json.providerGlobalMetaid) return null;
    return json as DelegationRequest;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run compile:electron && node --test tests/remoteDelegation.test.mjs`
Expected: PASS

- [ ] **Step 5: Hook detection into message finalization**

In `coworkRunner.ts`, inside `finalizeStreamingContent()` (~line 4896), after finalizing the text message, add:

```typescript
// Check for delegation pattern
if (currentStreamingContent) {
  const delegation = parseDelegationMessage(currentStreamingContent);
  if (delegation) {
    // Mark this message as internal (not shown to user)
    // Emit delegation event to be handled by the delegation pipeline
    this.emit('delegation:requested', {
      sessionId: this.currentSessionId,
      delegation,
    });
  }
}
```

- [ ] **Step 6: Commit**

```bash
git add src/main/libs/coworkRunner.ts tests/remoteDelegation.test.mjs
git commit -m "feat: detect [DELEGATE_REMOTE_SERVICE] pattern in cowork messages"
```

---

## Task 10: Delegation Pipeline — Handshake, Payment, Order, A2A

**Files:**
- Modify: `src/main/coworkStore.ts`
- Modify: `src/main/main.ts`

This is the core orchestration. When a `delegation:requested` event fires:

- [ ] **Step 1: Create delegation handler in coworkStore or a new orchestration function**

Add a `handleDelegationRequest` method that orchestrates the full pipeline:

```typescript
async function handleDelegationRequest(
  sessionId: string,
  delegation: DelegationRequest,
  deps: {
    coworkStore: CoworkStore;
    metabotStore: MetabotStore;
    heartbeatPollingService: HeartbeatPollingService;
    serviceOrderLifecycle: ServiceOrderLifecycleService;
    executeTransfer: typeof executeTransfer;
    pingProvider: (params: any) => Promise<{ success: boolean }>;
    createPin: typeof createPin;
    emitToRenderer: (channel: string, data: any) => void;
  }
): Promise<void> {
  const session = deps.coworkStore.getSession(sessionId);
  if (!session) return;

  const metabotId = session.metabotId;

  // Step 1: Resolve providerAddress from service record
  const service = deps.heartbeatPollingService.availableServices.find(
    (s) => (s.pinId || s.servicePinId) === delegation.servicePinId
  );
  if (!service) {
    injectErrorMessage(deps, sessionId, 'Service no longer available.');
    return;
  }

  // Step 2: PING/PONG handshake
  const metabot = deps.metabotStore.getMetabot(metabotId);
  const pong = await deps.pingProvider({
    metabotId,
    toGlobalMetaId: delegation.providerGlobalMetaid,
    toChatPubkey: service.chatPubkey || '',
    timeoutMs: 15000,
  });

  if (!pong.success) {
    deps.heartbeatPollingService.markOffline(delegation.providerGlobalMetaid);
    injectSystemMessage(deps, sessionId,
      `Handshake with ${delegation.serviceName} failed — the service appears offline. Please try the next matching service.`);
    // Let cowork continue so LLM can pick next service
    return;
  }

  // Step 3: Payment
  const transferResult = await deps.executeTransfer(deps.metabotStore, {
    metabotId,
    chain: delegation.currency === 'SPACE' ? 'mvc' : delegation.currency.toLowerCase(),
    toAddress: service.providerAddress,
    amountSpaceOrDoge: delegation.price,
    feeRate: getFeeRateStore?.().getMvcFeeRate() ?? 1,
  });

  if (!transferResult.success) {
    injectErrorMessage(deps, sessionId,
      `Payment failed: ${transferResult.error || 'Insufficient balance'}. You can continue chatting.`);
    return;
  }

  const txid = transferResult.txId;

  // Step 4: Build and send [ORDER] message
  const orderContent = `[ORDER] ${delegation.userTask}\n支付金额 ${delegation.price} ${delegation.currency}\ntxid: ${txid}\nservice id: ${delegation.servicePinId}\nskill name: ${delegation.serviceName}`;

  // ECDH encrypt and send via createPin (reuse existing pattern from gigSquare:orderService handler in main.ts ~line 5012+)
  // Reference: getPrivateKeyBufferForEcdh() → computeEcdhSharedSecretSha256() → ecdhEncrypt() → buildPrivateMessagePayload() → createPin()

  // Step 5: Create buyer order
  const order = deps.serviceOrderLifecycle.createBuyerOrder({
    localMetabotId: metabotId,
    counterpartyGlobalMetaId: delegation.providerGlobalMetaid,
    servicePinId: delegation.servicePinId,
    serviceName: delegation.serviceName,
    paymentTxid: txid,
    paymentChain: delegation.currency === 'SPACE' ? 'mvc' : delegation.currency.toLowerCase(),
    paymentAmount: delegation.price,
    paymentCurrency: delegation.currency,
    coworkSessionId: sessionId,
  });

  // Step 6: Inject processing message + enter blocking mode
  const processingMsg = `✅ Payment sent: ${delegation.price} ${delegation.currency}\ntxid: ${txid}\n\n🔄 Task delegated to ${service.providerMetaBot || delegation.serviceName}. Waiting for result...\n\n[View A2A session: ${order.id}]`;

  injectAssistantMessage(deps, sessionId, processingMsg, {
    delegationOrderId: order.id,
    delegationState: 'processing',
  });

  // Mark session as blocking/observer
  deps.coworkStore.setDelegationBlocking(sessionId, true, order.id);
}
```

- [ ] **Step 2: Add blocking state to coworkStore**

In `src/main/coworkStore.ts`, add methods:

```typescript
setDelegationBlocking(sessionId: string, blocking: boolean, orderId?: string): void {
  // Store blocking state in session metadata
  // Emit status update to renderer
}

isDelegationBlocking(sessionId: string): boolean {
  // Check if session is in delegation-blocking state
}
```

- [ ] **Step 3: Wire up delegation event listener in main.ts**

In `main.ts`, when creating cowork runner instances, listen for the `delegation:requested` event and call `handleDelegationRequest`.

- [ ] **Step 4: Compile and verify**

Run: `npm run compile:electron`
Expected: No compilation errors.

- [ ] **Step 5: Commit**

```bash
git add src/main/coworkStore.ts src/main/main.ts
git commit -m "feat: implement delegation pipeline — handshake, payment, order, A2A, blocking"
```

---

## Task 11: Result Return & Cowork Session Unblocking

**Files:**
- Modify: `src/main/services/privateChatDaemon.ts`
- Modify: `src/main/coworkStore.ts`

- [ ] **Step 1: Detect auto-delegated delivery in privateChatDaemon**

In `privateChatDaemon.ts`, in the delivery handling block (~line 807), after the existing delivery processing, add:

```typescript
// Check if this delivery is for an auto-delegated order (has source coworkSessionId)
// The buyerOrderMapping already provides coworkSessionId via the existing conversation mapping lookup
if (buyerOrderMapping?.coworkSessionId) {
  const buyerOrder = serviceOrderLifecycle.findOrderBySession(buyerOrderMapping.coworkSessionId);
  if (buyerOrder) {
    handleAutoDeliveryResult(coworkStore, buyerOrder, plaintext, emitToRenderer);
  }
}
```

- [ ] **Step 2: Implement handleAutoDeliveryResult**

```typescript
function handleAutoDeliveryResult(
  coworkStore: CoworkStore,
  order: ServiceOrderRecord,
  deliveryContent: string,
  emitToRenderer: (channel: string, data: any) => void
): void {
  const sessionId = order.coworkSessionId!;

  // Exit blocking mode
  coworkStore.setDelegationBlocking(sessionId, false);

  // Inject delivery result as system message
  const resultMsg = coworkStore.addMessage(sessionId, {
    type: 'system',
    content: deliveryContent,
    metadata: { delegationDelivery: true, orderId: order.id },
  });

  emitToRenderer('cowork:stream:message', { sessionId, message: resultMsg });

  // Trigger Bot A to summarize — continue the cowork session with a summary instruction
  // This will be handled by the cowork continue flow with a special system prompt addition
  emitToRenderer('cowork:delegation:resultReady', {
    sessionId,
    orderId: order.id,
    deliveryContent,
    serviceName: order.serviceName,
    paymentAmount: order.paymentAmount,
    paymentCurrency: order.paymentCurrency,
    paymentTxid: order.paymentTxid,
  });
}
```

- [ ] **Step 3: Handle delegation:resultReady in renderer to auto-continue**

In the renderer (or via IPC back to main), trigger a `cowork:session:continue` with a special prompt instructing Bot A to summarize:

```typescript
// System injects this as the continue prompt:
const summaryPrompt = `The remote service "${serviceName}" has returned a result. Summarize it for the user in natural language. Include a source attribution block at the end with: service name, provider name, payment amount (${paymentAmount} ${paymentCurrency}), txid (${paymentTxid}), and a link to view the full A2A conversation.`;
```

- [ ] **Step 4: Add blocking/processing UI in CoworkSessionDetail.tsx**

In `src/renderer/components/cowork/CoworkSessionDetail.tsx`, check if the session is in delegation-blocking state and render:
- Disable the input textarea
- Show status bar: "⏳ Waiting for remote service result... | Input disabled"
- When `delegation:resultReady` event arrives, re-enable input

- [ ] **Step 5: Compile and verify**

Run: `npm run compile:electron`
Expected: No compilation errors.

- [ ] **Step 6: Commit**

```bash
git add src/main/services/privateChatDaemon.ts src/main/coworkStore.ts src/renderer/components/cowork/CoworkSessionDetail.tsx
git commit -m "feat: handle delivery result injection and cowork session unblocking"
```

---

## Task 12: End-to-End Integration Verification

- [ ] **Step 1: Run full test suite**

Run: `npm run compile:electron && node --test tests/*.test.mjs`
Expected: All tests pass, including new heartbeat and delegation tests.

- [ ] **Step 2: Run lint**

Run: `npm run lint`
Expected: No errors.

- [ ] **Step 3: Manual E2E verification**

Run: `npm run electron:dev`

Verification checklist:
1. Sidebar shows "我的Bot" and "Bot Hub"
2. MetaBot cards have heartbeat toggle; toggling shows confirmation dialog
3. Bot Hub shows online/offline badges on service cards
4. In cowork: send a task that matches no local skill but matches a remote service → Bot A recommends it → confirm → payment + A2A → result summary with source attribution

- [ ] **Step 4: Final commit with any integration fixes**

```bash
git add -A
git commit -m "fix: integration adjustments for auto service discovery"
```
