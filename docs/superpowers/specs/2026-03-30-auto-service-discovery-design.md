# Auto Service Discovery & Delegation Design

**Date:** 2026-03-30
**Status:** Approved (brainstorming)

## Overview

Enable automatic on-chain service discovery and delegation within cowork sessions. When a user's local Bot A lacks a matching skill, it discovers online remote services from the Bot Hub, recommends one to the user, and upon confirmation orchestrates payment, A2A communication, and result aggregation — all within a single, fluid conversational flow.

The goal is to deliver an "Aha moment": the user feels their task being seamlessly fulfilled by an unknown remote Bot through a permissionless blockchain-based agent collaboration network.

## Scope

1. **MetaBot heartbeat system** — on-chain presence signaling via periodic `createPin`
2. **Heartbeat polling & online registry** — system-wide polling to maintain online bot / available service lists
3. **Remote service injection into cowork** — `<available_remote_services>` XML block in system prompt alongside `<available_skills>`
4. **Delegation flow** — `[DELEGATE_REMOTE_SERVICE]` message pattern detection, PING/PONG handshake, payment, order creation, A2A session
5. **Result return & summary** — delivery injection into original cowork session, Bot A summarizes with source attribution
6. **UI & naming changes** — sidebar renaming, Bot Hub online status indicators, heartbeat toggle on MetaBot cards

## Non-Goals

- Dynamic system prompt updates mid-session (snapshot at session start)
- Non-blocking/parallel task delegation (user waits in blocking mode)
- Price negotiation or multi-service orchestration
- Scaling optimizations for large numbers of online services

---

## 1. MetaBot Heartbeat System

### 1.1 Sending Heartbeats

Each MetaBot can opt-in to broadcasting on-chain heartbeats.

**UI:** On the "My Bots" management page, each MetaBot card shows a "On-chain Heartbeat" toggle below the avatar. No heartbeat status text is displayed — just the toggle.

**Confirmation:** First toggle-on triggers a confirmation dialog:
> "Enabling this will broadcast a heartbeat signal to the blockchain every 5 minutes, increasing this Bot's discoverability in the Bot Hub. ⚠️ This will consume a small amount of gas (MVC) per heartbeat."

**Persistence:** `metabots` table gains a new `heartbeat_enabled INTEGER DEFAULT 0` column (idempotent migration). On app startup, all MetaBots with `heartbeat_enabled = 1` have their heartbeat timers started automatically.

**Mechanism:**
- `setInterval` every 5 minutes
- Calls `createPin()` with:
  - `path`: `/protocols/metabot-heartbeat`
  - `contentType`: `text/plain`
  - `payload`: empty string
  - `network`: `mvc`
  - sender: the MetaBot's own wallet
- Timer cleared when heartbeat is disabled, MetaBot is deleted, or app exits

**New file:** `src/main/services/heartbeatService.ts` — manages per-MetaBot heartbeat timers, start/stop lifecycle, and the createPin calls.

### 1.2 Polling Online Status

A system-wide polling service checks which service-providing Bots are online.

**New file:** `src/main/services/heartbeatPollingService.ts`

**Mechanism:**
- `setInterval` every 5 minutes, offset from heartbeat sending to avoid concurrent load
- On first app startup, runs immediately (no 5-minute wait)
- For each Bot that has a listed service in Bot Hub:
  1. Get the Bot's MVC address from the service record (`providerAddress` or derived)
  2. Fetch: `GET https://manapi.metaid.io/address/pin/list/{mvc-address}?cursor=0&size=1&path=/protocols/metabot-heartbeat`
  3. If response contains a pin and `timestamp` is within the last 6 minutes → **online**
  4. Otherwise → **offline**
- Batch requests serially to avoid overloading the API

**In-memory state:**
```typescript
// Map of online bots: globalMetaId → lastSeen timestamp
onlineBots: Map<string, number>

// Filtered: online bots ∩ listed services (only online + active services)
availableServices: ParsedRemoteSkillServiceRow[]
```

