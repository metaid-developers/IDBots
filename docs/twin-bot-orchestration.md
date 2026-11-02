# Twin Bot Orchestration Architecture

## Status

This document defines the implementation contract for the first two Twin Bot orchestration releases. It turns the current Group Task prototype into a reusable, local-first orchestration system without conflating persistent Worker Bots with ephemeral subagents.

## Product Model

- One human owner has one Twin Bot. The current desktop application has one active owner, so the existing machine-wide Twin invariant remains the compatibility rule for the first release. All new authorization and task records must also bind the Twin to its owner GlobalMetaID so the model can become owner-scoped later without rewriting the orchestration boundary.
- The Twin Bot is the owner's persistent digital twin, private assistant, and chief of staff. It understands ambiguous owner intent, turns it into executable work, chooses appropriate workers, supervises progress, verifies results, and reports back.
- A Worker Bot is a persistent specialist with its own identity, persona, memories, history, wallet, skills, workspace, and permissions. A Worker is not a subagent.
- A subagent is an ephemeral execution tool created inside a Worker or Twin Cowork run. It has no independent long-term identity and is not registered in the Worker directory.
- Group Task is an observable collaboration adapter and acceptance harness. It is not the core orchestration engine.

## Behavioral Contract

The Twin should handle conversation, clarification, planning, verification, and reporting itself. It should prefer delegation for multi-step or specialist execution. It may directly complete a trivial task when delegation would add no value.

For a complex owner wish, the Twin must:

1. Retrieve the complete local Worker capability directory.
2. Enrich the wish into a concrete goal, measurable acceptance criteria, and an ordered or dependency-aware set of steps.
3. Select workers with the LLM using capability evidence. Worker selection must not be hard-coded by task category.
4. Delegate each ready step to a task-specific Cowork session attributed to the selected Worker Bot.
5. Continue talking to the owner while delegated work runs asynchronously.
6. Verify structured results and deliverables before accepting them.
7. Rework, retry, or reassign failed work within bounded policy.
8. Report material progress and the final verified result to the owner.

Local Workers are preferred. Remote Bot or Skill Service fallback is a second-release capability and must preserve price, privacy, identity, and approval boundaries.

## Architecture Boundaries

### Twin policy overlay

Twin behavior is derived from the host-owned `metabot_type` and current Twin record, not from editable persona text. The overlay is injected consistently into standard Cowork, private A2A, IM, and other owner-facing Twin turns.

The overlay must not replace the Bot's persona. It adds the orchestration role and the following policies:

- Resolve non-material ambiguity with reasonable assumptions; ask only when a choice materially changes the result or requires new authority.
- Prefer suitable local Workers for specialist execution.
- Do not fabricate progress or completion.
- Keep private owner and Worker memory out of delegated prompts unless the task explicitly needs a bounded piece of context.
- Escalate payment, transfer, destructive, or otherwise high-risk authority.

### Worker capability directory

The directory returns all local Bots because the expected roster is small. Each entry is a sanitized planning read model:

- Bot id, name, type, enabled state, and owner binding.
- Role, bio, goal, persona summary, and enabled skills.
- Capability evidence derived from prior completed work and experience summaries.
- Availability and current orchestration workload.

Raw private conversations and raw memory rows are never returned. Capability evidence is a bounded summary of what the Worker has demonstrated, not a disclosure of what it knows about private contacts.

### Host authorization

Twin-only operations are registered as host tools only for a session attributed to the current Twin. Every service call revalidates the source session, source MetaBot id, current Twin id, enabled state, and owner binding. Prompt text, request payload fields, and `IDBOTS_METABOT_ID` alone are not authorization.

The first-release host tools are:

- `local_workers_list`
- `local_worker_delegate`
- `twin_task_status`
- `twin_task_reassign`
- `twin_task_cancel`

The existing loopback Group Task RPC remains a compatibility adapter. New Twin orchestration must not rely on unauthenticated loopback claims for authorization.

For the first acceptance pass, Group Task creation through the desktop IPC or loopback RPC exposes the complete enabled local Worker roster to the Twin chair automatically. The kickoff prompt includes each Worker's planning profile, while the Twin's planning turn decides which specialist receives each step. Callers that use the service directly may still provide an explicit member list for compatibility and deterministic tests.

### Durable orchestration state

The generic task model is transport-neutral:

- `orchestration_tasks` stores owner intent, enriched goal, acceptance criteria, source session, current Twin, owner identity, status, and plan version.
- `orchestration_steps` stores one work unit, dependencies, assignee, permission scope, deadline, status, accepted result, and active attempt.
- `orchestration_attempts` stores every execution attempt, Worker Cowork session, lifecycle timestamps, error, structured result, and idempotency key.

Group Task may reference an orchestration task and project status/messages into the on-chain group. It must not own the canonical execution state.

The local acceptance bridge implements this projection as follows:

- `group_tasks.orchestration_task_id` is an immutable one-to-one link created at Group Task creation and reconciled idempotently by the daemon.
- Group Task `planning`, `executing`, `review`, `done`, and `cancelled` project to canonical `planning`, `running`, `review`, `completed`, and `cancelled` respectively.
- A Group Task message that activates a Worker creates one canonical step and attempt keyed by the source message and Worker identity.
- A sent Worker handoff completes the attempt but leaves its step in `waiting_input` until the Twin and owner review the evidence.
- Deliverables are copied into canonical attempt evidence with host verification notes. Owner acceptance is recorded separately and never upgrades an unverified claim into deterministic proof.
- Only owner acceptance while the Group Task is in `review` completes waiting steps, accepts pending deliverables, and closes both task models. Cancellation cascades across active canonical steps and attempts.
- Projection failures after an on-chain send never cause the message to be resent. The daemon retries local reconciliation from durable evidence instead.

