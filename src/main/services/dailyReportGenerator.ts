/**
 * Daily Report (每日汇报) generator — turns the collector's facts into the
 * briefing that lands in the Twin chat and the self-contained HTML report
 * file.
 *
 * v2 owner rework (2026-10-26): the briefing is an EA-style boss brief with
 * two artifacts that share nothing but per-bot one-liners:
 *
 * 1. Chat markdown (the 10-second scan): brain prose in three fixed sections
 *    — 昨日总览 (overview naming the main lines AND notable external
 *    interactions), 各 Bot 一句话 (exactly one line per active bot folding in
 *    local sessions incl. orchestrations, scheduled runs, external DM peers,
 *    OpenTeam participation and on-chain interactions), 需要你拍板 (blockers
 *    with a suggested action, only when warranted) — followed by the
 *    deterministic follow-up deep links and 今日预告 (next-24h scheduled
 *    fires + open orchestrations). The v1 per-bot COUNTS table is gone.
 * 2. HTML visual report (different content, not a markdown duplicate): KPI
 *    cards, a 24h activity chart, per-bot cards with activity meters,
 *    needs-you cards, main-line progress and the day's agenda — inline SVG
 *    only, no external dependencies.
 *
 * Deterministic assembler (NEVER delegated to the LLM): the follow-up list
 * with `[title](idbots://session/<id>)` deep links and overdue badges, the
 * agenda, every number, chart and meter in the HTML. Ids and links are
 * attached here — the brain only ever sees titles, so it can never invent a
 * wrong link.
 *
 * Brain prose: ONE chat-completion call (dream-style ladder injected by the
 * service: twin/system brain primary → fallback) writes the three sections.
 * Bounded input (facts JSON ≤80KB), bounded output (~2000 tokens), 120s wall
 * timeout. On timeout/failure/no-brain the report degrades to the
 * deterministic briefing (owner-task table, machine rollups, deterministic
 * bot lines) — the report always ships.
 *
 * Language: the deterministic strings come from a small zh/en table selected
 * by the UI locale at generation time (default English, Chinese when the
 * locale is zh); each locale's brain prompt is locale-native and requires the
 * output to follow the USER'S UI language (owner rework 2026-10-23: English
 * headings leaked into a Chinese report — hence the fixed verbatim headings
 * parsed back by parseDailyReportBrainProse).
 *
 * Kept free of runtime relative imports so plain-Node tests can load it with
 * type stripping (fs/path/node:url only).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { DailyReportBotActivity, DailyReportFacts } from './dailyReportCollector';

/** Local YYYY-MM-DD (inlined so this module stays free of runtime relative
 * imports — plain-Node tests load it with type stripping). */
const formatLocalDate = (ms: number): string => {
  const d = new Date(ms);
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
};

// ── Locale strings ─────────────────────────────────────────────────────────

export type DailyReportLanguage = 'en' | 'zh';

export interface DailyReportStrings {
  language: DailyReportLanguage;
  reportTitle: string;
  windowLabel: string;
  needsYouTitle: string;
  followUpLinksTitle: string;
  overviewTitle: string;
  botsTitle: string;
  agendaTitle: string;
  fleetTitle: string;
  overdueBadge: string;
  waitingDaysSuffix: string;
  /** Badge for follow-ups whose work waits on an external condition
   * (shown instead of the overdue badge — nobody here is late). */
  waitingBadge: string;
  ownerTasksIntro: string;
  columnTask: string;
  columnStatus: string;
  columnSteps: string;
  columnProgress: string;
  scheduledRunsLabel: string;
  allSucceededLabel: string;
  failedSkippedLabel: string;
  groupTasksRollupLabel: string;
  twinDelegateIntro: string;
  longTermIntro: string;
  stepsDone: string;
  viewFullReport: string;
  fallbackHeadline: string;
  generatedAtLabel: string;
  newSessionsMetaLabel: string;
  /* v2 briefing vocabulary */
  agendaFiresLabel: string;
  agendaFiresMoreSuffix: string;
  agendaOpenOrchLabel: string;
  agendaLongTermLabel: string;
  sessionsWord: string;
  messagesWord: string;
  runsWord: string;
  dmWord: string;
  groupMessagesWord: string;
  chainWord: string;
  likeWord: string;
  commentWord: string;
  openTeamWord: string;
  twinTag: string;
  withPeerWord: string;
  /* v2 HTML vocabulary */
  htmlNeedsYou: string;
  htmlOwnerTasks: string;
  htmlLongTerm: string;
  htmlBotsTitle: string;
  htmlProgressTitle: string;
  htmlAgendaTitle: string;
  htmlChartTitle: string;
  htmlChartLocal: string;
  htmlChartOnline: string;
  htmlKpiBots: string;
  htmlKpiSessions: string;
  htmlKpiMessages: string;
  htmlKpiRuns: string;
  htmlKpiOnline: string;
  htmlAllSucceeded: string;
  htmlStatus: string;
  htmlSteps: string;
}

export const DAILY_REPORT_STRINGS_EN: DailyReportStrings = {
  language: 'en',
  reportTitle: 'Daily Report',
  windowLabel: 'Window',
  needsYouTitle: 'Needs you',
  followUpLinksTitle: 'Follow-up links',
  overviewTitle: 'Yesterday at a glance',
  botsTitle: 'Bot one-liners',
  agendaTitle: 'Today ahead',
  fleetTitle: 'Fleet & automation',
  overdueBadge: 'overdue',
  waitingDaysSuffix: 'd waiting',
  waitingBadge: 'waiting on external',
  ownerTasksIntro: 'Owner-sourced tasks:',
  columnTask: 'Task',
  columnStatus: 'Status',
  columnSteps: 'Steps',
  columnProgress: 'Progress',
  scheduledRunsLabel: 'Scheduled runs',
  allSucceededLabel: 'all succeeded',
  failedSkippedLabel: 'failed/skipped',
  groupTasksRollupLabel: 'Group task updates',
  twinDelegateIntro: 'Twin-delegated orchestrations touched:',
  longTermIntro: 'Long-term projects:',
  stepsDone: 'steps done',
  viewFullReport: 'View the visual report',
  fallbackHeadline: 'Here is your daily briefing.',
  generatedAtLabel: 'Generated',
  newSessionsMetaLabel: 'New sessions',
  agendaFiresLabel: 'Scheduled tasks',
  agendaFiresMoreSuffix: '+{n} more',
  agendaOpenOrchLabel: 'Open orchestrations',
  agendaLongTermLabel: 'Long-term projects',
  sessionsWord: 'sessions',
  messagesWord: 'messages',
  runsWord: 'runs',
  dmWord: 'DMs',
  groupMessagesWord: 'group msgs',
  chainWord: 'on-chain',
  likeWord: 'likes',
  commentWord: 'comments',
  openTeamWord: 'OpenTeam',
  twinTag: 'Twin',
  withPeerWord: 'with',
  htmlNeedsYou: 'Needs you',
  htmlOwnerTasks: 'Owner tasks',
  htmlLongTerm: 'Long-term projects',
  htmlBotsTitle: 'What each bot did',
  htmlProgressTitle: 'Main lines',
  htmlAgendaTitle: 'Today ahead',
  htmlChartTitle: '24h activity',
  htmlChartLocal: 'Local session messages',
  htmlChartOnline: 'Online messages (own scale)',
  htmlKpiBots: 'Bots active',
  htmlKpiSessions: 'Active sessions',
  htmlKpiMessages: 'Local messages',
  htmlKpiRuns: 'Scheduled runs',
  htmlKpiOnline: 'Online msgs',
  htmlAllSucceeded: 'all succeeded',
  htmlStatus: 'Status',
  htmlSteps: 'Steps',
};

