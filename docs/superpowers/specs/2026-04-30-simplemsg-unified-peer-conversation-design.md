# Simplemsg Unified Peer Conversation Design

**Date:** 2026-04-30
**Project:** IDBots
**Status:** Confirmed design, pending implementation plan

---

## 1. Goal

The final product model is:

> simplemsg peer conversation first, order lifecycle as tagged events inside the conversation.

For any local MetaBot and remote peer, all `/protocols/simplemsg` messages should appear in one A2A conversation window. Ordinary private chat and service-order traffic are not separate user-facing conversations. Service orders are protocol events within the same encrypted private-message timeline.

After this change:

- A user sees ordinary private chat, order start, status updates, delivery, rating request, rating response, and order end in one window.
- Order-specific views open the same peer conversation and focus/filter an `orderTxid`, instead of opening a separate order session.
- The service-order state machine remains explicit and reliable.
- Ordinary private-chat auto-reply policy does not interfere with active orders.
- Existing user data is preserved and migrated or projected safely.

---

## 2. Current Problem

Today the code treats the same chain protocol as two UI/session concepts:

- `metaweb_private`: ordinary private-chat A2A session.
- `metaweb_order`: separate order observer session.

This split is artificial because the protocol and raw storage are already unified:

- All user-facing messages are `/protocols/simplemsg`.
- They are encrypted private messages between the same two MetaWeb identities.
- Raw listener data lands in `private_chat_messages`.
- Order semantics are carried by text-level tags such as `[ORDER]`, `[DELIVERY]`, `[NeedsRating]`, and `[ORDER_END]`.

The split creates ambiguous routing. If a message has incomplete metadata, legacy shape, or arrives outside the expected order observer path, it can render in the wrong place or as internal state. It also creates product friction: real cooperation happens in one conversation, while the UI asks users to think in two conversations.

---

## 3. Confirmed Decisions

### 3.1 Canonical Display Session

The canonical user-facing A2A session is one direct simplemsg peer session:

```text
metabotId + peerGlobalMetaId -> one A2A conversation window
```

Use the existing `metaweb_private` direct conversation as the canonical display session. Do not introduce a third long-lived display channel in the first implementation.

### 3.2 Order Mapping Becomes an Index

`metaweb_order` mappings should no longer imply a separate displayed conversation.

They should become order indexes that point to the same canonical peer session:

```text
metaweb_order:<role>:<metabotId>:<peerGlobalMetaId>:<orderTxid-prefix>
  -> cowork_session_id of the peer's metaweb_private session
```

`service_orders` remains the business source of truth for order status, settlement, timeout, delivery, rating, refund, and completion.

### 3.3 Order Mode Is Message-Level, Not Session-Level

There is no "enter order window" or "exit order window" state.

Instead:

- `[ORDER]` starts a specific order lifecycle.
- `orderTxid` identifies the lifecycle.
- `[ORDER_STATUS:<orderTxid>]`, `[DELIVERY:<orderTxid>]`, `[NeedsRating:<orderTxid>]`, and `[ORDER_END:<orderTxid> reason]` are events in that lifecycle.
- Ordinary messages without order tags remain ordinary private chat messages, even when visually near an order.

### 3.4 Active Order Suppresses Ordinary Auto-Reply

If a peer has any active order with the local MetaBot, incoming non-protocol ordinary private-chat messages from that peer:

- are displayed in the same peer conversation,
- are persisted with chain metadata,
- do not trigger the ordinary private-chat auto-reply policy,
- do not mutate order state unless they carry an explicit order protocol tag.

This avoids ordinary chat LLM responses interfering with an unfinished service order.

When all active orders with that peer are ended, ordinary private-chat auto-reply behavior resumes.

### 3.5 Protocol Messages Bypass Private-Chat Reply Policy

Order protocol messages must be processed by the order state machine before any ordinary private-chat policy:

- `[ORDER]`
- `[ORDER_STATUS:<orderTxid>]`
- `[DELIVERY:<orderTxid>]`
- `[NeedsRating:<orderTxid>]`
- `[ORDER_END:<orderTxid> reason]`

These messages should not be subject to ordinary private-chat stranger gating, latest-message-only skipping, no-op text skipping, or `byeSent` suppression.

### 3.6 `bye` Is Not Order End

`bye` belongs to ordinary private-chat auto-reply policy.

`[ORDER_END:<orderTxid> reason]` belongs to service-order lifecycle.

If a conversation has `byeSent=true`, incoming order protocol messages still must be handled. A later ordinary private-chat message may still be suppressed according to the existing private-chat close/restart policy, but order events cannot be dropped because of `bye`.

---

## 4. Protocol Semantics

### 4.1 Order Start

