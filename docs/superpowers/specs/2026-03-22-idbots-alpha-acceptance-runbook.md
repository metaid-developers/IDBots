# IDBots Alpha Acceptance Runbook

**Date:** 2026-03-22  
**Project:** IDBots + man-p2p  
**Status:** Active Alpha closure runbook

---

## 1. Purpose

This runbook defines how to decide whether the current packaged `IDBots.app` is ready for Alpha testing.

It combines:

- the scripted dual-machine gate that proves the core contract
- a short human smoke checklist that exercises the packaged desktop app as a user-facing product

This document is intentionally narrow. It is only about the current Alpha contract:

- local-first reads through bundled `man-p2p`
- centralized fallback on local miss
- realtime P2P PIN propagation between desktop nodes

It is not a full release checklist.

---

## 2. Current Accepted Baseline

As of 2026-03-22, the current packaged Alpha candidate is:

- app: `release/mac-arm64/IDBots.app`
- bundled binary manifest: `resources/man-p2p/bundle-manifest.json`
- bundled `man-p2p` source commit in the manifest: `f268938`

The dual-machine scripted gate was successfully run between:

- local host: `192.168.3.30`
- remote host: `192.168.3.53`

Validated outcomes:

- packaged nodes discovered each other over P2P
- local miss fallback succeeded for `d7947500f7668e361bd84d20a45f49bb8e692d3c5ec1dc57310a8d8171f258f8i0`
- a synthetic live PIN propagated across the mesh in realtime

---

## 3. Alpha Exit Criteria

The current build is acceptable for Alpha only if all of the following remain true:

- the packaged app can start its bundled `man-p2p` successfully
- `GET /api/p2p/status` reports a truthful runtime state
- a local miss still falls back to the centralized path instead of surfacing a false success or hard failure
- two packaged desktop nodes can discover each other and propagate a new PIN in realtime
- restarting the app does not leave broken local runtime state

---

## 4. Scripted Gate

### 4.1 Preconditions

- local packaged app exists at `release/mac-arm64/IDBots.app`
- remote machine is reachable over SSH
- remote machine has a usable packaged `IDBots.app` at `~/tmp/idbots-alpha/IDBots.app`
- `IDBOTS_REMOTE_PASSWORD` is exported if password auth is required

### 4.2 Command

Run from the `man-p2p` worktree:

```bash
cd /Users/tusm/.config/superpowers/worktrees/man-p2p/codex/bootstrap-reload-reconnect

export IDBOTS_REMOTE_PASSWORD=123456

CGO_ENABLED=0 go run ./tools/alpha_acceptance \
  --local-app /Users/tusm/Documents/MetaID_Projects/IDBots/IDBots-indev/release/mac-arm64/IDBots.app \
  --remote-user showpay \
  --remote-host 192.168.3.53 \
  --remote-app '~/tmp/idbots-alpha/IDBots.app' \
  --preferred-local-ip 192.168.3.30
```

Use `--remote-copy` only when the remote packaged app must be refreshed from the local candidate build.

### 4.3 Pass Conditions

The run passes only when:

- the command exits with code `0`
- output includes both local and remote bootstrap multiaddrs
- output includes `fallbackPinId`
- output includes `syntheticPinId`
- a final JSON summary is printed

Example summary shape:

```json
{
  "localBootstrap": "/ip4/192.168.3.30/tcp/55189/p2p/...",
  "localPeerId": "12D3KooW...",
  "remoteBootstrap": "/ip4/192.168.3.53/tcp/65077/p2p/...",
  "remotePeerId": "12D3KooW...",
  "fallbackPinId": "d7947500f7668e361bd84d20a45f49bb8e692d3c5ec1dc57310a8d8171f258f8i0",
  "syntheticPinId": "alpha-live-pin-..."
}
```

### 4.4 Failure Means

Treat any of the following as an Alpha-blocking failure:

- remote packaged app cannot connect back to the local bootstrap address
- fallback check does not pass
- synthetic PIN is published locally but not visible remotely within the command timeout
- the tool exits non-zero

---

## 5. Human Smoke Checklist

Run these checks after the scripted gate passes.

### 5.1 Packaged App Startup

- Launch `release/mac-arm64/IDBots.app`
- Confirm the app reaches an interactive state
- Confirm no obvious startup error dialog appears
- Confirm the local `man-p2p` child is reachable through `http://127.0.0.1:7281/health`

Pass:

- app opens normally
- health endpoint responds successfully

### 5.2 Local P2P Status Truth

- Call `http://127.0.0.1:7281/api/p2p/status`
- Confirm the response envelope has `code: 1`
- Confirm `data.runtimeMode` and `data.syncMode` match the expected local configuration

Pass:

- status is reachable
- returned fields are coherent with the current node mode

### 5.3 Local-First Miss Fallback

- In IDBots, open or resolve a known PIN that is not currently stored in the local node
- Use the Alpha fallback PIN if needed: `d7947500f7668e361bd84d20a45f49bb8e692d3c5ec1dc57310a8d8171f258f8i0`
- Confirm the user-facing flow still returns content or metadata instead of failing because the local node missed

Pass:

- the app continues to function on miss
- the miss is handled through fallback rather than a broken local success path

### 5.4 Dual-Node Connectivity

- Start the packaged app on both machines
- Call `GET /api/p2p/peers` on each node
- Confirm each side reports at least one peer after the connection settles

Pass:

- peer lists are non-empty on both machines

### 5.5 Restart Resilience

- Quit the local packaged app cleanly
- Launch it again
- Re-check `GET /health` and `GET /api/p2p/status`
- Re-check that the app can still resolve a fallback-backed PIN

Pass:

- the second startup is healthy
- fallback behavior still works

### 5.6 Config Reload Smoke

- Update P2P config through the normal app flow so the setting is persisted in the app store
- Treat `man-p2p-config.json` as a generated runtime file, not the source of truth across app restarts
- Trigger `POST /api/config/reload`
- Confirm `GET /api/p2p/status` reflects the updated filter-related fields honestly

Pass:

- reload succeeds
- status reflects the new runtime truth

---

## 6. Evidence To Record

For each Alpha test run, record:

- date and tester
- app commit
- bundled manifest commit and digest
- machines used
- scripted gate result
- human smoke result
- blocking issues, if any

Minimum evidence set:

- terminal output of the scripted gate
- one saved `GET /api/p2p/status` response from each machine
- note whether fallback PIN lookup succeeded inside the app

---

## 7. Current Non-Blocking Limits

The following are acceptable in the current Alpha:

- remote packaged app may continue using its default macOS user data directory
- local storage is partial rather than historically complete
- the scripted gate proves realtime propagation, while most human smoke steps focus on packaged-app behavior instead of raw protocol internals
- direct edits to `man-p2p-config.json` may be overwritten on app startup because startup regenerates runtime config from the app store
- multi-node restart smoke is most reliable when at least one bootstrap peer keeps a stable address for the duration of the test window

These are not acceptable:

- false local hits on missing PIN data
- broken fallback on local miss
- inability for two packaged nodes to exchange live PIN data

---

## 8. Immediate Next Step After This Runbook

Use this order:

1. Re-run the scripted gate whenever the packaged app bundle changes.
2. Run the human smoke checklist on the current candidate app.
3. Fix any Alpha-blocking issue before widening the tester pool.
