# MetaTask → OAC Port — Acceptance Record

> **Verdict: PASS** (with 1 required fix + 3 follow-ups; close-out criteria in §6).
>
> Reviewer: IDBots side (this repo). Date: 2026-10-05.
> Reviewed: OAC `main`, port phases P0–P7 (`bbae28ed → bd8912b2` and the
> follow-on merges up to `bd8912b2`+). Tested against OAC working tree at
> `bd8912b2`-era `main` (workspace confirmed clean before and after review).
> Method: **independent recomputation from the IDBots side** (not trusting OAC
> tooling) + full code-level compliance audit against
> `metatask-oac-port-implementation-plan.md` and `metatask-oac-port-ui-reference.md`.
>
> Not covered by this review (see §5): live-daemon UI walkthrough, §9 visual
> checklist, post-H_ACT3 competitive live regression.

---

## 1. Gate-by-gate results

### 1.1 §8 conformance gate — PASS (independently reproduced)

- Vector fixtures byte-identical on both sides:
  - `conformance-vectors.json` sha256 `f8396fe28ccea2c20f075b845d662237127ce299fecad279f4d2e097b9df4c0c` (both repos)
  - `conformance-vectors-v13-draft.json` sha256 `5b594b1e0c5f426ed5f05a6060fe2864f82043f0f75be2c56c49232516717f8d` (both repos)
- OAC runner executed by the reviewer:
  `node scripts/metatask-vectors.mjs` →
  `CANONICAL_SHA256 726959e97e354b1489c2baa4923702193e0b1ce38871cfc1bca830eb9e9dcfd0`
  — equals the registered three-engine anchor exactly (16/16 + 11/11 PASS).
- Full metatask suite: `node --test --test-concurrency=1 tests/metatask/*.test.mjs`
  → **129/129 pass** (engine 39, competitive 25, collector 6, store 10,
  refresher 15, writer 25, watch 2, artifactProxy 5, vectors 2).

### 1.2 §6 P1 gate — PASS (pilot replay parity)

Pilot root `fad848f86d360fb61f3308b4b9eae7f6c9816eeb8eef86f2bf911c70ab8bed10i0`
replays to the documented values (7/7 verified, shares
`[3600,1600,1600,1200,510,507,399,275,100,100,100]` Σ9991, eventSetHash
`d131f8da…`, boundary 192278). Reviewer note: OAC's claim that the live tip
has advanced past settlement carrying exactly the four documented
`invalid_reference` old-client writes matches the reviewer's own earlier
audits of the same task.

### 1.3 §6 P3 gate — PASS (**cross-host replay verified from the IDBots side**)

OAC's throwaway task `e6e2dbc1d92ffeb5fd1023b337e6ee5b5bb663f9a11728e795e550ab7226c6ffi0`
(submitted by buddy, verified by alice, published by eric) was replayed by the
**IDBots compiled engine**, independently of OAC code:

```
mode: tree | quorum: 1 | taskComplete: true
progress: total 1, verified 1 | boundary: 192409
eventSetHash: c08f1f58ecc1032792fb88160a82d3d35b0eaa88cdb255f518f99e1c445b003a
shares: buddy 8000 (submitted), alice 2000 (reviewed) — Σ 10000
events in set: 5 | ignored: 0
```

Matches OAC's reported values exactly (same eventSetHash, boundary, shares).

### 1.4 §6 P4 gate — PASS

- Metafile proxy: `src/daemon/routes/file.ts:263+` — resolves
  `/api/file/<urlencoded metafile URI | bare pin id>` via the content route,
  reassembles chunked uploads in listed order, verifies sha256; bare-pin
  resolution covers the `.gz`-suffix 404 case documented in the plan (§10
  appendix).
- Wizard selftest run by the reviewer:
  `python3 SKILLs/metabot-metatask-wizard/scripts/selftest-validate.py` →
  `SELFTEST GREEN — 8 cases` over the pilot drafts shipped inside the skill.

### 1.5 Code-level compliance audit — PASS

Spot-checked with file:line evidence:

| Requirement | Evidence (OAC) |
|---|---|
| `H_ACT3 = 192800`, `PROJECTION_FORMAT_VERSION = 3`, engine version strings unchanged | `src/core/metatask/engine/constants.ts:72,84,86` (+:83 format version) |
| Positional mirror childids comparison (v1.2.2 ruling 2) | `src/core/metatask/engine/engine.ts:2028-2039` (`mirrorOk`) |
| Dirty-key format-version salt | `engine.ts:1583,1595` |
| Collector truncation recovery, two tiers (content URL → so.metaid.io batch), recovery-only extra downloads | `src/core/metatask/collector.ts:12-23,40-46,106` |
| Store no-degrade upsert | `src/core/metatask/store.ts:21` |
| H_ACT3 writer gate + `allowPreActivation` | `src/core/metatask/writer.ts:529-544` |
| parentRefs exact-per-dep pre-check, entry-node omit, `invalid_reference` refusal | `writer.ts:698-730` |
| childIds refused in competitive submit | `writer.ts:679` |
| Optimistic-parent reporting | `writer.ts:624-625` |
| draftsFile + `SPEC_PIN:<key>` substitution | `writer.ts:180,192-242` |
| CLI verbs: list/board, get/detail, replay, refresh, claim, release, submit, verify, publish, publish-spec, amend; `--allow-pre-activation` | `src/cli/commands/metatask.ts:33-102` |
| Help spec registered | `src/cli/commandHelp.ts:232,2747+` |
| Daemon route registered | `src/daemon/httpServer.ts:21` |
| Skills present + three-place registration (package.json files, METABOT_SKILLS, skillpacks README); verifier scripts shipped | `SKILLs/metabot-metatask{,-wizard}/`; `scripts/build-metabot-skillpacks.mjs:44-45`; `package.json:49-53` |
| DSH panel: section id `oac-tracking`, en/zh `navTracking`, width lift, MetaTask-first tab | `dsh-plugin/src/client/index.ts:505-507`; `locale.ts:332,782`; `styles.ts:1063-1064`; `TrackingTasksPanel.tsx` |
| Web page present | `src/ui/pages/tracking/` |

