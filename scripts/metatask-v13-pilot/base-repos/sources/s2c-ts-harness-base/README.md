# metatask-ts-harness — S2c base skeleton

This repository is the **pinned base** for MetaTask pilot node **S2c** (TS
adapter over the reference engine). It ships the reference TS engine as a
**vendored snapshot** under `vendor/metatask-engine/`; your job is the
**adapter** (`src/cli.ts`), never the engine.

## Discipline (rubric-enforced)

- `vendor/metatask-engine/` is **read-only**. The verifier clones the pinned
  base bundle and diffs that directory byte-for-byte against your submission;
  any change fails the node. The adapter must be thin: translate the CLI/vector
  contract into `replayMetaTask` calls, print the canonical projection. Do not
  reimplement replay semantics in the adapter — that is what S2a/S2b are for.
- Snapshot provenance: see `vendor/metatask-engine/README.md`.

## CLI contract (frozen by the task spec)

Same contract as the sibling engines (S2a/S2b READMEs):

```
pnpm run -s replay -- --events <events.json> --root <rootPinId> [--now <ms>] [--guard]
```

Stdout: one canonJ line — `{ nodeStates, taskComplete, settlement }`.
Exit codes: 0 success, 2 malformed input, 3 guard violation (`--guard`).

## Vector runner contract

Executable `run-vectors.sh <vectors-dir>`: per-vector `PASS <id>` /
`FAIL <id>: <note>` lines, then `ENGINE metatask-ts-adapter
idbots-metatask-engine/1.3.0` (the vendored engine reports
`idbots-metatask-engine/1.3.0` for competitive vectors and
`idbots-metatask-engine/1.2.1` for tree vectors — report what the engine
reports) and `CANONICAL_SHA256 <hex>`; exit 0 iff all pass.

## Setup

```
pnpm install --frozen-lockfile   # or: npm ci
```
