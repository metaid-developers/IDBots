/**
 * Pure helpers for the Group Task UI (status filters, badges, transcript
 * handling). Plain JS (like sidebarNavigation.js) so it can be unit-tested
 * directly with node --test.
 */

export const ACTIVE_GROUP_TASK_STATUSES = ['planning', 'executing', 'review'];

const STATUS_LABEL_KEYS = {
  planning: 'groupTasksStatusPlanning',
  executing: 'groupTasksStatusExecuting',
  review: 'groupTasksStatusReview',
  done: 'groupTasksStatusDone',
  cancelled: 'groupTasksStatusCancelled',
};

export function groupTaskStatusLabelKey(status) {
  return STATUS_LABEL_KEYS[status] ?? 'groupTasksStatusPlanning';
}

export function isActiveGroupTaskStatus(status) {
  return ACTIVE_GROUP_TASK_STATUSES.includes(status);
}

/** Owner acceptance is available only after the Twin has moved work to review. */
export function canAcceptGroupTask(status) {
  return status === 'review';
}

/**
 * Digital outcomes for the acceptance checklist: a clickable/copyable URI
 * (metaapp / metafile / url / pinid). Process-text rows (kind=text, no uri)
 * stay out of the main list so verification notes do not drown the real
 * deliverable. A text-only task still surfaces rows that carry a body preview.
 */
export function isDigitalDeliverable(deliverable) {
  return String(deliverable?.uri ?? '').trim().length > 0;
}

export function selectAcceptanceChecklist(deliverables) {
  const list = Array.isArray(deliverables) ? deliverables : [];
  const digital = list.filter(isDigitalDeliverable);
  if (digital.length > 0) {
    return { items: digital, omittedProcessCount: list.length - digital.length };
  }
  const withBody = list.filter((deliverable) => {
    const uri = String(deliverable?.uri ?? '').trim();
    const preview = String(deliverable?.preview ?? deliverable?.sourceContent ?? '').trim();
    return uri.length > 0 || preview.length > 0;
  });
  return { items: withBody, omittedProcessCount: list.length - withBody.length };
}

const BOT_BROWSER_URI_PROTOCOL_RE = /^(metaid|metaapp|map|metafile|pin|preview-metaapp|preview-file):/i;

/** R3: whether a URI opens inside the Bot Browser (vs the external browser). */
export function isBotBrowserUri(uri) {
  return BOT_BROWSER_URI_PROTOCOL_RE.test(String(uri ?? '').trim());
}

/**
 * R3: open a deliverable/message URI the right way — metaweb schemes
 * (metaid://, metaapp://, map://, metafile://, pin://, preview-metaapp://) open
 * in the Bot Browser via the app-wide event MarkdownContent uses; http(s) opens
 * externally; anything else is copied to the clipboard as the best-effort action.
 * Never throws.
 */
export function openGroupTaskUri(uri) {
  const value = String(uri ?? '').trim();
  if (!value) return;
  try {
    if (isBotBrowserUri(value)) {
      window.dispatchEvent(new CustomEvent('botBrowser:openUri', { detail: { uri: value } }));
      return;
    }
    if (/^https?:\/\//i.test(value)) {
      window.open(value, '_blank', 'noreferrer');
      return;
    }
  } catch {
      // DOM/window unavailable — fall through to clipboard copy.
  }
  try {
    navigator.clipboard?.writeText(value);
  } catch {
      // Clipboard unavailable — silently ignore.
  }
}

/**
 * Short display form for a group/room id (the on-chain group_id, a 64-hex pinid
 * with an `i0` output suffix). Long ids are elided to `first8…last6` (keeping
 * the `i0` suffix visible so the room stays recognizable); short values and
 * junk pass through unchanged. The FULL id is what gets copied to the clipboard.
 */
export function shortGroupId(groupId) {
  const id = String(groupId ?? '').trim();
  if (!id) return '';
  if (id.length <= 16) return id;
  return `${id.slice(0, 8)}…${id.slice(-6)}`;
}