Task states are `planning`, `running`, `review`, `completed`, `failed`, and `cancelled`.

Step states are `blocked`, `ready`, `queued`, `running`, `waiting_input`, `completed`, `failed`, and `cancelled`.

Attempt states are `queued`, `running`, `completed`, `failed`, `timed_out`, and `cancelled`.

All schema changes must be safe, additive, and idempotent for existing user databases.

### Cross-session delivery outbox

`cowork_cross_session_deliveries` persists the wake obligation created by `insertCrossSessionMessageAndQueue`, independently of the message already stored in `cowork_messages`. The delivery is recorded before message insertion and uses the same id as the message, so recovery can adopt an already-written message instead of inserting a duplicate.

Delivery states are `pending`, `running`, `completed`, `failed`, and `cancelled`. A delivery also records its rendered message, attempt count, next retry time, last error, and creation, insertion, start, completion, and update timestamps. `failed` and `cancelled` are terminal audit states; a stopped target retains its message but cancels the wake obligation.

At startup, `running` deliveries return to `pending` while completed and terminal records remain untouched. Before any retry, the host reconciles the delivery id with the persisted message. Target-busy rules and per-target FIFO ordering remain in force. Retries use the stored rendered message and bounded exponential backoff; they do not regenerate content with another model call.

`getCrossSessionDeliveryReliabilitySnapshot` exposes the baseline metrics for this layer: state counts, retrying deliveries, total attempts, oldest pending age, and average and maximum completion latency. These metrics distinguish a persisted message from a continuation that actually started and finished.

The outbox provides durable, idempotent delivery of the wake obligation. It does not claim exactly-once semantics for tools chosen by the target model: external side effects still require their own idempotency and authorization boundaries.

### Worker Cowork execution

Each delegation attempt creates a new task-specific Cowork session attributed to the selected Worker `metabotId`. A fresh session avoids contaminating an unrelated historical conversation while preserving the Worker's persistent identity through persona, memory, experience, wallet, skills, and workspace attribution.

The Worker receives:

- The step objective and acceptance criteria.
- Required inputs and verified outputs from dependency steps.
- A minimal explanation of the parent task.
- A scoped permission grant derived from the owner's request.
- A required structured handoff containing summary, deliverables, verification evidence, and blockers.

The Worker may create subagents inside that Cowork session. Subagent activity remains an implementation detail of the Worker run.

Delegation is asynchronous. The host returns task, step, attempt, and session identifiers immediately, starts execution in the background, persists lifecycle events, and notifies the Twin when material state changes.

### Permission inheritance

Delegation never means unconditional `autoApprove`.

Permission scope is explicit and bounded by capability classes such as:

- Workspace read and write.
- Network read.
- Public on-chain publish.
- Private message send.
- Paid service or token spend.
- Destructive local action.

An explicit owner request may grant public publishing or named-recipient messaging for that task. Token transfers, additional paid services, destructive actions, and authority not present in the owner request require fresh confirmation. A Worker cannot broaden its own grant.

### Verification and reporting

Worker output is evidence, not proof. The host performs deterministic checks where possible, including file existence, URI shape, PinID format, on-chain Pin lookup, and expected session/tool completion. The Twin compares verified evidence with acceptance criteria.

The Twin may accept, request rework, or create a new attempt with a different Worker. Retries are bounded and use a new idempotency key while preserving prior attempt evidence.

The final owner report includes the plan, each Worker's contribution, deliverables, verification results, unresolved risks, and the decision requested from the owner.

## Release Plan

### Release 1: local orchestration

1. Centralize Twin policy overlay injection.
2. Add the sanitized Worker capability directory.
3. Add host-authorized Twin orchestration tools.
4. Add durable task, step, and attempt storage with safe migrations.
5. Create asynchronous Worker Cowork sessions with scoped permissions and structured handoffs.
6. Add result verification, bounded retry/reassignment, restart recovery, and owner progress events.
7. Connect Group Task as an optional visibility and acceptance adapter.

### Release 2: remote fallback

1. Add remote provider discovery behind the same step execution interface.
2. Rank local Workers before remote providers.
3. Preserve remote price, privacy, trust, and confirmation boundaries.
4. Add capability performance evidence such as verified success rate, latency, and failure categories.

## Acceptance Scenario

The reference scenario is an owner asking the Twin to create a MetaID knowledge-base MetaApp, publish it to a community, and notify relevant friends.

The first release is accepted only when:

1. The owner speaks only to the Twin and does not choose Workers manually.
2. The Twin retrieves all local Worker capability profiles and produces a measurable plan.
3. Development, review, publishing, and promotion work are assigned by profile fit rather than broadcast to every Worker.
4. Each Worker runs under its own persistent identity in a dedicated Cowork session and may use its own subagents.
5. The Twin remains responsive while work continues in the background.
6. Progress, timeout, failure, retry, and reassignment are durable and visible.
7. Deliverables are verified before the Twin marks the task ready for owner review.
8. The Twin sends a concise final report with evidence and asks for acceptance or rework.
9. A Worker attempting to invoke a Twin-only tool receives a host-level denial.
10. Restarting IDBots does not lose active task state or repeat completed external actions.
