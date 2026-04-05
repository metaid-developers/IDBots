# OpenClaw MetaBot Network Path Inventory

This document inventories the current IDBots business-truth path that V1 must preserve when extracting the OpenClaw-oriented runtime, CLI, daemon, and skills pack.

## 1. Publish Path

- entrypoint:
  `ipcMain.handle('gigSquare:publishService', ...)` in `src/main/main.ts:5196`
- main services:
  `normalizeGigSquareCurrency(...)`, `getGigSquarePriceLimit(...)`, and `buildGigSquareServicePayload(...)` in `src/main/services/gigSquareServiceMutationService.ts:167-289`
  `createPin(...)` write to `GIG_SQUARE_SERVICE_PATH` in `src/main/main.ts:5288-5296`
  `insertGigSquareServiceRow(...)` mirror write in `src/main/main.ts:5298-5318`
  optional service icon upload through `createPin(... path: '/file')` in `src/main/main.ts:5248-5264`
- transport/protocol:
  on-chain publish pin at `'/protocols/skill-service'` (`src/main/main.ts:392`, `src/main/main.ts:5289-5292`)
  payload is JSON with `endpoint: 'simplemsg'`, `inputType: 'text'`, `outputType`, `providerSkill`, `paymentAddress`
  file artifacts are externalized as `metafile://<pinid>` (`src/main/main.ts:5255-5264`)
  local chain-write substrate remains the MetaID `createPin(...)` path exposed through `src/main/services/metaidRpcServer.ts:1-4` and `src/main/services/metaidRpcServer.ts:624-642`
- business semantics to preserve:
  one published local skill equals one remotely callable service item
  provider-side wallet address is derived from the selected service currency before publish (`src/main/main.ts:5266-5270`)
  service publish always writes the truth-layer pin first, then mirrors the local row, then schedules follow-up remote sync (`src/main/main.ts:5298-5327`)
  no new marketplace semantics should be invented for V1; the existing GigSquare payload shape is the truth
- host/UI shell that may change:
  the current host shell is Electron renderer -> IPC
  external hosts may call a CLI or local HTML page instead, but must still end at the same publish payload + `createPin('/protocols/skill-service')` path

## 2. Discovery Path

- entrypoint:
  `syncRemoteSkillServices()` in `src/main/main.ts:947-980`
  `getRemoteServicesPrompt()` in `src/main/main.ts:2486-2490`
  `ipcMain.handle('gigSquare:fetchServices', ...)` in `src/main/main.ts:4891-4909`
  runtime consumers read the provider-availability snapshot from `ProviderDiscoveryService`
- main services:
  `syncRemoteSkillServicesWithCursor(...)` in `src/main/services/gigSquareRemoteServiceSync.ts:357-382`
  `parseRemoteSkillServiceItem(...)` and `buildRemoteSkillServiceUpsertStatement(...)` in `src/main/services/gigSquareRemoteServiceSync.ts:135-355`
  `buildProviderGroups(...)` and `buildPresenceSnapshot(...)` in `src/main/services/providerDiscoveryService.ts:118-199`
  `buildRemoteServicesPrompt(...)` in `src/main/skillManager.ts:1028-1073`
- transport/protocol:
  chain-backed service discovery fetches `pin/path/list` for `'/protocols/skill-service'` via local-first HTTP fallback (`src/main/main.ts:953-971`)
  synced rows are mirrored into `remote_skill_service`
  automatic recommendation candidate exposure currently happens by injecting availability-filtered `availableServices` into the cowork routing prompt (`src/main/skillManager.ts:1035-1073`)
  explicit GigSquare browsing loads current remote service rows through `gigSquare:fetchServices`, then overlays heartbeat/discovery snapshot state for online display and later uses handshake gating before order send (`src/main/main.ts:4891-4909`, `src/renderer/components/gigSquare/GigSquareView.tsx:134-145`, `src/renderer/components/gigSquare/GigSquareOrderModal.tsx:224-289`, `src/renderer/components/gigSquare/gigSquareOrderPresentation.js:4-17`)