/**
 * P0-1: a review task can be pulled back to executing (Back to work) — the
 * owner/chair reopens it to assign supplementary subtasks.
 */
export function canReopenGroupTask(status) {
  return status === 'review';
}

/** P1-4/R6: i18n label key for a member workStatus. */
export function groupTaskWorkStatusLabelKey(status) {
  switch (status) {
    case 'working':
      return 'groupTasksWorkStatusWorking';
    case 'error':
      return 'groupTasksWorkStatusError';
    case 'timeout':
      return 'groupTasksWorkStatusTimeout';
    case 'waiting':
      return 'groupTasksWorkStatusWaiting';
    case 'idle':
      return 'groupTasksWorkStatusIdle';
    case 'done':
      return 'groupTasksWorkStatusDone';
    case 'unknown':
      return 'groupTasksWorkStatusUnknown';
    default:
      return 'groupTasksWorkStatusUnknown';
  }
}

/** Client-side status filter for the list tabs: active | done | cancelled | all. */
export function filterGroupTasksByTab(tasks, tab) {
  const list = Array.isArray(tasks) ? tasks : [];
  if (tab === 'done') return list.filter((task) => task.status === 'done');
  if (tab === 'cancelled') return list.filter((task) => task.status === 'cancelled');
  if (tab === 'all') return list;
  return list.filter((task) => isActiveGroupTaskStatus(task.status));
}

/**
 * A task seat is remote when it maps to no local metabots row (metabotId ==
 * null) but carries a chain GlobalMetaID — i.e. an external bot invited via
 * OpenTeam. Mirrors the detail view's remote-member rule.
 */
export function isRemoteGroupTaskSeat(member) {
  return member?.metabotId == null && Boolean(String(member?.globalMetaId ?? '').trim());
}

/**
 * Split locally-stored group tasks for the home-page mode toggle:
 * - local: every participant is one of this machine's metabots.
 * - openTeam: at least one seat is a remote bot (OpenTeam invitee) — the task
 *   belongs under "发起的 Open Team" regardless of its status.
 */
export function splitGroupTasksByOpenTeam(tasks) {
  const list = Array.isArray(tasks) ? tasks : [];
  const local = [];
  const openTeam = [];
  for (const task of list) {
    const members = Array.isArray(task?.members) ? task.members : [];
    (members.some(isRemoteGroupTaskSeat) ? openTeam : local).push(task);
  }
  return { local, openTeam };
}

/** Tailwind classes for the colored status badge. */
export function groupTaskStatusBadgeClass(status) {
  switch (status) {
    case 'planning':
      return 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300';
    case 'executing':
      // Breathing blue gradient (defined in index.css) so the in-progress
      // state reads as alive and distinct from the green "done" badge.
      return 'group-task-badge-executing';
    case 'review':
      return 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300';
    case 'done':
      return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300';
    case 'cancelled':
      return 'bg-gray-200 text-gray-600 dark:bg-gray-700/50 dark:text-gray-300';
    default:
      return 'bg-gray-200 text-gray-600 dark:bg-gray-700/50 dark:text-gray-300';
  }
}

/**
 * Parse a group-task timestamp into a Date. Accepts sqlite datetime('now')
 * text ('YYYY-MM-DD HH:MM:SS', UTC), epoch numbers, or null. On-chain
 * chain_timestamp is in SECONDS; smaller numbers (< 1e12) are treated as
 * seconds, larger ones as milliseconds.
 */
export function toGroupTaskDate(value) {
  if (value == null || value === '') return null;
  let date;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value < 1e12 ? value * 1000 : value;
    date = new Date(ms);
  } else {
    const text = String(value).trim();
    if (!text) return null;
    // sqlite datetime('now') is UTC without a timezone marker.
    const normalized = text.includes('T') ? text : `${text.replace(' ', 'T')}Z`;
    date = new Date(normalized);
  }
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

/**
 * Format a group-task timestamp for display. Accepts sqlite datetime('now')
 * text ('YYYY-MM-DD HH:MM:SS', UTC), epoch numbers, or null. On-chain
 * chain_timestamp is in SECONDS; smaller numbers (< 1e12) are treated as
 * seconds, larger ones as milliseconds.
 */
