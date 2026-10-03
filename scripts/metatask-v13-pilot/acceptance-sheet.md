# MetaTask v1.3 Pilot — Acceptance Sheet (correspondence artifact)

> Independent correspondence artifact for the pilot task "Cross-Language
> Replay-Engine Conformance Suite". Every spec pin's
> `validation.proposition_fidelity` references this document's published
> metafile pin. It maps each node's rubric (the reviewer's checklist, pinned at
> `params.rubric`) to what the node's spec script actually machine-checks, and
> defines every artifact format the scripts enforce. Substance judgments that
> no script can make are explicitly assigned to the reviewer.
>
> Sources of truth: `docs/design/metatask-v13-pilot-conformance-suite.md`
> (task), `docs/metaid_protocols/metatask-protocol-v1.3-competitive-draft.md`
> (protocol v1.3.0 draft), `scripts/metatask-v13-pilot/` (this kit).

## Verifier contract recap (draft §4.3, as implemented by this kit)

Every spec script reads its environment, never stdin:

| Variable | Git nodes (S2a/S2b/S2c) | Metafile nodes (S1/S3/S4/S5) |
| --- | --- | --- |
| `METATASK_ARTIFACT_URI` | metafile://<submission git bundle> | metafile://<submission artifact> |
| `METATASK_COMMIT` | submission tip commit (40-hex) | — |
| `METATASK_BASE_COMMIT` | declared base commit (`null`/empty = greenfield, §4.4) | — |
| `METATASK_NODE` / `METATASK_TASKID` | yes | yes |

Exit codes: **0 pass** (evidence log on stdout, final line a JSON
`{"verdict":"pass","detail":…,"checks":N}`), **1 fail** (reason on stderr), **2
invalid** (null/empty/unresolvable input — the `null_tolerance` leg). Each
script counts its checks and asserts the total on the pass path
(`enumeration_closure`: the declared `expected_count` equals the script's
`EXPECTED_CHECKS` constant).

