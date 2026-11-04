import { formatBotWorkspaceDate } from './botWorkspace';
import { stripLoneSurrogates, truncateUtf16Units } from './llmSafeText';
import { describeWeixinOutboundCapabilities } from '../im/weixinMedia';
import {
  formatOutboundByteLimit,
  renderOutboundChannelForPrompt,
  type IMOutboundChannelView,
} from '../im/imOutbound';
import {
  WEIXIN_GROUP_MESSAGING_SUPPORTED,
  WEIXIN_INBOUND_VOICE_AUDIO_SUPPORTED,
} from '../im/weixinProtocol';
import { describeImPermissionMode } from '../im/imPermissionPolicy';

/**
 * Experience prompt blocks — the hot layer of the tiered experience system.
 *
 * Pure builders for the always-on blocks injected alongside a bot's prompt:
 * the protected self-identity entry ("我是谁", written by the dream service),
 * dream-distilled value boundaries, past work reviews, and the last few days'
 * daily summaries. Warm/cold layers are not injected; they are reached through
 * the experience_recall tool, whose query defaults and result formatting also
 * live here.
 */

export const RECENT_SUMMARIES_PROMPT_DAYS = 7;
export const RECENT_SUMMARIES_MAX_CHARS = 2000;
export const RECALL_WARM_DAYS = 30;
export const RECALL_MAX_LIMIT = 30;
/**
 * Dream-RSI §5.1 guardrail: semantic guidance over-constrains behavior when it
 * crowds the context. The three guidance blocks (value boundaries, work
 * reviews, proven techniques) share one char budget; when over it, the
 * least-distilled layer is trimmed first (techniques → reviews → boundaries).
 */
export const GUIDANCE_MAX_CHARS = 3000;
// Dream diaries now scale with the day's activity, so recall must not clip a
// rich day back to a fixed blurb. 1500 chars still keeps a 30-day recall bounded.
const RECALL_ENTRY_MAX_CHARS = 1500;

export interface ExperienceSummarySessionRef {
  sessionId: string;
  title: string;
}

export interface ExperienceSummaryLike {
  summaryDate: string;
  summaryText: string;
  sessionRefs?: ExperienceSummarySessionRef[];
}

const escapeXml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

/**
 * The bot's own dream-written "who am I" entry. Present in every context
 * (cowork UI and A2A) — it describes the bot itself, not the user, so it does
 * not fall under the external-channel owner-memory privacy block.
 */

/**
 * Hard cap for the INJECTED identity text (dream review P0 2026-10-23). The
 * identity is the most-protected prompt block, but an unbounded row still
 * crowds every context it rides in — over the cap it is cut with an explicit
 * truncation marker; the full text stays in long-term memory and remains
 * reachable through recall. The dream-side write contract (200-600 chars)
 * keeps normal identities far below this cap — it is a guard rail, not a
 * budget.
 */
export const SELF_IDENTITY_PROMPT_MAX_CHARS = 1500;
const SELF_IDENTITY_TRUNCATION_MARKER = '……(身份记录过长,此处截断;完整记录见长期记忆)';

export function buildSelfIdentityBlock(identityText: string): string {
  const trimmed = identityText?.trim();
  if (!trimmed) return '';
  const capped = trimmed.length > SELF_IDENTITY_PROMPT_MAX_CHARS
    ? `${truncateUtf16Units(trimmed, SELF_IDENTITY_PROMPT_MAX_CHARS)}${SELF_IDENTITY_TRUNCATION_MARKER}`
    : trimmed;
  return [
    '<metabot_self_identity>',
    escapeXml(capped),
    '</metabot_self_identity>',
    '<instruction>',
    'The &lt;metabot_self_identity&gt; block above is your own self-cognition, written and refined by',
    'yourself in your nightly dreams: its core is stable, its details evolve with your experiences.',
    'Do not recite it to the user — ALIGN your behavior with it. Let what you say and do live up to',
    'who you believe you are.',
    '</instruction>',
  ].join('\n');
}

/**
 * The bot's self-grown code of conduct: abstract value boundaries distilled
 * from its own experiences during nightly dreams. Injected so they actively
 * constrain behavior, not just sit in storage.
 */
