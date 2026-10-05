# MetaTask → OAC Port — Implementation Plan

> **Status**: ready for implementation. Author: IDBots side (this repo).
> **Target repo**: `/Users/tusm/Documents/MetaID_Projects/open-agent-connect` (OAC).
> **Companion document**: `docs/design/metatask-oac-port-ui-reference.md`
> (UI fidelity guide for the two OAC UI surfaces — required reading for the UI phases).
>
> Intended reader: a development agent implementing the port inside the OAC
> repository. Both repos live on the same machine; all paths below are absolute
> or repo-relative and marked accordingly.

---

## 1. Goal & non-goals

### 1.1 Goal

Make OAC-hosted MetaBots (Codex and 13 other platforms, plus the DSH host)
**first-class MetaTask participants and publishers**, at parity with IDBots:

1. **Participate**: list/inspect tasks, declare intent (claim), submit work
   (with `parentrefs`), review/verify others' submissions, release intents,
   amend owned tasks.
2. **Publish**: decompose a goal into a competitive MetaTask and publish it
   on-chain — including the Twin-Bot decomposition **wizard** flow.
3. **Observe (humans)**: two functionally-equivalent UIs — the DSH plugin
   (「我的Bot → 追踪任务」) and the OAC web UI (`src/ui/pages` Tracking Tasks).
4. **Conform**: the OAC replay engine must pass the registered conformance
   vector set byte-identically (§8).

Everything is **chain-first**: the chain is the only source of truth; every
host builds its own local projection by replaying public protocol events.
OAC needs no protocol change — the events it writes are the same 9 paths any
engine already replays.

### 1.2 Non-goals (do not build)

- No protocol changes, no new event paths, no registration pins (AI_Sunny
  owns the registry; v1.3.0 is already registered).
- No reward escrow (`reward_sat` stays 0), staking, arbitration, multi-sink
  tasks (protocol open questions Q1–Q4 stay deferred).
- No chain settlement payment path.
- No port of IDBots' Electron shell or its IPC layer — OAC has its own
  CLI/daemon/UI surfaces (§4).

---

## 2. Background for the implementer (10 lines)

1. MetaTask = an on-chain protocol (`/protocols/metatask`, registered v1.3.0,
   pin `fd33de09e0ff314016ff76e12d47c38bb0ee17fc7a9706bbfd3824ded0c0c947i0`)
   for multi-bot asynchronous task collaboration.
2. A task = a **tree pin** (node skeleton with `deps` + weights Σ=10000) +
   a **task pin** (policy) + **spec pins** (verifier scripts).
3. Two modes: `tree` (legacy, exclusive claim locks, AND-tree completion) and
   `competitive` (v1.3: no locks, competing fork submissions, `parentrefs`
   dependency DAG, quorum-verified, **winner-chain-only settlement**).
4. Chain stores **facts only** (task/tree/spec/claim/release/submission/
   verify/amend/challenge pins); every state — node status, leader, winner,
   settlement manifest — is **derived by replay**. Any two conformant engines
   replay the same events to the same bytes.
5. Submissions carry artifacts off-chain: `metafile://` bundles or
   `git-bundle` metafiles (`result.commit` + `attachment`), so "code
   certificates" verify without GitHub.
6. A live competitive pilot already completed on-chain (task root
   `fad848f86d360fb61f3308b4b9eae7f6c9816eeb8eef86f2bf911c70ab8bed10i0`):
   79 events, 7/7 nodes verified, winner-chain settlement reconciled to the
   basis point; three independently built engines (Python/Go/TS) replay the
   27-vector conformance set to one digest `726959e9…dcfd0`.
7. `H_ACT3 = 192800`: competitive-mode **writer gate** — writers must refuse
   competitive publishes below this chain height (arrives ≈ 2026-10-07).
8. Normative docs in this repo (IDBots):
   - `docs/metaid_protocols/metatask-protocol-v1.3-competitive-draft.md`
     (frozen draft text; on-chain twin
     `metafile://ae093069e016dde08408936d2d3a002fc73bb884fe7dd71864daa4da48ff05afi0.md`)
   - `docs/metaid_protocols/metatask-v1.3.0-alignment.md` (every registration
     decision vs the TS implementation — **read this before porting replay logic**)
   - `docs/metaid_protocols/metatask-v1.2.1-alignment.md` (v1.2.1 baseline).
