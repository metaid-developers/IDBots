# OpenClaw MetaBot Network V1 Design

**Date:** 2026-04-05  
**Status:** Approved for planning review

## 1. Goal

Ship the first real external-platform version of the MetaBot network using `OpenClaw <-> OpenClaw` as the initial host environment.

The V1 product moment is:

1. A requester MetaBot on OpenClaw needs a capability it cannot satisfy locally.
2. It discovers a remote on-chain service published by another MetaBot.
3. It submits one task payload containing a goal and task context.
4. The provider MetaBot's OpenClaw host is woken up in real time.
5. The provider side automatically creates a local session and starts execution with no human confirmation step.
6. The provider returns one delivery result.
7. The request and result remain traceable through MetaWeb-backed records.

The purpose of V1 is not to introduce a new agent platform. The purpose is to turn IDBots' already validated service-collaboration behavior into a portable runtime, CLI, and skills-pack form that can live inside external agent hosts.

## 2. Core Product Position

V1 should be positioned as a **MetaBot network access layer** for external agent platforms.

It is:

- a way to let third-party agent hosts connect to MetaWeb,
- a way to publish and call MetaBot services from those hosts,
- a way to reproduce IDBots' already validated single-service remote collaboration loop outside the IDBots desktop app.

It is not:

- a redesign of IDBots' business semantics,
- a brand-new remote agent protocol invented specifically for OpenClaw,
- a full remote invocation product for an entire MetaBot,
- a multi-turn remote conversation system in V1.

## 3. Hard Constraints

These constraints are mandatory for V1 planning and implementation.

### 3.1 IDBots Is the Business Truth

IDBots is not a loose inspiration source. It is the first validated implementation whose business semantics must be preserved.

For V1:

- IDBots' existing business paths are the source of truth.
- The migration target is behavior equivalence, not architectural elegance.
- If OpenClaw integration pressures the team to invent new service semantics, the default answer is no.

### 3.2 CLI Is an Ability Packaging Layer

The `metabot CLI` is allowed to be broad, operational, and initially inelegant.

Its job is to expose IDBots' existing abilities in a portable form. Its job is not to become the product center of gravity in V1.

### 3.3 Skills Pack Is a Bridge

The skills pack should translate host-native interaction modes into CLI/runtime calls.

It should not own:

- order lifecycle semantics,
- payment gating semantics,
- service delivery semantics,
- remote execution state machines.

### 3.4 Host Interaction May Change, Business Semantics May Not

IDBots currently expresses its product through Electron UI and existing daemon flows. In external hosts, those entrypoints may become:

- natural-language entrypoints,
- local HTML pages,
- explicit CLI commands,
- host-specific page actions,
- message-gateway wake-up events.

Those UI and interaction changes are acceptable. The underlying business meaning is not.

### 3.5 Prefer Canonical Paths, Not New Paths

The migration question is not:

> "What is the prettiest new workflow for OpenClaw?"

It is:

> "Which existing IDBots path is the canonical path for this behavior, and how do we reproduce it in a host-neutral way?"

### 3.6 UI and UX Are Secondary in V1

V1 should prioritize working capability migration over polished onboarding, page design, or wording refinement.

As long as the migrated capability is usable and behaviorally correct, UI/UX optimization can follow later.

### 3.7 Wake-Up Mechanism Is Host-Specific

The business flow must tolerate different host wake-up mechanisms:

- IDBots today: `idchat.io` socket path
- OpenClaw V1: OpenClaw message gateway
- future hosts without custom gateway support: daemon bridge, local listener, polling bridge, or equivalent

This means wake-up behavior must not be designed as an IDBots-only or OpenClaw-only business primitive. It is a host adapter concern.

## 4. V1 Service Model

V1 uses the narrowest product shape that still demonstrates the network.

### 4.1 What a Service Is

One published V1 service corresponds to **one local skill**.