export function formatGroupTaskTime(value) {
  const date = toGroupTaskDate(value);
  if (!date) return '';
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

/**
 * Compact transcript timestamp matching A2A private-chat bubbles (`HH:mm`,
 * `MM-DD HH:mm`, or `YYYY-MM-DD HH:mm`). Pass `now` in tests.
 */
export function formatGroupTaskMessengerTime(value, now = Date.now()) {
  const date = toGroupTaskDate(value);
  if (!date) return '';
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  const timeStr = `${hh}:${mm}`;
  const nowDate = new Date(now);
  if (date.getFullYear() < nowDate.getFullYear()) {
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${date.getFullYear()}-${month}-${day} ${timeStr}`;
  }
  if (nowDate.getTime() - date.getTime() > 24 * 60 * 60 * 1000) {
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${month}-${day} ${timeStr}`;
  }
  return timeStr;
}

/**
 * Compact relative time matching the local/A2A chat list (`19h`, `2d`).
 * `unit`/`count` let the UI build an i18n tooltip. Pass `now` in tests.
 */
export function formatGroupTaskRelativeTime(value, now = Date.now()) {
  const date = toGroupTaskDate(value);
  if (!date) return { compact: '', unit: 'empty', count: 0 };
  const diff = now - date.getTime();
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (minutes < 1) {
    return { compact: 'now', unit: 'now', count: 0 };
  }
  if (minutes < 60) {
    return { compact: `${minutes}m`, unit: 'minutes', count: minutes };
  }
  if (hours < 24) {
    return { compact: `${hours}h`, unit: 'hours', count: hours };
  }
  if (days === 1) {
    return { compact: '1d', unit: 'yesterday', count: 1 };
  }
  return { compact: `${days}d`, unit: 'days', count: days };
}

/**
 * Merge transcript pages by id (ascending). Used when polling: the incoming
 * page replaces rows it overlaps and appends genuinely new ones. Re-delivered
 * pages carry fresh row objects, so when the merged result is field-for-field
 * identical to `existing` the previous array (and its row references) is
 * returned unchanged — the memoized transcript rows then skip re-rendering.
 */
export function mergeTranscriptMessages(existing, incoming) {
  const current = Array.isArray(existing) ? existing : [];
  const byId = new Map();
  for (const message of current) {
    if (message && typeof message.id === 'number') byId.set(message.id, message);
  }
  for (const message of Array.isArray(incoming) ? incoming : []) {
    if (message && typeof message.id === 'number') byId.set(message.id, message);
  }
  const merged = [...byId.values()].sort((a, b) => a.id - b.id);
  if (!Array.isArray(existing) || merged.length !== current.length) return merged;
  for (let index = 0; index < merged.length; index += 1) {
    if (merged[index] === current[index]) continue;
    if (JSON.stringify(merged[index]) !== JSON.stringify(current[index])) return merged;
  }
  return existing;
}

/** Whether the transcript view should stick to the bottom on new messages. */
export function shouldStickToBottom(scrollTop, clientHeight, scrollHeight, threshold = 80) {
  return scrollHeight - (scrollTop + clientHeight) <= threshold;
}

/** P0-2: Tailwind classes for the member state-machine status badge. */
export function groupTaskMemberStatusBadgeClass(status) {
  switch (status) {
    case 'working':
      return 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300';
    case 'standby':
      return 'bg-slate-100 text-slate-600 dark:bg-slate-800/50 dark:text-slate-300';
    case 'done':
      return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300';
    case 'unreachable':
      return 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300';
    case 'assigned':
    default:
      return 'bg-gray-100 text-gray-600 dark:bg-gray-800/50 dark:text-gray-300';
  }
}

/**
 * Task #63: a deliverable URI's 64-hex+i0 pinid token IS the on-chain artifact
 * identity (`pin://X` / `metaapp://X` / `…X.zip` are the same object). Rows
 * sharing a pinid are the same artifact recorded twice — the panel keeps the
 * FIRST row (the earliest claim = the publisher) and hides the rest.
 */
export function deliverablePinidKey(uri) {
  const match = /[0-9a-f]{64}i0/i.exec(String(uri ?? ''));
  return match ? match[0].toLowerCase() : null;
}

/**
 * Task #63: display dedupe — one artifact, one card. Legacy ledgers (recorded
 * before artifact-identity folding landed) may hold the same pinid under two
 * authors; keep-first by pinid so the panel never shows a duplicate.
 */
export function dedupeDeliverablesByPinid(deliverables) {
  const seen = new Set();
  return (Array.isArray(deliverables) ? deliverables : []).filter((deliverable) => {
    const key = deliverablePinidKey(deliverable?.uri);
    if (!key) return true; // url/text rows have no pinid identity — pass through
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** P0-2: human label for the member state-machine status. */
export function groupTaskMemberStatusLabel(status) {
  switch (status) {
    case 'working': return 'working';
    case 'standby': return 'standby';
    case 'done': return 'done';
    case 'unreachable': return 'unreachable';
    case 'assigned':
    default: return 'assigned';
  }
}

/**
 * Group Task deliverable kinds and their badge styling. kind comes from the
 * [DELIVERABLE] line's URI scheme (groupTaskDeliverableParser):
 *   metafile://  -> metafile (on-chain file)
 *   metaapp://   -> metaapp  (on-chain app)
 *   https?://    -> url
 *   <pinid>i0    -> pinid
 *   (no uri)     -> text
 * Returns { labelKey, className } so the component can localize the label.
 */
export function deliverableKindBadge(kind) {
  switch (kind) {
    case 'metafile':
      return {
        labelKey: 'groupTasksDeliverableKindMetafile',
        className: 'bg-sky-500/15 text-sky-600 dark:text-sky-400',
      };
    case 'metaapp':
      return {
        labelKey: 'groupTasksDeliverableKindMetaapp',
        className: 'bg-violet-500/15 text-violet-600 dark:text-violet-400',
      };
    case 'url':
      return {
        labelKey: 'groupTasksDeliverableKindUrl',
        className: 'bg-blue-500/15 text-blue-600 dark:text-blue-400',
      };
    case 'pinid':
      return {
        labelKey: 'groupTasksDeliverableKindPinid',
        className: 'bg-cyan-500/15 text-cyan-600 dark:text-cyan-400',
      };
    case 'text':
    default:
      return {
        labelKey: 'groupTasksDeliverableKindText',
        className: 'dark:bg-claude-darkSurfaceHover bg-claude-surfaceHover dark:text-claude-darkTextSecondary text-claude-textSecondary',
      };
  }
}

/**
 * P0-4: summarize a deliverable's stored verification report (JSON string).
 * Returns one of 'verified' | 'pending-sync' | 'unverified' | 'unknown'.
 */
export function deliverableVerificationState(verification) {
  if (!verification) return 'unknown';
  let report;
  try {
    report = typeof verification === 'string' ? JSON.parse(verification) : verification;
  } catch {
    return 'unknown';
  }
  const sources = Array.isArray(report?.sources) ? report.sources : [];
  if (report?.verified === true) return 'verified';
  if (sources.some((entry) => entry?.outcome === 'not_found')
    && sources.some((entry) => entry?.outcome === 'found')) {
    return 'pending-sync';
  }
  if (sources.some((entry) => entry?.outcome === 'not_found')) return 'unverified';
  return 'unverified';
}

/** Tailwind classes for the verification badge. */
export function deliverableVerificationBadgeClass(state) {
  switch (state) {
    case 'verified':
      return 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400';
    case 'pending-sync':
      return 'bg-amber-500/15 text-amber-600 dark:text-amber-400';
    case 'unverified':
      return 'bg-red-500/15 text-red-600 dark:text-red-400';
    default:
      return 'bg-gray-500/15 text-gray-600 dark:text-gray-400';
  }
}