9. The registration body folds in the v1.2.2 rulings; two are easy to miss:
   aggregation-precondition anchor (parent's effective-submission height ≥
   H_ACT2) and the **positional mirror** childids comparison (see §5.1 M1).
10. IDBots shipped the full feature (engine, writers, skills, UI) and it is
    all on `main` — this document maps it to OAC.

---

## 3. Source inventory (IDBots, all paths repo-relative)

| # | Source | Size | What it is | Port disposition |
|---|---|---|---|---|
| S1 | `src/main/services/metatask/engine.ts` | ~2400 ln | Replay engine: both modes, settlement, amend fold, challenge, eventSetHash, `taskDirtyKey`, `PROJECTION_FORMAT_VERSION=3` | **Port ~verbatim** (pure TS, zero Electron deps) |
| S2 | `src/main/services/metatask/{types,constants,canon,estimate,deadlines}.ts` | ~800 ln | Types, protocol constants (H_ACT/H_ACT2/H_ACT3, split, engine versions), canonJ + double-hash, mid-task estimation, deadline clocks | **Port ~verbatim** |
| S3 | `src/main/services/metatask/collector.ts` + `src/main/services/protocolPinFetch.ts` | ~500 ln | Chain event collection: 9 paths + roster pool, cursor paging, base64 body parse, **truncated-content recovery** via content download URLs | **Port adapted** to OAC's indexer clients (§5.1 M2) |
| S4 | `src/main/services/metatask/projectionStore.ts` | ~610 ln | **SQLite** projection cache: events, projections, refresh state, watch state, alerts, identities; dirty-key skip; batch writes | **Redesign as JSON store** (§5.1 M3 — OAC has no SQLite) |
| S5 | `src/main/services/metatask/{refresher,watchService}.ts` | ~420 ln | Refresh pipeline (collect → upsert → replay dirty roots → save → push) + alerts (claim TTL, submission changes, closing drive) | **Port adapted** (§5.1 M4/M5) |
| S6 | `src/main/libs/metataskAgentTools.ts` | ~1900 ln | 10 writer/read tools incl. publish validation, parentRefs pre-check, H_ACT3 gate, git-bundle enforcement, draftsFile mode | **Port adapted** → core writer service + CLI verbs (§5.2) |
| S7 | `SKILLs/metatask-wizard/SKILL.md` + `scripts/metatask-wizard/*` | ~1900 ln | Decomposition wizard skill + generic draft validator (640 ln) + task template + HTML preview template + selftest | **Port adapted** (§5.3) |
| S8 | `scripts/metatask-v13-pilot/` | ~12k ln | Pilot campaign kit: **7 node verifier scripts** (S1 lint … S5 release), spec selftests, base bundles, publish harness, launch record | **Port reference parts** (§5.4 — reviewers need the verifier scripts) |
| S9 | `tests/fixtures/metatask/*.json` + `scripts/metatask-vectors.mjs` | ~2500 ln | Registered conformance vectors (16 + 11) + runner emitting the three-engine `CANONICAL_SHA256` | **Port ~verbatim** (§8 — the acceptance gate) |
| S10 | `tests/metatask{Engine,Competitive,ProjectionStore,AgentTools,Watch,Refresher}.test.mjs` | ~3500 ln | 122 unit tests | **Port adapted** alongside each module |
| S11 | Renderer: `src/renderer/components/metatask/*` + `src/renderer/{types,services,store/slices}/metatask*` | ~2400 ln | Full UI: board, detail, chain view, drawer, deliverables, node sections | **Re-implement per companion UI doc** (two new UIs, do not transliterate) |
| S12 | `src/renderer/services/i18n.ts` `metatask.*` keys | ~200 keys | en + zh UI copy | **Re-map** into both OAC i18n systems (companion doc §8) |
| S13 | Design mocks: `docs/design/metatask-chainview-mock.html`, `docs/design/metatask-detail-v2-mock.html`, `scripts/metatask-wizard/decomposition-preview.html` | 3 files | Visual authorities for chain view, detail v2, wizard preview | **Bundle with the port docs** (companion doc §5) |
| S14 | `scripts/metatask-v13-pilot/launch-record.json` | — | Every pilot pin id (task, tree, specs, bundles, vector set) | Reference for live-data testing |

---

## 4. Target architecture on OAC

OAC's own conventions (verified 2026-10-04, see §11 references):

- **CLI-first**: every capability lands `src/core/*` → daemon route → CLI verb
  → `SKILL.md`. Native function-call tools exist **only** in `dsh-plugin/`
  and must be thin shells over the CLI route.
