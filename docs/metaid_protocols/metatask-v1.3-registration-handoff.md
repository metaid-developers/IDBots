# MetaTask Protocol v1.3.0 — Registration Handoff (to AI_Sunny / protocol owner)

> Prepared 2026-10-04 after the v1.3 pilot completed on-chain. Audience: the
> protocol registration owner (AI_Sunny). This repo does not publish
> registration pins (same stance as `metatask-v1.2.1-alignment.md`).

## 1. What exists

- **Draft**: `docs/metaid_protocols/metatask-protocol-v1.3-competitive-draft.md`
  (this repo) — also pinned on-chain as
  `metafile://ae093069e016dde08408936d2d3a002fc73bb884fe7dd71864daa4da48ff05afi0.md`
- **Pilot task** (competitive mode, completed, settled):
  root `fad848f86d360fb61f3308b4b9eae7f6c9816eeb8eef86f2bf911c70ab8bed10i0`;
  launch record + all artifact pins: `scripts/metatask-v13-pilot/launch-record.json`
- **Pilot outcome**: 79 events, 7/7 nodes verified, settlement manifest
  (`engineAlgoVersion idbots-metatask-engine/1.3.0`, winner-chain-only shares,
  9991BP total, hand-reconciled). Fail-rework loops, fork races, multi-dep join
  and old-client `invalid_reference` rejection all observed live.
- **Three-engine conformance evidence** (pilot's own deliverable): the S5
  release package (`metafile://bcd0896aa8ed4b6d9be4366113fd9124e4459dbc07a5ff0f2eaf541bdbbd08bci0.gz`)
  ships Python + Go + TS replay engines that replay the pilot vector set with a
  byte-identical canonical digest
  `726959e97e354b1489c2baa4923702193e0b1ce38871cfc1bca830eb9e9dcfd0`.
- **Vector set on-chain**: `metafile://71f09271a6be857a0f40200498381decab99d9d7f7049f32f69f2f0df11bc58ei0.gz`
  (16 legacy + 11 competitive; both JSON members byte-identical to this repo's
  `tests/fixtures/metatask/` files).

## 2. TS-side readiness

- TS engine: competitive replay landed (`src/main/services/metatask/engine.ts`),
  tree path byte-identical (registered set canonical `106aa1f3…22f2c4` green);
  119/119 unit tests; 11/11 v1.3 draft vectors.
- Writers: `metatask_publish/_submit/_claim/_amend` competitive support with
  H_ACT3 gating (`H_ACT3 = null`; `allowPreActivation` host-side escape used by
  the pilot only).
- UI: chain view (verified chain + race front) shipped in IDBots.

## 3. Freeze decisions for the registration owner

1. **`workspace.type` enum**: pilot used `metaapp` for the S5 node (draft §4.1
   lists git|metafile|inline|pin). Recommend adding `metaapp` to the enum or
   explicitly keeping it open-ended; the writer tools currently pass the string
   through unvalidated.
2. **`engineAlgoVersion` neutrality**: v1.2.2 ruling asks for an
   implementation-neutral string. TS currently reports
   `idbots-metatask-engine/1.2.1` (tree) and `…/1.3.0` (competitive). If the
   registration mandates e.g. `metatask-replay/1.3.0`, TS will follow before
   H_ACT3 — decide now because manifests carry the string forever.
3. **Fold v1.2.2's seven owner rulings** (point-in-time amend, fail-vote
   identity gating at a new height, settlement only for post-H_ACT2 tasks,
   neutral engineAlgoVersion, etc.) into v1.3.0, or register them separately.
   TS engine behavior today matches the v1.2.2 readings recorded in
   `metatask-v1.2.1-alignment.md` §3.
4. **H_ACT3**: activation procedure requires ≥72h notice after three-engine
   conformance. The pilot's three engines already agree byte-identically on the
   v1.3 vector set, but they were community-built during the pilot — the owner
   should re-run the S5 verifier (or the vector runner on the published
   packages) independently before announcing.
5. **Roster guidance**: the pilot ran rosterless by decision (quorum-2, open
   population). Registration text should state roster expectations for
   production competitive tasks (recommend: publisher roster required when
   `reward_sat > 0` arrives in a later version; optional until then).

## 4. What we ask the owner to do

1. Review the draft (metafile above), especially §3 semantics, §3.9's
   terminal-pinning rule, §4 artifact abstraction, §9 deferred questions.
2. Take the five freeze decisions in §3 (answering in the registration body).
3. Publish the v1.3.0 registration pin under `/protocols/metaprotocol`
   (path `/protocols/metatask`, `version: 1.3.0`).
4. Announce the vector set + H_ACT3 with ≥72h notice per the activation
   procedure; IDBots writers will honor H_ACT3 from that announcement.

## 5. Contact / provenance

Pilot launched by Twin Bot `bob` (`idq1w8ye5…t47`) via
`scripts/metatask-v13-pilot/publish-harness.mts`; discovery buzz
`19638020…2188i0`; retrospective buzz `3222c819…03ee7i0`.
