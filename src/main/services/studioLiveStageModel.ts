import type { CoworkMessage } from '../coworkStore';
import type { LongTermTaskSummary } from '../../renderer/types/longTermTask';

export const LIVE_STAGE_PROTOCOL = 'idbots.live-stage.v1' as const;

export type LiveStageFamily =
  | 'idle' | 'received' | 'reasoning' | 'speaking'
  | 'local-run' | 'local-read' | 'local-recall'
  | 'desktop-control' | 'projecting' | 'making' | 'browser-action'
  | 'web2-research' | 'web-read'
  | 'metaweb-research' | 'chain-write' | 'chain-transfer'
  | 'private-chat' | 'group-task'
  | 'delegation' | 'waiting' | 'worker-report' | 'verification'
  | 'owner-needed' | 'problem' | 'report-ready' | 'complete';

/** Every family id — the template registry imports this list, never its own. */
export const LIVE_STAGE_FAMILIES: readonly LiveStageFamily[] = [
  'idle', 'received', 'reasoning', 'speaking',
  'local-run', 'local-read', 'local-recall',
  'desktop-control', 'projecting', 'making', 'browser-action',
  'web2-research', 'web-read',
  'metaweb-research', 'chain-write', 'chain-transfer',
  'private-chat', 'group-task',
  'delegation', 'waiting', 'worker-report', 'verification',
  'owner-needed', 'problem', 'report-ready', 'complete',
];

/** Background "place" layer a family draws in front of; 'inherit' keeps the previous place. */
export type LiveStagePlace = 'mind' | 'machine' | 'web' | 'chain';

export type LiveStageTransientKind = 'steer' | 'retry' | 'model-switch' | 'chain-confirmed' | 'tool-error';

/** Short-lived stage event (a few seconds); never replaces the family scene. */
export type LiveStageTransient = { kind: LiveStageTransientKind; id: string; label: string; at: number };

/** A live private (A2A) chat thread shown on the companion rail. */
export type LiveStagePeerThread = {
  /** Peer's globalMetaId. */
  id: string;
  name: string;
  avatar?: string;
  avatarRef?: string;
  status: 'sending' | 'delivered' | 'awaiting' | 'incoming' | 'open';
  /** Plain-text message preview, ≤40 chars. */
  preview?: string;
  updatedAt: number;
};

export type LiveStageGroupMember = {
  /** globalMetaId, else `bot:<metabotId>` for local bots. */
  id: string;
  name: string;
  avatar?: string;
  avatarRef?: string;
  role?: 'chair' | 'worker';
  /** Remote OpenTeam guest (no local metabots row). */
  openteam?: boolean;
  self?: boolean;
};

/** A live group task thread shown on the companion rail / hero ring. */
export type LiveStageGroupThread = {
  /** On-chain groupId. */
  id: string;
  /** ≤60 chars. */
  title: string;
  status: 'posting' | 'incoming' | 'active';
  members: LiveStageGroupMember[];
  memberCount: number;
  openteam: boolean;
  senderId?: string;
  updatedAt: number;
};

export type LiveStageCompanionFocus = { type: 'workers' | 'peers' | 'groups'; id?: string };

export type LiveStageInteractionQuestion = {
  question: string;
  header?: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect: boolean;
  detail?: string;
};

/**
 * One owner-facing prompt hosted on the stage. The stage renders it as a card
 * and queues the click back to the host; the host still owns the decision —
 * the card is a presentation surface, never the authority.
 */
export type LiveStageInteraction = {
  requestId: string;
  /** Single-use random echo value; drained clicks must return it. */
  token: string;
  kind: 'ask' | 'approval';
  title: string;
  detail: string;
  questions: LiveStageInteractionQuestion[];
  /** Approval watchdog deadline; asks wait indefinitely (null). */
  expiresAt: number | null;
  timeoutDefault: 'allow' | 'deny' | null;
};

export type LiveStageMetrics = {
  directorEnabled: boolean;
  directorCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  rejectedPatches: number;
  fallbackCount: number;
  directorLatencyMs: number;
};

export type LiveStageCollaboratingWorker = {
  id: string;
  name: string;
  avatar?: string;
  /** Optional unresolved chain avatar (`nft://` or `metafile://`) resolved asynchronously while `avatar` renders immediately. */
  avatarRef?: string;
  /** Communication flow: 'dispatch' (Twin→Worker), 'working' / 'waiting' (active/waiting), 'return' / 'verifying' (Worker→Twin review). */
  direction: 'dispatch' | 'working' | 'waiting' | 'return' | 'verifying';
  title: string;
  startedAt: number;
};

export type LiveStageTaskHudEntry = {
  id: string;
  title: string;
  state: 'in_progress' | 'waiting_external' | 'waiting_owner';
  accepted: number;
  total: number;
  currentSubtask?: string | null;
  /** True when the task qualifies for the `[长期]` (Long-Term) complexity/span badge. */
  isLongTerm?: boolean;
  /** Parent task id (`ltt_...`) when this row is a rework/companion child task. */
  parentTaskId?: string | null;
  parentTaskTitle?: string | null;
  /** True when rendered indented directly beneath its parent task row in the HUD. */
  isChild?: boolean;
  /** Assigned Bot name currently working on this task, if any. */
  assigneeName?: string | null;
  /** Live Worker milestone progress checkpoint, if any. */
  progressNote?: string | null;
  /** True for tasks expanded in the active HUD (every machine-wide `in_progress` task + session-focused tasks). */
  isCurrent?: boolean;
};

/**
 * The ONE owner-decision card the stage hosts inline (批 B · P0-3, owner
 * ruling 2026-11-23 22:23: 「决策要回到 Live Stage，这才是真正做决策的地方」).
 *
 * The card is a VIEW over `StudioDecisionQueueStore.listOpen()` and resolves
 * through the `longtermTask:decisionResolve` IPC — one data source, one resolve
 * channel. Since P0 (v3.2 §2.0/§2.3) the Live Stage is the ONLY ruling seat:
 * the Process Hub renders pointers, never approve / reject / option controls.
 * The stage never holds its own copy of a ruling.
 */
export type LiveStageDecisionEvidence = {
  kind: string;
  uri: string;
  note?: string;
};

export type LiveStageDecisionOption = {
  label: string;
  description?: string;
  recommended?: boolean;
};

/** The structural slice of a `StudioDecisionQueueItem` the stage card needs. */
export type LiveStageDecisionItem = {
  id: string;
  kind: string;
  title: string;
  question: string;
  recommendation?: string | null;
  backgroundSummary?: string | null;
  options?: readonly LiveStageDecisionOption[] | null;
  evidence?: readonly LiveStageDecisionEvidence[] | null;
  longtermTaskId?: string | null;
  originStudioSessionId?: string | null;
};

export type LiveStageDecisionCard = {
  /** Studio decision-queue item id — the resolve key, verbatim. */
  id: string;
  kind: string;
  title: string;
  question: string;
  recommendation?: string | null;
  backgroundSummary?: string | null;
  options: LiveStageDecisionOption[];
  evidence: LiveStageDecisionEvidence[];
  longtermTaskId?: string | null;
  /**
   * True when the card came from another session's queue (the machine-wide
   * single-pending fallback) — the stage labels it as coming from elsewhere
   * instead of pretending it was born here.
   */
  foreign?: boolean;
};

export type LiveStageTaskHud = {
  queuedDecisions: number;
  tasks: LiveStageTaskHudEntry[];
  /**
   * The inline decision card, when one belongs on this stage (P0-3). Absent /
   * null = the stage shows only the count; the Process Hub keeps the list.
   */
  decision?: LiveStageDecisionCard | null;
};

/**
 * Pick the ONE decision that belongs on this stage.
 *
 * Precedence (first hit wins):
 *   1. the item was born in THIS session (`originStudioSessionId`);
 *   2. the item's task is one this session owns (focused / linked / dispatched);
 *   3. exactly one decision is open machine-wide — that single pending ruling
 *      is the owner's next act, so it is hosted here and marked `foreign`.
 *
 * Anything else → null: several foreign decisions are a LIST, and the list
 * lives in the notification center (the entry seat), not on a stage that
 * belongs to one session. P0 removed the Process Hub's ruling seat.
 */
export function buildLiveStageDecisionCard(params: {
  items: readonly LiveStageDecisionItem[];
  sessionId: string;
  sessionOwnedTaskIds: ReadonlySet<string>;
  maxOptions?: number;
  maxEvidence?: number;
}): LiveStageDecisionCard | null {
  const { items, sessionId, sessionOwnedTaskIds, maxOptions = 3, maxEvidence = 3 } = params;
  if (items.length === 0) return null;
  let picked: LiveStageDecisionItem | null = null;
  let foreign = false;
  if (sessionId) {
    picked = items.find((item) => item.originStudioSessionId === sessionId) ?? null;
  }
  if (!picked) {
    picked = items.find((item) => item.longtermTaskId != null && sessionOwnedTaskIds.has(item.longtermTaskId)) ?? null;
  }
  if (!picked && items.length === 1) {
    picked = items[0];
    foreign = true;
  }
  if (!picked) return null;
  const options = (picked.options ?? [])
    .filter((option) => option && typeof option.label === 'string' && option.label.trim())
    .slice(0, maxOptions)
    .map((option) => ({
      label: option.label.trim(),
      ...(option.description ? { description: option.description } : {}),
      ...(option.recommended ? { recommended: true } : {}),
    }));
  const evidence = (picked.evidence ?? [])
    .filter((entry) => entry && typeof entry.uri === 'string' && entry.uri.trim())
    .slice(0, maxEvidence)
    .map((entry) => ({
      kind: String(entry.kind ?? 'other'),
      uri: entry.uri.trim(),
      ...(entry.note ? { note: entry.note } : {}),
    }));
  return {
    id: picked.id,
    kind: String(picked.kind ?? 'other'),
    title: String(picked.title ?? '').trim() || String(picked.question ?? '').trim() || 'Decision',
    question: String(picked.question ?? '').trim(),
    ...(picked.recommendation ? { recommendation: picked.recommendation } : {}),
    ...(picked.backgroundSummary ? { backgroundSummary: picked.backgroundSummary } : {}),
    options,
    evidence,
    ...(picked.longtermTaskId ? { longtermTaskId: picked.longtermTaskId } : {}),
    ...(foreign ? { foreign: true } : {}),
  };
}