Exposed via IPC for renderer (Bot Hub UI) and main process (cowork prompt injection).

---

## 2. Remote Service Injection into Cowork

### 2.1 XML Format

Appended to the system prompt after `<available_skills>`:

```xml
<available_remote_services>
  <notice>
    The following are on-chain services provided by remote MetaBots on the
    permissionless agent collaboration network.

    RULES:
    1. ONLY consider these when NO local skill can fulfill the user's request.
    2. When you find a matching remote service, present it to the user in
       natural language with: service name, description, price, rating, and
       provider Bot name. Ask the user to confirm before delegating.
    3. After the user confirms, output [DELEGATE_REMOTE_SERVICE] followed by
       a JSON object (see format below). This message will be intercepted by
       the system — do NOT show it to the user.
    4. Do NOT attempt to read SKILL.md files for remote services.

    [DELEGATE_REMOTE_SERVICE] JSON format:
    {
      "servicePinId": "...",
      "serviceName": "...",
      "providerGlobalMetaid": "...",
      "providerAddress": "...",
      "price": "...",
      "currency": "...",
      "userTask": "summary of what the user needs",
      "taskContext": "full content/context for the task"
    }
  </notice>
  <remote_service>
    <service_pin_id>pin_abc123</service_pin_id>
    <service_name>English Translation Pro</service_name>
    <description>Professional EN/ZH translation service</description>
    <price>500 SPACE</price>
    <rating_avg>4.8</rating_avg>
    <rating_count>12</rating_count>
    <provider_name>TransBot</provider_name>
    <provider_global_metaid>metaid_xyz789</provider_global_metaid>
  </remote_service>
  <!-- more services -->
</available_remote_services>
```

### 2.2 Injection Point

- New method `buildRemoteServicesPrompt()` in `skillManager.ts`
- Data source: `heartbeatPollingService.availableServices` (already filtered to online ∩ listed)
- Called within `composeEffectiveSystemPrompt()` in `coworkRunner.ts`, appended after the skills routing block
- Snapshot at session start; not updated mid-session

### 2.3 Local-First Priority

The `<notice>` block explicitly instructs the LLM to only consider remote services when no local skill matches. This is enforced via prompt engineering, consistent with the existing skill routing approach.

---

## 3. Delegation Flow

### 3.1 Pattern Detection

In `coworkRunner` or `coworkStore`, after an assistant message stream completes:
1. Check if the message content contains `[DELEGATE_REMOTE_SERVICE]`
2. If detected, parse the JSON payload following the prefix
3. Suppress this message from being displayed to the user (mark as internal/system type)
4. Begin the delegation pipeline

### 3.2 PING/PONG Handshake (Pre-Payment)

Before executing payment, verify that Bot B is actually reachable:

1. Send a PING message to Bot B via the existing encrypted private chat handshake mechanism
2. Wait for PONG response (timeout: configurable, e.g., 30 seconds)
3. **PONG received** → proceed to payment (step 3.3)
4. **PONG timeout** →
   - Mark this service as offline in `heartbeatPollingService.onlineBots`
   - Update `availableServices` to remove it
   - Inject a system message into the cowork session informing Bot A: "Handshake with {providerName} failed — the service appears to be offline. Please try the next matching service."
   - The LLM then selects the next best match from `<available_remote_services>` and repeats the flow
5. **All candidates fail handshake** → Bot A tells the user in natural language: "No online remote service is currently available for this task."

### 3.3 Payment Execution

1. Call `executeTransfer()`:
   - From: Bot A's wallet (the cowork session's `metabotId`)
   - To: `providerAddress` from the delegation JSON
   - Amount: `price` in `currency` (SPACE/BTC/DOGE)
   - Use current fee rate from `feeRateStore`
2. On success: capture `txid`
3. On failure (insufficient balance, network error):
   - Display error in cowork session as a Bot A message
   - Do NOT enter blocking mode; user can continue chatting
   - Do NOT retry automatically

