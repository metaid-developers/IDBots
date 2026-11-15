# IDBots Performance Optimization Roadmap (P0 Completed, P1 & P2 Plan)

**Date**: 2026-11-14  
**Scope**: Main-process SQLite/IPC architecture, Renderer UI/Redux responsiveness, DSH runtime memory budget, background daemon hygiene, and backend relay coordination for heavy-data veteran installs.

---

## 1. Baseline Empirical Profile (Veteran Install Benchmark)

Measured on a real long-running production/dev `IDBots` data directory (`idbots.sqlite` = **3.71 GB**, `freelist_count = 1`):

- `cowork_messages`: **807,048 rows** (**2,488.4 MB**); largest single session = **11,728 messages** (**18.19 MB**).
- `cowork_sessions`: **6,572 rows** (1,415 visible, 5,157 archived/hidden), **124.7 MB** total because `system_prompt` occupies **109.99 MB** inline at column index 6, pushing trailing `ALTER TABLE` columns onto SQLite overflow page chains, plus `usage_stats` (**5.06 MB**) and `peer_avatar` (**1.82 MB**).
- `metabot_prompt_layer_snapshots`: **670 rows** (**144.3 MB**).
- `private_chat_messages`: **213,748 rows** (**120.5 MB**).
- `metabot_chain_reads`: **25,129 rows** (**90.0 MB**); `group_chat_messages`: **10,736 rows** (**86.0 MB**).
- `metaweb_surf_seen_pins`: **105,120 rows**; `metaid_experience_evidence`: **67,127 rows**.
- Disk sidecars: `dsh-skill-env/` held **4,802 `.env` files**; `metaid-rpc.log` grew unbounded to **49 MB**.
- Observed symptom in `cowork.log` / `main.log`: 588+ `eventloop:lag` stalls of **19.7s – 23.7s** (`heapUsedMB` spiking to **377–436 MB**), triggering macOS WindowServer spinning wait cursors, plus `68ms+` dev-mode Redux `SerializableStateInvariantMiddleware` stalls per action.

---

## 2. P0 Fixes (Completed & Merged into `main` at `14a35b01`)

1. **P0-1 (`7a050f7f5`)**: Eliminated the `O(N)` full-transcript `getSession()` storm inside `cowork:session:list` (`enrichCoworkSessionsWithServiceOrderSummaries`), which previously read and parsed ~540k message rows (~1.24 GB) synchronously on every session-list refresh (~21s stall -> `< 1ms` steady state).
2. **P0-2 (`95c128e61`)**: Added partial visible-session indexes on `cowork_sessions`, rewrote `listSessions()`'s double correlated `cowork_conversation_mappings` subqueries into a single indexed `im_ranked` CTE (**2,844 ms -> 26.5 ms**, 107x speedup), added `created_at` indexes on `private_chat_messages` / `group_chat_messages`, and added bounded LRU prepared-statement caching + WAL PRAGMA tuning (`synchronous = NORMAL`, `temp_store = MEMORY`, 32 MiB `cache_size`) in `NativeSqliteDatabase`.
3. **P0-3 (`59e46ad11`)**: Replaced full-transcript `getSession()` calls on metadata-only hot paths (`mcpServerProvider`, `browserAutomationProvider`, `computerUseProvider`, `StudioLiveStage`, `studioDelegationLookupDeps`, `groupTaskDaemon`), added `(mtimeMs, ctimeMs, size)` caching to `SkillManager.parseSkillDir`, and added 5 MiB rotation to `metaid-rpc.log`.
4. **P0-4 (`53b1268aa`)**: Enabled `acceptFirstMouse: true` on macOS `BrowserWindow`, preloaded `Settings` on idle, replaced `<Suspense fallback={null}>` with an immediate `SettingsLoadingShell`, marked the Settings backdrop `non-draggable`, lazy-split 7 heavy secondary Settings tabs, and disabled dev-only recursive `serializableCheck` / `immutableCheck` Redux middleware.

---

## 3. P1 Architecture & UI Optimizations (Completed & Merged into `main` at `22a5019db`)