export const DAILY_REPORT_STRINGS_ZH: DailyReportStrings = {
  language: 'zh',
  reportTitle: '每日汇报',
  windowLabel: '统计区间',
  needsYouTitle: '需要你处理',
  followUpLinksTitle: '待跟进入口',
  overviewTitle: '昨日总览',
  botsTitle: '各 Bot 一句话',
  agendaTitle: '今日预告',
  fleetTitle: 'Bot 与自动化',
  overdueBadge: '已逾期',
  waitingDaysSuffix: '天待处理',
  waitingBadge: '等待外部',
  ownerTasksIntro: '你发起的任务：',
  columnTask: '任务',
  columnStatus: '状态',
  columnSteps: '步骤',
  columnProgress: '进度',
  scheduledRunsLabel: '定时任务',
  allSucceededLabel: '全部成功',
  failedSkippedLabel: '失败/跳过',
  groupTasksRollupLabel: '群任务动态',
  twinDelegateIntro: 'Twin 自动派单触及：',
  longTermIntro: '长期项目：',
  stepsDone: '步已完成',
  viewFullReport: '查看可视化报告',
  fallbackHeadline: '这是你的每日简报。',
  generatedAtLabel: '生成时间',
  newSessionsMetaLabel: '新建会话',
  agendaFiresLabel: '定时任务',
  agendaFiresMoreSuffix: '等 {n} 项',
  agendaOpenOrchLabel: '编排待办',
  agendaLongTermLabel: '长期项目',
  sessionsWord: '会话',
  messagesWord: '消息',
  runsWord: '次定时',
  dmWord: '私信',
  groupMessagesWord: '群消息',
  chainWord: '链上',
  likeWord: '赞',
  commentWord: '评论',
  openTeamWord: 'OpenTeam',
  twinTag: 'Twin',
  withPeerWord: '与',
  htmlNeedsYou: '需要你拍板',
  htmlOwnerTasks: 'Owner 任务',
  htmlLongTerm: '长期项目',
  htmlBotsTitle: '各 Bot 昨日一句话',
  htmlProgressTitle: '主线进度',
  htmlAgendaTitle: '今日预告',
  htmlChartTitle: '24 小时活动分布',
  htmlChartLocal: '本地会话消息',
  htmlChartOnline: '线上消息（独立刻度）',
  htmlKpiBots: 'Bot 活跃',
  htmlKpiSessions: '活跃会话',
  htmlKpiMessages: '本地消息',
  htmlKpiRuns: '定时任务',
  htmlKpiOnline: '线上消息',
  htmlAllSucceeded: '全部成功',
  htmlStatus: '状态',
  htmlSteps: '步骤',
};

/** Small zh/en table; anything that is not explicitly Chinese stays English. */
export const resolveDailyReportStrings = (locale: string | null | undefined): DailyReportStrings =>
  typeof locale === 'string' && locale.trim().toLowerCase().startsWith('zh')
    ? DAILY_REPORT_STRINGS_ZH
    : DAILY_REPORT_STRINGS_EN;

// ── Markdown helpers ───────────────────────────────────────────────────────

export const sessionDeepLink = (sessionId: string): string => `idbots://session/${sessionId}`;

/** Link text must not contain markdown control characters. */
export const sanitizeMarkdownLinkText = (text: string): string =>
  text.replace(/([\[\]\\])/g, ' ').replace(/\s+/g, ' ').trim() || '(untitled)';

