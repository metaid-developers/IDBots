/**
 * 进程详情页 · 档案层 pure model (design: process-detail-body-redesign,
 * Friday 2026-11-22, owner ruling 1A / 2A / 3A / 4A).
 *
 * The dossier is the DEFAULT layer of a process transcript: four fixed blocks
 * (goal / acceptance checklist / round timeline / evidence anchors) that answer
 * 「挂在哪条任务 · 验到哪条 · 哪一轮谁做的 · 证据在哪」 without scrolling the
 * message stream. The message stream stays as the second tab, byte-identical.
 *
 * This module is deliberately pure — no React, no IPC, no i18n service calls —
 * so the parts that can be WRONG (state derivation, round folding, anchor
 * classification) are unit-testable without a DOM.
 *
 * Honesty rules encoded here (design §2.1, §2.2, §2.3):
 *   - `evidence_json` carries no `criterionIndex` today, so a per-criterion
 *     state can only be inferred from the whole sub-project's status; every
 *     such row is marked `inferred` and the view renders the ≈ badge.
 *   - A round needs an END VERDICT. `began/assigned` opens it, `submitted`
 *     moves it to 未验, `accepted/rejected/skipped` closes it. An open round is
 *     `running` — never silently dropped.
 *   - A pin anchor is `named` only when the main process actually resolved it;
 *     an id alone is `unnamed` (never invent a title).
 */

import type {
  LongTermEvidence,
  LongTermEvent,
  LongTermSubtask,
  LongTermSubtaskStatus,
  TaskDeliverableArtifact,
} from '../types/longTermTask';

// ── 验收清单 ────────────────────────────────────────────────────────────────

/** Six check states (design §2.1) — zero new colour values. */
export type DossierCheckState =
  | 'passed'
  | 'awaiting'
  | 'unverified'
  | 'rejected'
  | 'skipped'
  | 'external';

export const DOSSIER_CHECK_LABEL_KEY: Record<DossierCheckState, string> = {
  // Five of six reuse the board's own status vocabulary — the detail cannot
  // call a state something the tracking page never says. Only 未验 is new:
  // the board has no word for "exists but was never judged".
  passed: 'longTermTask.status.accepted',
  awaiting: 'longTermTask.status.waitingOwner',
  unverified: 'processDossierCheckUnverified',
  rejected: 'longTermTask.status.rejected',
  skipped: 'longTermTask.status.skipped',
  external: 'longTermTask.status.waitingExternal',
};

/** 7 stored statuses → the 6 check states. `pending` and `in_progress` are the
 *  same thing here: 「未验」 does not distinguish "not started" from "half done"
 *  — that distinction belongs to the round timeline. */
export const dossierCheckStateOf = (status: LongTermSubtaskStatus): DossierCheckState => {
  switch (status) {
    case 'accepted':
      return 'passed';
    case 'waiting_owner':
      return 'awaiting';
    case 'rejected':
      return 'rejected';
    case 'skipped':
      return 'skipped';
    case 'waiting_external':
      return 'external';
    case 'pending':
    case 'in_progress':
    default:
      return 'unverified';
  }
};

export interface DossierCheckRow {
  /** 0-based index into `acceptanceCriteria` — also the criterionIndex contract. */
  index: number;
  text: string;
  state: DossierCheckState;
  /** true = the state was inferred from the whole sub-project, not bound to this row. */
  inferred: boolean;
  /** Evidence entries whose `criterionIndex` names this row (0 today, forward-compatible). */
  anchors: number;
}

export interface DossierCheckModel {
  rows: DossierCheckRow[];
  passed: number;
  total: number;
  /** true when at least one row is marked ≈ (the block header says why). */
  inferred: boolean;
}

/**
 * One row per acceptance criterion. A criterion is only "named" when some
 * evidence carries its `criterionIndex`; otherwise the row inherits the
 * whole-sub-project state and is flagged `inferred` (2A: ship the honest
 * approximation, swap in real per-row states when the field starts arriving).
 */
