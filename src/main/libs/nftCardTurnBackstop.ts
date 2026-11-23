/**
 * Deterministic turn-end backstop for host-emitted chat NFT & Token protocol cards.
 *
 * Why this exists:
 * Mutating NFT / collection host tools (`mrc721_*`, `wallet_nft_*`) and
 * Token / FT host tools (`wallet_token_*`, `wallet_mrc20_*`) append fenced
 * protocol cards (`nft-card`, `nft-collection-card`, `token-card`,
 * `ft-order-card`, `ft-quote-card`, `ft-fill-card`, `ft-my-orders-card`,
 * `ft-portfolio-card`, `ft-bridge-card`, `ft-action-card`) to their tool
 * results and ask the agent to include them verbatim in its reply.
 * In Studio / Projector Mode (or when a model summarizes prose), the model
 * sometimes omits the fenced block from the chat bubble.
 *
 * The runner captures fences emitted by announcing tools during a turn and, if
 * any card identity was omitted from all visible assistant messages of that
 * turn, appends the missing fence(s) onto the turn's final visible assistant
 * reply after flushing stream overlays.
 */

export type NftCardBackstopTag =
  | 'nft-card'
  | 'nft-collection-card'
  | 'token-card'
  | 'ft-order-card'
  | 'ft-quote-card'
  | 'ft-fill-card'
  | 'ft-my-orders-card'
  | 'ft-portfolio-card'
  | 'ft-bridge-card'
  | 'ft-action-card';

export interface CapturedNftCardFence {
  /** Canonical deduplication key (`nft:pin:...`, `col:...`, `token:...`, `ft-...`). */
  key: string;
  tag: NftCardBackstopTag;
  /** Full fenced markdown block (` ```<tag>\n{...}\n``` `). */
  fence: string;
}

const ANNOUNCING_NFT_CARD_TOOLS = new Set<string>([
  'mrc721_collection_create',
  'mrc721_collection_update',
  'mrc721_mint',
  'mrc721_item_desc_batch',
  'mrc721_transfer',
  'mrc721_sell',
  'mrc721_buy',
  'mrc721_sell_intent',
  'mrc721_offer',
  'mrc721_take_offer',
  'wallet_nft_transfer',
  'wallet_nft_sell',
  'wallet_nft_cancel_sell',
  'wallet_nft_buy',
  'wallet_token_card',
  'wallet_token_quote',
  'wallet_token_issue',
  'wallet_token_mint',
  'wallet_token_send',
  'wallet_token_transfer',
  'wallet_token_sell',
  'wallet_token_buy',
  'wallet_token_take',
  'wallet_token_portfolio',
  'wallet_token_my_orders',
  'wallet_token_bridge_card',
]);

const NFT_CARD_FENCE_RE =
  /```(nft-card|nft-collection-card|token-card|tokencard|ft-order-card|ft-quote-card|ft-fill-card|ft-my-orders-card|ft-portfolio-card|ft-bridge-card|ft-action-card)[ \t]*\r?\n([\s\S]*?)\r?\n```/gi;