const escapeHtml = (value: unknown): string =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const markdownTableCell = (value: unknown): string =>
  String(value ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();

const STATUS_EMOJI: Record<string, string> = {
  completed: '✅',
  done: '✅',
  success: '✅',
  skipped: '⏭️',
  failed: '❌',
  error: '❌',
  running: '▶️',
  executing: '▶️',
  review: '🔎',
  planning: '📋',
  pending: '⏳',
};

const statusEmoji = (status: string): string => STATUS_EMOJI[status] ?? '•';

/** Run statuses that count as not-succeeded for the rollup naming. */
const isFailedOrSkippedRun = (status: string): boolean =>
  status === 'failed' || status === 'error' || status === 'skipped';

/** Fold the host-generated delegation/schedule prefixes away (fixed generated
 * markers, mirrored from the collector — kept local so this module stays free
 * of runtime relative imports). */
const stripSessionTitlePrefix = (title: string): string =>
  title.replace(/^\[(?:编排任务|Orchestration Task|定时)\]\s*/, '').trim() || title;

/**
 * Deterministic follow-up list — present ONLY when something actually needs
 * the owner (an empty pending set omits the section entirely, in both the
 * markdown and the HTML). Links are attached here, never by the LLM.
 */
export const buildDailyReportFollowUpListMarkdown = (
  facts: DailyReportFacts,
  strings: DailyReportStrings,
  titleOverride?: string,
): string => {
  if (facts.pendingFollowUps.length === 0) return '';
  const lines = facts.pendingFollowUps.map((item) => {
    const age = item.ageDays !== null && item.ageDays > 0
      ? ` · ${item.ageDays}${strings.waitingDaysSuffix}`
      : '';
    // Waiting-on-external carries the waiting badge INSTEAD of overdue — the
    // collector already forces overdue=false for waiting items, and if an
    // inconsistent facts shape ever stamps both, the softer, more specific
    // waiting state wins (an externally-blocked item is not "overdue").
    const statusBadge = item.waitingOnExternal
      ? ` · ${strings.waitingBadge}`
      : (item.overdue ? ` · **${strings.overdueBadge}**` : '');
    const bot = item.botName ? ` · ${item.botName}` : '';
    return `- [${sanitizeMarkdownLinkText(item.title)}](${sessionDeepLink(item.sessionId)})${bot}${age}${statusBadge}`;
  });
  return [`**${titleOverride ?? strings.needsYouTitle}**`, ...lines].join('\n');
};

/** Deterministic owner-task table with step counts / percent complete. */
export const buildDailyReportOwnerTasksMarkdown = (
  facts: DailyReportFacts,
  strings: DailyReportStrings,
): string => {
  if (facts.ownerOrchestrations.length === 0) return '';
  const header = `| ${strings.columnTask} | ${strings.columnStatus} | ${strings.columnSteps} | ${strings.columnProgress} |`;
  const divider = '| --- | --- | --- | --- |';
  const rows = facts.ownerOrchestrations.map((task) => {
    const steps = task.stepsTotal > 0 ? `${task.stepsDone}/${task.stepsTotal}` : '—';
    const progress = task.percentComplete !== null ? `${task.percentComplete}%` : '—';
    return `| ${markdownTableCell(task.title)} | ${task.status} | ${steps} | ${progress} |`;
  });
  return [strings.ownerTasksIntro, header, divider, ...rows].join('\n');
};

/**
 * Deterministic per-bot one-line text (no name prefix) — what the HTML cards
 * show when the brain wrote no line for a bot, and the whole bot section
 * when the brain is unavailable. Session titles (prefix folded) + volume +
 * runs + top external peer + OpenTeam + chain interactions.
 */
export const buildDailyReportBotLineText = (
  bot: DailyReportBotActivity,
  strings: DailyReportStrings,
): string => {
  const parts: string[] = [];
  const titles = [...new Set(bot.sessions
    .slice(0, 3)
    .map((session) => sanitizeMarkdownLinkText(stripSessionTitlePrefix(session.title)))
    .filter(Boolean))].slice(0, 2);
  if (titles.length > 0) {
    parts.push(titles.join(strings.language === 'zh' ? '、' : ', '));
  }
  const volume: string[] = [`${bot.totalSessions} ${strings.sessionsWord}`, `${bot.totalMessages} ${strings.messagesWord}`];
  if (bot.scheduledRunCount > 0) volume.push(`${bot.scheduledRunCount} ${strings.runsWord}`);
  parts.push(`（${volume.join(' · ')}）`);
  const topPeer = bot.externalChats[0];
  if (topPeer) {
    parts.push(`${strings.withPeerWord} ${topPeer.peerName} ${bot.externalChats.reduce((sum, chat) => sum + chat.messageCount, 0)} ${strings.dmWord}`);
  }
  if (bot.openTeam.length > 0) {
    parts.push(`${strings.openTeamWord}: ${sanitizeMarkdownLinkText(bot.openTeam[0].taskTitle)}`);
  }
  const chainBits: string[] = [];
  for (const chain of bot.chainInteractions) {
    const word = chain.kind === 'paylike' ? strings.likeWord : chain.kind === 'paycomment' ? strings.commentWord : chain.kind;
    chainBits.push(`${chain.count} ${word}`);
  }
  if (chainBits.length > 0) parts.push(`${strings.chainWord} ${chainBits.join(' / ')}`);
  if (bot.groupMessages > 0) parts.push(`${bot.groupMessages} ${strings.groupMessagesWord}`);
  return parts.join(' · ') || '—';
};

/** Deterministic bot one-liners as markdown bullets (brain-unavailable path). */
export const buildDeterministicBotLines = (
  facts: DailyReportFacts,
  strings: DailyReportStrings,
): string => {
  if (facts.botActivity.length === 0) return '';
  const lines = facts.botActivity.map((bot) => `- **${bot.botName}**：${buildDailyReportBotLineText(bot, strings)}`);
  return [`**${strings.botsTitle}**`, ...lines].join('\n');
};

/**
 * Deterministic 今日预告 — next-24h scheduled fires (first few, named, with
 * the total), open orchestrations by status, active long-term projects.
 */
export const buildDailyReportAgendaMarkdown = (
  facts: DailyReportFacts,
  strings: DailyReportStrings,
): string => {
  const lines: string[] = [];
  const { upcoming } = facts;
  if (upcoming.scheduledFiresTotal > 0) {
    const shown = upcoming.scheduledFires.slice(0, 5).map((fire) => {
      const bot = fire.botName ? `（${fire.botName}）` : '';
      return `${fire.fireAtLocal} ${sanitizeMarkdownLinkText(fire.taskName)}${bot}`;
    });
    const extra = upcoming.scheduledFiresTotal - Math.min(5, upcoming.scheduledFires.length);
    const more = extra > 0 ? ` ${strings.agendaFiresMoreSuffix.replace('{n}', String(extra))}` : '';
    lines.push(`- ${strings.agendaFiresLabel} ${upcoming.scheduledFiresTotal}：${shown.join('、')}${more}`);
  }
  const statusBits = Object.entries(upcoming.openOrchestrationByStatus)
    .filter(([, count]) => count > 0)
    .map(([status, count]) => `${status} ${count}`)
    .join(' · ');
  if (statusBits) lines.push(`- ${strings.agendaOpenOrchLabel}：${statusBits}`);
  const longTerm = facts.machineActivity.longTermProgress.slice(0, 3).map((task) =>
    `${task.title} ${task.percentComplete}%（${task.stage}）`);
  if (longTerm.length > 0) lines.push(`- ${strings.agendaLongTermLabel}：${longTerm.join('、')}`);
  if (lines.length === 0) return '';
  return [`**${strings.agendaTitle}**`, ...lines].join('\n');
};

/**
 * Machine-activity ROLLUPS (no流水账): one summary line for scheduled runs
 * with failed/skipped runs NAMED (max 3, with their bot), one count line for
 * group-task transitions, the twin-delegate count line. Fallback path only —
 * with the brain up, these numbers ride the HTML KPI row instead.
 */
export const buildDailyReportMachineRollupMarkdown = (
  facts: DailyReportFacts,
  strings: DailyReportStrings,
): string[] => {
  const lines: string[] = [];
  const runs = facts.machineActivity.scheduledRuns;
  if (runs.length > 0) {
    const troubled = runs.filter((run) => isFailedOrSkippedRun(run.status)).slice(0, 3);
    let line = `${strings.scheduledRunsLabel} ${runs.length} · `;
    line += troubled.length === 0
      ? strings.allSucceededLabel
      : `${strings.failedSkippedLabel} ${troubled.length}:`;
    lines.push(line);
    for (const run of troubled) {
      const skip = run.skipReason ? ` (${run.skipReason})` : '';
      lines.push(`- ${statusEmoji(run.status)} ${sanitizeMarkdownLinkText(run.taskName)}${run.botName ? ` · ${run.botName}` : ''} — ${run.status}${skip}`);
    }
  }
  if (facts.machineActivity.groupTaskTransitions.length > 0) {
    lines.push(`${strings.groupTasksRollupLabel} ${facts.machineActivity.groupTaskTransitions.length}`);
  }
  if (facts.machineActivity.twinDelegateOrchestrationsInWindow > 0) {
    lines.push(`${strings.twinDelegateIntro} ${facts.machineActivity.twinDelegateOrchestrationsInWindow}`);
  }
  return lines;
};

/**
 * The deterministic briefing — the fallback the report degrades to when the
 * brain is unavailable: needs-you links, per-bot one-liners, owner-task
 * table, long-term progress, machine rollups, and the agenda.
 */
export const buildDeterministicBriefing = (
  facts: DailyReportFacts,
  strings: DailyReportStrings,
): string => {
  const sections: string[] = [];

  const followUps = buildDailyReportFollowUpListMarkdown(facts, strings);
  if (followUps) sections.push(followUps);

  const botLines = buildDeterministicBotLines(facts, strings);
  if (botLines) sections.push(botLines);

  const ownerTasks = buildDailyReportOwnerTasksMarkdown(facts, strings);
  if (ownerTasks) sections.push(ownerTasks);

  if (facts.machineActivity.longTermProgress.length > 0) {
    const lines = facts.machineActivity.longTermProgress.map((task) =>
      `- ${sanitizeMarkdownLinkText(task.title)} — ${task.stage} · ${task.percentComplete}% (${task.subtasksAccepted}/${task.subtasksTotal} ${strings.stepsDone})`,
    );
    sections.push([strings.longTermIntro, ...lines].join('\n'));
  }

  const machineRollups = buildDailyReportMachineRollupMarkdown(facts, strings);
  if (machineRollups.length > 0) {
    sections.push(`**${strings.fleetTitle}**\n\n${machineRollups.join('\n')}`);
  }

  const agenda = buildDailyReportAgendaMarkdown(facts, strings);
  if (agenda) sections.push(agenda);

  return sections.filter(Boolean).join('\n\n');
};

// ── Brain prose parsing ────────────────────────────────────────────────────

export interface DailyReportBrainBotLine {
  botName: string;
  text: string;
}

export interface DailyReportBrainNeed {
  level: 'red' | 'amber';
  text: string;
}

export interface DailyReportBrainSections {
  /** Raw markdown under the overview heading (null when absent). */
  overviewMarkdown: string | null;
  botLines: DailyReportBrainBotLine[];
  needsYou: DailyReportBrainNeed[];
}

const HEADING_OVERVIEW = /^(?:昨日总览|Yesterday at a glance)\s*[:：]?$/i;
const HEADING_BOTS = /^(?:各\s*Bot\s*一句话|Bot one-liners?)\s*[:：]?$/i;
const HEADING_NEEDS = /^(?:需要你拍板|Needs you)\s*[:：]?$/i;
const BOT_LINE_RE = /^[-*]\s*\*\*(.+?)\*\*\s*[：:—-]?\s*(.+)$/;
const NEED_RE = /^[-*]\s*(🔴|🟡)\s*(.+)$/;

/**
 * Tolerant parse of the brain's three fixed sections — used by the HTML
 * builder to lift per-bot lines and needs-you bullets into cards. Anything
 * unexpected degrades to empty; the chat markdown keeps the prose verbatim
 * either way.
 */
export const parseDailyReportBrainProse = (markdown: string): DailyReportBrainSections => {
  const result: DailyReportBrainSections = { overviewMarkdown: null, botLines: [], needsYou: [] };
  let section: 'overview' | 'bots' | 'needs' | null = null;
  const overviewLines: string[] = [];
  for (const rawLine of String(markdown ?? '').replace(/\r\n/g, '\n').split('\n')) {
    const line = rawLine.trim();
    const heading = /^##+\s+(.*)$/.exec(line);
    if (heading) {
      const title = heading[1].trim();
      if (HEADING_OVERVIEW.test(title)) {
        section = 'overview';
        continue;
      }
      if (HEADING_BOTS.test(title)) {
        section = 'bots';
        continue;
      }
      if (HEADING_NEEDS.test(title)) {
        section = 'needs';
        continue;
      }
      section = null;
      continue;
    }
    if (!line) continue;
    if (section === 'overview') {
      overviewLines.push(rawLine);
    } else if (section === 'bots') {
      const botLine = BOT_LINE_RE.exec(line);
      if (botLine) {
        result.botLines.push({ botName: botLine[1].trim(), text: botLine[2].trim() });
      }
    } else if (section === 'needs') {
      const need = NEED_RE.exec(line);
      if (need) {
        result.needsYou.push({ level: need[1].startsWith('🔴') ? 'red' : 'amber', text: need[2].trim() });
      }
    }
  }
  result.overviewMarkdown = overviewLines.join('\n').trim() || null;
  return result;
};

/** First non-heading, non-empty line of the prose (the HTML headline). */
export const extractDailyReportHeadlineLine = (markdown: string): string | null =>
  markdown
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith('#')) ?? null;