- **daemon is the sole writer / sole store owner**; the CLI is a thin HTTP
  client (`requestJsonForSelectedActor`).
- **Storage is JSON files + atomic rename** under `.runtime/<domain>/` —
  **no SQLite** (Node 20 lacks `node:sqlite`; OAC supports Node ≥20 <25).
- **Ticks** via `startAutomationTickLoop` (`src/daemon/automationTicks.ts`).
- The isomorphic precedent is **grouptask** (`src/core/grouptask/*`,
  `src/daemon/{grouptaskHandlers,routes/grouptask}.ts`,
  `src/cli/commands/grouptask.ts`, `SKILLs/metabot-grouptask/SKILL.md`,
  `tests/grouptask/`). Copy its five-layer shape exactly.

### 4.1 Module map

```
IDBots (source)                              OAC (target)
─────────────────────────────────────────────────────────────────────────
engine/canon/constants/types/estimate/   →   src/core/metatask/engine/*
  deadlines (S1, S2)                           (verbatim port, M1)
collector + protocolPinFetch (S3)        →   src/core/metatask/collector.ts
                                             (adapted to OAC indexer clients, M2)
projectionStore (SQLite, S4)             →   src/core/metatask/store.ts
                                             (JSON redesign, system-level
                                              .runtime/metatask/, M3)
refresher + watchService (S5)            →   src/core/metatask/{refresher,watch}.ts
                                             + daemon tick (M4, M5)
metataskAgentTools (S6)                  →   src/core/metatask/writer.ts
                                             src/daemon/{metataskHandlers,routes/metatask}.ts
                                             src/cli/commands/metatask.ts
                                             src/cli/commandHelp.ts (+spec)
                                             (M6, §5.2)
wizard skill + validator (S7)            →   SKILLs/metabot-metatask-wizard/SKILL.md
                                             SKILLs/metabot-metatask/SKILL.md
                                             shareable scripts under
                                             SKILLs/metabot-metatask-wizard/scripts/
                                             (M7, §5.3)
verifier scripts (pilot kit S8)          →   SKILLs/metabot-metatask/scripts/verifiers/
                                             + daemon metafile proxy endpoint (M9, §5.4)
conformance vectors + runner (S9)        →   tests/fixtures/metatask/*.json +
                                             scripts/metatask-vectors.mjs (§8)
unit tests (S10)                         →   tests/metatask/*.test.mjs
renderer UI (S11)                        →   TWO re-implementations:
                                               dsh-plugin Tracking Tasks panel
                                               src/ui/pages/tracking/* (see
                                               companion UI doc — NOT in this
                                               plan's scope beyond interfaces)
```

### 4.2 Where things live at runtime

| Data | Location | Notes |
|---|---|---|
| Event cache + projections + refresh state | system-level `~/.metabot/runtime/metatask/` | Derived, rebuildable, shared across profiles (chain truth is global). JSON + atomic rename + `version` field |
| Identities cache (metaId → name/avatar) | same store | Local roster first; remote lookups throttled (IDBots: 6h / 64 per sweep) |
| Watch alerts | same store | Display-only |
| Drafts / wizard working files | profile workspace (`~/.metabot/profiles/<slug>/workspace/metatask/`) | Wizard drafts are per-user intent, not chain data |

**Daemon as sole writer applies to the store too**: CLI verbs that mutate
(`refresh`, all writes) go through HTTP; read verbs (`list`, `get`, `replay`)
may read the store via the daemon route (keep one code path — always HTTP).

---

## 5. Module-by-module port spec

### 5.1 Read path (M1–M5)

#### M1 — Engine core (verbatim port, highest fidelity requirement)

Port S1+S2 into `src/core/metatask/engine/` keeping file boundaries:

```
src/core/metatask/engine/
  types.ts        (protocol + replay-output types, incl. VoteSummary v3 fields)
  constants.ts    (paths, H_ACT=190000, H_ACT2=191500, H_ACT3=192800,
                   settlement constants, ENGINE_ALGO_VERSION{,_COMPETITIVE},
                   PROJECTION_FORMAT_VERSION=3)
  canon.ts        (canonJ, sha256Hex, innerHash, outerHash)
  engine.ts       (taskEventSet, taskDirtyKey, replayMetaTask, both modes,
                   amend folds, challenge, aggregation precondition incl. the
                   v1.2.2 positional mirror childids check, settlement)
  estimate.ts     (mid-task share estimation; estimate == manifest when complete)
  deadlines.ts    (claim/review/challenge clocks; competitive skips claim/review)
```

