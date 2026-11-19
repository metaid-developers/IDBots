import type {
  LongTermBoard,
  LongTermSubtask,
  LongTermSubtaskStatus,
  LongTermTaskDetail,
  LongTermTaskStage,
  LongTermEventKind,
  LongTermActor,
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


export function createActiveLongTermFixture(sessionId: string): LongTermTaskDetail {
  const createdAt = '2026-11-18T02:00:00.000Z';
  const updatedAt = '2026-11-19T03:55:00.000Z';
  const first = fixtureSubtask('lt-mobile-sub-model', 1, 'Map the desktop task model', 'accepted', null, createdAt);
  const second = fixtureSubtask('lt-mobile-sub-prototypes', 2, 'Compare mobile task directions', 'accepted', null, createdAt);
  const current = fixtureSubtask('lt-mobile-sub-direction', 3, 'Confirm the Native Library and current-step card', 'in_progress', sessionId, createdAt);
  current.dependsOn = [second.id];
  current.progressNote = 'Reviewing the Native Library and current-step card';
  current.expectedMinutes = 45;
  current.acceptanceCriteria = [
    'All six desktop states remain reachable',
    'Active tasks are visible on first entry',
    'Every bound task has a conversation entry',
  ];
  const implementation = fixtureSubtask('lt-mobile-sub-implementation', 4, 'Implement the PWA task center', 'pending', null, createdAt);
  implementation.dependsOn = [current.id];
  const verification = fixtureSubtask('lt-mobile-sub-verification', 5, 'Verify mobile chat deep links', 'pending', null, createdAt);
  verification.dependsOn = [implementation.id];
  const subtasks = [first, second, current, implementation, verification].map((subtask) => ({ ...subtask, taskId: 'lt-mobile-task-center' }));
  return {
    id: 'lt-mobile-task-center',
    title: 'Launch the mobile task center',
    goal: 'Let people review active work, make decisions, and return to the exact conversation from a phone.',
    stage: 'active',
    column: 'in_progress',
    managedState: 'in_progress',
    taskKind: 'project',
    acceptanceDelegate: true,
    planArtifactUri: null,
    originChannel: 'mobile',
    currentSubtaskId: current.id,
    currentSubtaskTitle: current.title,
    currentSubtaskStatus: current.status,
    currentProgressNote: current.progressNote,
    currentWaitNote: '',
    currentExpectedMinutes: 45,
    currentAssigneeMetabotId: 2,
    progress: { accepted: 2, total: 5, percent: 40 },
    counts: {
      pending: 2,
      in_progress: 1,
      waiting_owner: 0,
      waiting_external: 0,
      accepted: 2,
      rejected: 0,
      skipped: 0,
    },
    decisionSessionIds: [],
    participants: [{ id: 1, name: 'Twin Bot', avatar: null }, { id: 2, name: 'Research Bot', avatar: null }],
    createdAt,
    updatedAt,
    doneAt: null,
    subtasks,
    events: [
      {
        id: 2,
        taskId: 'lt-mobile-task-center',
        subtaskId: current.id,
        kind: 'progress',
        actor: 'worker:2',
        detail: 'Reviewing the Native Library and current-step card',
        createdAt: updatedAt,
      },
      {
        id: 1,
        taskId: 'lt-mobile-task-center',
        subtaskId: null,
        kind: 'created',
        actor: 'owner',
        detail: 'Task created from a mobile conversation',
        createdAt,
      },
    ],
    definitionSessionId: sessionId,
  };
}

export function longTermBoardCollection(details: LongTermTaskDetail[]): LongTermBoard {
  const cards = details.filter((detail) => detail.stage !== 'cancelled');
  const columns: LongTermBoard['columns'] = ['waiting_owner', 'in_progress', 'waiting_external', 'defining', 'paused', 'done']
    .map((column) => ({
      column: column as LongTermBoard['columns'][number]['column'],
      cardIds: cards.filter((detail) => detail.column === column).map((detail) => detail.id),
    }));
  return {
    generatedAtMs: Math.max(0, ...cards.map((detail) => Date.parse(detail.updatedAt) || 0)),
    columns,
    cards,
  };
}

export function syncLongTermFixture(detail: LongTermTaskDetail, timestamp: string): LongTermTaskDetail {
  const counts = {
    pending: 0,
    in_progress: 0,
    waiting_owner: 0,
    waiting_external: 0,
    accepted: 0,
    rejected: 0,
    skipped: 0,
  };
  for (const subtask of detail.subtasks) counts[subtask.status] += 1;
  const accepted = counts.accepted;
  const total = detail.subtasks.filter((subtask) => subtask.status !== 'skipped').length;
  const current = detail.subtasks.find((subtask) => (
    subtask.status !== 'accepted'
    && subtask.status !== 'skipped'
    && subtask.dependsOn.every((dependency) => detail.subtasks.find((candidate) => candidate.id === dependency)?.status === 'accepted')
  )) ?? null;
  detail.counts = counts;
  detail.progress = { accepted, total, percent: total === 0 ? 100 : Math.round((accepted / total) * 100) };
  detail.currentSubtaskId = current?.id ?? null;
  detail.currentSubtaskTitle = current?.title ?? null;
  detail.currentSubtaskStatus = current?.status ?? null;
  detail.currentWaitNote = current?.waitNote ?? null;
  detail.currentExpectedMinutes = current?.expectedMinutes ?? null;
  detail.currentAssigneeMetabotId = current?.assigneeMetabotId ?? null;
  detail.currentProgressNote = current?.progressNote ?? null;
  detail.currentLastActivityAt = current?.lastActivityAt ?? null;
  detail.column = detail.stage === 'done' || detail.stage === 'cancelled'
    ? 'done'
    : detail.stage === 'paused'
      ? 'paused'
      : detail.stage === 'defining'
        ? 'defining'
        : current?.status === 'waiting_owner' || current?.status === 'waiting_external'
          ? current.status
          : 'in_progress';
  detail.managedState = detail.column === 'waiting_owner' || detail.column === 'in_progress' || detail.column === 'waiting_external'
    ? detail.column
    : null;
  detail.decisionSessionIds = detail.subtasks
    .filter((subtask) => subtask.status === 'waiting_owner' && subtask.sessionId)
    .map((subtask) => subtask.sessionId!);
  detail.updatedAt = timestamp;
  return detail;
}

export function appendLongTermFixtureEvent(
  detail: LongTermTaskDetail,
  kind: LongTermEventKind,
  actor: LongTermActor,
  text: string,
  subtaskId: string | null,
  timestamp: string,
): void {
  detail.events.unshift({
    id: Math.max(0, ...detail.events.map((event) => event.id)) + 1,
    taskId: detail.id,
    subtaskId,
    kind,
    actor,
    detail: text,
    createdAt: timestamp,
  });
}
