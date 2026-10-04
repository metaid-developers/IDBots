# MetaTask v1.3.0 Registration — IDBots Alignment Record

> Status: **aligned**. The v1.3.0 registration is on-chain; this record mirrors
> `metatask-v1.2.1-alignment.md`'s role for v1.2.1. This repo publishes no
> registration pins; it records conformance to the registered body.

## 1. Authorities

- **Registration pin**: `fd33de09e0ff314016ff76e12d47c38bb0ee17fc7a9706bbfd3824ded0c0c947i0`
  (`/protocols/metatask`, version 1.3.0, author AI_Sunny, supersedes v1.2.1
  `cbae49e0…fc55i0`). Companion local draft-of-record:
  `metafile://ae093069e016dde08408936d2d3a002fc73bb884fe7dd71864daa4da48ff05afi0.md`
  (byte-identical to this repo's
  `docs/metaid_protocols/metatask-protocol-v1.3-competitive-draft.md`).
- **Activation**: `H_ACT3 = 192800` (announced at height 192281, ~75h notice,
  procedure floor 72h). Set in `src/main/services/metatask/constants.ts`.
- **Announced vector set**: `metafile://71f09271a6be857a0f40200498381decab99d9d7f7049f32f69f2f0df11bc58ei0`
  = 16 legacy v1.2.1 vectors + 11 v1.3.0 competitive vectors; both JSON members
  are byte-identical to `tests/fixtures/metatask/conformance-vectors.json` and
  `conformance-vectors-v13-draft.json` in this repo.
- **Three-engine anchor digest**: `726959e97e354b1489c2baa4923702193e0b1ce38871cfc1bca830eb9e9dcfd0`
  (each engine replays all 27 vectors; `CANONICAL_SHA256 = sha256(canonJ(outputs))`).

## 2. Registration decisions vs this repo (all confirmed)

| Registration body | IDBots state |
| --- | --- |
| `policy.mode` absent ⇒ `"tree"`; pre-H_ACT3 tasks replay byte-identically | TS engine branches by mode; registered 16-vector set canonical sha256 `106aa1f3…22f2c4` still green |
| Writer gate: refuse competitive publishes pre-H_ACT3; `allowPreActivation` is host-side only, never changes replay | `metatask_publish` implements exactly this (`H_ACT3` from constants vs refresh boundary) |
| deps: dead-parent references (failed/superseded/invalid_reference) "are refused" | TS refuses them at the **writer**; at **replay** they are admitted but can never become chain-valid — outcome-equivalent, noted here as the standing TS reading |
| Publish invariants incl. non-empty `params.rubric` per node | Enforced in `metatask_publish` and `scripts/metatask-wizard/validate-task-draft.py` |
| Terminal pinning (finalnode stays a live deps sink; no layer above) | Engine + writer enforce; vector `v13-11-amend-sink-pinning` pins it |
| `workspace.type` enum closed: git/metafile/inline/pin/**metaapp** | Wizard validator accepts the full closed enum |
| `engineAlgoVersion` NOT renamed (tree `…/1.2.1`, competitive `…/1.3.0`); neutralization deferred | `constants.ts` unchanged |
| v1.2.2 ruling 1: aggregation anchor = parent's effective-submission height ≥ H_ACT2 | TS already implements (see `metatask-v1.2.1-alignment.md` §3) |
| v1.2.2 ruling 2: precondition childids compare is set-equality; **mirror (top-level ↔ result.childids) compare is positional** | Implemented in `engine.ts` (mirror check) with a dedicated test (equal → pass, reordered → blocked, result-only → set-compare order-insensitive) |
| v1.2.2 ruling 3: pre-H_ACT2 completion/settlement readings retained, no post-H_ACT2 tightening | TS unchanged |
| v1.2.2 ruling 4: roster content fetch caller-injected, shared gap | Unchanged (documented gap) |
| v1.2.2 ruling 5: two unrecoverable reference pins permanently removed | Doc-level, no code impact |
| Roster guidance advisory (mandatory only at a future reward_sat>0 version) | No code impact |

## 3. Conformance status (this repo)

- `pnpm run test:metatask`: 120/120 (incl. the new mirror-positional test).
- `pnpm run metatask:vectors`: 16/16 registered + 11/11 v1.3.0 vectors; the
  runner now also prints `CANONICAL_SHA256` per the three-engine recipe and
  matches the anchor digest `726959e9…dcfd0` exactly.
- Pilot replay (task root `fad848f86d…8bed10i0`): 79 events, 7/7 verified,
  settlement manifest byte-consistent with the registered semantics.

## 4. Standing notes for the next version

- The TS writer-vs-replay asymmetry on dead-parent references (§2 row 3) is
  the one place the registration wording ("are refused") is implemented at a
  different layer; if a future engine ever replays them differently, align the
  text or the layer, not the outcome.
- `engineAlgoVersion` neutralization requires vector-set regeneration
  (registration body, replayAndHashing.frozenDecision).
- Open questions Q1–Q4 (multi-sink, stale submissions, fail-voter pool, spam
  caps) remain deferred per the registration body.