export function buildValueBoundariesBlock(entries: Array<{ text: string }>, maxItems = 5): string {
  const items = entries
    .map((entry) => entry.text?.trim())
    .filter((text): text is string => Boolean(text))
    .slice(0, Math.max(1, maxItems));
  if (items.length === 0) return '';
  return [
    '<value_boundaries>',
    ...items.map((text) => `  <rule>${escapeXml(text)}</rule>`),
    '</value_boundaries>',
    '<instruction>',
    'The &lt;value_boundaries&gt; block lists rules you distilled from your own past experiences.',
    'They are boundaries, not scripts: they delimit what to avoid, and you honor them — but when a',
    'situation genuinely calls for a different approach, adapt deliberately rather than following blindly.',
    '</instruction>',
  ].join('\n');
}

/**
 * Past work reviews written by the dream service — including the owner's
 * acceptance ratings and review comments on group tasks — injected so prior
 * feedback actively guides new work instead of sitting in storage.
 */
export function buildWorkReviewsBlock(entries: Array<{ text: string }>, maxItems = 5): string {
  const items = entries
    .map((entry) => entry.text?.trim())
    .filter((text): text is string => Boolean(text))
    .slice(0, Math.max(1, maxItems));
  if (items.length === 0) return '';
  return [
    '<work_reviews>',
    ...items.map((text) => `  <review>${escapeXml(text)}</review>`),
    '</work_reviews>',
    '<instruction>',
    'The &lt;work_reviews&gt; block lists reviews of your past work, distilled in your nightly dreams',
    'and aligned with the human\'s acceptance ratings and comments. When a new task resembles one of',
    'them, reuse the approaches the human rated highly and avoid the patterns they criticized.',
    '</instruction>',
  ].join('\n');
}

/**
 * Hot layer: the bot's last few days of dream summaries, newest first,
 * oldest dropped when over the char budget.
 */
export function buildRecentDailySummariesBlock(
  summaries: ExperienceSummaryLike[],
  maxChars: number = RECENT_SUMMARIES_MAX_CHARS
): string {
  if (!summaries.length) return '';
  const dayBlocks: string[] = [];
  let used = 0;
  for (const summary of summaries) {
    // Dream-written text is stored free text — sanitize halves on render.
    const text = summary.summaryText ? stripLoneSurrogates(summary.summaryText.trim()) : '';
    if (!text) continue;
    const block = `  <day date="${escapeXml(summary.summaryDate)}">${escapeXml(text)}</day>`;
    if (dayBlocks.length > 0 && used + block.length > maxChars) break;
    dayBlocks.push(block);
    used += block.length;
  }
  if (dayBlocks.length === 0) return '';
  return [
    '<recent_daily_summaries>',
    ...dayBlocks,
    '</recent_daily_summaries>',
    '<instruction>',
    'The &lt;recent_daily_summaries&gt; block lists what you did on each recent day — these summaries',
    'ARE your dreams (做梦), written by yourself during the nightly dream consolidation. When the user',
    'asks whether you dreamed, what you dreamed about, or whether you remember a certain day',
    '(做梦/梦境/梦到/还记得), answer from these summaries, and call the experience_recall tool for',
    'any earlier date range or a full-history search. To recall the exact pins you published or fully',
    'read on-chain (with their pin ids), call the chain_history_recall tool instead.',
    '</instruction>',
  ].join('\n');
}

/**
 * Validated capability drafts ("proven techniques"): dream-distilled skills
 * and workflows that survived the dream-time validation pass against recorded
 * history. Injected as available options the bot may apply when the situation
 * matches — never as standing orders (Dream-RSI §5.1: strong semantic
 * directives over-constrain behavior).
 */
export function buildProvenTechniquesBlock(
  entries: Array<{ title: string; description?: string | null }>,
  maxItems = 5,
): string {
  const items = entries
    .map((entry) => ({
      title: entry.title?.trim(),
      description: entry.description?.trim() ?? '',
    }))
    .filter((entry) => Boolean(entry.title))
    .slice(0, Math.max(1, maxItems));
  if (items.length === 0) return '';
  return [
    '<proven_techniques>',
    ...items.map((entry) => `  <technique name="${escapeXml(entry.title!)}">${escapeXml(entry.description)}</technique>`),
    '</proven_techniques>',
    '<instruction>',
    'The &lt;proven_techniques&gt; block lists techniques you distilled in past dreams AND validated',
    'against your own recorded history. When a new task matches one, apply it; when none match, work',
    'as usual. These are proven options, not standing orders.',
    '</instruction>',
  ].join('\n');
}

