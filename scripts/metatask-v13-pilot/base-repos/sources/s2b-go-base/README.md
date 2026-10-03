# metatask-replay (Go) — S2b base skeleton

This repository is the **pinned base** for MetaTask pilot node **S2b** (Go
replay engine). Clone it, implement the CLI contract below, and submit your
work as a git bundle (`git bundle create <file> --all`) whose tip commit
descends from this base's tip.

## CLI contract (frozen by the task spec)

```
go run . --events <events.json> --root <rootPinId> [--now <ms>] [--guard]
# or, after `go build -o metatask-replay`:
./metatask-replay --events <events.json> --root <rootPinId> [--now <ms>] [--guard]
```

- `--events`: a JSON file holding the task's event list — either a bare array
  of chain events or a vector object `{ "events": [...], "options": {...} }`.
- `--root`: the task root pinId to project.
- `--now`: fixed clock (ms epoch) for TTL/expiry derivation; omit = no expiry.
- `--guard`: validate the event set strictly (unknown paths, malformed bodies)
  and exit 3 on the first guard violation instead of skipping it.

Stdout: the canonical replay projection as **one JSON object** with sorted
keys and no whitespace (canonJ), containing at least `nodeStates`,
`taskComplete`, and `settlement` (null or the manifest with
`engineAlgoVersion`, `winningChain`, `shares`). See the S2a README or the
acceptance sheet for the exact field contract — it is identical across the
three engines.

Exit codes: `0` success, `2` malformed input, `3` guard violation (`--guard`).

## Hard requirements (rubric-enforced)

1. **Stdlib only.** `go.mod` must carry no `require` directives for external
   modules; the verifier inspects it.
2. **`go build ./...` clean** and produces a static binary
   (`CGO_ENABLED=0 go build`); **`go vet ./...` clean**.
3. **Deterministic** — two runs over the same inputs are byte-identical (the
   verifier runs the vector set twice and compares the canonical digest).
4. **No panics on malformed events** — bad rows are skipped with a note.

## Vector runner contract

Provide an executable `run-vectors.sh <vectors-dir>`; same output contract as
the Python node: per-vector `PASS <id>` / `FAIL <id>: <note>` lines, then
`ENGINE metatask-replay-go <algoVersion>` and `CANONICAL_SHA256 <hex>`, exit 0
iff all pass. See the task's acceptance sheet for the full format.
