/**
 * Group-task staffing: decompose → coarse seats → one bot per seat →
 * owner-confirm (unless the triggering wish said "just start", or the slate is
 * all-local and small) → create.
 *
 * Research is a basic capability of every seat, not a seat of its own.
 * Match-first; local is a tie-break, not a gate.
 */

import { groupTaskLanguage } from '../libs/groupTaskCopy';

export const GROUP_TASK_SEAT_ROLES = [
  'content',
  'design',
  'engineering',
  'promotion',
  'domain',
] as const;

export type GroupTaskSeatRole = (typeof GROUP_TASK_SEAT_ROLES)[number];

export const GROUP_TASK_TYPICAL_TEAM_SIZE = 5;
export const GROUP_TASK_HARD_TEAM_SIZE = 8;

/**
 * All-local slates with at most this many seats skip the owner confirmation
 * round automatically: every member runs on this machine and the full team
 * (Twin chair included) stays within the typical team size of 5, so an extra
 * confirm adds friction without changing the roster's blast radius. The owner
 * can still override afterwards — a revise or cancel reply after propose
 * always blocks the auto-start.
 */
export const GROUP_TASK_LOCAL_AUTO_START_MAX_SEATS = 6; // quota audit 2026-09-17 (F1): was 4

export type GroupTaskStaffingProposalStatus =
  | 'pending'
  | 'confirmed'
  | 'skip_authorized'
  | 'consumed'
  | 'cancelled';

export type GroupTaskStaffingOwnerDecision =
  | 'skip_authorized'
  | 'owner_confirmed'
  | 'owner_revise'
  | 'owner_cancel'
  | 'awaiting_owner'
  | 'local_auto_start';

export interface GroupTaskStaffingStage {
  id: string;
  title: string;
  seatRole: GroupTaskSeatRole;
  dependsOn: string[];
}

export interface GroupTaskStaffingSeat {
  role: GroupTaskSeatRole;
  /** Required when role is `domain` (e.g. "legal"). */
  domainLabel?: string;
  /**
   * Optional instance discriminator for domain seats: lets two independent
   * perspectives share ONE specialty ("formal-methods" · 甲 / 乙) for
   * roundtable / adversarial-review tasks. Included in the seat dedupe key;
   * absent or empty keeps the pre-instance key byte-identical.
   */
  seatInstance?: string;
  candidateName: string;
  candidateGlobalMetaId?: string;
  metabotId?: number;
  source: 'local' | 'remote';
  reason: string;
  backupName?: string;
}

export interface GroupTaskStaffingPlan {
  stages: GroupTaskStaffingStage[];
  seats: GroupTaskStaffingSeat[];
}

export interface GroupTaskStaffingProposal {
  id: number;
  sourceSessionId: string;
  twinMetabotId: number;
  title: string;
  goal: string;
  acceptanceCriteria: string | null;
  plan: GroupTaskStaffingPlan;
  status: GroupTaskStaffingProposalStatus;
  skipAuthorized: boolean;
  ownerDecision: string | null;
  createdTaskId: number | null;
  createdAt: number;
  confirmedAt: number | null;
}

export interface StaffingSessionMessage {
  type: string;
  content: string;
  timestamp: number;
}

export interface StaffingPlanValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
  teamSize: number;
}

export class GroupTaskStaffingError extends Error {
  readonly code:
    | 'STAFFING_PLAN_INVALID'
    | 'OWNER_CONFIRM_REQUIRED'
    | 'OWNER_REVISE_REQUIRED'
    | 'OWNER_CANCEL_REQUIRED'
    | 'PROPOSAL_NOT_FOUND'
    | 'PROPOSAL_NOT_USABLE'
    | 'ROSTER_CAP_EXCEEDED'
    | 'SOURCE_SESSION_REQUIRED';

  constructor(
    code: GroupTaskStaffingError['code'],
    message: string,
  ) {
    super(message);
    this.name = 'GroupTaskStaffingError';
    this.code = code;
  }
}

