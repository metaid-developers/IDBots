# MetaTask → OAC Port — UI Fidelity & Implementation Reference

> **Status**: ready for implementation. Companion to
> `docs/design/metatask-oac-port-implementation-plan.md` (read that first;
> this document covers phases P5/P6).
>
> Audience: the development agent implementing the two MetaTask UIs in OAC:
> **(A)** the DSH plugin Tracking Tasks panel and **(B)** the OAC web UI
> `src/ui/pages/tracking`. Goal: both UIs let a human understand at a glance
> *what the task is, what each bot did, who reviewed what, and where the
> deliverables are* — functionally equivalent on both surfaces.

---

## 1. The two surfaces (verified 2026-10-04)

| | A. DSH plugin (`open-agent-connect-dsh`) | B. OAC web UI (`src/ui/pages`) |
|---|---|---|
| Stack | React 18 (externals injected by host), tsdown → CJS closure | Vanilla TS string templates + IIFE script strings (server-rendered `buildXPageDefinition`) |
| Entry | slot `oac.bots.section` child of the Bots page (`shell.overlay`) | `/ui/tracking` route + `NAV_ITEMS` |
| Styling | CSS strings in `src/client/styles.ts`, tokens `--dsw-alias-*`, dark via `body[data-ds-dark-theme]` | `src/ui/shared.css` tokens (`--bg/--surface/--border/--text/--muted/--accent`), **no dark mode** |
| i18n | `src/client/locale.ts` flat keys, en+zh pair (asserted equal) | `src/ui/i18n.ts` dotted keys, en + zh-CN (en is superset) |
| Data | `fetch('/oac/api/…')` via `src/client/api.ts`; SSE or polling | page IIFE calls daemon `/api/*` directly |
| Tests | node:test static source assertions + built-artifact tests | vm-sandbox page-script tests + i18n coverage whitelist |
| Width | default 720px cap — **must be lifted for this panel** (§6.3) | unconstrained (`.content` fluid) |

**Hard rule**: the two UIs consume the **same daemon data contract** (§2) and
present the **same information**. Visual language may follow each surface's
conventions; information architecture must not diverge.

---

## 2. Shared data contract (daemon endpoints both UIs use)

Implement these in the port (plan §5); the UIs must not re-derive replay
state — they render what the daemon replayed. Shapes mirror IDBots'
projection types (`/Users/tusm/Documents/MetaID_Projects/IDBots/IDBots/src/main/services/metatask/types.ts`).

| Endpoint | Payload (JSON) |
|---|---|
| `GET /api/metatask/board` | `{ tasks: BoardTask[], alerts: Alert[], identities: Record<metaId,{name,avatar}>, activation: {hAct2,hAct3}, refresh: {lastRefreshAtMs,lastOkAtMs,lastError,boundaryBlock,refreshing}, localRosterMetaIds: string[] }` |
| `GET /api/metatask/task?root=<pinId>` | `TaskProjection` (§2.1) |
| `POST /api/metatask/refresh` | `{ success, board }` |
| `POST /api/metatask/draft` | `{ text }` — builds the prefilled participation draft for the local bot (the UIs never write decisions; they hand the user a draft to start a bot session with) |
| `GET /api/file/<urlencoded metafile URI>` | metafile bytes (chunk-reassembly proxy, plan §5.4) — used by artifact "download" buttons |
| `GET /api/metatask/events?root=<pinId>&seq=<n>` (optional) | lightweight change feed for polling/SSE; fallback: poll board/task every 60s and on window focus |

### 2.1 TaskProjection (render-side essentials)