This is intentionally narrower than the long-term target of invoking an entire MetaBot. The team should preserve expansion room for that future, but V1 execution should begin with skill-bound services because that matches current IDBots capability and keeps provider mental models simple.

### 4.2 What a Request Looks Like

A remote request is:

- one target service,
- one task goal,
- one task context payload,
- one free or paid execution condition,
- one execution,
- one delivery result.

V1 does not support a single remote order containing multiple back-and-forth conversational rounds.

### 4.3 Payment Model

V1 must support both:

- `free service` execution,
- `paid service` execution.

The execution rule is simple:

- free service: may execute immediately once the request is valid,
- paid service: must not execute until payment proof resolves to the expected service and amount.

For planning purposes, the concrete V1 proof artifact is the same kind of artifact IDBots already uses in paid service-order flows:

- an on-chain payment transaction reference, carried as `payment_txid`,
- the chain/currency context needed to interpret it,
- the target service reference,
- the expected amount and currency for that service.

V1 must reuse the current IDBots payment-verification path rather than inventing a new receipt model. In practical terms, planning should assume that the provider runtime verifies a request by checking the referenced payment transaction against the expected service, amount, currency, and receiving side semantics already present in IDBots' service-order flow.

### 4.4 Delivery Model

V1 implementation should support:

- text delivery,
- text plus image/file attachment delivery.

The minimal V1 delivery contract must be:

- one required text result field,
- zero or more attachment references,
- attachment references passed by URI/reference, not inline binary transport,
- V1 attachment types limited to image and generic file.

For V1, attachments should be referenced using the same kind of externalizable artifact reference style already used in the IDBots/MetaWeb ecosystem, for example `metafile://<pinid>` or an equivalent existing asset reference path. The delivery payload should carry references only; it should not attempt to embed image, file, or video bytes directly in the wake-up or delivery message.

For planning purposes, V1 should standardize on `metafile://<pinid>` as the canonical cross-host attachment reference whenever the delivered artifact is a MetaWeb-backed file artifact. If IDBots currently uses additional internal asset path forms, those may remain implementation details inside one host, but the requester/provider contract should normalize to one portable reference shape.

The result schema must be designed so it can later support:

- video,
- larger files,
- richer artifact payloads.

However, V1 should not delay the core service loop in order to fully implement rich media delivery.

## 5. Scope and Non-Goals

### 5.1 In Scope

- `OpenClaw <-> OpenClaw` as the first external host pairing
- single-skill service publication
- local-first requester routing with remote fallback
- both explicit remote-service selection and automatic remote-service recommendation
- remote service discovery when local capability is insufficient
- one-shot request submission with free-form goal + context
- free and paid service gating
- automatic provider-side session creation
- automatic provider-side execution start without human confirmation
- one-shot delivery result return
- chain-backed request and result traceability
- a portable runtime / CLI / skills-pack shape that can later support other hosts

### 5.2 Out of Scope

- direct remote invocation of a whole MetaBot
- multi-turn remote conversation in a single service order
- new business semantics not already validated in IDBots
- generalized marketplace redesign
- new reputation or trust systems
- new price-negotiation flows
- polished final UX and page design
- immediate multi-host support beyond OpenClaw

## 6. Canonical Path Preservation

Every V1 capability must map to an already existing IDBots behavior path.

If a capability cannot be mapped to a real IDBots path today, it should not enter V1 by default.

### 6.1 Canonical Path Rule

For every planned V1 feature, the team must answer:

1. Where does this behavior exist in IDBots today?
2. Which modules implement it?
3. Which parts are business semantics versus UI shell?
4. Which exact semantics must be preserved?

If those answers are vague, extraction should pause until the path is clarified.

### 6.2 Canonical Path Candidates for V1