/** Pending / confirmed / skip-authorized slates expire after 24h. */
export const STAFFING_PROPOSAL_TTL_MS = 24 * 60 * 60 * 1000;

const SKIP_CONFIRM_PATTERNS: RegExp[] = [
  /不用确认/,
  /不必确认/,
  /不需要确认/,
  /无需确认/,
  /不用问我/,
  /不用等人选/,
  /跳过确认/,
  /直接开群/,
  /直接开始/,
  /直接开吧/,
  /直接开任务/,
  // Command-like "直接开" only — must not match 开发 / 开会 / 开通.
  /(^|[，,。；;！!\s])直接开[。.!！]*$/,
  /自行决定人选/,
  /no need to confirm/i,
  /skip confirmation/i,
  /without confirmation/i,
  /don't ask me/i,
  /do not ask me/i,
  /just start/i,
  /start directly/i,
  /proceed without confirmation/i,
];

const KEEP_ROSTER_PATTERNS: RegExp[] = [
  /不换人/,
  /不用换/,
  /不要换/,
  /keep (the )?(roster|team|slate|people)/i,
  /don'?t (swap|replace|change)/i,
];

const REVISE_PATTERNS: RegExp[] = [
  /换人/,
  /换成/,
  /换一个/,
  /去掉/,
  /不要\s*\S+/,
  /再找/,
  /换掉/,
  /\breplace\b/i,
  /\bswap\b/i,
  /\bremove\b/i,
  // Bare "drop" / "instead" mis-fire on "ok, use B instead of A".
  /\bdrop\s+(the\s+)?(seat|role|bot|member|candidate|person)\b/i,
];

/**
 * Whole-decision cancellations ("算了/别开了/never mind"). Anchored so plain
 * "取消" inside a compound sentence ("取消确认", "取消，换个岗位") does not
 * flip a normal reply; "算了，就这些人吧" stays a confirm (pattern 3 demands
 * an explicit 不/别 stop right after the comma).
 */
const CANCEL_PATTERNS: RegExp[] = [
  /^(算了|别开了|不开了|取消|取消吧|取消算|先不弄了|不弄了|先不开|不用开了)[。.!！]*$/u,
  /^算了吧[。.!！]*$/u,
  /算了[，,]\s*(不|别)[^。.！!]*$/u,
  /\b(cancel|abort|never ?mind|forget (it|about it)|call it off|scrap (it|this|the plan))\b/i,
];

/**
 * Owner intent labels for the staffing gate. `other` = no decisive intent.
 */
export type OwnerStaffingIntent = 'confirm' | 'revise' | 'cancel' | 'skip' | 'other';

/**
 * Owner intents are no longer matched by hardcoded phrase vocabularies
 * (global product: zh/en lists like 不用确认/换人/算了/just start silently
 * miss every other language — a missed CANCEL even let creates proceed
 * against the owner's wish under an active waiver). Natural-language intent
 * is judged by the host LLM at create time (see evaluateProposalOwnerGate)
 * and reaches the gate as `llmIntents` (one label per reply) plus
 * `llmWishSkip` for the triggering wish. The deterministic classifier below
 * stays as a precise zh/en + idiom OVERLAY: when it reads a reply
 * decisively, its label wins for that reply (a mis-judging LLM can never
 * turn a regex revise/cancel into a confirm); the LLM labels cover
 * everything else. Last decisive reply wins, as before.
 */

function isSeatRole(value: unknown): value is GroupTaskSeatRole {
  return typeof value === 'string' && (GROUP_TASK_SEAT_ROLES as readonly string[]).includes(value);
}

