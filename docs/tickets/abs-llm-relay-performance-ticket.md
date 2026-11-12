# ABS LLM Relay Performance Ticket — First-Token Latency & SSE Streaming

| | |
|---|---|
| **Ticket** | ABS-PERF-2026-1112-01 |
| **Date** | 2026-11-12 |
| **Reporter** | IDBots client team |
| **Component** | ABS llm relay (`www.metaso.network/assist-open-api/v2/assist/llm/*`, chat-completions path) |
| **Severity** | P1 — user-perceived latency on the default in-app provider (ID.Bots) |
| **Status** | Partially verified (see §8): R1 PASS, R2 PARTIAL — one residual open |
| **Related client doc** | `docs/me-llm-relay-plan-quota-backend-requirements.md` |

## 1. Summary

Users report that models served through the ID.Bots provider (the ABS relay)
respond noticeably slower than the same model families through official
gateways. Black-box measurement from a client machine (2026-11-12, same
network for all gateways, identical request bodies, streaming, interleaved
rounds) confirms the relay adds:

- **F1 — a fixed ~0.7–1.0 s first-token floor** that does not scale with
  request size (tiny 118 B → 30 KB bodies all land at 1.0–1.5 s TTFB, while
  official DeepSeek lands at 0.29–0.61 s across the same sizes).
- **F2 — SSE stream batching**: the relay delivers a whole 130-token answer in
  4–5 network chunks with ~250 ms inter-chunk gaps, while official DeepSeek
  delivers the same answer in 46–75 chunks with ~15 ms gaps. Users see text
  arrive in bursts instead of a smooth token stream.

The client side is ruled out: the app proxies upstream SSE chunk-by-chunk with
no aggregation buffering, and the request path is identical for all providers.

## 2. Measurement setup

- One client machine in mainland China, all four gateways tested under the
  same network conditions, interleaved rounds to cancel time-of-day drift.
- Wire shape identical for both sides of each pair: OpenAI
  `POST {base}/chat/completions`, `stream: true`, same messages, same
  `max_tokens`, same `thinking` controls.
- Metrics: TTFB (response headers), first SSE event, first reasoning delta,
  first content delta, per-chunk arrival gaps, full-stream totals.
- Credentials: the reporter's own relay key / official API keys. Keys are not
  reproduced in this ticket.

## 3. Evidence

### 3.1 TTFT vs official gateways (median, ms)

| Pair | Prompt | ID.Bots (ABS) | Official | Δ |
|---|---|---|---|---|
| deepseek (`deepseek-4.1-flash` vs official `deepseek-flash`, thinking off) | tiny (118 B) | 1190 | 289 | **+0.9 s** |
| deepseek, thinking off | ~4 K tokens (6 KB body) | 1337 | 303 | **+1.0 s** |
| deepseek, thinking off | ~15 K tokens (30 KB body) | 1137 | 403 | **+0.7 s** |
| glm-5.3-flash (thinking enabled, server default both sides) | tiny | 2000 (first content 4469) | 2096 (first content 6684) | ≈ parity (ABS first content faster) |
| glm-5.3-flash (thinking enabled) | ~4 K tokens | 3427 (first content 3993) | 1622 (first content 2716) | **+1.8 s** |

Key property: the ABS delta is a **flat floor** — it does not grow with
request size. A 30 KB body costs the relay the same ~1 s as a 118 B body.

### 3.2 Where the floor sits (probe decomposition)

| Probe | Result | Meaning |
|---|---|---|
| `GET /models` | 64–142 ms | front door + routing fast |
| 401 (bad relay key) | 124 ms | auth path fast — the billing/quota gate is NOT on the critical path |
| 404 (unknown model) | 66 ms | model routing fast |
| 400 relayed from upstream (invalid `reasoning_effort`) | 337 ms | relay→upstream dial ≤ ~300 ms |
| 200 streaming "Hi", `max_tokens=8` | 834–1116 ms (median 935, n=5) | **residual ~0.5–0.8 s between upstream dial and first byte on the success path** |
| 4 parallel "Hi" requests | all four ≈ 1.12 s | no per-key serialization/queueing at 4× concurrency |
| client→relay TLS handshake | dns 3–7 ms / tcp 17–21 ms / tls 48–57 ms | network to the relay is not the problem (direct origin, nginx/1.23.3, no CDN) |

### 3.3 SSE batching (whole 130-token answer, thinking off, `deepseek` pair)

| | Network chunks | Gap P50 | Gap P95 |
|---|---|---|---|
| ID.Bots (ABS) | **4–5** | **160–275 ms** | 281 ms |
| Official DeepSeek | 46–75 | **15 ms** | 91 ms |

The 200 SSE response carries `content-type: text/event-stream`,
`cache-control: no-cache`, `server: nginx/1.23.3`, and **no
`X-Accel-Buffering: no`** — consistent with a buffering proxy tier (nginx
`proxy_buffering`, a gzip tier, or an internal aggregation hop) holding
~250 ms of upstream tokens per flush.