export function buildExperiencePromptBlocksXml(input: {
  identityText?: string | null;
  summaries: ExperienceSummaryLike[];
  valueBoundaries?: Array<{ text: string }>;
  workReviews?: Array<{ text: string }>;
  provenTechniques?: Array<{ title: string; description?: string | null }>;
  maxChars?: number;
}): string {
  const identityBlock = input.identityText ? buildSelfIdentityBlock(input.identityText) : '';
  const summariesBlock = buildRecentDailySummariesBlock(input.summaries, input.maxChars);

  // §5.1 guardrail (Dream-RSI): semantic guidance over-constrains behavior
  // when it crowds the context. The three guidance blocks share one char
  // budget; when over it, trim the least-distilled layer first — techniques,
  // then reviews, and boundaries last (they are the hardest-won rules).
  const boundaries = input.valueBoundaries ?? [];
  const reviews = input.workReviews ?? [];
  const techniques = input.provenTechniques ?? [];
  const capLadder: Array<[number, number, number]> = [
    [5, 5, 5],
    [5, 5, 3],
    [5, 3, 0],
    [3, 0, 0],
  ];
  let guidanceBlocks: string[] = [];
  for (const [boundaryCap, reviewCap, techniqueCap] of capLadder) {
    // The builders clamp maxItems to ≥1, so a 0 cap must skip the block here.
    guidanceBlocks = [
      boundaryCap > 0 ? buildValueBoundariesBlock(boundaries, boundaryCap) : '',
      reviewCap > 0 ? buildWorkReviewsBlock(reviews, reviewCap) : '',
      techniqueCap > 0 ? buildProvenTechniquesBlock(techniques, techniqueCap) : '',
    ];
    const totalChars = guidanceBlocks.reduce((sum, block) => sum + block.length, 0);
    if (totalChars <= GUIDANCE_MAX_CHARS) break;
  }

  return [identityBlock, ...guidanceBlocks, summariesBlock]
    .filter((block) => block.trim())
    .join('\n\n');
}

/** Overall cap for the minimal self-cognition pack (identity itself capped at
 * SELF_IDENTITY_PROMPT_MAX_CHARS with a truncation marker; summaries cut first). */
export const MINIMAL_SELF_COGNITION_MAX_CHARS = 2500;
/** Char budget for the dream-summaries section inside the minimal pack. */
export const MINIMAL_SELF_COGNITION_SUMMARIES_MAX_CHARS = 1500;

/**
 * Minimal self-cognition pack for the lightweight one-shot LLM paths that have
 * no cowork runner to inject the full experience block (group-chat direct
 * replies, OpenTeam guest plain turns): the protected self-identity entry —
 * itself capped at SELF_IDENTITY_PROMPT_MAX_CHARS with an explicit truncation
 * marker inside buildSelfIdentityBlock — plus the last days' dream summaries
 * under their own char budget (newest kept). Over the overall cap the
 * summaries shrink first, then drop entirely; when the (already capped)
 * identity alone still exceeds the cap the pack is returned whole — the
 * identity instruction block's integrity beats the budget.
 */
export function buildMinimalSelfCognitionBlocks(input: {
  identityText?: string | null;
  summaries: ExperienceSummaryLike[];
  maxChars?: number;
}): string {
  const cap = Math.max(500, Math.floor(input.maxChars ?? MINIMAL_SELF_COGNITION_MAX_CHARS));
  const identityBlock = input.identityText ? buildSelfIdentityBlock(input.identityText) : '';
  const attempts: Array<{ summariesMaxChars?: number; dropSummaries?: boolean }> = [
    {},
    { summariesMaxChars: 600 },
    { dropSummaries: true },
  ];
  let lastBlock = '';
  for (const attempt of attempts) {
    const summariesBlock = attempt.dropSummaries
      ? ''
      : buildRecentDailySummariesBlock(
          input.summaries,
          attempt.summariesMaxChars ?? MINIMAL_SELF_COGNITION_SUMMARIES_MAX_CHARS
        );
    const block = [identityBlock, summariesBlock].filter((section) => section.trim()).join('\n\n');
    if (!block) return '';
    lastBlock = block;
    if (block.length <= cap) return block;
  }
  return lastBlock;
}

