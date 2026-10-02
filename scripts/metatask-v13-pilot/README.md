# MetaTask v1.3 Pilot — Off-Chain Campaign Kit (scripts/metatask-v13-pilot/)

Everything the first **competitive-mode** MetaTask needs before a single pin is
spent: the seven node spec scripts, the three pinned S2 base repositories (as
git bundles), the pilot vector set, the acceptance sheet (the
`proposition_fidelity` correspondence artifact), the machine-validated task
drafts, and a publish harness that drives the REAL `metatask_publish` /
`metatask_publish_spec` tool logic over the metabot CLI chain writer.

Task sheet: `docs/design/metatask-v13-pilot-conformance-suite.md`
Protocol: `docs/metaid_protocols/metatask-protocol-v1.3-competitive-draft.md`

## Files

| File | Purpose |
| --- | --- |
| `spec-s1-lint.py` | S1 verifier: spec bundle members, clause numbering (≥ 40, sequential from C-01), hand-written JSON-Schema self-check with `engineAlgoVersion`, test-plan ≥ 24 cases with clause cross-references. 9 checks. |
| `spec-s2a-python.sh` | S2a verifier: bundle clone → base ancestry → stdlib-only import scan → vector runner ×2 → byte-identical canonical digest. 15 checks. |
| `spec-s2b-go.sh` | S2b verifier: + `go build`/`go vet`/`CGO_ENABLED=0` static build, go.mod stdlib-only. 17 checks. |
| `spec-s2c-ts.sh` | S2c verifier: + pinned-base clone, `vendor/metatask-engine/` byte-diff, frozen install + typecheck, `idbots-metatask-engine/1.3.0` ENGINE line. 20 checks. |
| `spec-s3-matrix.py` | S3 verifier: legacy set canonical sha256 (`106aa1f3…22f2c4`), ≥ 8 competitive vectors, matrix digest equality, bundle verify, toolchain-gated matrix reproduction. 11 checks. |
| `spec-s4-report.py` | S4 verifier (structural): RED/AMBER cells ↔ ATTR sections bijection, severity + clause citation per attribution. 7 checks. |
| `spec-s5-release.sh` | S5 verifier: CHECKSUMS.txt member-set + sha256 verification, abs-path scan, three packaged engine runners green, digest equality. 10 checks. |
| `base-repos/sources/` | Authored sources of the three S2 base repos (plain files; deterministic rebuild via `build-base-bundles.sh`). |
| `bundles/` | `*.bundle` (the pinned base artifacts) + `*.base-commit` (workspace.baseCommit values). |
| `vector-set/` | `conformance-vectors.json` (16 legacy, byte copy) + `competitive-vectors.json` (11 v1.3 draft) + `manifest.json` + `vector-set.tar.gz` (uploadable). Built by `build-vector-set.py`. |
| `acceptance-sheet.md` | The proposition_fidelity correspondence artifact: per-node rubric ↔ machine-check tables + every artifact format definition + the placeholder lifecycle. Published as a metafile BEFORE the specs. |
| `pilot-task-drafts.template.json` | Hand-authored drafts source (specs carry `scriptFile` staging keys). |
| `pilot-task-drafts.json` | The publishable drafts (scripts inlined, byte-identical to the standalone files). Regenerate: `python3 embed-specs.py`; staleness gate: `python3 embed-specs.py --check`. |
| `validate-pilot-drafts.py` | Pre-publish validator (competitive graph invariants, rubric presence, tool-shape policy, workspace/artifact consistency, bundle/commit reconciliation, placeholder inventory). Prints `PILOT DRAFTS READY`. |
| `selftest-pilot-specs.py` | Builds minimal fixtures from the base bundles (toy pseudo-passing implementations; the S2c toy runs the REAL vendored engine) and asserts exit codes + evidence lines for all 7 scripts. Fully local, no network. |
| `selftest-toys/` | The toy implementations the selftest overlays onto the base repos. |
| `publish-harness.mts` | `pnpm exec tsx publish-harness.mts <specs\|task\|all> [--broadcast]`. Default dry-run prints the pin plan; `--broadcast` writes via `metabot chain write` (Twin Bot) and records pinIds into `launch-record.json`. |
| `launch-record.json` | Placeholder backfills (uploaded metafile URIs) + published pinIds. Skeleton committed; filled by the publish run. |

