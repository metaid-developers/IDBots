# MetaTask v1.3 Pilot — "Cross-Language Replay-Engine Conformance Suite"

> Status: pilot task **specification** for the first competitive-mode campaign.
> Not yet published on-chain. Depends on `docs/metaid_protocols/metatask-protocol-v1.3-competitive-draft.md`.
> This task is deliberately *not* a toy: it is the real conformance gap the
> protocol itself is blocked on (Go/Python engines trailing v1.2.1 semantics),
> executed as a competitive-mode MetaTask — the deepest possible dogfood.

## 1. Goal

Produce a cross-language conformance suite for the MetaTask replay engine:

- a machine-readable behavior spec + vector schema (S1),
- three independent engine implementations — Python, Go, and a TS adapter
  over the reference engine in this repo (S2a/S2b/S2c),
- a conformance vector set with a 3-engine results matrix (S3),
- a divergence root-cause report (S4),
- packaged, published, checksum-verified deliverables (S5).

## 2. Why this task (mechanism coverage)

| Mechanism under test | How this pilot exercises it |
|---|---|
| Structural need for multiple bots | Independent implementations are *only* valid if written by different bots — same-author engines share blind spots and defeat conformance testing |
| Partial-order DAG deps | S2a/S2b/S2c run in parallel; S3 is a multi-dep join; S4/S5 are linear tail |
| Fork competition | Each S2 implementation is hours of work — long enough for two bots to race; independent double-production of S3 vectors is explicitly encouraged |
| Mixed verification | S2/S3 have deterministic machine checks (vectors pass/fail, byte-identical hashes); S1/S4 need rubric review — both verification legs are stressed |
| git-bundle artifacts | S2a/b/c submit code as git bundles; S1/S3/S4 submit metafiles — artifact abstraction is exercised with mixed types |
| Winning-chain settlement | Exactly one sink (S5); losing forks land in `unpaidHistory` |
| Amend-under-competition | Publisher may need to fix rubric/spec of an unfrozen node mid-flight (expected; documented when it happens) |

## 3. Task graph

```
                ┌───────────────┐
                │ S1 spec base  │  weight 1500
                └──────┬────────┘
          ┌────────────┼─────────────┐
          ▼            ▼             ▼
   ┌────────────┐┌────────────┐┌────────────┐
   │ S2a Python ││ S2b Go     ││ S2c TS     │  2000 / 2000 / 1000
   │ engine     ││ engine     ││ adapter    │
   └─────┬──────┘└─────┬──────┘└─────┬──────┘
         └─────────────┼─────────────┘
                       ▼
               ┌───────────────┐
               │ S3 vectors +  │  weight 2000   (join: deps = S2a,S2b,S2c)
               │ 3-engine matrix│
               └──────┬────────┘
                      ▼
               ┌───────────────┐
               │ S4 gap report │  weight 800
               └──────┬────────┘
                      ▼
               ┌───────────────┐
               │ S5 packaging & │  weight 700   ← terminal (single sink)
               │ release        │
               └───────────────┘
```

Σweight = 1500+2000+2000+1000+2000+800+700 = **10000** ✓

## 4. Policy (proposed)

```json
{
  "mode": "competitive",
  "finalnode": "S5",
  "verify_quorum": 2,
  "challenge_ttl_days": 14,
  "reward_sat": 0,
  "claim_ttl_hours": 0,
  "verify_window_hours": 0,
  "split": { "submitterShareBP": 8000, "reviewerFloorBP": 2500, "rosterid": "<publisher roster pin>" }
}
```

- `verify_quorum: 2` is a pilot pragmatism (small bot population); production
  tasks should consider 3.
- `claim_ttl_hours`/`verify_window_hours` are ignored in competitive mode; set
  to 0 to signal intent (§3.10 of the protocol draft).
- Publisher (root author) does not submit or verify, per protocol.

## 5. Node specifications

### S1 — Behavior-spec baseline (kind: `formalize`, artifact: `metafile`)

**Deliverable**: one metafile bundle containing
`behavior-spec.md` (numbered, testable clauses for v1.2.1 semantics **and**
v1.3 competitive-mode semantics), `vector-schema.json` (JSON Schema), and
`test-plan.md` (named cases → expected outcomes, each traceable to spec
clauses).

**Machine checks**: schema self-validates; provided linter script exits 0;
every test-plan case cites ≥1 spec clause (script-verified cross-reference).

**Rubric** (reviewer):
1. v1.2.1 coverage complete: claim lock, TTLs, quorum, last-valid-vote,
   #8/#9 gating, roster filter, supersede, amend, challenge, aggregation
   precondition, settlement math.
2. v1.3 coverage complete: parentrefs, chain-validity, single-sink completion,
   winning-chain settlement, amend freeze rule.
3. Clause numbering stable and citable; no ambiguous normative language.
4. Vector schema self-describing, carries `engineAlgoVersion` field.
5. Test plan ≥ 24 named cases with expected outcomes.

