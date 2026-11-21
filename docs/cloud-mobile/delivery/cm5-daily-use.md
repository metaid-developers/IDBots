# CM5 delivery: mobile daily-use completeness (archived sessions + memory management)

Branch `feat/mobile-cm5-daily-use` — the CM5 first batch from
`71-commercial-mobile-experience-plan.md` §next: archived-session restore and
memory-entry management on mobile.

## What shipped

1. **Archived-session restore** (chat drawer). The drawer gains an
   "已归档会话 / Archived chats" expander: lazy-loads
   `cowork.listArchivedSessions`, lists titles, and restores via
   `cowork.unarchiveSession` (restored chats reappear in the active list).
   Channels were already P1 in `02` — no contract change, the shim exposes
   them from the generated contract. `useChat` gains `listArchivedSessions`
   and `unarchiveSession`; the mock bridge already implemented the semantics.
2. **Memory-entry management** (Me → 对话记忆). Below the three global
   switches (unchanged), the page gains the P2 entry surface:
   `listMemoryEntries` (server-side substring search), create
   (text + usage-class chips), edit, soft delete, archive (status `stale`)
   and unarchive. `self_identity` entries are dream-written and protected
   from edit/delete, mirroring desktop MemorySettings. On P1 tenants the
   gateway answers `CHANNEL_NOT_ALLOWED`; the UI shows a dedicated hint
   (`mobile.memory.tierBlocked`) instead of a generic error.

## Ops step required for real tenants (memory management)

The memory CRUD channels are tier **P2** per `02` (frozen; no CR needed — P2
is the contract-defined tier). The gateway reads the tier from
`IDBOTS_GATEWAY_TIER` (`src/main/gateway/wiring.ts` `resolveTier`, default
P1). To enable memory management (and the rest of the P2 surface) for a
tenant, set in the tenant compose/env:

```sh
IDBOTS_GATEWAY_TIER=P2
```

This is a deliberate per-tenant runtime switch, not a default flip: P2 opens
the whole P2 channel inventory at once, and that go/no-go belongs to the
owner. Until it is set, the memory page works for the three global switches
(P1 config channels) and shows the tier hint for the entries list.

## Tests

- `tests/mobileMemoryEntries.test.tsx` (new, 10 cases): mock-bridge behavior
  pins for the memory channels (default view, query, create, edit,
  archive/unarchive, soft delete, self_identity protection), ChatScreen
  drawer source pins for the archived section, and a MemoryPage structural
  SSR pin. Registered in `pnpm run test:mobile`.
- Pre-existing suites re-run green on this branch: mobileMeIa 16/16,
  mobileSessionList 26/26, mobileMockBridge 15/15.
- Runbook note: killed-process rows must use `am kill`, never `am force-stop`
  (stopped-state apps are undeliverable) — recorded in
  `72-push-real-acceptance-runbook.md` §4b from the 2026-11-21 push
  acceptance run.

## Known limits

- The archived-session drawer section loads on first expand (not preloaded);
  counts appear after the first expand.
- Memory create offers the five non-self-identity usage classes (desktop
  parity); value_boundary included.
- Playwright e2e for the two flows is not in this batch (structural +
  mock-behavior tests only), matching the Me-IA split where live flows ride
  the Playwright suite.