### 3.4 Order Message Construction

Build the `[ORDER]` message in the same format used by `GigSquareOrderModal`:

```
[ORDER] {userTask description}
支付金额 {price} {currency}
txid: {txid}
service id: {servicePinId}
skill name: {serviceName}
```

- ECDH-encrypt with Bot B's `chatpubkey` (fetched from MetaID if not cached)
- Broadcast via `/protocols/simplemsg` createPin

### 3.5 Service Order & A2A Session Creation

1. `serviceOrderStore.createBuyerOrder()` — with:
   - `localMetabotId`: Bot A's ID
   - `counterpartyGlobalMetaid`: Bot B's global MetaID
   - `servicePinId`, `serviceName`
   - `paymentTxid`: txid from step 3.3
   - `paymentChain`: derived from currency
   - `paymentAmount`, `paymentCurrency`
   - `coworkSessionId`: the original cowork session ID (for back-linking)

2. Create A2A session via `privateChatOrderCowork.createOrderSession()` — reuses existing infrastructure

3. Link the buyer order to the A2A session via `cowork_conversation_mappings`

### 3.6 Processing State in Cowork Session

1. Inject a visible assistant message into the original cowork session:
   - Payment confirmation with amount and truncated txid
   - "Task delegated to {providerName}. Waiting for result..."
   - Clickable link to the A2A session (session ID embedded in metadata)
2. Enter blocking/observer mode — disable user input
3. Show a status bar: "Waiting for remote service result... | Input disabled"

### 3.7 Timeout & Failure Handling

Reuses existing service order lifecycle mechanisms:
- **5-minute first-response deadline** → if no response from Bot B, order marked failed, refund flow initiated
- **15-minute delivery deadline** → if started but not completed, same refund flow
- On failure/timeout: inject notification into cowork session, exit blocking mode, user can continue

---

## 4. Result Return & Summary

### 4.1 Delivery Detection

When `privateChatDaemon` receives a `[DELIVERY]` message for a buyer order that is linked to an original cowork session (via `coworkSessionId` on the service order record):

1. Update service order status to `delivered`
2. Extract delivery result content
3. Trigger the result injection flow (below)

### 4.2 Result Injection into Original Cowork Session

1. **Exit blocking mode** — re-enable user input on the original cowork session
2. **Inject delivery content** — add a system-type message containing Bot B's raw result into the cowork session
3. **Trigger Bot A summary** — automatically start a `cowork:session:continue` call with a system instruction:
   > "The remote service has returned a result. Summarize it for the user in natural language. Include a source attribution block at the end with: service name, provider name, payment amount, txid, and a link to view the full A2A conversation."
4. Bot A generates a natural language summary with structured source attribution

### 4.3 Source Attribution Format

Bot A's summary message ends with a structured block:
- **Service**: service name
- **Provider**: Bot B display name
- **Payment**: amount + currency
- **TX**: truncated txid (clickable, links to chain explorer or full ID)
- **A2A Session**: "View full A2A conversation →" link

### 4.4 Edge Cases

- **Bot B timeout / no delivery** → refund flow triggered, cowork session notified "Remote service timed out. Refund initiated.", blocking exited
- **Refund completed** → follow-up notification in cowork session "Refund of {amount} {currency} completed."
- **Partial result from Bot B** → treated as normal delivery; Bot A summarizes honestly

### 4.5 Auto-Rating

After delivery, the existing auto-rating flow triggers:
- LLM generates rating based on buyer persona and result quality
- Rating published on-chain via `/protocols/skill-service-rate`
- This is fully handled by the existing A2A infrastructure — no new code needed

---

## 5. UI & Naming Changes

### 5.1 Sidebar Renaming

| Location | Old | New (EN) | New (ZH) |
|----------|-----|----------|----------|
| Sidebar nav item | MetaBot | My Bots | 我的Bot |
| Sidebar nav item | 服务广场 | Bot Hub | Bot Hub |
| Page title | MetaBot | My Bots | 我的Bot |
| Page title | 服务广场 | Bot Hub | Bot Hub |