- business semantics to preserve:
  automatic recommendation discovery is two-step: sync remote service records, then intersect with online/callable provider truth
  revoked or unavailable services stay mirrored but are not treated as callable (`src/main/services/gigSquareRemoteServiceSync.ts:163-194`, `src/main/services/providerDiscoveryService.ts:122-129`)
  requester discovery has two already-validated shells: automatic recommendation through the cowork prompt and explicit browsing through GigSquare; they share the same underlying mirrored service source, but only the automatic path filters to `availableServices` at discovery time
  automatic recommendation is local-first before it is remote-first: the cowork prompt explicitly says remote services may be considered only when no local skill can fulfill the request (`src/main/skillManager.ts:1053-1057`)
  explicit browsing/selection intentionally bypasses local-insufficiency detection once the requester opens the GigSquare service browser and picks a service, and it relies on online display plus order-time handshake gating rather than discovery-time availability filtering (`src/main/main.ts:4891-4909`, `src/renderer/components/gigSquare/GigSquareView.tsx:70-105`, `src/renderer/components/gigSquare/GigSquareOrderModal.tsx:224-289`)
  candidate presentation and requester-side confirmation are already business rules in the automatic prompt contract: remote services are shown with name/description/price/rating/provider, paid services require confirmation before delegation, and free services may delegate directly (`src/main/skillManager.ts:1057-1071`)
- host/UI shell that may change:
  today's shell is sidebar/service browser state in Electron
  V1 may surface remote-service candidates inside an OpenClaw skill, CLI prompt, or explicit chooser, but it must preserve the current split: automatic recommendation is local-first and availability-filtered before suggestion, while explicit selection may intentionally bypass local-miss detection and instead gate execution later

## 3. Request Path

- entrypoint:
  explicit service ordering starts in `GigSquareOrderModal` and calls `window.electron.gigSquare.sendOrder(...)` in `src/renderer/components/gigSquare/GigSquareOrderModal.tsx:271-457`
  `ipcMain.handle('gigSquare:sendOrder', ...)` in `src/main/main.ts:5540-5700`
  requester intent becomes a remote order at `parseDelegationMessage(...)` / `emit('delegation:requested', ...)` in `src/main/libs/coworkRunner.ts:5232-5242`
  `coworkRunner.on('delegation:requested', ...)` in `src/main/main.ts:2577-2581`
  remote delegation send flow in `src/main/main.ts:2246-2405`
- main services:
  `buildGigSquareOrderPayload(...)` in `src/renderer/components/gigSquare/gigSquareOrderPayloadBuilder.mjs:8-18`
  `ipcMain.handle('gigSquare:preflightOrder', ...)` in `src/main/main.ts:5159-5188`
  `buildDelegationOrderPayload(...)` in `src/main/services/delegationOrderMessage.ts:92-110`
  `ensureBuyerOrderObserverSession(...)` in `src/main/services/buyerOrderObserverSession.ts:45-70`
  `ensureServiceOrderObserverSession(...)` in `src/main/services/serviceOrderObserverSession.ts:71-177`
  `serviceOrderLifecycle.createBuyerOrder(...)` in `src/main/services/serviceOrderLifecycleService.ts:193-214`
- transport/protocol:
  automatic delegation builds an `[ORDER]` payload through `buildDelegationOrderPayload(...)`, while explicit GigSquare ordering builds the same shared ORDER shape through `buildGigSquareOrderPayload(...)` over `buildOrderPayload(...)` (`src/main/services/delegationOrderMessage.ts:92-110`, `src/renderer/components/gigSquare/gigSquareOrderPayloadBuilder.mjs:8-18`, `src/main/shared/orderMessage.js:75-100`)
  both requester paths ECDH-encrypt that order and write it through `createPin(... path: '/protocols/simplemsg')` (`src/main/main.ts:2293-2312`, `src/main/main.ts:5656-5671`)
  the buyer observer session stores order context under a deterministic `metaweb_order:buyer:...` conversation id (`src/main/services/serviceOrderObserverSession.ts:39-47`)
- business semantics to preserve:
  one request is one service order, not a multi-turn remote chat
  explicit requester selection and automatic recommendation are two distinct requester entry modes today, but both must converge on the same ORDER payload semantics, encrypted `'/protocols/simplemsg'` write, and buyer-order lifecycle truth
  explicit GigSquare ordering performs its own preflight, payment/free-order handling, ORDER send, and buyer-order creation without going through `[DELEGATE_REMOTE_SERVICE]` (`src/renderer/components/gigSquare/GigSquareOrderModal.tsx:271-457`, `src/main/main.ts:5540-5700`)
  buyer trace is created immediately after request write via `createBuyerOrder(...)`, using the order message pin id as the truth-layer request anchor, in both the delegation pipeline and the explicit GigSquare order flow (`src/main/main.ts:2338-2355`, `src/main/main.ts:5635-5685`)
  when the order originated from an auto-delegated cowork session, local blocking / waiting-for-delivery state is keyed off that buyer order (`src/main/main.ts:2381-2404`)