// ── HTML report (deterministic visuals; no prose duplication) ──────────────

const avatarHue = (name: string): number => {
  let hash = 0;
  for (const ch of name) hash = (hash + (ch.codePointAt(0) ?? 0)) % 360;
  return hash;
};

const buildChartSvg = (facts: DailyReportFacts, strings: DailyReportStrings): string => {
  const local = facts.hourlyActivity?.local ?? [];
  const online = facts.hourlyActivity?.online ?? [];
  const maxLocal = Math.max(1, ...local);
  const maxOnline = Math.max(1, ...online);
  const bars: string[] = [];
  const points: string[] = [];
  for (let i = 0; i < 12; i += 1) {
    const x = 20 + i * 70;
    const barHeight = Math.round(((local[i] ?? 0) / maxLocal) * 105);
    if (barHeight > 0) {
      bars.push(`<rect x="${x}" y="${120 - barHeight}" width="40" height="${barHeight}" rx="3"/>`);
    }
    const dotHeight = Math.min(40, Math.round(((online[i] ?? 0) / maxOnline) * 40));
    points.push(`${x + 20},${120 - dotHeight}`);
  }
  const labels = Array.from({ length: 12 }, (_, i) => {
    const from = i * 2;
    return `<text x="${20 + i * 70 + 20}" y="142">${from}-${from + 2}</text>`;
  }).join('');
  return `<div class="card"><h2>${escapeHtml(strings.htmlChartTitle)}</h2>`
    + '<svg viewBox="0 0 880 150" width="100%" role="img">'
    + `<g fill="#3f6fd8">${bars.join('')}</g>`
    + `<polyline fill="none" stroke="#fbbf24" stroke-width="2" points="${points.join(' ')}"/>`
    + `<g fill="#5c6373" font-size="10" text-anchor="middle">${labels}</g>`
    + '</svg>'
    + `<div class="legend"><span class="sw" style="background:#3f6fd8"></span>${escapeHtml(strings.htmlChartLocal)}<span class="sw" style="background:#fbbf24"></span>${escapeHtml(strings.htmlChartOnline)}</div></div>`;
};

