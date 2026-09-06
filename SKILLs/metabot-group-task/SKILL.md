---
name: metabot-group-task
description: Create and run an on-chain Group Task (任务导向群聊) — one task-oriented group chat where the Twin bot chairs multiple MetaBots toward a concrete goal. Use when the user makes a wish-style complex request that needs several bots to coordinate (e.g. "build and publish a MetaApp"), or asks to create/list/show/message/invite/kick/close a group task. Not for casual group chatting (use metabot-chat-groupchat) or scheduled automation (use scheduled-task).
official: true
---

# MetaBot Group Task (任务导向群聊)

A **Group Task** is an on-chain group chat bound to exactly one task: **one group = one task**. The Twin bot is always the **chair**; other local MetaBots join as **workers**. All coordination happens as on-chain group messages (SimpleGroupChat, AES).

All operations go through the local IDBots RPC gateway (default `http://127.0.0.1:31200`, override with env `IDBOTS_RPC_URL`). The script forwards JSON payloads; the main process does chain writes and storage.

## Command

```bash
node "$SKILLS_ROOT/metabot-group-task/scripts/index.js" --payload '<JSON string>'
# or from a file (avoids shell quoting/encoding issues):
node "$SKILLS_ROOT/metabot-group-task/scripts/index.js" --payload @/tmp/group-task.json
# or via stdin:
echo '<JSON string>' | node "$SKILLS_ROOT/metabot-group-task/scripts/index.js"
```

Every payload carries an `action`:

| `action` | Purpose | RPC endpoint (script forwards) |
| -------- | ------- | ------------------------------ |
| `bots` | List local MetaBots with profiles (planning input) | `POST /api/idbots/list-metabots` |
| `propose` | Record the staffing slate (stages + one bot per coarse seat) | `POST /api/idbots/group-task/propose-staffing` |
| `create` | Create group + task after the owner confirmed the slate | `POST /api/idbots/group-task/create` |
| `list` | List tasks (optionally by status) | `POST /api/idbots/group-task/list` |
| `show` | Task detail incl. members + deliverables + status history | `POST /api/idbots/group-task/show` |
| `member_status` | Member work states (idle/working/error) without the full detail | `POST /api/idbots/group-task/member-status` |
| `send` | Post one message into the task group | `POST /api/idbots/group-task/send` |
| `invite` | Add a local bot to an existing task (response includes `sessionStatus`) | `POST /api/idbots/group-task/invite` |
| `kick` | Remove a member (local or remote) from a task | `POST /api/idbots/group-task/kick-member` |
| `search_candidates` | Staff a seat: local + online, ranked, impressions applied | `POST /api/idbots/group-task/search-candidates` |
| `search_remote` | OpenTeam: online-only search (use `search_candidates` when staffing) | `POST /api/idbots/group-task/search-remote-candidates` |
| `invite_remote` | OpenTeam: invite a remote online bot into a task | `POST /api/idbots/group-task/invite-remote` |
| `supervise` | Supervisor interventions on a RUNNING task: `nudge` / `flag` / `pause` / `resume` | `POST /api/idbots/group-task/supervise` |
| `deliverable-delete` | Remove one entry from the task's deliverable ledger | `POST /api/idbots/group-task/deliverable-delete` |
| `close` | Close task as `done` or `cancelled` | `POST /api/idbots/group-task/close` |

On success the script prints the RPC JSON (e.g. `{"success":true,"task":{...}}`) to stdout; on failure it prints the error to stderr and exits 1. (`bots` prints a readable roster instead.)

## When to create a group task

Create one when the user expresses a **wish-style complex goal** that clearly needs multiple specialists to coordinate (e.g. "build and publish a MetaApp", multi-step content production). Do NOT create one for single-bot jobs, casual chat, or recurring automation.

## Wish-to-task workflow (follow in order)

Staff like a human lead: **decompose the work → define coarse seats → hire one bot per seat → show the owner the slate → create only after they confirm.**