- host/UI shell that may change:
  today's shells are local cowork delegation UI for automatic recommendation and GigSquare order UI for explicit selection
  V1 requester hosts may use natural language, commands, or explicit service pickers, but once the remote path is chosen they must still build the same ORDER payload and write it to `'/protocols/simplemsg'`

## 4. Wake-Up Path

- entrypoint:
  inbound private message processing in `src/main/services/privateChatDaemon.ts:793-845`
- main services:
  `isOrderMessage(...)`, `extractOrderTxid(...)`, `extractOrderReferenceId(...)`, `extractOrderSkillId(...)`, and `extractOrderSkillName(...)`
  `checkOrderPaymentStatus(...)` in `src/main/services/orderPayment.ts:152-236`
  `ensureServiceOrderObserverSession(...)` seller-side attach in `src/main/services/privateChatDaemon.ts:853-891`
- transport/protocol:
  there is no standalone wake-up envelope today
  the wake-up signal is the arrival of a private `'/protocols/simplemsg'` pin whose decrypted plaintext begins with `[ORDER]`
  seller wake-up currently depends on the IM/private-chat daemon loop plus whichever upstream connectivity path delivered the private message
- business semantics to preserve:
  remote wake-up is not a new business primitive; it is the adapter-specific way an inbound service order reaches the provider
  paid orders first go through `checkOrderPaymentStatus(...)` for expected-amount / currency / recipient-wallet verification, but current IDBots also has a legacy network-unverifiable allow-through branch (`unverified_network_error`) when raw-tx lookup fails; this is current runtime truth and should be treated as a V1 compatibility risk rather than the ideal end-state (`src/main/services/privateChatDaemon.ts:811-828`, `src/main/services/orderPayment.ts:161-236`, `src/main/services/orderPayment.ts:216-226`)
  current payment verification is not service-bound: `checkOrderPaymentStatus(...)` does not validate that the payment proof is tied to the parsed `service_pin_id`, so expected-service verification remains a V1 gap/risk
  free orders are allowed through using the existing `free_order_no_payment_required` branch (`src/main/services/orderPayment.ts:171-178`)
  seller order rows are created as soon as an inbound order is accepted (`src/main/services/privateChatDaemon.ts:835-850`)
- host/UI shell that may change:
  today's wake-up shell is the private-chat daemon plus the current socket/IM path
  OpenClaw may replace that with a message-gateway wake-up event, but it must still hand the provider runtime the same order semantics recovered from the truth-layer request

## 5. Execute Path

- entrypoint:
  `orderCoworkHandler.runOrder(...)` in `src/main/services/privateChatDaemon.ts:952-969`
- main services:
  `PrivateChatOrderCowork.runOrder(...)` in `src/main/services/privateChatOrderCowork.ts:77-101`
  `PrivateChatOrderCowork.createOrderSession(...)` in `src/main/services/privateChatOrderCowork.ts:103-158`
  seller observer-session linking in `src/main/services/privateChatDaemon.ts:853-891`
- transport/protocol:
  provider execution is local cowork session orchestration, not a remote RPC hop
  the seller-side order session is stored under `metaweb_order:seller:...` conversation mapping (`src/main/services/serviceOrderObserverSession.ts:39-47`, `src/main/services/serviceOrderObserverSession.ts:127-144`)
  execution auto-start uses `coworkRunner.startSession(... autoApprove: true ...)` (`src/main/services/privateChatOrderCowork.ts:89-98`)
- business semantics to preserve:
  once a valid order arrives, provider execution auto-starts with no human confirmation
  the seller observer session is created before the run so the provider host already has order context and a stable conversation/session link (`src/main/services/privateChatDaemon.ts:853-891`)
  processing notices and session creation are host shell details; the key semantic is “accepted order -> one local execution session”
- host/UI shell that may change:
  today's host shell is Electron cowork session creation
  OpenClaw can replace session creation and prompt injection, but must still preserve one accepted order -> one auto-started local provider session

## 6. Deliver Path

