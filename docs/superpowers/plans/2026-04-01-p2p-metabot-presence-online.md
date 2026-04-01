# P2P MetaBot Presence Online Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship presence-first provider online discovery across `man-p2p` and `IDBots`, while keeping `PING/PONG` as the final orderability gate and chain heartbeat as fallback only when presence discovery is unhealthy.

**Architecture:** Add a dedicated presence subsystem to `man-p2p` with its own topic, cache, health contract, and HTTP API. In `IDBots`, keep the renderer-facing discovery snapshot stable, but swap the main-process discovery source to a new presence-first orchestrator that rewrites runtime config, polls `/api/p2p/presence`, and falls back to the existing heartbeat poller only when the presence contract reports unhealthy.

**Tech Stack:** Go 1.25+, Gin, go-libp2p pubsub, Electron 40, TypeScript, sql.js, Node `node:test`

**Spec:** `/Users/tusm/Documents/MetaID_Projects/IDBots/IDBots/.worktrees/codex/p2p-presence-online/docs/superpowers/specs/2026-04-01-p2p-metabot-presence-online-discovery-design.md`

---

## Repository Roots

Use these exact worktrees during implementation:

```bash
export MAN_P2P_ROOT=/Users/tusm/Documents/MetaID_Projects/man-p2p/.worktrees/codex/p2p-presence-online
export IDBOTS_ROOT=/Users/tusm/Documents/MetaID_Projects/IDBots/IDBots/.worktrees/codex/p2p-presence-online
```

## Current Baseline Note

- `man-p2p` full `go test ./...` is currently red on this macOS machine because of an unrelated `github.com/DataDog/zstd` C compilation failure.
- Until that separate Go/C repair lands, use the focused package-level Go test commands in this plan.
- Before claiming the feature is complete, repair that baseline in a separate execution step and re-run the final verification commands.
- Per user requirement, every non-trivial test batch in Tasks 3, 5, 6, and 7 should be run by a dedicated testing subagent so implementation context stays narrow.

## File Structure

### `man-p2p`

| File | Responsibility |
| --- | --- |
| `p2p/presence.go` | Presence topic name, payload schema, canonicalization, receive-time TTL cache, runtime membership reload, health snapshot |
| `p2p/presence_test.go` | Unit tests for canonicalization, TTL clamp, cache aggregation, reload behavior |
| `p2p/config.go` | Add `p2p_presence_global_metaids` to runtime config and trigger presence membership reload on config reload |
| `p2p/config_test.go` | Config load/reload tests for presence membership |
| `api/p2p_api.go` | Register `GET /api/p2p/presence` |
| `api/p2p_presence_contract_test.go` | API contract tests for healthy/unhealthy presence semantics |
| `p2p/host.go` | Background bootstrap reconnect loop |
| `p2p/host_test.go` | Reconnect loop regression tests |
| `app.go` | Initialize the presence subsystem after host + pubsub startup |
| `p2p/presence_dual_instance_test.go` | Same-process dual-node presence propagation + expiry acceptance test |

### `IDBots`

| File | Responsibility |
| --- | --- |
| `src/main/services/p2pConfigService.ts` | Add `p2p_presence_global_metaids` to generated runtime JSON |
| `src/main/services/p2pRuntimeConfigSync.ts` | Central helper to rewrite `man-p2p-config.json` and POST `/api/config/reload` after startup/toggle/MetaBot CRUD |
| `src/main/services/p2pPresenceClient.ts` | Fetch + normalize `/api/p2p/presence` into a typed local contract |
| `src/main/services/providerDiscoveryService.ts` | Presence-first scheduler, fallback orchestration, stable discovery snapshot output |
| `src/main/services/providerPingService.ts` | Extract current pre-order `PING/PONG` logic out of `main.ts` for targeted regression tests |
| `src/main/main.ts` | Wire runtime-config sync, provider discovery service, existing IPC/event channels, and pre-order gating |
| `tests/p2pConfigService.test.mjs` | Runtime-config derivation tests |
| `tests/p2pRuntimeConfigSync.test.mjs` | Runtime config rewrite/reload hook tests |
| `tests/p2pPresenceClient.test.mjs` | Presence API parsing and unhealthy detection tests |
| `tests/providerDiscoveryService.test.mjs` | Presence-first vs heartbeat-fallback discovery behavior tests |
| `tests/providerPingService.test.mjs` | `PING/PONG` success/failure timeout regression tests |
| `tests/heartbeatPollingService.test.mjs` | Keep heartbeat fallback behavior honest while it remains as the phase-1 fallback path |
| `resources/man-p2p/*` | Bundled updated binaries after `npm run sync:man-p2p` |

