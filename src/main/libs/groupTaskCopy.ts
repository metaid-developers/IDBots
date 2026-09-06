/**
 * Host-authored group-task copy (zh/en).
 *
 * Pure: no Electron import. Production wires {@link setGroupTaskCopyLanguageGetter}
 * to {@link getPersistedAppLanguage} so English Settings never fall back to
 * Chinese. Tests leave the getter unset and therefore stay on zh, matching
 * the existing Chinese fixtures.
 *
 * Protocol tags ([WORKING], [GROUP_TASK_REVIEW], …) stay ASCII. Human-readable
 * wrappers around them follow the owner language. Group-chat host lines also
 * carry a language-neutral `[GROUP_TASK_NOTICE:<kind>]` prefix so the UI can
 * detect them without matching Chinese.
 */

import type { AppLanguage } from './inferLanguageFromLocale';

export type { AppLanguage };

let languageGetter: (() => AppLanguage) | null = null;

export function setGroupTaskCopyLanguageGetter(getter: (() => AppLanguage) | null): void {
  languageGetter = getter;
}

export function groupTaskLanguage(): AppLanguage {
  try {
    return languageGetter?.() === 'en' ? 'en' : 'zh';
  } catch {
    return 'zh';
  }
}

export function pickCopy(zh: string, en: string, language: AppLanguage = groupTaskLanguage()): string {
  return language === 'en' ? en : zh;
}

export const GROUP_TASK_NOTICE = {
  welcome: 'welcome',
  reviewClosing: 'review_closing',
  reviewSummary: 'review_summary',
  checkpointOpen: 'checkpoint_open',
  checkpointResolved: 'checkpoint_resolved',
  longTurn: 'long_turn',
  dispatchHeld: 'dispatch_held',
  supervisor: 'supervisor',
  statusParser: 'status_parser',
} as const;

export type GroupTaskNoticeKind = (typeof GROUP_TASK_NOTICE)[keyof typeof GROUP_TASK_NOTICE];

export function groupTaskNoticePrefix(kind: GroupTaskNoticeKind): string {
  return `[GROUP_TASK_NOTICE:${kind}]`;
}

export function withGroupTaskNotice(kind: GroupTaskNoticeKind, body: string): string {
  return `${groupTaskNoticePrefix(kind)}\n${body}`;
}

export function hasGroupTaskNotice(content: string, kind?: GroupTaskNoticeKind): boolean {
  const text = String(content ?? '').trimStart();
  if (kind) return text.startsWith(groupTaskNoticePrefix(kind));
  return text.startsWith('[GROUP_TASK_NOTICE:');
}

/**
 * Fold detector for the host acceptance checklist (group transcript).
 * Prefers the language-neutral notice prefix; keeps the pre-i18n Chinese
 * opening so historical messages still fold.
 */
export function isAcceptanceSummaryNotice(content: string): boolean {
  const text = String(content ?? '').trimStart();
  if (text.startsWith(groupTaskNoticePrefix(GROUP_TASK_NOTICE.reviewSummary))) return true;
  return text.startsWith('📦 任务「') && text.includes('已进入验收阶段');
}