// ---------------------------------------------------------------------------
// Channel capability manifest (通道能力清单)
// ---------------------------------------------------------------------------

/** Byte ceiling rendered for a prompt: derived from the constant, never typed. */
export function formatChannelCapabilityByteLimit(bytes: number): string {
  return formatOutboundByteLimit(bytes);
}

const formatExtensionList = (extensions: string[]): string =>
  extensions.length > 0 ? extensions.map((extension) => `.${extension}`).join(' ') : '(none)';

export interface ChannelCapabilityBlockOptions {
  /**
   * The cowork permission mode this turn actually runs under (read from the
   * live session, so it is the same value the runner enforces). Defaults to
   * 'default' when unknown.
   */
  permissionMode?: 'default' | 'plan' | 'acceptEdits' | 'bypassPermissions';
  /**
   * `cowork_ui` only: the live channel inventory from
   * `IMGatewayManager.listOutboundChannels()`. `undefined` (test/minimal
   * embedders with no IM manager) and `[]` both render the explicit
   * "当前没有可用通道" block — the desktop prompt must never stay silent about
   * this, because silence is what sent the model off to drive the WeChat
   * client window. Connected channels are listed with their capabilities;
   * unconnected ones are named as 未连接 rather than described as unsupported.
   */
  connectedChannels?: IMOutboundChannelView[];
}

/**
 * Desktop (cowork_ui) capability manifest.
 *
 * Two facts matter more than the lists: (1) the machine can send through the
 * channel API, and (2) the agent must NOT try to drive the WeChat/QQ/Feishu
 * desktop client. A real desktop session was asked to "给微信发消息" and went
 * looking for the client process — this block exists to make that route
 * unreachable-by-instruction.
 *
 * Every extension list and byte ceiling comes from the channel gateway's own
 * tables (passed in as `channels`, produced by
 * `IMGatewayManager.listOutboundChannels()`); nothing here is hand-copied.
 */
function buildCoworkUiChannelCapabilitiesBlock(
  channel: string,
  channels: IMOutboundChannelView[]
): string {
  const sendable = channels.filter((entry) => entry.connected && entry.sendable);
  // Connected but not yet addressable (usually: no private chat seen yet).
  const connectedButBlocked = channels.filter((entry) => entry.connected && !entry.sendable);
  const offline = channels.filter((entry) => !entry.connected);
  const offlineLine = offline.length > 0
    ? `- 未连接：${offline.map((entry) => `${entry.label}（${entry.platform}）`).join('、')}`
    : '';
  const lines: string[] = [
    `<channel_capabilities channel="${escapeXml(channel)}" source="imGatewayManager">`,
  ];
  if (sendable.length === 0) {
    lines.push(
      '当前没有可用通道：本机此刻没有「已连接且可主动发送」的 IM 通道（若应用刚启动，通道可能仍在连接中）。不要假装已经发出任何内容，也不要模拟操作任何 IM 客户端窗口；请明确告诉用户需要先在设置里连接通道。'
    );
    for (const entry of connectedButBlocked) lines.push(renderOutboundChannelForPrompt(entry));
    if (offlineLine) lines.push(offlineLine);
  } else {
    lines.push(
      '当前是电脑端（cowork_ui）会话。下列已连接的 IM 通道可以主动发消息与文件——用 im_send_message 工具发送，不要模拟操作微信/QQ/飞书客户端窗口，也不要检查客户端进程是否在运行。'
    );
    for (const entry of sendable) lines.push(renderOutboundChannelForPrompt(entry));
    if (connectedButBlocked.length > 0) {
      lines.push('尚不能发送：');
      for (const entry of connectedButBlocked) lines.push(renderOutboundChannelForPrompt(entry));
    }
    if (offlineLine) lines.push(offlineLine);
    lines.push(
      `发送规则：默认且只允许发往该通道上最近一次与你的私聊会话（target 留空即为默认）；任何其他会话 id 都会被拒绝。附件必须写本地绝对路径并放进 attachments 参数（不要写进正文，避免部分通道重复发送），单文件上限见上表。`
    );
  }
  lines.push('</channel_capabilities>');
  lines.push('<instruction>');
  lines.push(
    'The &lt;channel_capabilities&gt; block is the machine\'s live IM inventory, read from the gateway'
  );
  lines.push(
    'implementations at prompt time. Send through the im_send_message tool; if a channel is not listed'
  );
  lines.push(
    'as sendable, do not claim it can send and do not fall back to UI automation of an IM client.'
  );
  lines.push('</instruction>');
  return lines.join('\n');
}