Rules:

- **Zero behavior changes.** The acceptance gate (§8) replays the registered
  vectors and must emit `CANONICAL_SHA256 =
  726959e97e354b1489c2baa4923702193e0b1ce38871cfc1bca830eb9e9dcfd0`.
- No Electron/Node-only imports beyond `node:crypto`/`node:fs` (engine itself
  needs only `node:crypto`). Target must compile under OAC's strict tsconfig
  and run on Node 20 (verify: no `Array.prototype.findLast`-era APIs beyond
  Node 20 support, no `node:sqlite`).
- Keep `PROJECTION_FORMAT_VERSION = 3` and the dirty-key salt logic — OAC's
  store will inherit its own upgrades through it.
- Keep per-mode `engineAlgoVersion` reporting (tree `idbots-metatask-engine/1.2.1`,
  competitive `…/1.3.0`). **Do not rename** — the string sits inside the
  conformance hashConstants.
- Port tests S10's engine suites into `tests/metatask/engine.test.mjs` +
  `competitive.test.mjs` (~107 cases). They import via `createRequire` from
  `dist/` per OAC convention.

#### M2 — Collector (adapted)

IDBots' collector walks 10 pools via a paged indexer fetch with a
base64-body parse and **truncated-content recovery** (when the inline summary
is shorter than the declared content length, it re-downloads the full body
from the content URL, concurrency 4, 8s timeout, 8MB cap).

OAC equivalents to build on (verified paths):

- `src/core/surf/manapiPins.ts` — MANAPI `GET /api/pin/path/list` client;
- `src/core/surf/surfReads.ts` — `POST /api/metaweb/pins:batch` (so.metaid.io);
- `src/core/grouptask/backfill.ts` — **the cursor-incremental, pinId-idempotent
  sync loop to copy**.

Deliver `src/core/metatask/collector.ts` with the same output contract as
IDBots (`MetaTaskChainEvent[]` + roster pin bodies), merging MANAPI and
so.metaid.io sources with pinId dedupe. **Keep the truncation recovery** —
wave-1 proved indexer summaries truncate large spec bodies, and a degraded
body must never overwrite a good cached one (store-side rule, M3).

#### M3 — Projection store (redesign: SQLite → JSON)

IDBots uses SQLite tables; OAC has no SQLite. Redesign as
`src/core/metatask/store.ts` on the `~/.metabot/runtime/metatask/` layout:

```
~/.metabot/runtime/metatask/
  version.json                 { "version": 3 }
  events/<path-segment>.jsonl  raw chain events, one JSON per line, pinId-indexed
                               (append-only; load-time dedupe by pinId)
  projections/<rootPinId>.json replay output per task root (full projection JSON,
                               incl. dirtyKey + eventSetHash + evaluatedAtMs)
  refresh-state.json           last/ok/error/boundaryBlock/refreshing/seq
  watch-state.json             per (root,node) last status + alerts[]
  identities.json              metaId → {name, avatar, fetchedAtMs}
```

Must-keep semantics (tests exist for each in IDBots S10 — port them):

- **No-degrade upsert**: an event whose body failed to parse (`{}`) never
  overwrites a cached good body.
- **Dirty-key skip**: replay only roots whose `taskDirtyKey` changed or whose
  deadline fired since `evaluatedAtMs`; `PROJECTION_FORMAT_VERSION` salt
  forces exactly one re-replay after format upgrades.
- Batch writes stay atomic per write batch (single rename).
- Everything here is **rebuildable**: deleting the directory only costs one
  full re-collect. Never treat it as authoritative.

#### M4 — Refresher + tick

Port `refresher.ts` into `src/core/metatask/refresher.ts` (collect → upsert →
replay dirty → enrich identities → save → bump seq). Wrap it in:

- a daemon tick via `startAutomationTickLoop` (5 min + jitter, mirroring
  IDBots' heartbeat), registered in `serveCliDaemonProcess` next to the other
  automation ticks, honoring the **DSH-first stand-down / host-lease**
  conventions (`automationTicks.ts` patterns);
- on-demand refresh via `POST /api/metatask/refresh` (used by CLI
  `metabot metatask refresh`, UI load, and post-write self-refresh — IDBots
  fires a background refresh after every successful write: keep that, it
  makes CLI flows feel synchronous).

Keep the 60s min-interval merge window with trailing refresh (IDBots
`refresher.ts` behavior) so bursts of writes don't hammer the indexer.

#### M5 — Watch service + alerts

Port `watchService.ts` (three alert kinds: `claim_ttl_soon`,
`submission_change`, `closing_drive`; 48h decay; dedupe per kind+node).
Alerts are display-only: stored in the JSON store, surfaced via
`GET /api/metatask/board`. The closing-drive kind matters most (it nudges the
publisher when an aggregate stalls — port its dedupe-key regression test).

### 5.2 Write path (M6): core writer + CLI + daemon

This is the module OAC bots will actually call. IDBots'
`metataskAgentTools.ts` (~1900 lines) is the source of truth for **all writer
guards** — port the guards verbatim, split by layer:

| Layer | Content |
|---|---|
| `src/core/metatask/writer.ts` | Pure-ish request builders + guards: payload assembly (snake_case on-chain bodies, version `1.1.0` pin envelopes), double-hash embedding for submissions, parentRefs validation via fresh replay, publish invariants (graph four + rubric + weights + spec validation blocks), amend rules, H_ACT3 gate, dead-parent refusal, git-bundle enforcement, draftsFile loading + `SPEC_PIN:<key>` substitution |
| `src/daemon/routes/metatask.ts` + `metataskHandlers.ts` | HTTP verbs (table-driven like `routes/grouptask.ts`): `list/get/replay/refresh/claim/submit/verify/release/publish/publish-spec/amend`. Handlers resolve the actor (`resolveActorWriteContext`), call writer + signer.writePin, then fire a background refresh |
| `src/cli/commands/metatask.ts` + help spec + `main.ts` case | CLI verbs below |

#### CLI verb specification (user-facing contract)

Follow OAC CLI conventions (`--from`, `--request-file` or flags, envelope
`{ok,state,data}`, JSON-first):

| Command | Args | Behavior / guards (all pre-broadcast) |
|---|---|---|
| `metabot metatask list [--refresh]` | — | Board: tasks with progress, myRoles, myStats (shareBP/estShareBP), boundaryBlock, alerts |
| `metabot metatask get --root <pinId> [--refresh]` | — | Full projection + openNodes + reviewEligibility + estimation |
| `metabot metatask replay --root <pinId>` | — | Pure replay of cached events: node table, manifest, ignoredEvents |
| `metabot metatask refresh` | — | Force collect+replay; returns refresh state |
| `metabot metatask claim --root <pinId> --node <id>` | — | Intent-only in competitive (return `intentOnly: true`); tree mode keeps lock guard; root author refused |
| `metabot metatask release --root <pinId> --node <id> --claim <pinId>` | — | Tree mode only; competitive refuses with explanation (no-op on-chain) |
| `metabot metatask submit --request-file <json>` | `{root,node,result,contentType?,attachment?,parentRefs?,claimPinId?,supersedePinId?,childIds?}` | Fresh-replay guard: parentRefs each exist on their dep node (refuse ghost/wrong-node/missing/extra as `invalid_reference`); **dead parents refused** (failed/superseded); unverified parents allowed with `optimistic: true` in output; git-workspace nodes require `result.type="git-bundle"` + 40-hex commit + baseCommit|null + `metafile://` attachment; claim required in tree mode only; root author refused |
| `metabot metatask verify --request-file <json>` | `{targetPinId,verdict,method,semanticCheck,failReason?,evidence?}` | #8/#9 enforced: semanticCheck required, failReason required on fail; refuse self-review, root-author target, same-side roster |
| `metabot metatask publish --request-file <json> [--allow-pre-activation]` | draftsFile shape (S7 template) or inline | H_ACT3 gate (constants vs refresh boundary); graph four invariants; rubric non-empty per node; Σweight=10000; spec validation three items; ttl/window normalize to 0 with warnings; order: roster(≥2 bots)→tree→spec→task; returns all pinIds |
| `metabot metatask publish-spec --request-file <json>` | spec draft | Single spec pin; v1.2.1 validation block enforced (null_tolerance, enumeration_closure w/ integer self-count, proposition_fidelity to an independent artifact pin) |
| `metabot metatask amend --request-file <json>` | `{rootPinId,ops[]}` | Publisher only; bases = current amendHead; competitive freeze = satisfied nodes; remove_node rejected when deps-referenced; fold preserves pinned terminal |

**Gas-safety rule (carry over religiously)**: every guard above exists to
*not spend a pin* on something replay would ignore. A refused write costs 0
sats and returns the exact engine reason string.

### 5.3 Skills (M7)

Two OAC skills (sources: IDBots `SKILLs/metatask-wizard/SKILL.md` and the
implicit participation flow encoded in IDBots' participate-draft i18n):

1. **`SKILLs/metabot-metatask/SKILL.md`** — "how to participate in a MetaTask":
   routing (when to use vs grouptask/long-term-task/schedule), competitive
   mode explained for a bot (no locks, fork races, winner-chain-only pay),
   the claim→submit→verify loop over the CLI verbs above, parentRefs
   discipline (quote exact pins; optimistic pipelining risk), #8/#9 review
   gates, git-bundle packaging recipe (clone base → work →
   `git bundle create` → `metabot file upload` → submit), verifier-script
   usage for self-check before submitting.
2. **`SKILLs/metabot-metatask-wizard/SKILL.md`** — port of the IDBots wizard:
   Twin-Bot-only gate, Web2+MetaWeb research pre-phase, visual-first
   clarification (HTML prototypes/tables mandatory for structure), single vs
   multi-task decision, preview gate, dry-run validation, draftsFile publish.
   Ship its tooling **inside the skill directory** so it travels with the
   skillpack: `SKILLs/metabot-metatask-wizard/scripts/{validate-task-draft.py,
   task-draft.template.json,decomposition-preview.html}` + selftest. Adapt
   only the tool names (`metatask_publish` → `metabot metatask publish
   --request-file`).

Registration (3 places, per OAC convention): `package.json` `files[]`,
`scripts/build-metabot-skillpacks.mjs` `METABOT_SKILLS`,
`skillpacks/shared/README.md`.

### 5.4 Reviewer tooling (M9)

For OAC bots to *verify* dev submissions they need the verifier scripts and a
way to download metafile content:

- Ship the 7 pilot verifier scripts as reference implementations:
  `SKILLs/metabot-metatask/scripts/verifiers/` (from IDBots
  `scripts/metatask-v13-pilot/spec-s1-lint.py`, `spec-s2a-python.sh`,
  `spec-s2b-go.sh`, `spec-s2c-ts.sh`, `spec-s3-matrix.py`,
  `spec-s4-report.py`, `spec-s5-release.sh`, unmodified).
- Implement a daemon metafile proxy: `GET /api/file/<urlencoded metafile URI>`
  → resolves via the manapi content route, reassembles chunked uploads
  (chunkList concat + sha256 verify), streams bytes. This makes
  `METATASK_DOWNLOAD_BASE=http://127.0.0.1:<port>` work out of the box — the
  pilot-local convention the verifier scripts already document. (IDBots
  proved the chunk-reassembly path by hand on the S5 package; see
  `docs/design/metatask-oac-port-ui-reference.md` appendix A for the exact
  recipe and hashes.)

### 5.5 Optional DSH native tool (M10, thin shell only)

`dsh-plugin/src/metatask-tools.ts`: one `metatask` HostToolDefinition
(`action` union mirroring the CLI verbs), registered on the agent like
`group-task-tools.ts:660` does, executing through the same dispatch as the
plugin's HTTP routes (never a parallel implementation). SOP text = condensed
`metabot-metatask` SKILL.md. **All 14 other platforms use CLI + SKILL.md —
this tool must add zero new capability.**

---

## 6. Phased plan

Each phase lists deliverables + its verification gate. Phases are mergeable
independently (matching OAC's `closeout` convention: scoped verification +
single commit + journal buzz).

### P0 — Scaffold & engine core (M1)

- `src/core/metatask/engine/*` (S1+S2 verbatim), tests ported.
- Gate: `pnpm run build && node --test tests/metatask/engine.test.mjs
  tests/metatask/competitive.test.mjs` → 107/107.

### P1 — Read path (M2–M4)

- collector + JSON store + refresher + tick; `metabot metatask
  {list,get,replay,refresh}` verbs (read-only); daemon routes.
- Gate: against live chain data, `metabot metatask replay --root
  fad848f86d…8bed10i0` reproduces the pilot: 7/7 verified, settlement
  shares `[3600,1600,1600,1200,510,507,399,275,100,100,100]` sum 9991,
  `eventSetHash d131f8daac99495d…`, boundary 192278.

### P2 — Conformance gate (S9)

- vectors + runner in OAC; wired into the metatask test suite.
- Gate: 16/16 + 11/11 PASS and `CANONICAL_SHA256` == `726959e9…dcfd0`
  (print it next to the anchor constant; CI must fail on mismatch).

### P3 — Write path (M6)

- writer.ts + all write verbs + guards + draftsFile mode; H_ACT3 gate with
  `--allow-pre-activation` escape documented as testing-only.
- Gate: ported `metataskAgentTools` tests (OAC-ified) green; a **throwaway
  test task** published on-chain by an OAC bot, claimed/submitted/verified by
  another OAC bot, replays identically in IDBots (cross-host replay check:
  IDBots `metatask_replay` output == OAC `metabot metatask replay` output,
  same boundary).

### P4 — Skills (M7 + M9)

- both skills + wizard tooling + verifier scripts + metafile proxy endpoint.
- Gate: wizard selftest green; `validate-task-draft.py` accepts the pilot
  draft (`scripts/metatask-v13-pilot/pilot-task-drafts.json` in IDBots);
  proxy serves the S5 package with exact sha256
  `b75b02ff1e71714f9d6d668573ca449869503ed4cf2c30a259dc0f72ec6965a8`.

### P5 — UI: DSH plugin panel

- Per companion UI doc §6: Tracking Tasks section (wide layout), MetaTask tab
  with board + detail + chain view + drawer + deliverables + node sections.
- Gate: dsh-plugin build + typecheck + static-assertion tests; manual
  checklist in companion doc §9.

### P6 — UI: `src/ui/pages/tracking`

- Per companion UI doc §7: Tracking Tasks page with MetaTask tab (vanilla TS),
  same data contract.
- Gate: `tests/ui/trackingPageScript.test.mjs` (vm-sandbox style), i18n
  coverage whitelist, manual checklist in companion doc §9.

### P7 — Watch/alerts + hardening

- watch service + alerts in board payload; min-interval merge; identity
  enrichment throttling; README/docs; closeout journal.
- Gate: full `pnpm run test:fast` green; live smoke of all flows.

---

## 7. Cross-host participation notes

- **Identities & gas**: OAC bots write with their own signers (per-profile
  wallets). Participation costs gas per pin (~1–3k sats). Wallets must be
  funded; the claim/parentRefs guards exist precisely to avoid burning pins
  on ignored writes.
- **Same chain, shared truth**: OAC bots and IDBots bots see the same pools.
  Cross-host replay equality (P3 gate) is the standing health check.
- **Roster**: pilot ran rosterless by decision; production tasks should
  publish a roster when several bots share one operator (advisory in v1.3.0
  registration). The publish flow auto-creates one when ≥2 local bots exist
  (IDBots behavior — keep it).
- **H_ACT3 timing**: announced 192800 (≈ 2026-10-07). Before the boundary
  reaches it, write-side competitive publishes are refused everywhere except
  the documented escape hatch — this is protocol-correct behavior, not a bug.
- **Old-client writes**: pre-v1.3 clients can still write claim/submit without
  parentRefs; those land as `invalid_reference` and are ignored (already
  observed live ×4). OAC's UI should surface `ignoredEvents` as the IDBots UI
  does (chain view dims them; detail lists reasons) — it explains "why didn't
  my submission count" without support tickets.

---

## 8. Conformance acceptance (the hard gate)

1. `tests/fixtures/metatask/conformance-vectors.json` (16) and
   `conformance-vectors-v13-draft.json` (11) ported **byte-identically**
   (sha256 of each file must equal the IDBots copies; the on-chain set
   `metafile://71f09271…c58ei0` holds the same content).
2. The OAC runner prints `CANONICAL_SHA256` and it equals
   `726959e97e354b1489c2baa4923702193e0b1ce38871cfc1bca830eb9e9dcfd0`.
   Recipe (do not improvise): per vector — hash vectors push `{id, inner,
   outer}`; replay vectors push `{id, nodes{nodeId:status}, taskComplete,
   engineAlgoVersion(per task mode)}`; digest = `sha256(canonJ(outputs))`,
   sets run legacy-then-competitive in that order. Reference implementation:
   IDBots `scripts/metatask-vectors.mjs` (post-alignment version).
3. Pilot replay parity (P1 gate) with the exact numbers in §6 P1.
4. Tree-mode byte compatibility: all pre-H_ACT3 tasks replay identically in
   both hosts (spot-check any wave-1 task root from
   `scripts/metatask-campaign/wave1-launch-record.json`).

---

## 9. Risks & gotchas (things that already bit us once)

1. **No SQLite / Node 20**: do not attempt to port `projectionStore.ts`
   line-by-line; the JSON redesign (M3) is deliberate and tested-in-spirit by
   the ported store tests.
2. **Projection format drift**: keep `PROJECTION_FORMAT_VERSION=3` and the
   dirty-key salt. A store that serves stale projections after an upgrade
   showed up in IDBots acceptance as "the new UI shows the old replay" — the
   salt is the fix, keep it.
3. **Truncated indexer bodies**: without the collector's recovery, large spec
   bodies silently degrade and the dirty key never heals (root cause of a
   real IDBots incident). Port it with its tests.
4. **Mirror childids**: the positional mirror comparison (v1.2.2 ruling 2) is
   easy to drop — it is registered semantics; the ported engine test must
   include the three-case test (equal → pass, reordered → blocked,
   result-only → set-compare).
5. **engineAlgoVersion renaming**: forbidden (breaks the anchor digest).
6. **Dead-parent submissions**: refuse at the writer (gas) even though replay
   would never chain-validate them; the registration text says "are refused"
   and the writer is the honest layer for it (alignment doc §2 row 3).
7. **daemon-sole-writer discipline**: never let the CLI or UI write the JSON
   store directly; one refresh pipeline only, or watch/alerts will fork.
8. **Idempotence of refresh**: indexer paging must run to the empty page
   (priority-anchoring rule); partial pages create phantom "open" states.

---

## 10. Definition of done (port complete)

- All phase gates (P0–P7) green.
- An OAC-only competitive task (published, worked, verified, settled entirely
  by OAC bots) replays byte-identically in IDBots and in OAC.
- Both UIs pass the companion doc's fidelity checklist with screenshots.
- The two skills are visible in a fresh `oac install` (skillpacks diff-clean
  in CI).

---

## 11. References

### OAC (target) — verified structure

- CLI registration: `src/cli/main.ts` (switch), `src/cli/commandHelp.ts`
  (`COMMAND_HELP_SPECS`), `src/cli/commands/grouptask.ts` (flag→deps pattern)
- daemon routing: `src/daemon/routes/{types,grouptask,chain}.ts`,
  `src/daemon/httpServer.ts` (`ROUTES`), `src/daemon/defaultHandlers.ts`
- tick loop: `src/daemon/automationTicks.ts:515` `startAutomationTickLoop`;
  registration examples in `src/cli/runtime.ts` (schedule/dream/chain-history
  ticks)
- storage conventions: `src/core/state/paths.ts`, `src/core/grouptask/store.ts`,
  `src/core/knowledgebase/indexStore.ts` (versioned derived layer)
- indexer clients: `src/core/surf/manapiPins.ts`, `src/core/surf/surfReads.ts`,
  `src/core/grouptask/backfill.ts`
- skills: `SKILLs/metabot-grouptask/SKILL.md`,
  `src/core/host/hostSkillBinding.ts`, `scripts/build-metabot-skillpacks.mjs`
- port precedent: `docs/superpowers/plans/2026-08-24-idbots-parity-port-plan.md`
- DSH native tools: `dsh-plugin/src/group-task-tools.ts:660`,
  `dsh-plugin/src/context-types.ts:136`
- UI surfaces: see companion doc §6/§7 (exhaustive file lists there)

### IDBots (source)

- All S1–S14 paths in §3.
- Registration: pin `fd33de09e0ff314016ff76e12d47c38bb0ee17fc7a9706bbfd3824ded0c0c947i0`;
  alignment records `docs/metaid_protocols/metatask-v1.3.0-alignment.md`,
  `metatask-v1.2.1-alignment.md`.
- Pilot: root `fad848f86d360fb61f3308b4b9eae7f6c9816eeb8eef86f2bf911c70ab8bed10i0`;
  launch record `scripts/metatask-v13-pilot/launch-record.json`; wave-1 record
  `scripts/metatask-campaign/wave1-launch-record.json`.
- Wizard: `SKILLs/metatask-wizard/SKILL.md`, `scripts/metatask-wizard/*`.
- Design mocks (bundle these three files with the port docs):
  `docs/design/metatask-chainview-mock.html`,
  `docs/design/metatask-detail-v2-mock.html`,
  `scripts/metatask-wizard/decomposition-preview.html`.
