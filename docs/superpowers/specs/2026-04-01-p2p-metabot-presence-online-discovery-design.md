# P2P MetaBot Presence Online Discovery Design

**Date:** 2026-04-01  
**Project:** IDBots + man-p2p  
**Status:** Proposed for implementation

---

## 1. Purpose

Replace Bot Hub and remote-service online discovery's current chain-heartbeat-first model with a `man-p2p` presence-first model, while keeping:

- `PING/PONG` as the final service-availability confirmation before payment/order
- existing on-chain `/protocols/metabot-heartbeat` as fallback for the discovery read path when local P2P presence is unhealthy or unavailable

This design targets faster and more stable online-state detection for remote services and later MetaBot private-chat online filtering.

---

## 2. Current Problem

Today, IDBots determines whether a provider is online by scanning the latest on-chain `/protocols/metabot-heartbeat` PIN for the provider's address and checking whether it falls within a freshness window.

This has four product costs:

1. it consumes gas continuously for providers that want to remain discoverable
2. chain aggregation delay can produce false offline/online judgments
3. service discovery is slower than the actual P2P runtime state
4. the discovery mechanism is tied to blockchain indexing semantics rather than network reachability semantics

At the same time, `man-p2p` already embeds a libp2p runtime, already exposes local peer state, and already runs on two public production nodes that have proven P2P transport between nodes.

---

## 3. Goals

### 3.1 Primary Goal

Make provider online discovery in IDBots use `man-p2p` online presence as the primary truth source.

### 3.2 Functional Goals

- discover online providers within roughly `30-60s`
- remove chain heartbeat from the primary online-discovery path
- keep current Bot Hub service listing semantics:
  - service definitions still come from chain-indexed service publication data
  - service availability becomes `service published` + `provider MetaBot online`
- preserve current `PING/PONG` handshake as the final pre-order gate
- preserve chain heartbeat as a fallback path only

### 3.3 Secondary Goal

Make the same P2P presence layer reusable for later MetaBot private-chat online filtering.

---

## 4. Non-Goals

This phase does **not** attempt to:

- replace service publication / service indexing with P2P
- infer service-level availability directly from `servicePinId`
- remove the existing chain heartbeat toggle or rename it
- guarantee full-network visibility beyond the current P2P topology limits
- solve every NAT/relay topology issue in this same feature

However, one known networking gap must be fixed because it materially affects presence stability:

- bootstrap auto-reconnect must be added; startup-only bootstrap dialing is not sufficient

---

## 5. Key Product Decisions

### 5.1 Online Semantics Are MetaBot-Level

Online state is defined at the `globalMetaId` level, not at the peer level and not at the service level.

- a peer may declare multiple MetaBots as online
- a published service is considered online only if its provider `globalMetaId` is online
- `PING/PONG` remains required before payment/order creation

### 5.2 Only Explicitly Public MetaBots Are Broadcast

The node must **not** broadcast every local MetaBot.

Only MetaBots that are explicitly allowed to be discoverable are announced. In this phase, the single source of truth is the existing `heartbeat_enabled` flag.

Result:

- `heartbeat_enabled = 1` means "this MetaBot is willing to be discoverable online"
- the same flag drives:
  - existing chain heartbeat fallback behavior
  - new P2P presence broadcasting

No separate `presence_enabled`, `service_enabled`, or `private_chat_enabled` flags are introduced in this phase.

### 5.3 Presence Must Be Independent From PIN Gossip

Presence uses a dedicated pubsub topic, not the existing PIN announcement topic.

Reasons:

- presence is ephemeral and TTL-driven
- PIN gossip is content/index driven and durable in meaning
- mixing the two would create semantic confusion around storage, expiry, and fallback

### 5.4 Fallback Is Presence-Unhealthy Only

IDBots falls back to chain heartbeat only when P2P presence is unhealthy.

If P2P presence is healthy and returns an empty online set, that empty result is authoritative and must **not** trigger chain fallback.

---

## 6. Presence Protocol

### 6.1 Topic

Add a dedicated topic in `man-p2p`, for example:

- `metaid-presence-v1`

The exact string is implementation-defined, but it must be versioned from day 1.

### 6.2 Announcement Payload

`v1` keeps the payload intentionally small and only carries MetaBot-level online identity.

```json
{
  "schemaVersion": 1,
  "peerId": "12D3KooW...",
  "sentAt": 1760000000,
  "ttlSec": 55,
  "runtimeMode": "p2p-only",
  "globalMetaIds": [
    "idq1provideraaa...",
    "idq1providerbbb..."
  ]
}
```