function trimText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function normalizeStaffingPlan(raw: unknown): GroupTaskStaffingPlan {
  const record = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  const stagesRaw = Array.isArray(record.stages) ? record.stages : [];
  const seatsRaw = Array.isArray(record.seats) ? record.seats : [];
  const stages: GroupTaskStaffingStage[] = stagesRaw.map((item, index) => {
    const row = item && typeof item === 'object' ? item as Record<string, unknown> : {};
    const role = isSeatRole(row.seatRole) ? row.seatRole : 'content';
    const dependsOn = Array.isArray(row.dependsOn)
      ? row.dependsOn.map((dep) => String(dep ?? '').trim()).filter(Boolean)
      : [];
    return {
      id: trimText(row.id) || `stage-${index + 1}`,
      title: trimText(row.title) || `Stage ${index + 1}`,
      seatRole: role,
      dependsOn,
    };
  });
  const seats: GroupTaskStaffingSeat[] = seatsRaw.map((item) => {
    const row = item && typeof item === 'object' ? item as Record<string, unknown> : {};
    const metabotId = Number(row.metabotId);
    const candidateGlobalMetaId = trimText(row.candidateGlobalMetaId) || trimText(row.globalmetaid) || undefined;
    const rawSource = String(row.source ?? '').trim();
    // A missing / invalid source label falls back to the global meta id: a
    // seat carrying one is a remote hire (local seats never carry one), so it
    // must not be miscounted as local for the auto-start waiver.
    const source = rawSource === 'local'
      ? 'local'
      : rawSource === 'remote'
        ? 'remote'
        : candidateGlobalMetaId
          ? 'remote'
          : 'local';
    return {
      role: isSeatRole(row.role) ? row.role : 'content',
      domainLabel: trimText(row.domainLabel) || undefined,
      seatInstance: trimText(row.seatInstance) || undefined,
      candidateName: trimText(row.candidateName) || trimText(row.name),
      candidateGlobalMetaId,
      metabotId: Number.isInteger(metabotId) && metabotId > 0 ? metabotId : undefined,
      source,
      reason: trimText(row.reason),
      backupName: trimText(row.backupName) || undefined,
    };
  });
  return { stages, seats };
}

function seatKey(seat: GroupTaskStaffingSeat): string {
  if (seat.role === 'domain') {
    const label = `domain:${(seat.domainLabel || 'unspecified').trim().toLowerCase()}`;
    // H-1 fix: the instance discriminator separates two independent seats in
    // the SAME specialty. No instance → the exact pre-instance key, so every
    // payload that predates the field dedupes byte-identically to before.
    const instance = (seat.seatInstance || '').trim().toLowerCase();
    return instance ? `${label}#${instance}` : label;
  }
  return seat.role;
}

export function validateStaffingPlan(plan: GroupTaskStaffingPlan): StaffingPlanValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  for (const [index, seat] of plan.seats.entries()) {
    if (!isSeatRole(seat.role)) {
      errors.push(`seats[${index}].role is not a coarse seat`);
      continue;
    }
    if (seat.role === 'domain' && !seat.domainLabel) {
      errors.push(`seats[${index}] domain seat needs domainLabel (e.g. legal)`);
    }
    if (!seat.candidateName) {
      errors.push(`seats[${index}] needs candidateName`);
    }
    if (seat.source === 'remote' && !seat.candidateGlobalMetaId) {
      errors.push(`seats[${index}] remote seat needs candidateGlobalMetaId`);
    }
    const key = seatKey(seat);
    if (seen.has(key)) {
      errors.push(`duplicate seat ${key}: one bot per coarse role`);
    }
    seen.add(key);
  }
  const teamSize = plan.seats.length + 1;
  if (teamSize > GROUP_TASK_HARD_TEAM_SIZE) {
    errors.push(
      `team size ${teamSize} exceeds the hard cap of ${GROUP_TASK_HARD_TEAM_SIZE} (including the Twin chair)`,
    );
  }
  if (teamSize > GROUP_TASK_TYPICAL_TEAM_SIZE) {
    warnings.push(
      `team size ${teamSize} is above the typical cap of ${GROUP_TASK_TYPICAL_TEAM_SIZE}; keep this only when the owner asked for the extra seat`,
    );
  }
  if (plan.stages.some((stage) => stage.title.toLowerCase().includes('research') && stage.seatRole === 'content' && plan.stages.some((other) => other !== stage && other.seatRole === 'content'))) {
    warnings.push('research is a basic capability of every seat — do not split it from content');
  }
  return { ok: errors.length === 0, errors, warnings, teamSize };
}