/**
 * Pure builder for the Studio Live Stage bottom-right Task HUD:
 * - Expands (`isCurrent: true`) ALL actively executing (`stage === 'active' && state === 'in_progress'`)
 *   tasks on this machine PLUS tasks explicitly focused/born in the current Studio session.
 * - Folds (`isCurrent: false`) inactive/parked tasks (`paused`, `defining`, `waiting_external`,
 *   or background `waiting_owner` cards from other sessions) underneath the toggle.
 */
export function buildStudioLiveTaskHud(params: {
  cards: readonly LongTermTaskSummary[];
  sessionOwnedTaskIds: ReadonlySet<string>;
  synthesizedCurrent?: LiveStageTaskHudEntry[];
  studioBusy: boolean;
  rawQueuedDecisions: number;
  maxTasks?: number;
  /** P0-3: the inline owner-decision card this stage hosts (null/absent = none). */
  decision?: LiveStageDecisionCard | null;
}): LiveStageTaskHud | null {
  const {
    cards,
    sessionOwnedTaskIds,
    synthesizedCurrent = [],
    studioBusy,
    rawQueuedDecisions,
    maxTasks = 10,
    decision = null,
  } = params;

  const candidates = cards
    .filter((card) => card.stage !== 'done' && card.stage !== 'cancelled' && card.managedState != null)
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));

  const waitingOwnerBoardCount = candidates.filter((c) => c.managedState === 'waiting_owner').length;
  const queuedDecisions = studioBusy ? 0 : Math.max(rawQueuedDecisions, waitingOwnerBoardCount);

  if (candidates.length === 0 && synthesizedCurrent.length === 0 && queuedDecisions === 0 && !decision) {
    return null;
  }

  const mappedCards: LiveStageTaskHudEntry[] = candidates.map((card) => {
    const inThisSession = sessionOwnedTaskIds.has(card.id);
    const rawState = card.managedState ?? 'in_progress';
    const effectiveState =
      inThisSession && studioBusy && rawState === 'waiting_owner' ? 'in_progress' : rawState;
    const isActivelyAdvancing = card.stage === 'active' && effectiveState === 'in_progress';
    const isCurrent = isActivelyAdvancing || inThisSession;
    const assignee =
      card.currentAssigneeMetabotId != null
        ? card.participants.find((p) => p.id === card.currentAssigneeMetabotId)?.name ?? null
        : null;
    const subParts: string[] = [];
    if (assignee) subParts.push(assignee);
    if (card.currentProgressNote) {
      subParts.push(card.currentProgressNote);
    } else if (card.currentSubtaskTitle && card.currentSubtaskTitle !== card.title) {
      subParts.push(card.currentSubtaskTitle);
    }
    return {
      id: card.id,
      title: card.title,
      state: effectiveState,
      accepted: card.progress.accepted,
      total: Math.max(1, card.progress.total),
      currentSubtask: subParts.length > 0 ? subParts.join(' · ') : card.currentSubtaskTitle,
      ...(card.isLongTerm ? { isLongTerm: true } : {}),
      ...(card.parentTaskId ? { parentTaskId: card.parentTaskId } : {}),
      ...(card.parentTaskTitle ? { parentTaskTitle: card.parentTaskTitle } : {}),
      ...(assignee ? { assigneeName: assignee } : {}),
      ...(card.currentProgressNote ? { progressNote: card.currentProgressNote } : {}),
      isCurrent,
    };
  });

  // Tree hierarchy grouping:
  // 1) If ANY child task under `parentTaskId` is `isCurrent` (actively advancing),
  //    promote its open parent task to `isCurrent: true` (and show parent state as
  //    `in_progress` while its child tasks are actively `in_progress`) so the
  //    parent sits at top as the group anchor with its children indented beneath it!
  const byId = new Map(mappedCards.map((entry) => [entry.id, entry]));
  for (const entry of mappedCards) {
    if (!entry.parentTaskId) continue;
    const parent = byId.get(entry.parentTaskId);
    if (!parent) continue;
    if (entry.isCurrent) {
      parent.isCurrent = true;
    }
    if (entry.state === 'in_progress' && parent.state === 'waiting_owner') {
      parent.state = 'in_progress';
    }
  }

  const childrenByParent = new Map<string, LiveStageTaskHudEntry[]>();
  const topLevel: LiveStageTaskHudEntry[] = [];
  for (const entry of mappedCards) {
    if (entry.parentTaskId && byId.has(entry.parentTaskId)) {
      const list = childrenByParent.get(entry.parentTaskId) ?? [];
      list.push({ ...entry, isChild: true });
      childrenByParent.set(entry.parentTaskId, list);
    } else {
      topLevel.push(entry.parentTaskId ? { ...entry, isChild: true } : entry);
    }
  }

  topLevel.sort((a, b) => {
    const aCur = a.isCurrent ? 1 : 0;
    const bCur = b.isCurrent ? 1 : 0;
    if (aCur !== bCur) return bCur - aCur;
    const aProg = a.state === 'in_progress' ? 1 : 0;
    const bProg = b.state === 'in_progress' ? 1 : 0;
    if (aProg !== bProg) return bProg - aProg;
    return 0;
  });

  const treeOrdered: LiveStageTaskHudEntry[] = [];
  for (const root of topLevel) {
    treeOrdered.push(root);
    const kids = childrenByParent.get(root.id);
    if (kids && kids.length > 0) {
      kids.sort((a, b) => {
        const aCur = a.isCurrent ? 1 : 0;
        const bCur = b.isCurrent ? 1 : 0;
        return bCur - aCur;
      });
      for (const kid of kids) {
        treeOrdered.push({ ...kid, isCurrent: Boolean(kid.isCurrent || root.isCurrent) });
      }
    }
  }

  const activeTasks = [...synthesizedCurrent, ...treeOrdered].slice(0, maxTasks);
  return { queuedDecisions, tasks: activeTasks, ...(decision ? { decision } : {}) };
}

export type LiveStageState = {
  protocol: typeof LIVE_STAGE_PROTOCOL;
  sessionId: string;
  /** Stable per-Bot stage identity (`bot:<metabotId>`); all Studio sessions of the same Bot share one Live Stage. */
  botKey?: string;
  turnId: string;
  /**
   * Epoch ms when this turn's state was created. The persistent stage page
   * uses it to order turns: a patch for a different turnId is accepted only
   * when its turnStartedAt is newer, so a delayed old-turn patch can never
   * overwrite a newer turn.
   */
  turnStartedAt: number;
  revision: number;
  enabled: boolean;
  family: LiveStageFamily;
  botName: string;
  /** Twin avatar as an https URL or a stage-relative `avatars/<hash>.<ext>` path; absent → fallback avatar. */
  botAvatar?: string;
  /** Showcase URI of the projected report; the stage's report button opens it. */
  reportUri?: string | null;
  language: 'zh' | 'en';
  /** Localized label shown above the headline; the raw family id never reaches the owner. */
  kicker: string;
  headline: string;
  caption: string;
  /**
   * 'specific' when headline/caption came from real message content (speech,
   * owner request, tool activity, error copy); 'default' when they are the
   * family fallback. The Director may only rewrite 'default' captions.
   */
  captionSource: 'default' | 'specific';
  /** Epoch ms when the current family began; the stage renders elapsed time from it. */
  phaseStartedAt: number;
  composition: 'presence' | 'gather' | 'topology' | 'converge' | 'ready';
  motif: string;
  participants: string[];
  topology: {
    mode: 'presence' | 'structured';
    nodes: Array<{ id: string; label: string; kind: 'twin' | 'source' | 'worker' | 'evidence' | 'owner'; avatar?: string }>;
    edges: Array<[string, string]>;
  };
  motion: {
    preset: string;
    seed: number;
    durationMs: number;
    easing: string;
    energy: number;
    density: number;
  };
  metrics: LiveStageMetrics;
  handoff: { direction: 'dispatch' | 'return'; eventId: string } | null;
  /** Prompt currently hosted on the stage card, if any. */
  interaction: LiveStageInteraction | null;
  pendingProjectionIds: string[];
  eventWindow: Array<{ family: LiveStageFamily; tool?: string; outcome?: string }>;
  /** Concurrent Worker Bots collaborating with the Twin, with directional flow state. */
  activeWorkers?: LiveStageCollaboratingWorker[];
  /** Live private-chat threads on the companion rail (≤4). */
  activePeers?: LiveStagePeerThread[];
  /** Live group-task threads on the companion rail (≤2). */
  activeGroups?: LiveStageGroupThread[];
  /** Which companion family the hero connector currently points at. */
  companionFocus?: LiveStageCompanionFocus | null;
  /** Resolved place layer for this state ('inherit' families keep the previous place). */
  place?: LiveStagePlace;
  /** Short-lived event overlay (steer / retry / model switch / chain confirm / tool error). */
  transient?: LiveStageTransient | null;
  /** In-flight private-chat send tied to its tool_use id. */
  peerSend?: { toolUseId: string; peerId: string; status: 'sending' | 'delivered' | 'failed'; at: number } | null;
  /** In-flight group post tied to its tool_use id. */
  groupPost?: { toolUseId: string; groupId: string; status: 'posting' | 'posted' | 'failed'; at: number } | null;
  /** Tool-use ids awaiting their on-chain confirmation beat (≤16). */
  pendingChainToolIds?: string[];
  /** Live graphical HUD of Managed Task Tree progress and queued owner decisions. */
  taskHud?: LiveStageTaskHud | null;
  /** True when `complete` preserves the final `speaking` headline so font metrics stay steady. */
  speechRest?: boolean;
  /**
   * Pre-claim draft identity patch (prepareDraft): renders bot name/avatar on
   * an unclaimed stage page without claiming it — the first real session
   * patch still claims the page.
   */
  draft?: boolean;
};

export type LiveStageSessionContext = {
  sessionId: string;
  botKey?: string;
  turnId: string;
  botName: string;
  botAvatar?: string;
  language: 'zh' | 'en';
  directorEnabled?: boolean;
  nowMs?: number;
  /** Opening family; defaults to 'received' (a live turn's first beat). */
  family?: LiveStageFamily;
};

