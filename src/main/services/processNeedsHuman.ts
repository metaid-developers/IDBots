/**
 * 进程中心写端 — the `needs_human` gate + the HTML 摘要件 generator.
 *
 * Owner definition (2026-11-24 00:47, adopted by floatwin-outline §4.0):
 *
 *   「日常任务的推进，运行时的在 live stage 里展示；推进完毕需要人类下一步
 *     动作的，整理出 html 扔到通知中心里」
 *
 * Three consequences this module encodes:
 *   1. a NORMAL completion (no human action owed) must NOT write a notification
 *      — it only enters the process ledger (N8: the old writer notified EVERY
 *      cowork terminal, which is exactly the spam the definition forbids);
 *   2. when the owner really is owed a next step, the 承办 bot's OWN final
 *      message becomes the digest's 结论, and its `[FOLLOW_UP: owner — …]`
 *      declaration becomes 建议下一步. The host only renders the file — it
 *      never authors the conclusion (M6=A / M7=A);
 *   3. objective wait states are the ONLY fallback the host may add on its own
 *      (pending permission / open decision / waiting_owner / overrun), because
 *      those are facts, not interpretations (M7=A 兜底).
 *
 * PURE where it matters: `resolveProcessNeedsHuman` and
 * `buildProcessDigestHtml` have no I/O, so both are pinned by unit tests.
 */

import fs from 'node:fs';
import path from 'node:path';
import { previewMetaappUriForPath } from '../libs/localPreviewUri';

/** N1's closed reason vocabulary (the protocol field, not a free string). */
export type ProcessNeedsHumanReason =
  | 'overrun'
  | 'waiting_owner'
  | 'waiting_external'
  | 'permission'
  | 'decision';

export const PROCESS_NEEDS_HUMAN_REASONS: readonly ProcessNeedsHumanReason[] = [
  'overrun',
  'waiting_owner',
  'waiting_external',
  'permission',
  'decision',
];

export type ProcessFollowUpDeclaration = 'owner' | 'none';

/** Same tag the scheduled-run contract injects (`[FOLLOW_UP: owner — …]`). */
const FOLLOW_UP_TAG_PATTERN = /\[FOLLOW_UP:\s*(owner|none)\b([^\]]*)\]/gi;

export interface ParsedFollowUpDeclaration {
  verdict: ProcessFollowUpDeclaration;
  /** The free-text tail after `owner —`, or null. */
  reason: string | null;
}

/**
 * Parse the LAST declaration in the text (the contract's rule: later tags win).
 * Returns null when the message carries no tag.
 */
export const parseFollowUpDeclarationWithReason = (
  text: string | null | undefined,
): ParsedFollowUpDeclaration | null => {
  const value = typeof text === 'string' ? text : '';
  if (!value) return null;
  let parsed: ParsedFollowUpDeclaration | null = null;
  for (const match of value.matchAll(FOLLOW_UP_TAG_PATTERN)) {
    const verdict = match[1].toLowerCase() === 'owner' ? 'owner' : 'none';
    const tail = String(match[2] ?? '')
      .replace(/^[\s:：—–-]+/u, '')
      .replace(/\s+/gu, ' ')
      .trim();
    parsed = { verdict, reason: tail ? tail.slice(0, 240) : null };
  }
  return parsed;
};

/** Everything the gate is allowed to look at (all facts, no interpretation). */
export interface ProcessNeedsHumanFacts {
  outcome: 'completed' | 'failed';
  /** The 承办 bot's explicit end-of-run declaration (null = it made none). */
  declaration: ProcessFollowUpDeclaration | null;
  declarationReason: string | null;
  /** `cowork_sessions.follow_up_state` ('pending' = waiting on the owner). */
  followUpState: 'pending' | null | undefined;
  /** A tool permission is still waiting for the owner in THIS session. */
  pendingPermission: boolean;
  /** An open Studio decision card points at THIS session. */
  openDecision: boolean;
  /** The linked long-term sub-project ran past its expected-duration budget. */
  overrun: boolean;
}

export interface ProcessNeedsHumanVerdict {
  needsHuman: boolean;
  reason: ProcessNeedsHumanReason | null;
  /** What the owner is asked to do (the bot's own words when it declared one). */
  nextStep: string | null;
}

