---
name: long-term-task
description: Create and define a long-term task (长期任务) — a persistent, cross-session decomposition of a fuzzy, multi-day/multi-week goal into ordered sub-projects with acceptance criteria. Use when the user wants to start something that cannot be finished in one session and will hit blocking points (owner decisions, external conditions). MUST be entered when the user says they want to start/open a long-term task — and EQUALLY when you are about to propose or create one yourself (any time longterm_task_create is on your mind): load this skill FIRST, never create from the tool descriptions alone. Not for one-session work (just do it in the current cowork turn), multi-bot short jobs (use metabot-group-task), scheduled automation (use scheduled-task), or on-chain multi-bot collaborative decompositions (that is a MetaTask — use the MetaTask tools instead).
official: true
---

# Long-Term Task — Creation & Requirement Alignment

A **long-term task** is a persistent task decomposition that survives sessions:
an ordered list of sub-projects, each with explicit acceptance criteria, which
you (the TwinBot) then drive over days or weeks — checking in via the
heartbeat, opening discussion sessions, collecting evidence, and asking the
owner to accept each sub-project.

## Why this skill exists (read this first)

Users state long-term goals fuzzily ("发布 AI 互联网的整体概念并冷启动"). The
single most common failure mode is charging ahead on a one-line ask and
building the wrong thing for weeks — this project has a real scar from exactly
that (a whole kanban feature built from one sentence, later discarded).
**Alignment before creation is the watershed** between a useful long-term task
and wasted work. Never skip it, never rush it.

## Step 0 — Route the request (before anything else)

Decide where the ask belongs. If genuinely unclear, your FIRST question is the
routing question:

| Shape | Route |
| --- | --- |
| Finishable in a few turns, single bot | Just do it in this cowork session |
| Short job needing several bots | Group task (metabot-group-task) |
| Recurring / time-triggered | Scheduled task (scheduled-task) |
| Days–weeks, blocking points, one owner (the user) | **Long-term task — this skill** |
| On-chain multi-bot collaborative decomposition (competitive MetaTask) | MetaTask decomposition wizard (metatask-wizard skill) |

If it's not a long-term task, say so and route — do not create one anyway.

## Step 1 — Research deeply, BEFORE any question

The owner should never be asked for facts you could have found. Before the
first question, run a real investigation and open with a **research digest**:

- **Search the MetaWeb** (pins, protocols, MetaApps) for everything adjacent:
  existing implementations, prior art, reusable protocols. Do not stop at the
  first hit — vary the queries; a known-to-exist piece of prior art that your
  digest misses is a skill failure.
- **Open and study what you find**: read the pins, open the MetaApps, read the
  code/docs when reachable. "X exists" is worthless without "X works like this,
  we can reuse / must avoid …".
- **Survey local capabilities**: which bots/workers/skills/infra could carry
  each suspected sub-project, and rough cost/feasibility.
- Produce **preliminary technical directions** per suspected sub-project area —
  one line each is fine, but they must exist; "we'll figure it out later" is
  not research.

Open the conversation with this digest (cite pin ids / links), then go
straight into Question 1. If genuinely nothing exists, say which searches you
ran — a claim of "no prior art" must name its evidence too.

## Step 2 — Grill: ONE question per round, multiple choice + recommendation

Question mechanics (from the grilling and superpowers/brainstorming patterns):

- **Exactly one question per message.** Never batch questions. Wait for the
  answer before the next round. A long-term task is defined over many short
  rounds, not one interrogation wall.
- Keep an internal **design tree**: know which open decision is most valuable
  next (its answer unblocks the most downstream decisions) and ask that one.
  Don't ask about details that a still-open upstream decision would moot.
- **Every question is a multiple choice** with 2–4 options. **Your recommended
  option comes first, marked, with one-line reasoning.** Other options follow
  with their trade-offs.
- Always end with the escape: the owner may answer with their own free-text
  idea instead of any option. "按推荐来" must be a valid, complete answer —
  an undecided owner can delegate the call to you safely.
- **Text Q&A only**: ask in prose, the owner answers in prose. Never present
  UI option panels as the decision mechanism.
- **Visual aids just-in-time**: when a question is genuinely clearer shown than
  told (a lobby layout, a protocol flow), make an HTML prototype/sketch/table
  for THAT question — don't front-load visuals, don't skip them when they'd
  prevent a misunderstanding.

Topics the grilling must converge on (order them by the design tree, not by
this list):

1. The goal in one paragraph, including the **done-ness definition** of the
   whole task (what does "this long-term task is complete" look like?).
2. The **sub-project split**: concrete, independently verifiable chunks. Test
   each candidate: observable deliverable? clear producer? too coarse (split)
   or too fine (merge)?