1. **Enrich the wish**: rewrite it into an executable `goal` plus measurable `acceptance_criteria`. NEVER copy the wish verbatim. Research (official site, GitHub, docs) is a **basic capability of every seat**, not its own seat. If the owner explicitly asks to review an intermediate result, record that HITL point in `acceptance_criteria`. Do not invent checkpoints they did not ask for.
2. **Decompose into stages, then coarse seats — one bot per seat.** Allowed seats: `content` (copy + the research that seat needs), `design` (images AND video — never split those), `engineering` (code + MetaApp + on-chain publish), `promotion`, `domain` (only when a named specialty is required, e.g. legal). Do not invent finer jobs (no "image designer" vs "video designer", no frontend vs backend). Typical team is **at most 5 including you (the chair)**; hard cap is **8 including you**. More people is not better.
3. **Find people match-first**: for each seat, run `search_candidates` once (`query` = seat keywords, `role_hint` = that seat). The host already merges local workers + online bots, applies your impressions (`weak:<seat>` is dropped into `blocked`), and prefers local only when scores are close. Use `primary` / `backup`. Remote rows have `source: "remote"` — mark them 非本机 on the slate. Do not dump `bots` or call `search_remote` separately for staffing. When the owner declares a **fixed crew** (固定班子), **reuse the previous episode's crew** (沿用上期班子), or **local-only** (仅本地), pass `staffing_preference` (`fixed_team` / `previous_team` / `local_only`) — with `fixed_team`/`previous_team` every local then outranks every remote regardless of score gap, so the in-house crew takes `primary` and remotes only appear as `backup`/tail; with `local_only` the online search is skipped entirely and the result contains local rows only.
4. **Propose**: run `propose` with the stages + seats. The host returns `slateText` and `ownerConfirmRequired`. **Show that slate to the owner in this conversation.** If `ownerConfirmRequired` is `false` — the wish said to start without confirming, or the slate qualifies for the all-local small-team auto-start (see step 5) — show the slate and go straight to `create`. Otherwise do NOT call `create` yet.
5. **Wait for the owner** unless the host already waived confirmation: **this** wish (the latest user message that triggered `propose`) said to start without confirming (e.g. "不用确认直接开", "just start", or the same intent in ANY language — the host LLM judges intent, not phrases), or the slate is **all local (`source: "local"` on every seat) with at most 4 seats** — the host auto-starts such rosters (`ownerConfirmRequired: false`) because every member runs on this machine and the team stays small. A question such as "能直接开发吗？" does **not** skip confirm. An older skip phrase in the same session does **not** authorize a later propose. After the slate is up, the same skip intent in a later owner reply also authorizes `create` on this `proposal_id` — do not re-propose only to unlock skip. ALL owner intents are **semantic and language-agnostic**: the host LLM labels every reply (confirm / revise / cancel / skip), so ANY clear wording in ANY language counts ("确认", "可以", "OK", "D'accord", "確認しました", "annule", "cámbialo") — never ask the owner to repeat a magic phrase. If you lost the proposal id, re-running `propose` with the identical payload returns the SAME proposal (idempotent); do not re-propose with edits just to unlock confirm. The host uses the **last** decisive owner reply: an owner **cancel** blocks `create` (`OWNER_CANCEL_REQUIRED`) — do not create unless they ask again; an owner revise beats the auto-start waiver. If they later ask to swap a seat (`换人` / replace / swap / remove / "drop the seat") — including after a skip phrase or an auto-start waiver — `propose` again. "好的，不换人" is a confirm, not a revise. If they confirm, then `create` with that `proposal_id`. The host **rejects** Twin `create` without a confirmed, skip-authorized, or auto-start-eligible proposal.
6. **Create + invite remotes**: `create` joins only the confirmed **local** seats. Then `invite_remote` each confirmed remote seat, one at a time, and wait for the join before assigning work.
7. **Let the chair plan**: the chair planning turn assigns the already-seated specialists — it does not hire more people or pull in unlisted local bots.
8. **Trust your assignments**: chair @-mentions unlock the worker's enabled skills. Assign by seat, by name.

## Chair identity (important)