const text = (language: 'zh' | 'en', zh: string, en: string): string => language === 'zh' ? zh : en;

const TEAMMATE_FALLBACK: Record<'zh' | 'en', string> = { zh: '协作 Bot', en: 'a teammate' };

/**
 * Family → place layer. 'inherit' families never move the place on their own:
 * they keep whatever place the run was already showing.
 */
export const LIVE_STAGE_FAMILY_PLACE: Record<LiveStageFamily, LiveStagePlace | 'inherit'> = {
  idle: 'mind',
  received: 'mind',
  reasoning: 'mind',
  speaking: 'inherit',
  'local-run': 'machine',
  'local-read': 'machine',
  'local-recall': 'mind',
  'desktop-control': 'machine',
  projecting: 'machine',
  making: 'machine',
  'browser-action': 'machine',
  'web2-research': 'web',
  'web-read': 'web',
  'metaweb-research': 'chain',
  'chain-write': 'chain',
  'chain-transfer': 'chain',
  'private-chat': 'chain',
  'group-task': 'chain',
  delegation: 'machine',
  waiting: 'inherit',
  'worker-report': 'machine',
  verification: 'inherit',
  'owner-needed': 'inherit',
  problem: 'inherit',
  'report-ready': 'mind',
  complete: 'mind',
};

/**
 * Resolve the place a state draws on. Mapped families return their place;
 * 'waiting' picks machine while workers are live, chain while peers/groups
 * are live, else keeps the previous place; the other inherit families always
 * keep the previous place (default 'mind').
 */
export function resolveLiveStagePlace(next: LiveStageState, previous?: LiveStagePlace): LiveStagePlace {
  const mapped = LIVE_STAGE_FAMILY_PLACE[next.family];
  if (mapped !== 'inherit') return mapped;
  if (next.family === 'waiting') {
    if (next.activeWorkers?.length) return 'machine';
    if (next.activePeers?.length || next.activeGroups?.length) return 'chain';
    return previous ?? 'mind';
  }
  return previous ?? 'mind';
}

/** Stamp `place` on every state the model emits so renderer fixtures and service commits agree. */
const withResolvedPlace = (next: LiveStageState, previous?: LiveStagePlace): LiveStageState => ({
  ...next,
  place: resolveLiveStagePlace(next, previous),
});

/** Localized kicker label per family; 'speaking' uses the bot name instead. */
const FAMILY_KICKER: Record<LiveStageFamily, { zh: string; en: string }> = {
  idle: { zh: '', en: '' },
  received: { zh: '收到', en: 'Received' },
  reasoning: { zh: '思考中', en: 'Thinking' },
  speaking: { zh: '', en: '' },
  'local-run': { zh: '本机执行', en: 'On this computer' },
  'local-read': { zh: '读取文件', en: 'Reading files' },
  'local-recall': { zh: '回忆中', en: 'Recalling' },
  'desktop-control': { zh: '操作电脑', en: 'Desktop' },
  projecting: { zh: '投屏', en: 'Projecting' },
  'web2-research': { zh: '上网查找', en: 'Searching the web' },
  'web-read': { zh: '阅读网页', en: 'Reading a page' },
  'metaweb-research': { zh: '查 AI 互联网', en: 'Searching MetaWeb' },
  'chain-write': { zh: '写入 AI 互联网', en: 'Writing to MetaWeb' },
  'chain-transfer': { zh: '链上交易', en: 'On-chain exchange' },
  'private-chat': { zh: '链上私聊', en: 'Private chat' },
  'group-task': { zh: '群任务', en: 'Group task' },
  making: { zh: '动手制作', en: 'Making' },
  delegation: { zh: '安排协作', en: 'Delegating' },
  waiting: { zh: '等待协作', en: 'Waiting on a teammate' },
  'worker-report': { zh: '协作回执', en: 'Teammate reported' },
  verification: { zh: '核对结果', en: 'Checking' },
  'browser-action': { zh: '操作大屏', en: 'On the big screen' },
  'owner-needed': { zh: '需要你决定', en: 'Needs you' },
  problem: { zh: '出了点问题', en: 'Problem' },
  'report-ready': { zh: '汇报就绪', en: 'Report ready' },
  complete: { zh: '已完成', en: 'Done' },
};

function sceneFor(
  family: LiveStageFamily,
  language: 'zh' | 'en',
  botName: string,
  workerName?: string,
  context?: { peerName?: string; groupTitle?: string },
): Pick<LiveStageState, 'headline' | 'caption' | 'kicker' | 'composition' | 'motif' | 'participants' | 'topology'> {
  const worker = workerName?.trim().slice(0, 80) || TEAMMATE_FALLBACK[language];
  const peer = context?.peerName?.trim().slice(0, 80) || text(language, '对方 Bot', 'a Bot');
  const groupTitle = context?.groupTitle?.trim().slice(0, 60) || '';
  const scenes: Record<LiveStageFamily, { headline: string; caption: string; participants: string[] }> = {
    idle: { headline: text(language, '我在，随时可以开始', "I'm here whenever you're ready"), caption: '', participants: [botName] },
    received: { headline: text(language, '收到，我来处理', 'Got it — on it'), caption: text(language, '我来处理这件事。', 'On it.'), participants: [botName] },
    reasoning: { headline: text(language, '正在想怎么做', 'Thinking it through'), caption: '', participants: [botName] },
    speaking: { headline: text(language, '正在回复', 'Replying'), caption: '', participants: [botName] },
    'local-run': { headline: text(language, '正在电脑上处理', 'Working on the computer'), caption: '', participants: [botName] },
    'local-read': { headline: text(language, '正在查看本地文件', 'Reading local files'), caption: '', participants: [botName] },
    'local-recall': { headline: text(language, '正在回想相关的记忆', 'Recalling what I know'), caption: '', participants: [botName] },
    'desktop-control': { headline: text(language, '正在电脑桌面上操作', 'Working on the desktop'), caption: text(language, '桌面操作需要你的授权。', 'Desktop control runs only with your approval.'), participants: [botName] },
    projecting: { headline: text(language, '正在把汇报投到大屏', 'Projecting the report'), caption: '', participants: [botName] },
    'web2-research': { headline: text(language, '正在网上查找资料', 'Searching the web'), caption: '', participants: [botName] },
    'web-read': { headline: text(language, '正在打开网页', 'Opening a web page'), caption: '', participants: [botName] },
    'chain-write': { headline: text(language, '正在写入 AI 互联网', 'Writing to MetaWeb'), caption: text(language, '上链后所有 Bot 都能看到。', 'Once on-chain, every Bot can see it.'), participants: [botName] },
    'chain-transfer': { headline: text(language, '正在处理一笔链上交易', 'Handling an on-chain transaction'), caption: text(language, '以你在对话里确认的为准。', 'Exactly as you confirmed in the chat.'), participants: [botName] },
    'private-chat': { headline: text(language, `正在给 ${peer} 发私信`, `Messaging ${peer} privately`), caption: text(language, '端到端加密，经链上投递。', 'End-to-end encrypted, delivered on-chain.'), participants: [botName, peer] },
    'group-task': {
      headline: groupTitle
        ? text(language, `正在「${groupTitle}」里发言`, `Posting in “${groupTitle}”`)
        : text(language, '正在群任务里同步进展', 'Posting an update to the group task'),
      caption: '',
      participants: groupTitle ? [botName, groupTitle] : [botName],
    },
    'metaweb-research': { headline: text(language, '正在查 AI 互联网上的资料', 'Searching MetaWeb'), caption: '', participants: [botName] },
    making: { headline: text(language, '正在动手制作', 'Making it'), caption: '', participants: [botName] },
    delegation: { headline: text(language, `正在把任务交给 ${worker}`, `Handing the task to ${worker}`), caption: text(language, '它交回来后我会核对，再向你汇报。', "I'll check its work and report back."), participants: [botName, worker] },
    waiting: { headline: text(language, `${worker} 正在处理`, `${worker} is on it`), caption: text(language, '交回来后我会核对，再向你汇报。', "I'll check it and report to you when it's back."), participants: [botName, worker] },
    'worker-report': { headline: text(language, `${worker} 交回了结果`, `${worker} reported back`), caption: text(language, '我正在核对，确认无误再向你汇报。', "I'm checking it now and will report once it's confirmed."), participants: [botName, worker] },
    verification: { headline: text(language, '正在核对结果', 'Checking the result'), caption: text(language, '确认真的做对了再向你汇报。', "I'll only report back once it's verified."), participants: [botName] },
    'browser-action': { headline: text(language, '正在大屏上操作', 'Working on the big screen'), caption: '', participants: [botName] },
    'owner-needed': { headline: text(language, '需要你做个决定', 'I need a decision from you'), caption: text(language, '在你回答之前我先停在这里。', "I'm paused here until you weigh in."), participants: [botName] },
    problem: { headline: text(language, '这一轮没能完成', "This run didn't finish"), caption: text(language, '说「继续」我就接着做。', 'Say "continue" and I\'ll pick it up.'), participants: [botName] },
    'report-ready': { headline: text(language, '汇报已投到大屏', 'The report is on the big screen'), caption: text(language, '汇报在旁边的标签页里，这里继续显示现场。', 'The report is in the next tab; this live view stays here.'), participants: [botName] },
    complete: { headline: text(language, '这一轮做完了', 'Done for this round'), caption: text(language, '完整记录保留在左侧对话里。', 'The full transcript stays on the left.'), participants: [botName] },
  };
  const scene = scenes[family];
  const structured = family === 'delegation' || family === 'waiting' || family === 'worker-report' || family === 'verification' || family === 'browser-action';
  // Only nodes that correspond to something real may appear: the twin, a
  // worker bot that was actually dispatched, the check the twin runs, or the
  // big screen it operates. No decorative "source" nodes.
  const hasWorker = typeof workerName === 'string' && workerName.trim().length > 0;
  const nodes: LiveStageState['topology']['nodes'] = structured ? (() => {
    const twin = { id: 'twin', label: botName, kind: 'twin' as const };
    switch (family) {
      case 'delegation':
      case 'waiting':
      case 'worker-report':
        return [twin, { id: 'worker', label: worker, kind: 'worker' as const }];
      case 'verification':
        return [
          twin,
          ...(hasWorker ? [{ id: 'worker', label: worker, kind: 'worker' as const }] : []),
          { id: 'evidence', label: text(language, '核对', 'Check'), kind: 'evidence' as const },
        ];
      case 'browser-action':
        return [twin, { id: 'source', label: text(language, '大屏', 'Big screen'), kind: 'source' as const }];
      default:
        return [];
    }
  })() : [];
  const edges: LiveStageState['topology']['edges'] = structured ? (() => {
    switch (family) {
      case 'delegation':
      case 'waiting':
        return [['twin', 'worker']];
      case 'worker-report':
        return [['worker', 'twin']];
      case 'verification':
        return [...(hasWorker ? [['twin', 'worker'], ['worker', 'evidence']] : []), ['evidence', 'twin']] as Array<[string, string]>;
      case 'browser-action':
        return [['twin', 'source'], ['source', 'twin']];
      default:
        return [];
    }
  })() : [];
  return {
    ...scene,
    // The participants block lists collaborators only (the stage drops the
    // twin's own entry): a verification names the worker when one exists.
    participants: family === 'verification' && hasWorker ? [botName, worker] : scene.participants,
    kicker: family === 'speaking' || family === 'idle' ? botName : FAMILY_KICKER[family][language],
    composition: family === 'verification' ? 'converge' : structured ? 'topology' : family === 'local-recall' || family === 'web2-research' || family === 'metaweb-research' || family === 'web-read' ? 'gather' : family === 'report-ready' || family === 'complete' ? 'ready' : 'presence',
    motif: family,
    topology: {
      mode: structured ? 'structured' : 'presence',
      nodes,
      edges,
    },
  };
}