### 3.4 Upstream identity observations (informational)

- The relay's DeepSeek upstream is **not `api.deepseek.com`**: a relayed
  upstream 400 exposes the vocabulary `'reasoning_effort' must be one of:
  'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'`
  (OpenAI-style, not DeepSeek's own error shape), and served chunks report the
  snapshot id `deepseek-v4.1-flash-1017`.
- The relay's GLM upstream IS Zhipu (chunk id format `hex-timestamp` matches
  bigmodel), reporting `GLM-5.3-Flash`.
- GLM-5.3-flash ignores `thinking:{type:'disabled'}` on BOTH paths (official
  Zhipu direct also keeps streaming `reasoning_content`) — no parameter
  fidelity bug on the relay side; the model cannot disable thinking anywhere.

## 4. Root-cause hypotheses (ordered)

1. **H1 (stream batching)**: a buffering layer between relay and client —
   nginx `proxy_buffering` left on for the SSE location, gzip on
   `text/event-stream`, or an internal hop that aggregates chunks. Explains
   F2 entirely and part of F1 (the first flush waits for a full buffer).
2. **H2 (per-request upstream dial)**: no upstream connection reuse — each
   relay request re-establishes TLS to the upstream (~300 ms observed for the
   relayed-400 round trip).
3. **H3 (residual ~0.5–0.8 s on success path)**: either an extra internal hop
   (edge → worker → upstream) or the upstream snapshot deployment itself
   having slower first-token than the official edge. The relayed-400 probe
   proves dial+error is fast, so the residual accrues after the upstream
   accepts the request and before its first 200 byte — i.e. inside the
   upstream generation path or a hidden second hop.
4. **H4 (ruled out)**: billing/quota gating (error paths answer in 66–124 ms),
   concurrency queueing (4× parallel unaffected), client-side buffering
   (chunk-by-chunk proxy verified), GLM parameter fidelity (verified
   faithful).

## 5. Requested fixes (priority order)

### R1 — SSE passthrough (expected: kills the bursty feel, trims part of the floor)

For the chat-completions streaming route:

- `proxy_buffering off;` for the SSE location (or honor upstream
  `X-Accel-Buffering: no` and have the app server emit it);
- no gzip on `text/event-stream` (`gzip off` for that location);
- `tcp_nodelay on` on the client-facing leg;
- verify no internal hop aggregates chunks (stream one upstream SSE event per
  client write).

**Acceptance**: a 130-token answer arrives in >40 network chunks with gap P50
≤ ~50 ms, matching official-gateway cadence.

### R2 — upstream connection pooling / keep-alive (expected: −~300 ms/request)

Reuse warm connections to each upstream (agent with keep-alive, connection
pool per upstream origin, HTTP/2 multiplexing where available).

**Acceptance**: relayed upstream error round trips drop well below the
current ~337 ms; success-path TTFB drops by the dial cost.

### R3 — account for the residual ~0.5–0.8 s on the success path

Instrument per-request phases (auth → dial → upstream headers → first
upstream byte → first client byte) and identify where the residual sits. If it
is the upstream snapshot deployment, evaluate pointing the DeepSeek route at
the official API (or a faster endpoint) — official first-token was 0.29–0.61 s
for the same bodies, i.e. the relay's floor should be able to approach
official + dial (~0.4–0.7 s total).

**Acceptance**: published per-phase timings; success-path TTFB ≤ official
TTFB + 300 ms for the same body.

### R4 — (optional) first-byte flush

If the first upstream byte sits in any buffer (proxy or worker), flush
headers + first event immediately. Today TTFB and first event arrive together,
which means headers are held until data exists — pass headers through as soon
as the upstream sends them.

## 6. Client-side commitments (IDBots team)

- Nothing required for this ticket: client path is verified clean.
- The client will re-run the same benchmark suite after each ABS deployment to
  verify acceptance (same script, `/tmp` scratch copies exist; a hardened
  copy can be shared on request).

## 7. Notes

- GLM first *visible content* (2.7–6.7 s) is dominated by GLM-5.3-flash's
  mandatory thinking and is identical on official Zhipu — not an ABS defect.
  The ABS-side improvements above still shave the transport share (~1–2 s on
  large prompts) off of it.
- Tiny-prompt GLM through ABS already beats Zhipu direct on first content
  (4.5 s vs 6.7 s medians) — evidence the upstream itself is competitive; the
  fixed floor and batching are what drag it down.

## 8. Verification log — 2026-11-12 (ABS fix deployed)

Client-side re-run of the same benchmark suite against production
(2026-11-12 ~10:12 +08:00, same machine/network, interleaved with official
baselines). The reporter's primary identity free pool was exhausted
(quota reset 2026-11-15 12:43 +08:00), so the run used a separate fresh
e2e identity relay key (5 M chat quota) — same relay, same wire.

### 8.1 Acceptance ① — SSE passthrough (R1): **PASS**

~130-token answer (thinking off, `deepseek` pair), per network-chunk cadence:

| | chunks | gap P50 | gap P95 |
|---|---|---|---|
| ABS before fix | 4–5 | 160–275 ms | 281 ms |
| **ABS after fix (3 rounds)** | **83 / 94 / 87** | **0 ms** | 88–179 ms |
| official baseline (same run) | 60–69 | 10–14 ms | 91–103 ms |

Acceptance line: >40 chunks with gap P50 ≤ 50 ms — met with margin; ABS now
streams finer-grained than the official gateway. The bursty "text arrives in
chunks" feel is gone. (Response headers still show plain
`server: nginx/1.23.3` with no `X-Accel-Buffering` header — the buffering
appears disabled at the config level; behavior is what counts.)

### 8.2 Acceptance ② — first-token floor (R2): **PARTIAL**

Tiny request (`"Hi"`, `max_tokens=8`), TTFB medians:

| | before fix | after fix | official (same run) | acceptance |
|---|---|---|---|---|
| streaming gen (`bench_thru`) | 1200 ms | **685 ms** | 232 ms | ≤ official+300 = 532 ms → **~+453 ms, still above line** |
| sequential probes (n=5) | 935 ms | 841 ms | — | improved ~100 ms |
| 4× parallel | ~1120 ms | 558–845 ms | — | improved ~300–450 ms |

~4 K-token prompt (~6 KB body), TTFB medians:

| | before fix | after fix | official (same run) | acceptance |
|---|---|---|---|---|
| deepseek pair | 1252 ms | **1280 ms (916–1525)** | 270 ms | ≤ official+300 = 570 ms → **+1010 ms, FAIL / unchanged** |
| glm-5.3-flash pair (first event) | +1805 ms vs Zhipu | **+595 ms vs Zhipu** (3126 vs 2531; small-n noisy) | — | improved |

Error paths unchanged and fast (401 242 ms / 404 20 ms / upstream-relayed 400
630 ms, single noisy sample). Upstream identity unchanged
(`deepseek-v4.1-flash-1017` snapshot; GLM → Zhipu).

**Reading**: the fix removed the buffering/first-byte floor (~400–500 ms off
small requests, streaming cadence restored) — but the **size-growing
component is still there**: a ~4 K-token body costs ABS ~+1.0 s over official,
essentially unchanged from before the fix. That residual sits between request
accept and upstream first byte and scales with input size, pointing at either
(a) the upstream snapshot deployment's prefill being slower than the official
edge, or (b) a per-byte relay cost (body scan/rewrite/line-buffered upload).
This is now the dominant user-visible gap on long-context turns.

### 8.3 Remaining ask (supersedes R3)

Instrument per-request phases for one ~4 K-token request (auth → upstream
headers → upstream first byte → client first byte) and either fix the
size-proportional component or re-point the DeepSeek route at the official
API. Acceptance stays as §5 R3: success-path TTFB ≤ official + 300 ms for the
same body, tiny and ~4 K-token alike.

## 9. Verification log — round 3 (2026-11-12 ~11:06–11:30 +08:00, after the second ABS fix)

Same suite, same machine/network, e2e identity key again. Official baselines
stable across all rounds (tiny 174–509 ms, big-prompt 239–400 ms medians).

### 9.1 Acceptance ① — SSE passthrough: still PASS

`deepseek` pair ~130-token answers: 73–104 network chunks, gap P50 = 0 ms,
gap P95 104–115 ms. No regression vs round 2.

### 9.2 Acceptance ② — first-token floor: improved again, NOT yet accepted

Same-window interleaved medians (round 4 of the day, 11:25):

| body | ABS | official | delta | acceptance ≤+300 ms |
|---|---|---|---|---|
| tiny | 721 ms | 226 ms | **+495 ms** | fail (round 2: +453 ms) |
| ~4 K-token | 916 ms | 271 ms | **+645 ms** | fail (round 2: +1010 ms — halved, real progress) |

### 9.3 New finding — high backend variance during this window

Identical request bodies swing widely minute-to-minute while official
gateways hold steady, e.g. the same ~4 K-token body measured
2412 / 2289 / 2681 / 2194 ms at 11:06, then 923 / 712 / 745 / 857 ms at
~11:15, then 1912 / 1188 / 1529 / 802 ms at ~11:20. GLM probes spiked to
9.4 s in the same window. This is consistent with a rollout still in
progress or a mixed cold/warm upstream pool — it makes any single-pass
acceptance number unreliable.

### 9.4 Status

- R1 holds. R2 residual roughly halved vs round 2 but above the +300 ms line
  in both size classes, with high variance on top.
- **Cannot certify acceptance from this window.** Final re-verification will
  run once ABS confirms the rollout is complete and stable (and, for the
  reporter's primary identity, after the 2026-11-15 quota reset).
- Ask for ABS: confirm rollout completion + whether upstream nodes are pooled
  behind uneven cold/warm latencies; then hold the backend steady for a
  15-minute window while the client runs the interleaved acceptance pass.