/**
 * M7=A: the AUTHORING BOT decides; the host only falls back to OBJECTIVE wait
 * states. Precedence is deliberate:
 *
 *   permission → decision → waiting_owner → overrun → declared 'owner'
 *
 * Objective blockers outrank the bot's own words because a bot that declared
 * `none` while an approval prompt is literally on screen would otherwise
 * suppress a real blocker. A declared `none` with no objective fact means
 * "nothing owed" — and then NOTHING is written (the N8 no-spam branch).
 * Failures never pass through here: they keep the existing failed notification.
 */
export const resolveProcessNeedsHuman = (
  facts: ProcessNeedsHumanFacts,
): ProcessNeedsHumanVerdict => {
  if (facts.outcome !== 'completed') return { needsHuman: false, reason: null, nextStep: null };
  if (facts.pendingPermission) {
    return { needsHuman: true, reason: 'permission', nextStep: null };
  }
  if (facts.openDecision) {
    return { needsHuman: true, reason: 'decision', nextStep: facts.declarationReason };
  }
  if (facts.followUpState === 'pending') {
    return { needsHuman: true, reason: 'waiting_owner', nextStep: facts.declarationReason };
  }
  if (facts.overrun) {
    return { needsHuman: true, reason: 'overrun', nextStep: facts.declarationReason };
  }
  if (facts.declaration === 'owner') {
    return { needsHuman: true, reason: 'decision', nextStep: facts.declarationReason };
  }
  return { needsHuman: false, reason: null, nextStep: null };
};

/* ───────────────────────── 摘要件 (N3) ───────────────────────── */

type DigestLanguage = 'zh' | 'en';

export interface ProcessDigestInput {
  title: string;
  /** The authoring bot's own closing words (never host-authored). */
  conclusion: string;
  /** Evidence URIs already recorded by the bot (pin://, metafile://, paths). */
  evidence: string[];
  /** The bot's declared next step, or the objective reason when it declared none. */
  nextSteps: string[];
  language?: DigestLanguage;
  meta: {
    sessionId: string;
    taskId?: string | null;
    metabotName?: string | null;
    reason?: ProcessNeedsHumanReason | null;
    generatedAt?: number;
  };
}

const escapeHtml = (value: string): string => value
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const DIGEST_COPY = {
  zh: {
    kicker: '进程摘要件',
    conclusion: '结论',
    evidence: '证据',
    next: '建议下一步',
    emptyEvidence: '承办 bot 未登记证据条目',
    emptyNext: '未声明额外动作 — 打开会话继续指示',
    meta: '来源',
    reason: '等待原因',
    session: '会话',
    task: '任务',
    generated: '生成时间',
    reasonLabels: {
      overrun: '超出预期时长',
      waiting_owner: '等你拍板',
      waiting_external: '等待外部条件',
      permission: '等待权限确认',
      decision: '需要你决定',
    },
  },
  en: {
    kicker: 'Process digest',
    conclusion: 'Conclusion',
    evidence: 'Evidence',
    next: 'Suggested next step',
    emptyEvidence: 'The authoring bot recorded no evidence entry',
    emptyNext: 'No extra action declared — open the conversation to steer',
    meta: 'Source',
    reason: 'Waiting reason',
    session: 'Session',
    task: 'Task',
    generated: 'Generated',
    reasonLabels: {
      overrun: 'Over expected duration',
      waiting_owner: 'Waiting for your verdict',
      waiting_external: 'Waiting on an external condition',
      permission: 'Waiting for permission',
      decision: 'Needs your decision',
    },
  },
} as const;

/**
 * The 摘要件: a plain, self-contained HTML page (inline CSS, no external asset,
 * no script) so it renders identically in the Bot Browser preview route and in
 * any static viewer. Three sections in the owner's order: 结论 / 证据 / 建议下一步.
 */
