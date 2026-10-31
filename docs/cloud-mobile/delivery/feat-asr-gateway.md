# feat/asr-gateway — ASR Voice Gateway (server side)

Branch: `feat/asr-gateway` (worktree `.worktrees/asr-gateway`), based on `main` @ 956d7db5.
Delivered: 2026-10-31 by Builder阿码. Scope: the gateway slice of sub-project
#10 (mobile voice input P0). Not deployed — code + local verification only;
deployment waits for the joint debugging round with the PWA frontend.

## What landed

The control plane gains a second WebSocket endpoint — `/asr/v1/ws` — that
streams phone audio to a pluggable ASR upstream and streams recognized text
back. New capability, new independent channel doc
(`docs/cloud-mobile/voice/asr-channel.md`); **the frozen contracts 01/02 are
untouched** (diff contains zero changes under `docs/cloud-mobile/0*`).

Code map (all under `cloud/control-plane/`):

- `src/services/asr/types.ts` — the `UpstreamProvider` interface (the seam
  the frontend doc is decoupled from the provider through).
- `src/services/asr/upstream-stub.ts` — StubUpstream: fixed test transcript,
  injectable `delayMs` / `disconnectAfterMs` / `slowFinalMs` faults.
- `src/services/asr/upstream-doubao.ts` — DoubaoUpstream: Volcengine Doubao
  Streaming ASR 2.0 (`bigmodel_async`, SAUC v3 binary protocol, gzip JSON,
  forced endpointing for short utterances). Credentials env-only; protocol
  implementation is validated by framing tests against a local fake SAUC
  server (no live test possible yet — no credentials).
- `src/services/asr/upstream-funasr.ts` — reserved FunASR slot.
- `src/services/asr/usage.ts` + `src/db/migrations.ts` (migration 2) —
  `asr_usage` per-session rows; daily quota = SUM query, Asia/Shanghai day,
  crash leftovers capped at the session cap (self-healing).
- `src/services/asr/gateway.ts` — `attachAsrGateway`: cookie+origin auth
  (reuses `resolveSession`/`isOriginAllowed` like the `/ws` proxy), 41xx
  close-code block, 60 min/day quota + 600 s session cap, per-second
  enforcement ticker, upstream auto-reopen on retryable loss (client socket
  survives), hop-by-hop ping/pong keepalive, metrics (`cp_asr_*`).
- `src/routes/asr.ts` — `GET /api/v1/asr/quota` preflight endpoint.
- `src/server.ts` / `src/config.ts` / `src/cli.ts` / `src/main.ts` wiring +
  `CP_ASR_*` config validation (doubao without credentials refuses to start).
- `src/services/wsProxy.ts` — one behavioral edit: the `/ws` proxy no longer
  destroys *unknown* upgrade paths; the ASR gateway (attached after it) owns
  that 404. `/ws` itself is byte-identical in behavior (proxy tests green).
- Tests: `test/asr-quota.test.ts`, `test/asr-stub.test.ts`,
  `test/asr-doubao.test.ts`, `test/asr-gateway.test.ts` (+ `test/asr-helpers.ts`).

## Engineering decisions (why it looks like this)

1. **Location — control-plane bypass module, not a separate service.** The
   `idb_session` cookie is `Secure; SameSite=Strict`: only a same-origin WS
   handshake carries it. A separate origin would force a second credential
   mechanism (new auth surface = contract territory) and cross-process
   sqlite sharing. One process = zero new auth surface, one deploy unit (the
   task scope excludes a second server), and the UpstreamProvider seam keeps
   extraction cheap if ASR load ever justifies it. Quota is account-level,
   tenant containers are the wrong place; keys are platform assets.
2. **Auth — same session, no new token.** `resolveSession` is the exact code
   path `/ws` uses (REQ-B-13); behavior, sliding expiry, and test surface are
   shared. Close codes moved to a dedicated 41xx block so C3's
   4001/4003/4013 can never be misread by the client.
3. **Usage — row-per-session over a counter table.** Auditable (which day,
   which upstream, bytes, close reason), cheap at our scale, and crash-safe
   (open leftovers capped by the session cap, charged to their start day).
4. **Stub-first.** No credentials exist, so the stub is the default upstream
   and the joint-debugging surface; the Doubao implementation is protocol-
   complete but honestly marked not-live-tested.

## Verification

- `tsx --test test/*.test.ts` — **185/185 pass** (156 pre-existing + 29 new;
  the full control-plane suite, including the `/ws` proxy tests).
- `tsc -p tsconfig.build.json --noEmit` — clean.
- `eslint` on all new files — clean.
- Highlight: the recovery test proves a mid-stream upstream drop (stub
  `disconnectAfterMs`) produces exactly `asr.error UPSTREAM_LOST` → gateway
  auto-reopen → second `asr.open` → partial/final/done → close 1000, all on
  the same client socket.

## Live-upstream validation (2026-10-31, follow-up commit)

With the real API key in place, one probe + two full gateway e2e runs were
executed against `wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async`
(evidence: `asr-gateway/doubao-live/` outside the repo). Findings folded back
into `upstream-doubao.ts`:

- **Response layouts are mixed** — the config ack arrives with flags 0b0000
  (no sequence; size at offset 4, payload at 8), recognition results with
  0b0001/0b0011 (sequenced; size at 8, payload at 12). The parser now
  branches on the flags nibble; the previous fixed sequenced offset would
  have failed on the first real frame. Locked by `test/asr-doubao-live.test.ts`
  (new file; pre-existing tests untouched).
- **Request headers** now carry `X-Api-Request-Id` (doc-required task id)
  alongside the trace `X-Api-Connect-Id` (one UUID), plus the doc-fixed
  `X-Api-Sequence: -1`. Legacy auth headers corrected to the documented
  `X-Api-App-Key` / `X-Api-Access-Key` pair.
- **Request body** adds `enable_nonstream` (two-pass recognition — the
  definite utterance arrives as `source: "two_pass"` with punctuation, e.g.
  「今天天气怎么样？」) and `enable_ddc` (semantic smoothing), per the
  official example payload.
- **Audio packets are capped at 200 ms** (6400 B): oversized client chunks
  split, ≤200 ms chunks pass through untouched (no added latency; the
  channel doc already binds clients to 100–200 ms frames).
- **An empty-payload EOS packet is accepted** by the live service.

Live numbers (TTS sample 「今天天气怎么样？」, 1.73 s, 200 ms packets,
two runs): `asr.open` 262–568 ms after connect; first partial 808–1055 ms
after first audio; finish→final 250–369 ms; `audio_info.duration` 1726 ms
matches the sample length exactly. Wrong-key attempts are rejected at the
HTTP handshake (close 1006). Full logs: `doubao-live/probe-run2.json`,
`doubao-live/e2e-live-clean.json`.

After the fold-back: full suite **188/188 pass** (185 + 3 new live-fact
regression gates), `tsc` and `eslint` clean.

## Not done / follow-ups

- No production deployment (per slice discipline).
- FunASR implementation fills `upstream-funasr.ts` when that switch is due.
- AGENTS.md asks for an on-chain development-journal buzz per commit; this
  delegated slice posts nothing on chain — left to the orchestrating side.
