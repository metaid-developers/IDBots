import type { Metabot } from '../types/metabot';
import {
  OrchestrationStore,
  type OrchestrationAttempt,
  type OrchestrationStep,
  type OrchestrationTask,
} from '../orchestrationStore';
import {
  GroupTaskStore,
  type GroupTask,
  type GroupTaskDeliverable,
  type GroupTaskDeliverableStatus,
  type GroupTaskStatusEventActor,
} from '../groupTaskStore';
import { recordDeliverableVerdictImpression } from './openTeamImpressionService';

export interface GroupTaskOrchestrationBridgeDeps {
  groupTaskStore: GroupTaskStore;
  orchestrationStore: OrchestrationStore;
  getMetabotById(id: number): Metabot | null;
}

export interface GroupTaskWorkerAttemptContext {
  task: OrchestrationTask;
  step: OrchestrationStep;
  attempt: OrchestrationAttempt;
  reused: boolean;
}

function sourceSessionId(groupTaskId: number): string {
  return `group-task:${groupTaskId}`;
}

function acceptanceCriteria(task: GroupTask): unknown[] {
  const text = task.acceptanceCriteria?.trim();
  return text ? [{ type: 'owner_defined', text }] : [];
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

export class GroupTaskOrchestrationBridge {
  constructor(private readonly deps: GroupTaskOrchestrationBridgeDeps) {}

  ensureCanonicalTask(taskOrId: GroupTask | number): OrchestrationTask {
    const groupTask = typeof taskOrId === 'number'
      ? this.deps.groupTaskStore.getTaskById(taskOrId)
      : taskOrId;
    if (!groupTask) throw new Error(`Group task ${taskOrId} not found`);

    if (groupTask.orchestrationTaskId) {
      const linked = this.deps.orchestrationStore.getTask(groupTask.orchestrationTaskId);
      if (!linked) {
        throw new Error(
          `Group task ${groupTask.id} references missing orchestration task ${groupTask.orchestrationTaskId}`,
        );
      }
      return linked;
    }

    const sourceId = sourceSessionId(groupTask.id);
    const existing = this.deps.orchestrationStore.getTaskBySourceSessionId(sourceId);
    if (existing) {
      this.deps.groupTaskStore.linkOrchestrationTask(groupTask.id, existing.id);
      return existing;
    }

    const twin = this.deps.getMetabotById(groupTask.chairMetabotId);
    if (!twin || twin.metabot_type !== 'twin' || !twin.enabled) {
      throw new Error(`Group task ${groupTask.id} chair is not the enabled local Twin Bot`);
    }
    const ownerGlobalMetaId = String(twin.boss_global_metaid ?? '').trim();
    if (!ownerGlobalMetaId) {
      throw new Error(`Group task ${groupTask.id} Twin has no owner GlobalMetaID binding`);
    }

    const canonical = this.deps.orchestrationStore.createTask({
      ownerIntent: groupTask.goal,
      enrichedGoal: groupTask.goal,
      acceptanceCriteria: acceptanceCriteria(groupTask),
      sourceSessionId: sourceId,
      twinMetabotId: twin.id,
      ownerGlobalMetaId,
    });
    this.deps.groupTaskStore.linkOrchestrationTask(groupTask.id, canonical.id);
    return canonical;
  }

  /**
   * Read-only working-state snapshot for the daemon's per-turn prompt block:
   * every step of the task's canonical orchestration card together with its
   * attempts. A group task with no canonical card yet returns [] — this is a
   * pure read and must never create the card (that is ensureCanonicalTask's
   * job on the write paths).
   */
  listStepsWithAttempts(groupTaskId: number): Array<{ step: OrchestrationStep; attempts: OrchestrationAttempt[] }> {
    const groupTask = this.deps.groupTaskStore.getTaskById(groupTaskId);
    if (!groupTask?.orchestrationTaskId) return [];
    return this.deps.orchestrationStore.listSteps(groupTask.orchestrationTaskId)
      .map((step) => ({ step, attempts: this.deps.orchestrationStore.listAttempts(step.id) }));
  }

  syncStatus(groupTaskId: number): OrchestrationTask {
    const groupTask = this.deps.groupTaskStore.getTaskById(groupTaskId);
    if (!groupTask) throw new Error(`Group task ${groupTaskId} not found`);
    let canonical = this.ensureCanonicalTask(groupTask);

    if (groupTask.status === 'cancelled') {
      return canonical.status === 'cancelled'
        ? canonical
        : this.deps.orchestrationStore.cancelTaskCascade(canonical.id);
    }
    if (groupTask.status === 'done') {
      return this.acceptGroupTask(groupTask.id).canonicalTask;
    }
    if (canonical.status === 'completed' || canonical.status === 'cancelled') return canonical;

    if (groupTask.status === 'executing' && canonical.status !== 'running') {
      canonical = this.deps.orchestrationStore.updateTaskStatus(canonical.id, 'running');
    } else if (groupTask.status === 'review' && canonical.status === 'running') {
      canonical = this.deps.orchestrationStore.updateTaskStatus(canonical.id, 'review');
    }
    return canonical;
  }

  beginWorkerAttempt(input: {
    groupTaskId: number;
    workerMetabotId: number;
    objective: string;
    sourceMessageKey: string;
  }): GroupTaskWorkerAttemptContext {
    const objective = input.objective.trim();
    if (!objective) throw new Error('Group Task Worker objective is required');
    const worker = this.deps.getMetabotById(input.workerMetabotId);
    if (!worker || worker.metabot_type !== 'worker' || !worker.enabled) {
      throw new Error(`MetaBot ${input.workerMetabotId} is not an enabled local Worker`);
    }
    let task = this.ensureCanonicalTask(input.groupTaskId);
    if (task.status === 'completed' || task.status === 'cancelled') {
      throw new Error(`Orchestration task ${task.id} is ${task.status}`);
    }
    if (task.status !== 'running') {
      task = this.deps.orchestrationStore.updateTaskStatus(task.id, 'running');
    }

    const idempotencyKey = [
      'group-task',
      input.groupTaskId,
      input.sourceMessageKey.trim(),
      'worker',
      worker.id,
    ].join(':');
    const existingAttempt = this.deps.orchestrationStore.getAttemptByIdempotencyKey(idempotencyKey);
    if (existingAttempt) {
      const existingStep = this.deps.orchestrationStore.getStep(existingAttempt.stepId);
      if (!existingStep || existingStep.taskId !== task.id) {
        throw new Error(`Orchestration evidence is inconsistent for attempt ${existingAttempt.id}`);
      }
      // Terminal attempt behind a re-driven trigger message: restart recovery
      // settles crashed attempts to failed and parks their step as ready with a
      // severed active-attempt link. Reusing that dead attempt left the step
      // stuck in ready forever — the worker could reply and deliver real work
      // while the ledger never advanced, and the orphan step then blocked owner
      // acceptance with no in-app remedy. Re-arm the step and open a fresh
      // attempt under a derived key (idempotency_key is UNIQUE).
      if (
        (existingAttempt.status === 'failed' || existingAttempt.status === 'cancelled')
        && existingStep.status === 'ready'
      ) {
        this.deps.orchestrationStore.updateStepStatus(existingStep.id, 'queued');
        let retryOrdinal = this.deps.orchestrationStore.listAttempts(existingStep.id).length;
        let retryKey = `${idempotencyKey}:retry:${retryOrdinal}`;
        while (this.deps.orchestrationStore.getAttemptByIdempotencyKey(retryKey)) {
          retryOrdinal += 1;
          retryKey = `${idempotencyKey}:retry:${retryOrdinal}`;
        }
        const attempt = this.deps.orchestrationStore.createAttempt({
          stepId: existingStep.id,
          idempotencyKey: retryKey,
          workerMetabotId: worker.id,
          prompt: objective,
        });
        return { task, step: this.deps.orchestrationStore.getStep(existingStep.id)!, attempt, reused: false };
      }
      return { task, step: existingStep, attempt: existingAttempt, reused: true };
    }

    const steps = this.deps.orchestrationStore.listSteps(task.id);
    const step = this.deps.orchestrationStore.createStep({
      taskId: task.id,
      ordinal: steps.length + 1,
      title: `Worker assignment: ${worker.name.trim() || `bot-${worker.id}`}`,
      objective,
      acceptanceCriteria: task.acceptanceCriteria,
      assigneeMetabotId: worker.id,
      permissionScope: {
        source: 'group_task',
        workspace: 'read_write',
        network: 'worker_skills_only',
        publicOnChain: 'task_scoped',
      },
      status: 'queued',
    });
    const attempt = this.deps.orchestrationStore.createAttempt({
      stepId: step.id,
      idempotencyKey,
      workerMetabotId: worker.id,
      prompt: objective,
    });
    return { task, step: this.deps.orchestrationStore.getStep(step.id)!, attempt, reused: false };
  }

  markWorkerAttemptRunning(attemptId: string, workerSessionId: string): OrchestrationAttempt {
    let attempt = this.deps.orchestrationStore.getAttempt(attemptId);
    if (!attempt) throw new Error(`Orchestration attempt ${attemptId} not found`);
    const step = this.deps.orchestrationStore.getStep(attempt.stepId);
    if (!step) throw new Error(`Orchestration step ${attempt.stepId} not found`);
    if (step.status === 'queued') {
      this.deps.orchestrationStore.updateStepStatus(step.id, 'running', { activeAttemptId: attempt.id });
    }
    if (attempt.status === 'queued') {
      attempt = this.deps.orchestrationStore.updateAttempt(attempt.id, 'running', { workerSessionId });
    }
    return attempt;
  }

  completeWorkerAttempt(input: {
    attemptId: string;
    replyText: string;
    groupMessagePinId: string;
  }): OrchestrationAttempt {
    let attempt = this.deps.orchestrationStore.getAttempt(input.attemptId);
    if (!attempt) throw new Error(`Orchestration attempt ${input.attemptId} not found`);
    let step = this.deps.orchestrationStore.getStep(attempt.stepId);
    if (!step) throw new Error(`Orchestration step ${attempt.stepId} not found`);
    if (attempt.status === 'queued') {
      attempt = this.deps.orchestrationStore.updateAttempt(attempt.id, 'running');
    }
    if (step.status === 'queued') {
      step = this.deps.orchestrationStore.updateStepStatus(step.id, 'running', { activeAttemptId: attempt.id });
    }
    if (attempt.status === 'running') {
      attempt = this.deps.orchestrationStore.updateAttempt(attempt.id, 'completed', {
        result: {
          replyText: input.replyText.trim(),
          groupMessagePinId: input.groupMessagePinId.trim(),
          verified: false,
          deliverables: [],
        },
      });
    }
    if (step.status === 'running') {
      this.deps.orchestrationStore.updateStepStatus(step.id, 'waiting_input', {
        activeAttemptId: attempt.id,
        acceptedResult: attempt.result,
      });
    }
    return attempt;
  }

  /**
   * fix/group-member-status: settle an attempt whose worker answered with the
   * [NO_REPLY] escape hatch. Deliberate silence is a legitimate protocol
   * answer, not a failure — recording it as 'failed' painted the member-rail
   * "出错" badge for the whole error window even though the bot was healthy.
   * Mirrors completeWorkerAttempt minus the on-chain pin (the send was
   * suppressed), marking the result as a no-reply completion.
   */
  completeWorkerAttemptNoReply(attemptId: string): void {
    const attempt = this.deps.orchestrationStore.getAttempt(attemptId);
    if (!attempt) return;
    if (attempt.status === 'queued' || attempt.status === 'running') {
      this.deps.orchestrationStore.updateAttempt(attempt.id, 'completed', {
        result: {
          replyText: '',
          groupMessagePinId: '',
          verified: true,
          deliverables: [],
          noReply: true,
        },
      });
    }
    const step = this.deps.orchestrationStore.getStep(attempt.stepId);
    if (step && (step.status === 'queued' || step.status === 'running')) {
      this.deps.orchestrationStore.updateStepStatus(step.id, 'waiting_input', {
        activeAttemptId: attempt.id,
      });
    }
  }

  failWorkerAttempt(attemptId: string, error: string): void {
    const attempt = this.deps.orchestrationStore.getAttempt(attemptId);
    if (!attempt) return;
    if (attempt.status === 'queued' || attempt.status === 'running') {
      this.deps.orchestrationStore.updateAttempt(attempt.id, 'failed', { error: error.trim() || 'WORKER_ATTEMPT_FAILED' });
    }
    const step = this.deps.orchestrationStore.getStep(attempt.stepId);
    if (step && (step.status === 'queued' || step.status === 'running')) {
      this.deps.orchestrationStore.updateStepStatus(step.id, 'failed', { activeAttemptId: attempt.id });
    }
  }

  /**
   * P1-2: fail the latest still-active (running/queued) canonical attempt of
   * one worker of one group task — used by the daemon's stuck-session reclaim
   * so the orchestration ledger matches the reclaimed reality. Returns true
   * when an attempt was failed.
   */
  failActiveWorkerAttempt(groupTaskId: number, workerMetabotId: number, error: string): boolean {
    const groupTask = this.deps.groupTaskStore.getTaskById(groupTaskId);
    if (!groupTask?.orchestrationTaskId) return false;
    const steps = this.deps.orchestrationStore.listSteps(groupTask.orchestrationTaskId)
      .filter((step) => step.assigneeMetabotId === workerMetabotId);
    for (const step of steps.slice().reverse()) {
      const attempts = this.deps.orchestrationStore.listAttempts(step.id);
      const active = attempts.slice().reverse().find(
        (attempt) => attempt.status === 'running' || attempt.status === 'queued',
      );
      if (active) {
        this.failWorkerAttempt(active.id, error);
        return true;
      }
    }
    return false;
  }

  recordDeliverable(input: {
    groupTaskId: number;
    deliverable: GroupTaskDeliverable;
    verificationNotes: string[];
  }): void {
    const groupTask = this.deps.groupTaskStore.getTaskById(input.groupTaskId);
    if (!groupTask) throw new Error(`Group task ${input.groupTaskId} not found`);
    const canonical = this.ensureCanonicalTask(groupTask);
    const author = this.deps.groupTaskStore.listMembers(groupTask.id).find((member) =>
      Boolean(member.globalmetaid)
      && member.globalmetaid!.toLowerCase() === String(input.deliverable.authorGlobalmetaid ?? '').toLowerCase(),
    );
    if (!author?.metabotId) return;
    const step = this.deps.orchestrationStore.listSteps(canonical.id)
      .slice()
      .reverse()
      .find((candidate) => candidate.assigneeMetabotId === author.metabotId && candidate.activeAttemptId);
    if (!step?.activeAttemptId) return;
    const attempt = this.deps.orchestrationStore.getAttempt(step.activeAttemptId);
    if (!attempt) return;

    const result = asObject(attempt.result);
    const previous = Array.isArray(result.deliverables) ? result.deliverables : [];
    const deliverableEvidence = {
      groupTaskDeliverableId: input.deliverable.id,
      msgPinId: input.deliverable.msgPinId,
      kind: input.deliverable.kind,
      uri: input.deliverable.uri,
      verificationNotes: input.verificationNotes,
      ownerAccepted: false,
    };
    const deliverables = previous.some((item) =>
      asObject(item).groupTaskDeliverableId === input.deliverable.id,
    ) ? previous : [...previous, deliverableEvidence];
    const merged = { ...result, deliverables, verified: false };
    this.deps.orchestrationStore.updateAttempt(attempt.id, attempt.status, { result: merged });
    this.deps.orchestrationStore.updateStepStatus(step.id, step.status, {
      activeAttemptId: attempt.id,
      acceptedResult: merged,
    });
  }

  /**
   * Auto-ignore noise steps: failed steps are typically noise (a mistaken worker
   * mention whose skill routing failed) that carries no real deliverable. When a
   * task enters review, demote them to completed with an `ignored` marker so they
   * neither block owner acceptance nor show up as real work. Safe to call at any
   * point; steps that already have a different status are left untouched.
   */
  ignoreFailedSteps(groupTaskId: number): number {
    const groupTask = this.deps.groupTaskStore.getTaskById(groupTaskId);
    if (!groupTask) throw new Error(`Group task ${groupTaskId} not found`);
    if (!groupTask.orchestrationTaskId) return 0;
    const steps = this.deps.orchestrationStore.listSteps(groupTask.orchestrationTaskId);
    let ignored = 0;
    for (const step of steps) {
      if (step.status !== 'failed') continue;
      this.deps.orchestrationStore.updateStepStatus(step.id, 'completed', {
        acceptedResult: {
          ignored: true,
          reason: 'noise step auto-ignored on review entry (no real deliverable)',
        },
      });
      ignored += 1;
    }
    return ignored;
  }

  /**
   * P1-5: latest canonical attempt state for one worker of one group task —
   * the "error/working" half of the member workStatus readout. 'running'
   * attempt => working; 'failed' attempt (recent) => error. `atMs` is the
   * attempt start (running) or finish (failed) timestamp.
   */
  getWorkerAttemptStatus(
    groupTaskId: number,
    workerMetabotId: number,
  ): { status: 'running' | 'failed' | null; atMs: number | null } {
    const groupTask = this.deps.groupTaskStore.getTaskById(groupTaskId);
    if (!groupTask?.orchestrationTaskId) return { status: null, atMs: null };
    const steps = this.deps.orchestrationStore.listSteps(groupTask.orchestrationTaskId)
      .filter((step) => step.assigneeMetabotId === workerMetabotId);
    let latest: { status: 'running' | 'failed'; atMs: number | null } | null = null;
    let latestQueuedMs = 0;
    for (const step of steps) {
      for (const attempt of this.deps.orchestrationStore.listAttempts(step.id)) {
        const queuedMs = Date.parse(attempt.queuedAt);
        if (!Number.isFinite(queuedMs) || queuedMs < latestQueuedMs) continue;
        latestQueuedMs = queuedMs;
        const atMsOf = (value: string | null): number | null => {
          const parsed = Date.parse(value ?? '');
          return Number.isFinite(parsed) ? parsed : null;
        };
        if (attempt.status === 'running') {
          latest = { status: 'running', atMs: atMsOf(attempt.startedAt) };
        } else if (attempt.status === 'failed') {
          latest = { status: 'failed', atMs: atMsOf(attempt.finishedAt) };
        } else {
          latest = null;
        }
      }
    }
    return latest ?? { status: null, atMs: null };
  }

  acceptGroupTask(
    groupTaskId: number,
    actor?: GroupTaskStatusEventActor,
  ): { groupTask: GroupTask; canonicalTask: OrchestrationTask } {
    const groupTask = this.deps.groupTaskStore.getTaskById(groupTaskId);
    if (!groupTask) throw new Error(`Group task ${groupTaskId} not found`);
    let canonical = this.ensureCanonicalTask(groupTask);
    if (canonical.status === 'cancelled') {
      throw new Error(`Orchestration task ${canonical.id} is cancelled`);
    }
    // Orphan 'ready' steps are fossils of restart recovery: the crashed attempt
    // was settled to failed and the step's active-attempt link severed, so no
    // code path can ever advance them (a re-driven trigger message now re-arms
    // them in beginWorkerAttempt instead). Like failed/cancelled noise steps
    // they carry no live work — cancel them here so existing stuck tasks can
    // close, instead of trapping the task in review with no remedy. A ready
    // step that still has a live (queued/running/timed_out) attempt keeps
    // blocking acceptance below.
    for (const step of this.deps.orchestrationStore.listSteps(canonical.id)) {
      if (step.status !== 'ready') continue;
      const hasLiveAttempt = this.deps.orchestrationStore.listAttempts(step.id)
        .some((attempt) => ['queued', 'running', 'timed_out'].includes(attempt.status));
      if (hasLiveAttempt) continue;
      this.deps.orchestrationStore.updateStepStatus(step.id, 'cancelled', {
        acceptedResult: {
          ignored: true,
          reason: 'orphan ready step auto-cancelled on owner acceptance (attempt lost to restart recovery)',
        },
      });
    }
    const steps = this.deps.orchestrationStore.listSteps(canonical.id);
    // Only ACTIVE steps (ready/queued/running/blocked) block acceptance; failed and
    // cancelled steps are noise (mistaken mentions, aborted turns) and never carry
    // a real deliverable, so they must not trap the task in review.
    const unfinished = steps.filter((step) =>
      ['ready', 'queued', 'running', 'blocked'].includes(step.status),
    );
    if (unfinished.length > 0) {
      // F6 (GT#11): the close error names every remaining step with its status
      // and the concrete remedy — previously it was a bare "unfinished
      // canonical steps" with no way to see what blocked the close.
      const detail = unfinished
        .map((step) =>
          `#${step.ordinal} "${step.title}" [${step.status}]` +
          (step.assigneeMetabotId != null ? ` assignee=bot-${step.assigneeMetabotId}` : ''),
        )
        .join('; ');
      throw new Error(
        `Group task ${groupTaskId} has ${unfinished.length} unfinished canonical step(s): ${detail}. ` +
        'Let the running steps finish, or re-dispatch the queued/blocked ones (chair @mentions the assignee), ' +
        'then set the task to review again; failed/cancelled noise steps never block acceptance.',
      );
    }
    if (steps.length > 0 && groupTask.status !== 'review' && groupTask.status !== 'done') {
      throw new Error(`Group task ${groupTaskId} must be in review before owner acceptance`);
    }
    for (const step of steps) {
      if (step.status !== 'waiting_input') continue;
      const accepted = { ...asObject(step.acceptedResult), ownerAccepted: true };
      if (step.activeAttemptId) {
        const attempt = this.deps.orchestrationStore.getAttempt(step.activeAttemptId);
        if (attempt) {
          this.deps.orchestrationStore.updateAttempt(attempt.id, attempt.status, {
            result: { ...asObject(attempt.result), ownerAccepted: true },
          });
        }
      }
      this.deps.orchestrationStore.updateStepStatus(step.id, 'completed', { acceptedResult: accepted });
    }
    // P0-b (task #149): acceptance is the OWNER's verdict. A chair close (the
    // bearer RPC path) or any other non-owner accept must NOT write
    // deliverable.status='accepted' on the owner's behalf — that flipped the
    // ledger to "owner accepted" with nobody having accepted. Non-owner done
    // closes flip pending rows to 'delivered' instead: the rows stay visible
    // in the acceptance summary and member readouts (both filter
    // delivered||accepted), and the chair's closure_note carries the
    // "closed on behalf, owner acceptance pending" semantics. The verdict
    // impression below is likewise owner-only — it records the OWNER's
    // verdict, and recording it for a chair close would sediment the same
    // false acceptance into the remote collaborator's culture base.
    const ownerAccepting = actor?.kind === 'owner';
    const closeVerdict: GroupTaskDeliverableStatus = ownerAccepting ? 'accepted' : 'delivered';
    for (const deliverable of this.deps.groupTaskStore.listDeliverables(groupTask.id)) {
      if (deliverable.status === 'pending') {
        this.deps.groupTaskStore.updateDeliverableStatus(deliverable.id, closeVerdict);
        // OpenTeam M3: the chair sediments a delivery impression for REMOTE
        // authors (local authors are covered by the canonical attempt
        // projection in recordDeliverable plus the dream pipeline).
        // Best-effort, never throws.
        if (ownerAccepting) {
          recordDeliverableVerdictImpression(
            groupTask.id,
            deliverable.authorGlobalmetaid ?? '',
            'accepted',
            deliverable.uri,
          );
        }
      }
    }
    canonical = this.deps.orchestrationStore.getTask(canonical.id)!;
    if (canonical.status === 'running') {
      canonical = this.deps.orchestrationStore.updateTaskStatus(canonical.id, 'review');
    }
    if (canonical.status === 'planning' || canonical.status === 'review') {
      canonical = this.deps.orchestrationStore.updateTaskStatus(canonical.id, 'completed');
    }
    const closed = groupTask.status === 'done'
      ? groupTask
      : this.deps.groupTaskStore.updateTaskStatus(groupTask.id, 'done', { actor: actor ?? { kind: 'system' } });
    // v1.4 (owner ruling C): acceptance IS closure. When the canonical card
    // carries no closure record yet, write the neutral owner record — the
    // board flips the card to closed without inventing a conclusion, and the
    // stale badge dies with it. Idempotent via the closure_at gate: an
    // existing record (with or without a conclusion) is never overwritten.
    if (!this.deps.orchestrationStore.hasClosureRecord(canonical.id)) {
      this.deps.orchestrationStore.recordClosure(canonical.id, { conclusion: null, by: 'owner' });
    }
    return { groupTask: closed, canonicalTask: canonical };
  }

  cancelGroupTask(
    groupTaskId: number,
    actor?: GroupTaskStatusEventActor,
  ): { groupTask: GroupTask; canonicalTask: OrchestrationTask } {
    const groupTask = this.deps.groupTaskStore.getTaskById(groupTaskId);
    if (!groupTask) throw new Error(`Group task ${groupTaskId} not found`);
    const canonical = this.ensureCanonicalTask(groupTask);
    const cancelledCanonical = canonical.status === 'cancelled'
      ? canonical
      : this.deps.orchestrationStore.cancelTaskCascade(canonical.id);
    const cancelledGroup = groupTask.status === 'cancelled'
      ? groupTask
      : this.deps.groupTaskStore.updateTaskStatus(groupTask.id, 'cancelled', { actor: actor ?? { kind: 'system' } });
    return { groupTask: cancelledGroup, canonicalTask: cancelledCanonical };
  }

  /**
   * v1.4 board-sweep self-heal (owner ruling D): catches the detached pairs the
   * pre-v1.4 board produced — the canonical card was closed by a human while
   * the linked group task lagged behind in `review`. When the canonical now
   * carries a closure record (acceptance happened) and `acceptGroupTask` can
   * succeed, the group task catches up to `done`.
   *
   * Best-effort BY CONTRACT: any failure on one group task is recorded as a
   * skip and NEVER thrown — the sweep that calls this must not die on one
   * stuck pair, and unrelated cards must stay untouched.
   */
  healAcceptedGroupTaskCards(): {
    healed: Array<{ groupTaskId: number; canonicalTaskId: string }>;
    skipped: Array<{ groupTaskId: number; canonicalTaskId: string | null; reason: string }>;
  } {
    const healed: Array<{ groupTaskId: number; canonicalTaskId: string }> = [];
    const skipped: Array<{ groupTaskId: number; canonicalTaskId: string | null; reason: string }> = [];
    const reviewing = this.deps.groupTaskStore.listTasks({ status: 'review' });
    for (const groupTask of reviewing) {
      const canonicalTaskId = groupTask.orchestrationTaskId ?? null;
      try {
        if (!canonicalTaskId) {
          skipped.push({ groupTaskId: groupTask.id, canonicalTaskId: null, reason: 'no canonical orchestration task linked' });
          continue;
        }
        // Only accepted cards heal: a closure record on the canonical is the
        // human acceptance this sync is catching the group task up with.
        if (!this.deps.orchestrationStore.hasClosureRecord(canonicalTaskId)) {
          skipped.push({ groupTaskId: groupTask.id, canonicalTaskId, reason: 'canonical card is not closed out yet' });
          continue;
        }
        this.acceptGroupTask(groupTask.id);
        healed.push({ groupTaskId: groupTask.id, canonicalTaskId });
      } catch (error) {
        skipped.push({
          groupTaskId: groupTask.id,
          canonicalTaskId,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { healed, skipped };
  }
}