const buildBotCardsHtml = (
  facts: DailyReportFacts,
  strings: DailyReportStrings,
  brainLines: ReadonlyMap<string, string>,
): string => {
  if (facts.botActivity.length === 0) return '';
  const maxMessages = Math.max(1, ...facts.botActivity.map((bot) => bot.totalMessages));
  const cards = facts.botActivity.map((bot) => {
    const text = brainLines.get(bot.botName) ?? buildDailyReportBotLineText(bot, strings);
    const meter = Math.max(2, Math.round((bot.totalMessages / maxMessages) * 100));
    const chips: string[] = [`${bot.totalSessions} ${strings.sessionsWord} · ${bot.totalMessages} ${strings.messagesWord}`];
    if (bot.scheduledRunCount > 0) chips.push(`${bot.scheduledRunCount} ${strings.runsWord}`);
    const dmTotal = bot.externalChats.reduce((sum, chat) => sum + chat.messageCount, 0);
    if (dmTotal > 0) chips.push(`${dmTotal} ${strings.dmWord}`);
    if (bot.groupMessages > 0) chips.push(`${bot.groupMessages} ${strings.groupMessagesWord}`);
    const avatarChar = [...bot.botName][0] ?? '?';
    return `<div class="bot"><div class="top"><div class="avatar" style="background:hsl(${avatarHue(bot.botName)},70%,72%)">${escapeHtml(avatarChar)}</div><span class="name">${escapeHtml(bot.botName)}</span>${bot.isTwin ? `<span class="twin">${escapeHtml(strings.twinTag)}</span>` : ''}</div><div class="line">${escapeHtml(text)}</div><div class="meter"><div class="bar"><i style="width:${meter}%"></i></div><span class="n">${escapeHtml(chips.join(' · '))}</span></div></div>`;
  }).join('');
  return `<div class="card"><h2>${escapeHtml(strings.htmlBotsTitle)}</h2><div class="bots">${cards}</div></div>`;
};

const buildNeedsHtml = (
  facts: DailyReportFacts,
  strings: DailyReportStrings,
  brainNeeds: ReadonlyArray<DailyReportBrainNeed>,
): string => {
  const cards: string[] = [];
  for (const need of brainNeeds.slice(0, 5)) {
    const badge = need.level === 'red' ? '🔴 ' : '🟡 ';
    cards.push(`<div class="need ${need.level}"><div class="t">${badge}${escapeHtml(need.text)}</div></div>`);
  }
  for (const item of facts.pendingFollowUps.slice(0, 6)) {
    const badges = [
      item.botName ? escapeHtml(item.botName) : '',
      item.ageDays !== null && item.ageDays > 0 ? `${item.ageDays}${escapeHtml(strings.waitingDaysSuffix)}` : '',
      // Waiting wins over overdue on inconsistent facts shapes (see the
      // markdown follow-up list for the rationale).
      item.waitingOnExternal
        ? escapeHtml(strings.waitingBadge)
        : (item.overdue ? escapeHtml(strings.overdueBadge) : ''),
    ].filter(Boolean).join(' · ');
    cards.push(`<div class="need link"><div class="t"><a href="${sessionDeepLink(item.sessionId)}">${escapeHtml(item.title)}</a></div><div class="act">${badges}</div></div>`);
  }
  const seenFailed = new Set<string>();
  const failedRunSources: { taskName: string; botName: string | null }[] = [
    ...facts.machineActivity.scheduledRuns
      .filter((run) => isFailedOrSkippedRun(run.status))
      .map((run) => ({ taskName: run.taskName, botName: run.botName })),
    ...facts.botActivity.flatMap((bot) =>
      bot.scheduledRuns
        .filter((run) => isFailedOrSkippedRun(run.status))
        .map((run) => ({ taskName: run.taskName, botName: bot.botName }))),
  ];
  for (const run of failedRunSources) {
    const key = `${run.taskName}|${run.botName}`;
    if (seenFailed.has(key)) continue;
    seenFailed.add(key);
    const bot = run.botName ? ` · ${escapeHtml(run.botName)}` : '';
    cards.push(`<div class="need amber"><div class="t">🟡 ${escapeHtml(run.taskName)}${bot}</div></div>`);
    if (seenFailed.size >= 3) break;
  }
  if (cards.length === 0) return '';
  return `<div class="card"><h2>${escapeHtml(strings.htmlNeedsYou)}</h2>${cards.join('')}</div>`;
};

const buildProgressHtml = (facts: DailyReportFacts, strings: DailyReportStrings): string => {
  const bars = facts.machineActivity.longTermProgress.slice(0, 4).map((task) =>
    `<div class="prog"><div class="row1"><span>${escapeHtml(task.title)}</span><span class="pct">${task.percentComplete}%</span></div><div class="track"><i style="width:${task.percentComplete}%"></i></div></div>`).join('');
  const chips: string[] = [];
  const transitions = facts.machineActivity.groupTaskTransitions.length;
  if (transitions > 0) chips.push(`${strings.groupTasksRollupLabel} ×${transitions}`);
  const reviews = facts.upcoming?.openOrchestrationByStatus?.review ?? 0;
  if (reviews > 0) chips.push(`${strings.agendaOpenOrchLabel} review ×${reviews}`);
  const delegated = facts.machineActivity.twinDelegateOrchestrationsInWindow;
  if (delegated > 0) chips.push(`Twin delegate ×${delegated}`);
  if (bars === '' && chips.length === 0) return '';
  const chipline = chips.length > 0
    ? `<div class="chipline">${chips.map((chip) => `<span class="chip">${escapeHtml(chip)}</span>`).join('')}</div>`
    : '';
  return `<div class="card"><h2>${escapeHtml(strings.htmlProgressTitle)}</h2>${bars}${chipline}</div>`;
};

const buildAgendaHtml = (facts: DailyReportFacts, strings: DailyReportStrings): string => {
  const upcoming = facts.upcoming;
  const items = (upcoming?.scheduledFires ?? []).slice(0, 8).map((fire) => {
    const bot = fire.botName ? ` <span class="who">· ${escapeHtml(fire.botName)}</span>` : '';
    return `<div class="item"><span class="time">${escapeHtml(fire.fireAtLocal)}</span><span>${escapeHtml(fire.taskName)}${bot}</span></div>`;
  }).join('');
  const extras: string[] = [];
  const total = upcoming?.scheduledFiresTotal ?? 0;
  if (total > 0) extras.push(`${strings.agendaFiresLabel} ${total}`);
  const statusBits = Object.entries(upcoming?.openOrchestrationByStatus ?? {})
    .filter(([, count]) => count > 0)
    .map(([status, count]) => `${status} ${count}`)
    .join(' · ');
  if (statusBits) extras.push(`${strings.agendaOpenOrchLabel}：${statusBits}`);
  const longTerm = facts.machineActivity.longTermProgress.slice(0, 2)
    .map((task) => `${task.title} ${task.percentComplete}%`);
  if (longTerm.length > 0) extras.push(`${strings.agendaLongTermLabel}：${longTerm.join('、')}`);
  if (!items && extras.length === 0) return '';
  const more = extras.length > 0 ? `<div class="more">${escapeHtml(extras.join(' · '))}</div>` : '';
  return `<div class="card agenda"><h2>${escapeHtml(strings.htmlAgendaTitle)}</h2>${items}${more}</div>`;
};