---

### Task 1: Add `man-p2p` Presence Config And Cache Primitives

**Files:**
- Create: `p2p/presence.go`
- Create: `p2p/presence_test.go`
- Modify: `p2p/config.go`
- Modify: `p2p/config_test.go`

- [ ] **Step 1: Write the failing config tests for presence membership**

Add tests like:

```go
func TestLoadConfigIncludesPresenceGlobalMetaIDs(t *testing.T) {
	path := writeTempConfig(t, `{"p2p_presence_global_metaids":["idq1bota","idq1botb"]}`)
	if err := LoadConfig(path); err != nil { t.Fatal(err) }
	got := GetConfig().PresenceGlobalMetaIDs
	if len(got) != 2 || got[0] != "idq1bota" || got[1] != "idq1botb" {
		t.Fatalf("unexpected presence ids: %v", got)
	}
}

func TestReloadConfigUpdatesPresenceGlobalMetaIDs(t *testing.T) {
	path := writeTempConfig(t, `{"p2p_presence_global_metaids":["idq1old"]}`)
	if err := LoadConfig(path); err != nil { t.Fatal(err) }
	if err := os.WriteFile(path, []byte(`{"p2p_presence_global_metaids":["idq1new"]}`), 0o644); err != nil { t.Fatal(err) }
	if err := ReloadConfig(); err != nil { t.Fatal(err) }
	if got := GetConfig().PresenceGlobalMetaIDs; len(got) != 1 || got[0] != "idq1new" {
		t.Fatalf("unexpected reloaded ids: %v", got)
	}
}
```

- [ ] **Step 2: Run the config tests to verify they fail**

Run: `CGO_ENABLED=0 go test ./p2p -run 'TestLoadConfigIncludesPresenceGlobalMetaIDs|TestReloadConfigUpdatesPresenceGlobalMetaIDs' -count=1 -v`

Expected: FAIL because `P2PSyncConfig` does not yet expose `p2p_presence_global_metaids`.

- [ ] **Step 3: Write the failing cache and canonicalization tests**

Add tests like:

```go
func TestPresenceCacheCanonicalizesGlobalMetaID(t *testing.T) {
	cache := newPresenceCache()
	cache.upsert("peer-a", PresenceAnnouncement{GlobalMetaIDs: []string{" IDQ1BotA "}, TTLSec: 55}, 1_760_000_000)
	snap := cache.snapshot(1_760_000_000)
	if _, ok := snap.OnlineBots["idq1bota"]; !ok {
		t.Fatalf("expected canonical key, got %#v", snap.OnlineBots)
	}
}

func TestPresenceCacheUsesReceiveTimeAndClampsTTL(t *testing.T) {
	cache := newPresenceCache()
	cache.upsert("peer-a", PresenceAnnouncement{GlobalMetaIDs: []string{"idq1bota"}, TTLSec: 9999, SentAt: 1}, 100)
	snap := cache.snapshot(100)
	if snap.OnlineBots["idq1bota"].ExpiresAtSec != 220 {
		t.Fatalf("expected ttl clamp to 120 seconds, got %#v", snap.OnlineBots["idq1bota"])
	}
}

func TestPresenceCacheAggregatesOneGlobalMetaIDAcrossMultiplePeers(t *testing.T) {
	cache := newPresenceCache()
	cache.upsert("peer-a", PresenceAnnouncement{GlobalMetaIDs: []string{"idq1bota"}, TTLSec: 55}, 100)
	cache.upsert("peer-b", PresenceAnnouncement{GlobalMetaIDs: []string{"idq1bota"}, TTLSec: 55}, 105)
	snap := cache.snapshot(105)
	got := snap.OnlineBots["idq1bota"]
	if len(got.PeerIDs) != 2 {
		t.Fatalf("expected two peer ids, got %#v", got)
	}
}
```

- [ ] **Step 4: Run the cache tests to verify they fail**