export const buildCheckModel = (
  subtask: Pick<LongTermSubtask, 'acceptanceCriteria' | 'status' | 'evidence'> | null | undefined,
): DossierCheckModel => {
  const criteria = Array.isArray(subtask?.acceptanceCriteria) ? subtask.acceptanceCriteria : [];
  if (!subtask || criteria.length === 0) {
    return { rows: [], passed: 0, total: 0, inferred: false };
  }
  const evidence = Array.isArray(subtask.evidence) ? subtask.evidence : [];
  const anchorsByIndex = new Map<number, number>();
  for (const entry of evidence) {
    const raw = (entry as { criterionIndex?: unknown }).criterionIndex;
    const index = typeof raw === 'number' && Number.isInteger(raw) ? raw : null;
    if (index == null || index < 0 || index >= criteria.length) continue;
    anchorsByIndex.set(index, (anchorsByIndex.get(index) ?? 0) + 1);
  }
  const base = dossierCheckStateOf(subtask.status);
  // 2A honesty: with no per-criterion binding, evidence exists but cannot be
  // attributed — the row says so instead of pretending the proof is its own.
  const hasUnboundEvidence = evidence.length > 0 && anchorsByIndex.size === 0;
  const rows = criteria.map((text, index) => {
    const anchors = anchorsByIndex.get(index) ?? 0;
    return {
      index,
      text: String(text ?? ''),
      state: base,
      inferred: anchors === 0,
      anchors,
    };
  });
  return {
    rows,
    passed: rows.filter((row) => row.state === 'passed').length,
    total: rows.length,
    inferred: rows.some((row) => row.inferred) && (hasUnboundEvidence || evidence.length > 0),
  };
};

// ── 执行轮次 ────────────────────────────────────────────────────────────────

export type DossierRoundVerdict = 'running' | 'submitted' | 'accepted' | 'rejected' | 'skipped';

export const DOSSIER_ROUND_VERDICT_LABEL_KEY: Record<DossierRoundVerdict, string> = {
  running: 'processDossierVerdictRunning',
  submitted: 'processDossierVerdictSubmitted',
  accepted: 'processDossierVerdictAccepted',
  rejected: 'processDossierVerdictRejected',
  skipped: 'processDossierVerdictSkipped',
};

export interface DossierSubtaskMeta {
  title: string;
  /** preferredChannel of the sub-project (delegate_bot / group_task / …). */
  channel: string | null;
}

export interface DossierRound {
  key: string;
  subtaskId: string | null;
  subtaskTitle: string;
  /** The event kind that opened the round (assigned / began / accepted …). */
  kind: string;
  /** Sub-project channel, when the caller supplied it (design §04 l2 chip). */
  channel: string | null;
  actor: string;
  startedAt: string;
  endedAt: string | null;
  /** What was done — the opening event's detail, or the verdict's own detail. */
  what: string;
  verdict: DossierRoundVerdict;
  /** Intermediate events folded into this round (oldest → newest). */
  progress: string[];
}

const OPENING_KINDS = new Set(['began', 'assigned']);
const PROGRESS_KINDS = new Set(['progress', 'waiting', 'unblocked', 'nudged', 'supervised', 'note', 'replanned']);
const CLOSING_KINDS = new Set(['accepted', 'rejected', 'skipped']);

/** Stable chronological order: ISO string, then the autoincrement id. */
const byChronology = (a: LongTermEvent, b: LongTermEvent): number => {
  const at = String(a.createdAt ?? '');
  const bt = String(b.createdAt ?? '');
  if (at !== bt) return at < bt ? -1 : 1;
  return (a.id ?? 0) - (b.id ?? 0);
};

/**
 * 3A: rounds are derived from `long_term_events` (the only time-series fact
 * source the renderer can read). One round = one executor on one sub-project,
 * opened by began/assigned, closed by a verdict. Events for a sub-project that
 * never opened a round still produce a round when they carry a verdict —
 * an acceptance is a fact even when its opening event fell outside the window.
 *
 * Newest first (the timeline reads top-down from "what just happened").
 */
