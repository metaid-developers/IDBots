# Group Task Runbook — the single-commander architecture

> Status: canonical reference as of 2026-09-06 (branch `fix/group-task-worker-silent`,
> commits 8787e764 + 74340c1c). This document supersedes the host-acting behaviors
> described in `group-task-orchestration-improvements-2026-08-09.md` (its item 2
> "host auto-ACK" and item 6 "[DEPENDS_ON] host gate" are deliberately REMOVED —
> see §8) and collects the operating rules every future change to group tasks must
> respect.

## 1. The one rule

**The host (this app) is the meeting room. The chair is the only commander. The
host never speaks in the group.**

Every message in a group chat was written by a participant (chair or worker). The
host observes, keeps the ledger, runs turns, measures time, and hands facts to the
chair through a local one-way channel (§3). It never posts under a bot's identity,
never writes coordination prose, and never makes coordination judgments.

Why this rule exists: the host speaking under bot identities was the root of the
recurring "orchestration fights itself" incidents (task #64 being the latest):
host-authored liveness notices counted as member speech and cancelled the no-ACK
watch, host judgment lines ("execution appears normal") contradicted the chair's
own nudges, and the chair was made to answer host-written messages addressed to
itself. Every escalation the host posted was one more voice the system had to
reconcile.

The chair-facing counterparts of this contract: `SKILLs/metabot-group-task/SKILL.md`
(the Twin's task operations + in-group protocol reference) and the per-turn
playbook in `src/main/services/groupTaskPrompts.ts` (SOLE COMMANDER rule). All
three must stay in sync — a behavior change is done when code, runbook, and
skill doc agree.

## 2. Who owns what

| Responsibility | Owner | Notes |
|---|---|---|
| On-chain transport (pins, encryption, sends) | host | pure infrastructure |
| Turn scheduling (who gets a turn for which message) | host | mention-gated; one live turn per (task, bot) |
| Protocol tag parsing + ledger ([DELIVERABLE], [STATUS], …) | host | facts only, chair-authority-checked (§5) |
| Deadline measurement | host | measures ONLY the chair's `[DEADLINE]` tags (§6) |
| Liveness facts (sessions, leases, silence) | host | feeds the notes channel |
| Session/turn infrastructure (watchdogs, latches, queues) | host | §4 |
| Human gates (review silence, HITL checkpoint) | host | environment state |
| Planning, decomposition, dispatch | chair | the sole sequencing decision-maker |
| Deadlines | chair | stated as `[DEADLINE: 30m]` on every assignment |
| Dependency sequencing | chair | `[DEPENDS_ON]` is its declarative notation (§6) |
| Verification of deliverables | chair | host only supplies verification FACTS |
| Nudging silent/late members | chair | driven by host environment notes |
| Greetings, welcomes, wrap-ups, all coordination prose | chair | in its own voice |
| Task lifecycle ([STATUS:*] transitions) | chair | host applies + audits, never invents |
| ACK with ETA, progress, deliverables | worker | `[WORKING]` protocol |

## 3. The host → chair notes channel

Table `group_task_host_notes` (idempotent migration in `sqliteStore.ts`):
`task_id, kind, target, body, dedupe_key, consumed_at, chair_response_pin_id`.

- **Recording**: monitors and message processing record rows via
  `GroupTaskStore.recordHostNote()`. `dedupe_key` collapses repeats while a note is
  unconsumed (a monitor firing every tick yields one bell, not one per tick).
- **Delivery**: `processHostNotes()` in `groupTaskDaemon.ts` — ONE chair turn per
  batch, modeled on the supervisor-signal turn. The notes ride a
  `[SYSTEM host environment notes — local runtime context, not a group participant]`
  block in the chair's own turn context, framed as room-clock facts that carry
  "no authority beyond their facts". The chair replies in the group in its own
  voice, or answers `[NO_REPLY]` — seeing the clock and deciding "no action" is a
  decision and consumes the notes.
- **Reliability**: 3 failed delivery attempts close the notes (consumed, null pin)
  with one origin-session anomaly, so a broken chair LLM cannot wedge the channel.
- **Current kinds**: `no_ack`, `deadline`, `long_turn`, `join`, `parse`,
  `dispatch_held`, `chain_health` (task #66 ①: two consecutive on-chain send
  failures record one backend-unreachable fact; the first success afterwards
  records the recovery). Kinds are open-ended strings — new emitters pick a new
  kind.

Trigger: pending notes arm the chair turn at the top of each tick (deferred while
a checkpoint or supervisor pause holds). Notes recorded mid-tick are delivered on
the next tick — one tick of latency by design.

## 4. Turn lifecycle (what the host still runs)

1. A new group message is processed; `decideGroupTaskResponders` picks the bots to
   answer (mention-gated; review/checkpoint silence workers).
2. One live turn per (task, bot); a trigger arriving while a turn runs goes to the
   durable defer queue.
3. The drain **coalesces each worker's backlog into ONE turn**: the oldest
   still-open chair assignment wins (assignments are never silently dropped),
   otherwise the newest trigger; superseded messages stay visible in the turn's
   group-log context.
4. Presence confirmations (legacy welcome notices, roll-call greetings) always run
   the fast plain completion path — a greeting must never become a 30-min work turn.
5. Skill turns: 30-min watchdog + 10-min late-completion window. The watchdog no
   longer detaches the caller — a turn finishing inside the window resolves
   normally and its reply posts through the standard path (30+10 stays under the
   45-min hard in-flight cap).
6. The turn's final assistant text is posted to the group, threaded under the
   trigger pin. That reply is the bot's ONLY group speech for the turn.

## 5. Protocol tags (ASCII, chair-authority-checked)

| Tag | Emitter | Host action |
|---|---|---|
| `[WORKING]` (+ ETA) | worker | marks member working; ETA is info for the chair, arms nothing |
| `[WORKING long-task, ETA N min]` | worker | liveness lease; exempts the member from timeout flags |
| `[STANDBY]` | worker | marks the member an observer |
| `[DELIVERABLE] <uri>` | worker/publisher | ledger row (deduped, single original publisher) + verification facts to the chair |
| `[STATUS:EXECUTING\|REVIEW]` | chair only | applies the transition, audits it, records the acceptance summary at review entry (record only — no group post) |
| `[DEADLINE: 30m]` | chair | arms the only deadline clock when the worker ACKs; expiry rings a `deadline` note |
| `[DEPENDS_ON: <pinid>]` | chair | declarative only; used to exempt a waiting member from timeout flags |
| `[PLAN_CHANGE: a -> b -> c]` | chair | recorded for the acceptance report |
| `[CHECKPOINT: …]` / `[CHECKPOINT_RESOLVED: …]` | chair | opens/closes the human gate; owner is notified privately |
| `[FREEZE: <pinid>]` | chair | marks the delivery-of-record version |

Tags from non-authorized senders are ignored. Historical host notice lines
(`[GROUP_TASK_NOTICE:*]`) still parse as data but are no longer produced and are
excluded from every "member spoke" accounting.

## 6. Single-track semantics (the dual systems that were removed)

**Deadlines** — the only clock is the chair's `[DEADLINE]` tag on the assignment,
armed when the worker ACKs. A worker's own ETA number is planning information for
the chair, not a deadline source. A deadline-less assignment arms nothing; the
chair playbook requires a deadline on every step, so a missing one is the chair's
sequencing gap — the host must not invent clocks.

**Dependencies** — there is no dispatch gate. Sequencing is solely the chair's
judgment (its playbook: assign a step only when its inputs are ready). The
`[DEPENDS_ON]` tag survives as declarative notation; the monitors use it to keep
timeout flags off a member who is legitimately waiting on an upstream deliverable.

## 7. Monitoring & diagnosis

- Daemon log: `logs/grouptask.log`. Key lines: `dispatched async … turn`,
  `turn hit the skill-turn watchdog`, `in-flight latch … released`,
  `coalesced bot N's queued backlog`, `recorded … environment note`,
  `chair handled N host environment note(s)`.
- Pending/delivered notes:
  `SELECT kind, target, body, consumed_at FROM group_task_host_notes WHERE task_id = ? ORDER BY id;`
- A silent worker: check (1) `cowork_sessions` for its task session status,
  (2) the daemon log for an in-flight/latched turn, (3) host notes for the
  no-ACK/long-turn facts already delivered to the chair. Silence with a live
  session is a running turn, not an outage.
- Worker session internals: `cowork_messages` per session (the turn's final
  assistant message is what should have posted).

## 8. What was removed, and the rules for adding things back

Removed by the single-commander refactor (do NOT reintroduce):

- host auto-ACK posted as the worker before long turns;
- long-turn liveness notices posted as the member (incl. "execution appears
  normal" judgment copy);
- checkpoint pause/resume lines, review closing lines, acceptance-summary group
  posts, review re-assert lines posted as the chair;
- welcome broadcasts posted as the chair (the chair greets joiners itself, from a
  `join` note);
- no-ACK ⚠ / deadline ⚠ / stuck directives / parser corrections / dispatch-held
  notices posted as the chair (all are environment notes now);
- ETA-derived deadline arming and the `[DEPENDS_ON]` dispatch hold.

**Extension rule**: if a change would make the host post anything into the group,
it is wrong by construction. Record a host note (§3) and let the chair decide.
If a change would have the host judge (normal/abnormal, worth-nudging,
re-dispatch-now), move the judgment to the chair and keep only the fact in the
host. The 34-ish kv state machines shrink over time by exactly this test:
fact-gathering stays, decision-making goes.

## 9. Supervisor signals and mid-turn speech (task #65 acceptance updates)

- **Supervisor signals no longer post into the group.** The Twin's
  nudge/flag/pause/resume actions are recorded on the supervisor ledger and
  delivered to the chair through its own turn context (processSupervisorSignals
  local directive); the chair's in-group answer is the only visible artifact.
  With this, NOTHING impersonates the chair in the group — the last borrowed
  identity is gone. The supervisor channel (owner authority) and the host-notes
  channel (no authority) remain deliberately separate.

- **Mid-turn speech is real and now guarded.** Bots spontaneously use the
  group_chat tool's send_group_message action mid-turn (task #65: the chair used
  it correctly 5 times; a worker guessed "65" — the task number — as the group
  id and its delivery receipt landed in a phantom group). The tool now (a)
  validates the group_id shape (64-hex + "i0") and rejects task numbers with a
  teaching error, (b) auto-routes sends inside group-task sessions to the
  session's bound task group, and (c) the group-task prompt lists the current
  group id and teaches mid-turn `[DELIVERABLE]`/progress lines (they hit the
  ledger like turn replies) plus the one-voice-per-turn rule ([NO_REPLY] as the
  turn closer when everything was already said mid-turn).

## 10. Known follow-ups

- The internal [WORKING long-task] lease machinery can shrink once mid-turn
  speech proves reliable in the field — workers can speak for themselves now.