### P1-1: Dedicated Off-Main-Thread SQLite Read Worker (`node:worker_threads` + WAL)
- **Problem**: Even with indexes, running multi-table analytical queries (`collectDailyReportFacts`, archived-chat content search, cross-session conversation search) synchronously via `DatabaseSync` on Electron's main thread blocks IPC and window events whenever cold pages or large windows are scanned.
- **Design**:
  - Introduce a reusable `SqliteReadWorker` pool/service backed by `node:worker_threads` opening `idbots.sqlite` in `{ readOnly: true }` WAL mode (`busy_timeout = 5000`, `query_only = ON`, `temp_store = MEMORY`).
  - Offload heavy read-only IPC and background queries (`dailyReportCollector` fact collection, archived session content search `cowork:session:listArchived`, and `cowork:session:search` / `conversationSearch` async paths) to the worker thread with graceful fallback to the in-process DB when running on `:memory:` or `sql.js` fallback backends.
  - Guarantee clean worker shutdown before `SqliteStore.close()` so Windows CI file-handle teardown (`EPERM` prevention) remains 100% deterministic.

### P1-2: `cowork_sessions` Cold/Hot Column Split (`system_prompt` Out-of-Line Table) & `peerAvatar` Deduplicated Channel
- **Problem**:
  - `cowork_sessions.system_prompt` stores **110 MB** inline across 6,572 rows (~17 KB/row), bloating `cowork_sessions` to 31,913 pages and forcing overflow-chain reads whenever non-covered columns are accessed.
  - `listSessions()` still inlines `peer_avatar` (up to cientos of KB of `data:image/...` per A2A session), inflating every `cowork:session:list` IPC payload to **1.19 MB**.
- **Design**:
  - Create `cowork_session_prompts (session_id TEXT PRIMARY KEY, system_prompt TEXT NOT NULL, updated_at INTEGER NOT NULL)` with an idempotent migration that copies non-empty `cowork_sessions.system_prompt` into `cowork_session_prompts` and clears the inline `cowork_sessions.system_prompt` to `''` so future updates and newly created sessions stay compact without breaking old schema columns or downgrade compatibility (dual-read `COALESCE(NULLIF(p.system_prompt, ''), s.system_prompt, '')`!).
  - Deduplicate `peerAvatar` over IPC via a dedicated `cowork:session:listPeerAvatars` batch channel + renderer `peerAvatarCache` (matching `metabotAvatarCache`), keeping `peerAvatarVersion` (`updatedAt` / hash) on summary rows while omitting inline multi-hundred-KB `data:image/` strings from `cowork:session:list` (HTTPS URLs can pass through directly since they are tiny).

### P1-3: Paginated Message Window for Studio (`sessionType === 'browser'`) Sessions
- **Problem**: `CoworkStore.getSessionView()` pages `standard` and `a2a` sessions (100 newest messages + `beforeTranscriptCursor`), but explicitly exempts `sessionType === 'browser'` and calls `this.getSessionMessages(id)` (full unpaged history). Long-lived Studio sessions grow to thousands of messages and stall IPC/rendering on every open and post-turn refresh.
- **Design**:
  - Switch `sessionType === 'browser'` in `CoworkStore.getSessionView()` to the same bounded `getSessionMessagesPage(id, { limit: messageLimit })` window + `messageHistory` cursor used by `standard` sessions.
  - Update `browserCoworkSlice` (`setBrowserSession` / `prependBrowserMessages`) and `BotBrowserCoworkPanel` to preserve loaded pages across mid-turn refreshes and offer a "Load earlier messages" affordance at the top of the Studio transcript when `messageHistory.hasMoreBefore` is true.

