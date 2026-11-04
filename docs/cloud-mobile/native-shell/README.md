# IDBots Native Mobile Shell — Development Handoff

- **Status:** NS0 (`mobile-shell/` foundation) and NS1 (native lifecycle and
  navigation) are implemented, reviewed, and merged to `main` — see
  [`mobile-shell/DELIVERY-NOTE.md`](../../../mobile-shell/DELIVERY-NOTE.md) for NS1
  and [`mobile-shell/NS2-DELIVERY-NOTE.md`](../../../mobile-shell/NS2-DELIVERY-NOTE.md)
  for the current NS2 package.
  NS2 native capabilities are implemented on `feat/mobile-native-capabilities`
  with automated and Android WebView evidence; physical-device, iOS WebView,
  and real-service acceptance remain pending. NS3 has not started. The original
  handoff status ("ready for development handoff; native implementation has not
  started") describes this document at writing time (2026-10-28).
- **Repository decision:** implement in this IDBots repository under `mobile-shell/`, as a separate pnpm package; do not create a new repository
- **Product decision:** retain the PWA as a fully supported client; Android and iOS use a Capacitor native shell around the remote PWA
- **Current product stage:** the PWA is undergoing staging internal testing; native development may proceed in parallel, but native release acceptance remains gated on the core staging journeys

## Decision

Use **one repository, one remote product, two native shells**.

The native apps load the deployed PWA from the staging or production origin. Capacitor supplies system capabilities such as camera, photos, system share, app state, Android back, external links, and secure screens. The apps do not contain another Agent, LLM, wallet, chain, memory, skill, session, or task implementation.

Do not use React Native and do not rewrite the PWA as a second native UI. Do not bundle a second long-lived copy of the PWA for normal online use; only a small bundled error/offline experience is allowed. This keeps normal PWA updates independent of APK/TestFlight releases.

## Read in This Order

1. [`01-architecture-and-requirements.md`](01-architecture-and-requirements.md) — binding architecture, current-code map, native adapter, security, and versioning requirements.
2. [`02-implementation-plan.md`](02-implementation-plan.md) — dependency-ordered NS0–NS3 branches, concrete deliverables, and verification gates.
3. [`03-acceptance-and-handoff.md`](03-acceptance-and-handoff.md) — acceptance matrix, evidence rules, release blockers, and delivery-note requirements.
4. [`DEVELOPMENT-PROMPT.md`](DEVELOPMENT-PROMPT.md) — copy this to the development Agent.
5. [`REVIEW-PROMPT.md`](REVIEW-PROMPT.md) — copy this to an independent reviewer after a development package is delivered.

The development Agent starts with **NS0 only**. Later packages must not be silently pulled into the first branch.

## Existing Authoritative Material

These documents remain authoritative. This handoff elaborates their native-shell requirements; it does not replace them or amend frozen contracts.

- [`../HANDOFF.md`](../HANDOFF.md) and [`../README.md`](../README.md) — cloud/mobile program entry points.
- [`../00-program-plan.md`](../00-program-plan.md) — workstreams, environments, dependencies, and change control.
- [`../50-ws-e-mobile-client.md`](../50-ws-e-mobile-client.md) — REQ-E-22 through REQ-E-24, AC-E-8/9, security, and device requirements.
- [`../51-ws-e-implementation-plan.md`](../51-ws-e-implementation-plan.md) — original Capacitor shell sequence.
- [`../60-acceptance-and-go-live.md`](../60-acceptance-and-go-live.md) — A-01 through A-23 and non-functional/security targets.
- [`../delivery/internal-test-release.md`](../delivery/internal-test-release.md) — current core staging candidate and real-environment acceptance boundary.
- [`../01-interface-contracts.md`](../01-interface-contracts.md) and [`../02-ipc-allowlist-v1.md`](../02-ipc-allowlist-v1.md) — frozen C1–C4 and mobile IPC rules; propose a CR instead of editing them.

## Delivery Sequence

| Package | Branch | Outcome |
|---|---|---|
| NS0 | `feat/mobile-shell-foundation` | Separate Capacitor package, Android/iOS remote-PWA shells, origin restrictions, offline error UI, and a proven native-adapter bootstrap |
| NS1 | `feat/mobile-native-lifecycle` | Typed local native bridge, app-state reconnect/resync, back/external navigation, authentication preservation, and iOS recharge policy |
| NS2 | `feat/mobile-native-capabilities` | Native camera/photos/files and system share through the existing upload/artifact pipelines, with complete web fallbacks |
| NS3 | `feat/mobile-shell-release` | Signed Android/TestFlight candidates where credentials exist, physical-device matrix, release runbook, and final acceptance evidence |

Each package has its own branch/worktree from current `main`, tests, commits, on-chain development journals, delivery note, and independent review. No push, merge, deployment, signing-key use, store submission, or production rollout without explicit owner authorization.

## Explicitly Separate Later Work

Reliable APNs/FCM push notifications require device-token registration, server-side event routing, privacy policy, and contract work. They are not a shell-only feature and are not part of NS0–NS3 unless the owner approves a separate package. Offline Agent execution, React Native, Bot Browser, and desktop-only settings are also out of scope.
