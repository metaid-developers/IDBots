# DSH Kernel Migration — Phase 0 Spike Report

Branch: `feat/dsh-phase0-spike` · Date: 2026-08-15 · DSH version under test: `0.1.0-rc.6` (npm `next` tag)

Phase 0 asked one question: **can DeepSeek Harness (DSH), consumed as npm packages without forking, replace the Claude Agent SDK as IDBots' agent kernel — and which adoption route (incremental replacement vs. greenfield rebuild) does the evidence favor?**

**Answer: GO for a kernel swap on the existing IDBots codebase, with a plugin-first track running in parallel. Greenfield rebuild is not justified by current evidence.** Details below.

## 1. What was built and verified

A self-composed minimal runtime (`cordis.yml`, 10 entries, zero upstream forks) booted in-process via `@deepseek-ai/dsh-app-boot`, plus a standalone JSON-RPC runtime bin (`scripts/runtime-bin.mjs`) driven over stdio by `@deepseek-ai/dsh-sdk-client`. All checks green as of the final regression run:

| # | Verification | Result |
|---|---|---|
| 1 | In-process boot of own plugin composition | PASS |
| 2 | Plain-text turn: token-level `assistant/chunk` stream → assembled `assistant/message` | PASS |
| 3 | `request/header` event carries full request snapshot (system prompt, tools, provider route) — the `getContextUsage()` equivalent source | PASS |
| 4 | Tool registration (`defineTool`) + execution consuming a cordis service (`ctx.idbotsWallet`) | PASS |
| 5 | Tool result fed back into the next model request (derived history) | PASS |
| 6 | Permission gate: `tools/pre-execute` deny → error tool result the model sees | PASS |
| 7 | **Steer mid-turn**: `agent.steer()` consumed at the next step boundary while a tool was running | PASS |
| 8 | **Cancel mid-stream**: `agent.cancel(cause)` aborts the stream, closes the turn with `{"kind":"aborted","reason":"spike driver cancel"}` | PASS |
| 9 | Resume: same-process `ctx.agents.resume()` + followup | PASS |
| 10 | **Cross-process resume**: fresh Node process resumes from JSONL persistence, turn counter continues (seq 130) | PASS |
| 11 | Third-party OpenAI-compatible endpoint via `dsh-llm-pi-ai` hand-declared `openai-completions` route (mock gateway) | PASS |
| 12 | Third-party endpoint via `dsh-llm-deepseek` + `DEEPSEEK_BASE_URL` override | PASS |
| 13 | Subprocess wire: `initialize` → `prompt` (enqueue receipt) → `session.event`/`session.status` notifications → clean `close()` ladder | PASS |
| 14 | Wire gaps probed empirically: `session/cancel`, `session/steer`, `session/approval` all return `-32603 method not found` | CONFIRMED GAP |
| 15 | Runtime relocatability: spike directory copied to `/tmp`, runs unmodified | PASS |
| 16 | Wallet-style cordis service plugin (class extends `Service`, `inject` consumption) authored and used by a tool | PASS |

Not covered (deferred, with rationale in §4): real-model behavior comparison, subagent transcript APIs, compaction quality, Electron main-process integration, native modules (koffi/node-pty).

## 2. Key findings (the list that saves the next person time)

**Ecosystem / release hygiene**

- F1. **npm `latest` dist-tags are stale and dangerous.** `@deepseek-ai/dsh-*` publishes the rc.6 family under `next`; `latest` still points at `0.0.1-rc.1`. A bare `npm i @deepseek-ai/dsh-llm-pi-ai` installs a version whose peer deps (`dsh-attachment@^0.0.1`) conflict with the rc.6 family (`^0.1.0-rc.6`) — hard ERESOLVE failure. **Rule: always pin exact versions or the `next` tag; never `latest`.**
- F2. The runtime footprint of a maximal install (including the whole `@deepseek-ai/dsh` CLI tree) is **336 MB / 198 `@deepseek-ai` packages**. A lean composition needs a fraction of this; the spike's own composition resolved fine without koffi/node-pty ever loading (their install scripts were even blocked — the loop does not need them).
- F3. The `dsh` CLI bin is **profile-based** (`--profile <name>` under `$DSH_HOME`) and will not boot an arbitrary config path. The correct production shape is **our own runtime bin** (10 lines: `boot()` + keep-alive), which the SDK client happily spawns. This is composition, not forking.

**API / DX sharp edges**