| V1 Capability | IDBots Canonical Path | Golden Path To Preserve | Current Anchor Modules |
| --- | --- | --- | --- |
| Service publish / mutate | Existing service-square / skill-service publication behavior | Publish one local skill as one remotely callable service item, using existing service publication semantics rather than a new marketplace model | `gigSquareServiceMutationService.ts`, `serviceOrderProtocols.js`, related renderer publish flows |
| Service discovery and sync | Remote service sync plus provider online filtering | Read chain-backed service records, then narrow to callable providers through the same online/availability interpretation used by IDBots | `gigSquareRemoteServiceSync.ts`, `providerDiscoveryService.ts`, `heartbeatPollingService.ts`, `ProviderPingService` |
| Free / paid service order semantics | Existing service order lifecycle | Treat free and paid requests as the same order shape with different execution gates, not as separate product lines | `serviceOrderLifecycleService.ts`, `serviceOrderState.ts`, `serviceRefundSyncService.ts`, `serviceRefundSettlementService.ts` |
| Remote request transport | Existing private message / order message transport | Send one request payload through the existing order/message semantics instead of introducing a new remote RPC contract | `privateChatDaemon.ts`, `metaWebListenerService.ts`, `serviceOrderProtocols.js`, `orderPayment.ts` |
| Provider-side execution bridge | Existing order-to-cowork execution path | Turn an accepted remote request into one local execution session bound to the requested service | `privateChatOrderCowork.ts`, `orchestratorCoworkBridge.ts`, `serviceOrderCoworkBridge.ts` |
| Result delivery and order completion | Existing delivery / observer / result bridge | Return one delivery payload and advance the order state through the same observer/completion semantics already validated in IDBots | `serviceOrderObserverSession.ts`, `buyerOrderObserverSession.ts`, `serviceOrderSessionResolution.js`, `privateChatOrderObserverState.js` |
| Chain read/write and wallet substrate | Existing MetaID and wallet services | Reuse current chain read/write, wallet, and transfer semantics without inventing a separate external-host wallet model | `metaidCore.ts`, `metaidRpcServer.ts`, `metabotWalletService.ts`, transfer and asset services |

This table is not a final implementation inventory. It is the required preservation map for planning.

## 7. Target System Layers

V1 should be designed as five layers with clear ownership boundaries.

### 7.1 MetaWeb Truth Layer

This is the source of truth for:

- service publication,
- service discovery records,
- payment proof references,
- request trace,
- result trace.

The truth layer is chain-backed and should preserve the same business meaning that IDBots uses today.

### 7.2 Wake-Up Layer

This is a host-specific real-time wake-up mechanism used to reduce latency and create the "remote request immediately starts my local agent" experience.

For V1 on OpenClaw, this layer should use the OpenClaw message gateway.

The wake-up layer is not the truth layer. It is a low-latency execution trigger layered on top of the truth layer.

### 7.3 Provider Runtime Layer

This layer should:

- receive wake-up events,
- validate whether the request is executable,
- validate free-versus-paid execution eligibility,
- create the provider-side execution session through the host adapter,
- collect one delivery result,
- write result and status back to the truth layer.

This layer should be host-neutral in business semantics.

### 7.4 Host Adapter Layer

The adapter is host-specific and should stay thin.

For `OpenClaw`, it should translate between:

- OpenClaw message gateway events,
- OpenClaw session creation and input injection,
- provider runtime commands,
- requester-side result injection into host conversation state.

The adapter should not redefine order, payment, or delivery semantics.

### 7.5 Skills Pack Layer

The skills pack should serve as the user's bridge into the system.

It should:

- expose service publication entrypoints,
- expose remote call entrypoints,
- expose discovery and result-view entrypoints,
- translate natural language or page interactions into CLI calls.

It should not be the implementation home of the core business loop.

## 8. Requester-Side Selection and Fallback Rules

V1 must preserve two requester entry modes:

1. `explicit selection mode`
   - the user or host explicitly chooses a remote service and submits work to it;
   - this mode bypasses local-insufficiency detection because the remote route is chosen intentionally.
2. `automatic recommendation mode`
   - the requester host evaluates local capability first;
   - if there is no acceptable local skill match, it discovers remote services and recommends one or more candidates using the same local-first-then-remote pattern that IDBots already validates.

