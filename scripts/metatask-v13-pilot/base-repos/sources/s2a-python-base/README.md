# metatask-replay (Python) — S2a base skeleton

This repository is the **pinned base** for MetaTask pilot node **S2a** (Python
replay engine). Clone it, implement the CLI contract below, and submit your
work as a git bundle (`git bundle create <file> --all`) whose tip commit
descends from this base's tip.

## CLI contract (frozen by the task spec)

```
python3 metatask_replay.py --events <events.json> --root <rootPinId> [--now <ms>] [--guard]
```

- `--events`: a JSON file holding the task's event list — either a bare array
  of chain events or a vector object `{ "events": [...], "options": {...} }`.
- `--root`: the task root pinId to project.
- `--now`: fixed clock (ms epoch) for TTL/expiry derivation; omit = no expiry.
- `--guard`: validate the event set strictly (unknown paths, malformed bodies)
  and exit 3 on the first guard violation instead of skipping it.

Stdout: the canonical replay projection as **one JSON object** with sorted
keys and no whitespace (canonJ: `json.dumps(o, ensure_ascii=False,
sort_keys=True, separators=(',', ':'))`), containing at least:

```
{
  "nodeStates": { "<nodeId>": { "status": "open|claimed|submitted|verified|..." } },
  "taskComplete": false,
  "settlement": null | { "engineAlgoVersion": "...", "winningChain": [...], "shares": [...] }
}
```

Exit codes: `0` success, `2` malformed input (null/missing events), `3` guard
violation (only with `--guard`).

## Hard requirements (rubric-enforced)

1. **Stdlib only.** No third-party packages; no `requirements.txt`,
   `pyproject.toml` or `setup.py` with dependencies. The verifier scans every
   `import`.
2. **Deterministic.** Two runs over the same inputs must produce byte-
   identical stdout (the verifier runs the vector set twice and compares the
   canonical digest).
3. **No crashes on malformed events.** Bad rows are skipped with a note, never
   an exception.

## Vector runner contract

Provide an executable `run-vectors.sh <vectors-dir>` that runs your engine
over every `*.json` set file in the given directory (manifest order), prints
one `PASS <vector-id>` / `FAIL <vector-id>: <note>` line per vector, then:

```
ENGINE metatask-replay-python <engineAlgoVersion your engine reports>
CANONICAL_SHA256 <sha256 over the canonJ of the per-vector canonical outputs, in run order>
```

and exits 0 iff every vector passed. The canonical output of a replay vector
is `{ "nodes": {id: status}, "taskComplete": bool, "settlement": ... }`; of a
hash vector `{ "inner": ..., "outer": ... }`.

See the task's acceptance sheet for the full artifact format definitions.