- entrypoint:
  provider delivery send in `src/main/services/privateChatDaemon.ts:976-1000`
  buyer delivery apply in `src/main/services/privateChatDaemon.ts:1064-1112`
- main services:
  `buildDeliveryMessage(...)` and `parseDeliveryMessage(...)` in `src/main/services/serviceOrderProtocols.js:8-10` and `src/main/services/serviceOrderProtocols.js:218-237`
  `serviceOrderLifecycle.markSellerOrderDelivered(...)` and `markBuyerOrderDelivered(...)` in `src/main/services/serviceOrderLifecycleService.ts:270-296`
  `handleAutoDeliveryResult(...)` re-injection bridge in `src/main/services/privateChatDaemon.ts:1095-1112`
- transport/protocol:
  provider serializes a `[DELIVERY] { ... }` JSON payload and sends it via encrypted `createPin(... path: '/protocols/simplemsg')` (`src/main/services/privateChatDaemon.ts:983-991`)
  buyer parses the delivery plaintext from the incoming simplemsg pin and marks the order delivered (`src/main/services/privateChatDaemon.ts:1064-1093`)
- business semantics to preserve:
  delivery is one-shot and ends the order loop
  seller and buyer both persist the delivery message pin id as the truth anchor (`src/main/services/privateChatDaemon.ts:991-999`, `src/main/services/privateChatDaemon.ts:1083-1093`)
  if the buyer order was auto-delegated from a blocking local cowork session, the delivery is reinjected into that original session (`src/main/services/privateChatDaemon.ts:1095-1112`)
  current delivery contract is text-only JSON result payload; attachment refs are a V1 extension point that must stay reference-only, not inline binary, and V1 limits them to image/file references rather than general media blobs or video bytes
- host/UI shell that may change:
  today's shell is private chat + cowork message injection
  V1 requester hosts may display a host-native result card or assistant message, but must still consume the same delivery semantics and preserve the underlying truth-layer delivery pin

## 7. Trace Path

- entrypoint:
  buyer trace starts in the delegation pipeline at `src/main/main.ts:2270-2288` and `src/main/main.ts:2341-2355`
  buyer trace also starts in the explicit order flow at `src/main/main.ts:5635-5685`
  seller trace starts in `src/main/services/privateChatDaemon.ts:835-891`
- main services:
  `createBuyerOrder(...)`, `createSellerOrder(...)`, `markBuyerOrderFirstResponseReceived(...)`, `markSellerOrderFirstResponseSent(...)`, `markBuyerOrderDelivered(...)`, `markSellerOrderDelivered(...)` in `src/main/services/serviceOrderLifecycleService.ts:193-296`
  `ensureBuyerOrderObserverSession(...)` in `src/main/services/buyerOrderObserverSession.ts:45-70`
  `ensureServiceOrderObserverSession(...)` in `src/main/services/serviceOrderObserverSession.ts:71-177`
  `handleAutoDeliveryResult(...)` in `src/main/services/privateChatDaemon.ts:1095-1112`
- transport/protocol:
  trace state is persisted locally in service-order storage and cowork conversation mappings
  observer-session conversation ids are deterministic from role + metabot id + peer globalmetaid + order correlation key (`payment_txid / order_reference_id`) (`src/main/services/serviceOrderObserverSession.ts:39-47`)
  the truth-layer pins (`orderMessagePinId`, `deliveryMessagePinId`) are attached to the lifecycle rows as the on-chain anchors (`src/main/services/serviceOrderLifecycleService.ts:199-213`, `src/main/services/serviceOrderLifecycleService.ts:278-295`)
- business semantics to preserve:
  buyer and seller are two views over the same order lifecycle, not separate protocols
  first response and delivered transitions are distinct and preserved on both sides
  explicit GigSquare orders and automatic delegation orders both create the same buyer observer/buyer order artifacts; V1 must preserve this shared lifecycle even if host shells differ
  requester-side reinjection today resolves the destination indirectly from buyer order/payment-or-order-reference context and blocking cowork session state, using bridge-local state such as `deliveredOrder.coworkSessionId`, not from an explicit request/session correlation field
  V1 must preserve traceability while adding explicit portable correlation fields where the current code only has implicit payment/session linkage
- host/UI shell that may change:
  today's shells are observer sessions plus Electron cowork streams, regardless of whether the order was initiated from GigSquare or the cowork delegation flow
  external hosts may replace the viewer/session UI, but not the underlying buyer/seller lifecycle semantics or truth-layer pin references