`[ORDER]` starts a new order lifecycle.

The canonical order identifier is the simplemsg txid of the `[ORDER]` message:

```text
orderTxid = private_chat_messages.tx_id for the [ORDER] simplemsg
```

This supports both paid and free orders. Payment txid is order payment metadata, not the lifecycle id.

### 4.2 Order Events

All non-start order events should be scoped by order txid:

```text
[ORDER_STATUS:<orderTxid>] <text>
[DELIVERY:<orderTxid>] <json payload>
[NeedsRating:<orderTxid>] <text>
[ORDER_END:<orderTxid> reason] <optional text>
```

Legacy unscoped forms remain parseable for backward compatibility:

```text
[DELIVERY] <json payload>
[NeedsRating] <text>
[ORDER_END reason] <optional text>
```

But new outgoing messages must use scoped forms whenever `orderTxid` is known.

### 4.3 Active Order Definition

An order is active for ordinary-private-chat suppression when any of the following is true:

1. `service_orders.status` is one of:

- `awaiting_first_response`
- `in_progress`
- `rating_pending`
- `refund_pending`

2. `service_orders.status = 'failed'` and the buyer-side refund request is still unresolved:

```text
role = 'buyer'
refund_request_pin_id IS NULL
refund_txid IS NULL
refund_completed_at IS NULL
```

This covers the retry window after `markFailed()` and before a refund request pin is successfully created. During that window the commercial interaction is still unresolved, so ordinary private-chat auto-reply should remain suppressed.

Existing schema does not have a separate `ended` status. A normal order end is represented by:

```text
status = 'completed'
order_ended_at IS NOT NULL
order_end_reason = <reason>
```

Terminal statuses for auto-reply resumption are:

- `completed`
- `refunded`
- `failed`, only when it is not a buyer-side refund-request retry state

For rating-aware orders, successful delivery should not immediately make the order inactive. Delivery moves the order to rating-pending semantics. The order remains active until either:

- the buyer sends rating and `[ORDER_END:<orderTxid> rated]`,
- seller sends `[ORDER_END:<orderTxid> rating_timeout]` after the configured rating timeout,
- seller sends `[ORDER_END:<orderTxid> <reason>]` for another supported terminal reason.

`refund_pending` should continue to suppress ordinary auto-replies because the commercial interaction is not settled yet. After refund completion, `refunded` is terminal and ordinary private-chat policy can resume.

### 4.4 Non-Protocol Messages During Active Orders

When a peer has active orders and sends text without an order protocol tag:

- Store and display it as ordinary private chat.
- Do not auto-reply with ordinary private-chat LLM.
- Do not guess the order if multiple active orders exist.
- If exactly one active order exists, UI may show a subtle association to that order, but business state must not depend on that guess.

This rule keeps protocol-driven automation deterministic while preserving human-readable context.

---

## 5. Data Model

### 5.1 Raw Message Table

`private_chat_messages` remains the raw chain message table.

No new raw table is needed.

### 5.2 Cowork Session

The canonical display session should be the direct peer session:

```text
cowork_sessions.session_type = 'a2a'
cowork_sessions.metabot_id = local MetaBot id
cowork_sessions.peer_global_metaid = remote peer globalMetaId
```

The canonical mapping should be:

```text
cowork_conversation_mappings.channel = 'metaweb_private'
cowork_conversation_mappings.external_conversation_id = metaweb-private:<peerGlobalMetaId>
```

### 5.3 Message Metadata

Messages in the unified peer session should preserve chain metadata and protocol classification.

Recommended metadata fields:

```ts
{
  sourceChannel: 'metaweb_private',
  externalConversationId: 'metaweb-private:<peerGlobalMetaId>',
  direction: 'incoming' | 'outgoing',
  txid?: string,
  txids?: string[],
  pinId?: string,

  simplemsgKind?: 'private_chat' | 'order_protocol',
  orderProtocolTag?: 'ORDER' | 'ORDER_STATUS' | 'DELIVERY' | 'NeedsRating' | 'ORDER_END',
  orderTxid?: string,
  orderRole?: 'buyer' | 'seller',
  orderPaymentTxid?: string,
  orderMappingExternalConversationId?: string
}
```

`sourceChannel` should point to the display channel. Order identity should be explicit fields, not inferred from `sourceChannel`.

### 5.4 Order Index Mapping

Each active or historical order may still have a `metaweb_order` mapping for lookup:

```text
channel = 'metaweb_order'
externalConversationId = metaweb_order:<role>:<metabotId>:<peerGlobalMetaId>:<orderTxid-prefix>
coworkSessionId = canonical peer session id
metadata_json includes role, peerGlobalMetaId, orderTxid, servicePaidTx, service info
```