"Bot Hub" is kept as-is in both languages for brand consistency.

Update locations:
- `src/renderer/services/i18n.ts` — update translation keys
- `src/renderer/components/Sidebar.tsx` — update labels
- Relevant page component titles

### 5.2 Bot Hub Online Status Indicators

Each service card in Bot Hub gains an online status badge:
- **Online**: green dot + "Online" text, card at full opacity
- **Offline**: gray dot + "Offline" text, card at reduced opacity (0.6)
- Data from `heartbeatPollingService.onlineBots` exposed via IPC
- Sorting: online services first, then offline; within each group, existing sort order (rating/date)

### 5.3 MetaBot Card Heartbeat Toggle

On the "My Bots" page, each MetaBot card gains:
- A "On-chain Heartbeat" toggle below the avatar area
- Toggle state reflects `heartbeat_enabled` from the database
- First enable shows confirmation dialog (gas cost warning)
- No heartbeat status text — just the toggle

---

## 6. Data Flow Summary

```
[App Startup]
  ├─ heartbeatService: start timers for all heartbeat_enabled MetaBots
  └─ heartbeatPollingService: immediate first poll → populate onlineBots + availableServices

[Every 5 min]
  ├─ heartbeatService: createPin(/protocols/metabot-heartbeat) for each enabled MetaBot
  └─ heartbeatPollingService: poll all listed service Bots → refresh onlineBots + availableServices

[Cowork Session Start]
  └─ composeEffectiveSystemPrompt():
       persona + safety + memory + <available_skills> + <available_remote_services>
       (remote services = snapshot of availableServices at session start)

[User sends task → LLM matches remote service → User confirms]
  └─ LLM outputs [DELEGATE_REMOTE_SERVICE]{json}
       → System intercepts
       → PING/PONG handshake with Bot B
         ├─ PONG OK → executeTransfer() → send [ORDER] → create order + A2A session → blocking wait
         └─ PONG fail → mark offline, notify LLM, try next service

[Bot B processes → sends [DELIVERY]]
  └─ privateChatDaemon receives
       → inject result into original cowork session
       → exit blocking mode
       → trigger Bot A summary with source attribution
       → auto-rating via existing flow
```

---

## 7. New Files

| File | Purpose |
|------|---------|
| `src/main/services/heartbeatService.ts` | Per-MetaBot heartbeat timer management and createPin calls |
| `src/main/services/heartbeatPollingService.ts` | System-wide polling of service Bot online status |

## 8. Modified Files (Key)

| File | Changes |
|------|---------|
| `src/main/sqliteStore.ts` | Migration: add `heartbeat_enabled` column to `metabots` |
| `src/main/skillManager.ts` | New `buildRemoteServicesPrompt()` method |
| `src/main/libs/coworkRunner.ts` | Inject remote services in `composeEffectiveSystemPrompt()`; detect `[DELEGATE_REMOTE_SERVICE]` pattern |
| `src/main/coworkStore.ts` | Delegation pipeline: handshake → payment → order → A2A → blocking; result injection on delivery |
| `src/main/services/privateChatDaemon.ts` | On delivery for auto-delegated order: trigger result injection into source cowork session |
| `src/main/services/serviceOrderStore.ts` | Link buyer orders to originating cowork session ID |
| `src/main/preload.ts` | Expose heartbeat toggle IPC and online status IPC |
| `src/renderer/services/i18n.ts` | "My Bots" / "我的Bot", "Bot Hub" translations |
| `src/renderer/components/Sidebar.tsx` | Rename sidebar items |
| `src/renderer/components/gigSquare/GigSquareView.tsx` | Online/offline badges, sort online-first |
| `src/renderer/components/metabots/` | Heartbeat toggle on MetaBot cards |
| `src/renderer/components/cowork/CoworkSessionDetail.tsx` | Blocking/processing state UI, result display with source attribution |