## 8. Cross-Layer Field Schemas

### Truth-Layer Request Record

| Field | Source today | Meaning | Required in V1 |
| --- | --- | --- | --- |
| `order_message_pin_id` | `createPin(... '/protocols/simplemsg')` send result in `src/main/main.ts:2303-2312`; persisted into buyer order at `src/main/main.ts:2343-2354` | The on-chain pin that carries the ORDER request | Yes |
| `requester_global_metaid` | Not embedded in ORDER plaintext; recovered from the `'/protocols/simplemsg'` sender row as `from_global_metaid` / `from_metaid` in `src/main/services/privateChatDaemon.ts:758-820` | The requester identity bound to the truth-layer request pin | Yes |
| `service_pin_id` | Embedded as `serviceId` in `buildDelegationOrderPayload(...)` at `src/main/services/delegationOrderMessage.ts:99-109`; recovered by provider with `extractOrderSkillId(...)` | The exact published service being invoked | Yes |
| `payment_txid / order_reference_id` | Paid path uses `paymentTxid` in `src/main/main.ts:2264`; free path falls back to `orderReference` in `src/main/main.ts:2265` | Correlation key used to bind buyer/seller order rows, with free orders using `orderReferenceId` instead of a real txid | Yes |
| `price` / `currency` | Added to ORDER payload in `src/main/services/delegationOrderMessage.ts:102-105` | The expected order amount for provider-side payment verification | Yes |
| `raw_request` | Stored in the `<raw_request>...</raw_request>` block built by `buildOrderPayload(...)` in `src/main/shared/orderMessage.js:70-100`; fed from `rawRequest` in `buildDelegationOrderPayload(...)` at `src/main/services/delegationOrderMessage.ts:97-107` | The verbatim one-shot goal the provider executes | Yes |
| `task_goal_summary` | Stored in the first `[ORDER] ...` line via `displayText` in `buildOrderPayload(...)`; currently derived by `buildDelegationOrderNaturalText(...)` from `taskContext`, `userTask`, then `rawRequest` in `src/main/services/delegationOrderMessage.ts:63-69` | Human-readable short goal summary shown to the provider side | Yes |
| `task_context` | Gap: the current ORDER payload does not persist a first-class context field; `taskContext` is only available before build time and may be folded into the summary/raw request selection in `src/main/services/delegationOrderMessage.ts:63-80` | Separate task context that V1 must preserve alongside the goal | Yes |
| `request_id` | Gap: not persisted in current ORDER payload or buyer order row | Portable cross-host correlation id for one service request | Yes |
| `requester_session_id` | Gap: buyer reinjection currently resolves through payment/order state, not an explicit field | Portable requester-side reinjection target key | Yes |
| `requester_conversation_id` | Gap: observer conversation ids are derived locally, not carried cross-host | Portable host-side conversation correlation | Yes |

### Wake-Up Payload

| Field | Source today | Meaning | Required in V1 |
| --- | --- | --- | --- |
| `requester_global_metaid` | Incoming row sender in `src/main/services/privateChatDaemon.ts:820` | Who submitted the order | Yes |
| `service_pin_id` | Parsed from ORDER plaintext through `extractOrderSkillId(...)` in `src/main/services/privateChatDaemon.ts:829` | Which local service/skill to execute; current payment verification does not bind the payment proof to this service id | Yes |
| `payment_txid` / `order_reference_id` | Parsed from ORDER plaintext in `src/main/services/privateChatDaemon.ts:797-819` | Which payment/free-order reference unlocks execution | Yes |
| `payment_amount` | Parsed from the ORDER `支付金额 ...` metadata by `extractOrderAmount(...)` in `src/main/services/orderPayment.ts:103-115`; consumed by `checkOrderPaymentStatus(...)` in `src/main/services/orderPayment.ts:157-166` | Expected payment amount for provider-side verification | Yes |
| `payment_currency` | Parsed from the ORDER `支付金额 ...` metadata by `extractOrderAmount(...)` in `src/main/services/orderPayment.ts:103-115`; consumed by `checkOrderPaymentStatus(...)` in `src/main/services/orderPayment.ts:157-166` | Expected payment currency for provider-side verification | Yes |
| `payment_chain` | Derived from the parsed ORDER amount/currency inside `extractOrderAmount(...)` in `src/main/services/orderPayment.ts:103-115`; used by `checkOrderPaymentStatus(...)` to resolve the recipient wallet and verification chain in `src/main/services/orderPayment.ts:165-178` | Chain context the provider uses to validate payment and select the receiving wallet | Yes |
| `order_message_pin_id` | `row.pin_id` saved into seller order at `src/main/services/privateChatDaemon.ts:835-847` | The truth-layer request anchor the provider is waking up for | Yes |
| `user_task` / request text | Current provider prompt is derived from decrypted ORDER plaintext before `buildOrderPrompts(...)` in `src/main/services/privateChatDaemon.ts:938-946` | The provider-facing execution goal | Yes |
| `request_id` | Gap: current wake-up path is implicit inbound ORDER delivery, not an explicit envelope | Portable daemon/runtime correlation id | Yes |
| `requester_session_id` | Gap: current provider wake-up knows nothing about the buyer's original local session | Needed so later delivery can reinject into the correct requester session | Yes |
| `requester_conversation_id` | Gap: current provider path derives seller observer conversation locally | Portable host conversation correlation | Yes |