/**
 * What THIS chat channel can actually send, in the agent's own prompt.
 *
 * Same-source guarantee: every extension and the size ceiling are read from
 * `weixinMedia`'s own tables (`MIME_BY_EXTENSION` → `uploadKindForFile` and
 * `WEIXIN_OUTBOUND_MAX_BYTES`) through `describeWeixinOutboundCapabilities()`,
 * and the two "cannot do" facts come from `weixinProtocol` constants. Adding an
 * audio extension or changing the ceiling therefore changes the advertised
 * manifest in the same edit — no hand-copied numbers to drift.
 *
 * Scope: `im:` channels keep their per-channel manifest; `cowork_ui` gets the
 * desktop inventory (see buildCoworkUiChannelCapabilitiesBlock). Any other
 * channel returns '' — advertising capabilities nobody verified would be worse
 * than saying nothing.
 */
export function buildChannelCapabilitiesBlock(
  channel: string | null | undefined,
  options: ChannelCapabilityBlockOptions = {}
): string {
  const normalized = typeof channel === 'string' ? channel.trim().toLowerCase() : '';
  if (normalized === 'cowork_ui') {
    return buildCoworkUiChannelCapabilitiesBlock(normalized, options.connectedChannels ?? []);
  }
  if (!normalized.startsWith('im:')) return '';
  const [platform] = normalized.split(':').slice(1);
  if (platform !== 'weixin') return '';
  const isGroup = normalized.endsWith(':group');

  if (isGroup && !WEIXIN_GROUP_MESSAGING_SUPPORTED) {
    return [
      `<channel_capabilities channel="${escapeXml(normalized)}">`,
      '当前会话是微信「群聊」通道，但该微信账号的群聊消息能力在平台侧被禁用（代码常量 WEIXIN_GROUP_MESSAGING_SUPPORTED = false）。',
      '因此：不要尝试在此会话发送任何微信消息或附件；如需交付文件，请说明原因并改用私聊通道。',
      '</channel_capabilities>',
    ].join('\n');
  }

  const capabilities = describeWeixinOutboundCapabilities();
  const directions = capabilities.extensionsByKind;
  // Audio is a FILE attachment on this channel, so list it separately from the
  // other documents instead of advertising a voice item that is never produced.
  const audioExtensions = new Set(capabilities.audioExtensions);
  const documentExtensions = directions.file.filter((extension) => !audioExtensions.has(extension));
  const inboundVoiceRule = WEIXIN_INBOUND_VOICE_AUDIO_SUPPORTED
    ? '入站语音会下载音频。'
    : '入站语音不下载音频，只使用服务端转写文字（voice_item.text）。';
  const permissionLine = `- 权限模式：${describeImPermissionMode(options.permissionMode ?? 'default')}`;
  return [
    `<channel_capabilities channel="${escapeXml(normalized)}" source="weixinMedia.ts">`,
    '当前是微信私聊通道。把本地绝对路径写进回复正文即可发送附件（系统自动识别并转成对应消息类型）；只接受本地绝对路径，不接受公网 URL。',
    `- 图片：${formatExtensionList(directions.image)}`,
    `- 视频：${formatExtensionList(directions.video)}`,
    `- 音频：${formatExtensionList(capabilities.audioExtensions)}；按普通文件发送（file_item，media_type 3），客户端显示为音频文件附件，不生成语音条`,
    `- 普通文件：${formatExtensionList(documentExtensions)}；未列出的扩展名同样按普通文件发送`,
    `- 单文件上限：${formatChannelCapabilityByteLimit(capabilities.maxOutboundBytes)}（WEIXIN_OUTBOUND_MAX_BYTES = ${capabilities.maxOutboundBytes} bytes）`,
    `- 不能做：微信群聊发送（${WEIXIN_GROUP_MESSAGING_SUPPORTED ? '可用' : '平台侧禁用，仅私聊可用'}）；${inboundVoiceRule}`,
    permissionLine,
    '</channel_capabilities>',
    '<instruction>',
    'The &lt;channel_capabilities&gt; block is derived from the channel implementation itself. When it',
    'disagrees with any generic media instruction elsewhere in this prompt, THIS block wins: it is what',
    'the running code will actually do with a path you write.',
    '</instruction>',
  ].join('\n');
}