function isInterrogativeStaffingText(text: string): boolean {
  const value = text.trim();
  if (!value) return false;
  if (/[？?]/.test(value)) return true;
  if (/吗\s*[。.!！]*$/.test(value)) return true;
  if (/^(能不能|可不可以|能否)/.test(value)) return true;
  return false;
}

export function detectSkipConfirmInWish(text: string): boolean {
  const value = String(text ?? '').trim();
  if (!value || isInterrogativeStaffingText(value)) return false;
  return SKIP_CONFIRM_PATTERNS.some((pattern) => pattern.test(value));
}

export function classifyOwnerStaffingReply(text: string): 'confirm' | 'revise' | 'cancel' | 'unknown' {
  const value = String(text ?? '').trim();
  if (!value) return 'unknown';
  // "好的，不换人" must not fire /换人/ first-match revise.
  if (KEEP_ROSTER_PATTERNS.some((pattern) => pattern.test(value))) return 'confirm';
  if (CANCEL_PATTERNS.some((pattern) => pattern.test(value))) return 'cancel';
  if (REVISE_PATTERNS.some((pattern) => pattern.test(value))) return 'revise';
  // A plain confirmation ("确认", "可以", "OK", "就这样吧", …) is NOT decided
  // here — natural-language approval is LLM-judged upstream and injected as
  // llmLastConfirmIndex. This keeps a deterministic vocabulary out of the
  // confirm path while revise/cancel stay regex-exact (safety side).
  return 'unknown';
}

export function pickTriggeringWishText(
  messages: StaffingSessionMessage[],
  atOrBeforeMs: number,
): string {
  const chronological = [...messages].sort((left, right) => left.timestamp - right.timestamp);
  let latest = '';
  for (const message of chronological) {
    if (message.type !== 'user') continue;
    if (message.timestamp > atOrBeforeMs) continue;
    const content = String(message.content ?? '').trim();
    if (content) latest = content;
  }
  return latest;
}

export function isStaffingProposalExpired(createdAt: number, nowMs: number = Date.now()): boolean {
  return nowMs - createdAt > STAFFING_PROPOSAL_TTL_MS;
}

/** True when the slate is non-empty, small, and every seat is a local bot —
 * such teams start without an owner confirmation round (see GROUP_TASK_LOCAL_AUTO_START_MAX_SEATS). */
export function isLocalOnlySmallSlate(plan: GroupTaskStaffingPlan): boolean {
  return plan.seats.length > 0
    && plan.seats.length <= GROUP_TASK_LOCAL_AUTO_START_MAX_SEATS
    && plan.seats.every((seat) => seat.source === 'local');
}