```
{ rootPinId, title, brief, publisher, tags,
  policy: { mode:'tree'|'competitive', finalNode, verifyQuorum,
            claimTtlHours, verifyWindowHours, rewardSat, challengeTtlDays,
            submitterShareBP, rosterid },
  nodes: [{ id, parent, title, kind, weight, deps[] }],
  nodeStates: Record<nodeId, {
    id, parent, title, kind, weight, params, specid, status, disputed,
    holder, submission,               // leader view (competitive) / effective (tree)
    submissions?: Candidate[],        // competitive only
    passVotes, failVotes, votes: VoteSummary[], cycleCount, deps[]
  }>,
  progress: { total, verified, claimed, open, disputed, satisfied },
  taskComplete, participants: ParticipantStats[], identities,
  settlement: SettlementManifest | null,
  estimation: { basis, shares: [{metaId, shareBP, from{submittedBP,reviewedBP}}] } | null,
  freshness: { boundaryBlock, evaluatedAtMs, eventCount, eventSetHash, expiryApplied },
  lastActivityMs, ignoredEvents: [{pinId, reason}] }

Candidate = { pinId, submitter, atMs, result, hash, contentType, attachment,
  parentrefs, verified, chainValid, superseded, failed,
  passVotes, failVotes, verifiedHeight, verifiedTxIndex,
  votes?: VoteSummary[] }             // per-candidate review timeline (format v3)

VoteSummary = { voter, verdict, pinId, counted, ignoreReason,
  semanticCheck, failreason,          // booleans (protocol gates)
  targetid, height, timestampMs,      // v3 enrichment
  failreasonText, semanticCheckText } // v3 enrichment (may be null)

SettlementManifest = { taskid, boundaryBlock, eventSetHash, engineAlgoVersion,
  mode?, winningChain?, shares[], unpaidHistory[{node,author,pinId,reason}],
  disputed[], weightsTableHash }
```

BoardTask additionally carries `mode`, `myRoles`, `myStats`,
`settlementFinalized`, `participantCount`, `lastActivityMs`, `freshness`.

---

## 3. Feature inventory (both UIs, fidelity-required)

Order below = page order on the detail view. §6/§7 map each item to surface
mechanics.

