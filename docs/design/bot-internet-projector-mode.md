# Bot Internet Projector Mode (Visual Assistant)

Status: APPROVED — requirements aligned with owner on 2026-11-07. Branch: `feat/bot-internet-visual-assistant`.

## Goal

Turn the Bot Internet tab into a meeting-room style visual assistant surface: the owner
chats with their Twin bot on the left, and at the end of each turn the Twin projects a
visual HTML report onto the right-side bot browser — like an assistant putting a slide on
the projector after finishing a piece of work in a meeting room.

Motivation: assistant output today is text-heavy Markdown; humans read walls of text
fatigue and miss emphasis. A projected page can use size, color, tables, charts and
infographics to carry the same report with far less reading effort.

## UX contract

### Left pane (Bot Internet co-work panel)

- Always runs assistant mode, regardless of the global `chatExperienceMode` setting.
- No thinking / tool-process display (assistant projection semantics hide it already).
- Locked to the owner's Twin bot. The bot selector dropdown is replaced by a fixed Twin
  identity chip (avatar + name + Twin badge), not clickable — it tells the user who they
  are talking to, nothing else.
- If the machine has no Twin: do not allow chatting; show bootstrap guidance to create a
  Twin first (reuse the Bot Home bootstrap flow).
- Left-side chat text output stays as-is (assistant reporting style).

### Right pane (the projector)

- One projection tab per session. Each projected turn = one self-contained HTML page,
  navigated in place inside that tab. The ABC per-tab history stack then gives free
  back/forward review of previous turns' pages.
- **First turn of a session MUST project** — even a bare greeting ("GM") projects a
  welcome page (big smiley / welcome composition). This pulls the user into the mode
  immediately.
- Later turns project only when the turn produced a new outcome / arrangement / state
  change. Small talk, follow-up questions, or turns where the previous page is still
  accurate → no projection; the projector keeps showing the last page.
- When the turn is about a metaapp that is open in the browser, do not cover it.
- A final report always reveals the session's projection tab and switches the internet
  pane to Browser, including when the owner had selected another tab or pane. Live Stage
  progress updates are the exception: they navigate in the background without changing
  the active tab. Neither flow changes the OS window focus after the initial tab opens.

### Chat side effects

- No inline metaapp / HTML embeds in this tab (owner ruling: keep the visual focus on the
  projector). Metaapp embeds and local HTML report links render as ordinary Bot Browser
  links.
- After each successful projection, a small chip appears in the bubble flow ("report
  projected"), clickable to focus the projection tab. It is also the persistent recovery
  entry after an app restart (ABC tab history is in-memory only).

## Decisions (owner rulings, 2026-11-07)

1. Old browser sessions keep rendering exactly as today (professional mode); only
   sessions created after this change carry the marker.
2. No-Twin machines are blocked with bootstrap guidance; no fallback to other bots.
3. Projection transport: extend the existing `bot_browser_preview_local` tool with a
   projection parameter — no new tool surface.
4. Focus policy: final reports reveal the projection tab; only Live Stage progress
   updates stay in the background. Neither changes OS focus after the initial open.
5. Desktop voice input: out of scope for v1; validate the visual-report core first.
6. Sessions carrying the marker render assistant-style everywhere they appear (Bot Home
   list included) — one shared logic, no per-surface forks.
7. In this tab, metaapp / HTML is never embedded inline in bubbles; everything guides to
   the right-side big screen.

## Technical design

### Session marker

- New persisted per-session flag `assistantMode` on cowork sessions, set at session
  start when launched from the Bot Internet co-work panel. Idempotent first-run migration
  (existing rows default to unset = legacy behavior).
- Global `chatExperienceMode` stays untouched and keeps governing everything else.

### Gate

- Main `isAssistantModeOwnerChatSession`: additionally accept `sessionType === 'browser'`
  sessions that carry the marker (plus the existing `cowork_ui` source-channel check).
- Renderer mirror (`assistantModeSessionGate.ts`): accept browser sessions with the
  marker; also report "projector mode" so the panel can adjust embed rendering.
- Prompt mount stays the single `buildAssistantModePrompt()` — one source of truth for
  assistant-mode behavior shared with Bot Home. Effort fallback (`off`), `owner_update`
  cap, and assistant UI semantics follow automatically.

### Projector prompt section

- New conditional section (`idbots:projector-mode`), built in `assistantModePrompt.ts`
  and mounted only for marker sessions; for these sessions it replaces the assistant
  prompt's inline-HTML-report and metaapp-embed clauses.
- Content principles (trust the LLM's composition, no rigid template):
  - Meeting-room framing: the right pane is a projector; the user expects each turn's
    outcome projected as one page.
  - First turn of the session MUST call the projection tool, even for greetings.
  - Projection decision rule: new result / arrangement / state change → project;
    continuation with an accurate page → skip; open metaapp under discussion → skip.
  - One page per turn, self-contained snapshot (not a delta — the reader may join
    mid-way): conclusion first, emphasis via size/color hierarchy, tables, timelines,
    inline SVG/CSS charts; inline assets preferred over CDN.
  - Page carries its own title, turn number and time.
  - Write the page to `<session cwd>/reports/turn-<n>.html`, then call
    `bot_browser_preview_local` with `projection: true`.
  - In this mode never embed metaapp / HTML in the chat bubble; project instead.

### Projection protocol (host side)

- `bot_browser_preview_local` gains `projection: boolean` and optional `title`.
- Main keeps a `sessionId → projection tab id` map; the entry is invalidated only when the
  tab is confirmed missing (ABC tabs are in-memory). A final report also carries the current
  turn's confirmed Stage tab id, so a lost map entry cannot fork the projection onto a new tab.
- First projection for a session: open a new tab through the awaited tab bridge, confirm
  its id, and record it. A missing cached tab opens a confirmed replacement; the service
  never adopts an unrelated tab by the shared reports-directory prefix. A transient tab-info
  bridge failure falls back to the tab list; if both reads fail, the projection fails without
  deleting the binding or opening a duplicate tab.
- Subsequent Live Stage projections navigate that specific tab in the background. Final
  reports use the same navigation with `activate: true`, leaving the target active through
  resolution so ABC paints the report before the tool returns. Background resolutions mark
  the cleared target pane unpainted so a later reveal rehydrates it instead of showing blank.
- ABC re-resolves the URI on history traversal, so back/forward works for free. A successful
  report also writes its URI into the frozen Stage snapshot. Back then exposes an **Open
  report** button whose in-page navigation is accepted only from the active Stage frame,
  for the same turn and a report in the same local-preview directory.
- Projection tab title defaults to the provided `title` (e.g. "Turn 3 report") instead of
  the generic "Local Preview".

### Renderer changes

- `BotBrowserCoworkPanel`: Twin chip instead of `MetaBotSelector`; force Twin id into
  `startSession` plus the marker; no-Twin bootstrap empty state.
- `MarkdownContent`: marker sessions render metaapp embeds and local HTML report links as
  Bot Browser links (projector policy), even though the session is assistant mode.
- Projection chip element in the bubble flow after a successful projection; click focuses
  the projection tab.

## Out of scope (v1)

- Desktop voice/dictation input.
- Persisting ABC tab history across restarts (chat chip is the recovery entry).
- Any change to Bot Home assistant mode itself.

## Acceptance

- `pnpm compile` + relevant test suites green.
- Real-machine pass: greeting first turn projects a welcome page; a work turn automatically
  reveals its infographic report even after the owner selects another tab; Back reviews the
  Live Stage page; no inline embeds in this tab; Bot Home renders marker sessions
  assistant-style; legacy browser sessions unchanged.