Run: `CGO_ENABLED=0 go test ./p2p -run 'TestPresenceCacheCanonicalizesGlobalMetaID|TestPresenceCacheUsesReceiveTimeAndClampsTTL' -count=1 -v`

Expected: FAIL because the presence cache does not exist yet.

- [ ] **Step 5: Implement the minimal config and cache layer**

Implement:

```go
type P2PSyncConfig struct {
	// existing fields...
	PresenceGlobalMetaIDs []string `json:"p2p_presence_global_metaids"`
}

type PresenceAnnouncement struct {
	SchemaVersion int      `json:"schemaVersion"`
	PeerID        string   `json:"peerId"`
	SentAt        int64    `json:"sentAt"`
	TTLSec        int64    `json:"ttlSec"`
	RuntimeMode   string   `json:"runtimeMode,omitempty"`
	GlobalMetaIDs []string `json:"globalMetaIds"`
}
```

In `p2p/presence.go`, add:
- canonical `globalMetaId` normalization (`trim()` + lowercase, reject `metaid:` form)
- in-memory `(peerId, globalMetaId)` cache keyed from transport `ReceivedFrom`
- TTL clamp `1..120`
- reloadable local membership derived from `GetConfig().PresenceGlobalMetaIDs`

- [ ] **Step 6: Re-run the focused `man-p2p` unit tests**

Run: `CGO_ENABLED=0 go test ./p2p -run 'TestLoadConfigIncludesPresenceGlobalMetaIDs|TestReloadConfigUpdatesPresenceGlobalMetaIDs|TestPresenceCacheCanonicalizesGlobalMetaID|TestPresenceCacheUsesReceiveTimeAndClampsTTL|TestPresenceCacheAggregatesOneGlobalMetaIDAcrossMultiplePeers' -count=1 -v`

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git -C "$MAN_P2P_ROOT" add p2p/config.go p2p/config_test.go p2p/presence.go p2p/presence_test.go
git -C "$MAN_P2P_ROOT" commit -m "feat: add p2p presence config and cache primitives"
```

### Task 2: Expose The `man-p2p` Presence HTTP Contract

**Files:**
- Modify: `p2p/presence.go`
- Modify: `api/p2p_api.go`
- Create: `api/p2p_presence_contract_test.go`

- [ ] **Step 1: Write the failing API contract tests**

Add tests like:

```go
func TestP2PPresenceEndpointReturnsHealthySnapshot(t *testing.T) {
	setPresenceTestSnapshot(PresenceStatus{
		Healthy: true,
		PeerCount: 2,
		OnlineBots: map[string]PresenceBotState{"idq1bota": {PeerIDs: []string{"peer-a"}}},
	})
	r := setupP2PTestRouter()
	w := httptest.NewRecorder()
	req, _ := http.NewRequest(http.MethodGet, "/api/p2p/presence", nil)
	r.ServeHTTP(w, req)
	// assert code=1, healthy=true, peerCount present, onlineBots present
}

func TestP2PPresenceEndpointReportsNoActivePeersAsUnhealthy(t *testing.T) {
	setPresenceTestSnapshot(PresenceStatus{Healthy: false, PeerCount: 0, UnhealthyReason: "no_active_peers"})
	// assert unhealthyReason and no fallback ambiguity
}
```

- [ ] **Step 2: Run the API contract tests to verify they fail**

Run: `CGO_ENABLED=0 go test ./api -run 'TestP2PPresenceEndpointReturnsHealthySnapshot|TestP2PPresenceEndpointReportsNoActivePeersAsUnhealthy' -count=1 -v`

Expected: FAIL because `/api/p2p/presence` is not registered.

- [ ] **Step 3: Implement the minimal endpoint and health snapshot**

Expose a new `GET /api/p2p/presence` returning:

```go
respond.ApiSuccess(1, "ok", gin.H{
	"healthy":               status.Healthy,
	"peerCount":             status.PeerCount,
	"unhealthyReason":       status.UnhealthyReason,
	"lastConfigReloadError": status.LastConfigReloadError,
	"nowSec":                status.NowSec,
	"onlineBots":            status.OnlineBots,
})
```

Rules:
- `healthy=true` only when subsystem ready and `peerCount >= 1`
- `peerCount` counts active libp2p peers from `Node.Network().Peers()`
- `onlineBots` keys must be canonical lowercase `id...` strings
- `lastConfigReloadError` is diagnostic only

- [ ] **Step 4: Re-run the focused API tests**

Run: `CGO_ENABLED=0 go test ./api -run 'TestP2PPresenceEndpointReturnsHealthySnapshot|TestP2PPresenceEndpointReportsNoActivePeersAsUnhealthy|TestP2PStatusEndpoint|TestConfigReloadEndpoint' -count=1 -v`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git -C "$MAN_P2P_ROOT" add api/p2p_api.go api/p2p_presence_contract_test.go p2p/presence.go
git -C "$MAN_P2P_ROOT" commit -m "feat: expose p2p presence api contract"
```