For V1 planning, the canonical automatic mode should remain user-confirmed on the requester side unless the canonical IDBots path inventory proves that a narrower path is already validated. The provider side remains auto-starting once the request has actually been sent.

### 8.1 What "Local Capability Is Insufficient" Means in V1

For V1 planning, "local capability is insufficient" must mean a **pre-execution routing miss**, not a post-start execution failure.

More concretely:

- the requester first runs its existing local skill-routing logic,
- if that routing logic finds an acceptable local execution path, the request stays local,
- if that routing logic does not find an acceptable local skill/service path, remote discovery may begin,
- explicit remote selection remains allowed and does not require a local miss.

This rule matters because it preserves the current IDBots idea of local-first routing with remote fallback. V1 should not reinterpret "insufficient" to mean "the local run started and then failed, so now try remote."

## 9. Module Split

To preserve one business semantics while supporting multiple hosts later, V1 should split into the following modules.

### 9.1 `metabot-runtime-core`

This is the most important extraction target.

It should hold host-neutral business behavior for:

- chain read/write and wallet actions needed by the remote-service loop,
- service publish and revoke semantics,
- service discovery and availability interpretation,
- request validation,
- free and paid execution gating,
- request state progression,
- result delivery and trace writing.

This layer should be derived from IDBots' business services, not reinvented from scratch.

### 9.2 `metabot-daemon`

This is a long-running runtime process, not the user-facing product.

It should:

- receive wake-up signals,
- maintain request handling state,
- invoke `runtime-core`,
- call host adapters for session creation and task injection,
- monitor request completion and delivery.

This module is especially important because future hosts may not offer a custom message gateway.

### 9.3 `metabot-cli`

The CLI is a stable command surface over `runtime-core` and the daemon.

It may be broad and operational in V1. Elegance is not the priority.

Its job is to make IDBots-derived capabilities portable and scriptable.

### 9.4 `host-openclaw-adapter`

This is the only V1 host adapter.

It should:

- translate OpenClaw wake-up inputs into daemon/runtime actions,
- create local provider-side sessions,
- inject request payloads into those sessions,
- collect delivery results from host session state,
- reinject returned results into requester-side host context where required.

### 9.5 `metabot-skills-pack-openclaw`

This is the user-installable bridge package for OpenClaw.

It should expose the system through:

- natural-language skill routing,
- explicit commands,
- optional local HTML helper pages.

Its role is translation and usability, not business ownership.

## 10. Recommended Runtime Sequence

The recommended V1 flow is:

1. Provider MetaBot publishes a service record corresponding to one local skill.
2. Requester MetaBot evaluates local capability first.
3. If local capability is insufficient under the pre-execution routing rule above, the requester discovers remote services through MetaWeb-backed records.
4. The requester either:
   - explicitly selects a remote service, or
   - uses automatic recommendation mode, where the host recommends a remote candidate and the requester-side user confirms before the order is actually submitted.
5. The requester submits one service request containing:
   - service reference,
   - requester identity,
   - task goal,
   - task context,
   - free or paid execution metadata.
6. The wake-up layer notifies the provider-side host immediately.
7. The provider runtime validates the request and checks whether it is free or already paid.
8. If valid, the provider-side OpenClaw host auto-creates a local session and starts execution with no human confirmation gate.
9. The provider returns one delivery payload.
10. The runtime writes request and delivery trace back to MetaWeb-backed records.
11. The requester host receives the result and folds it back into the original local conversation.

## 11. Development Strategy

V1 should be built by extraction, not by redesign.

### 11.1 Phase 0: Canonical Path Inventory

Before implementation planning, document the exact IDBots path for each V1 behavior:

- publish,
- discover,
- request,
- wake up,
- execute,
- deliver,
- trace.

This is required. Without it, the team risks rebuilding by memory instead of extracting from truth.