export function resolveStaffingOwnerGate(input: {
  triggeringWish: string;
  repliesAfterPropose: string[];
  persistedSkip?: boolean;
  /** Set when the slate qualifies for the all-local small-team auto-start. */
  localSmallSlate?: boolean;
  /**
   * Host-LLM intent labels, one per repliesAfterPropose entry in order
   * (null/missing/'other' = the judge saw no decisive intent in that reply).
   * See the vocabularies comment above: these labels carry multilingual
   * coverage; the regex overlay overrides them per reply where it is
   * decisive.
   */
  llmIntents?: Array<OwnerStaffingIntent> | null;
  /** Host-LLM judgment that the triggering wish asked to start WITHOUT
   * confirmation (multilingual coverage for detectSkipConfirmInWish). */
  llmWishSkip?: boolean | null;
}): { allowed: boolean; decision: GroupTaskStaffingOwnerDecision } {
  const replies = input.repliesAfterPropose;
  const llmIntents = Array.isArray(input.llmIntents) ? input.llmIntents : [];
  const labelToDecision: Record<Exclude<OwnerStaffingIntent, 'other'>, GroupTaskStaffingOwnerDecision> = {
    confirm: 'owner_confirmed',
    revise: 'owner_revise',
    cancel: 'owner_cancel',
    skip: 'skip_authorized',
  };
  let decided: { intent: GroupTaskStaffingOwnerDecision; index: number } | null = null;
  replies.forEach((reply, index) => {
    const kind = classifyOwnerStaffingReply(reply);
    const label: Exclude<OwnerStaffingIntent, 'other'> | null = kind !== 'unknown'
      ? kind
      : detectSkipConfirmInWish(reply)
        ? 'skip'
        : (llmIntents[index] && llmIntents[index] !== 'other' ? llmIntents[index] : null);
    if (label) decided = { intent: labelToDecision[label], index };
  });
  if (decided) {
    if (decided.intent === 'owner_revise') return { allowed: false, decision: 'owner_revise' };
    if (decided.intent === 'owner_cancel') return { allowed: false, decision: 'owner_cancel' };
    if (decided.intent === 'owner_confirmed') return { allowed: true, decision: 'owner_confirmed' };
    if (decided.intent === 'skip_authorized') return { allowed: true, decision: 'skip_authorized' };
  }
  if (detectSkipConfirmInWish(input.triggeringWish) || input.llmWishSkip === true || input.persistedSkip) {
    return { allowed: true, decision: 'skip_authorized' };
  }
  if (input.localSmallSlate) return { allowed: true, decision: 'local_auto_start' };
  return { allowed: false, decision: 'awaiting_owner' };
}

export function splitSessionMessagesForStaffingGate(
  messages: StaffingSessionMessage[],
  proposedAtMs: number,
): { triggeringWish: string; repliesAfterPropose: string[] } {
  const chronological = [...messages].sort((left, right) => left.timestamp - right.timestamp);
  const repliesAfterPropose: string[] = [];
  for (const message of chronological) {
    if (message.type !== 'user') continue;
    const content = String(message.content ?? '').trim();
    if (!content) continue;
    if (message.timestamp > proposedAtMs) repliesAfterPropose.push(content);
  }
  return {
    triggeringWish: pickTriggeringWishText(messages, proposedAtMs),
    repliesAfterPropose,
  };
}

export function localSeatMetabotIds(plan: GroupTaskStaffingPlan): number[] {
  return [...new Set(
    plan.seats
      .filter((seat) => seat.source === 'local' && Number.isInteger(seat.metabotId) && Number(seat.metabotId) > 0)
      .map((seat) => Number(seat.metabotId)),
  )];
}

/**
 * Canonical signature of a propose payload (title + goal + acceptance
 * criteria + NORMALIZED plan). Two proposes with the same signature describe
 * the exact same slate, so the second one must reuse the first proposal
 * instead of stacking a new row (propose idempotency; task #38 incident).
 * Both sides must pass the plan through normalizeStaffingPlan first — the
 * normalizer emits deterministic key order, making the JSON a stable key.
 */
export function staffingProposalPayloadKey(input: {
  title: string;
  goal: string;
  acceptanceCriteria?: string | null;
  plan: GroupTaskStaffingPlan;
}): string {
  return JSON.stringify({
    title: input.title,
    goal: input.goal,
    acceptanceCriteria: input.acceptanceCriteria?.trim() || null,
    plan: input.plan,
  });
}

export function localSeatNames(plan: GroupTaskStaffingPlan): string[] {
  return plan.seats
    .filter((seat) => seat.source === 'local' && seat.candidateName)
    .map((seat) => seat.candidateName);
}

export function remoteSeats(plan: GroupTaskStaffingPlan): GroupTaskStaffingSeat[] {
  return plan.seats.filter((seat) => seat.source === 'remote');
}