function seedFor(sessionId: string, turnId: string, revision: number): number {
  let hash = 2166136261;
  for (const char of `${sessionId}:${turnId}:${revision}`) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return Math.abs(hash >>> 0) % 90000 + 1000;
}

export function createLiveStageState(context: LiveStageSessionContext): LiveStageState {
  const family = context.family ?? 'received';
  const scene = sceneFor(family, context.language, context.botName);
  const nowMs = context.nowMs ?? Date.now();
  const placeMap = LIVE_STAGE_FAMILY_PLACE[family];
  const state: LiveStageState = {
    protocol: LIVE_STAGE_PROTOCOL,
    sessionId: context.sessionId,
    ...(context.botKey ? { botKey: context.botKey } : {}),
    turnId: context.turnId,
    turnStartedAt: nowMs,
    revision: 0,
    enabled: true,
    family,
    botName: context.botName,
    ...(context.botAvatar ? { botAvatar: context.botAvatar } : {}),
    language: context.language,
    ...scene,
    captionSource: 'default',
    phaseStartedAt: nowMs,
    motion: { preset: family, seed: seedFor(context.sessionId, context.turnId, 0), durationMs: 720, easing: 'emphasized-decelerate', energy: .35, density: .25 },
    metrics: { directorEnabled: context.directorEnabled === true, directorCalls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, rejectedPatches: 0, fallbackCount: 0, directorLatencyMs: 0 },
    handoff: null,
    interaction: null,
    pendingProjectionIds: [],
    eventWindow: [{ family }],
    place: placeMap === 'inherit' ? 'mind' : placeMap,
  };
  return state;
}

/** Tools that move value or tokens on-chain — the chain-transfer scene. */
const CHAIN_TRANSFER_TOOLS = new Set([
  'wallet_transfer', 'wallet_token_send', 'wallet_token_transfer', 'wallet_token_buy', 'wallet_token_sell',
  'wallet_token_take', 'wallet_token_cancel_sell', 'wallet_nft_transfer', 'wallet_nft_buy',
  'wallet_nft_sell', 'wallet_nft_cancel_sell', 'wallet_btc_build_multisig_psbt',
  'wallet_btc_sign_psbt', 'wallet_btc_combine_psbts', 'wallet_btc_finalize_psbt',
  'wallet_btc_broadcast', 'mrc721_buy', 'mrc721_sell', 'mrc721_sell_intent',
  'mrc721_sell_intent_cancel', 'mrc721_transfer', 'mrc721_offer', 'mrc721_offer_cancel',
  'mrc721_take_offer', 'escrow_order_create', 'escrow_order_act', 'escrow_tick', 'me_charge',
]);

/** Tools that publish content/pins on-chain — the chain-write scene. */
const CHAIN_WRITE_TOOLS = new Set([
  'post_buzz', 'post_simplenote', 'post_simplelog', 'post_simplequestion', 'post_simpleanswer',
  'comment_pin', 'like_pin', 'upload_file', 'post_metaprotocol', 'metatask_publish',
  'metatask_publish_spec', 'metatask_submit', 'metatask_claim', 'metatask_amend',
  'metatask_release', 'metatask_verify', 'twin_stamp_publish', 'omni_cast', 'mrc721_mint',
  'mrc721_collection_create', 'mrc721_collection_update', 'wallet_token_issue', 'wallet_token_mint',
  'bot_browser_publish_app',
  'preference_vote_commit', 'preference_lesson_publish', 'preference_round_open',
]);

/** Explicit chain-read tool names (omni_* / metaweb / mrc721_* / metatask_* prefixes are handled separately). */
const CHAIN_READ_TOOLS = new Set([
  'search_metaapps', 'resolve_metaapp_url', 'chain_history_recall', 'read_metaweb_pin',
  'search_qa', 'list_latest_questions', 'get_question_answers', 'search_social_posts',
  'social_post_detail', 'social_post_comments', 'metaid_profile', 'search_metaids',
  'list_online_bots', 'list_online_services', 'check_metafile_route', 'metaprotocol_registry',
  'wallet_resolve_global_metaid', 'wallet_balance', 'wallet_mrc20_balance', 'wallet_token_card', 'wallet_token_orders', 'wallet_token_quote', 'wallet_token_portfolio', 'wallet_token_my_orders', 'wallet_token_bridge_card', 'wallet_nft_balance', 'wallet_token_balance', 'wallet_token_issued_list', 'wallet_nft_sell_orders',
  'wallet_token_sell_orders', 'wallet_btc_utxos', 'wallet_btc_pubkey', 'wallet_btc_multisig_address',
  'escrow_order_info', 'escrow_order_list', 'check_peer_relationship', 'list_social_connections',
  'preference_lessons_search', 'preference_round_status', 'preference_rounds_list',
  'search_preference_comparisons',
]);

/** metaweb_* enqueue/start utilities that kick off background work — they keep the current family. */
const METAWEB_BACKGROUND_TOOLS = new Set([
  'metaweb_surf_start', 'metaweb_study_enqueue', 'metaweb_qa_surf_enqueue',
]);

const LOCAL_RUN_TOOLS = new Set(['bash', 'shell', 'pwsh', 'powershell']);
const LOCAL_READ_TOOLS = new Set([
  'read', 'read_image', 'glob', 'grep', 'media_info', 'grab_video_frame',
  'describe_image', 'describe_video', 'describe_audio', 'project_query',
]);
const MAKING_TOOLS = new Set(['write', 'edit', 'apply_patch', 'str_replace_editor', 'convert_media']);
const LOCAL_RECALL_TOOLS = new Set([
  'conversation_search', 'conversation_recall', 'recent_chats', 'intuition',
  'experience_recall', 'procedure_recall',
]);

/**
 * Tool → family classification, evaluated in a fixed priority order so a name
 * always lands in exactly one bucket. Returns null when the tool should not
 * move the scene.
 */
export function familyForTool(toolName: string, toolInput?: unknown): LiveStageFamily | null {
  const name = (toolName || '').toLowerCase();
  if (!name) return null;
  // 1. Turn lifecycle / owner interaction / collaboration bookkeeping.
  if (name === 'twin_todo' || name === 'todo_write' || name === 'todowrite') return null;
  if (name === 'ask_user_question') return 'owner-needed';
  if (name === 'local_worker_delegate' || name === 'idbots_session_insert_user_message' || name === 'twin_task_reassign') return 'delegation';
  if (name === 'longterm_subtask_wait' || name === 'twin_task_status') return 'waiting';
  // 2. Verification beats.
  if (name === 'bot_browser_screenshot' || name === 'bot_browser_read_page' || name === 'twin_task_accept') return 'verification';
  // 3. Projection.
  if (name === 'projection_begin') return 'projecting';
  if (name === 'bot_browser_preview_local') {
    const input = toolInput && typeof toolInput === 'object' && !Array.isArray(toolInput)
      ? toolInput as Record<string, unknown>
      : {};
    return input.projection === true ? 'projecting' : 'browser-action';
  }
  // 4. On-chain messaging.
  if (name === 'send_private_chat') return 'private-chat';
  if (name === 'group_chat') return 'group-task';
  // 5. On-chain value transfer.
  if (CHAIN_TRANSFER_TOOLS.has(name)) return 'chain-transfer';
  // 6. On-chain write (plus the Agentpedia authoring namespace).
  if (CHAIN_WRITE_TOOLS.has(name) || name.startsWith('agentpedia_')) return 'chain-write';
  // 7. Big-screen action.
  if (name.startsWith('bot_browser_') || name === 'open_metaapp' || name === 'browser_open') return 'browser-action';
  // 8. Web2.
  if (name.includes('web_search') || name.includes('websearch')) return 'web2-research';
  if (name === 'web_fetch' || name === 'fetch_url') return 'web-read';
  // 9. Chain reads (AI Internet).
  if (name.startsWith('omni_')) return 'metaweb-research';
  if (name.includes('metaweb')) return METAWEB_BACKGROUND_TOOLS.has(name) ? null : 'metaweb-research';
  if (name.includes('metaapp')) return 'metaweb-research';
  if (name.startsWith('mrc721_') || name.startsWith('metatask_')) return 'metaweb-research';
  if (CHAIN_READ_TOOLS.has(name)) return 'metaweb-research';
  // 10. Desktop control (CUA + DSH Playwright browser-use tools; browser_open is step 7).
  if (name.startsWith('cua_') || name.startsWith('computer_') || name.includes('cua_driver') || name === 'screenshot' || name.startsWith('browser_')) return 'desktop-control';
  // 11. Local execution.
  if (LOCAL_RUN_TOOLS.has(name) || name.startsWith('terminal_')) return 'local-run';
  // 12. Local file/media reads.
  if (LOCAL_READ_TOOLS.has(name)) return 'local-read';
  // 13. Local writes.
  if (MAKING_TOOLS.has(name)) return 'making';
  // 14. Memory / knowledge / past-chat recall.
  if (LOCAL_RECALL_TOOLS.has(name)
    || name.startsWith('idbots_session_read')
    || name.startsWith('longterm_')
    || name.startsWith('memory_')
    || name.startsWith('knowledge_')
    || name.startsWith('task_')) return 'local-recall';
  // 15. Unmapped tools keep the current family.
  return null;
}