### Task 3: Wire `man-p2p` Startup, Reconnect, And Dual-Node Presence Propagation

**Files:**
- Modify: `app.go`
- Modify: `p2p/host.go`
- Modify: `p2p/host_test.go`
- Create: `p2p/presence_dual_instance_test.go`

- [ ] **Step 1: Write the failing bootstrap reconnect test**

Add a test like:

```go
func TestBootstrapReconnectLoopReconnectsAfterDisconnect(t *testing.T) {
	// start local host + bootstrap host
	// connect once
	// close bootstrap host
	// start replacement bootstrap host on the same addr
	// assert the reconnect loop redials without waiting for ReloadConfig()
}
```

- [ ] **Step 2: Run the reconnect test to verify it fails**

Run: `CGO_ENABLED=0 go test ./p2p -run TestBootstrapReconnectLoopReconnectsAfterDisconnect -count=1 -v`

Expected: FAIL because bootstrap redial only happens at startup/reload.

- [ ] **Step 3: Write the failing dual-node presence propagation test**

Create `p2p/presence_dual_instance_test.go` with a focused acceptance harness:

```go
func TestPresenceAnnouncementPropagatesAndExpires(t *testing.T) {
	// start node A + node B with pubsub
	// node A publishes idq1providera
	// node B waits for it in snapshot
	// advance time past ttl or stop A broadcasts
	// assert node B drops it after expiry
}
```

- [ ] **Step 4: Run the dual-node test to verify it fails**

Run: `CGO_ENABLED=0 go test ./p2p -run TestPresenceAnnouncementPropagatesAndExpires -count=1 -v`

Expected: FAIL because no dedicated presence topic or expiry loop exists yet.

- [ ] **Step 5: Implement startup wiring and reconnect loop**

In `app.go`:
- initialize the presence subsystem after `InitGossip(ctx)` succeeds
- start broadcast loop immediately when the subsystem is ready
- publish the first announcement immediately without waiting for `healthy=true`
- use the phase-1 defaults from the spec: rebroadcast every `20s`, `ttlSec=55`, jitter `+/-3s`

In `p2p/host.go`:
- replace one-shot bootstrap dialing with a background loop that periodically redials disconnected peers
- keep `clearBootstrapDialBackoff` before retry
- avoid hot loops with a ticker-based interval

- [ ] **Step 6: Re-run the focused `p2p` integration tests**