export function buildStaffingSlateText(input: {
  title: string;
  goal: string;
  acceptanceCriteria?: string | null;
  plan: GroupTaskStaffingPlan;
  ownerConfirmRequired: boolean;
  /** Why confirmation is skipped — selects the tail-line copy. */
  skipReason?: 'wish' | 'local_small';
  language?: 'zh' | 'en';
}): string {
  const language = input.language ?? groupTaskLanguage();
  const zh = language !== 'en';
  const roleLabel = (seat: GroupTaskStaffingSeat): string => {
    if (seat.role === 'domain') {
      // Seat instances must stay distinguishable in the slate text — the
      // owner reading the roster has to tell 甲 from 乙 at a glance.
      const instance = seat.seatInstance ? ` · ${seat.seatInstance}` : '';
      return zh
        ? `领域（${seat.domainLabel || '未标注'}${instance}）`
        : `domain (${seat.domainLabel || 'unspecified'}${instance})`;
    }
    const labels: Record<Exclude<GroupTaskSeatRole, 'domain'>, [string, string]> = {
      content: ['内容', 'content'],
      design: ['设计', 'design'],
      engineering: ['工程', 'engineering'],
      promotion: ['推广', 'promotion'],
    };
    return zh ? labels[seat.role][0] : labels[seat.role][1];
  };
  const lines: string[] = [];
  if (zh) {
    lines.push(`按你的目标「${input.title}」，我拆成 ${input.plan.seats.length} 个粗岗位（调查是每个岗位的基础能力，不单设岗），准备这 ${input.plan.seats.length} 个人（加我一共 ${input.plan.seats.length + 1} 人）：`);
  } else {
    lines.push(`For "${input.title}", I split the work into ${input.plan.seats.length} coarse seat(s) (research is a basic capability of every seat). Proposed team: ${input.plan.seats.length} specialist(s) + me as chair = ${input.plan.seats.length + 1}:`);
  }
  for (const seat of input.plan.seats) {
    const origin = seat.source === 'remote'
      ? (zh ? '**在线，非本机**' : '**online, remote**')
      : (zh ? '本机' : 'local');
    const reason = seat.reason ? (zh ? ` · 理由：${seat.reason}` : ` · reason: ${seat.reason}`) : '';
    const backup = seat.backupName
      ? (zh ? `（备选：${seat.backupName}）` : ` (backup: ${seat.backupName})`)
      : '';
    lines.push(`- **${roleLabel(seat)}** — ${seat.candidateName}（${origin}）${backup}${reason}`);
  }
  if (input.plan.stages.length > 0) {
    lines.push('');
    lines.push(zh ? '工序：' : 'Stages:');
    for (const stage of input.plan.stages) {
      lines.push(`- ${stage.title}`);
    }
  }
  if (input.acceptanceCriteria?.trim()) {
    lines.push('');
    lines.push(zh ? `验收：${input.acceptanceCriteria.trim()}` : `Acceptance: ${input.acceptanceCriteria.trim()}`);
  }
  lines.push('');
  if (input.ownerConfirmRequired) {
    lines.push(zh
      ? '请看是否合理。可以说换人、去掉某岗，或直接回复确认——任何明确同意的表述都可以（如「确认 / 可以 / 就这样吧 / OK」）。没确认前我不会建群。'
      : 'Please confirm this roster, ask to swap/drop a seat, or reply with any clear approval ("OK", "looks good", "确认"). I will not create the group until you confirm.');
  } else if (input.skipReason === 'local_small') {
    lines.push(zh
      ? '这份名单全是本机成员且规模不大，无需确认。我将直接开群；若名单不合适，告诉我换人或去掉某个岗位即可。'
      : 'This slate is all local and small, so it needs no confirmation. I will create the group with it directly; if the lineup is off, just tell me to swap or drop a seat.');
  } else {
    lines.push(zh
      ? '你已经说了不用确认人选，我将按这份名单直接开群。'
      : 'You asked to skip roster confirmation; I will create the group with this slate.');
  }
  return lines.join('\n');
}

export function assertCreateRosterCap(workerCount: number): void {
  const teamSize = workerCount + 1;
  if (teamSize > GROUP_TASK_HARD_TEAM_SIZE) {
    throw new GroupTaskStaffingError(
      'ROSTER_CAP_EXCEEDED',
      `Group task roster ${teamSize} exceeds the hard cap of ${GROUP_TASK_HARD_TEAM_SIZE} (including the Twin chair).`,
    );
  }
}
