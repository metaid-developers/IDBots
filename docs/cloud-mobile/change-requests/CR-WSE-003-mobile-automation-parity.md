# CR-WSE-003 — Mobile Bot automation parity

- **Status:** Approved for staged implementation through the CM0 direction on 2026-11-20; gateway changes land with CM3, not CM1
- **Date:** 2026-11-20
- **Contract:** daily-report, experimental-automation, and Surf channel tiers; target allowlist version 1.2.0 after CR-WSE-002
- **Affected parties:** WS-A, WS-E, security review, acceptance
- **Compatibility:** Backward-compatible expansion after resource and safety review. Existing settings storage and desktop behavior remain unchanged.

## Current text before this CR

Per-Bot `metabot:getSetting/setSetting` already supports Surf and daily-report preferences. `dailyReport:runNow` and the global experimental-automation controls are N. `surf:listRuns` and `surf:runNow` are P2, while the newer Surf day-index channels are N.

## Approved staged change

1. Reclassify `dailyReport:runNow` for mobile after validating tenant resource use and the existing global/per-Twin gates.
2. Reclassify `app:getExperimentalAutomation` and `app:setExperimentalAutomation` with cloud-safe product copy and no phone-to-desktop control semantics.
3. Roll out `surf:listRuns` and `surf:runNow` through the intended gateway tier, and add `surf:listRunsByDay` and `surf:listRunDays` through this CR or replace them with a composed mobile read facade if profiling favors it.
4. Reuse the existing whitelisted per-Bot settings; do not add a second settings store.

## Reason

Mobile users need the same control over autonomous Surf and the Twin daily briefing that desktop users have. These controls also produce first-class notification events through the CM1 foundation.

## Migration and acceptance

- Existing per-Bot settings and defaults remain compatible; no migration or opt-in flip is allowed.
- Surf and daily-report tests cover persistence, global gates, run state, failure recovery, and notification deep links.
- No contract file is edited before the corresponding CM3 implementation and security/resource evidence is ready.