function eventSummary(message: CoworkMessage, family: LiveStageFamily): LiveStageState['eventWindow'][number] {
  const tool = typeof message.metadata?.toolName === 'string' ? message.metadata.toolName : undefined;
  const outcome = message.type === 'tool_result' ? (message.metadata?.isError ? 'error' : 'ok') : undefined;
  return { family, ...(tool ? { tool } : {}), ...(outcome ? { outcome } : {}) };
}

export function isLiveStageWorkerReport(message: CoworkMessage): boolean {
  const metadata = message.metadata as Record<string, unknown> | undefined;
  return message.type === 'user' && (metadata?.origin === 'cross_session' || metadata?.sourceChannel === 'idbots_cross_session');
}

export function isLiveStageInternalTrigger(message: CoworkMessage): boolean {
  if (message.type !== 'user') return false;
  if (isLiveStageWorkerReport(message)) return false;
  const metadata = message.metadata as Record<string, unknown> | undefined;
  if (metadata?.isDelegationInternal === true) return true;
  if (
    metadata?.origin === 'studio_briefing'
    || metadata?.origin === 'studio_supervision'
    || metadata?.origin === 'heartbeat'
  ) {
    return true;
  }
  const trimmed = String(message.content ?? '').trimStart();
  return /^<(?:studio_proactive_briefing|studio_back_office_supervision|active_studio_briefing)\b/i.test(trimmed);
}

const clip = (value: string, max: number): string => (value.length > max ? `${value.slice(0, Math.max(0, max - 1))}…` : value);

/** First sentence-ending punctuation index (inclusive), or -1. */
const SENTENCE_END = /[。！？!?…]|\.(?=\s|$)/;
const SENTENCE_END_ALL = /[。！？!?…]|\.(?=\s|$)/g;

const firstSentenceEnd = (text: string): number => {
  const match = SENTENCE_END.exec(text);
  return match ? match.index : -1;
};

/** Last sentence-ending punctuation index inside the first `limit` chars, or -1. */
const sentenceEnd = (text: string, limit: number): number => {
  const window = text.slice(0, limit);
  let best = -1;
  for (const match of window.matchAll(SENTENCE_END_ALL)) best = (match.index ?? 0);
  return best;
};

const CJK_IDEOGRAPH = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g;
/** Speaking headline caps: 28 chars for CJK-dominant text, 60 for Latin-dominant. */
const SPEECH_HEADLINE_CJK_LIMIT = 28;
const SPEECH_HEADLINE_LATIN_LIMIT = 60;
const CLAUSE_MARKS = /[，、；：,;:]/g;

const speechHeadlineLimit = (text: string): number => {
  const cjk = (text.match(CJK_IDEOGRAPH) ?? []).length;
  return cjk * 2 > text.length ? SPEECH_HEADLINE_CJK_LIMIT : SPEECH_HEADLINE_LATIN_LIMIT;
};

/** Index of the last clause mark inside `text`, or -1. */
const lastClauseMark = (text: string): number => {
  let best = -1;
  for (const match of text.matchAll(CLAUSE_MARKS)) best = match.index ?? 0;
  return best;
};

/**
 * Reduce one assistant bubble to stage copy: markdown is stripped to plain
 * prose. The headline is the first sentence when it fits the speaking cap —
 * 28 characters for CJK-dominant text, 60 for Latin-dominant — otherwise it
 * is cut at the last clause mark (，、；：,;:) inside the cap, or hard-cut at
 * the cap (Latin text backs off to a word boundary) with no ellipsis. The
 * remainder flows into the caption (≤200 chars, cut at a sentence boundary).
 * The speaking family never takes the headline length tiers, so this copy
 * keeps the base title size while a reply streams.
 */
export function liveStageSpeechCopy(markdown: string): { headline: string; caption: string } | null {
  const plain = markdownToPlainText(markdown);
  if (!plain) return null;
  const limit = speechHeadlineLimit(plain);
  const end = firstSentenceEnd(plain);
  const firstSentence = end >= 0 ? plain.slice(0, end + 1) : plain;
  let headline: string;
  let rest: string;
  if (firstSentence.length <= limit) {
    headline = firstSentence;
    rest = end >= 0 ? plain.slice(end + 1).trimStart() : '';
  } else {
    const window = plain.slice(0, limit);
    const clause = lastClauseMark(window);
    if (clause > 0) {
      headline = window.slice(0, clause + 1);
      rest = plain.slice(clause + 1).trimStart();
    } else {
      let cut = limit;
      if (limit === SPEECH_HEADLINE_LATIN_LIMIT) {
        const space = window.lastIndexOf(' ');
        if (space > 0) cut = space;
      }
      headline = window.slice(0, cut).trimEnd();
      rest = plain.slice(cut).trimStart();
    }
  }
  let caption = '';
  if (rest) {
    if (rest.length <= 200) {
      caption = rest;
    } else {
      const cut = sentenceEnd(rest, 200);
      caption = cut > 0 ? `${rest.slice(0, cut + 1)}…` : clip(rest, 200);
    }
  }
  return { headline, caption };
}

/** Strip markdown to plain prose for stage display (no raw syntax on the projector). */
export function markdownToPlainText(markdown: string): string {
  return String(markdown ?? '')
    .replace(/<(?:studio_proactive_briefing|studio_back_office_supervision|active_studio_briefing|studio_queue_awareness)\b[^>]*>[\s\S]*?<\/(?:studio_proactive_briefing|studio_back_office_supervision|active_studio_briefing|studio_queue_awareness)>/gi, ' ')
    .replace(/<\/?(?:studio|active_studio|cross_session_message|worker_report)[a-z0-9_]*[^>]*>/gi, ' ')
    .replace(/```[\s\S]*?(?:```|$)/g, ' ')
    .replace(/`([^`\n]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}>+\s?/gm, '')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*\|[^\n]*\|\s*$/gm, ' ')
    .replace(/^\s*[-*+•]\s+/gm, '')
    .replace(/^\s*\d+[.)]\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

const firstSentence = (value: string, max: number): string => {
  const plain = value.replace(/\s+/g, ' ').trim();
  if (!plain) return '';
  const end = firstSentenceEnd(plain);
  return end >= 0 ? clip(plain.slice(0, end + 1), max) : clip(plain, max);
};

const pathBaseName = (value: unknown): string => {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return '';
  const normalized = raw.replace(/\\/g, '/');
  const base = normalized.slice(normalized.lastIndexOf('/') + 1);
  return base || normalized;
};

const inputPath = (input: Record<string, unknown>): string =>
  pathBaseName(input.path) || pathBaseName(input.file_path) || pathBaseName(input.filePath) || pathBaseName(input.target_file) || pathBaseName(input.notebook_path);

/**
 * Owner-facing description of one tool call, in plain words — never raw
 * commands, paths, or arguments. Returns null for tools without a dedicated
 * line so the family default copy stays in charge.
 */