export const buildProcessDigestHtml = (input: ProcessDigestInput): string => {
  const lang: DigestLanguage = input.language === 'zh' ? 'zh' : 'en';
  const copy = DIGEST_COPY[lang];
  const title = input.title.trim() || copy.kicker;
  const conclusion = input.conclusion.trim() || '—';
  const evidence = input.evidence.map((item) => String(item ?? '').trim()).filter(Boolean);
  const nextSteps = input.nextSteps.map((item) => String(item ?? '').trim()).filter(Boolean);
  const generatedAt = input.meta.generatedAt ?? Date.now();
  const reasonLabel = input.meta.reason ? copy.reasonLabels[input.meta.reason] : null;
  return `<!DOCTYPE html>
<html lang="${lang === 'zh' ? 'zh-CN' : 'en'}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)} · ${escapeHtml(copy.kicker)}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; padding: 32px 24px; font-family: -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; background: #ffffff; color: #303133; }
  main { max-width: 760px; margin: 0 auto; }
  .kicker { font-size: 11px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: #64748B; }
  h1 { margin: 6px 0 20px; font-size: 22px; line-height: 1.35; }
  section { border: 1px solid #BFC2CC; border-radius: 10px; padding: 15px; margin-bottom: 11.25px; }
  h2 { margin: 0 0 8px; font-size: 11px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: #64748B; }
  p { margin: 0; font-size: 13px; line-height: 1.6; white-space: pre-wrap; }
  ul { margin: 0; padding-left: 18px; }
  li { font-size: 12.5px; line-height: 1.6; word-break: break-all; }
  footer { margin-top: 14px; font-size: 11px; line-height: 1.7; color: #64748B; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; }
  @media (prefers-color-scheme: dark) { body { background: #1f2937; color: #e5e7eb; } section { border-color: #374151; } .kicker, h2, footer { color: #9ca3af; } }
</style>
</head>
<body>
<main>
  <div class="kicker">${escapeHtml(copy.kicker)}</div>
  <h1>${escapeHtml(title)}</h1>
  <section data-digest-section="conclusion">
    <h2>${escapeHtml(copy.conclusion)}</h2>
    <p>${escapeHtml(conclusion)}</p>
  </section>
  <section data-digest-section="evidence">
    <h2>${escapeHtml(copy.evidence)}</h2>
    ${evidence.length > 0
      ? `<ul>${evidence.map((item) => `<li><code>${escapeHtml(item)}</code></li>`).join('')}</ul>`
      : `<p>${escapeHtml(copy.emptyEvidence)}</p>`}
  </section>
  <section data-digest-section="next">
    <h2>${escapeHtml(copy.next)}</h2>
    ${nextSteps.length > 0
      ? `<ul>${nextSteps.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`
      : `<p>${escapeHtml(copy.emptyNext)}</p>`}
  </section>
  <footer>
    <div>${escapeHtml(copy.session)}: <code>${escapeHtml(input.meta.sessionId)}</code></div>
    ${input.meta.taskId ? `<div>${escapeHtml(copy.task)}: <code>${escapeHtml(input.meta.taskId)}</code></div>` : ''}
    ${input.meta.metabotName ? `<div>${escapeHtml(copy.meta)}: ${escapeHtml(input.meta.metabotName)}</div>` : ''}
    ${reasonLabel ? `<div>${escapeHtml(copy.reason)}: ${escapeHtml(reasonLabel)}</div>` : ''}
    <div>${escapeHtml(copy.generated)}: ${escapeHtml(new Date(generatedAt).toISOString())}</div>
  </footer>
</main>
</body>
</html>
`;
};

/** Path-safe token (task ids / session ids are uuid-ish; anything else is folded). */
const safeSegment = (value: string): string => {
  const cleaned = String(value ?? '').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  return cleaned.slice(0, 96) || 'unassigned';
};

/** `<userData>/process-digest/<taskId>/<stamp>.html` — M6=A's fixed location. */
export const processDigestFilePath = (
  userDataDir: string,
  taskKey: string,
  stamp: string,
): string => path.join(userDataDir, 'process-digest', safeSegment(taskKey), `${safeSegment(stamp)}.html`);

export interface ProcessDigestWriteResult {
  filePath: string;
  /** `preview-metaapp://…` — the app's existing local preview route. */
  artifactUri: string;
}

/**
 * Write the digest and return its preview URI (the value that rides the
 * notification's `target.artifactUri`). Synchronous on purpose: the terminal
 * hook is not on the turn's hot path, and a partial async write has no
 * recovery story.
 */
export const writeProcessDigest = (input: {
  userDataDir: string;
  taskKey: string;
  stamp: string;
  html: string;
}): ProcessDigestWriteResult => {
  const filePath = processDigestFilePath(input.userDataDir, input.taskKey, input.stamp);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, input.html, 'utf8');
  return { filePath, artifactUri: previewMetaappUriForPath(filePath) };
};