### P1-4: SQLite `FTS5` Full-Text Index for `cowork_messages` Search
- **Problem**: `CoworkStore.conversationSearch()` and `buildArchivedSessionFilter(..., { searchContent: true })` run `LOWER(m.content) LIKE '%term%'` across 807,048 rows (**2.49 GB** sequential scan).
- **Design**:
  - Create an external-content `FTS5` virtual table `cowork_messages_fts` (`content='cowork_messages'`, `tokenize='trigram'` so CJK substrings AND English words both match `LIKE '%term%'` semantics!) maintained by lightweight `INSERT`/`UPDATE`/`DELETE` triggers on `cowork_messages`.
  - Backfill existing rows incrementally in small non-blocking chunks during idle maintenance (`cowork.messagesFtsBackfillCursor`), and automatically route `conversationSearch`, `searchSessionMessages`, and archived content search through `cowork_messages_fts` once ready (falling back to `LIKE` for <3-char queries or while backfill is still in progress).

### P1-5: Incremental Session Summary Delta Broadcast (`cowork:session:summaryUpdated`)
- **Problem**: `CoworkService` in the renderer calls full `loadSessions()` (`cowork:session:list`, 1,415+ rows) whenever a background session emits its first message, `refreshSessionSummary` is set, or an A2A peer profile refreshes.
- **Design**:
  - Add `CoworkStore.getSessionSummary(sessionId)` returning a single enriched `CoworkSessionSummary` in `< 0.5ms`.
  - Add `cowork:session:getSummary` IPC + `cowork:stream:sessionSummary` broadcast so single-session mutations (new background session, `refreshSessionSummary`, peer profile refresh, unarchive) patch Redux `state.sessions` in `O(1)` via `upsertSessionSummary` instead of reloading all 1,415 sessions.

### P1-6: Long-Transcript Offscreen Rendering (`content-visibility: auto`) & Event-Driven Git Branch Probe
- **Problem**:
  - Long open transcripts keep hundreds of complex Markdown/code/tool DOM subtrees in layout flow simultaneously.
  - `CoworkSessionDetail` spawns `git` every **3 seconds** via `setInterval(poll, 3000)` even when idle.
- **Design**:
  - Apply `content-visibility: auto` + `contain-intrinsic-size` to offscreen historical turn blocks in `CoworkSessionDetail` (excluding the active streaming tail / jump-highlighted target so scroll-to-bottom and anchor jumps remain pixel-accurate).
  - Replace the unconditional 3-second `getGitBranch` interval while idle with event-driven refreshes (session/cwd change, streaming state transitions / tool completions, window focus/visibility) plus a much gentler 30s background poll only while `isStreaming` is active.

### P1-7: Memory-Aware Adaptive DSH Runtime Warmup & Idle Reaping
- **Problem**: On memory-constrained machines (`sysFreeMB` observed at `61–95 MB`, heavy macOS swap pressure), `runDshRuntimeWarmup()` boots up to `COWORK_WARMUP_COMBO_LIMIT` parallel DSH runtime child processes at startup and keeps idle runtimes alive for 120s, amplifying OS page-outs and 15–20s swap thrash stalls.
- **Design**:
  - Introduce a pure, unit-tested host memory pressure policy (`resolveDshMemoryBudget({ freeMemBytes, totalMemBytes })`):
    - Under low free memory (`< 512 MiB`) or tight RAM (`<= 16 GiB` with `< 1.5 GiB` free), cap startup warmup to **1** attended slot (skipping speculative secondary combo slots) and shorten idle runtime TTL (`120s -> 45s`) so unused DSH child processes release RAM promptly.
    - High-headroom machines retain the existing multi-slot warmup and 120s TTL.

---

## 4. P2 Optimizations (P2-1 through P2-4 Implemented; P2-5 Deferred)

### P2-1 (Implemented): Cerebellum (`/v1/systemone`) Bundle Budget, Effort Coalescing, Circuit Breaker & `assist-base-service` Relay Support
- **Empirical baseline**: `cowork.log` recorded `1,309` `/v1/systemone` calls with a **47.3% timeout rate** and **83.8% (`356/425`) turn-race budget misses** (`1,000ms` dead first-token wait) caused by ~80.8 KB / 77-question merged bundles plus a second concurrent `effortSelector` request.
- **Client (`IDBots` `852f5f655`)**:
  - Unified per-turn candidate/character caps with lexical overlap pre-pruning (`<= 15` memories, `<= 12` knowledge items, `<= 18` skills, `<= 16` remote services; `remoteServiceShortlist` total cap `12,000` chars).
  - Coalesced `effort_level` auto-effort classification into `turnDecisionBundle` so DSH turns issue a single `/v1/systemone` request.
  - Added `X-Deadline-Ms` propagation, auto-negotiated `question_templates` (`templates-v1`) via `X-Jev-Capabilities`, and a 90s consecutive-timeout circuit breaker (`3` consecutive timeouts -> `0ms` fast local fallback).
