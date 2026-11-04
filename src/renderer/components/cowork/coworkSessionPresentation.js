export function shouldShowCoworkA2ADot({ sessionType, showStatusIndicator }) {
  if (showStatusIndicator) return false;
  if (sessionType === 'a2a') return false;
  return false;
}

export function getCoworkSessionTitleClassName(input) {
  const sessionType = typeof input === 'string' ? input : input?.sessionType;
  const serviceOrderStatus = typeof input === 'string' ? undefined : input?.serviceOrderStatus;

  if (sessionType === 'a2a' && serviceOrderStatus === 'refund_pending') {
    return 'text-sm font-medium truncate leading-tight text-orange-600 dark:text-orange-400';
  }

  if (sessionType === 'a2a' && serviceOrderStatus === 'refunded') {
    return 'text-sm font-medium truncate leading-tight text-emerald-600 dark:text-emerald-400';
  }

  return sessionType === 'a2a'
    ? 'text-sm font-medium truncate leading-tight text-blue-500 dark:text-blue-400'
    : 'text-sm font-medium truncate leading-tight dark:text-claude-darkText text-claude-text';
}

export function shouldShowA2AServiceSessionId(input) {
  const sessionId = typeof input?.sessionId === 'string' ? input.sessionId.trim() : '';
  if (!sessionId) return false;
  if (input?.sessionType !== 'a2a') return false;
  return Boolean(input?.serviceOrderSummary);
}

export function buildPrivateA2ASessionDisplayId(localGlobalMetaId, peerGlobalMetaId) {
  const localPrefix = typeof localGlobalMetaId === 'string' ? localGlobalMetaId.trim().slice(0, 8) : '';
  const peerPrefix = typeof peerGlobalMetaId === 'string' ? peerGlobalMetaId.trim().slice(0, 8) : '';
  if (!localPrefix || !peerPrefix) return '';
  return `${localPrefix}-${peerPrefix}`;
}

/**
 * Assistant-mode display title for a session row: strips the localized
 * orchestration prefix ("[编排任务] " / "[Orchestration Task] ") that
 * orchestrator-delegated worker sessions carry. The prefix doubles as a
 * grouping key for auto-grouping and store queries, so this is render-only —
 * the stored title (rename flow, grouping, LIKE queries) is untouched, and
 * professional mode keeps showing it. The row already lives in the
 * autonomous-tasks fold, so for a non-technical reader the prefix carries no
 * information beyond engineering flavor.
 */
export function getAssistantSessionDisplayTitle(title, enabled) {
  if (!enabled || typeof title !== 'string') return title;
  const stripped = title.replace(/^(\[(?:编排任务|Orchestration Task)\])\s+/, '');
  return stripped || title;
}

/**
 * IM session classification for the session list.
 *
 * `imChannel` comes from cowork_conversation_mappings (`im:qq:group` /
 * `im:qq:direct`) via listSessions, so a row created BEFORE IM sessions were
 * re-classified as 'standard' (they used to be 'a2a') is still identifiable
 * without a destructive data migration.
 *
 * Returns null for non-IM sessions.
 */
export function getImSessionChannelInfo(input) {
  const channel = typeof input === 'string' ? input : input?.imChannel;
  const value = typeof channel === 'string' ? channel.trim() : '';
  // `im:<platform>:<kind>` is the current shape; very old rows only carry
  // `im:<platform>`, so the kind is recovered from the stored conversation id
  // (`qq:group:…` / `qq:c2c:…`) instead of guessing.
  const match = /^im:([a-z0-9_-]+)(?::(direct|group))?$/i.exec(value);
  if (!match) return null;
  const platform = match[1].toLowerCase();
  const conversationId = (
    typeof input === 'object' && input && typeof input.imConversationId === 'string'
      ? input.imConversationId.trim()
      : ''
  );
  let chatType = (match[2] || '').toLowerCase();
  if (!chatType) {
    if (/:group:/i.test(conversationId)) chatType = 'group';
    else if (/:c2c:|:direct:/i.test(conversationId)) chatType = 'direct';
  }
  if (chatType !== 'direct' && chatType !== 'group') return null;
  const lastSegment = conversationId.includes(':')
    ? conversationId.slice(conversationId.lastIndexOf(':') + 1)
    : conversationId;
  const suffix = chatType === 'group'
    ? lastSegment.replace(/[^A-Za-z0-9]/g, '').slice(-4)
    : '';
  return { platform, chatType, isGroup: chatType === 'group', suffix };
}

/**
 * True when the stored title is the old generic `IM-<platform>-<digits>`
 * placeholder. Those rows get an IM title rendered from the channel mapping
 * instead; a user-renamed or model-generated title is preserved as-is.
 */
export function isLegacyImSessionTitle(title) {
  return /^IM-[a-z0-9_-]+-\d+$/i.test(typeof title === 'string' ? title.trim() : '');
}