### Truth-Layer Delivery Record

| Field | Source today | Meaning | Required in V1 |
| --- | --- | --- | --- |
| `delivery_message_pin_id` | Delivery send result in `src/main/services/privateChatDaemon.ts:991-999` | The on-chain pin that carries the provider result | Yes |
| `payment_txid / order_reference_id` | Delivery payload currently serializes `paymentTxid: orderTrackingId` in `src/main/services/privateChatDaemon.ts:984-989`; buyer-side matching uses the same correlation key in `src/main/services/privateChatDaemon.ts:1083-1093` | The order being completed, with free orders reusing the legacy `paymentTxid` slot for `orderReferenceId` compatibility | Yes |
| `service_pin_id` | Added to delivery payload in `src/main/services/privateChatDaemon.ts:984-989` | The service that produced the result | Yes |
| `service_name` | Added to delivery payload in `src/main/services/privateChatDaemon.ts:984-989` | Human-readable trace/debug field for the delivered service | Yes |
| `result` | Added to delivery payload in `src/main/services/privateChatDaemon.ts:984-989` | Provider's one-shot text result | Yes |
| `delivered_at` | Added to delivery payload and persisted into lifecycle transitions in `src/main/services/privateChatDaemon.ts:983-999` and `src/main/services/privateChatDaemon.ts:1088-1092` | Delivery completion timestamp | Yes |
| `attachments` | Gap: current `[DELIVERY]` payload has no portable attachment list or typed attachment restriction | V1 must add reference-only attachments such as `metafile://<pinid>`, limited to image and generic file refs | Yes |
| `request_id` | Gap: current buyer matches delivery by payment txid only | Portable request correlation | Yes |
| `requester_session_id` | Gap: current buyer reinjection target is indirect via blocking order/session state | Explicit requester-side result target key | Yes |
| `requester_conversation_id` | Gap: current delivery does not carry host conversation correlation | Portable host conversation correlation | Yes |

### Requester-Visible Delivery Payload

| Field | Source today | Meaning | Required in V1 |
| --- | --- | --- | --- |
| raw `[DELIVERY]` plaintext | Added as assistant message to the buyer observer session in `src/main/services/privateChatDaemon.ts:1064-1080` | The exact provider delivery as seen on the buyer side before normalization | No |
| parsed `result` text | Extracted through `parseDeliveryMessage(...)` and eventually cleaned/injected by `handleAutoDeliveryResult(...)` | The user-visible service result | Yes |
| `attachments` | Gap: current requester-visible flow has no portable attachment list | V1 requester bridge must surface attachment refs separately from text, limited to image/file references rather than inline binary or arbitrary media blobs | Yes |
| `payment_txid / order_reference_id` | Current buyer-side link field in `src/main/services/privateChatDaemon.ts:1083-1093`, with free orders reusing the same slot through `orderTrackingId` | Legacy compatibility join key for the delivered buyer order | Yes, for compatibility |
| `request_id` | Gap: current visible delivery has no explicit request correlation | V1 requester bridge must use it for host-safe reinjection | Yes |
| `requester_session_id` | Gap: current buyer reinjection relies on local blocking state rather than an explicit field | V1 requester bridge must require it together with `request_id` | Yes |