- **Backend (`assist-base-service` `b5ccc9b` on `feat/perf-jev-relay`)**:
  - `ParseLlmJevSystemoneRequest` expands optional `question_templates` (`$tpl` + `{{INDEX}}`) in-memory before forwarding to TypeSafe JEV while keeping legacy requests verbatim.
  - `LlmJevSystemone` enforces `X-Deadline-Ms` and client context cancellation before ME wallet freezes and between failover attempts, skipping false upstream key health penalties on client-side aborts.

### P2-2 (Implemented): Async Batched `coworkLogger`, Log Deduplication & Dropping Redundant `cowork_messages` Prefix Indexes (`f92b5e111`)
- Buffered `coworkLogger` writes asynchronously in Electron (`200ms` / `64 KB` batches + in-memory size rotation tracking + `process.once('exit')` synchronous flush), deduplicated `resolveNodeShim` PATH logs (previously `2,120` entries), and gated per-message `StudioLiveStage` dev `console.warn` spam (`10,514` lines) behind `IDBOTS_DEBUG_LIVE_STAGE=1`.
- Dropped redundant left-prefix indexes `idx_cowork_messages_session_id` (**40.2 MB**) and `idx_cowork_messages_session_created_at` (**60.8 MB**) once composite window indexes exist, saving **~101 MB** and reducing per-message index write amplification, plus eliminating warm-boot no-op `saveDb()` calls.

### P2-3 (Implemented): Streaming Markdown Frozen-Prefix + Active-Tail Incremental Rendering (`7d8bd0140`)
- Added `splitStreamingMarkdownBlocks` and `MemoizedMarkdownBlock` in `MarkdownContent.tsx` so live streaming replies freeze settled top-level paragraphs and closed code fences in `React.memo` and only re-parse the active trailing block on each frame (`O(L^2)` -> `O(1)` per frame), reverting seamlessly to a single tree once finalized.

### P2-4 (Implemented): Snapshot Compression, Ledger Retention Hygiene, `dsh-skill-env` GC & Indexed Daily Report Scans (`ec4c1590f`)
- Gzip-compressed `metabot_prompt_layer_snapshots.payload_json` (`gz:` prefix with transparent gunzip and `compactPromptLayerSnapshots()` background compaction, shrinking **144.3 MB -> ~10 MB** without losing rollback history).
- Wired `MetawebSurfStore.pruneSeenPins` and `ChainContentHistoryStore.pruneOldChainReads` (90-day non-KB read retention) into `MemoryHygieneService`.
- Added 7-day `pruneStaleDshSkillEnvFiles` cleanup during deferred startup maintenance (reclaiming 4,800+ orphaned `.env` sidecars while keeping `loader.sh` and active sessions).
- Added B-tree range prefilters (`m.created_at >= ? AND m.created_at < ?`) ahead of `datetime(m.created_at)` predicates in `dailyReportCollector.ts` so `private_chat_messages` and `group_chat_messages` use `created_at` indexes.

---

## 5. Deferred Future Item (P2-5 — Not Scheduled Yet)

### P2-5: `ProviderDiscovery` (`idchat online-status`) Conditional Sync (`ETag` / Snapshot Hash Diff) & Idle Window Backoff
- **Backend (`idchat` `/group-chat/socket/online-status`)**: Investigate timeout slow queries, support `ETag` / `304 Not Modified`, and compress directory responses.
- **Client**: Skip `ProviderDiscoveryService` listener/IPC broadcasts when the online-status snapshot fingerprint has not changed, and lengthen polling intervals while minimized with no active seller/delegation sessions.