export const buildDossierRounds = (
  events: readonly LongTermEvent[] | null | undefined,
  subtaskMeta?: ReadonlyMap<string, DossierSubtaskMeta> | null,
): DossierRound[] => {
  const sorted = [...(events ?? [])].sort(byChronology);
  const rounds: DossierRound[] = [];
  /** Open round per sub-project (a sub-project has one live round at a time). */
  const open = new Map<string, DossierRound>();

  const titleOf = (subtaskId: string | null): string => {
    if (!subtaskId) return '';
    return subtaskMeta?.get(subtaskId)?.title ?? '';
  };
  const channelOf = (subtaskId: string | null): string | null => {
    if (!subtaskId) return null;
    return subtaskMeta?.get(subtaskId)?.channel ?? null;
  };

  const push = (round: DossierRound) => {
    rounds.push(round);
  };

  for (const event of sorted) {
    const subtaskId = event.subtaskId ?? null;
    // Task-level events (created / replanned / completed / paused …) are not a
    // round of any sub-project; the goal block already carries the task state.
    if (!subtaskId) continue;
    const detail = String(event.detail ?? '');
    const key = `${subtaskId}#${event.id}`;

    if (OPENING_KINDS.has(event.kind)) {
      const existing = open.get(subtaskId);
      if (existing) {
        // A second begin/assign inside the same round (lease retry) is progress,
        // not a new round — otherwise one dispatch reads as two.
        existing.progress.push(detail);
        continue;
      }
      const round: DossierRound = {
        key,
        subtaskId,
        subtaskTitle: titleOf(subtaskId),
        kind: event.kind,
        channel: channelOf(subtaskId),
        actor: event.actor,
        startedAt: event.createdAt,
        endedAt: null,
        what: detail,
        verdict: 'running',
        progress: [],
      };
      open.set(subtaskId, round);
      push(round);
      continue;
    }

    if (event.kind === 'submitted') {
      const existing = open.get(subtaskId);
      if (existing) {
        existing.verdict = 'submitted';
        existing.endedAt = event.createdAt;
        if (detail) existing.progress.push(detail);
      } else {
        push({
          key,
          subtaskId,
          subtaskTitle: titleOf(subtaskId),
          kind: event.kind,
          channel: channelOf(subtaskId),
          actor: event.actor,
          startedAt: event.createdAt,
          endedAt: event.createdAt,
          what: detail,
          verdict: 'submitted',
          progress: [],
        });
      }
      continue;
    }

    if (CLOSING_KINDS.has(event.kind)) {
      const verdict: DossierRoundVerdict = event.kind === 'accepted'
        ? 'accepted'
        : event.kind === 'rejected'
          ? 'rejected'
          : 'skipped';
      const existing = open.get(subtaskId);
      if (existing) {
        existing.verdict = verdict;
        existing.endedAt = event.createdAt;
        // The verdict's detail is the outcome (owner feedback, skip reason);
        // it is what a reader needs on the row.
        if (detail) existing.what = detail;
        open.delete(subtaskId);
      } else {
        push({
          key,
          subtaskId,
          subtaskTitle: titleOf(subtaskId),
          kind: event.kind,
          channel: channelOf(subtaskId),
          actor: event.actor,
          startedAt: event.createdAt,
          endedAt: event.createdAt,
          what: detail,
          verdict,
          progress: [],
        });
      }
      continue;
    }

    if (PROGRESS_KINDS.has(event.kind)) {
      const existing = open.get(subtaskId);
      if (existing && detail) existing.progress.push(detail);
    }
  }

  return rounds.reverse();
};

/** A round's progress list is folded when it exceeds this many lines. */
export const DOSSIER_ROUND_FOLD_LIMIT = 3;

export const foldRoundProgress = (
  progress: readonly string[],
  limit: number = DOSSIER_ROUND_FOLD_LIMIT,
): { visible: string[]; folded: number } => {
  if (progress.length <= limit) return { visible: [...progress], folded: 0 };
  // Keep the NEWEST lines — the oldest progress is the least useful on screen.
  return { visible: progress.slice(progress.length - limit), folded: progress.length - limit };
};

// ── 交付物与证据锚 ──────────────────────────────────────────────────────────

export type DossierAnchorClass = 'PIN' | 'DIR' | 'URL' | 'APP' | 'FILE' | 'OTHER';

/** 类签 (40px). `metafile` is a pin by another name — same on-chain object. */
export const anchorClassOf = (kind: string): DossierAnchorClass => {
  switch (String(kind ?? '').trim().toLowerCase()) {
    case 'pin':
    case 'metafile':
      return 'PIN';
    case 'dir':
      return 'DIR';
    case 'url':
      return 'URL';
    case 'metaapp':
      return 'APP';
    case 'file':
      return 'FILE';
    default:
      return 'OTHER';
  }
};

/**
 * The 66-character pin id inside a chain URI — the value the copy key MUST put
 * on the clipboard (the visible label may truncate; the clipboard may not).
 * 64 lowercase hex + `i` + output index.
 */
export const PIN_ID_RE = /^[0-9a-f]{64}i\d+$/;

export const pinIdOf = (uri: string | null | undefined): string | null => {
  const raw = String(uri ?? '').trim();
  const match = /^(?:pin|metafile|metaapp):\/\/([0-9a-f]{64}i\d+)$/i.exec(raw);
  if (match) return match[1].toLowerCase();
  if (PIN_ID_RE.test(raw)) return raw;
  return null;
};