Run: `CGO_ENABLED=0 go test ./p2p -run 'TestBootstrapReconnectLoopReconnectsAfterDisconnect|TestPresenceAnnouncementPropagatesAndExpires|TestConnectBootstrapNodesRetriesUntilPeerBecomesAvailable' -count=1 -v`

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git -C "$MAN_P2P_ROOT" add app.go p2p/host.go p2p/host_test.go p2p/presence_dual_instance_test.go
git -C "$MAN_P2P_ROOT" commit -m "feat: wire p2p presence startup and bootstrap reconnect"
```

### Task 4: Add IDBots Runtime-Config Sync And Presence Client

**Files:**
- Modify: `src/main/services/p2pConfigService.ts`
- Create: `src/main/services/p2pRuntimeConfigSync.ts`
- Create: `src/main/services/p2pPresenceClient.ts`
- Create: `tests/p2pConfigService.test.mjs`
- Create: `tests/p2pRuntimeConfigSync.test.mjs`
- Create: `tests/p2pPresenceClient.test.mjs`

- [ ] **Step 1: Write the failing runtime-config derivation tests**

Add tests like:

```javascript
test('buildRuntimeConfig injects canonical p2p_presence_global_metaids from heartbeat-enabled bots', async () => {
  const { buildRuntimeConfig } = await import('../dist-electron/services/p2pConfigService.js');
  const config = buildRuntimeConfig(
    { p2p_sync_mode: 'self', p2p_bootstrap_nodes: [], p2p_enable_relay: true, p2p_storage_limit_gb: 10, p2p_enable_chain_source: false, p2p_own_addresses: [] },
    ['mvc-1'],
    [{ globalmetaid: ' IDQ1BotA ', heartbeat_enabled: true }, { globalmetaid: 'idq1botb', heartbeat_enabled: false }]
  );
  assert.deepEqual(config.p2p_presence_global_metaids, ['idq1bota']);
});
```

- [ ] **Step 2: Run the runtime-config tests to verify they fail**

Run: `npm run compile:electron && node --test tests/p2pConfigService.test.mjs`

Expected: FAIL because `buildRuntimeConfig()` does not yet accept MetaBot presence inputs.

- [ ] **Step 3: Write the failing presence client tests**

Add tests covering:
- healthy empty snapshot stays authoritative
- `code != 1` becomes unhealthy
- malformed `onlineBots` becomes unhealthy
- keys normalize to lowercase raw `id...`

Use fixtures like:

```javascript
const healthyEmpty = { code: 1, message: 'ok', data: { healthy: true, peerCount: 2, onlineBots: {} } };
const malformed = { code: 1, message: 'ok', data: { healthy: true, peerCount: 2 } };
```

- [ ] **Step 4: Run the presence client tests to verify they fail**

Run: `npm run compile:electron && node --test tests/p2pPresenceClient.test.mjs`

Expected: FAIL because the client module does not exist yet.

- [ ] **Step 5: Implement the runtime-config sync and presence client**

Implement:

```typescript
export async function syncP2PRuntimeConfig(input: {
  store: SqliteStore;
  configPath: string;
  listMetabots: () => Array<{ globalmetaid?: string | null; heartbeat_enabled?: boolean }>;
}): Promise<{ reloadOk: boolean; runtimeConfig: P2PConfig }> { /* write file + POST reload */ }
```

And:

```typescript
export async function fetchLocalPresenceSnapshot(baseUrl: string): Promise<PresenceFetchResult> {
  // use AbortSignal.timeout(2000)
  // classify healthy / unhealthy according to the spec, not renderer badge semantics
}
```

Runtime-config derivation must only write `p2p_presence_global_metaids` entries that are:
- non-empty after `trim()`
- canonicalized to lowercase
- rejected if they begin with `metaid:`
- otherwise left in raw `id...` form so they join with service rows and `/api/p2p/presence`
- when possible, reuse the existing IDBots `globalMetaId` validator instead of inventing a second validation rule

If the file write succeeds but `POST /api/config/reload` fails:
- log it
- surface the error through the local sync result and later `lastConfigReloadError`
- keep the last successful in-memory membership authoritative
- do **not** trigger heartbeat fallback unless the later `/api/p2p/presence` read path is unhealthy

- [ ] **Step 6: Re-run the focused IDBots tests**

Run: `npm run compile:electron && node --test tests/p2pConfigService.test.mjs tests/p2pRuntimeConfigSync.test.mjs tests/p2pPresenceClient.test.mjs`

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git -C "$IDBOTS_ROOT" add src/main/services/p2pConfigService.ts src/main/services/p2pRuntimeConfigSync.ts src/main/services/p2pPresenceClient.ts tests/p2pConfigService.test.mjs tests/p2pRuntimeConfigSync.test.mjs tests/p2pPresenceClient.test.mjs
git -C "$IDBOTS_ROOT" commit -m "feat: add runtime config sync and local presence client"
```

### Task 5: Switch IDBots Discovery To Presence-First While Preserving Snapshot Shape

**Files:**
- Create: `src/main/services/providerDiscoveryService.ts`
- Modify: `src/main/main.ts`
- Modify: `tests/heartbeatPollingService.test.mjs`
- Create: `tests/providerDiscoveryService.test.mjs`

- [ ] **Step 1: Write the failing presence-first discovery tests**

Add tests like:

```javascript
test('provider discovery uses presence onlineBots when presence is healthy', async () => {
  // services include providerGlobalMetaId idq1providera
  // presence client returns healthy snapshot for idq1providera
  // expect onlineBots + availableServices to be populated from presence
});

test('provider discovery does not fall back when presence is healthy and empty', async () => {
  // presence healthy, onlineBots={}
  // heartbeat fallback spy must not be called
});

test('provider discovery falls back when presence is unhealthy', async () => {
  // unhealthy presence result triggers heartbeat poller
});
```