Required fields:

- `schemaVersion`
- `peerId`
- `sentAt`
- `ttlSec`
- `globalMetaIds`

Optional debug field:

- `runtimeMode`

Canonicalization rule:

- phase 1 canonical `globalMetaId` is the existing raw MetaID string form, for example `idq1provideraaa...`
- do **not** wrap it in a URI-style prefix such as `metaid:`
- before broadcasting, caching, or joining, implementations must normalize by `trim()` + lowercase
- presence payload `globalMetaIds[]`, local MetaBot `globalmetaid`, and synced service-row `providerGlobalMetaId` / legacy `globalMetaId` must all use this same canonical string form

Examples:

- valid canonical form: `idq1provideraaa...`
- invalid for phase 1 join/broadcast: `metaid:idq1provideraaa...`

Receiver trust rules:

- receiver must derive the sending peer from the pubsub transport metadata, not from the payload body
- payload `peerId` is debug-only and may be logged or compared for diagnostics, but must not be used as the authoritative cache key
- receiver must compute expiry from local receive time, not from sender `sentAt`, so normal clock skew does not flap online state
- payload `sentAt` remains useful for debugging only
- phase 1 does **not** cryptographically prove that a peer is authorized to announce every `globalMetaId` it lists
- therefore presence is an advisory discovery signal, not a final trust signal for payment/order or identity-sensitive actions

Phase 1 deliberately excludes:

- `servicePinIds`
- service names
- chat pubkeys
- profile metadata
- per-MetaBot signatures or other cryptographic ownership proofs for announced `globalMetaIds`

Those can be derived elsewhere if needed.

### 6.3 Broadcast Frequency

Recommended defaults:

- start the local broadcast loop immediately after the presence subsystem is initialized
- publish the first announcement immediately after the broadcast loop starts; do not wait for `healthy = true`
- rebroadcast every `20s`
- use `ttlSec = 55`
- add small random jitter such as `+/- 3s`
- IDBots presence API request timeout: `2s`

This gives:

- normal online visibility within roughly `30-60s`
- offline expiry within roughly `55s`
- tolerance for one or two missed broadcasts without flapping

---

## 7. man-p2p Runtime Model

### 7.1 Local Runtime Inputs

`man-p2p` needs an internal runtime config field containing the local MetaBots that should be announced as online.

Add a generated runtime config field such as:

```json
{
  "p2p_presence_global_metaids": [
    "idq1provideraaa...",
    "idq1providerbbb..."
  ]
}
```

This field:

- is written by IDBots
- is not a user-facing manual config field
- is derived from local MetaBots with `heartbeat_enabled = 1` and valid `globalMetaId`

For phase 1, a valid `globalMetaId` means:

- non-empty after `trim()`
- canonicalized to lowercase
- matches the existing raw MetaID string form validated by current IDBots rules, for example `idq1...`, not `metaid:idq1...`

### 7.1.1 Config Write Path And Lifecycle

Phase 1 reuses the existing IDBots-generated runtime config file:

- IDBots treats persisted `p2p_config` in SQLite `kv.p2p_config` as the source of truth for user-editable P2P settings
- config file path remains `app.getPath('userData')/man-p2p-config.json`
- IDBots writes the full merged runtime JSON from that persisted source of truth, including existing P2P config plus `p2p_presence_global_metaids`
- IDBots must also seed the official public bootstrap nodes as the default `p2p_bootstrap_nodes` value for new profiles in persisted `p2p_config`
- after writing the file, IDBots calls `POST /api/config/reload`
- presence membership must hot-reload without requiring a `man-p2p` process restart

Bootstrap defaulting and migration rules:

- the official public bootstrap list is a user-visible default, not a hidden hard-coded override
- new profiles start with the official bootstrap list populated
- legacy profiles that still carry the historical empty default must be migrated one time to the official bootstrap list
- the one-time migration must record a durable migration marker outside the editable bootstrap array itself, for example `p2p.bootstrap_defaults_migrated.v1`
- after that migration has run once, later user edits are authoritative
- if a user intentionally clears `p2p_bootstrap_nodes` to an empty array, IDBots must respect that empty value and must not silently repopulate the official nodes on next launch
- if a user replaces the list with custom bootstrap nodes, IDBots must preserve those custom nodes unchanged

IDBots must recompute and rewrite `p2p_presence_global_metaids` at least on:

- app startup before spawning local `man-p2p`
- `heartbeat_enabled` toggle
- local MetaBot create / import / restore / delete
- any local MetaBot `globalMetaId` change that affects discoverability

If file write succeeds but reload fails:

- IDBots logs the failure
- the existing `man-p2p` in-memory presence membership remains authoritative until the next successful reload or process restart
- `man-p2p` retains the last successfully loaded presence membership
- this does **not** by itself force presence `healthy = false`
- the presence API should surface the problem through an optional diagnostic field such as `lastConfigReloadError`
- IDBots must not silently fall back to chain heartbeat solely because of this write/reload failure while the presence read path still reports `healthy = true`

### 7.2 Presence Cache

`man-p2p` maintains an in-memory cache keyed by:

- `(peerId, globalMetaId)`

Each record stores at least:

- `lastSeenSec`
- `expiresAtSec`

Cache timing semantics:

- `lastSeenSec` means local receive time, not sender `sentAt`
- `expiresAtSec = lastSeenSec + effectiveTtlSec`
- `effectiveTtlSec` comes from payload `ttlSec`, but receiver must clamp it to `1..120` seconds so one bad payload cannot create near-permanent liveness
- phase 1 default sender value is `55`

Aggregation rule:

- a `globalMetaId` is online if any cached record for that `globalMetaId` has not expired

The aggregated response should also preserve:

- `peerIds[]`
- `lastSeenSec`
- `expiresAtSec`

This keeps the cache debuggable and future-proof if one MetaBot is later announced from more than one peer.

Expected scale for phase 1:

- desktop nodes usually announce only a small set of local MetaBots
- remote cache size is expected to stay in the tens to low hundreds of active `(peerId, globalMetaId)` records in normal operation
- cache must be TTL-pruned and memory-only; do not persist historical presence records to disk in phase 1

### 7.3 Runtime Health

Presence health should be reported separately from simple process liveness.

Phase 1 distinguishes:

- presence subsystem ready: local broadcaster, subscriber, and TTL cache loop are initialized and may already send/receive announcements
- discovery healthy: local node is currently capable of remote discovery and may suppress heartbeat fallback

The presence API should only report `healthy = true` when:

- `man-p2p` process is up
- host/pubsub presence subsystem initialized successfully
- local time-based cache and periodic broadcast loop are running
- the local discovery overlay is currently usable for remote discovery, meaning `peerCount >= 1`

If the presence subsystem is not initialized, the API should report `healthy = false`.

Phase 1 discovery-health rule:

- `peerCount` means the current count of active libp2p peer connections as observed by the local host network; bootstrap peers count like any other connected peer
- `peerCount = 0` means presence discovery is currently unhealthy, even if the broader P2P runtime is otherwise alive
- this is intentionally narrower than the existing `/api/p2p/status` runtime truth model, where `0 peers` may still be a healthy peerless runtime state
- reason: provider discovery must fall back when the overlay is disconnected and cannot observe remote announcements
- phase 1 does not require a separate "connected bootstrap" test beyond `peerCount >= 1`; any active libp2p peer connection is sufficient to treat the overlay as usable for discovery
- IDBots must not reuse the renderer P2P badge truth model as the discovery fallback gate; discovery health is a separate contract

---

## 8. man-p2p HTTP API

Add a new endpoint:

- `GET /api/p2p/presence`

Suggested response:

```json
{
  "code": 1,
  "message": "ok",
  "data": {
    "healthy": true,
    "nowSec": 1760000000,
    "peerCount": 2,
    "unhealthyReason": null,
    "lastConfigReloadError": null,
    "onlineBots": {
      "idq1provideraaa...": {
        "lastSeenSec": 1759999988,
        "expiresAtSec": 1760000043,
        "peerIds": ["12D3KooW..."]
      }
    }
  }
}
```

Required response semantics:

- success envelope remains `{ code: 1, message: "ok", data: ... }`
- `healthy` is mandatory in `data`
- `onlineBots` is mandatory in `data`
- `peerCount` is mandatory in `data` and uses the phase 1 definition from Section 7.3
- each `onlineBots` key must be the canonical lowercase raw `globalMetaId` string, for example `idq1provideraaa...`
- a healthy empty set is valid and authoritative
- when `healthy = false`, `unhealthyReason` should be populated with a short machine-readable reason such as `presence_not_initialized` or `no_active_peers`
- optional diagnostics such as `lastConfigReloadError` may be included without changing the fallback rule

---