export function describeLiveStageActivity(
  toolName: string,
  toolInput: unknown,
  language: 'zh' | 'en',
  workerName?: string,
  context?: { peerName?: string; groupTitle?: string },
): { headline: string; caption?: string } | null {
  const name = (toolName || '').toLowerCase();
  if (!name) return null;
  const input = toolInput && typeof toolInput === 'object' && !Array.isArray(toolInput)
    ? toolInput as Record<string, unknown>
    : {};
  const worker = workerName?.trim().slice(0, 80) || TEAMMATE_FALLBACK[language];
  const peer = context?.peerName?.trim().slice(0, 80) || text(language, '对方 Bot', 'a Bot');
  const groupTitle = context?.groupTitle?.trim().slice(0, 60) || '';
  const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

  if (name === 'bash' || name === 'shell') {
    const description = str(input.description);
    // In a Chinese UI, models often fill `bash` schema's `description` in raw
    // technical English ("Show vault-poll and verify-claim CLI usage"). Never
    // surface pure-Latin developer descriptions on a Chinese Live Stage — let
    // the clean localized scene caption stay in charge unless the description
    // actually carries Chinese text.
    const languageAppropriate = language === 'en' || /[\u3400-\u9fff]/.test(description);
    return {
      headline: text(language, '正在电脑上处理', 'Working on the computer'),
      ...(description && description.length <= 120 && languageAppropriate ? { caption: description } : {}),
    };
  }
  if (name === 'read' || name === 'read_image') {
    const base = inputPath(input);
    return { headline: text(language, `正在查看 ${base || '文件'}`, `Reading ${base || 'a file'}`) };
  }
  if (name === 'write' || name === 'edit') {
    const base = inputPath(input);
    return { headline: text(language, `正在编写 ${base || '文件'}`, `Writing ${base || 'a file'}`) };
  }
  if (name.includes('web_search') || name.includes('websearch')) {
    const query = clip(str(input.query), 32);
    return { headline: text(language, `正在网上查${query ? `：${query}` : ''}`, `Searching the web${query ? `: ${query}` : ''}`) };
  }
  if (name === 'web_fetch' || name === 'fetch_url') {
    return { headline: text(language, '正在打开网页', 'Opening a web page') };
  }
  if (name === 'conversation_recall') {
    return { headline: text(language, '正在翻看我们之前聊过的内容', 'Looking back through this conversation') };
  }
  if (name === 'conversation_search' || name.startsWith('idbots_session_read')) {
    return { headline: text(language, '正在翻看以前的聊天记录', 'Looking through past chats') };
  }
  if (name.startsWith('memory_') || name.startsWith('knowledge_')) {
    return { headline: text(language, '正在回想相关的记忆', 'Recalling what I know') };
  }
  if (name === 'local_worker_delegate') {
    const objective = firstSentence(str(input.objective ?? input.task ?? input.description), 80);
    return {
      headline: text(language, `正在把任务交给 ${worker}`, `Handing the task to ${worker}`),
      ...(objective ? { caption: objective } : {}),
    };
  }
  if (name === 'twin_task_status') {
    return { headline: text(language, `正在看 ${worker} 的进度`, `Checking ${worker}'s progress`) };
  }
  if (name === 'twin_task_accept') {
    return { headline: text(language, `正在验收 ${worker} 的成果`, `Reviewing ${worker}'s work`) };
  }
  if (name === 'bot_browser_preview_local') {
    return input.projection === true
      ? { headline: text(language, '正在把汇报投到大屏', 'Projecting the report') }
      : { headline: text(language, '正在大屏上打开预览', 'Opening a preview on the big screen') };
  }
  if (name.startsWith('bot_browser_')) {
    return { headline: text(language, '正在大屏上操作', 'Working on the big screen') };
  }
  if (name === 'upload_file') {
    return { headline: text(language, '正在把文件传到链上', 'Uploading a file to the chain') };
  }
  if (name.startsWith('terminal_')) {
    return { headline: text(language, '正在终端里操作', 'Working in the terminal') };
  }
  if (name === 'glob' || name === 'grep') {
    return { headline: text(language, '正在电脑里查找文件', 'Searching files on this computer') };
  }
  if (name === 'media_info' || name === 'grab_video_frame') {
    return { headline: text(language, '正在查看媒体文件', 'Inspecting a media file') };
  }
  if (name === 'describe_image' || name === 'describe_video' || name === 'describe_audio') {
    return { headline: text(language, '正在看这份媒体内容', 'Looking at the media') };
  }
  if (name === 'convert_media') {
    return { headline: text(language, '正在转换媒体文件', 'Converting a media file') };
  }
  if (name === 'projection_begin') {
    return { headline: text(language, '正在准备投屏', 'Preparing the projection') };
  }
  if (name === 'send_private_chat') {
    return {
      headline: text(language, `正在给 ${peer} 发私信`, `Messaging ${peer} privately`),
      caption: text(language, '端到端加密，经链上投递。', 'End-to-end encrypted, delivered on-chain.'),
    };
  }
  if (name === 'group_chat') {
    const action = str(input.action);
    if (action === 'join_group') {
      return { headline: text(language, '正在加入群聊', 'Joining a group chat') };
    }
    if (action === 'orchestrate') {
      return { headline: text(language, '正在设置群聊任务', 'Setting up a group chat task') };
    }
    return {
      headline: groupTitle
        ? text(language, `正在「${groupTitle}」里发言`, `Posting in “${groupTitle}”`)
        : text(language, '正在群任务里同步进展', 'Posting an update to the group task'),
    };
  }
  if (name.startsWith('cua_') || name.startsWith('computer_') || name.includes('cua_driver')) {
    return { headline: text(language, '正在电脑桌面上操作', 'Working on the desktop') };
  }
  if (name === 'screenshot') {
    return { headline: text(language, '正在截取屏幕', 'Taking a screenshot') };
  }
  if (name.startsWith('browser_')) {
    return { headline: text(language, '正在用浏览器操作', 'Working in a browser') };
  }
  if (name === 'list_latest_questions' || name === 'search_qa' || name === 'get_question_answers') {
    return { headline: text(language, '正在看链上问答', 'Reading on-chain Q&A') };
  }
  if (name.includes('balance')) {
    return { headline: text(language, '正在查看链上钱包', 'Checking my on-chain wallet') };
  }
  if (name === 'mrc721_item_info' || name === 'mrc721_item_desc_batch') {
    return { headline: text(language, '正在读取 NFT 的链上信息', 'Reading NFT details on-chain') };
  }
  if (name === 'metaid_profile' || name === 'search_metaids') {
    return { headline: text(language, '正在查看链上身份', 'Looking up on-chain identities') };
  }
  if (name === 'list_online_bots' || name === 'list_online_services') {
    return { headline: text(language, '正在看谁在线', "Checking who's online") };
  }
  if (name === 'search_social_posts' || name.startsWith('social_post_')) {
    return { headline: text(language, '正在看链上动态', 'Reading on-chain posts') };
  }
  if (name === 'check_metafile_route') {
    return { headline: text(language, '正在核对链上文件', 'Checking an on-chain file') };
  }
  if (name === 'post_buzz') {
    return { headline: text(language, '正在发布一条动态', 'Posting to MetaWeb') };
  }
  if (name === 'post_simpleanswer') {
    return { headline: text(language, '正在把回答写到链上', 'Publishing an answer on-chain') };
  }
  if (name === 'post_simplequestion') {
    return { headline: text(language, '正在链上提问', 'Asking on-chain') };
  }
  if (name === 'like_pin') {
    return { headline: text(language, '正在链上点赞', 'Liking on-chain') };
  }
  if (name === 'comment_pin') {
    return { headline: text(language, '正在链上评论', 'Commenting on-chain') };
  }
  if (name === 'post_simplenote') {
    return { headline: text(language, '正在发布一篇链上文章', 'Publishing an on-chain note') };
  }
  if (name === 'mrc721_mint') {
    return { headline: text(language, '正在铸造 NFT', 'Minting an NFT') };
  }
  if (CHAIN_TRANSFER_TOOLS.has(name)) {
    if (name.startsWith('escrow_')) {
      return { headline: text(language, '正在处理链上托管订单', 'Handling an escrow order') };
    }
    if (name.endsWith('_transfer')) {
      return { headline: text(language, '正在发起一笔链上转账', 'Sending an on-chain transfer') };
    }
    if (/buy|sell|offer|take/.test(name)) {
      return { headline: text(language, '正在链上交易', 'Trading on-chain') };
    }
    return { headline: text(language, '正在处理一笔链上交易', 'Handling an on-chain transaction') };
  }
  if (CHAIN_WRITE_TOOLS.has(name) || name.startsWith('agentpedia_')) {
    return { headline: text(language, '正在写入 AI 互联网', 'Writing to MetaWeb') };
  }
  if (name.startsWith('omni_') || name.includes('metaweb') || name.includes('metaapp') || name.startsWith('mrc721_') || name.startsWith('metatask_')) {
    return { headline: text(language, '正在查 AI 互联网', 'Searching MetaWeb') };
  }
  return null;
}

/**
 * Apply a streaming assistant update to the speaking scene. Only non-empty
 * prose moves the stage; the same markdown→headline/caption rules as
 * reduceLiveStageMessage apply so streamed and final text agree.
 */
export function applyLiveStageSpeech(state: LiveStageState, content: string, nowMs = Date.now()): LiveStageState {
  const speech = liveStageSpeechCopy(content);
  if (!speech) return state;
  const familyChanged = state.family !== 'speaking';
  const scene = sceneFor('speaking', state.language, state.botName);
  return withResolvedPlace({
    ...state,
    ...scene,
    headline: speech.headline,
    caption: speech.caption,
    captionSource: 'specific',
    family: 'speaking',
    handoff: null,
    phaseStartedAt: familyChanged ? nowMs : state.phaseStartedAt,
    revision: state.revision + 1,
    eventWindow: [...state.eventWindow, { family: 'speaking' as const }].slice(-8),
  }, state.place);
}

