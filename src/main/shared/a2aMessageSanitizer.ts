/**
 * Sanitize A2A private-chat message content so host-injected prompt blocks,
 * volatile CoWork metadata (e.g. `## Local Time Context`), inline `<think>`
 * blocks, and internal `[Host]` notices never leak into outgoing on-chain
 * messages or clutter rendered A2A chat bubbles.
 *
 * Fenced code blocks (``` ... ```) are preserved verbatim so technical messages
 * that intentionally discuss prompt/XML snippets inside code fences stay intact.
 */

const FENCED_CODE_BLOCK_RE = /(```[\s\S]*?```)/g;

const INLINE_THINK_TAG_RE = /<(?:think|thinking)\b[^>]*>[\s\S]*?<\/(?:think|thinking)>/gi;

const HOST_XML_VOLATILE_BLOCK_RE = /<(instant_ack|system-reminder|recent_sessions|metaid_cognition_context|ownerMemories|contactMemories|conversationMemories|ownerOperationalPreferences|metabot_self_identity|recent_daily_summaries|guidance)\b[^>]*>[\s\S]*?<\/\1>/gi;

const LOCAL_TIME_CONTEXT_BLOCK_RE = /(?:^|\r?\n)[ \t]*(?:#{1,6}[ \t]+)?Local Time Context[ \t]*\r?\n(?:[ \t]*-[ \t]*(?:Treat this section|请将本节视为|Current local|当前本地|Current unix timestamp|当前\s*unix\s*时间戳|Current CoWork session id|当前\s*CoWork\s*会话|For relative time|涉及相对时间|When creating one-time|创建一次性定时任务|For short-delay|短延迟一次性任务|Scheduled task prompts|定时任务提示)[^\r\n]*(?:\r?\n|$))+/gi;

const LANGUAGE_CONTRACT_BLOCK_RE = /(?:^|\r?\n)[ \t]*#{1,6}[ \t]+Language Contract\s*\(final instruction for this turn\)[ \t]*\r?\n(?:[ \t]*-[ \t]*[^\r\n]*(?:\r?\n|$))+/gi;

const WORKSPACE_SAFETY_BLOCK_RE = /(?:^|\r?\n)[ \t]*#{1,6}[ \t]+Workspace Safety Policy\s*\(Highest Priority\)[ \t]*\r?\n(?:[ \t]*-[ \t]*[^\r\n]*(?:\r?\n|$))+/gi;

const HUMAN_OPERATOR_GUIDANCE_HEADER_RE = /(?:^|\r?\n)[ \t]*#{1,6}[ \t]+Human Operator Guidance[ \t]*\r?\n[\s\S]*?(?=\r?\n#{1,6}[ \t]+|$)/gi;

const HOST_INTERNAL_NOTICE_LINE_RE = /(?:^|\r?\n)[ \t]*\[Host\][ \t]+(?:Wake check \d+:|Previous turn ended with no final reply text|Turn ended with no final reply text)[^\r\n]*(?=\r?\n|$)/gi;

function sanitizePlainSegment(segment: string): string {
  if (!segment) return segment;
  let cleaned = segment;
  cleaned = cleaned.replace(INLINE_THINK_TAG_RE, '');
  cleaned = cleaned.replace(HOST_XML_VOLATILE_BLOCK_RE, '');
  cleaned = cleaned.replace(LOCAL_TIME_CONTEXT_BLOCK_RE, '\n');
  cleaned = cleaned.replace(LANGUAGE_CONTRACT_BLOCK_RE, '\n');
  cleaned = cleaned.replace(WORKSPACE_SAFETY_BLOCK_RE, '\n');
  cleaned = cleaned.replace(HUMAN_OPERATOR_GUIDANCE_HEADER_RE, '\n');
  cleaned = cleaned.replace(HOST_INTERNAL_NOTICE_LINE_RE, '');
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
  return cleaned;
}

export function sanitizeA2APeerMessageContent(value: unknown): string {
  const raw = typeof value === 'string' ? value : String(value ?? '');
  if (!raw) return '';

  const sanitized = raw
    .split(FENCED_CODE_BLOCK_RE)
    .map((part) => (part.startsWith('```') ? part : sanitizePlainSegment(part)))
    .join('');

  return sanitized.trim();
}