| # | Feature | Notes |
|---|---|---|
| F1 | **Board** (square): task cards grid | Title, lifecycle badge (open/in progress/completed/settled), publisher badge, brief (2-line clamp), progress bar (satisfied/total), participant count, disputed count, my-role badge, my stats (verified N · review M), est./settled share, "last activity + N events @ block" footer, participate button (draft, never acts) |
| F2 | Board: view toggle 广场/我的参与, manual refresh, activation notice (when boundary < hAct3), index-lag footnote, block-height anchor | "我的参与" filters `myRoles.length>0` |
| F3 | Board: alert cards (≤4, grouped by kind+root+node) | kinds: claim_ttl_soon / submission_change / closing_drive; each offers participate draft |
| F4 | Detail header | Back, title, lifecycle badge, publisher, verified/total, last activity, block height, event count; brief (readable prose, collapsible if long); policy facts line (quorum, split σ, rewardSat, finalNode, mode) |
| F5 | **Deliverables** (competitive) | Final-deliverable hero when settled (terminal node's winner artifact): type badge, kicker (node id+title+submitter), name, description (result.summary or type default), members chips, sha256, metafile URI + copy, [在 MetaWeb 查看] via `https://openagentinternet.org/browser/metafile/<pinId>`, [打开应用] only when result carries a `metaapp://` reference. Below: one artifact row per winning-chain node (git-bundle → `commit @ baseCommit` + repoHint link; metafile → members summary). In-progress: satisfied nodes' current leaders under "当前产出（进行中）" |
| F6 | Rules strip + chain status line | One-line race explainer (gold = verified chain, blue = race front); status line: `● 已验证链：S1 → S2a (2/7)   ● 竞赛前沿：S2c · <bot>` / settled variant |
| F7 | **Chain view** (competitive only; tree mode keeps the classic dot-grid TreeMap) | §4.1/§4.2 state machines; columns by deps depth; SVG bezier edges for parentrefs; gold flow edges (verified chain), blue flow edges (race front), violet dashed (optimistic), gray (other); horizontal scroll; empty-step invitation box; legend; card click → candidate drawer |
| F8 | **Candidate drawer** (right slide-over) | Identity header (avatar+name, state tag, YOU chip, relative time + verified block), "他交付了什么" (result.summary + type-aware facts + attachment actions: copy URI / open in MetaWeb / open app), parentrefs chips (navigate drawer to parent candidate), review timeline (per-candidate votes, time-asc: voter, verdict badge, time+block, ignoreReason when uncounted, **failreasonText red box**, **semanticCheckText gray box**), on-chain credentials (pinId + copy, hash, supersedeid when present) |
| F9 | **Node requirement sections** (competitive) | Per node card: header (id chip, title, kind, weight `10% · 1000BP`, state/winner chip, disputed), left: rubric numbered list from `params.rubric` (+ spec/workspace summary line; params JSON collapsed when no rubric), right: candidate rows (avatar, name+short pin, vote pips, state tag, time) → drawer |
| F10 | Roster table | participants sorted by verifiedContrib: identity, claims, verified contrib, review votes, est. share (pre-settlement) |
| F11 | Settlement table | shares sorted desc: `shareBP (submittedBP+reviewedBP)` + %; unpaidHistory count + reasons; closing checklist when no manifest yet (all nodes verified / root aggregate verified / no open challenges) |
| F12 | Freshness everywhere | Every progress view shows its boundary block ("@ 192278"); refresh timestamps in board header |
| F13 | Participate drafts (never direct action) | Every "参与" control dispatches a prefilled bot-session draft (mode-aware: tree claim flow vs competitive parentRefs flow). In OAC: hand the draft to the bot session entry point of that surface |

---

## 4. State taxonomies (normative)

### 4.1 Candidate display states (exact mapping — pure display over engine flags)

```
failed                              → rejected   (dimmed 45%, name strikethrough, red tag)
superseded                          → replaced   (ghost 40%, slate tag)
∈ settlement.winningChain           → winner     (gold solid tag + gold border + glow)
live ∧ a parentref target is
  failed/superseded                 → stalled    (gray dashed 60%, slate tag "断链/Dead end")
verified ∧ chainValid ∧ is the
  node's leading candidate          → leading    (gold tag "已验证/Verified", gold border + glow)
verified ∧ chainValid (not leader)  → behind     (emerald tag "已验证 · 备选", emerald border)
verified ∧ ¬chainValid              → awaitingDeps (violet dotted, "等待上游/Awaiting deps")
¬verified ∧ every parentref target
  is chainValid                     → inReview   (sky dashed, "复核中/In review")
otherwise                           → optimistic (violet dotted, "乐观提交/Optimistic")
```

Vote pips: `verifyQuorum` circles; counted passes fill emerald, counted fails
append red. `counted=false` votes show `ignoreReason`.

### 4.2 Race front (blue line) — display geometry only

- Eligible tips: **unverified, live** candidates only (verified = already on
  the gold chain). Tip maximizes (coverage = |live ancestor closure in
  nodes|, then passVotes, then earliest atMs).
- Race path = tip + live ancestors walked via parentrefs.
- On-path in-review cards: **solid** sky border (+ soft glow); the tip card
  gets the "竞赛前沿/Race front" filled sky tag. Path edges: sky, dashed-flow
  animation (same keyframes as gold).
- **Suppressed entirely when `taskComplete`** (no tip, no race edges; status
  line shows "已收官/settled").

### 4.3 Node header status words

`获胜 · <name>` (winner) / `已验证 · <name>` (leader) / `已验证` /
`N 个乐观提交` / `N 个候选竞争` / `开放` — gold text only for winner/leader.

### 4.4 Task lifecycle badge

`settled > completed > inProgress > open` (settled = manifest exists).

---

## 5. Design authorities (bundle these with the port docs)

1. `/Users/tusm/Documents/MetaID_Projects/IDBots/IDBots/docs/design/metatask-chainview-mock.html`
   — chain view: columns, cards, edge styles, gold/blue lines, legend,
   status line, dark theme. Governs F6/F7.
2. `/Users/tusm/Documents/MetaID_Projects/IDBots/IDBots/docs/design/metatask-detail-v2-mock.html`
   — detail page v2: task header, deliverables hero + per-node rows, node
   requirement sections, candidate drawer (open state). Governs F4/F5/F8/F9.
3. `/Users/tusm/Documents/MetaID_Projects/IDBots/IDBots/scripts/metatask-wizard/decomposition-preview.html`
   — wizard decomposition preview (DAG + rubric/weight/deps tables). Governs
   the wizard preview step (both UIs may link to it rather than re-render).
4. React reference implementation (behavior, not styling):
   `/Users/tusm/Documents/MetaID_Projects/IDBots/IDBots/src/renderer/components/metatask/`
   — `MetaTaskBoard.tsx`, `MetaTaskDetail.tsx`, `MetaTaskChainView.tsx`,
   `MetaTaskCandidateDrawer.tsx`, `MetaTaskDeliverables.tsx`,
   `MetaTaskNodeSections.tsx`, `metaTaskCandidateState.ts`,
   `metaTaskArtifact.ts`, `MetaTaskCopyMini.tsx`, `MetaIdBadge.tsx`.
5. Copy source of truth (en + zh):
   `/Users/tusm/Documents/MetaID_Projects/IDBots/IDBots/src/renderer/services/i18n.ts`,
   prefixes `metatask.*` (see §8).

---

## 6. Surface A — DSH plugin: Tracking Tasks panel

### 6.1 Registration (Bots page child section, tabs ready for 长期任务 later)

New section in the Bots page left nav; tab strip inside with `MetaTask` as
the first tab (second tab reserved: 长期任务/Long-term).

- New `dsh-plugin/src/client/TrackingTasksPanel.tsx` — outer tab strip +
  keep-alive `role="tabpanel"` per tab. **Copy the tab mechanics from
  `dsh-plugin/src/client/PluginSettingsPanel.tsx:74-141`** (top tabs,
  localStorage-persisted active tab).
- Register in `dsh-plugin/src/client/index.ts` next to the existing section
  registrations (`:498-523` pattern):
  `ctx.slots.register({ name:'oac.bots.section', id:'oac-tracking', order:21,
  label: () => t('navTracking'), locale: NS, inject: () => ({}) }, TrackingTasksPanel)`
  (order 21 = after 我的Bot(20), before 元应用(24)).
- `dsh-plugin/src/client/bots-page.tsx` `SECTION_ICONS` (:110-114): add an icon.
- `dsh-plugin/src/client/locale.ts`: en+zh keys (`navTracking`, tab labels,
  all panel copy) — the repo asserts en/zh key parity in tests.
- Host routes: new `dsh-plugin/src/metatask-routes.ts` (copy
  `dsh-plugin/src/grouptask.ts:67+` dispatch pattern) + register in
  `dsh-plugin/src/index.ts` dispatcher chain; client data calls added to
  `dsh-plugin/src/client/api.ts` (`api.metataskBoard()`,
  `api.metataskTask(root)`, `api.metataskRefresh()`, …, envelope
  `{ok,state,data}` like `api.ts:551-571`).

### 6.2 Components (React)

Mirror the IDBots component tree 1:1 in responsibility (new files under
`dsh-plugin/src/client/metatask/`):

```
MetataskBoard.tsx        (F1–F3, square/mine toggle)
MetataskDetail.tsx       (F4 header, F6 strip, hosts drawer state)
Deliverables.tsx         (F5)
ChainView.tsx            (F7 — incl. SVG edge overlay)
CandidateDrawer.tsx      (F8 — reuse the panel's overlay pattern; see styles note)
NodeSections.tsx         (F9)
Roster.tsx / Settlement.tsx (F10/F11)
logic.ts                 (candidateState mapping, race-front geometry,
                          artifact parsing, shortPin/shortMetaId — SHARED pure
                          functions; put in dsh-plugin/src/metatask-logic.ts so
                          host+client can both import, per repo convention)
```

Pure display logic (candidateState, race-front, artifact extraction) is a
**direct TypeScript port** of IDBots `metaTaskCandidateState.ts` +
`metaTaskArtifact.ts` — keep the same function names where possible; it makes
cross-review trivial.

### 6.3 Width: "as wide as possible" (explicit requirement)

The Bots page caps tab panels at 720px
(`styles.ts:1051` `.oac-bots-page-content > [role='tabpanel'] { max-width: 720px }`).
Lift it **only for this panel** with a `:has()` rule (precedent exists in
`src/browser/page.ts`):

```css
/* appended to BOTSPAGE_CSS in dsh-plugin/src/client/styles.ts */
.oac-bots-page-content > [role='tabpanel']:has(.oac-track-shell) { max-width: none; }
.oac-track-shell { width: 100%; }
```

The panel root uses `.oac-track-shell` (NOT `.oac-panel`, which re-caps at
720). Chain view scrolls horizontally inside (`overflow-x:auto`) — column
width 224px + 64px gaps as in the mock.

### 6.4 Styling notes (DSH)

- Append a `TRACKING_CSS` segment in `styles.ts` and include it in the
  `index.ts:97` injection join. Reuse existing segments where possible:
  `.oac-tablist/.oac-tab/.oac-tab-panel` (:143-148), `.oac-sch-table*`
  (:565-593, roster/settlement tables), `.oac-gt-dcard*` (:761, artifact
  cards), `.oac-gt-drawer` (:703, drawer shell), `.oac-gt-status-*` (:604,
  status badges).
- Status colors: follow the repo's "bright hex + `body[data-ds-dark-theme]`
  rgba override" pattern (`styles.ts:597` explains why) for the candidate
  palette: gold `#f5b83d`, sky `#38bdf8`, emerald `#34d399`, violet `#a78bfa`,
  red `#f87171`, slate for stalled/replaced.
- Candidate drawer: reuse `.oac-gt-drawer` geometry (absolute inset overlay
  inside the panel) rather than inventing a fixed-position drawer — it stays
  inside the overlay frame.
- SVG edges: no repo precedent — implement as in the mock: an absolutely
  positioned `<svg>` over a `position:relative` flex container; measure card
  rects (`data-cand-pin` attributes + `getBoundingClientRect`), draw cubic
  beziers, recompute on `ResizeObserver` + window resize. Gold/race edges get
  the dash-flow CSS animation; honor `prefers-reduced-motion`.

### 6.5 Tests (DSH)

- Static source assertions in `dsh-plugin/tests/` (registration id/order,
  locale key parity, `:has()` rule presence, no `.oac-panel` on the shell).
- Route dispatch tests (built artifact, fake runner) for the new host routes.

---

## 7. Surface B — `src/ui/pages/tracking` (vanilla TS)

### 7.1 Registration

- New `src/ui/pages/tracking/app.ts` + `index.html` (skeleton copied from
  `src/ui/pages/schedule/`).
- `src/daemon/routes/types.ts`: `MetabotUiPageName` += `'tracking'`.
- `src/daemon/routes/ui.ts`: `PAGE_BUILDERS['tracking']` (else 404) +
  `NAV_ITEMS` += `{ page:'tracking', labelKey:'nav.tracking' }`.
- `src/ui/i18n.ts`: en + zh-CN dictionaries (en is the typed superset);
  client fallbacks must equal en values byte-for-byte (enforced by
  `tests/ui/pageI18nCoverage.test.mjs` — add the page to its whitelist).
- Tab strip inside the page (MetaTask first, 长期任务 reserved): copy the
  **embedded-page pattern** from `src/ui/pages/bot/app.ts:17-43`
  (`EMBEDDED_PAGE_SCRIPTS` + `initEmbeddedPage` lazy init), or the simpler
  `memory` page tab model (`app.ts:99`, `:234-277`) — pick one and stay
  consistent.

### 7.2 Rendering approach

- Data: page IIFE `fetchJson('/api/metatask/board')` etc. Poll 60s + on
  `visibilitychange` (schedule page precedent) or SSE if P7 adds it.
- Board/detail HTML: string templates from the JSON contract; reuse
  `shared.css` classes: `.card`, `.section-header`, `.data-table` (roster,
  settlement), `.status-pill` + `.status-dot` (lifecycle/candidate states —
  add CSS variants for the §4.1 palette in the page `<style>` block),
  `.timeline` + `tone-*` (**direct fit for the review timeline**),
  `.stats-row` (progress facts), `.btn/.btn-sm`.
- Chain view: build the column/card DOM in JS from nodeStates; the SVG edge
  layer is a `<svg>` element sized to the scroll container, paths computed
  from `getBoundingClientRect` of `[data-cand-pin]` elements, redrawn on
  container resize (`ResizeObserver` is available in the target browsers) and
  after each data refresh. Keep geometry helpers as pure functions in
  `src/ui/pages/tracking/chainview.ts` so the vm-sandbox test can unit-test
  them (path string for two rects; race-front tip selection over a fixture).
- Drawer: absolutely positioned right panel inside `.content` (browser page's
  `.browser-drawer` is the only repo precedent — same pattern), Esc + veil
  click to close.
- No dark mode (surface convention).

### 7.3 Tests

- `tests/ui/trackingPageScript.test.mjs` in the established vm-sandbox style
  (`tests/ui/schedulePageScript.test.mjs` skeleton): stub DOM + fetch, assert
  endpoint URLs, board rendering, detail rendering, drawer open content.
- Unit-test `chainview.ts` helpers (node:test, no DOM).

---

## 8. i18n mapping

Copy text, adapt key style per surface (DSH flat keys, src/ui dotted keys).
Source of truth (en+zh): IDBots `src/renderer/services/i18n.ts`. Prefixes in
use:

| Prefix | Count ≈ | Covers |
|---|---|---|
| `metatask.*` (base) | 45 | board, cards, alerts, participate, lifecycle, errors |
| `metatask.chain.*` | 40 | chain view: rules strip, status line, tags, legend, empty |
| `metatask.dlv.*` | 12 | deliverables hero + rows |
| `metatask.cand.*` | 23 | drawer sections, actions, credentials |
| `metatask.node.*` | 12 | node sections, rubric, candidates |

Drafts (F13) — two mode-aware templates live at
`metatask.participateDraft` / `metatask.participateDraftCompetitive`; port
both verbatim (they teach the bot the correct tool flow for each mode). OAC
variants must reference `metabot metatask …` verbs instead of IDBots tool
names — this is the only permitted text change, and it must happen in both
languages.

---

## 9. Fidelity acceptance checklist (both UIs)

Visual/interaction sign-off against the live pilot task (root
`fad848f86d…8bed10i0`, settled):

1. Board shows the pilot card: settled badge, 7/7, publisher bob, correct
   block anchor; no MetaTask alert noise.
2. Detail: deliverables hero shows the S5 package (7 member chips, sha256
   `b75b02ff…`, metafile URI copy works, MetaWeb link opens);
   6 per-node artifact rows; S2 rows show `commit @ baseCommit`.
3. Chain view: 7 columns; winner cards gold with 获胜 tags; failed candidates
   dimmed with strikethrough; **no race-front tag** (task settled); status
   line reads 已验证链 S1 → … → S5 (7/7) · 已收官.
4. Click 宇哥's S5 winner card → drawer: summary box, attachment actions,
   parentref chip to S4 winner navigates the drawer, 3 pass votes with
   reviewer evidence boxes, pin credentials copyable.
5. Click a rejected candidate (e.g. S1 小明同学) → drawer shows the fail vote
   with its red failreason box.
6. Node sections: S2c rubric has its numbered acceptance items; 7 candidate
   rows with correct pips.
7. Settlement table sums to 9991 BP with the exact 11-share breakdown
   `[3600,1600,1600,1200,510,507,399,275,100,100,100]`.
8. In-progress task (or fixtures): blue race line + tip tag visible; explainer
   strip and legend match §4.
9. DSH panel: tabpanel exceeds 720px (`:has()` rule effective), both tabs
   keep-alive, active section/tab survive reload.
10. src/ui page: renders in a plain browser (no console errors), i18n toggle
    switches all new keys, `?tab=` state round-trips.

---

## 10. Appendix A — metafile download recipe (for the `/api/file/` proxy)

Verified against the pilot's S5 package (2026-10-04):

1. `GET https://manapi.metaid.io/content/<pinId>` → JSON manifest:
   `{ sha256, fileSize, chunkNumber, chunkSize, dataType, name, chunkList[] }`.
2. Small files return inline content directly; chunked files (like S5:
   6,488,396 bytes, 7 chunks) list `chunkList[{sha256, pinId}]`.
3. Fetch each chunk via the same route (raw bytes), concatenate **in listed
   order**, verify `sha256(file) == manifest.sha256` (S5:
   `b75b02ff1e71714f9d6d668573ca449869503ed4cf2c30a259dc0f72ec6965a8`).
4. Serve with the manifest's `dataType` and `name`. Cache by pinId (content
   is immutable).
5. Note (probed during the pilot): the suffixed URI form
   (`metafile://<pin>.gz`) 404s on the content route; resolve by bare
   66-char pin id. Bare-pin `metafile://` URIs without extension are valid
   and must be accepted.