export interface DossierAnchorRow {
  key: string;
  kind: string;
  cls: DossierAnchorClass;
  uri: string;
  /** Full 66-char id for chain anchors; null for everything else. */
  pinId: string | null;
  label: string;
  /** true when the author supplied a label; false = the label is a fallback
   *  (pin id / basename) and a resolved pin title may replace it for display. */
  hasLabel: boolean;
  note: string | null;
  /** Registered value only — never presented as verified. */
  sha256: string | null;
  /** 'artifact' rows come from the Worker submission; 'evidence' from the proposal. */
  source: 'evidence' | 'artifact';
}

const basenameOf = (uri: string): string => {
  const clean = uri.replace(/[\\/]+$/, '');
  const cut = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'));
  return cut >= 0 ? clean.slice(cut + 1) : clean;
};

/** Evidence rows + structured deliverables, de-duplicated by (kind, uri). */
export const buildAnchorRows = (
  evidence: readonly LongTermEvidence[] | null | undefined,
  artifacts: readonly TaskDeliverableArtifact[] | null | undefined,
): DossierAnchorRow[] => {
  const rows: DossierAnchorRow[] = [];
  const seen = new Set<string>();
  const add = (
    kind: string,
    uri: string,
    label: string | null,
    note: string | null,
    sha256: string | null,
    source: 'evidence' | 'artifact',
  ) => {
    const trimmed = String(uri ?? '').trim();
    if (!trimmed) return;
    const key = `${String(kind ?? '').trim().toLowerCase()}|${trimmed}`;
    if (seen.has(key)) return;
    seen.add(key);
    const cls = anchorClassOf(kind);
    rows.push({
      key,
      kind: String(kind ?? '').trim().toLowerCase() || 'other',
      cls,
      uri: trimmed,
      pinId: pinIdOf(trimmed),
      label: (label && label.trim()) || basenameOf(trimmed) || trimmed,
      hasLabel: Boolean(label && label.trim()),
      note: note && note.trim() ? note.trim() : null,
      sha256: sha256 && /^[0-9a-f]{64}$/i.test(sha256.trim()) ? sha256.trim().toLowerCase() : null,
      source,
    });
  };
  for (const entry of evidence ?? []) {
    add(entry?.kind ?? 'other', entry?.uri ?? '', null, entry?.note ?? null, null, 'evidence');
  }
  for (const artifact of artifacts ?? []) {
    add(
      artifact?.kind ?? 'other',
      artifact?.uri ?? '',
      artifact?.label ?? null,
      null,
      artifact?.sha256 ?? null,
      'artifact',
    );
  }
  return rows;
};

// ── 时间与署名 ──────────────────────────────────────────────────────────────

const pad2 = (value: number): string => String(value).padStart(2, '0');

/** The 52px timeline column: date (11/600) over time (10). Local time. */
export const formatDossierStamp = (iso: string | null | undefined): { date: string; time: string } | null => {
  if (!iso) return null;
  const parsed = new Date(iso);
  const ms = parsed.getTime();
  if (!Number.isFinite(ms)) return null;
  return {
    date: `${pad2(parsed.getMonth() + 1)}-${pad2(parsed.getDate())}`,
    time: `${pad2(parsed.getHours())}:${pad2(parsed.getMinutes())}`,
  };
};

/** `worker:12` → 12; every other actor → null. */
export const workerIdOfActor = (actor: string | null | undefined): number | null => {
  const match = /^worker:(\d+)$/.exec(String(actor ?? '').trim());
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isFinite(id) ? id : null;
};

/** Actor → i18n key for the non-worker roles (workers resolve to a bot name). */
export const DOSSIER_ACTOR_LABEL_KEY: Record<string, string> = {
  owner: 'processDossierActorOwner',
  twin: 'processDossierActorTwin',
  system: 'processDossierActorSystem',
};

// ── 通道 / 档位 ─────────────────────────────────────────────────────────────

export const DOSSIER_CHANNEL_LABEL_KEY: Record<string, string> = {
  delegate_bot: 'processDossierChannelDelegate',
  group_task: 'processDossierChannelGroup',
  owner_external: 'processDossierChannelOwnerExternal',
  owner_together: 'processDossierChannelOwnerTogether',
};

/**
 * Which dossier tier a process belongs to (design §4). Derived from the same
 * `autoOrigin` the hub uses — a run cannot be T1 in the list and T4 in detail.
 */
export type DossierTier = 'task' | 'orchestration' | 'schedule' | 'none';

export const dossierTierOf = (autoOrigin: string | null | undefined): DossierTier => {
  if (autoOrigin === 'longterm') return 'task';
  if (autoOrigin === 'orchestration') return 'orchestration';
  if (autoOrigin === 'schedule') return 'schedule';
  return 'none';
};