const FAST_BACKSTOP_HINT_RE =
  /```(?:nft-card|nft-collection-card|token-card|tokencard|ft-(?:order|quote|fill|my-orders|portfolio|bridge|action)-card)/i;

export function normalizeHostToolBaseName(toolName: string): string {
  const trimmed = String(toolName ?? '').trim();
  if (!trimmed) return '';
  const mcpMatch = trimmed.match(/^mcp__[^_]+__(.+)$/);
  return (mcpMatch ? mcpMatch[1] : trimmed).trim().toLowerCase();
}

export function isNftCardBackstopTool(toolName: string): boolean {
  return ANNOUNCING_NFT_CARD_TOOLS.has(normalizeHostToolBaseName(toolName));
}

function cleanKeyField(val: unknown): string {
  return typeof val === 'string' ? val.trim().toLowerCase() : '';
}

function deriveCardIdentityKey(
  tag: NftCardBackstopTag,
  parsed: Record<string, unknown>,
): string | null {
  if (tag === 'token-card') {
    const assetKey = cleanKeyField(parsed.assetKey);
    if (assetKey) return `token:key:${assetKey}`;
    const symbol = cleanKeyField(parsed.symbol);
    if (symbol) return `token:sym:${symbol}`;
    return null;
  }

  if (tag === 'ft-order-card') {
    const batch = cleanKeyField(parsed.batchGroupId);
    if (batch) return `ft-order:batch:${batch}`;
    const assetKey = cleanKeyField(parsed.assetKey);
    return assetKey ? `ft-order:key:${assetKey}` : null;
  }

  if (tag === 'ft-quote-card') {
    const assetKey = cleanKeyField(parsed.assetKey);
    if (assetKey) return `ft-quote:key:${assetKey}`;
    const symbol = cleanKeyField(parsed.symbol);
    return symbol ? `ft-quote:sym:${symbol}` : null;
  }

  if (tag === 'ft-fill-card') {
    const txids = Array.isArray(parsed.txids)
      ? parsed.txids.map((x) => cleanKeyField(x)).filter(Boolean)
      : [];
    if (txids[0]) return `ft-fill:tx:${txids[0]}`;
    const symbol = cleanKeyField(parsed.symbol);
    const side = cleanKeyField(parsed.side);
    return symbol ? `ft-fill:${side}:${symbol}` : null;
  }

  if (tag === 'ft-my-orders-card') {
    const botId =
      typeof parsed.metabotId === 'number' && Number.isFinite(parsed.metabotId)
        ? String(parsed.metabotId)
        : cleanKeyField(parsed.botName) || 'active';
    return `ft-my-orders:${botId}`;
  }

  if (tag === 'ft-portfolio-card') {
    const botId =
      typeof parsed.metabotId === 'number' && Number.isFinite(parsed.metabotId)
        ? String(parsed.metabotId)
        : cleanKeyField(parsed.botName) || 'active';
    return `ft-portfolio:${botId}`;
  }

  if (tag === 'ft-bridge-card') {
    const txid = cleanKeyField(parsed.txid);
    if (txid) return `ft-bridge:tx:${txid}`;
    const symbol = cleanKeyField(parsed.symbol);
    const dir = cleanKeyField(parsed.direction);
    return symbol ? `ft-bridge:${dir}:${symbol}` : null;
  }

  if (tag === 'ft-action-card') {
    const txid = cleanKeyField(parsed.txid);
    const action = cleanKeyField(parsed.action);
    if (txid) return `ft-action:${action}:${txid}`;
    return null;
  }

  if (tag === 'nft-collection-card') {
    const colId = cleanKeyField(parsed.collectionId);
    if (colId) return `col:id:${colId}`;
    const colName = cleanKeyField(parsed.collectionName);
    if (colName) return `col:name:${colName}`;
    return null;
  }

  const pinId = cleanKeyField(parsed.pinId);
  if (pinId) return `nft:pin:${pinId}`;

  const genesis = cleanKeyField(parsed.genesis);
  const codehash = cleanKeyField(parsed.codehash);
  const tokenIndex =
    typeof parsed.tokenIndex === 'string'
      ? parsed.tokenIndex.trim()
      : typeof parsed.tokenIndex === 'number' && Number.isFinite(parsed.tokenIndex)
        ? String(parsed.tokenIndex)
        : '';
  if (genesis && codehash && tokenIndex) {
    return `nft:mc:${genesis}:${codehash}:${tokenIndex}`;
  }
  return null;
}

export function parseNftCardFencesFromMarkdown(markdown: string): CapturedNftCardFence[] {
  if (!markdown || !FAST_BACKSTOP_HINT_RE.test(markdown)) {
    return [];
  }
  const results: CapturedNftCardFence[] = [];
  NFT_CARD_FENCE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = NFT_CARD_FENCE_RE.exec(markdown)) !== null) {
    const rawTag = (match[1] ?? '').toLowerCase();
    const tag: NftCardBackstopTag =
      rawTag === 'tokencard' ? 'token-card' : (rawTag as NftCardBackstopTag);
    const rawBody = (match[2] ?? '').trim();
    if (!rawBody) continue;
    try {
      const parsed = JSON.parse(rawBody) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      const key = deriveCardIdentityKey(tag, parsed as Record<string, unknown>);
      if (!key) continue;
      results.push({
        key,
        tag,
        fence: `\`\`\`${tag}\n${rawBody}\n\`\`\``,
      });
    } catch {
      // Ignore malformed JSON blocks.
    }
  }
  return results;
}

export function extractEmittedNftCardFences(
  toolName: string,
  toolResultText: string,
): CapturedNftCardFence[] {
  if (!isNftCardBackstopTool(toolName) || !toolResultText) return [];
  return parseNftCardFencesFromMarkdown(toolResultText);
}

/**
 * Merge newly captured fences into the turn ledger. When the same item/album
 * is acted on multiple times in one turn, the newer fence supersedes the
 * earlier one at the latest chronological position.
 */
export function recordCapturedNftCardFences(
  existing: readonly CapturedNftCardFence[],
  incoming: readonly CapturedNftCardFence[],
): CapturedNftCardFence[] {
  if (!incoming.length) return [...existing];
  const next = [...existing];
  for (const item of incoming) {
    const priorIdx = next.findIndex((candidate) => candidate.key === item.key);
    if (priorIdx >= 0) {
      next.splice(priorIdx, 1);
    }
    next.push(item);
  }
  return next;
}

export function selectMissingNftCardFences(
  captured: readonly CapturedNftCardFence[],
  visibleAssistantTexts: readonly string[],
): CapturedNftCardFence[] {
  if (!captured.length) return [];
  const presentKeys = new Set<string>();
  for (const text of visibleAssistantTexts) {
    for (const fence of parseNftCardFencesFromMarkdown(text)) {
      presentKeys.add(fence.key);
    }
  }
  return captured.filter((entry) => !presentKeys.has(entry.key));
}

export function isEligibleBackstopTargetMessage(
  message: {
    type?: string;
    content?: string;
    metadata?: Record<string, unknown>;
  } | null | undefined,
): boolean {
  if (!message || message.type !== 'assistant') return false;
  if (typeof message.content !== 'string' || message.content.trim().length === 0) return false;
  const meta = message.metadata;
  if (!meta) return true;
  if (meta.isThinking === true) return false;
  if (meta.turnAckReply === true) return false;
  if (meta.narration === true) return false;
  if (meta.ownerUpdate === true) return false;
  if (meta.compaction === true) return false;
  if (meta.isError === true) return false;
  return true;
}

export function appendNftCardFencesToReply(
  content: string,
  missing: readonly CapturedNftCardFence[],
): string {
  if (!missing.length) return content;
  const base = String(content ?? '').replace(/\s+$/, '');
  const suffix = missing.map((entry) => entry.fence).join('\n\n');
  return base ? `${base}\n\n${suffix}` : suffix;
}