export type ExperienceRecallGranularity = 'day' | 'week' | 'month';

export interface ExperienceRecallArgs {
  query?: string;
  date_from?: string;
  date_to?: string;
  /** Group results by day (default), ISO week, or month — compresses long ranges. */
  granularity?: ExperienceRecallGranularity;
  limit?: number;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const normalizeDateArg = (value?: string): string | undefined => {
  const trimmed = value?.trim();
  return trimmed && DATE_RE.test(trimmed) ? trimmed : undefined;
};

const normalizeGranularity = (value?: string): ExperienceRecallGranularity => {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return normalized === 'week' || normalized === 'month' ? normalized : 'day';
};

/** Monday-based YYYY-MM-DD key for the week containing the given YYYY-MM-DD date. */
function weekKeyOf(dateStr: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!match) return dateStr;
  const [, y, m, d] = match;
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  const dow = date.getUTCDay(); // 0=Sun..6=Sat
  const diff = (dow === 0 ? -6 : 1) - dow; // shift to Monday
  const monday = new Date(date);
  monday.setUTCDate(date.getUTCDate() + diff);
  return `${monday.getUTCFullYear()}-${String(monday.getUTCMonth() + 1).padStart(2, '0')}-${String(monday.getUTCDate()).padStart(2, '0')}`;
}

function groupKeyOf(dateStr: string, granularity: ExperienceRecallGranularity): string {
  if (granularity === 'month') return dateStr.slice(0, 7); // YYYY-MM
  if (granularity === 'week') return weekKeyOf(dateStr);
  return dateStr;
}

/**
 * Warm/cold defaults for the recall tool: a bare call looks back
 * RECALL_WARM_DAYS (warm); a keyword query searches the full history (cold),
 * unless the caller pins explicit dates. Args use the tool schema's
 * snake_case names; the result is normalized to camelCase.
 */
export function resolveExperienceRecallQuery(
  args: ExperienceRecallArgs,
  today: Date = new Date()
): { query?: string; dateFrom?: string; dateTo?: string; granularity: ExperienceRecallGranularity; limit: number } {
  const limit = Math.max(1, Math.min(RECALL_MAX_LIMIT, Math.floor(args.limit ?? 10)));
  const query = args.query?.trim() || undefined;
  let dateFrom = normalizeDateArg(args.date_from);
  const dateTo = normalizeDateArg(args.date_to);
  if (!query && !dateFrom) {
    dateFrom = formatBotWorkspaceDate(
      new Date(today.getFullYear(), today.getMonth(), today.getDate() - RECALL_WARM_DAYS)
    );
  }
  return { query, dateFrom, dateTo, granularity: normalizeGranularity(args.granularity), limit };
}

/** Plain-text rendering of recall results for the tool response. */
export function formatExperienceRecallResults(
  summaries: ExperienceSummaryLike[],
  granularity: ExperienceRecallGranularity = 'day',
): string {
  if (!summaries.length) {
    return 'No experience summaries found for the given range or query. Days before your first dream run have no summary; recent days may not have been consolidated yet — try granularity=day, or widen the range.';
  }
  if (granularity === 'day') {
    return formatDailyRecall(summaries);
  }
  return formatGroupedRecall(summaries, granularity);
}

