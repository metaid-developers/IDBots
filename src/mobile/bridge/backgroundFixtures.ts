import type {
  LongTermBoard,
  LongTermSubtask,
  LongTermSubtaskStatus,
  LongTermTaskDetail,
  LongTermTaskStage,
} from '../../renderer/types/longTermTask';

function fixtureSubtask(
  id: string,
  ordinal: number,
  title: string,
  status: LongTermSubtaskStatus,
  sessionId: string | null,
  timestamp: string,
): LongTermSubtask {
  return {
    id,
    taskId: 'lt-document',
    ordinal,
    title,
    description: 'Produce a readable artifact for the owner.',
    acceptanceCriteria: ['A real document is available'],
    status,
    dependsOn: [],
    preferredChannel: 'delegate_bot',
    evidence: [],
    sessionId,
    sessionHistory: sessionId ? [sessionId] : [],
    waitNote: '',
    waitUntil: null,
    notes: '',
    expectedMinutes: 30,
    metataskRoot: null,
    acceptedBy: status === 'accepted' ? 'twin' : null,
    createdAt: timestamp,
    updatedAt: timestamp,
    acceptedAt: status === 'accepted' ? timestamp : null,
  };
}

export function createLongTermFixture(sessionId: string): LongTermTaskDetail {
  const timestamp = '2026-10-27T00:00:00.000Z';
  const previous = fixtureSubtask('lt-sub-brief', 1, 'Prepare a brief', 'accepted', null, timestamp);
  const current = fixtureSubtask('lt-sub-document', 2, 'Produce a document', 'waiting_owner', sessionId, timestamp);
  current.dependsOn = [previous.id];
  current.waitNote = 'Owner review required';
  const pending = fixtureSubtask('lt-sub-review', 3, 'Review the final document', 'pending', null, timestamp);
  pending.dependsOn = [current.id];
  return {
    id: 'lt-document',
    title: 'Long-term document',
    goal: 'Deliver a document and review it with the owner.',
    stage: 'active',
    column: 'waiting_owner',
    acceptanceDelegate: true,
    planArtifactUri: null,
    currentSubtaskId: current.id,
    currentSubtaskTitle: current.title,
    currentSubtaskStatus: current.status,
    currentWaitNote: current.waitNote,
    currentExpectedMinutes: 30,
    progress: { accepted: 1, total: 3, percent: 33 },
    counts: {
      pending: 1,
      in_progress: 0,
      waiting_owner: 1,
      waiting_external: 0,
      accepted: 1,
      rejected: 0,
      skipped: 0,
    },
    decisionSessionIds: [sessionId],
    participants: [{ id: 1, name: 'Twin Bot', avatar: null }],
    createdAt: timestamp,
    updatedAt: timestamp,
    doneAt: null,
    subtasks: [previous, current, pending],
    events: [{
      id: 1,
      taskId: 'lt-document',
      subtaskId: current.id,
      kind: 'created',
      actor: 'twin',
      detail: 'Long-term document created',
      createdAt: timestamp,
    }],
    definitionSessionId: sessionId,
  };
}

export function applyLongTermStage(
  detail: LongTermTaskDetail,
  action: 'pause' | 'resume' | 'cancel',
  timestamp: string,
): LongTermTaskDetail {
  const stage: LongTermTaskStage = action === 'pause' ? 'paused' : action === 'cancel' ? 'cancelled' : 'active';
  detail.stage = stage;
  detail.column = stage === 'paused'
    ? 'paused'
    : stage === 'cancelled'
      ? 'done'
      : detail.currentSubtaskStatus === 'waiting_owner' || detail.currentSubtaskStatus === 'waiting_external'
        ? detail.currentSubtaskStatus
        : 'in_progress';
  detail.updatedAt = timestamp;
  const nextEventId = Math.max(0, ...detail.events.map((event) => event.id)) + 1;
  detail.events.unshift({
    id: nextEventId,
    taskId: detail.id,
    subtaskId: null,
    kind: action === 'pause' ? 'paused' : action === 'resume' ? 'resumed' : 'note',
    actor: 'owner',
    detail: action,
    createdAt: timestamp,
  });
  return detail;
}

export function longTermBoard(detail: LongTermTaskDetail): LongTermBoard {
  return {
    generatedAtMs: Date.parse(detail.updatedAt) || Date.now(),
    columns: [{ column: detail.column, cardIds: detail.stage === 'cancelled' ? [] : [detail.id] }],
    cards: detail.stage === 'cancelled' ? [] : [detail],
  };
}
