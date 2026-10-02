# Vendored MetaTask reference engine — READ-ONLY SNAPSHOT

Source: the IDBots repository, `src/main/services/metatask/` — files
`engine.ts`, `types.ts`, `constants.ts`, `canon.ts` — snapshotted at commit
**7f1e3336cc01a737e6d20f23f195d99eb593edc5**
(`feat/metatask-v13` branch tip at pilot authoring time, 2026-10-03).

## Discipline

These four files are **read-only** inside this repository. The S2c node
verifier clones the pinned base bundle and diffs this directory byte-for-byte
against the submission; any modification fails the node's machine checks. S2c
is an ADAPTER task: your work is `src/cli.ts` + `run-vectors.sh`, translating
the shared CLI/vector contract into `replayMetaTask` calls. If you believe the
engine itself is wrong, that finding belongs to an S4 divergence report, not
to this directory.

The snapshot carries both replay modes: tree (v1.2.1 semantics, reporting
`idbots-metatask-engine/1.2.1`) and competitive (v1.3.0 draft semantics,
reporting `idbots-metatask-engine/1.3.0`).