export const buildDailyReportHtml = (input: {
  facts: DailyReportFacts;
  strings: DailyReportStrings;
  dateLabel: string;
  headlineText?: string | null;
  proseMarkdown?: string | null;
}): string => {
  const { facts, strings, dateLabel } = input;
  const sections = input.proseMarkdown ? parseDailyReportBrainProse(input.proseMarkdown) : null;
  const brainLines = new Map<string, string>(
    (sections?.botLines ?? []).map((line) => [line.botName, line.text]),
  );

  const activeBots = facts.botActivity.length;
  const activeSessions = facts.botActivity.reduce((sum, bot) => sum + bot.totalSessions, 0);
  const localMessages = facts.botActivity.reduce((sum, bot) => sum + bot.totalMessages, 0);
  const runTotal = facts.botActivity.reduce((sum, bot) => sum + bot.scheduledRunCount, 0);
  const onlineMessages = facts.onlineActivity.reduce(
    (sum, entry) => sum + entry.privateMessageCount + entry.groupMessageCount, 0,
  );
  const anyFailedRun = facts.machineActivity.scheduledRuns.some((run) => isFailedOrSkippedRun(run.status))
    || facts.botActivity.some((bot) => bot.scheduledRuns.some((run) => isFailedOrSkippedRun(run.status)));
  const botsTotal = facts.knownBotCount > 0 ? facts.knownBotCount : activeBots;

  const headline = input.headlineText ?? strings.fallbackHeadline;

  const ownerTaskRows = facts.ownerOrchestrations.map((task) => `<tr>
    <td>${escapeHtml(task.title)}</td>
    <td>${escapeHtml(task.status)}</td>
    <td>${task.stepsTotal > 0 ? `${task.stepsDone}/${task.stepsTotal}` : '—'}</td>
    <td>${task.percentComplete !== null ? `${task.percentComplete}%` : '—'}</td>
  </tr>`).join('');

  const generatedAt = new Date(facts.generatedAtMs).toLocaleString(strings.language === 'zh' ? 'zh-CN' : 'en-US');

  return `<!DOCTYPE html>
<html lang="${strings.language}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(strings.reportTitle)} ${escapeHtml(dateLabel)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, "PingFang SC", "Segoe UI", sans-serif; margin: 0; padding: 32px 20px; background: #0f1115; color: #e6e8ee; }
  .wrap { max-width: 960px; margin: 0 auto; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .meta { color: #8a90a2; font-size: 12px; margin-bottom: 20px; }
  .kpis { display: grid; grid-template-columns: repeat(5, 1fr); gap: 10px; margin-bottom: 18px; }
  .kpi { background: #171a22; border: 1px solid #262b38; border-radius: 12px; padding: 12px 14px; }
  .kpi .v { font-size: 21px; font-weight: 700; }
  .kpi .v small { font-size: 12px; font-weight: 400; color: #8a90a2; }
  .kpi .l { font-size: 11px; color: #8a90a2; margin-top: 2px; }
  .kpi.good .v { color: #4ade80; }
  .headline { font-size: 16px; line-height: 1.7; margin: 0 0 18px; padding: 14px 16px; background: linear-gradient(135deg, #1a1f2e, #171a22); border: 1px solid #2b3245; border-radius: 12px; }
  .card { background: #171a22; border: 1px solid #262b38; border-radius: 12px; padding: 14px 16px; margin-bottom: 18px; }
  .card h2 { font-size: 14px; text-transform: uppercase; letter-spacing: .06em; color: #9aa3b8; margin: 0 0 10px; }
  .legend { font-size: 11px; color: #8a90a2; margin-top: 6px; }
  .legend .sw { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin: 0 4px 0 10px; vertical-align: -1px; }
  .bots { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .bot { background: #13161e; border: 1px solid #232837; border-radius: 12px; padding: 11px 12px; }
  .bot .top { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
  .avatar { width: 26px; height: 26px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 700; color: #0f1115; flex: none; }
  .bot .name { font-size: 13.5px; font-weight: 600; }
  .bot .twin { font-size: 10px; color: #fbbf24; border: 1px solid #5a4a1b; border-radius: 999px; padding: 0 6px; margin-left: 4px; }
  .bot .line { font-size: 12px; line-height: 1.55; color: #c3c9d8; }
  .bot .meter { margin-top: 8px; display: flex; align-items: center; gap: 8px; }
  .meter .bar { flex: 1; height: 4px; border-radius: 2px; background: #232837; overflow: hidden; }
  .meter .bar i { display: block; height: 100%; background: linear-gradient(90deg, #3f6fd8, #6ea8fe); border-radius: 2px; }
  .meter .n { font-size: 10px; color: #8a90a2; white-space: nowrap; }
  .cols { display: grid; grid-template-columns: 1fr 320px; gap: 14px; align-items: start; }
  .need { border-radius: 12px; padding: 11px 13px; margin-bottom: 10px; font-size: 12.5px; line-height: 1.55; }
  .need .t { font-weight: 700; }
  .need.red { background: #2a1618; border: 1px solid #5a2b2b; }
  .need.red .t { color: #ffb4b4; }
  .need.amber { background: #2a2214; border: 1px solid #57461c; }
  .need.amber .t { color: #ffe2a8; }
  .need.link { background: #13161e; border: 1px solid #232837; }
  .need a { color: #6ea8fe; text-decoration: none; }
  .need .act { color: #8a90a2; font-size: 11.5px; margin-top: 4px; }
  .prog { margin-bottom: 12px; }
  .prog .row1 { display: flex; justify-content: space-between; font-size: 12px; margin-bottom: 4px; gap: 8px; }
  .prog .row1 .pct { color: #4ade80; font-weight: 700; white-space: nowrap; }
  .prog .track { height: 6px; border-radius: 3px; background: #232837; overflow: hidden; }
  .prog .track i { display: block; height: 100%; background: linear-gradient(90deg, #2f9e6a, #4ade80); }
  .chipline { font-size: 11.5px; color: #8a90a2; margin-top: 8px; }
  .chip { display: inline-block; background: #20242f; border: 1px solid #2c3242; border-radius: 999px; padding: 1px 8px; margin: 2px 4px 0 0; color: #c3c9d8; }
  .agenda .item { display: flex; gap: 10px; padding: 7px 0; border-bottom: 1px solid #20242f; font-size: 12px; }
  .agenda .item:last-child { border-bottom: none; }
  .agenda .time { color: #6ea8fe; font-variant-numeric: tabular-nums; white-space: nowrap; width: 44px; flex: none; }
  .agenda .who { color: #8a90a2; }
  .agenda .more { font-size: 11.5px; color: #8a90a2; margin-top: 8px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid #232837; vertical-align: top; }
  th { color: #9aa3b8; font-weight: 600; }
  a { color: #6ea8fe; text-decoration: none; }
  @media (max-width: 720px) { .cols { grid-template-columns: 1fr; } .bots { grid-template-columns: 1fr; } .kpis { grid-template-columns: repeat(2, 1fr); } }
</style>
</head>
<body>
<div class="wrap">
  <h1>${escapeHtml(strings.reportTitle)} · ${escapeHtml(dateLabel)}</h1>
  <div class="meta">${escapeHtml(strings.windowLabel)}: ${escapeHtml(formatLocalDate(facts.windowStartMs))} → ${escapeHtml(formatLocalDate(facts.windowEndMs))} · ${escapeHtml(strings.generatedAtLabel)}: ${escapeHtml(generatedAt)} · ${escapeHtml(strings.newSessionsMetaLabel)}: ${facts.newSessionCount}</div>

  <div class="kpis">
    <div class="kpi good"><div class="v">${activeBots}<small>/${botsTotal}</small></div><div class="l">${escapeHtml(strings.htmlKpiBots)}</div></div>
    <div class="kpi"><div class="v">${activeSessions}</div><div class="l">${escapeHtml(strings.htmlKpiSessions)}</div></div>
    <div class="kpi"><div class="v">${localMessages}</div><div class="l">${escapeHtml(strings.htmlKpiMessages)}</div></div>
    <div class="kpi${runTotal > 0 && !anyFailedRun ? ' good' : ''}"><div class="v">${runTotal}${runTotal > 0 && !anyFailedRun ? `<small> ${escapeHtml(strings.htmlAllSucceeded)}</small>` : ''}</div><div class="l">${escapeHtml(strings.htmlKpiRuns)}</div></div>
    <div class="kpi"><div class="v">${onlineMessages}</div><div class="l">${escapeHtml(strings.htmlKpiOnline)}</div></div>
  </div>

  <div class="headline">${escapeHtml(headline)}</div>

  ${buildChartSvg(facts, strings)}

  <div class="cols">
    <div>${buildBotCardsHtml(facts, strings, brainLines)}${ownerTaskRows ? `<div class="card"><h2>${escapeHtml(strings.htmlOwnerTasks)}</h2><table><thead><tr><th>${escapeHtml(strings.columnTask)}</th><th>${escapeHtml(strings.htmlStatus)}</th><th>${escapeHtml(strings.htmlSteps)}</th><th>${escapeHtml(strings.columnProgress)}</th></tr></thead><tbody>${ownerTaskRows}</tbody></table></div>` : ''}</div>
    <div>${buildNeedsHtml(facts, strings, sections?.needsYou ?? [])}${buildProgressHtml(facts, strings)}${buildAgendaHtml(facts, strings)}</div>
  </div>
</div>
</body>
</html>`;
};