Phase 0 must explicitly capture the field schema that crosses layers:

- the truth-layer request record fields,
- the truth-layer delivery record fields,
- the wake-up payload fields needed by the provider runtime,
- the delivery payload fields expected by the requester host.

That schema inventory is part of the canonical-path inventory, not a later polish step.

### 11.2 Phase 1: Extract the Smallest Closed Loop

Extract only the minimum end-to-end loop first:

- service publication,
- service discovery,
- request validation,
- provider-side execution trigger,
- one-shot delivery,
- trace writing.

Do not attempt broad host support or broad CLI polish in this phase.

### 11.3 Phase 2: Expose Through CLI

Wrap the extracted runtime behavior in a CLI that is stable enough for skills-pack and adapter use.

The CLI should initially optimize for coverage and reliability, not elegance.

### 11.4 Phase 3: Build OpenClaw Provider Adapter

The provider-side OpenClaw path is the first must-win because it creates the central product moment:

> a remote request wakes a third-party local agent host and starts a session automatically.

### 11.5 Phase 4: Build OpenClaw Requester Adapter and Skills Pack

Once the provider side is working, add:

- requester-side remote discovery,
- requester-side service invocation,
- requester-side result reinjection,
- user-facing skills and helper flows.

### 11.6 Phase 5: UX and Packaging Optimization

Only after the closed loop works should the team invest heavily in:

- polished interaction copy,
- helper pages,
- better user education,
- richer onboarding,
- launch video composition.

## 12. Risks

### 12.1 Extraction Risk

IDBots' current behavior is spread across main-process services, listener flows, order lifecycle transitions, and result-bridging logic. If the team skips path inventory, hidden coupling will be missed.

### 12.2 Host-Coupling Risk

If provider-side auto-session logic is implemented directly in host skills instead of daemon/adapter layers, supporting a second host will require re-implementing core behavior.

### 12.3 Business Drift Risk

The easiest failure mode is "slightly changing the semantics to fit OpenClaw better." That would violate the design goal. Behavior equivalence with IDBots is the baseline.

### 12.4 Payment Gating Risk

Paid requests must never execute before payment eligibility is confirmed. Free requests must not be made artificially complex by paid-request handling.

### 12.5 Overreach Risk

Attempting to support whole-MetaBot invocation, multi-turn remote conversation, or full media richness in V1 will likely slow the project enough to miss the first real product moment.

### 12.6 Wake-Up Portability Risk

If V1 treats OpenClaw message gateway behavior as the business primitive, future non-gateway hosts will be blocked. Wake-up must remain an adapter concern.

## 13. Acceptance Contract

V1 is complete only when the following are true:

1. A provider on OpenClaw can publish one local skill as a remote MetaBot service using semantics equivalent to the existing IDBots service path.
2. A requester on OpenClaw can either explicitly choose that service or discover it through local-first remote fallback, where remote discovery is triggered only by a pre-execution local routing miss.
3. A requester can submit one-shot task input consisting of a goal and task context.
4. A free request can execute immediately after validation.
5. A paid request cannot execute until the provider runtime has validated the referenced payment transaction against the expected service, amount, and currency using IDBots-equivalent payment verification semantics.
6. A provider-side OpenClaw host automatically creates a local session and starts execution when the remote request arrives.
7. The provider returns exactly one delivery payload for the service order, consisting of required text plus optional image/file references.
8. The requester receives that payload back inside its host experience and can resolve any referenced attachments by their delivery references.
9. Request and delivery remain traceable through MetaWeb-backed records.
10. The above loop works without requiring IDBots itself to be the demo host.

## 14. Planning Guidance

The implementation plan that follows this spec should be framed as:

> extracting and porting IDBots' validated MetaBot service-collaboration loop into OpenClaw-oriented runtime, CLI, daemon, and skills-pack components.

It should not be framed as:

> designing a brand-new MetaBot platform from scratch.

That distinction is the main scope defense for the whole project.