Toolchain policy: python3 + git + bash are assumed everywhere. node+npx are
additionally allowed for S2c/S3/S5 (pilot task sheet). go is required only for
S2b; for S5 the go leg never invokes the toolchain directly — the packaged
`run-vectors.sh` chooses a prebuilt `bin/metatask-replay-go-<os>-<arch>` binary
first and falls back to `go run`. A missing **required** toolchain yields
**invalid** (never a fail — the reviewer must re-run on a capable machine); a
missing **optional** toolchain (S3's ts/go reproduction legs) is recorded as
SKIP evidence with the digest-equality invariant still enforced.

## Shared formats

### canonJ

`json.dumps(o, ensure_ascii=False, sort_keys=True, separators=(',', ':'))` —
byte-identical to `src/main/services/metatask/canon.ts`. All digests below are
sha256 over canonJ unless said otherwise.

### Vector runner contract (S2/S3/S5)

`run-vectors.sh <vectors-dir>` (S2 node repos) resp. `runner --engine <name>
--vectors <dir>` (S3 artifact) prints, in order:

- one `PASS <vector-id>` / `FAIL <vector-id>: <note>` line per vector,
- `ENGINE <engine-name> <engineAlgoVersion>` — the version the engine reports
  for **competitive-mode** tasks (`idbots-metatask-engine/1.3.0` when
  competitive vectors ran green, else `idbots-metatask-engine/1.2.1`),
- `CANONICAL_SHA256 <64hex>` — sha256 over canonJ of the ordered per-vector
  canonical outputs: `{"id","inner","outer"}` for hash vectors,
  `{"id","nodes":{id:status},"taskComplete","engineAlgoVersion"}` for replay
  vectors.

Exit 0 iff every vector passed.

### Matrix format (S3, and embedded in S4)

`matrix.md` carries a table whose header row is `| vector | python | go | ts |`
with one row per vector id (legacy set first, then competitive), cells ∈
`PASS | RED | AMBER` (RED = diverges from the vector's expect; AMBER = matches
expect but with noted warnings), and three digest lines:
`engine <python|go|ts> canonical sha256: <64hex>`.

## S1 — behavior-spec baseline (spec: `s1-behavior-spec-lint`, root spec)

### Artifact format (metafile → .tar.gz | .zip)

`behavior-spec.md` — normative clauses as headings `### C-NN(: title)`, NN
decimal, unique, sequential from C-01, ≥ 40 clauses.
`vector-schema.json` — JSON Schema for the vector format; must declare an
`engineAlgoVersion` property.
`test-plan.md` — cases as headings `#### TP-NN(: title)`; each case body cites
≥ 1 clause id `C-NN`; ≥ 24 cases.

### Rubric ↔ checks correspondence

| Rubric (task sheet §5.S1) | Machine-checked by spec-s1-lint.py | Left to the reviewer |
| --- | --- | --- |
| 1. v1.2.1 coverage complete (claim lock, TTLs, quorum, last-valid-vote, #8/#9 gating, roster filter, supersede, amend, challenge, aggregation precondition, settlement math) | — | **Yes** — reviewer reads the spec and ticks the clause list |
| 2. v1.3 coverage complete (parentrefs, chain-validity, single-sink completion, winning-chain settlement, amend freeze) | — | **Yes** — same |
| 3. Clause numbering stable and citable; no ambiguous normative language | numbering unique + sequential from C-01 (check 4) | ambiguity review |
| 4. Vector schema self-describing, carries `engineAlgoVersion` | schema parses; hand-written minimal structural validation (types/properties/required/items consistent); `engineAlgoVersion` present (checks 5–7) | whether the schema actually describes the vectors |
| 5. Test plan ≥ 24 named cases with expected outcomes | ≥ 24 `TP-NN` cases; every case cites ≥ 1 existing clause (checks 8–9) | whether expected outcomes are correct |

Machine checks 1–3 (env/artifact gates) correspond to no rubric item — they are
the §4.3/null-tolerance plumbing. `enumeration_closure.expected_count` = **9**.

## S2a/S2b/S2c — three engine nodes (specs: `s2a-python-engine`, `s2b-go-engine`, `s2c-ts-adapter`)

All three are `workspace.type: "git"`; submissions are git bundles (§4.2):
`result.type = "git-bundle"`, `result.commit` = tip, `result.baseCommit` = the
pinned base commit from the spec's workspace (the bundle carries full history,
so the base is always an ancestor of the submission — checked), `attachment` =
the bundle metafile. Base bundles are pinned as metafiles at publish and named
from `workspace.baseRef` (see "Open items" for the URI lifecycle).

### Shared machine checks (template spec-s2-engine)

env contract (gate 1–2) → toolchain evidence (gate 3) → vector-set reference
resolved (gate 4; placeholder unresolved ⇒ **invalid**) → artifact fetch (gate
5) → bundle verify + clone (check 6) → checkout `METATASK_COMMIT` (check 7) →
base-ancestry (check 8; skipped-with-evidence for greenfield `baseCommit:
null`) → language gates → vector runner ×2 → determinism.

### S2a (python) — 15 checks

Language gates: stdlib-only import scan (every top-level import ∈ stdlib ∪
repo-local modules; `requirements*.txt`/`Pipfile`/`setup.py`/nonempty
pyproject `dependencies` forbidden) (check 9); `metatask_replay.py` + runner
present (10–11); vector set extracted (gate 12); run 1/2 green (13–14);
determinism: identical `CANONICAL_SHA256` twice (15).

| Rubric | Machine | Reviewer |
| --- | --- | --- |
| CLI contract match (--events/--root/--now/--guard, exit codes) | runner exercised over the full set (13–14) | spot-check `--guard` behavior |
| zero third-party deps | check 9 | — |
| determinism | check 15 | — |
| readable module structure | — | yes |
| malformed events never crash | — (toy coverage in vectors) | yes (rubric review + vector content) |

### S2b (go) — 17 checks

Language gates: `go.mod` has no external `require`s (9); `go build ./...` (10);
`go vet ./...` (11); static binary `CGO_ENABLED=0 go build` (12); runner present
(13); vector set (gate 14); runs green ×2 (15–16); determinism (17). Rubric
mirrors S2a with Go idioms (reviewer leg).

### S2c (ts adapter) — 20 checks

Additional gates: base bundle reference resolved (gate 5bis — the pinned
s2c-ts-harness-base bundle), base bundle fetches + clones (checks 10–11),
**`vendor/metatask-engine/` byte-identical to the pinned base** (check 12 —
the "engine untouched" diff test), frozen install (13), build/typecheck clean
(14), runner present (15), vector set (gate 16), runs green ×2 (17–18),
determinism (19), ENGINE line reports `idbots-metatask-engine/1.3.0` on the
competitive set (20).

| Rubric | Machine | Reviewer |
| --- | --- | --- |
| adapter is thin; no semantics reimplemented | vendor byte-diff (12) | read the adapter |
| build reproducible | frozen install + typecheck (13–14) | — |
| engineAlgoVersion correct | check 20 | — |

## S3 — conformance vectors + results matrix (spec: `s3-matrix-check`)

### Artifact format (metafile → .tar.gz)

```
manifest.json               informational (per-file sha256)
legacy-vectors.json         byte copy of the announced v1.2.1 set (16 vectors)
competitive-vectors.json    >= 8 NEW competitive vectors
runner                      executable, contract above
matrix.md                   table + digest lines (format above)
engines/python.bundle       the S2a winning submission bundle
engines/go.bundle           the S2b winning submission bundle
engines/ts.bundle           the S2c winning submission bundle
```

### Rubric ↔ checks (11 checks)

| Rubric | Machine | Reviewer |
| --- | --- | --- |
| all 16 legacy vectors included byte-identical | check 4: canonJ sha256 of the parsed `legacy-vectors.json` == `106aa1f3bee8ebd48339ceb65f97a12e54247e1e831296a394a974c9cb22f2c4` and 16 vectors | — |
| ≥ 8 new competitive cases (fork race, fail-cascade, optimistic pipelining, amend freeze, challenge-blocked settlement, winning-chain settlement math, losing-fork unpaidHistory, ghost parentrefs) | check 5: ≥ 8 well-formed vectors with unique ids | topic coverage vs the required list |
| runner reproduces the matrix from scratch | checks 10–11 (python always; ts/go under available toolchains, else SKIP) | rerun on a full machine when SKIP appears |
| canonical sha256 equal across engines | check 7 | — |
| (plumbing) members present, table covers every vector id, bundles verify | checks 1–3, 6, 8–9 | — |

`enumeration_closure.expected_count` = **11**.

## S4 — divergence root-cause report (spec: `s4-report-structure`)

### Artifact format (metafile → .tar.gz)

`matrix.md` (the S3 matrix, format above) + `report.md` with one attribution
section per divergent cell: heading `#### ATTR: <vector-id> / <engine>`, body
carries a `severity: low|medium|high|critical` line and cites ≥ 1 clause
`C-NN`.

### Rubric ↔ checks (7 checks)

| Rubric | Machine | Reviewer |
| --- | --- | --- |
| every divergent cell explained | checks 4–5: table parses; RED/AMBER cells ↔ ATTR sections bijection | — |
| each attribution: severity + minimal reproduction + proposed fix citing spec clauses | checks 6–7: severity line + ≥ 1 clause citation present | reproduction sufficiency, fix implementability |
| ambiguities routed to the protocol registration queue (not silently resolved) | — | yes |

Pure structure only — substance is the reviewer's, per the task sheet.
`enumeration_closure.expected_count` = **7**.

## S5 — packaging & release (spec: `s5-release-verify`, terminal node)

### Artifact format (metafile → release package .tar.gz)

```
CHECKSUMS.txt        sha256sum format: `<64hex>  <relpath>` per member
python-skill.zip     packaged python engine (extract → run-vectors.sh)
ts-harness.tar.gz    packaged TS adapter (prebuilt; extract → run-vectors.sh)
go-module.tar.gz     packaged Go module (extract → run-vectors.sh; ships
                     bin/metatask-replay-go-<os>-<arch> prebuilt and/or source)
vectors.tar.gz       the S3 vector set
docs/install.md      install/usage docs
metaapp/index.html   release index page (also published as the metaapp payload)
```

The submission `result` declares the release package's sha256; reviewers
cross-check it against the artifact (rubric leg).

### Rubric ↔ checks (10 checks)

| Rubric | Machine | Reviewer |
| --- | --- | --- |
| fresh-environment: download, verify checksums, unpack, run packaged vector runners, exit 0 | checks 2–5 (fetch, member-set equality, sha256 verification), 7–9 (three packaged runners green) | — |
| no machine-absolute paths in distributed artifacts | check 6 (`/Users/`, `/home/`, `C:\Users` scan) | — |
| docs sufficient for a new engine author | — | yes |
| packaged engines still agree | check 10: three `CANONICAL_SHA256` digests equal | — |

`enumeration_closure.expected_count` = **10**.

## Open items (placeholders resolved at publish time)

1. **`VECTOR_SET_URI`** — embedded in the three S2 spec scripts as a literal
   placeholder; backfilled with the vector-set metafile URI once
   `vector-set/vector-set.tar.gz` is uploaded. Until then the scripts exit 2
   (invalid) — never fail. Offline runs may override with
   `METATASK_VECTOR_SET_URI` (the selftest uses this).
2. **`BASE_BUNDLE_URI:<key>`** — `workspace.baseRef` placeholders in the S2
   specs, backfilled with the uploaded base-bundle metafile URIs. The S2c
   script additionally embeds a `BASE_BUNDLE_URI` constant (same backfill) for
   its vendor byte-diff; overridable via `METATASK_BASE_BUNDLE_URI`.
3. **`ARTIFACT_PIN:acceptance-sheet`** — `validation.proposition_fidelity` of
   every spec, backfilled with this document's published metafile pin.
4. **`SPEC_PIN:<key>`** — node specid placeholders, backfilled by the six
   standalone `metatask_publish_spec` calls (S1's spec is the task root spec,
   written by `metatask_publish` itself).
5. **Metafile download URL convention** — spec scripts resolve
   `metafile://`/`pin://` artifacts as
   `<METATASK_DOWNLOAD_BASE>/file/<urlencoded URI>`. This is a **pilot-local
   convention**: no pre-existing convention was found in the wave-1 kit (its
   only remote fetch used a host-side `metabot <uri> --download` helper, which
   spec scripts cannot assume on a bare python3/git/bash machine). If the
   MetaWeb file gateway settles on a different path shape before publish, only
   the fetch helpers change; evidence logs always record the resolved URL.