// ── Brain prose ────────────────────────────────────────────────────────────

export const DAILY_REPORT_BRAIN_TIMEOUT_MS = 120_000;
export const DAILY_REPORT_BRAIN_MAX_TOKENS = 2000;

export interface DailyReportBrainOptions {
  llmId: string | null;
  llmProvider?: string | null;
  effort?: string | null;
  fallbackLlmId?: string | null;
  fallbackLlmProvider?: string | null;
  fallbackEffort?: string | null;
}

export type DailyReportPerformChat = (
  systemPrompt: string,
  userMessage: string,
  llmId?: string | null,
  options?: {
    signal?: AbortSignal;
    maxTokens?: number;
    fallbackLlmId?: string | null;
    fallbackLlmProvider?: string | null;
    effort?: string | null;
    fallbackEffort?: string | null;
    llmProvider?: string | null;
    throwOnEmptyContent?: boolean;
    thinking?: 'enabled' | 'disabled';
    webSearch?: boolean;
    attemptTimeoutMs?: number;
  },
) => Promise<string>;

const DAILY_REPORT_BRAIN_PROMPT_ZH =
  '你是 IDBots 团队（本地 AI Bot 群 + Twin Bot）负责人的执行助理，呈交每日简报。受众只有负责人本人。\n'
  + '输出要求：使用与用户界面一致的语言（当前界面语言为中文）撰写；GitHub 风格 markdown；不要代码块；不要输出任何链接、id 或会话号；全文不超过 600 字。\n'
  + '固定输出三节，标题逐字使用：\n'
  + '## 昨日总览\n'
  + '2–4 句高度总结：点名主线工作（编排任务/长期项目/群任务）的正式名称、结果、进度与阻塞；'
  + '若本机 bot 与外部 bot 或陌生人有值得注意的交流，点名对方是谁、围绕什么主题；先讲大局，绝不流水账。\n'
  + '## 各 Bot 一句话\n'
  + 'facts.botActivity 中每个 bot 输出恰好一行，格式：**Bot名**：一句话。每行不超过 60 字，概括该 bot 这一天：'
  + '本地会话与编排任务做了什么、结果如何；定时任务做了什么；与哪个外部 bot/谁私聊了什么主题；参与过哪个 OpenTeam 任务；'
  + '在链上做过什么互动（冲浪时的评论/点赞/发布）。信息为零的维度直接省略；几个 bot 只做同类琐事时可合并为一行；'
  + '禁止罗列消息数与运行次数清单。\n'
  + '## 需要你拍板\n'
  + '仅当确有需要负责人处理的问题时输出本节：每条一行，以 🔴（需要尽快）或 🟡（可排期）开头，说清问题与建议动作；'
  + '素材包括失败的定时任务、被拒或挂起的转账、停在 review 的编排、facts.pendingFollowUps 的待跟进事项。没有则整节省略。\n'
  + '严禁编造 id、链接、会话号或事实；严禁照抄 facts JSON。';

const DAILY_REPORT_BRAIN_PROMPT_EN =
  'You are the executive assistant to the owner of an IDBots fleet (local AI bots + the Twin bot), delivering the daily briefing. The audience is the owner only.\n'
  + 'Output requirements: write in the same language as the user\'s UI (currently English); GitHub-flavored markdown; no code fences; no links, ids, or session references; keep the whole brief under 400 words.\n'
  + 'Produce exactly three sections, headings verbatim:\n'
  + '## Yesterday at a glance\n'
  + '2–4 highly summarized sentences: name the main lines (orchestrations / long-term projects / group tasks) by their real titles with outcomes, progress and blockers; '
  + 'when local bots had notable exchanges with external bots or strangers, name who and the topic. Big picture first — never a laundry list.\n'
  + '## Bot one-liners\n'
  + 'Exactly one line per bot in facts.botActivity, format: **Bot name**: one sentence. Each line ≤ 60 words covering what that bot did today: '
  + 'local sessions and orchestration work with outcomes; scheduled-run work; which external bot/person it DM\'d and about what; which OpenTeam task it took part in; '
  + 'what it interacted with on-chain (surf comments/likes/publishes). Omit empty dimensions; merge bots that only share trivial errands into one line; '
  + 'never list message or run counts.\n'
  + '## Needs you\n'
  + 'Only when something genuinely needs the owner: one line per item starting with 🔴 (urgent) or 🟡 (schedulable), stating the problem and a suggested action; '
  + 'material includes failed scheduled runs, rejected/hung transfers, orchestrations stuck in review, and facts.pendingFollowUps. Omit the section entirely otherwise.\n'
  + 'Never invent ids, links or facts; never copy the facts JSON verbatim.';