export function reduceLiveStageMessage(
  state: LiveStageState,
  message: CoworkMessage,
  options: { workerName?: string; workerAvatar?: string; peerName?: string; groupTitle?: string; nowMs?: number } = {},
): LiveStageState {
  const nowMs = options.nowMs ?? Date.now();
  const metadata = message.metadata as Record<string, unknown> | undefined;
  // Host projection receipts are bookkeeping bubbles, not the bot speaking.
  if (metadata?.projectorReport) return state;
  if (isLiveStageInternalTrigger(message)) return state;
  let family = state.family;
  let headline: string | undefined;
  let caption: string | undefined;
  let captionSource: 'default' | 'specific' = 'default';
  let pendingProjectionIds = state.pendingProjectionIds;
  let peerSend = state.peerSend ?? null;
  let groupPost = state.groupPost ?? null;
  // Hoist the fallback so the unchanged-check below compares references
  // against the same array (a fresh `[]` per side would never be `===`).
  const stateChainToolIds = state.pendingChainToolIds ?? [];
  let pendingChainToolIds = stateChainToolIds;
  /** undefined = unchanged; a transient produced by this message. */
  let transient: LiveStageTransient | undefined;
  const toolUseIdOf = (): string =>
    typeof metadata?.toolUseId === 'string' && metadata.toolUseId ? metadata.toolUseId : message.id;
  if (message.type === 'user') {
    if (metadata?.interactionKind === 'steer') {
      // A mid-turn steer is a transient banner: the scene and its copy stay.
      const note = markdownToPlainText(String(message.content ?? '')) || String(message.content ?? '').trim();
      transient = {
        kind: 'steer',
        id: message.id,
        at: nowMs,
        label: state.language === 'zh'
          ? `收到补充：「${clip(note, 24)}」`
          : `Got your note: “${clip(note, 40)}”`,
      };
    } else {
      family = isLiveStageWorkerReport(message) ? 'worker-report' : 'received';
      if (family === 'received') {
      const request = String(message.content ?? '').replace(/\s+/g, ' ').trim();
      if (request) {
        caption = clip(state.language === 'zh' ? `「${request}」` : `“${request}”`, 80);
        captionSource = 'specific';
      }
    }
    }
  } else if (message.type === 'assistant') {
    if (message.metadata?.isThinking) {
      family = 'reasoning';
    } else {
      const speech = liveStageSpeechCopy(message.content);
      if (speech) {
        family = 'speaking';
        headline = speech.headline;
        caption = speech.caption || undefined;
        captionSource = 'specific';
      }
      // An assistant bubble without visible text carries no narration; the
      // scene stays where the previous event left it until content arrives.
    }
  } else if (message.type === 'system') {
    if (metadata?.dshRouteFallback === true) {
      transient = {
        kind: 'model-switch',
        id: message.id,
        at: nowMs,
        label: text(state.language, '已切换到备用模型', 'Switched to the backup model'),
      };
    }
    if (message.metadata?.sdkRuntimeStatus === 'api_retry') {
      family = 'reasoning';
      transient = {
        kind: 'retry',
        id: message.id,
        at: nowMs,
        label: text(state.language, '连接不太稳，正在重试', 'Connection is shaky — retrying'),
      };
      const attempt = typeof metadata?.retryAttempt === 'number' && Number.isFinite(metadata.retryAttempt)
        ? Math.max(1, Math.trunc(metadata.retryAttempt))
        : null;
      headline = state.language === 'zh'
        ? `连接不太稳，正在重试${attempt ? `（第 ${attempt} 次）` : ''}`
        : `Connection is shaky — retrying${attempt ? ` (attempt ${attempt})` : ''}`;
    } else if (message.metadata?.sdkRuntimeStatus === 'requesting') {
      family = 'reasoning';
    }
  } else if (message.type === 'tool_use') {
    const toolName = typeof message.metadata?.toolName === 'string' ? message.metadata.toolName : '';
    const toolInput = message.metadata?.toolInput && typeof message.metadata.toolInput === 'object' && !Array.isArray(message.metadata.toolInput)
      ? message.metadata.toolInput as Record<string, unknown>
      : {};
    // owner_update narration reaches the stage through the assistant bubble
    // that follows it — the bubble moves the scene, not this bookkeeping call.
    if (toolName !== 'owner_update') {
      const lowered = toolName.toLowerCase();
      family = familyForTool(toolName, toolInput) ?? state.family;
      if (lowered === 'send_private_chat') {
        peerSend = { toolUseId: toolUseIdOf(), peerId: String(toolInput.to ?? ''), status: 'sending', at: nowMs };
      } else if (lowered === 'group_chat') {
        const groupId = String(toolInput.groupId ?? toolInput.group_id ?? '').trim();
        if (groupId) groupPost = { toolUseId: toolUseIdOf(), groupId, status: 'posting', at: nowMs };
      }
      if (family === 'chain-write' || family === 'chain-transfer' || family === 'private-chat' || family === 'group-task') {
        const chainId = toolUseIdOf();
        if (!pendingChainToolIds.includes(chainId)) pendingChainToolIds = [...pendingChainToolIds, chainId].slice(-16);
      }
      const workerName = options.workerName ?? (state.topology.mode === 'structured'
        ? state.topology.nodes.find((node) => node.kind === 'worker')?.label
        : undefined);
      const activity = describeLiveStageActivity(toolName, toolInput, state.language, workerName, { peerName: options.peerName, groupTitle: options.groupTitle });
      if (activity) {
        headline = activity.headline;
        if (activity.caption) {
          caption = activity.caption;
          captionSource = 'specific';
        }
      }
    }
    if (toolName === 'bot_browser_preview_local' && toolInput.projection === true) {
      const id = typeof message.metadata.toolUseId === 'string' ? message.metadata.toolUseId : message.id;
      if (!pendingProjectionIds.includes(id)) pendingProjectionIds = [...pendingProjectionIds, id];
    }
  } else if (message.type === 'tool_result') {
    const id = typeof message.metadata?.toolUseId === 'string' ? message.metadata.toolUseId : '';
    const wasPendingProjection = state.pendingProjectionIds.includes(id);
    if (id && peerSend?.toolUseId === id) {
      peerSend = { ...peerSend, status: message.metadata.isError ? 'failed' : 'delivered', at: nowMs };
    }
    if (id && groupPost?.toolUseId === id) {
      groupPost = { ...groupPost, status: message.metadata.isError ? 'failed' : 'posted', at: nowMs };
    }
    if (pendingChainToolIds.includes(id)) {
      pendingChainToolIds = pendingChainToolIds.filter((chainId) => chainId !== id);
      const resultText = String(message.content ?? '');
      if (!message.metadata.isError && /\b(?:pin ?id|pinid|txids?)\b/i.test(resultText)) {
        transient = {
          kind: 'chain-confirmed',
          id: message.id,
          at: nowMs,
          label: text(state.language, '已上链', 'Confirmed on-chain'),
        };
      }
    }
    if (message.metadata.isError && !wasPendingProjection) {
      const errorText = `${String(message.content ?? '')} ${typeof metadata?.error === 'string' ? metadata.error : ''}`;
      transient = /timed out|timeout/i.test(errorText)
        ? { kind: 'retry', id: message.id, at: nowMs, label: text(state.language, '这一步超时了，正在重试', 'That step timed out — retrying') }
        : { kind: 'tool-error', id: message.id, at: nowMs, label: text(state.language, '这一步没成功，换个办法', 'That step failed — trying another way') };
    }
    if (pendingProjectionIds.includes(id)) {
      // Only a successful projection switches the stage to 'report-ready'. A
      // guard-rejected mid-turn projection (e.g. Worker still running) is
      // handled in-turn by the model on the very next step — never flash the
      // terminal "这一轮没能完成 / 说「继续」" problem screen for a live turn!
      if (!message.metadata.isError) {
        family = 'report-ready';
      }
      pendingProjectionIds = pendingProjectionIds.filter((pendingId) => pendingId !== id);
    }
  }
  if (state.interaction) {
    family = 'owner-needed';
    headline = undefined;
    caption = undefined;
    captionSource = 'default';
  }
  // The effective worker is the freshly reported one, else the worker already
  // on the structured topology — sceneFor needs it to decide which nodes are
  // real (a verification only shows a worker that was actually dispatched).
  const previousWorker = state.topology.mode === 'structured'
    ? state.topology.nodes.find((node) => node.kind === 'worker')
    : undefined;
  const incomingName = options.workerName?.trim().slice(0, 80);
  const workerLabel = incomingName || previousWorker?.label;
  const sameWorker = !incomingName || !previousWorker?.label || incomingName === previousWorker.label;
  const workerAvatar = options.workerAvatar || (sameWorker ? previousWorker?.avatar : undefined);
  const scene = sceneFor(family, state.language, state.botName, workerLabel, { peerName: options.peerName, groupTitle: options.groupTitle });
  if (workerLabel && scene.topology.mode === 'structured') {
    scene.topology.nodes = scene.topology.nodes.map((node) => node.kind === 'worker'
      ? { ...node, label: workerLabel, ...(workerAvatar ? { avatar: workerAvatar } : {}) }
      : node);
    scene.participants = scene.participants.map((participant, index) => index === 1 ? workerLabel : participant);
  }
  const nextWorkerAvatar = scene.topology.mode === 'structured'
    ? scene.topology.nodes.find((node) => node.kind === 'worker')?.avatar
    : undefined;
  const workerAvatarChanged = (nextWorkerAvatar ?? null) !== (previousWorker?.avatar ?? null);
  const handoff = family === 'worker-report'
    ? { direction: 'return' as const, eventId: typeof metadata?.crossSessionDeliveryId === 'string' ? metadata.crossSessionDeliveryId : message.id }
    : family === 'delegation'
      ? { direction: 'dispatch' as const, eventId: typeof metadata?.toolUseId === 'string' ? metadata.toolUseId : message.id }
      : null;
  // Which companion family the hero connector points at after this message.
  const previousFocus = state.companionFocus ?? null;
  let companionFocus: LiveStageCompanionFocus | null;
  switch (family) {
    case 'delegation':
    case 'worker-report':
    case 'waiting':
      companionFocus = { type: 'workers' };
      break;
    case 'verification':
      companionFocus = scene.topology.nodes.some((node) => node.kind === 'worker')
        ? { type: 'workers' }
        : previousFocus;
      break;
    case 'private-chat':
      companionFocus = { type: 'peers', id: peerSend?.peerId ?? (previousFocus?.type === 'peers' ? previousFocus.id : undefined) };
      break;
    case 'group-task':
      companionFocus = { type: 'groups', id: groupPost?.groupId ?? (previousFocus?.type === 'groups' ? previousFocus.id : undefined) };
      break;
    case 'speaking':
    case 'owner-needed':
    case 'problem':
      companionFocus = previousFocus;
      break;
    default:
      companionFocus = null;
  }
  const focusChanged = (companionFocus?.type ?? null) !== (previousFocus?.type ?? null)
    || (companionFocus?.id ?? null) !== (previousFocus?.id ?? null);
  const familyChanged = family !== state.family;
  const handoffChanged = (handoff?.direction ?? null) !== (state.handoff?.direction ?? null)
    || (handoff?.eventId ?? null) !== (state.handoff?.eventId ?? null);
  // A message that produced no new family, copy, transient or companion
  // bookkeeping (empty assistant bubbles, bookkeeping tool results,
  // owner_update) leaves the stage exactly where it was — including any
  // speech already on screen.
  if (!familyChanged && headline == null && caption == null
    && pendingProjectionIds === state.pendingProjectionIds && !handoffChanged && !workerAvatarChanged
    && transient === undefined && peerSend === (state.peerSend ?? null) && groupPost === (state.groupPost ?? null)
    && pendingChainToolIds === stateChainToolIds && !focusChanged) {
    return state;
  }
  // Same-family updates without fresh copy keep the visible headline/caption
  // (and whether the Director may restyle them) instead of reverting to the
  // family defaults.
  const keepCopy = !familyChanged && headline == null && caption == null;
  return withResolvedPlace({
    ...state,
    ...scene,
    headline: headline ?? (keepCopy ? state.headline : scene.headline),
    caption: caption ?? (keepCopy ? state.caption : scene.caption),
    captionSource: caption != null ? captionSource : (keepCopy ? state.captionSource : 'default'),
    phaseStartedAt: familyChanged ? nowMs : state.phaseStartedAt,
    revision: state.revision + 1,
    family,
    handoff,
    motion: { preset: family, seed: seedFor(state.sessionId, state.turnId, state.revision + 1), durationMs: 720, easing: 'emphasized-decelerate', energy: family === 'report-ready' || family === 'complete' ? .18 : family === 'verification' ? .55 : .4, density: scene.topology.mode === 'structured' ? .55 : .28 },
    pendingProjectionIds,
    peerSend,
    groupPost,
    pendingChainToolIds,
    companionFocus,
    ...(transient !== undefined ? { transient } : {}),
    eventWindow: [...state.eventWindow, eventSummary(message, family)].slice(-8),
  }, state.place);
}