/** Presence roll-call — not a work assignment. Must match both host languages. */
const ROLL_CALL_RE = /请确认在线|确认在线|confirm you(?:['’]re| are) online|please confirm (?:you are )?online/i;

export function isRollCallPresenceCheck(content: string): boolean {
  return ROLL_CALL_RE.test(String(content ?? ''));
}

export function buildMemberJoinWelcomeText(
  input: {
    taskId?: number;
    taskTitle: string;
    joinerName: string;
    invitedFor?: string | null;
    existingMemberNames: string[];
  },
  language: AppLanguage = groupTaskLanguage(),
): string {
  const names = input.existingMemberNames.map((name) => name.trim()).filter(Boolean);
  const invitedFor = input.invitedFor?.trim() ?? '';
  const why = invitedFor
    ? pickCopy(`受邀参与:${invitedFor}`, `Invited for: ${invitedFor}`, language)
    : pickCopy('受邀参与本任务协作', 'Invited to collaborate on this task', language);
  const lines = language === 'en'
    ? [
      `🎉 Welcome @${input.joinerName} to task "${input.taskTitle}"!`,
      `${input.joinerName} ${why}.`,
      `@${input.joinerName}: Please greet the group to confirm you are present, then start work.`,
    ]
    : [
      `🎉 欢迎 @${input.joinerName} 加入任务「${input.taskTitle}」!`,
      `${input.joinerName} ${why}。`,
      `@${input.joinerName}:请先向群内打个招呼确认就位,再开始工作。`,
    ];
  if (names.length > 0) {
    const mentions = names.map((name) => `@${name}`).join(' ');
    lines.push(
      language === 'en'
        ? `${mentions}: Please confirm you are online (once each, no small talk).`
        : `${mentions}:请确认在线(每人一次即可,无需客套)。`,
    );
  }
  return withGroupTaskNotice(GROUP_TASK_NOTICE.welcome, lines.join('\n'));
}

export function buildReviewClosingLine(
  taskTitle: string,
  language: AppLanguage = groupTaskLanguage(),
): string {
  const body = language === 'en'
    ? `📦 Task "${taskTitle}" has completed every step and entered acceptance. Waiting for human review.`
    : `📦 任务「${taskTitle}」所有步骤已完成,进入验收阶段,等待人类评审。`;
  return withGroupTaskNotice(GROUP_TASK_NOTICE.reviewClosing, body);
}

export function copyDefaultObserverExpectation(language: AppLanguage = groupTaskLanguage()): string {
  return pickCopy('静默观察 / 待命接手 / 可退出', 'observe silently / stand by / may leave', language);
}

export function copyObserverSectionHeader(language: AppLanguage = groupTaskLanguage()): string {
  return pickCopy('未派活成员预期（observer/standby）：', 'Unassigned members (observer/standby):', language);
}

export function copyObserverLine(
  name: string,
  expectation: string,
  language: AppLanguage = groupTaskLanguage(),
): string {
  return language === 'en' ? `- ${name}: ${expectation}` : `- ${name}：${expectation}`;
}

export function copyWorkingAckFallback(
  objective: string,
  language: AppLanguage = groupTaskLanguage(),
): string {
  return language === 'en'
    ? `[WORKING] On it: "${objective}". Will take a little time.`
    : `[WORKING] 已接单，正在处理「${objective}」，预计需要一些时间。`;
}

export function copyWorkingAckExample(language: AppLanguage = groupTaskLanguage()): string {
  return language === 'en'
    ? '[WORKING] On it: X, ETA N min'
    : '[WORKING] 已接单，正在做X，预计N分钟';
}

/**
 * fix/group-task-flow (task #51 feedback): host-posted liveness lines for a
 * turn that is still running. Posted AS the working bot so the group sees
 * progress instead of silence. Deliberately numberless (never parsed as an
 * ETA, arms no delivery deadline) and question-free, URI-free and short —
 * isCeremonyAckLine must keep classifying them as ceremony so they never
 * drive a chair turn by themselves.
 */
export function copyLongTurnInProgress(
  language: AppLanguage = groupTaskLanguage(),
): string {
  return language === 'en'
    ? '[WORKING] Still on it — this step is taking a while; progress is normal and I will report as soon as it lands.'
    : '[WORKING] 仍在执行中——本步骤耗时较长，进展正常，完成后会立即汇报。';
}

export function copyLongTurnHeartbeat(
  language: AppLanguage = groupTaskLanguage(),
): string {
  return language === 'en'
    ? '[WORKING] Long step still running in the background; everything is fine — will report the moment it completes.'
    : '[WORKING] 长步骤仍在后台执行，一切正常，完成后第一时间汇报进展。';
}

/**
 * Speedup R-01: the ONE proactive reminder for a turn that has run past the
 * long-turn reminder threshold. Posted as the working bot, addressed to the
 * chair; the member is NOT expected to reply (it is mid-turn). Deliberately
 * carries no protocol tags beyond the host-notice envelope, so it never arms
 * ACK watches or delivery deadlines when it round-trips through the daemon.
 *
 * Task #64: when the member never ACKed the assignment (ackPending), the
 * blanket "execution appears normal, no reply needed" claim gaslights the
 * chair out of acting on the earlier no-ACK warning — the notice then says
 * the ACK is still outstanding instead.
 */
export function copyLongTurnChairReminder(
  memberName: string,
  minutes: number,
  opts?: { ackPending?: boolean; language?: AppLanguage },
): string {
  const language = opts?.language ?? groupTaskLanguage();
  if (opts?.ackPending) {
    return language === 'en'
      ? `@chair ℹ️ ${memberName}'s turn has been running for over ${minutes} min with no new group message. ` +
        `NOTE: ${memberName} has NOT sent a [WORKING] ACK for the assignment yet — once this turn ends, ` +
        'verify the assignment was actually received and re-dispatch if it was not.'
      : `@chair ℹ️ ${memberName} 的回合已执行超过 ${minutes} 分钟，期间无新群消息。` +
        `注意：${memberName} 尚未对派单回过 [WORKING] ACK——回合结束后请确认派单确实送达，未送达请重新派发。`;
  }
  return language === 'en'
    ? `@chair ℹ️ ${memberName}'s turn has been running for over ${minutes} min with no new group message. ` +
      'Execution appears normal and the member need not reply before delivering — intervene only if this far exceeds the expected duration.'
    : `@chair ℹ️ ${memberName} 的回合已执行超过 ${minutes} 分钟，期间无新群消息。` +
      '执行看似正常，成员交付前无需回应——仅当明显超出预期时长时再介入。';
}

export function copyStandbyExample(language: AppLanguage = groupTaskLanguage()): string {
  return language === 'en'
    ? '[STANDBY] observing / on standby / can exit'
    : '[STANDBY] 静默观察 / 待命接手 / 可退出';
}

export function copyCorrectionApplied(
  id: number,
  kind: string,
  uri: string,
  language: AppLanguage = groupTaskLanguage(),
): string {
  return language === 'en'
    ? `✓ Correction applied: deliverable #${id} (${kind}) updated in place to ${uri}`
    : `✓ 更正优先：交付物 #${id}（${kind}）已就地更新为 ${uri}`;
}

export function copyPinidNotSynced(
  pinPrefix: string,
  language: AppLanguage = groupTaskLanguage(),
): string {
  return language === 'en'
    ? `… Host verification: pinid ${pinPrefix}… not synced (indexer lag, sources disagree); will retry`
    : `… Host verification: pinid ${pinPrefix}… 未同步（索引延迟，多源不一致），将自动重试`;
}

export function copyLocalDeliverableOnChain(
  uri: string,
  language: AppLanguage = groupTaskLanguage(),
): string {
  return language === 'en'
    ? `✓ Local deliverable published on-chain as ${uri}`
    : `✓ 本地交付物已上链为 ${uri}`;
}

export function copyLocalDeliverableNoPin(
  filePath: string,
  language: AppLanguage = groupTaskLanguage(),
): string {
  return language === 'en'
    ? `⚠ Local deliverable upload returned no pinId: ${filePath}`
    : `⚠ 本地交付物上传未返回 pinId：${filePath}`;
}

export function copyLocalDeliverableUploadFailed(
  filePath: string,
  language: AppLanguage = groupTaskLanguage(),
): string {
  return language === 'en'
    ? `⚠ Local deliverable upload failed (${filePath})`
    : `⚠ 本地交付物上传失败（${filePath}）`;
}

export function copyCheckpointNeedDecision(
  summary: string,
  language: AppLanguage = groupTaskLanguage(),
): string {
  return language === 'en' ? ` Decision needed: ${summary}` : ` 需要你拍板：${summary}`;
}

export function buildCheckpointPauseLine(input: {
  taskId: number;
  taskTitle: string;
  topic: string | null;
  summaryClause: string;
}, language: AppLanguage = groupTaskLanguage()): string {
  const topic = (input.topic ?? '').trim()
    || pickCopy('等待主人决策', 'awaiting owner decision', language);
  const body = language === 'en'
    ? `⏸️ Task #${input.taskId} "${input.taskTitle}" entered a human checkpoint (${topic}): `
      + `work is paused pending the owner's reply.${input.summaryClause}`
      + ' The owner can reply in this group or privately to Twinbot.'
    : `⏸️ 任务 #${input.taskId}「${input.taskTitle}」进入人工确认点（${topic}）：`
      + `任务暂停推进，等待主人反馈。${input.summaryClause}`
      + '主人可直接在本群留言，或与 Twinbot 私聊给出意见。';
  return withGroupTaskNotice(GROUP_TASK_NOTICE.checkpointOpen, body);
}

export function buildCheckpointResumeLine(input: {
  taskId: number;
  taskTitle: string;
  resolution: string | null;
}, language: AppLanguage = groupTaskLanguage()): string {
  const resolution = (input.resolution ?? '').trim()
    || pickCopy('主人已确认', 'owner confirmed', language);
  const body = language === 'en'
    ? `▶️ Task #${input.taskId} "${input.taskTitle}" checkpoint passed (${resolution}); work continues.`
    : `▶️ 任务 #${input.taskId}「${input.taskTitle}」人工确认点已通过（${resolution}），任务继续推进。`;
  return withGroupTaskNotice(GROUP_TASK_NOTICE.checkpointResolved, body);
}

export function buildLongTurnStandbyNote(
  memberName: string,
  language: AppLanguage = groupTaskLanguage(),
): string {
  const body = language === 'en'
    ? `@chair ℹ️ ${memberName} is in a long-running turn (recent progress/delivery). New assignments will wait until this turn finishes; no action needed.`
    : `@chair ℹ️ ${memberName} 正在长回合执行中（近期有进展/交付），新派单将在本回合结束后处理，无需干预。`;
  return withGroupTaskNotice(GROUP_TASK_NOTICE.longTurn, body);
}

// ---------------------------------------------------------------------------
// G-04: supervisor intervention copy. The in-group [GROUP_TASK_NOTICE:
// supervisor] notice post was REMOVED by the single-commander architecture
// (task #65 acceptance): nothing impersonates the chair in the group anymore.
// Signals ride the chair's own turn context; only the note cap remains.
// ---------------------------------------------------------------------------

/** Cap for a supervisor signal note (ledger + chair directive). */
export const SUPERVISOR_NOTE_MAX_CHARS = 500;

/**
 * Host notice when a worker-addressed dispatch was swallowed by a human-gate
 * phase (open HITL checkpoint or review): workers stay silent by design, so
 * without this line the chair believes the dispatch failed or the workers
 * are broken (task #39: the chair @-dispatched into an open checkpoint and
 * spent hours assuming the members were unresponsive).
 */
export function buildDispatchHeldLine(input: {
  taskId: number;
  taskTitle: string;
  senderName: string;
  memberNames: string[];
  gate: 'checkpoint' | 'review';
  checkpointTopic?: string | null;
}, language: AppLanguage = groupTaskLanguage()): string {
  const names = input.memberNames.join(language === 'en' ? ', ' : '、');
  const gateText = input.gate === 'checkpoint'
    ? (language === 'en'
      ? `a human checkpoint is open${input.checkpointTopic?.trim() ? ` (${input.checkpointTopic.trim()})` : ''}`
      : `人工确认点未关闭${input.checkpointTopic?.trim() ? `（${input.checkpointTopic.trim()}）` : ''}`)
    : (language === 'en' ? 'the task is in the review phase' : '任务处于验收（review）阶段');
  const resume = input.gate === 'checkpoint'
    ? (language === 'en'
      ? 'Once the owner has weighed in, post `[CHECKPOINT_RESOLVED: <decision>]` in the group, then re-send the dispatch — the members will answer it.'
      : '主人给出意见后，在群里发 `[CHECKPOINT_RESOLVED: <决定>]`，然后重新派发该工作——成员届时会正常响应。')
    : (language === 'en'
      ? 'Reopen execution with `[STATUS:EXECUTING]` (or the Tasks panel Back-to-work action), then re-send the dispatch.'
      : '用 `[STATUS:EXECUTING]`（或 Tasks 面板的返回执行）恢复执行后重新派发。');
  const body = language === 'en'
    ? `⏸️ A dispatch from ${input.senderName} to ${names} was HELD: ${gateText}. `
      + 'Workers stay silent by design in this phase, so the dispatch will NOT be executed as sent. '
      + resume
    : `⏸️ ${input.senderName} 刚向 ${names} 派发了工作，但${gateText}：该阶段成员按规则保持沉默，这条派工不会被执行。`
      + resume;
  return withGroupTaskNotice(GROUP_TASK_NOTICE.dispatchHeld, body);
}

/**
 * GT-04 (task #56): in-group explanation when the host's status-tag parser
 * applied and/or rejected [STATUS:*] directives in a chair message. The old
 * "end-line tag wins" rule rejected task #56's descriptive end-line REVIEW
 * and silently dropped its legitimate mid-message EXECUTING — the group saw
 * nothing and the task pinned in planning forever. Now every rejection is
 * visible where the chair can read and correct it. Rejected tags are wrapped
 * in backticks so the notice's own citations are never re-read as
 * instructions (the escape hatch the parser itself honors).
 */
export function buildStatusDirectiveNote(input: {
  taskId: number;
  taskTitle: string;
  /** The tag that was applied (null when every candidate was rejected). */
  appliedTag: 'executing' | 'review' | null;
  /** Task status when the message was parsed (rejection reasons refer to it). */
  fromStatus: string;
  /** Rejected tags with their illegal from-status, in message order. */
  rejected: Array<{ tag: 'executing' | 'review'; fromStatus: string }>;
  /** Chair-movable tags from legalMovesStatus (may be empty). */
  legalMoves: Array<'executing' | 'review'>;
  /** The status the legal-moves list applies to (post-transition when one applied). */
  legalMovesStatus: string;
}, language: AppLanguage = groupTaskLanguage()): string {
  const tagText = (tag: 'executing' | 'review') => `[STATUS:${tag.toUpperCase()}]`;
  const rejectedText = (tag: 'executing' | 'review', fromStatus: string) =>
    language === 'en'
      ? `\`${tagText(tag)}\` (${fromStatus} -> ${tag} is not a legal transition)`
      : `\`${tagText(tag)}\`（${fromStatus} -> ${tag} 不是合法的状态迁移）`;
  const legalText = input.legalMoves.length > 0
    ? input.legalMoves.map(tagText).join(language === 'en' ? ' or ' : ' 或 ')
    : (language === 'en' ? 'none — only the owner can move this task now' : '无——当前只有主人能推进该任务');
  const tip = language === 'en'
    ? 'Tip: put ONE bare [STATUS:*] tag on its own line or at the end of your message; tags wrapped in `backticks` are treated as citations, never instructions.'
    : '提示：把单个裸 [STATUS:*] 标签独立成行或放在消息末尾；用 `反引号` 包裹的标签只视为引用，不会被执行。';
  const lines: string[] = [];
  if (input.appliedTag) {
    // The applied tag is backtick-wrapped like the rejected ones: this note
    // is chair-facing prose, and a bare [STATUS:*] in it must never read as
    // an instruction if a future parser stops exempting host notices.
    lines.push(
      language === 'en'
        ? `⚙️ Status update applied: \`${tagText(input.appliedTag)}\` — task moved ${input.fromStatus} -> ${input.appliedTag}.`
        : `⚙️ 状态已更新：\`${tagText(input.appliedTag)}\`——任务从 ${input.fromStatus} 迁移到 ${input.appliedTag}。`,
    );
    if (input.rejected.length > 0) {
      lines.push(
        language === 'en'
          ? `However, ${input.rejected.length === 1 ? 'another tag' : 'other tags'} in the same message ${input.rejected.length === 1 ? 'was' : 'were'} REJECTED: ${input.rejected.map((entry) => rejectedText(entry.tag, entry.fromStatus)).join('; ')}.`
          : `但同一条消息里的 ${input.rejected.length} 个标签被拒绝：${input.rejected.map((entry) => rejectedText(entry.tag, entry.fromStatus)).join('；')}。`,
      );
    }
  } else {
    lines.push(
      language === 'en'
        ? `⚠️ No status change applied: ${input.rejected.map((entry) => rejectedText(entry.tag, entry.fromStatus)).join('; ')}. The task stays in ${input.fromStatus}.`
        : `⚠️ 状态未变更：${input.rejected.map((entry) => rejectedText(entry.tag, entry.fromStatus)).join('；')}。任务保持在 ${input.fromStatus}。`,
    );
  }
  lines.push(
    language === 'en'
      ? `Legal status moves from ${input.legalMovesStatus}: ${legalText}. ${tip}`
      : `从 ${input.legalMovesStatus} 出发的合法状态操作：${legalText}。${tip}`,
  );
  return withGroupTaskNotice(GROUP_TASK_NOTICE.statusParser, lines.join('\n'));
}

/**
 * Task #63: in-group note when a chair message cited a [STATUS:*] tag ONLY as
 * descriptive prose (mid-sentence / non-standalone line) while at least one of
 * the cited tags is a legal move from the live status and nothing applied.
 * Task #63's chair bolded its verdict line in a wrap-up report — the parser
 * (pre-fix) filed it as descriptive, the task parked in executing for 34 min,
 * and the chair answered the supervisor nudges with "false alarm" because its
 * own memory said the verdict was announced. The note makes the miss visible
 * in the group the moment it happens, so the chair re-sends a bare tag on its
 * next turn instead of waiting out the 20-min nudge cycle. Cited tags are
 * backtick-wrapped so the notice itself can never be re-read as an instruction.
 */
export function buildDescriptiveStatusNote(input: {
  taskId: number;
  taskTitle: string;
  /** Descriptive tags that would be legal moves from fromStatus. */
  descriptive: Array<'executing' | 'review'>;
  fromStatus: string;
}, language: AppLanguage = groupTaskLanguage()): string {
  const tagText = (tag: 'executing' | 'review') => `\`[STATUS:${tag.toUpperCase()}]\``;
  const bareTagText = (tag: 'executing' | 'review') => `[STATUS:${tag.toUpperCase()}]`;
  const cited = input.descriptive.map(tagText).join(language === 'en' ? ' or ' : ' 或 ');
  const bareCited = input.descriptive.map(bareTagText).join(language === 'en' ? ' or ' : ' 或 ');
  const body = language === 'en'
    ? `⚠️ No status change applied: this message cited ${cited} only as descriptive text `
      + `(embedded in prose, not a bare tag on its own line / at the end). The task stays in ${input.fromStatus} `
      + `— check the authoritative host state line before assuming your earlier verdict landed. `
      + `If you intended the transition, post ONE new message containing only the bare tag `
      + `${bareCited} `
      + `(no bold, no backticks, no extra text); if this was a citation, no action is needed.`
    : `⚠️ 状态未变更：这条消息里的 ${cited} 只是描述性文字（嵌在正文中，不是独立成行/末尾的裸标签）。任务仍处于 ${input.fromStatus} `
      + `——在假设你先前的状态宣告已生效之前，请先核对权威宿主状态行。`
      + `如果你确实要迁移状态，请另发一条只含裸标签 `
      + `${bareCited} `
      + `的新消息（不加粗、不用反引号、不带其他文字）；若只是引用协议，则无需处理。`;
  return withGroupTaskNotice(GROUP_TASK_NOTICE.statusParser, body);
}

export function buildAcceptanceGuidanceText(language: AppLanguage = groupTaskLanguage()): string {
  return language === 'en'
    ? [
      'You can:',
      '1. On the Tasks panel acceptance card, tap Accept & Close and rate (1–5 stars + optional comment) — the task closes;',
      '2. On the card, tap Request Changes — execution resumes and the chair will assign follow-up work;',
      '3. Reply in the group — the chair will act on your feedback.',
    ].join('\n')
    : [
      '你可以：',
      '① 在 Tasks 面板的验收卡点「Accept & Close」并评分（1-5 星 + 可选评语）——任务关闭；',
      '② 在验收卡点「验收不通过」——返回执行，chair 会补派工作；',
      '③ 在群内直接回复意见——chair 会按你的意见处理。',
    ].join('\n');
}

export function acceptanceSummaryCopy(language: AppLanguage = groupTaskLanguage()): {
  header: (title: string) => string;
  conclusion: (text: string) => string;
  goal: (text: string) => string;
  criteria: (text: string) => string;
  criteriaEmpty: string;
      criteriaCheckTitle: string;
      criteriaPass: (text: string) => string;
      criteriaFail: (text: string) => string;
      criteriaUnclear: (text: string) => string;
      observationsTitle: string;
      supervisorSignalsTitle: string;
  emptyChecklist: string;
  checklistTitle: string;
  omittedProcess: (count: number) => string;
  planChangesTitle: string;
  omittedPlanChanges: (count: number) => string;
  timeBreakdownTitle: string;
  phaseLabel: (key: string) => string;
  breakdownTotals: (messageTotal: number, heartbeatSharePct: number) => string;
  breakdownAlerts: (alertTotal: number, falsePositives: number) => string;
  phaseLine: (key: string, minutes: number) => string;
  stepLine: (label: string, minutes: number) => string;
  members: (names: string) => string;
  memberJoin: string;
} {
  if (language === 'en') {
    const phaseLabels: Record<string, string> = {
      planning: 'planning',
      executing: 'executing',
      review: 'acceptance review',
      done: 'done',
      cancelled: 'cancelled',
    };
    return {
      header: (title) => `📦 Task "${title}" has entered acceptance. Here is the outcome summary.`,
      conclusion: (text) => `Conclusion: ${text}`,
      goal: (text) => `Goal: ${text}`,
      criteria: (text) => `Acceptance criteria: ${text}`,
      criteriaEmpty: '(not specified)',
      criteriaCheckTitle: 'Criteria check (as declared at creation):',
      criteriaPass: (text) => `- ✓ PASS — ${text}`,
      criteriaFail: (text) => `- ✗ FAIL — ${text}`,
      criteriaUnclear: (text) => `- ? UNVERIFIED — ${text}`,
      observationsTitle: 'Observations (outside the declared criteria — NOT blocking):',
      supervisorSignalsTitle: 'Supervisor interventions:',
      emptyChecklist: 'Deliverables: no verified artifacts.',
      checklistTitle: 'Deliverables:',
      omittedProcess: (count) => `(${count} process note(s) omitted; see the in-group report)`,
      planChangesTitle: 'Plan changes:',
      omittedPlanChanges: (count) => `(${count} more change(s); see the in-group log)`,
      timeBreakdownTitle: 'Time breakdown:',
      phaseLabel: (key) => phaseLabels[key] ?? key,
      breakdownTotals: (messageTotal, heartbeatSharePct) =>
        `Group messages: ${messageTotal} total; host heartbeat lines: ${heartbeatSharePct}%.`,
      breakdownAlerts: (alertTotal, falsePositives) =>
        `Host alerts: ${alertTotal} (false alarms acknowledged in-thread: ${falsePositives}).`,
      phaseLine: (key, minutes) => `- ${phaseLabels[key] ?? key}: ${minutes} min`,
      stepLine: (label, minutes) => `- ${label}: +${minutes} min`,
      members: (names) => `Members: ${names}`,
      memberJoin: ', ',
    };
  }
  const phaseLabels: Record<string, string> = {
    planning: '筹备派单',
    executing: '执行',
    review: '验收评审',
    done: '已完成',
    cancelled: '已取消',
  };
  return {
    header: (title) => `📦 任务「${title}」已进入验收阶段，以下为成果汇总。`,
    conclusion: (text) => `结论：${text}`,
    goal: (text) => `目标：${text}`,
    criteria: (text) => `验收标准：${text}`,
    criteriaEmpty: '（未填写）',
    criteriaCheckTitle: '验收标准对照（以创建时声明为准）：',
    criteriaPass: (text) => `- ✓ 通过 — ${text}`,
    criteriaFail: (text) => `- ✗ 未通过 — ${text}`,
    criteriaUnclear: (text) => `- ? 无法核实 — ${text}`,
    observationsTitle: '观察项（标准之外，不阻断验收）：',
    supervisorSignalsTitle: '监督者干预记录：',
    emptyChecklist: '成果清单：无已核验交付物。',
    checklistTitle: '成果清单：',
    omittedProcess: (count) => `（另有 ${count} 项过程记录，见群内报告）`,
    planChangesTitle: '方案变更：',
    omittedPlanChanges: (count) => `（另有 ${count} 项变更，见群内记录）`,
    timeBreakdownTitle: '耗时分解：',
    phaseLabel: (key) => phaseLabels[key] ?? key,
    breakdownTotals: (messageTotal, heartbeatSharePct) =>
      `群消息共 ${messageTotal} 条，其中宿主心跳占 ${heartbeatSharePct}%。`,
    breakdownAlerts: (alertTotal, falsePositives) =>
      `宿主告警共 ${alertTotal} 条，其中被群内确认为误报 ${falsePositives} 条。`,
    phaseLine: (key, minutes) => `- ${phaseLabels[key] ?? key}：${minutes} 分钟`,
    stepLine: (label, minutes) => `- ${label}：+${minutes} 分钟`,
    members: (names) => `成员：${names}`,
    memberJoin: '、',
  };
}

export function buildSourceSessionAcceptanceNotice(input: {
  title: string;
  outcome: 'done' | 'cancelled';
  ratingLine: string;
  commentLine: string;
  deliverableCount: number;
  summaryVersion: number | null;
}, language: AppLanguage = groupTaskLanguage()): string {
  if (language === 'en') {
    const artifacts = input.summaryVersion != null
      ? `Artifacts: ${input.deliverableCount} item(s) (see acceptance summary v${input.summaryVersion})`
      : `Artifacts: ${input.deliverableCount} item(s); see the Tasks panel`;
    return [
      `[GROUP_TASK_ACCEPTANCE] Task "${input.title}" acceptance finished:`,
      `Result: ${input.outcome}${input.ratingLine}${input.commentLine}`,
      artifacts,
    ].join('\n');
  }
  return [
    `[GROUP_TASK_ACCEPTANCE] 任务「${input.title}」已完成验收：`,
    `结果：${input.outcome}${input.ratingLine}${input.commentLine}`,
    `成果：${input.deliverableCount} 项${input.summaryVersion != null ? `（详见验收总结 v${input.summaryVersion}）` : '，详见 Tasks 面板'}`,
  ].join('\n');
}

export function copyAcceptanceRatingLine(
  rating: number,
  language: AppLanguage = groupTaskLanguage(),
): string {
  return language === 'en' ? ` | rating ${rating}/5` : `｜评分 ${rating}/5`;
}

export function copyAcceptanceCommentLine(
  comment: string,
  language: AppLanguage = groupTaskLanguage(),
): string {
  return language === 'en' ? ` (${comment})` : `（${comment}）`;
}

export function copyReviewVersionTag(
  version: number,
  language: AppLanguage = groupTaskLanguage(),
): string {
  return language === 'en' ? ` (acceptance summary v${version})` : `（验收摘要 v${version}）`;
}

export function buildSourceSessionReviewNotice(input: {
  title: string;
  versionTag: string;
  conclusion: string;
}, language: AppLanguage = groupTaskLanguage()): string {
  if (language === 'en') {
    return [
      `[GROUP_TASK_REVIEW] Task "${input.title}" has entered acceptance${input.versionTag}.`,
      `Conclusion: ${input.conclusion}`,
      'The full checklist and Accept & Close / Rework actions are on the Tasks panel acceptance card.',
    ].join('\n');
  }
  return [
    `[GROUP_TASK_REVIEW] 任务「${input.title}」已进入验收${input.versionTag}。`,
    `结论：${input.conclusion}`,
    '完整验收清单与 Accept & Close / Rework 操作见 Tasks 面板的验收卡。',
  ].join('\n');
}

export function buildSourceSessionReviewFallback(input: {
  title: string;
  body: string;
}, language: AppLanguage = groupTaskLanguage()): string {
  if (language === 'en') {
    return [
      `[GROUP_TASK_REVIEW] Task "${input.title}" has entered acceptance (host-generated summary; the chair's first-hand verdict is in the group):`,
      input.body,
    ].join('\n');
  }
  return [
    `[GROUP_TASK_REVIEW] 任务「${input.title}」已进入验收（系统生成验收汇总，chair 一手核验结论见群内）：`,
    input.body,
  ].join('\n');
}

export function copyReviewReportTruncated(
  body: string,
  language: AppLanguage = groupTaskLanguage(),
): string {
  return language === 'en'
    ? `${body}…\n(Report truncated — full acceptance summary is on the Tasks panel and in the group chair summary.)`
    : `${body}…\n（报告过长已截断——完整验收摘要见 Tasks 面板与群内 chair 摘要消息）`;
}

export function buildOrchNotifyCompleted(
  workerName: string,
  taskId: string | number,
  language: AppLanguage = groupTaskLanguage(),
): string {
  return language === 'en'
    ? `[ORCH-NOTIFY] worker ${workerName} completed task ${taskId} → review; please verify, then report the delivered result to the owner with each on-chain artifact's complete MetaWeb URI in full text (never abbreviated)`
    : `[ORCH-NOTIFY] worker ${workerName} 已完成 task ${taskId} → review，请验收；验收后向 owner 交付完整成果，每个链上成果附完整 MetaWeb URI（全文展示，不缩略）`;
}

export function buildOrchNotifyFailed(
  workerName: string,
  taskId: string | number,
  detail: string,
  language: AppLanguage = groupTaskLanguage(),
): string {
  return language === 'en'
    ? `[ORCH-NOTIFY] worker ${workerName} did not complete task ${taskId}: ${detail} (failed)`
    : `[ORCH-NOTIFY] worker ${workerName} 未完成 task ${taskId}：${detail}（failed）`;
}

export function wrapCrossSessionMessage(
  sourceSessionId: string,
  message: string,
  language: AppLanguage = groupTaskLanguage(),
): string {
  return language === 'en'
    ? `From ${sourceSessionId}: ${message}`
    : `来自${sourceSessionId} 的信息：${message}`;
}

// ---------------------------------------------------------------------------
// G-01: origin-session milestone notices. Each carries an ASCII protocol
// prefix (renderer/test detectable), the task identifier, the current status,
// and the next step or pending decision — and fires exactly once per node.
// ---------------------------------------------------------------------------

/** Shared pointer line: where the owner opens the task from a milestone notice. */
function taskPanelPointerLine(language: AppLanguage): string {
  return language === 'en'
    ? 'Open the Tasks panel to follow this task in detail.'
    : '可在 Tasks 面板查看并跟进该任务详情。';
}

export function buildSourceSessionCreatedNotice(input: {
  title: string;
  status: string;
  memberNames: string[];
}, language: AppLanguage = groupTaskLanguage()): string {
  const members = input.memberNames.join(language === 'en' ? ', ' : '、');
  if (language === 'en') {
    return [
      `[GROUP_TASK_CREATED] Group task "${input.title}" is live (status: ${input.status}).`,
      `Members: ${members || '(none)'}`,
      `Next: the chair decomposes the goal and dispatches work; I will report the first dispatch here.`,
      taskPanelPointerLine(language),
    ].join('\n');
  }
  return [
    `[GROUP_TASK_CREATED] 群任务「${input.title}」已创建成功（状态：${input.status}）。`,
    `成员：${members || '（无）'}`,
    '下一步：chair 将拆解目标并派工；首轮派工完成后我会在此汇报。',
    taskPanelPointerLine(language),
  ].join('\n');
}

/** Cap for the dispatch plan text echoed into the origin session. */
export const SOURCE_SESSION_DISPATCH_MAX_CHARS = 1200;

export function buildSourceSessionDispatchNotice(input: {
  title: string;
  status: string;
  planText: string;
}, language: AppLanguage = groupTaskLanguage()): string {
  const plan = input.planText.trim();
  const capped = plan.length > SOURCE_SESSION_DISPATCH_MAX_CHARS
    ? `${plan.slice(0, SOURCE_SESSION_DISPATCH_MAX_CHARS).trimEnd()}…`
    : plan;
  if (language === 'en') {
    return [
      `[GROUP_TASK_DISPATCH] Group task "${input.title}" is now ${input.status}: the chair posted the first dispatch.`,
      'Dispatch (seat assignments and work stages):',
      capped,
      taskPanelPointerLine(language),
    ].join('\n');
  }
  return [
    `[GROUP_TASK_DISPATCH] 群任务「${input.title}」已进入 ${input.status}：chair 已完成首轮派工。`,
    '派工内容（各座位分工与工序）：',
    capped,
    taskPanelPointerLine(language),
  ].join('\n');
}

export function buildSourceSessionCheckpointNotice(input: {
  title: string;
  topic: string | null;
  summary: string;
}, language: AppLanguage = groupTaskLanguage()): string {
  const topic = (input.topic ?? '').trim();
  if (language === 'en') {
    return [
      `[GROUP_TASK_CHECKPOINT] Group task "${input.title}" reached a decision point${topic ? ` (${topic})` : ''} and is paused waiting for your call.`,
      input.summary.trim() || 'The chair has sent you the details privately; reply there or in the task group.',
      taskPanelPointerLine(language),
    ].join('\n');
  }
  return [
    `[GROUP_TASK_CHECKPOINT] 群任务「${input.title}」到达需要你决策的节点${topic ? `（${topic}）` : ''}，任务已暂停等待你的决定。`,
    input.summary.trim() || 'chair 已将详情私发给你；可直接回复，或在任务群内留言。',
    taskPanelPointerLine(language),
  ].join('\n');
}

export function buildSourceSessionAnomalyNotice(input: {
  title: string;
  status: string;
  summary: string;
}, language: AppLanguage = groupTaskLanguage()): string {
  if (language === 'en') {
    return [
      `[GROUP_TASK_ALERT] Group task "${input.title}" (status: ${input.status}) hit an anomaly:`,
      input.summary.trim(),
      taskPanelPointerLine(language),
    ].join('\n');
  }
  return [
    `[GROUP_TASK_ALERT] 群任务「${input.title}」（状态：${input.status}）出现异常：`,
    input.summary.trim(),
    taskPanelPointerLine(language),
  ].join('\n');
}

export function copyRespondingPlaceholder(language: AppLanguage = groupTaskLanguage()): string {
  return pickCopy('响应中…', 'Responding…', language);
}

export function copyMetabotNotFound(language: AppLanguage = groupTaskLanguage()): string {
  return pickCopy('未找到指定的 MetaBot', 'The specified MetaBot was not found', language);
}

export function copyOwnerLanguageName(language: AppLanguage = groupTaskLanguage()): string {
  return language === 'en' ? 'English' : 'Chinese (Simplified)';
}

export function copyConclusionTagInstruction(language: AppLanguage = groupTaskLanguage()): string {
  return language === 'en'
    ? 'the FIRST line of your report must be exactly `Conclusion: <one line, ≤80 chars>` (the host also accepts `【结论】`).'
    : 'the FIRST line of your report must be exactly 【结论】<one line, ≤80 chars> (the host also accepts `Conclusion:`).';
}

export function copyGuestHandshakeExample(
  language: AppLanguage = groupTaskLanguage(),
): string {
  return language === 'en'
    ? '`Hi everyone, I am <your name>, present and ready to start.`'
    : '`大家好，我是<your name>，已就位，随时可以开始。`';
}