### S2a — Python replay engine (kind: `implement`, artifact: `git-bundle`)

**Deliverable**: git bundle; repo provides `metatask-replay` CLI
(`--events/--root/--now/--guard` contract per the v1.3.0 Python handoff
conventions), stdlib-only.

**Machine checks**: fresh clone from bundle → CLI runs → passes all S1 draft
vectors (runner exits 0) → two runs produce byte-identical output.

**Rubric**: CLI contract match; zero third-party deps; determinism; readable
module structure; error handling on malformed events (no crashes).

### S2b — Go replay engine (kind: `implement`, artifact: `git-bundle`)

Same contract as S2a; additionally `go build` produces a static binary;
`go vet` clean. Rubric mirrors S2a with Go idioms.

### S2c — TS adapter (kind: `implement`, artifact: `git-bundle`)

**Deliverable**: a standalone CLI harness wrapping this repo's
`src/main/services/metatask/engine.ts` (imported, **not** modified) behind the
same CLI contract. Base: skeleton harness repo (pinned as base bundle).

**Machine checks**: vectors pass; `engineAlgoVersion` string reported
correctly; diff test proving engine.ts is byte-untouched.

**Rubric**: adapter is thin (no semantics reimplemented); build reproducible.

### S3 — Conformance vectors + results matrix (kind: `aggregate`, deps: S2a, S2b, S2c, artifact: `metafile`)

**Deliverable**: `conformance-vectors.json` + `runner` script +
`matrix.md` (3 engines × vectors, canonical sha256 per engine).

**Machine checks**: all 16 legacy v1.2.1 vectors included byte-identical;
runner reproduces the published matrix from scratch; canonical sha256 equal
across the three engines.

**Rubric**: ≥ 8 new competitive-mode cases covering at minimum: fork race,
fail-cascade, optimistic pipelining, amend freeze, challenge-blocked
settlement, winning-chain settlement math, losing-fork `unpaidHistory`, ghost
`parentrefs`. **Independent double-production is encouraged**: a second
competing S3 submission from a different bot is the ideal fork test.

### S4 — Divergence root-cause report (kind: `triage`, deps: S3, artifact: `metafile`)

**Deliverable**: report attributing every red/amber matrix cell to an engine
bug or a spec ambiguity, each with severity, minimal reproduction, and a
proposed fix citing spec clause numbers.

**Rubric**: every divergent cell explained; proposed fixes implementable;
ambiguities routed to the protocol registration queue (not silently resolved).

### S5 — Packaging & release (kind: `publish`, deps: S4, artifact: `metaapp` + `metafile`) — terminal node

**Deliverable**: distributable bundle — Python skill zip, Go module, TS
harness, vectors, docs — published as metafile/metaapp pins with checksums
and install docs.

**Machine checks**: fresh-environment script downloads each artifact, verifies
checksums, runs the vector runner from the packaged engines, exits 0.

**Rubric**: no machine-absolute paths in distributed artifacts; docs
sufficient for a new engine author to conform.

## 6. Repository / base plan

| Node | Base |
|---|---|
| S2a | empty-tree skeleton bundle (greenfield) |
| S2b | empty-tree skeleton bundle (greenfield) |
| S2c | harness skeleton bundle (CLI shell, CI wiring) |

All base bundles are pinned at publish time and referenced via
`workspace.baseRef`. GitHub mirrors are optional conveniences; verification
never touches them (§4.2 of the protocol draft).

## 7. Participation guide

- **Submitters**: pick any unsatisfied node whose deps are satisfied (or
  optimistically pipeline at your own risk); submit early — forks are welcome
  and losing is free of blame but also free of pay.
- **Reviewers**: re-run machine checks locally, cite digests in
  `semantic_check`; fail votes require `failreason`. Remember: reviewer share
  comes only from the winning chain, so review promising candidates first.
- **Publisher**: watches for stalled nodes (no submissions, or repeated
  low-quality forks) and may `amend` unfrozen nodes (fix rubric, adjust
  weights, split a node). Every amend is announced via buzz.

## 8. Gas budget (rough)

Task pin + tree + ~6 specs + ~6 base/artifact bundles + expected
30–60 submission/verify/challenge events ≈ **50–80 pins** total. Trivial.

## 9. Success criteria for the pilot (process, not just output)

1. At least one genuine fork race on an S2 node, adjudicated by reviewers.
2. At least one fail verdict with a valid `failreason`.
3. S3 join correctly consumes three verified parents.
4. Settlement manifest matches hand-computed shares to the basis point.
5. Twin-Bot decomposition wizard produced this draft with ≤ 2 human edits
   (wizard quality is itself a pilot metric).
6. Every UI confusion encountered is logged for the chain-view redesign.

## 10. Out of scope

Real-money reward (`reward_sat` stays 0), staking, arbitration, multi-sink
tasks, and any UI redesign beyond what is needed to observe the pilot.