The important change is that `coworkSessionId` points to the unified peer session.

### 5.5 Service Orders

`service_orders` remains responsible for:

- role (`buyer` or `seller`)
- payment and settlement facts
- order message pin/tx
- delivery message pin
- rating/request/end pins
- timeout state
- refund state
- linked `cowork_session_id`

After migration, `cowork_session_id` should point to the unified peer conversation.

---

## 6. Message Processing Flow

### 6.1 Incoming Simplemsg

Incoming decrypted simplemsg should use this order:

1. Handle handshake messages (`ping`, `pong`) exactly as today.
2. Parse protocol classification:
   - order start
   - order status
   - delivery
   - needs rating
   - order end
   - ordinary private chat
3. Ensure canonical peer session exists.
4. Append the incoming message to canonical peer session with chain metadata.
5. If order protocol:
   - update or create order index mapping,
   - update `service_orders`,
   - run seller or buyer order workflow as needed,
   - do not run ordinary private-chat auto-reply.
6. If ordinary private chat:
   - if peer has active order, display only and mark processed,
   - otherwise evaluate ordinary private-chat policy and maybe auto-reply.

Appending before business handling ensures the UI timeline reflects what actually arrived on-chain, even if subsequent order handling fails.

### 6.2 Outgoing Order Messages

All outgoing order-related simplemsg messages should be appended to the canonical peer session:

- seller acknowledgement
- status update
- delivery
- needs rating
- order end
- failure/refund notices

These messages should carry both chain metadata and order protocol metadata.

### 6.3 Outgoing Ordinary Private Replies

Ordinary auto replies remain in the same canonical peer session and use the existing private-chat chain send path.

They are only generated when:

- the incoming message is not an order protocol message,
- no active order exists for that peer,
- private-chat policy permits reply.

---

## 7. UI Design

### 7.1 Unified Conversation Window

The A2A conversation window should show one timeline:

- ordinary text bubbles,
- order start cards,
- order status bubbles,
- delivery bubbles and media previews,
- rating request/action bubbles,
- order end markers,
- refund/failure notices.

The renderer should not require a separate `metaweb_order` session to display order progress.

After migration, normal conversation navigation should expose only the canonical peer session for a peer. Legacy standalone `metaweb_order` sessions may remain in storage for rollback/audit compatibility, but they should not appear as separate ordinary A2A conversations in the default session list.

### 7.2 Order Entry Points

Order entry points still exist, but they navigate to the unified peer session:

- Bot Hub order list
- refund center
- service order notifications
- delivery/rating status links

If an `orderTxid` is known, the UI should focus that order in the conversation:

- scroll to the `[ORDER]` message,
- optionally enable an order filter,
- optionally highlight messages with the same `orderTxid`.

### 7.3 Filtering

The first implementation should not hide ordinary messages by default.

Optional order filtering can be introduced as a view state:

- all messages
- one order by `orderTxid`

Filtering should never move messages into a different session.

### 7.4 Active Order Notice

When a peer has active orders, the UI may show a subtle state indicator such as:

```text
订单进行中，普通私聊自动回复已暂停
```

This is optional for the first implementation. The required behavior is backend policy suppression, not visible copy.

---

## 8. Memory and Prompting

### 8.1 Memory Scope

Unified simplemsg conversation should use direct contact memory scope, because the peer relationship is direct.

Using canonical `metaweb_private` as `sourceChannel` lets existing memory scope behavior stay aligned with contact-level memory.

### 8.2 Ordinary Private-Chat Prompt

The ordinary private-chat prompt should not be invoked while active orders exist for the peer.

When invoked, it should build context from the unified conversation but may filter out noisy protocol internals:

- keep useful human text,
- summarize order context if relevant,
- avoid injecting raw `[DELIVERY]` JSON as ordinary conversation content unless needed.

### 8.3 Order Prompt

Order execution prompt remains order-specific.

It should receive:

- the `[ORDER]` payload,
- service metadata,
- relevant user request content,
- optional ordinary chat context from the same peer conversation if it helps fulfill the order.

It should not rely on a separate order-only session existing in the UI.

---

## 9. Migration and Compatibility

### 9.1 New Data

For new messages after implementation:

- all simplemsg messages append to the peer `metaweb_private` session,
- all order mappings point to that same session,
- `service_orders.cowork_session_id` points to that same session.

### 9.2 Existing Data

Existing users may have:

- ordinary private-chat sessions,
- separate order observer sessions,
- order rows linked to order sessions,
- messages duplicated or partially backfilled between private and order sessions.

Migration should be idempotent and non-destructive:

1. Ensure a canonical peer session for each `(metabotId, peerGlobalMetaId)`.
2. For each `metaweb_order` mapping, repoint it to the canonical peer session.
3. Repoint matching `service_orders.cowork_session_id` to the canonical peer session.
4. Copy missing order messages into the canonical peer session using `pinId`/`txid` de-duplication.
5. Mark old standalone order sessions as legacy/hidden from normal conversation navigation, without deleting their rows.
6. Preserve old order sessions for compatibility, rollback, audit, or explicit maintenance tooling.

Do not delete user data during the migration.

The expected user-facing result is one visible peer A2A conversation. Legacy order session rows are retained data, not active navigation targets.

### 9.3 De-Duplication

Message merge must use chain identity first:

- same `pinId` means same chain message,
- same `txid` or included `txids` means same chain message,
- content-only matching is fallback only for legacy messages without chain metadata.

### 9.4 Legacy Unscoped Order Messages

Legacy `[DELIVERY]`, `[NeedsRating]`, and `[ORDER_END reason]` without `orderTxid` remain supported.

Fallback matching should only be used when:

- exactly one active order exists for the peer and role, or
- service order metadata has a unique matching payment/order pin.

If matching is ambiguous, display the message but do not mutate a specific order state automatically.

---

## 10. Edge Cases

### 10.1 Multiple Active Orders With Same Peer

Scoped tags resolve the order:

```text
[DELIVERY:<orderTxid>]
```

Non-protocol text remains ordinary chat and does not mutate order state.

Legacy unscoped protocol text should not guess if multiple active orders exist.

### 10.2 Peer Sends Ordinary Text During Active Order

Display it.

Do not auto-reply.

Do not update `service_orders`.

### 10.3 Peer Sends `[ORDER]` While Existing Order Active

Create a new order lifecycle with a new `orderTxid`, assuming payment/free-order validation passes.

The unified conversation can show multiple concurrent orders.

### 10.4 Seller Sends Delivery Before Status

Accept `[DELIVERY:<orderTxid>]` if it matches an existing active order.

Status updates are informative, not required for delivery.

### 10.5 Delivery Arrives After `bye`

Process delivery.

`byeSent` cannot block order protocol messages.

### 10.6 Rating Timeout

Seller may send:

```text
[ORDER_END:<orderTxid> rating_timeout]
```

This ends the order lifecycle without changing the delivered result.

### 10.7 Failed Delivery Artifact

Buyer-side artifact validation and refund fallback continue to use `service_orders`.

The failure/refund notice should appear in the unified peer session.

### 10.8 Self-Directed Orders

Existing self-order protections stay in place.

The unified session model does not change the rule that a MetaBot should not process an order sent by itself to itself.

---

## 11. Non-Goals

This design does not:

- change `/protocols/simplemsg`,
- change encryption semantics,
- remove `service_orders`,
- remove `private_chat_messages`,
- replace refund business logic,
- change payment verification rules,
- introduce group order support,
- introduce a new chain protocol path,
- delete legacy order sessions in the first migration,
- keep migrated legacy order sessions visible as separate default A2A conversations.

---

## 12. Success Criteria

Implementation is successful when:

- One peer has one visible A2A conversation containing both ordinary private chat and order events.
- New `[ORDER]` requests create order rows and order index mappings that point to the peer session.
- Seller acknowledgement, status, delivery, needs-rating, order-end, rating, and refund notices render in the same peer timeline.
- Ordinary private-chat auto-reply does not run for non-protocol messages while that peer has active orders.
- Ordinary private-chat auto-reply resumes after all active orders end.
- Existing order sessions are migrated or projected into the peer conversation without duplicate chain messages.
- Migrated legacy order sessions do not remain visible as separate default A2A conversations.
- Existing tests for A2A rendering, delivery media preview, order delivery artifacts, rating, timeout, and private-chat policy remain passing.

---

## 13. Suggested Implementation Phases

### Phase 1: Shared Classification and Canonical Session Resolution

Introduce a small helper layer that classifies simplemsg content and resolves the canonical peer session.

This phase should not change business behavior yet; it creates stable primitives for later phases.

### Phase 2: Route New Order Messages Into Canonical Peer Session

Change new incoming and outgoing order messages to append to the peer session while keeping order mappings for lookup.

### Phase 3: Active Order Suppression for Ordinary Auto-Reply

Apply the confirmed rule:

```text
active order exists -> non-protocol private-chat text is display-only
```

### Phase 4: UI Navigation and Order Focus

Update order entry points to open the peer session and focus the `orderTxid`.

### Phase 5: Legacy Migration and Backfill

Repoint old order mappings and copy missing order messages into peer sessions with idempotent de-duplication.

### Phase 6: Cleanup and Compatibility Hardening

Keep legacy reads working, add regression coverage, and only hide/archive legacy order sessions after the unified path has proven stable.