## 9. Networking Hardening Requirement

Current bootstrap logic only retries on startup/reload. This is insufficient for stable online detection.

Phase 1 must add a background bootstrap redial loop in `man-p2p` that:

- periodically checks configured bootstrap peers
- clears dial backoff when appropriate
- reconnects when a configured bootstrap peer is disconnected
- avoids hot-looping when peers are healthy

This is required because presence quality depends on stable overlay connectivity, not just initial startup success.

Relay-service hardening is **not** a hard requirement for this phase, but:

- current public nodes are enough as bootstrap nodes for real-network validation
- relay-service capability should be explicitly verified or deferred, not assumed implicitly

---

## 10. IDBots Discovery Model

### 10.1 Keep External Business Semantics Stable

IDBots should keep the renderer-facing business semantics as close to the current model as possible.

The current outputs remain:

- `onlineBots`
- `availableServices`
- provider debug state

The implementation changes underneath, but the business outputs should remain stable so renderer churn stays low.

For phase 1, the stable snapshot contract remains equivalent to the current IDBots discovery snapshot:

- `onlineBots: Record<string, number>`
- `availableServices: any[]`
- `providers: Record<string, ProviderState>`

### 10.2 Discovery Flow

Recommended provider discovery order:

1. fetch local P2P presence from `man-p2p`
2. if presence API is healthy:
   - build `onlineBots` from presence
   - build `availableServices` by filtering published services by provider `globalMetaId`
3. if presence API is unhealthy:
   - fall back to the existing chain-heartbeat polling logic

IDBots should keep the current snapshot-plus-event model, but the presence-first backend refresh cadence should be tighter than the legacy heartbeat cadence:

- poll `GET /api/p2p/presence` every `10s`
- continue emitting the same discovery snapshot shape to renderer listeners only when the snapshot materially changes or a manual refresh is requested
- renderer subscription semantics stay unchanged in phase 1

Fallback path retention rule:

- in phase 1, MetaBots with `heartbeat_enabled = 1` continue publishing the existing on-chain `/protocols/metabot-heartbeat`
- therefore chain-heartbeat fallback remains functionally armed after the discovery path switches to presence-first
- this means phase 1 improves discovery correctness first, but does **not** yet eliminate heartbeat gas cost

### 10.3 Service Availability Rule

For Bot Hub and remote-service selection:

- service publication still comes from remote service sync data
- service availability becomes:
  - service row exists and is current
  - provider `globalMetaId` is online according to discovery

### 10.3.1 Provider Identity Join Source

IDBots should reuse the provider identity already normalized into synced remote service rows.

Phase 1 join order is:

1. prefer `service.providerGlobalMetaId`
2. if absent, allow the current in-memory compatibility alias `service.globalMetaId`
3. do **not** add a new address-to-`globalMetaId` lookup step in discovery

Remote service sync already derives `providerGlobalMetaId` from:

- chain item `globalMetaId`, when present
- otherwise parsed content-summary field `providerMetaBot`, when present

Planning assumption for phase 1:

- presence-first availability filtering joins against the existing normalized `providerGlobalMetaId` field already stored on synced service rows
- service rows lacking both `providerGlobalMetaId` and legacy `globalMetaId` are not eligible to become online via P2P presence and should not appear in `availableServices`
- therefore this feature does not require a new provider-identity database migration solely for the join

### 10.4 Pre-Order Confirmation Rule

`PING/PONG` remains the final gate before payment/order flow.

Meaning:

- presence online: candidate is shown and may be selected
- `PING/PONG` success: order flow may proceed
- `PING/PONG` failure: UI must treat provider as unreachable for ordering, even if presence says online

---

## 11. IDBots Flag Reuse

The existing `heartbeat_enabled` flag remains the single user-facing switch for discoverability.

In this phase it means:

- include this MetaBot in P2P presence announcements
- continue sending chain heartbeat if that fallback path is enabled

This preserves current user mental model and avoids introducing multiple overlapping online-state toggles.

No new persisted user-facing status fields are added in phase 1.

---

## 12. Failure Semantics

### 12.1 Presence Healthy + Empty Result

If `GET /api/p2p/presence` returns:

- HTTP `2xx`
- `code = 1`
- `healthy = true`
- `onlineBots = {}`

then that is a **valid empty online result** and must not trigger chain-heartbeat fallback.

### 12.2 Presence Unhealthy

IDBots should fall back to chain heartbeat only when:

- request times out
- request fails at transport level
- HTTP status is non-`2xx`
- JSON envelope is invalid
- JSON envelope `code != 1`
- required `data.healthy` or `data.onlineBots` fields are missing or malformed
- `healthy = false`

### 12.3 Presence/Heartbeat Conflict

When presence is healthy, presence wins.

Chain heartbeat participates only when presence is unhealthy.

### 12.4 Presence Online + Handshake Failure

If presence says online but `PING/PONG` fails:

- keep provider visible as online in general discovery
- treat the provider as not currently orderable
- surface a clear "provider unreachable" ordering error

This preserves the distinction between:

- online discovery
- transactional availability at this instant

### 12.5 Presence Spoofing Limitation

Phase 1 presence announcements are not cryptographically bound to ownership of every announced `globalMetaId`.

Result:

- a malicious peer may falsely announce another provider as online
- this may pollute discovery visibility, but it must not bypass the existing `PING/PONG` gate before payment/order
- this limitation is accepted in phase 1 so the rollout can prioritize stable discovery plumbing first
- stronger authenticity proof is deferred to a later phase

---

## 13. Implementation Boundaries

### 13.1 man-p2p

Expected new or changed areas:

- `p2p/presence.go`
  - new presence topic
  - announcement publish/receive
  - TTL cache
  - aggregation helpers
- `p2p/config.go`
  - add runtime config field for `p2p_presence_global_metaids`
- `api/p2p_api.go`
  - add `GET /api/p2p/presence`
- `app.go`
  - initialize presence service after host/pubsub startup
- `p2p/host.go`
  - add ongoing bootstrap reconnect logic

### 13.2 IDBots

Expected new or changed areas:

- `src/main/services/p2pConfigService.ts`
  - derive `p2p_presence_global_metaids` from `heartbeat_enabled`
- new main-process discovery service, presence-first
  - fetch presence
  - determine fallback
  - output current discovery snapshot shape
- current heartbeat-polling layer
  - retained as fallback path, not removed in phase 1
- GigSquare and delegation flows
  - continue consuming discovery snapshot
  - preserve `PING/PONG` requirement

The renderer should ideally require minimal changes, because the discovery output shape remains stable.

---

## 14. Testing Strategy

### 14.1 man-p2p Tests

Must include:

- presence payload encode/decode
- publish/receive for multiple `globalMetaIds`
- TTL expiry removes online state
- aggregate one `globalMetaId` across multiple peers
- `/api/p2p/presence` contract test
- bootstrap reconnect test

### 14.2 IDBots Tests

Must include:

- presence healthy path populates `onlineBots` and `availableServices`
- presence unhealthy path falls back to heartbeat
- healthy empty presence does not fall back
- GigSquare online indicator and sorting still follow `onlineBots`
- delegation pipeline rejects services not present in online `availableServices`
- `PING/PONG` failure still blocks payment/order flow

### 14.3 End-to-End Acceptance

Acceptance should prove:

1. two nodes join the same P2P network
2. one node broadcasts an online MetaBot
3. the other node sees that MetaBot online within `30-60s`
4. when the source node exits, the other node removes that MetaBot within TTL
5. service list online status and ordering follow P2P presence
6. disabling or breaking presence causes heartbeat fallback to engage

---

## 15. Rollout Strategy

Recommended rollout:

1. ship `man-p2p` presence support first
2. validate it against the two existing public nodes plus desktop nodes
3. switch IDBots discovery to presence-first with heartbeat fallback still enabled
4. observe behavior before changing any user-facing wording around heartbeat

This keeps rollback simple:

- if presence logic regresses, IDBots can fall back to chain heartbeat
- if bootstrap reconnect regresses, the defect is visible early in presence acceptance tests

---

## 16. Acceptance Criteria

This design is considered successfully implemented when all of the following are true:

- `man-p2p` exposes a healthy local presence API
- IDBots uses P2P presence as the primary source for provider online discovery
- `heartbeat_enabled` remains the only user-facing discoverability toggle
- Bot Hub service online state follows provider `globalMetaId` online presence
- `PING/PONG` remains the final pre-order confirmation
- chain heartbeat remains available as fallback only
- offline transitions happen within roughly `30-60s`
- bootstrap reconnect no longer depends only on process startup

---

## 17. Future Extensions

Once this phase is stable, later phases may add:

- optional `servicePinIds` in presence payloads
- private-chat UX that filters candidate MetaBots by presence
- richer presence diagnostics in renderer
- optional de-emphasis or retirement of chain heartbeat in product UI