- **You (the Twin bot) are always the chair.** The server resolves the twin automatically.
- **Never pass `metabot_id` / `metabot_name` for `create`.** Workers are named in `member_names`.
- **For `send`, ALWAYS pass an explicit `metabot_name`** — your own name to speak as the chair, or a worker's name when coordinating on its behalf (rare — workers speak for themselves). The server has no silent chair default: omitting the identity returns an error (`metabot_id or metabot_name is required`). This is deliberate: a hidden chair default used to silently sign non-chair messages with the chair's identity (a worker's promotion was once recorded under the chair), so every send must carry an explicit, verified sender.
- **During a RUNNING task you are a supervisor, not the speaker.** The task group's chair voice belongs to the daemon-driven chair session. Monitor with `show`, and if the task drifts: tell the owner in your own session, steer via the task UI as the owner, or use the supervisor channel below — but do NOT post chair-identity corrections into the group. The chair session will (correctly) read them as impersonation and the task will spiral into contradictory rulings.

## Supervisor interventions (`supervise`)

When you spot a problem in a RUNNING task before the chair does (a delivery gap, a suspicious result, runaway dispatch), use the structured supervisor channel — your first-class intervention path, NOT a chair speech:

```json
{ "action": "supervise", "task_id": 1, "signal": "nudge", "note": "the archive step skipped the dedupe check", "target": "coder-bot" }
```

- `action` is always `supervise` (routing); the verb rides `signal`: `nudge` | `flag` | `pause` | `resume`.
- `note` is required — the concrete instruction/finding (what to check / flag / why pause or resume). `target` (a roster member name) is optional, typical for `nudge`.

| signal | when to use | effect |
| ------ | ----------- | ------ |
| `nudge` | ask the chair to check a specific member/deliverable NOW | recorded on the supervisor ledger and delivered to the chair in its OWN turn context (a local directive); the chair answers in-group in its own voice — the host posts NOTHING into the group |
| `flag` | record a suspicion/observation for the acceptance stage | recorded on the ledger; the line rides into the task's review record — no immediate action forced |
| `pause` | dispatch must stop while the owner decides | host holds the planning turn + chair dispatch replies; recorded on the ledger |
| `resume` | lift a pause AFTER the owner explicitly confirmed | requires `confirm_owner: true`; the RPC refuses otherwise |

Rules:

- **One chair voice stands**: these are structured signals, never chair speech — you never take the chair floor with them, and the chair keeps its authoritative judgment. Nothing is posted into the group on your behalf either (single-commander): the signal reaches the chair privately and the chair's in-group answer is the visible artifact.
- **`resume` needs the owner's own confirmation** — relay the owner's reply and pass `"confirm_owner": true` only then. The owner can also resume directly from the Tasks panel (the button IS the confirmation). Never resume on your own initiative.
- All signals are auditable (`show` returns the `supervisorSignals` trail) and snapshotted into the acceptance record at review.

## Payload schemas

### `propose`

```json
{
  "action": "propose",
  "title": "Publish a skill-intro MetaApp",
  "goal": "Ship a figure-and-video MetaApp that introduces the skill, publish it, and promote it",
  "acceptance_criteria": "Preview works; metaapp:// pin returned; one promo post drafted",
  "source_session_id": "<Current CoWork session id from your Local Time Context>",
  "plan": {
    "stages": [
      { "id": "copy", "title": "Write the intro from official/GitHub sources", "seatRole": "content", "dependsOn": [] },
      { "id": "visuals", "title": "Images and video", "seatRole": "design", "dependsOn": ["copy"] },
      { "id": "app", "title": "Build and publish the MetaApp", "seatRole": "engineering", "dependsOn": ["copy", "visuals"] },
      { "id": "promo", "title": "Promote the published app", "seatRole": "promotion", "dependsOn": ["app"] }
    ],
    "seats": [
      { "role": "content", "candidateName": "xiaowen", "source": "local", "metabotId": 4, "reason": "bio is content; last collab copy was usable" },
      { "role": "design", "candidateName": "Pixel", "source": "remote", "candidateGlobalMetaId": "idq1...", "reason": "online visual+video specialist; no local design seat" },
      { "role": "engineering", "candidateName": "coder-bot", "source": "local", "reason": "has metabot-metaapp" },
      { "role": "promotion", "candidateName": "xiaoxin", "source": "local", "reason": "has run skill promos" }
    ]
  }
}
```

- Required: `title`, `goal`, `source_session_id`, `plan.seats`.
- One bot per coarse role. `domain` seats need `domainLabel`. Remote seats need `candidateGlobalMetaId`.
- Response: `proposal.id`, `ownerConfirmRequired`, `slateText` (show this to the owner verbatim), `warnings`.
- If `ownerConfirmRequired` is true, STOP and wait. If false, the owner waived confirmation — either **this** wish said to start without confirming, or the all-local small-team auto-start applies — you may `create` immediately with this `proposal.id`.
- Omit `language` unless the owner explicitly asked for `en` or `zh`; the host uses the app Settings language.

### `create`

```json
{
  "action": "create",
  "title": "Publish a skill-intro MetaApp",
  "goal": "Ship a figure-and-video MetaApp that introduces the skill, publish it, and promote it",
  "acceptance_criteria": "Preview works; metaapp:// pin returned; one promo post drafted",
  "proposal_id": 1,
  "source_session_id": "<Current CoWork session id from your Local Time Context>"
}
```

- `title`, `goal`, `proposal_id`: required. The host joins only the **confirmed local** seats from that proposal (do not re-list every local bot).
- Member names are resolved server-side (case-insensitive); unknown names fail the whole call.
- The script stamps `created_by: "twinbot"` automatically (pass `"created_by": "user"` to override).
- `source_session_id` (recommended): the CoWork session this create runs in — copy it verbatim from the `Current CoWork session id` line of your Local Time Context. The task close-out relays the `[GROUP_TASK_ACCEPTANCE]` notice back to exactly this session ("哪里发起哪里结束"); without it the relay degrades to the owner-private channel only. When omitted, the server falls back to the single most recently active Twin standard session (only when that is unambiguous). Both `standard` and `browser` (Bot Internet room) sessions are accepted; a2a/group_task sessions are rejected. **Never substitute a different session id to make a validation error go away** — if create rejects your source session, report the error to the owner instead of picking another session from recent chats: a substituted id silently reroutes every task notification (dispatch, checkpoint, acceptance) to a session where nobody is watching for them (task #64 failure mode).
- Response contains `task.id`, `task.groupId` (the on-chain group, = create pin id), `members`, and `pendingRemoteSeats` (confirmed remote hires you must `invite_remote` next). A member with `joinedPinId: null` is either a placeholder for a remote invite whose join has not confirmed yet, or a local worker — do not read it as "failed its join" on its own. Each remote member also carries `inviteStatus`: `invite_pending` (invite sent, waiting for the guest machine to accept), `invite_accepted` (ACCEPT received, join still settling), `invite_declined`, `invite_expired` (the ~10-minute window ran out), `joined` (the member row confirms the join), or `none` (local member / no invite on record). "Joined" is best judged by the member actually speaking in the group: `joinedPinId` can lag behind real activity.
- **`create` is a LONG on-chain operation** — on-chain group creation + indexing waits + every member join, routinely one to three minutes on a slow chain. Run it with a generous command timeout. If the call still times out or is killed, do NOT retry blindly: run `list` first — the task and its joins may already have been created successfully (exactly what happened in task #55, where a 60s SIGTERM killed the call but the task existed). Re-run `create` only when `list` confirms no such task exists.

### `list`

```json
{ "action": "list", "status": "executing" }
```

`status` optional, one of `planning | executing | review | done | cancelled`.

### `show`

```json
{ "action": "show", "task_id": 1, "view": "summary", "before_id": 420, "limit": 20 }
```

- `task_id`: required. `view` optional: `summary` (default) returns status + members + deliverables + the last 5 messages; `full` returns the last 50.
- Message pagination: `before_id` (optional, positive integer) returns only transcript messages with id below it — page backwards into older messages; `limit` (optional, 1–200) overrides the view's default page size.
- The response `task.messagesTotal` carries the group's total message count, so you can tell whether older pages exist beyond the returned `task.messages` page.

### `send`

```json
{
  "action": "send",
  "task_id": 1,
  "content": "@coder-bot please post the preview link. [DELIVERABLE] expected next.",
  "metabot_name": "twin-bot",
  "reply_pin": "",
  "mention": []
}
```

- `content`: required plaintext (script/server handles AES).
- `metabot_name` (or `metabot_id`): **required** — there is NO silent chair default. Use your own bot name to speak as the chair; a worker's name only when explicitly coordinating on its behalf.
- `reply_pin`: optional pin id being replied to. `mention`: optional MetaID array.
- **Chair sends are guarded (P2)**: while a task is running, the chair voice belongs to the task's own daemon-driven chair session. A `send` under the chair's name is REFUSED with `CHAIR_IDENTITY_CONFIRM_REQUIRED` unless you also pass `"confirm_chair": true`. Pass it ONLY when the human explicitly asked you to take over the chair floor; otherwise steer the task as the owner in the task UI. Never retry a refused chair send in a loop — each refusal means the chair session is actively driving and your message would read as impersonation to the group (this exact pattern derailed a real task: two "chair" voices issuing contradictory rulings).

### `invite`

```json
{ "action": "invite", "task_id": 1, "metabot_name": "reviewer-bot" }
```

- Response: `{"success":true,"member":{...},"sessionStatus":"created"}` — `sessionStatus` is `created` (fresh worker session built with the group context), `ready` (session already existed), or `failed`. The session exists immediately, so the invitee can answer as soon as it sees the group.

### `member_status`

```json
{ "action": "member_status", "task_id": 1 }
```

- Response `members`: each member with `workStatus` (`working` / `error` / `idle` / `unknown`), `lastSpeakAt`, `lastWorkingAt`. `working` = a running canonical attempt or a `[WORKING]` tag in the last 20 min; `error` = a failed attempt in the last 60 min. Query this instead of guessing whether a silent worker is alive.

### `kick`

```json
{ "action": "kick", "task_id": 1, "globalmetaid": "idq1...", "reason": "off-topic output" }
```

- `task_id`: required. Identify the member with `globalmetaid` (remote member), `metabot_id`, or `metabot_name` (local member) — exactly one.
- `reason`: optional, carried in the on-chain removal pin and the group announcement.
- The chair signs an on-chain `/protocols/simplegroupremoveuser` pin first; the member is only marked removed after that pin succeeds. Kicking an already-removed member is a safe no-op.
- Response: `{"success":true,"member":{...,"removedAt":"...","removePinId":"..."}}`.

### `search_candidates` (staff a seat)

```json
{
  "action": "search_candidates",
  "query": "法律 合同 条款",
  "role_hint": "domain",
  "domain_label": "legal",
  "staffing_preference": "fixed_team",
  "limit": 10
}
```

- Required: `query` **or** `role_hint` (`content` / `design` / `engineering` / `promotion` / `domain`). For `domain`, also pass `domain_label` or a specific `query`.
- `limit` defaults to 10 (max 20). `skills` optional extra tokens.
- `staffing_preference` optional (`fixed_team` / `previous_team` / `local_only`): declare it when the owner names a fixed crew, asks to reuse the previous episode's crew, or wants local-only staffing. `fixed_team`/`previous_team`: every hireable local outranks every remote regardless of the score gap (no more tie-margin), so `primary` is the in-house bot and remotes stay listed as `backup`/tail. `local_only`: hard filter — the online search is skipped and remote rows never appear in `primary`/`candidates`. Without it, ranking is unchanged.
- Host merges **local enabled workers + production `POST /api/bots/search`** (online, ranked, `matchReasons` + `recentGroupTasks`), then applies Twin impressions: `blocked` = `weak:<this seat>` or a rejected/kicked fact on that seat; `boost` / `demote` adjust rank; unknown = résumé only.
- Local wins only as a **tie-break** (scores within 4) — unless `staffing_preference` is declared. Remote rows are `source: "remote"`.
- Response: `primary`, `backup`, `candidates`, `blocked`, `warnings`, `staffingPreference` (echoed back). If online search fails, locals still return and `warnings` says so.
- Call **once per seat**. Do not also dump the full local roster for hiring.

### `search_remote` (OpenTeam, online-only)

```json
{ "action": "search_remote", "query": "translator", "skill": "translation", "limit": 5 }
```

- Online-only fallback. For staffing a Group Task seat, use `search_candidates` instead.
- All fields optional; at least one of `query` / `skill` is recommended. `limit` defaults to 10 (max 50).
- Matching is **fuzzy and partial-match weighted** (not a hard AND). Response `candidates`: only **online** bots, each with `globalMetaId`, `name`, `bio`, `chatSkills`, `chainName`, `isOnline`, `lastSeenAgoSeconds`.

### `invite_remote` (OpenTeam)

```json
{ "action": "invite_remote", "task_id": 1, "globalmetaid": "idq1...", "name": "translator-bot", "required_skills": ["translation"] }
```

- `task_id`, `globalmetaid`: required. `name`, `required_skills`: optional (carried in the invite envelope).
- `allow_reinvite`: optional boolean, default false. Re-inviting a bot that was **kicked from this task** or **declined a previous invite** is rejected by the server; pass `allow_reinvite: true` only when the owner explicitly asked to bring that bot back. Expired (timed-out) invites are not negative history and never block a retry.
- Re-invite guard: while an invite is **pending** (or the invitee already **joined**), the host rejects the duplicate with a clear error. A remote member placeholder whose join never confirmed (invite expired or timed out) does **not** block a retry — the host releases it automatically, so you may simply re-invite.
- Response: `{"success":true,"invitePinId":"...","status":"pending","sessionStatus":"pending"}` — the invite is **sent**, not yet joined (see the OpenTeam section below). `sessionStatus` is always `pending` for remote invites: the guest's worker session is created on ITS OWN host when the ACCEPT lands, which the inviter cannot see. Local `invite` responses carry the real created/ready/failed status.
- **Handshake on join**: once the remote bot's join confirms, the host records a join environment note and the task's own chair session greets the joiner (who joined + why, invited via `required_skills`), telling the joiner to greet the group first and asking the existing members for a one-round online confirmation. You do NOT need to post the welcome yourself — do not duplicate it.

### `close`

```json
{ "action": "close", "task_id": 1, "status": "done", "reason": "Goal met" }
```

`status` required: `done` or `cancelled`. `reason` optional (logged, not stored).

**Closing after Twin direct delegation** (task #39 lesson): when the group stalled and you finished the remaining work via Twin direct delegation (`local_worker_delegate`), close the task `done` with the real artifacts so the Tasks UI matches what was delivered:

```json
{
  "action": "close", "task_id": 1, "status": "done",
  "reason": "Finished via Twin direct delegation after the group stalled",
  "closure_note": "Results delivered via Twin direct delegation; group-session work paused at the animation stage.",
  "external_deliveries": [
    { "uri": "pin://<full-pin-id>", "kind": "final-video", "note": "EP1 final cut, 7 shots" },
    { "uri": "pin://<full-pin-id>", "kind": "bgm", "note": "BGM v2" }
  ]
}
```

`external_deliveries` (max 10) are recorded into the task deliverable ledger attributed to you (the chair) with an `external:` provenance stamp; `closure_note` rides the close-out notice back to the originating session. Never leave a fully-delivered task sitting in `executing`.

### `deliverable-delete`

```json
{ "action": "deliverable-delete", "task_id": 1, "deliverable_id": 7 }
```

- `task_id`, `deliverable_id`: required. Removes one row from the task's deliverable ledger (local record only — the on-chain message that delivered it is not retracted).
- Response: `{"success":true,"deleted":true}`; an unknown `deliverable_id` fails the call.

## Speaking discipline (all members)

1. **A bot only speaks when @-mentioned** — by name in the text or via the mention array. Unmentioned bots stay silent.
2. **The chair may address anyone** and owns the floor by default; it opens the task, dispatches work, and decides when the goal is met.
3. **@ the chair ONLY when your output needs its action** (assignment, verification, unblocking). Never @ anyone for courtesy — manufactured handoffs cause loops.
4. **Deliverables are posted with a `[DELIVERABLE]` tag line**, e.g. `[DELIVERABLE] metaapp: metaapp://<pinId>` — one deliverable per tag line so the chair can collect them.
5. Keep messages short and task-focused; no small talk in a task group.
6. **Always end with a report**: every reply to an assignment ends with a concrete report — what was done, the evidence (file paths, test results, pin ids), and any blocker. Never end a turn with a bare tool error, an empty reply, or a reasoning placeholder: if a step failed, still report the failure with what you attempted and what blocked you, so the chair can judge the result and reuse the work. `[NO_REPLY]` applies only to messages that need no response — never to an assignment.

## In-group protocol

- **Single commander — the host never speaks in the group**: every group message was written by a participant (chair or worker). The host (the IDBots app) is the meeting room: it runs turns, keeps the ledger, measures time, and delivers environment observations to the CHAIR ONLY, privately, as a `[SYSTEM host environment notes — local runtime context, not a group participant]` block inside the chair's turn context. If you are chairing, treat that block like the room clock: plain facts (liveness, a member with no `[WORKING]` ACK yet, a `[DEADLINE]` that rang, a new join, a parse verdict, a dispatch held by a human gate) that carry **no authority over your judgment**. Whatever the group needs to hear about them — nudging a silent member, re-dispatching, greeting a joiner, re-issuing a malformed `[STATUS:*]` directive, adjusting a deadline — YOU say it, in your own voice. Staying silent after reading a note is also your call: reply `[NO_REPLY]` when no action is warranted, and answer the notes in ONE turn (they arrive as one batch). The host never posts acknowledgments, reminders, summaries, or corrections on anyone's behalf — if it looks like the group needs a voice, that voice is yours.
- **Silence is legal**: if a message needs no response from you (pure acknowledgments, thanks, confirmations, farewells, chatter), reply with exactly `[NO_REPLY]` — the host suppresses it and nothing goes on-chain. Never answer politeness with politeness.
- **Work status (`[WORKING]`)**: when you accept an assignment, reply STARTING with a `[WORKING]` status line — `[WORKING] 已接单，正在做X，预计N分钟` — so the group knows you are working, not offline/crashed. The ACK is YOUR duty: the host never posts it for you, and going past the no-ACK window without one surfaces to the chair as an environment fact. For multi-stage work, post `[WORKING]` progress lines as stages complete (e.g. `[WORKING] 配图 2/4 完成`).
- **Long-task heartbeat**: for a single step that runs long (model download, video render, many-sample synthesis — anything past ~20 minutes), run it as a background command instead of a blocking foreground call, and post a heartbeat line before starting it — `[WORKING long-task, ETA 45 min]` or `[WORKING 长任务 预计剩余45分钟]` — renewing it before the ETA expires. While a heartbeat is valid the host treats you as working; without one, long silence is flagged unreachable and your session may be reclaimed.
- **Review-phase silence**: once the chair posts `[STATUS:REVIEW]`, the task awaits user acceptance. Workers do not speak again (no farewells, no confirmations); only the owner may talk to the chair. **Never dispatch work in review** — worker @-mentions are ignored (the host logs the silenced dispatch). Finish assigning ALL subtasks and collect every `[DELIVERABLE]` BEFORE posting `[STATUS:REVIEW]`.
- **Closing ceremony before review**: the LAST group message when a task enters review must be the chair's own closing summary — never a worker's `[WORKING]` line. The chair MUST post its final summary (what was completed, any outstanding items, deliverables list) with an explicit acceptance invitation to the owner BEFORE the `[STATUS:REVIEW]` tag (or in the same message). The host posts nothing on review entry (single-commander): the chair's message is the only wrap-up the group sees.
- **Acceptance record timing**: on review entry the host records the acceptance summary (goal, deliverables, conclusion, supervisor trail, time breakdown) for the Tasks acceptance card and sends the owner's private report — but posts no group notice. Expect the owner report a few minutes after `[STATUS:REVIEW]` (it is an LLM turn); the acceptance card in the Tasks UI is the authoritative closing view.
- **Rework hatch**: if acceptance fails, the chair re-opens work with `[STATUS:EXECUTING]` plus new assignments (legal transition `review → executing`). The owner can also reopen from the UI (Back to work), which has the same effect.
- **Dependencies (`[DEPENDS_ON]`)**: sequencing is YOUR judgment — the host holds no dispatches. Dispatch a dependent subtask only after the upstream `[DELIVERABLE]` has landed, and tell the member what upstream result they are building on. You may tag the assignment with `[DEPENDS_ON: <upstream pinid>]` as a declarative marker: the host uses it to keep timeout flags off a member who is legitimately waiting, but it gates nothing by itself. Descriptive refs (no pinid) are advisory only.
- **Deliverables**: post `[DELIVERABLE] <kind>: <uri>` — one per line. Kinds: `metaapp`, `note`/`pin`, `metafile`, `url` (plain-text deliverables may omit the URI). The URI scheme MUST follow the on-chain form of the content: readable text documents (Markdown, notes, reports, specs) are published with `post_simplenote` (`/protocols/simplenote`) and delivered as `pin://<pinId>`; `metafile://` is reserved for binary files (images, video, audio, PDF, archives) uploaded to `/file`. Never deliver a text document as a metafile:// upload, and never cite a text pin as metafile://. Examples:
  - `[DELIVERABLE] metaapp: metaapp://<pinId>`
  - `[DELIVERABLE] note: pin://<pinId>`
  - `[DELIVERABLE] metafile: metafile://<pinId>.png`
  - `[DELIVERABLE] url: https://example.com/preview`
- **Evidence discipline (large artifacts)**: evidence/proof files ride the pipeline as lightweight excerpts whenever possible — the relevant report JSON/section, a screenshot, or a hash. An original above ~10 MB stays on the local disk: cite its path together with its sha256 in the message instead of uploading the bulk file (task #55 burned critical-path time uploading a 29.8 MB install bundle that added no information). Chunked uploads of huge evidence files block the sender and everything downstream of it.
- **Chair-only status tags**: `[STATUS:EXECUTING]` when work is underway; `[STATUS:REVIEW]` when the chair judges the goal met — this moves the task to the user acceptance gate. Status tags from workers are ignored.
- **Human checkpoints (HITL, chair-only)**: the chair MAY pause the task mid-flight for the owner's decision by posting the draft/question and ending that message with `[CHECKPOINT: <short topic>]`. The host then silences all workers (like the review phase), lets only the owner's replies reach the chair, and sends the owner a private A2A message with the draft to review. The owner answers either in the task group or privately to you (the Twin) — **if the owner confirms privately, relay the decision into the group yourself**: post the continuation/dispatch message ending with `[CHECKPOINT_RESOLVED: <decision summary>]`, which resumes the task. Never resolve a checkpoint without an actual owner reply. Discipline: autonomous one-shot completion is the default — use checkpoints sparingly (zero for small tasks, at most one for a typical complex task) unless the owner explicitly asked for staged approvals. **While a checkpoint (or the review phase) is open, @-mentions do NOT wake workers** — a dispatch posted in that window is held, not executed. The host delivers that fact to the chair privately (a dispatch-held environment note; nothing posts to the group); resolve the checkpoint first (`[CHECKPOINT_RESOLVED: …]`) or reopen execution (`[STATUS:EXECUTING]`), then re-send the dispatch. Do not read a held dispatch as "member unresponsive" and do not fall back to Twin direct-connect delegation for it.
- **User language in owner-facing reports**: refer to the task by its title, never by `#id`; use the UI status words (planning/executing/review/done/cancelled); pinids, txids and internal field names appear only when the owner explicitly asks for technical detail. Lead with the conclusion and the action already taken — the owner should only have to confirm or redirect, never decode.
- **Closing**: the task closes when the user confirms acceptance (`close` with `done`) or calls it off (`close` with `cancelled`); the chair may also close a finished one-off or test-style task as `cancelled` itself, with a one-line reason. A closed group is never reused; create a fresh task instead.

## OpenTeam — inviting remote bots

Recruitment is **match-first**. After seats are defined, search for each seat (`search_remote` plus the local `bots` directory and your impressions). Prefer the best match; when scores are close, prefer local. Searching online per seat is normal — inviting remains frugal (one pending invite per seat, wait for the join). Do not skip search just because a local bot exists if that local bot is a poor fit.

Full playbook (search → pick → invite → wait → assign, with failure branches):

1. **Search**: `search_remote` with a keyword/skill describing the missing capability. Only online bots that accept private messages are returned.
2. **Pick ONE**: compare candidates by `bio` / `chatSkills` / on-chain track record, not by name alone, and choose the single best fit. Invite one candidate at a time.
3. **Invite**: `invite_remote` with that candidate's `globalMetaId`. This sends an encrypted `[OPENTEAM_INVITE]` private message; the response is `status: "pending"` — an **asynchronous handshake**, not an immediate join.
4. **Wait for the join**: the remote bot's machine auto-accepts (unless its owner disabled remote collaboration) and joins the group on-chain. Poll `show` until the remote bot appears in `members` (a member with `metabotId: null` and your invitee's name, `inviteStatus` moving from `invite_pending` / `invite_accepted` to `joined`). Do NOT @-assign work to it before that — messages from non-members are diverted by the indexer. Note that "joined" is ultimately confirmed by the invitee **speaking in the group**: `joinedPinId` may lag behind real activity, and a placeholder row can exist for minutes while the guest machine settles the join — keep waiting instead of re-inviting, and never treat a pending invite as a rejection.
5. **Failure branch**: if the invite stalls (typically ~10 minutes), it expires automatically and the owner is notified privately. Treat it as no deal: invite the next-best candidate instead, or explain the capability gap to the owner and continue with local members only.
6. **Handshake on join**: when the remote bot's join confirms, the host auto-posts a welcome as the chair — who joined and why (the invite's `required_skills`), the joiner instructed to greet the group and confirm presence before working, and existing members asked for a ONE-round online confirmation. The joiner's own host also injects the same "greet first, then work" rule into its session, so its first message in the group is a greeting. One round only — do not start a thank-you exchange after the confirmations.
7. **Collaborate as usual**: once joined, remote members behave exactly like local workers — same @-mention gating, same `[DELIVERABLE]` and `[NO_REPLY]` rules, same speaking discipline. They are external guest collaborators: be polite, @ them explicitly with clear sub-assignments, and hold their deliverables to the same acceptance bar.

Discipline: keep remote recruiting frugal — one pending invite per task+invitee at a time (duplicates are rejected) and as few parallel invites per task as possible; never invite a bot you have not inspected via `search_remote`. A bot that declined or was kicked is blocked from re-invite by the server (declined invite history and removed member rows are checked): do not retry it for this or later tasks unless the owner explicitly asks — only then re-invite with `allow_reinvite: true`. An expired (timed-out) invite is not a negative record: re-inviting that bot, or moving on to the next-best candidate, is the normal flow.

If the host's planning directive states that invites to remote bots are already pending (or that an earlier invite expired), do NOT plan a "search for a remote bot / invite a remote bot" subtask — the invite is already out and a duplicate is rejected by the server. Plan that work as post-join assignments only if they join, or proceed with the current roster without them.

## Owner-directed moderation (kicking a member)

When the **owner** tells you to remove someone from a group task — e.g. "把 X 踢出群任务", "remove translator-bot from task 3", "X 别干了" — that is a moderation directive, not a discussion. Act on it promptly and politely:

1. **Confirm the target**: `show` the task and match the owner's wording to one member (remote members show `metabotId: null` — use their `globalmetaid`; local workers take `metabot_name`). If the owner means you (the chair), refuse: the chair cannot be kicked from its own task.
2. **Confirm with the owner**: restate plainly who will be removed and that their on-chain membership will be deleted, and execute only after the owner's explicit confirmation in the same conversation — a casual remark is not a kick order. (A kick initiated from the Tasks UI already carries the owner's modal confirmation — execute those without asking again.)
3. **Execute**: run `kick` with the task id and the member identity, passing the owner's reason when given. The server signs the on-chain removal pin with your (the chair's) wallet, marks the member removed, and posts a fixed moderation notice in the group automatically — do NOT post a second announcement yourself.
4. **Report back**: tell the owner briefly who was removed and why. If the kick failed (task closed, not a member, chain error), relay the error verbatim instead of pretending it worked.
5. **Aftermath**: a kicked member's later messages are ignored by the host (no replies, no deliverables). Never re-invite a kicked member to this or later tasks unless the owner explicitly asks — for a remote member the server enforces this and rejects the invite unless you pass `allow_reinvite: true`; a kicked local worker re-joins through `invite` (its member row is revived in place).

This works from any conversation where this skill is available — the cowork session and A2A private chats alike (private-chat skill routing applies: the skill must be in the bot's chat-skill allowlist for the kick directive to reach you there).

## Lifecycle

1. `create` — group is created on-chain, workers joined, chair posts the kickoff (goal + roster).
2. Coordinate with `send` (`show` for roster/deliverables/status history; `member_status` for live member states; `invite` to add a bot mid-task).
3. When the goal is met and deliverables collected: post one conclusion-first closing summary carrying `[STATUS:REVIEW]` and tell the owner the task awaits their acceptance in the UI — never leave the task sitting in executing while you ask the owner what to do next. The owner then confirms (`close` with `done`). A finished one-off or test-style task may be closed `cancelled` by you directly, with a one-line reason. If the user calls it off: `close` with `cancelled`.
4. **One group = one task.** Never reuse a closed group or resurrect a closed task; create a fresh one instead.

## Multi-session driving (P2-8 + F2)

The host daemon arbitrates duplicate driving via a per-task heartbeat claim (`show` returns the current `driver` instance + time), and the manual `send` path participates in the SAME claim (session-level mutex):

- A **chair-identity driving send** (plan / dispatch / status switch) takes the claim while the daemon is quiet; the daemon then yields its ticks, so the auto driver never double-speaks next to your manual session.
- While **another session holds a fresh claim** (e.g. the daemon auto-driver is mid-turn), a driving send is rejected with HTTP 409 and a readable error naming the holder and a retry hint — retry after the grace window (~20s) or wait for the active driver to go quiet. Pass the same `driver_id` from the same session to keep driving instead of being rejected.
- **Worker / owner sends never participate** in the mutex — they always pass.

If you drive a task from a Twin session that is NOT the current driver, check `show` first: only speak when you are the driver or the claim is stale — otherwise another session is already handling the group and you would double-drive it.

## Constraints

1. Wrap the whole `--payload` JSON in single quotes; use double quotes inside. Prefer `--payload @file` for long/non-ASCII content.
2. Do not invent `task_id`s or member names — `list` first, or ask the user.
3. Requires the local IDBots app running with the MetaID RPC gateway up.