- F4. `defineTool` **requires an explicit `output.render`**; omitting it produces `output.render failed: userRender is not a function` at call time, not at registration. (Also: output schemas must set `additionalProperties` explicitly true/false.)
- F5. `tools/pre-execute` is dispatched through an **agent-scope carrier**; a policy listener registered on an ordinary fiber context is silently filtered out. Host-wide policy must register with `{ global: true }` (works, verified) or per-agent inside `CreateAgentOptions.setup`. This is exactly where IDBots' `canUseTool` chain will land.
- F6. The pre-execute `ToolExecution` payload exposes `arguments` (not `args`), plus `name`, `callId`, `signal`, `agent`, `deferContext`, `concludeTurn`.
- F7. A composition without a logger exporter plugin **swallows internal errors silently** (they surface only as flattened tool-result text). Ship a logger plugin in every composition, dev and prod.
- F8. There is **no root-context dispose API**; the idiomatic shutdown is `sessions.flush()` + process exit (DSH's own headless runner does exactly this). In-process embeds must plan teardown at fiber level or accept process-boundary lifecycle.
- F9. Session events wrap payloads in `event.data`; `tool/call` carries `data.name`/`data.callId`/`data.arguments`; `request/header` carries the **complete assembled request** (system prompt string, tool schemas, provider config) — a much stronger observability surface than anything the Claude SDK exposes, and the natural replacement for both `getContextUsage()` and the request-fingerprint monitoring in `coworkRequestHeadWatch`.

**Control plane (the part IDBots cannot ship without)**

- F10. In-process `ctx.agents` gives full parity: `followup` / `steer` (step-boundary, non-destructive — arguably better than the current `interrupt()`-then-resubmit steer) / `cancel(cause)` / `whenIdle` / `resume`. All verified.
- F11. The **subprocess wire does not carry steer/cancel/approval** (F14 above, matches docs). Therefore: either (a) extend the protocol with our own jsonrpc-server-side methods — small cordis plugin work, both ends ours — or (b) run the agent kernel in-process. **Recommendation: start Phase 1 with our own runtime bin + a protocol-extension plugin (`session/steer`, `session/cancel`, approval notifications); keep in-process embed as a later optimization.** This preserves crash isolation (same model as today's per-query `claude` binary) and keeps the wire narrow against rc churn.

## 3. Route decision: incremental kernel swap vs. greenfield rebuild

The user posed three routes. Evidence-based assessment:

| | Route A: swap kernel inside IDBots | Route B: greenfield Electron+SQLite, all-DSH/cordis, rewrite features as plugins, migrate data | Route C (user's proposal): build DSH plugins first (wallet, metabot management), then greenfield |
|---|---|---|---|
| Agent-kernel coupling | ~4,000 lines concentrated in `coworkRunner.ts` + sandbox replica; SDK imports already funneled through one loader; `promptComposer` already mirrors `dsh-system-prompt`'s registry model | Same 4,000 lines to rewrite, **plus** everything else | Kernel untouched initially |
| Non-kernel surface (memory, Studio, group tasks, A2A, IM gateways, chain daemons, browser host, sandbox VM) | Unchanged — this is most of IDBots and none of it benefits from a rewrite | **Rewritten wholesale for no architectural gain** — these are host services, not agent-loop code | Ported as plugins — real work, real value |
| User-data continuity (AGENTS.md mandate) | Dual-kernel period: legacy `claudeSessionId` sessions stay on Claude SDK; no migration event | Requires a one-time migration tool across SQLite schemas + session logs | Same as B when the cutover happens |
| DSH rc-churn exposure | Narrow (wire protocol + a handful of services) | Maximal (every module rides pre-release internals) | Medium, front-loaded in plugins |
| Velocity signal from this spike | One day to a fully working kernel harness with tools/streaming/steer/cancel/resume — the abstraction quality is high | Same signal, but multiplied over ~quarters of rewrite | Plugin DX verified directly (wallet service + tools) |

**Recommendation: Route A for the kernel, Route C's plugin-first idea as the parallel track — and let the shell decision come later.**

1. **Phase 1 (kernel swap in IDBots).** Generalize the existing `loadClaudeSdk` test seam into a `KernelAdapter` interface; implement the DSH adapter as our own runtime bin + `sdk-client` + a protocol-extension plugin (steer/cancel/approval). Route per provider: DeepSeek/OpenAI-compatible sessions go DSH first, Anthropic-direct can stay Claude SDK during validation. Old sessions keep the Claude kernel. The OpenAICompatProxy's DeepSeek-reasoning work is natively handled by DSH's adapter; its per-session `tool_result` trimming moves to an `agent/pre-step` plugin (to be validated early in Phase 1).
2. **Phase 2 (pluginization track, starts in parallel).** Author host-agnostic cordis plugins for the modules with the least Electron/SQLite coupling (wallet primitives, metabot manage core, social search). These plugins run in both hosts — inside IDBots' DSH runtime and inside any future DSH-native host. This is Route C without betting the product on it.
3. **Greenfield shell: deferred, data-driven.** Re-evaluate when plugin coverage is high enough that the "host" is a thin shell (UI + process supervision + chain daemons). At that point "new project" collapses into "swap the shell", a bounded decision. Opening a greenfield repo today means rewriting ~90% of IDBots while carrying rc churn on every line — the worst risk/return point on the curve.

## 4. Open items for Phase 1 (spike scope cuts)

- Real-model behavior comparison (needs live keys; scripted fake cannot measure answer quality or compaction behavior).
- Subagent surface: DSH has the subsystem, but `listSubagents`/transcript-read parity needs a dedicated check.
- `agent/pre-step` message rewriting for per-session `tool_result` trimming (the `/s/<sessionId>` proxy's job today).
- Approval (`ask`) flow end-to-end with an approval channel service; the spike only exercised deterministic allow/deny.
- Electron main-process integration: spawning the runtime bin from packaged `app.asar.unpacked`, auto-update story for the pinned runtime version, Windows behavior of the dispose ladder.
- Compaction (`dsh-compaction-basic`) behavior across providers — IDBots' tiered compression is currently a safety net around SDK auto-compact.

## 5. How to run the spike

```bash
cd spikes/dsh-phase0
npm install                # pinned @deepseek-ai/*@0.1.0-rc.6 (npm 'next' line)

node scripts/run-agent.mjs                       # in-process: 9 checks, prints session id for resume
RESUME_SESSION_ID=<id> node scripts/run-agent.mjs --resume-only

node scripts/provider-test.mjs pi-ai             # custom openai-completions route → mock gateway
node scripts/provider-test.mjs deepseek          # DEEPSEEK_BASE_URL → mock gateway

node scripts/sdk-client-test.mjs                 # subprocess JSON-RPC wire incl. gap probes
```

No API keys needed: the fake adapter (`plugins/fake-llm.mjs`) drives the full loop; provider tests hit a local mock OpenAI endpoint (`scripts/mock-openai.mjs`).
