# ABS LLM Relay Performance Ticket — First-Token Latency & SSE Streaming

| | |
|---|---|
| **Ticket** | ABS-PERF-2026-1112-01 |
| **Date** | 2026-11-12 |
| **Reporter** | IDBots client team |
| **Component** | ABS llm relay (`www.metaso.network/assist-open-api/v2/assist/llm/*`, chat-completions path) |
| **Severity** | P1 — user-perceived latency on the default in-app provider (ID.Bots) |
| **Status** | Open, evidence attached, fixes proposed below |
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