## Runbook

```bash
# 0. regenerate derived artifacts after editing sources
bash    scripts/metatask-v13-pilot/build-base-bundles.sh     # base repos -> bundles (+ .base-commit)
python3 scripts/metatask-v13-pilot/build-vector-set.py       # fixtures  -> vector-set.tar.gz
python3 scripts/metatask-v13-pilot/embed-specs.py            # template  -> pilot-task-drafts.json

# 1. gates (all must pass before any spend)
python3 scripts/metatask-v13-pilot/validate-pilot-drafts.py  # -> PILOT DRAFTS READY
python3 scripts/metatask-v13-pilot/selftest-pilot-specs.py   # -> ALL PILOT SPEC SELF-TESTS PASSED
pnpm    exec tsx scripts/metatask-v13-pilot/publish-harness.mts all   # dry-run: full pin plan, zero writes

# 2. publish (manual uploads first, then the harness)
#    a. metabot file upload: bundles/*.bundle ×3, vector-set/vector-set.tar.gz,
#       acceptance-sheet.md → record the returned metafile URIs into
#       launch-record.json under artifacts{<key>.uri}
#    b. pnpm exec tsx scripts/metatask-v13-pilot/publish-harness.mts specs --broadcast
#    c. pnpm exec tsx scripts/metatask-v13-pilot/publish-harness.mts task  --broadcast
#    d. discovery buzz within 24h (title + full task root pinId + #metatask)
```

The publish order is the wave-1 order adapted to the pilot: artifacts →
standalone spec pins → task (root spec written by `metatask_publish`). The
harness refuses `--broadcast` of the task phase while any `SPEC_PIN:<key>` is
unresolved; competitive publishes always pass `allowPreActivation: true` (draft
§7 escape hatch — H_ACT3 is unannounced at authoring time; replay has no height
gate, so the pilot replays identically before/after activation).

## Verifier environment contract (draft §4.3, as implemented)

Every spec script: `METATASK_ARTIFACT_URI` / `METATASK_NODE` /
`METATASK_TASKID` (+ `METATASK_COMMIT` / `METATASK_BASE_COMMIT` on git nodes),
exit 0 pass / 1 fail / 2 invalid, evidence log on stdout with a final JSON
verdict line, and an `EXPECTED_CHECKS` counter asserted on the pass path.
Metafile resolution: `file://`/local path direct; `metafile://` via
`METATASK_DOWNLOAD_BASE` → `<base>/file/<urlencoded URI>` (**pilot-local
convention, see acceptance-sheet.md "Open items"**). Placeholder vector-set /
base-bundle URIs resolve to invalid (exit 2), never fail.

## Pilot decisions worth noticing

- **No roster pin** (`policy.split.rosterid` omitted): pilot adjudication is
  quorum-2 across the open bot population; same-side exclusion stays off.
- **S5 `workspace.type: "metaapp"`** extends the draft §4.1 enum
  (git|metafile|inline|pin): the human-facing artifact is the release index
  metaapp; the machine-checked artifact is the release-package metafile. If the
  draft freezes the enum, republish the S5 spec with `metafile`.
- **Tree root = S5** (the terminal sink), following the v1.3 conformance-vector
  fixture convention; `parent` is presentational backbone, `deps` carries the
  semantics.
- The S2 base repos pin deterministic commits (fixed author/date in
  `build-base-bundles.sh`); the drafts' `workspace.baseCommit` values are
  reconciled against `bundles/*.base-commit` by the validator.