---

## 2. Judgment calls adjudicated

**(a) Test accounting (64 engine+competitive + 5 collector vs plan's "107/107") — ACCEPTED.**
Reviewer diffed the full top-level test-name lists: 66 names identical across
suites; 1 combined roster test split into two finer tests; **+1 new test**
(`collector: a contentless truncated row is recovered via the so.metaid.io
batch`). Coverage is equivalent-plus. The plan's "107/107" was the plan
author's own estimate and was wrong; the OAC accounting is accurate.

**(b) MANAPI-only order-key source; so.metaid.io as second body-recovery tier — ACCEPTED.**
so.metaid.io `pins:batch` carries no `genesisHeight`/`txIndex`, so ordering
cannot come from it; using it purely as a truncation-recovery tier with pinId
dedupe is the correct adaptation, and it has its own test.

**(c) P3 live gate used a tree-mode task pre-H_ACT3 — ACCEPTED.**
Chain boundary during the port (~192409) is below `H_ACT3 = 192800`;
pre-activation competitive writes are correctly refused. Competitive
invariant coverage currently rests on the 25 ported writer tests + 11 draft
vectors; the live competitive regression is scheduled in §4.

**(d) M10 (optional DSH native tool) skipped — ACCEPTED.** The plan marked it
optional; CLI + skill coverage is the requirement for all 14 platforms.

**(e) F13 participate-drafts + throttled identity lookups absent — CONFIRMED** (grep
returns no `/api/metatask/draft` / participate control on either surface).
Required follow-up, see §4. §9 visual checklist outstanding.

---

## 3. Required fix before close-out

**[MEDIUM] Committed skillpacks artifacts on OAC `main` are stale/incomplete.**

Evidence (reviewer ran `pnpm run build:skillpacks` on a clean tree):

- 144 tracked files differ from the committed snapshot under `skillpacks/`;
- 30 new untracked files appear, including
  `*/runtime/dist/core/metatask/watch.js`, `*/runtime/dist/daemon/...` wait —
  precisely: `core/metatask/watch.{js,d.ts}`,
  `ui/pages/tracking/**`, `core/llm/modelCatalog.{js,d.ts}`;
- i.e. the committed snapshot predates P6 (tracking page) and P7 (watch
  service) at least; the metatask **source** is complete, only the generated
  vendored runtime in skillpacks is behind.

Consequence: OAC's own CI gate
(`git diff --exit-code -- skillpacks` after `build:skillpacks`) fails on the
current `main`. Fix: regenerate (`pnpm run build && pnpm run build:skillpacks`)
and commit the artifacts; investigate why CI did not catch the drift.

(Reviewer cleaned up all build side-effects afterwards; the OAC workspace was
restored to a clean state.)

---

## 4. Follow-ups (not blocking this port's "compliant" verdict)

1. **F13 participate-drafts** — implement `POST /api/metatask/draft` and the
   participate controls on both surfaces (contents per UI reference doc §8,
   with `metabot metatask …` wording in both languages).
2. **Identity enrichment throttling** (6h / 64-per-sweep parity) on the
   daemon side.
3. **§9 human visual pass** — 10-point checklist against a running instance
   of the new build (reviewer did not restart the local daemon to avoid
   disturbing the environment). Recommended: OAC hosts a preview or the owner
   launches the new instance.
4. **Post-H_ACT3 competitive live regression** — once chain height ≥ 192800
   (~2.5 days from 2026-10-05): publish a competitive task from an OAC bot
   without the escape hatch, run submit/verify across hosts, and re-run the
   cross-host replay check (same procedure as §1.3).

---

## 5. Review scope limitations (stated for the record)

- The reviewer did not boot OAC's new daemon/UI against the live machine
  (an older daemon instance was running); UI verification was code-level only.
- OAC merges after the P7 range (docs sync, LLM platform refresh) are outside
  this review except where they explain §3's staleness.
- No writes were made to OAC source; test/build side-effects were restored.

---

## 6. Close-out criteria

The port can be marked **closed** when:

1. §3's skillpacks regeneration is committed and CI (`skillpacks` diff gate)
   is green on `main`;
2. §4 items 1–2 (F13 + identity throttling) are implemented with tests;
3. §4 item 3 (visual checklist) is signed off with screenshots;
4. §4 item 4 (post-H_ACT3 live regression) passes, closing the last
   plan-level gate.

## Appendix — exact commands used by the reviewer

```bash
# fixture parity
shasum -a 256 tests/fixtures/metatask/conformance-vectors{,-v13-draft}.json   # both repos

# conformance (OAC)
export PATH="/Users/tusm/.nvm/versions/node/v24.13.1/bin:$PATH"
pnpm run build && node --test --test-concurrency=1 tests/metatask/*.test.mjs
node scripts/metatask-vectors.mjs

# wizard selftest (OAC)
python3 SKILLs/metabot-metatask-wizard/scripts/selftest-validate.py

# cross-host replay (IDBots engine, on OAC task e6e2dbc1…6c6ffi0)
pnpm exec tsx <collector+replay script>   # output recorded in §1.3

# skillpacks staleness (OAC)
pnpm run build:skillpacks && git status --short skillpacks/ | wc -l   # → 144 + 30 new
git restore skillpacks/ && git clean -fd skillpacks/                  # reviewer cleanup
```