export function completeLiveStage(state: LiveStageState, nowMs = Date.now()): LiveStageState {
  if (state.family === 'report-ready') return state;
  const scene = sceneFor('complete', state.language, state.botName);
  // The bot's last words stay on screen when the turn ends mid-speech; the orb
  // rests but the headline/caption are not replaced by generic copy.
  const keepSpeech = state.family === 'speaking';
  return withResolvedPlace({
    ...state,
    ...scene,
    headline: keepSpeech ? state.headline : scene.headline,
    caption: keepSpeech ? state.caption : scene.caption,
    captionSource: keepSpeech ? state.captionSource : 'default',
    speechRest: keepSpeech ? true : undefined,
    reportUri: state.reportUri,
    family: 'complete',
    handoff: null,
    companionFocus: null,
    phaseStartedAt: nowMs,
    revision: state.revision + 1,
    motion: { ...state.motion, preset: 'complete', energy: .12, durationMs: 600 },
  }, state.place);
}

export function reportReadyLiveStage(state: LiveStageState, reportUri: string | null, nowMs = Date.now()): LiveStageState {
  const scene = sceneFor('report-ready', state.language, state.botName);
  return withResolvedPlace({ ...state, ...scene, family: 'report-ready', reportUri, handoff: null, companionFocus: null, phaseStartedAt: nowMs, revision: state.revision + 1, pendingProjectionIds: [], motion: { ...state.motion, preset: 'report-ready', energy: .18, durationMs: 650 } }, state.place);
}

export function liveStageError(state: LiveStageState, copy?: { headline: string; caption: string }, nowMs = Date.now()): LiveStageState {
  const scene = sceneFor('problem', state.language, state.botName);
  return withResolvedPlace({
    ...state,
    ...scene,
    headline: copy?.headline ?? scene.headline,
    caption: copy?.caption ?? scene.caption,
    captionSource: copy ? 'specific' : 'default',
    family: 'problem',
    handoff: null,
    phaseStartedAt: nowMs,
    revision: state.revision + 1,
    motion: { ...state.motion, preset: 'problem', energy: .25 },
  }, state.place);
}

export type LiveStageDelegationWait = {
  workerName?: string;
  workerAvatar?: string;
  /** First delegation's title (owner intent), shown in the caption. */
  title?: string;
  /** Total open delegations; >1 renders "X 等 n 位" / "X and n-1 more". */
  total?: number;
  /** Distinguish waiting on Worker execution vs back-office Twin verification. */
  phase?: 'worker_running' | 'back_office_verifying';
  /** Earliest delegation start (epoch ms) — the elapsed clock measures from here. */
  startedAt?: number;
  nowMs?: number;
};

/**
 * Turn-complete-but-workers-still-running scene: structured topology with the
 * first worker's name/avatar, a bilingual multi-worker summary, and the
 * delegation's own start time as phaseStartedAt.
 */
export function waitingLiveStage(state: LiveStageState, wait: LiveStageDelegationWait): LiveStageState {
  const nowMs = wait.nowMs ?? Date.now();
  const language = state.language;
  const first = wait.workerName?.trim().slice(0, 80) || TEAMMATE_FALLBACK[language];
  const total = Math.max(1, Math.trunc(wait.total ?? 1));
  const others = total - 1;
  const workerLabel = others > 0
    ? (language === 'zh' ? `${first} 等 ${total} 位` : `${first} and ${others} more`)
    : first;
  const scene = sceneFor('waiting', language, state.botName, first);
  if (scene.topology.mode === 'structured') {
    scene.topology.nodes = scene.topology.nodes.map((node) => node.kind === 'worker'
      ? { ...node, label: workerLabel, ...(wait.workerAvatar ? { avatar: wait.workerAvatar } : {}) }
      : node);
    scene.participants = scene.participants.map((participant, index) => index === 1 ? workerLabel : participant);
  }
  const verifying = wait.phase === 'back_office_verifying';
  const title = wait.title?.replace(/\s+/g, ' ').trim();
  const headline = verifying
    ? (language === 'zh' ? `${workerLabel} 已交回，正在核验结果` : `${workerLabel} returned — verifying now`)
    : scene.headline;
  const kicker = verifying
    ? (language === 'zh' ? '后台核验中' : 'Verifying')
    : scene.kicker;
  const caption = verifying
    ? (language === 'zh'
        ? `${title ? `${clip(title, 54)} · ` : ''}正在后台核查产出与验收标准，整理完毕立即向你汇报。`
        : `${title ? `${clip(title, 54)} · ` : ''}Checking deliverables in the back office; I'll report right after.`)
    : title
      ? (language === 'zh'
        ? `${clip(title, 60)}。交回来后我会核对，再向你汇报。`
        : `${clip(title, 60)}. When it's back I'll check it and report to you.`)
      : scene.caption;
  return withResolvedPlace({
    ...state,
    ...scene,
    kicker,
    headline,
    caption,
    captionSource: 'specific',
    speechRest: undefined,
    family: 'waiting',
    handoff: null,
    companionFocus: { type: 'workers' },
    phaseStartedAt: wait.startedAt ?? nowMs,
    revision: state.revision + 1,
    motion: { ...state.motion, preset: 'waiting', energy: .36, durationMs: 720 },
    eventWindow: [...state.eventWindow, { family: 'waiting' as const }].slice(-8),
  }, state.place);
}

const MAX_INTERACTION_QUESTIONS = 6;
const MAX_INTERACTION_OPTIONS = 8;

const sliceText = (value: unknown, max: number): string =>
  typeof value === 'string' ? value.trim().slice(0, max) : '';

const questionOf = (raw: unknown): LiveStageInteractionQuestion | null => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const question = sliceText(record.question, 400);
  if (!question) return null;
  const options = (Array.isArray(record.options) ? record.options : [])
    .slice(0, MAX_INTERACTION_OPTIONS)
    .map((option): { label: string; description?: string } | null => {
      if (!option || typeof option !== 'object' || Array.isArray(option)) return null;
      const label = sliceText((option as Record<string, unknown>).label, 200);
      if (!label) return null;
      const description = sliceText((option as Record<string, unknown>).description, 400);
      return description ? { label, description } : { label };
    })
    .filter((option): option is { label: string; description?: string } => option !== null);
  const header = sliceText(record.header, 60);
  const detail = sliceText(record.detail, 2000);
  return {
    question,
    options,
    multiSelect: record.multiSelect === true,
    ...(header ? { header } : {}),
    ...(detail ? { detail } : {}),
  };
};

export type LiveStageInteractionCandidate = {
  requestId?: unknown;
  toolName?: unknown;
  toolInput?: Record<string, unknown> | null;
  expiresAt?: unknown;
  timeoutDefault?: unknown;
};

/**
 * Decide whether a pending permission can be hosted on the stage, and shape
 * the card data if so. Ordinary prompts only — A2A approvals and
 * delete-safety confirmations keep their desktop seats (Phase 1 ruling:
 * ask + plain approval, dual seats with the overlay).
 * Returns null when the request must stay off the stage.
 */
export function buildLiveStageInteraction(candidate: LiveStageInteractionCandidate, token: string): LiveStageInteraction | null {
  const requestId = typeof candidate.requestId === 'string' ? candidate.requestId.trim() : '';
  if (!requestId) return null;
  const toolName = typeof candidate.toolName === 'string' ? candidate.toolName.trim() : '';
  if (!toolName) return null;
  const input = candidate.toolInput && typeof candidate.toolInput === 'object' && !Array.isArray(candidate.toolInput)
    ? candidate.toolInput as Record<string, unknown>
    : {};
  const expiresAt = typeof candidate.expiresAt === 'number' && Number.isFinite(candidate.expiresAt) ? candidate.expiresAt : null;
  const timeoutDefault = candidate.timeoutDefault === 'allow' || candidate.timeoutDefault === 'deny' ? candidate.timeoutDefault : null;
  if (toolName === 'AskUserQuestion') {
    const context = input.context && typeof input.context === 'object' && !Array.isArray(input.context)
      ? input.context as Record<string, unknown>
      : null;
    if (context) {
      const action = typeof context.action === 'string' ? context.action : '';
      if (context.a2aApproval === true || action === 'invite' || action === 'remove') return null;
      if (sliceText(context.requestedToolName, 200)) return null;
    }
    const questions = (Array.isArray(input.questions) ? input.questions : [])
      .slice(0, MAX_INTERACTION_QUESTIONS)
      .map(questionOf)
      .filter((question): question is LiveStageInteractionQuestion => question !== null);
    if (questions.length === 0) return null;
    return {
      requestId,
      token,
      kind: 'ask',
      title: questions[0].question,
      detail: questions[0].detail ?? '',
      questions,
      expiresAt,
      timeoutDefault,
    };
  }
  return {
    requestId,
    token,
    kind: 'approval',
    title: toolName,
    detail: sliceText(input.reason, 400),
    questions: [],
    expiresAt,
    timeoutDefault,
  };
}

export function presentLiveStageInteraction(state: LiveStageState, interaction: LiveStageInteraction, nowMs = Date.now()): LiveStageState {
  const scene = sceneFor('owner-needed', state.language, state.botName);
  return withResolvedPlace({
    ...state,
    ...scene,
    family: 'owner-needed',
    interaction,
    phaseStartedAt: state.family === 'owner-needed' ? state.phaseStartedAt : nowMs,
    revision: state.revision + 1,
    handoff: null,
    motion: { ...state.motion, preset: 'owner-needed', energy: .12 },
  }, state.place);
}

export function dismissLiveStageInteraction(state: LiveStageState, requestId: string): LiveStageState {
  if (!state.interaction || state.interaction.requestId !== requestId) return state;
  return { ...state, interaction: null, revision: state.revision + 1 };
}