function formatDailyRecall(summaries: ExperienceSummaryLike[]): string {
  const lines: string[] = [];
  for (const summary of summaries) {
    const text = stripLoneSurrogates(summary.summaryText.replace(/\s+/g, ' ').trim());
    const truncated = text.length > RECALL_ENTRY_MAX_CHARS ? `${truncateUtf16Units(text, RECALL_ENTRY_MAX_CHARS)}…` : text;
    lines.push(`${summary.summaryDate}: ${truncated}`);
    for (const ref of summary.sessionRefs ?? []) {
      const title = ref.title?.trim();
      lines.push(`  - IDBots://${ref.sessionId}${title ? ` ${title}` : ''}`);
    }
  }
  return [
    ...lines,
    '',
    'These daily summaries index your full experience records, and the IDBots:// links above point at the complete conversations behind them. When a task resembles something you did before, read the relevant session with idbots_session_read_all first: reuse the approaches that worked, and avoid the pitfalls you already stepped into.',
  ].join('\n');
}

function formatGroupedRecall(summaries: ExperienceSummaryLike[], granularity: ExperienceRecallGranularity): string {
  // Preserve first-seen order of groups (summaries arrive newest-first).
  const groupOrder: string[] = [];
  const byGroup = new Map<string, ExperienceSummaryLike[]>();
  for (const summary of summaries) {
    const key = groupKeyOf(summary.summaryDate, granularity);
    if (!byGroup.has(key)) {
      groupOrder.push(key);
      byGroup.set(key, []);
    }
    byGroup.get(key)!.push(summary);
  }
  const label = granularity === 'week' ? 'Week of' : 'Month';
  const lines: string[] = [];
  for (const key of groupOrder) {
    const group = byGroup.get(key)!;
    const dates = group.map((item) => item.summaryDate).sort();
    const span = dates.length > 1 ? `${dates[dates.length - 1]}..${dates[0]}` : dates[0];
    lines.push(`${label} ${key} (${group.length} day${group.length > 1 ? 's' : ''}, ${span}):`);
    for (const summary of group) {
      const text = stripLoneSurrogates(summary.summaryText.replace(/\s+/g, ' ').trim());
      const truncated = text.length > RECALL_ENTRY_MAX_CHARS ? `${truncateUtf16Units(text, RECALL_ENTRY_MAX_CHARS)}…` : text;
      lines.push(`  - ${summary.summaryDate}: ${truncated}`);
    }
  }
  return [
    ...lines,
    '',
    `Summaries above are grouped by ${granularity} to compress a long range. For a specific day's full detail (and the IDBots:// session links), re-call with granularity=day and a tight date_from/date_to. When a task resembles something you did before, read the relevant session with idbots_session_read_all.`,
  ].join('\n');
}

/**
 * Raw-episode fallback for date ranges that have no dream summary yet (the bot
 * was off, or dreaming was enabled late). Rendered as a compact timeline of
 * episode titles so the time-anchored recall is never blind for un-dreamed
 * days. Episodes are the shared fact source, so this adds no duplication.
 */
export function formatExperienceTimelineFallback(input: {
  dateFrom?: string;
  dateTo?: string;
  episodes: Array<{ startedAt: number; sourceChannel: string; episodeType: string; title?: string | null; archived?: boolean }>;
}): string {
  if (!input.episodes.length) {
    return `No raw episodes found for ${input.dateFrom ?? 'the range'}${input.dateTo ? `..${input.dateTo}` : ''} either — there may genuinely be no activity in that window.`;
  }
  const lines = input.episodes.map((episode) => {
    const when = new Date(episode.startedAt).toISOString().slice(0, 10);
    const title = typeof episode.title === 'string' && episode.title.trim() ? episode.title.trim() : `${episode.sourceChannel}/${episode.episodeType}`;
    const archivedMark = episode.archived ? ' (archived)' : '';
    return `- ${when} [${episode.episodeType}]${archivedMark}: ${title}`;
  });
  return [
    `No dream summaries were consolidated for ${input.dateFrom ?? 'this range'}${input.dateTo ? `..${input.dateTo}` : ''}, but the raw activity timeline shows ${input.episodes.length} episode(s):`,
    ...lines,
    'These episodes were not yet distilled into a daily summary; re-call later (after the nightly dream) or with granularity=day for a summarized view.',
  ].join('\n');
}