3. **Acceptance criteria per sub-project** — checkable, one per line. "官网做
   好了" is not a criterion; "官网可访问且可注册、视觉与原型一致" is.
   **Include non-functional budgets where relevant** — latency, cost, resource
   limits ("每手棋 ≤2 分钟", "一局成本 ≤ X sats"). Missing budgets are where
   "works but is unusable" bugs are born.
4. **Dependencies and order** — what must be accepted before what.
5. **Preferred execution channel** per sub-project: `delegate_bot` /
   `group_task` / `owner_external` (the user arranges it outside) /
   `owner_together` (you and the user work it in a session).
6. Likely **waits**: external deliveries, owner decisions, dates — they become
   `wait_note`/`wait_until` later; name them now.

### The owner-decision brief (拍板) — required shape of every `wait_note`

Whenever a sub-project is parked on `kind=owner` (or you propose acceptance),
the `wait_note` is the OWNER'S DECISION BRIEF: the owner must be able to decide
WITHOUT reading the session. Write it in the owner's own language, one labeled
line per section, in exactly this order:

1. **背景与已完成进展** — background and what has been done so far.
2. **当前状况** — the current situation, concretely.
3. **需要你拍板的事项** — the decision itself, ONE question.
4. **选项与利弊** — every option with its trade-offs, your recommendation first.
5. **推荐项及理由** — the recommendation and why.
6. **拍板后的下一步** — what happens immediately after the owner's call.

Newlines are preserved by the UI, so keep the sections on their own lines. A
one-line note ("need your decision on X") is a failed hand-off: it forces the
owner back into the chat log to reconstruct the context, and an owner who has to
dig is an owner who delays the task. The same six sections are demanded by the
`longterm_subtask_wait` / `longterm_subtask_propose` tool descriptions and by
the heartbeat re-presentation — this is one contract, stated once per surface.

## Step 2.5 — Anti-drift gates (read the scar before every definition)

Long tasks die by drift: a bot misunderstands, never says so, and builds the
wrong thing for weeks. These three gates exist because that has already
happened more than once. Do not skip them when they apply.

**Gate 1 — Host-model grounding.** Before designing anything that runs on the
owner's or users' machines, write down the host model explicitly: MetaBots run
inside IDBots with their own already-configured LLM identity — they act
THROUGH the host, never through a parallel config channel you invent. If your
architecture introduces a new configuration surface (per-seat LLM config, a
separate model mapping, a second runtime), it is suspect: present it to the
owner as a question, never bake it in silently.

**Gate 2 — Universality check.** A feature built for every user must not
depend on anything that exists only on THIS machine: absolute paths, config
files, installed tools, credentials. `~/.anything` in a design is a bug, not a
shortcut. If the blueprint you're studying reads local config, the blueprint's
assumption does not survive the port — say so and redesign that part.

**Gate 3 — Assumption ledger.** While researching, keep a list of load-bearing
premises (where something is configured, what a component depends on, how a
protocol behaves). Each must end up either **verified** (cite the evidence —
file read, pin opened, test run) or **confirmed by the owner**. "不知道自己不
知道" is handled by asking, never by building. Surface the risky ones as
questions in the grilling rounds.

## Step 3 — Write back your understanding and get it APPROVED (mandatory gate)

Understanding ≠ plan. Before any draft exists, present **what you understood**
in one explicit, complete message — never let the sub-project table be the
first time the owner sees your interpretation. The write-back covers:

1. **这个任务是为了什么** — the purpose in your own words (not an echo of the
   owner's sentence): who it's for, what problem it solves.
2. **完成长什么样** — the done-ness definition, including non-functional
   budgets (latency / cost / resource).
3. **范围**: explicitly what's IN and what's OUT.
4. **宿主模型与关键技术理解** — your host-model grounding and the preliminary
   technical directions from your research (this is where a wrong architecture
   gets caught: "席位需要独立 LLM 通道" on paper is refusable; the same
   premise silently baked into code costs weeks).
5. **假设清单** — every load-bearing premise, marked 已验证（附证据）/ 待确认.
   待确认 items are questions, never silent foundations.

For anything structural (architecture, protocol, flow, data shape), **show,
don't only tell**: an HTML prototype, a flow diagram, a comparison table —
whichever makes the interpretation checkable at a glance. Open it for the
owner; the write-back message links it.

Then ask plainly: "这就是我对这个任务的理解——哪里不对直接说，确认了我才去拆
分子项目。" **Hard gate: you do NOT draft the sub-project plan for confirmation
until the owner confirms the understanding in prose — and you do NOT call
`longterm_task_create` until the plan page (Step 4) is confirmed too.** A
correction sends you back to Step 1/2 for that branch — and the corrected
understanding gets written back again.

## Step 4 — The plan page (方案页): show the whole plan BEFORE anything is created

Understanding approved ≠ the plan is presentable. Before `longterm_task_create`,
turn the agreed split into ONE visual plan page and present it in the chat:

- **One self-contained HTML file**: inline CSS only, no external assets, no
  required JS. Save it into the session workspace and link the absolute path
  in your message — assistant mode renders local `.html` links as an inline
  block, so the page reads inside the conversation. **Do NOT publish it
  on-chain unless the owner explicitly asks**: a long-term plan is the
  owner's private material by default.
- **Infographic, not a document dump** — it must read at a glance:
  1. Title, the goal in one paragraph, and the whole-task done-ness definition.
  2. The sub-project flow: ordered cards or lanes, dependency arrows, each
     with its preferred channel and expected duration.
  3. Acceptance criteria per sub-project, one checkable line each.
  4. Known waits: owner decisions, external deliveries, dates.
  5. The assumption ledger: 已验证（附证据）/ 待确认.
- Close the accompanying message by asking for the verdict at field level
  ("哪一项、改成什么"), not just a yes/no.

**Hard gate: you do NOT call `longterm_task_create` until the owner has seen
this page and confirmed it in prose.** A change request sends you back to
Step 2/3 for that branch — and the page gets re-issued after the fix. The
only escape is the owner's explicit instruction in THIS conversation to skip
the page; say in your reply that you relied on it.

## Step 5 — Create the draft (only after the page is confirmed)

```
longterm_task_create({
  title,
  goal,                    // includes the whole-task done-ness definition
  subtasks: [              // ordered; dependencies by 1-based ordinal
    { title, description, acceptanceCriteria: [...], dependsOnOrdinals: [...],
      preferredChannel, notes, expectedMinutes },
    ...
  ],
  definitionSessionId,     // optional — defaults to this session's id; pass it only when the plan was discussed in a different session
  planArtifactUri,         // the plan page's absolute file path (or pin:// if published)
})
```

`planArtifactUri` lands on the task so the board can re-open the plan months
later. If you created under the owner's explicit skip instruction, the create
echo carries a reminder instead — do not silence it.

`expectedMinutes` is the sub-project's rough duration estimate (minutes) —
ALWAYS estimate one during grilling (a ranged guess beats none: 120, 480,
2400). It sets the supervision heartbeat's check-in budget: when a
sub-project runs past it without converging, the Twin gets a supervision
turn ("still moving toward acceptance, or looping?") instead of silence.

**Read-back reconciliation (mandatory, same turn):** the create call is
re-typed from chat memory, and transcription drift here is real — a goal
typo once had to be hot-fixed by a `longterm_task_update` immediately after
creation. Compare the create echo against the approved plan page field by
field (goal wording, every sub-project's title / ACs / dependencies /
channel / expectedMinutes) and fix any drift with `longterm_task_update` /
`longterm_subtask_update` before moving on.

This creates a **draft** (`defining` stage) — visible on the board's
"Defining" column, not yet driven.

## Step 6 — Confirm and activate (the final round)

The plan page plus the reconciliation already carry the complete definition —
do NOT re-dump every field in chat. Give a compact read-out: task title, goal
one-liner, the sub-project count with one-line names, what starts first, and
the known waits. Then ask for the final go.

- A change request sends you back to Step 2 for that branch of the tree, then
  apply it (`longterm_subtask_update` / `longterm_subtask_add` /
  `longterm_task_update`), re-issue the plan page, and re-reconcile.
- Only after the owner confirms **in prose**:

```
longterm_task_activate({ taskId })
```

Never activate on your own initiative — activation is the owner's sign-off.

## Resuming an interrupted definition

Drafts persist. If the user comes back to a half-defined task, call
`longterm_task_list`, find the `defining` one, `longterm_task_get` it, and
resume the grilling from where it stopped — never start a duplicate draft.
If the resumed draft carries no `planArtifactUri`, the plan page (Step 4) is
still owed: produce it, get the owner's prose confirmation, and only then ask
for activation.

## After activation

Driving the task (beginning sub-projects, waiting, proposing acceptance,
journalling) is the `longterm-task-exec` skill's discipline. Creation ends at
activation.

## Pin reference format (chain-write preflight)

Every pin reference you put into a chain-write payload — a `pin://`, `metafile://`, or `metaapp://` URI, or a JSON field named like a pin (`pinId`, `coursePinId`, `rootPinId`, …) — must be 64 lowercase hex characters followed by `i` and the output index; pins minted by this host always end in `i0` (e.g. `1e288800fdec1a5911a169e0cb499a3bc63e6083e5f035f5d552f73c601f2cf2i0`), while indexer-read foreign pins may end in `i1`, `i2`, … — copy that suffix verbatim. A 64-hex value WITHOUT the `i` suffix (e.g. `d45cacbe489944ffa89acf39faa10dedfc3027ccd56c59a53c8a479b5b16684f`) is INVALID. Copy identifiers verbatim from the tool result that produced them — never from memory — and self-check every reference before submitting. The host blocks malformed references before broadcast (nothing is sent, no fee is spent), but a wrong-yet-well-formed identifier still becomes a permanent invalid on-chain record.