- [ ] **Step 2: Run the discovery tests to verify they fail**

Run: `npm run compile:electron && node --test tests/providerDiscoveryService.test.mjs tests/heartbeatPollingService.test.mjs`

Expected: FAIL because the presence-first orchestrator does not exist.

- [ ] **Step 3: Implement the provider discovery orchestrator**

Create `providerDiscoveryService.ts` that:
- polls `/api/p2p/presence` every `10s`
- uses the service identity join order from the spec: `service.providerGlobalMetaId` first, then legacy `service.globalMetaId`
- keeps the renderer-facing snapshot shape stable:

```typescript
type DiscoverySnapshot = {
  onlineBots: Record<string, number>;
  availableServices: any[];
  providers: Record<string, {
    key: string;
    globalMetaId: string;
    address: string;
    lastSeenSec: number | null;
    lastCheckAt: number | null;
    lastSource: string | null;
    lastError: string | null;
    online: boolean;
    optimisticLocal: boolean;
  }>;
};
```

- [ ] **Step 4: Rewire `main.ts` to use the new service without changing renderer IPC**

Update the current call sites that read discovery state:
- startup scheduler around `getHeartbeatPollingService().startPolling(...)`
- `heartbeat:getDiscoverySnapshot`
- discovery event emission
- delegation lookups that currently read `getHeartbeatPollingService().availableServices`

Keep IPC names unchanged in phase 1:
- `heartbeat:getDiscoverySnapshot`
- `heartbeat:discoveryChanged`

Emit `heartbeat:discoveryChanged` only when the normalized snapshot materially changes or a manual refresh explicitly asks for a rebroadcast.

- [ ] **Step 5: Re-run the focused discovery tests**

Run: `npm run compile:electron && node --test tests/providerDiscoveryService.test.mjs tests/heartbeatPollingService.test.mjs`

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git -C "$IDBOTS_ROOT" add src/main/services/providerDiscoveryService.ts src/main/main.ts tests/providerDiscoveryService.test.mjs tests/heartbeatPollingService.test.mjs
git -C "$IDBOTS_ROOT" commit -m "feat: switch provider discovery to p2p presence first"
```

### Task 6: Preserve Orderability Gates And MetaBot Lifecycle Hooks

**Files:**
- Create: `src/main/services/providerPingService.ts`
- Modify: `src/main/main.ts`
- Create: `tests/providerPingService.test.mjs`
- Modify: `tests/remoteDelegation.test.mjs`

- [ ] **Step 1: Write the failing provider ping tests**

Extract the current `PING/PONG` path into a service with injected dependencies, then test:

```javascript
test('provider ping resolves true when pong arrives before timeout', async () => {
  // injected sendMessage succeeds, injected reply poller yields "pong"
});

test('provider ping resolves false when timeout expires without pong', async () => {
  // reply poller never yields pong
});
```

- [ ] **Step 2: Run the provider ping tests to verify they fail**

Run: `npm run compile:electron && node --test tests/providerPingService.test.mjs`

Expected: FAIL because the extracted service does not exist yet.

- [ ] **Step 3: Add the delegation availability regression**

Extend `tests/remoteDelegation.test.mjs` with a narrow regression around the orderability gate:

```javascript
it('treats a service missing from availableServices as offline even when it still exists in the DB list', async () => {
  // availableServices excludes the provider
  // fallback DB row exists
  // expect the guard to reject ordering with an offline-style result
});
```

- [ ] **Step 4: Run the delegation regression to verify it fails or is missing**

Run: `npm run compile:electron && node --test tests/remoteDelegation.test.mjs tests/providerPingService.test.mjs`

Expected: FAIL until the extracted pre-order gate is wired up.

- [ ] **Step 5: Implement the lifecycle hooks and extracted ping service**

In `main.ts`:
- replace inline `PING/PONG` flow with `providerPingService`
- call `syncP2PRuntimeConfig(...)` on:
  - app startup before local `man-p2p` spawn
  - `heartbeat:toggle`
  - MetaBot create/import/restore/delete
  - MetaBot updates that change `globalmetaid`

Do not disable existing heartbeat publishing in phase 1; fallback read-path depends on it.

- [ ] **Step 6: Re-run the focused orderability tests**

Run: `npm run compile:electron && node --test tests/providerPingService.test.mjs tests/remoteDelegation.test.mjs`

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git -C "$IDBOTS_ROOT" add src/main/services/providerPingService.ts src/main/main.ts tests/providerPingService.test.mjs tests/remoteDelegation.test.mjs
git -C "$IDBOTS_ROOT" commit -m "feat: preserve orderability gates and runtime config lifecycle hooks"
```