/**
 * Locale-native briefing contract. Each locale's prompt is written in that
 * language and requires the output to follow the USER'S UI language. The
 * three section headings are fixed (parsed back by parseDailyReportBrainProse
 * for the HTML cards).
 */
export const buildDailyReportBrainSystemPrompt = (strings: DailyReportStrings): string =>
  strings.language === 'zh' ? DAILY_REPORT_BRAIN_PROMPT_ZH : DAILY_REPORT_BRAIN_PROMPT_EN;

export const buildDailyReportBrainUserMessage = (input: {
  facts: DailyReportFacts;
  strings: DailyReportStrings;
  dateLabel: string;
}): string =>
  `Report date: ${input.dateLabel}\n`
  + `Window (ms since epoch): ${input.facts.windowStartMs} → ${input.facts.windowEndMs}\n`
  + 'Facts (JSON):\n'
  + JSON.stringify(input.facts);

/**
 * CoT hygiene for the brain prose (the 2026-11-07 commandcode incident): the
 * relay serving glm-5.3-flash intermittently flattens the model's
 * chain-of-thought INTO message.content, and the raw text then shipped
 * verbatim as the briefing — including as the HTML headline. The briefing
 * contract already requires the prose to START with the verbatim overview
 * heading, so sanitize = strip inline <think>/<thinking> blocks (some relays
 * tag them) and drop everything before the first fixed overview heading; the
 * heading must carry the markdown ## prefix, exactly the shape
 * parseDailyReportBrainProse recognizes. An empty result means the brain
 * violated the contract and the caller falls back to the deterministic
 * briefing — a leaked chain-of-thought never reaches the owner either way.
 */
export const sanitizeDailyReportBrainProse = (markdown: string): string => {
  const withoutThinkBlocks = String(markdown ?? '')
    .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '')
    .trim();
  const lines = withoutThinkBlocks.replace(/\r\n/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const heading = /^##+\s+(.*)$/.exec(lines[i].trim());
    if (heading && HEADING_OVERVIEW.test(heading[1].trim())) {
      return lines.slice(i).join('\n').trim();
    }
  }
  return '';
};

// ── Orchestration ──────────────────────────────────────────────────────────

export interface DailyReportGenerationResult {
  briefingMarkdown: string;
  usedFallback: boolean;
  htmlFilePath: string;
  htmlFileUrl: string;
}

/**
 * Generate the daily report: try the brain once (bounded, 120s wall), on any
 * failure degrade to the deterministic pure-data briefing. Either way the
 * HTML file is written and the returned markdown ends ready for the message
 * (caller appends the file link).
 *
 * Brain path markdown = prose (three sections) + follow-up deep links +
 * agenda. The HTML never repeats the prose — it renders the visuals.
 */
export const generateDailyReport = async (input: {
  facts: DailyReportFacts;
  strings: DailyReportStrings;
  dateLabel: string;
  reportDir: string;
  brain: DailyReportBrainOptions | null;
  performChat: DailyReportPerformChat;
  brainTimeoutMs?: number;
}): Promise<DailyReportGenerationResult> => {
  const { facts, strings, dateLabel } = input;
  const reportDir = input.reportDir;
  fs.mkdirSync(reportDir, { recursive: true });
  const htmlFilePath = path.join(reportDir, `${dateLabel}.html`);

  let headlineText: string | null = null;
  let proseMarkdown: string | null = null;
  let usedFallback = true;

  if (input.brain?.llmId) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, input.brainTimeoutMs ?? DAILY_REPORT_BRAIN_TIMEOUT_MS));
    try {
      const prose = await input.performChat(
        buildDailyReportBrainSystemPrompt(strings),
        buildDailyReportBrainUserMessage({ facts, strings, dateLabel }),
        input.brain.llmId,
        {
          signal: controller.signal,
          maxTokens: DAILY_REPORT_BRAIN_MAX_TOKENS,
          llmProvider: input.brain.llmProvider ?? null,
          effort: input.brain.effort ?? null,
          fallbackLlmId: input.brain.fallbackLlmId ?? null,
          fallbackLlmProvider: input.brain.fallbackLlmProvider ?? null,
          fallbackEffort: input.brain.fallbackEffort ?? null,
          attemptTimeoutMs: input.brainTimeoutMs ?? DAILY_REPORT_BRAIN_TIMEOUT_MS,
          thinking: 'disabled',
          webSearch: false,
          throwOnEmptyContent: true,
        },
      );
      const trimmed = prose?.trim();
      // Contract gate: only three-section prose that starts at the verbatim
      // overview heading is adopted; relay-flattened CoT prefixes are cut and
      // a fully non-conforming reply degrades to the deterministic briefing
      // (same sink as a failing brain — the report always ships).
      const sanitized = trimmed ? sanitizeDailyReportBrainProse(trimmed) : '';
      if (sanitized) {
        proseMarkdown = sanitized;
        usedFallback = false;
        headlineText = extractDailyReportHeadlineLine(sanitized);
      } else if (trimmed) {
        console.warn('[DailyReportGenerator] brain prose failed the three-section contract (no overview heading after CoT strip); using deterministic briefing');
      }
    } catch (error) {
      console.warn('[DailyReportGenerator] brain prose failed; using deterministic briefing:', error);
    } finally {
      clearTimeout(timer);
    }
  }

  // Brain path: prose + deterministic links + agenda. Fallback path: the
  // full deterministic briefing (links and agenda already inside).
  const followUpLinks = buildDailyReportFollowUpListMarkdown(facts, strings, strings.followUpLinksTitle);
  const agenda = buildDailyReportAgendaMarkdown(facts, strings);
  let briefingMarkdown: string;
  if (proseMarkdown) {
    const tail = [followUpLinks, agenda].filter(Boolean).join('\n\n');
    briefingMarkdown = tail ? `${proseMarkdown}\n\n${tail}` : proseMarkdown;
  } else {
    briefingMarkdown = `**${strings.fallbackHeadline}**\n\n${buildDeterministicBriefing(facts, strings)}`;
  }

  const html = buildDailyReportHtml({
    facts,
    strings,
    dateLabel,
    headlineText,
    proseMarkdown,
  });
  fs.writeFileSync(htmlFilePath, html, 'utf8');

  return {
    briefingMarkdown,
    usedFallback,
    htmlFilePath,
    htmlFileUrl: pathToFileURL(htmlFilePath).toString(),
  };
};