### Task 7: Sync Bundled Binaries And Run Cross-Repo Verification With Testing Subagents

**Files:**
- Modify: `resources/man-p2p/man-p2p-darwin-arm64`
- Modify: `resources/man-p2p/man-p2p-win32-x64.exe`
- Modify: `resources/man-p2p/bundle-manifest.json`

- [ ] **Step 1: Build the updated `man-p2p` binaries**

Run:

```bash
make -C "$MAN_P2P_ROOT" build-darwin-arm64
make -C "$MAN_P2P_ROOT" build-windows-amd64
```

Expected: both binaries land in `$MAN_P2P_ROOT/dist/`.

- [ ] **Step 2: Sync the new binaries into IDBots**

Run:

```bash
cd "$IDBOTS_ROOT"
npm run sync:man-p2p -- --source "$MAN_P2P_ROOT"
```

Expected: `resources/man-p2p/*` and `resources/man-p2p/bundle-manifest.json` update to the new `man-p2p` commit.

- [ ] **Step 3: Use a dedicated testing subagent for the `man-p2p` verification batch**

Run in the testing subagent:

```bash
cd "$MAN_P2P_ROOT"
CGO_ENABLED=0 go test ./p2p -run 'TestLoadConfigIncludesPresenceGlobalMetaIDs|TestReloadConfigUpdatesPresenceGlobalMetaIDs|TestPresenceCacheCanonicalizesGlobalMetaID|TestPresenceCacheUsesReceiveTimeAndClampsTTL|TestBootstrapReconnectLoopReconnectsAfterDisconnect|TestPresenceAnnouncementPropagatesAndExpires|TestConnectBootstrapNodesRetriesUntilPeerBecomesAvailable' -count=1 -v
CGO_ENABLED=0 go test ./api -run 'TestP2PPresenceEndpointReturnsHealthySnapshot|TestP2PPresenceEndpointReportsNoActivePeersAsUnhealthy|TestP2PStatusEndpoint|TestP2PPeersEndpoint|TestConfigReloadEndpoint' -count=1 -v
```

Expected: PASS

- [ ] **Step 4: Use a dedicated testing subagent for the IDBots verification batch**

Run in the testing subagent:

```bash
cd "$IDBOTS_ROOT"
npm run compile:electron
node --test tests/p2pConfigService.test.mjs tests/p2pRuntimeConfigSync.test.mjs tests/p2pPresenceClient.test.mjs tests/providerDiscoveryService.test.mjs tests/heartbeatPollingService.test.mjs tests/providerPingService.test.mjs tests/remoteDelegation.test.mjs
```

Expected: PASS

- [ ] **Step 5: After the separate Go/C baseline repair lands, run the final broader verification**

Run in a fresh testing subagent after the unrelated build issue is fixed:

```bash
cd "$MAN_P2P_ROOT"
go test ./...
cd "$IDBOTS_ROOT"
npm run lint
```

Expected: PASS

- [ ] **Step 6: Commit the bundled binary sync in IDBots**

```bash
git -C "$IDBOTS_ROOT" add resources/man-p2p/man-p2p-darwin-arm64 resources/man-p2p/man-p2p-win32-x64.exe resources/man-p2p/bundle-manifest.json
git -C "$IDBOTS_ROOT" commit -m "chore: sync bundled man-p2p presence binaries"
```

- [ ] **Step 7: Record manual acceptance evidence**

Capture the following in the execution notes:
- two nodes join the same P2P overlay
- presence appears on the observer within `30-60s`
- stopping the source node expires online state within TTL
- healthy empty presence does not trigger heartbeat fallback
- unhealthy presence does trigger heartbeat fallback
- `PING/PONG` failure still blocks ordering even when discovery shows online
