/**
 * Deterministic turn-end backstop for host-emitted chat NFT & Token protocol cards.
 *
 * Why this exists:
 * Host NFT / digital-goods tools (`mrc721_*`, `wallet_nft_*`, `goods_*`,
 * `nft_swap_*`, `metabot_update`) and Token / FT host tools (`wallet_token_*`,
 * `wallet_mrc20_*`) append fenced protocol cards (`nft-card`,
 * `nft-collection-card`, `nft-listing-card`, `nft-fill-card`,
 * `nft-my-listings-card`, `nft-portfolio-card`, `nft-swap-card`,
 * `nft-action-card`, `nft-negotiate-card`, `token-card`, `ft-order-card`,
 * `ft-quote-card`, `ft-fill-card`, `ft-my-orders-card`, `ft-portfolio-card`,
 * `ft-bridge-card`, `ft-action-card`) to their tool results and ask the agent
 * to include them verbatim in its reply.
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
  | 'nft-listing-card'
  | 'nft-fill-card'
  | 'nft-my-listings-card'
  | 'nft-portfolio-card'
  | 'nft-swap-card'
  | 'nft-action-card'
  | 'nft-negotiate-card'
  | 'token-card'
  | 'ft-orderbook-card'
  | 'ft-order-card'
  | 'ft-quote-card'
  | 'ft-fill-card'
  | 'ft-my-orders-card'
  | 'ft-portfolio-card'
  | 'ft-bridge-card'
  | 'ft-action-card';

export interface CapturedNftCardFence {
  /** Canonical deduplication key (`nft:pin:...`, `col:...`, `token:...`, `ft-...`, `nft-...`). */
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
  'mrc721_sell_intent_cancel',
  'mrc721_sell_intents',
  'mrc721_sell_orders',
  'mrc721_balance',
  'mrc721_offer',
  'mrc721_offer_cancel',
  'mrc721_take_offer',
  'wallet_nft_transfer',
  'wallet_nft_sell',
  'wallet_nft_cancel_sell',
  'wallet_nft_buy',
  'wallet_nft_sell_orders',
  'wallet_nft_balance',
  'goods_market_summary',
  'goods_holder_lookup',
  'goods_buy_with_me',
  'goods_buy_with_token',
  'goods_send_inquiry',
  'goods_accept_inquiry',
  'nft_swap_submit_batch',
  'nft_swap_order_status',
  'metabot_update',
  'wallet_token_card',
  'wallet_token_orders',
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
  /```(nft-card|nft-collection-card|nft-listing-card|nftlistingcard|nft-fill-card|nftfillcard|nft-my-listings-card|nftmylistingscard|nft-portfolio-card|nftportfoliocard|nft-swap-card|nftswapcard|nft-action-card|nftactioncard|nft-negotiate-card|nftnegotiatecard|token-card|tokencard|ft-orderbook-card|ft-orders-card|ftorderbookcard|token-orderbook-card|ft-order-card|ft-quote-card|ft-fill-card|ft-my-orders-card|ft-portfolio-card|ft-bridge-card|ft-action-card)[ \t]*\r?\n([\s\S]*?)\r?\n```/gi;

const FAST_BACKSTOP_HINT_RE =
  /```(?:nft-(?:card|collection-card|listing-card|fill-card|my-listings-card|portfolio-card|swap-card|action-card|negotiate-card)|nft(?:listing|fill|mylistings|portfolio|swap|action|negotiate)card|token-card|tokencard|token-orderbook-card|ftorderbookcard|ft-(?:orderbook|orders|order|quote|fill|my-orders|portfolio|bridge|action)-card)/i;

const COMPACT_TAG_ALIASES: Record<string, NftCardBackstopTag> = {
  tokencard: 'token-card',
  'ft-orders-card': 'ft-orderbook-card',
  'token-orderbook-card': 'ft-orderbook-card',
  ftorderbookcard: 'ft-orderbook-card',
  nftlistingcard: 'nft-listing-card',
  nftfillcard: 'nft-fill-card',
  nftmylistingscard: 'nft-my-listings-card',
  nftportfoliocard: 'nft-portfolio-card',
  nftswapcard: 'nft-swap-card',
  nftactioncard: 'nft-action-card',
  nftnegotiatecard: 'nft-negotiate-card',
};

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

  if (tag === 'ft-orderbook-card') {
    const assetKey = cleanKeyField(parsed.assetKey);
    const rail = cleanKeyField(parsed.rail);
    if (assetKey) return rail ? `ft-orderbook:${rail}:${assetKey}` : `ft-orderbook:key:${assetKey}`;
    const symbol = cleanKeyField(parsed.symbol);
    return symbol ? `ft-orderbook:sym:${symbol}` : null;
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

  if (tag === 'nft-my-listings-card') {
    const botId =
      typeof parsed.metabotId === 'number' && Number.isFinite(parsed.metabotId)
        ? String(parsed.metabotId)
        : cleanKeyField(parsed.sellerAddress) || cleanKeyField(parsed.botName) || 'active';
    return `nft-my-listings:${botId}`;
  }

  if (tag === 'nft-portfolio-card') {
    const ownerKey =
      typeof parsed.metabotId === 'number' && Number.isFinite(parsed.metabotId)
        ? String(parsed.metabotId)
        : cleanKeyField(parsed.ownerAddress) || cleanKeyField(parsed.ownerGlobalMetaId) || 'active';
    return `nft-portfolio:${ownerKey}`;
  }

  if (tag === 'nft-swap-card') {
    const reqId = cleanKeyField(parsed.requestId) || cleanKeyField(parsed.orderId);
    const slug = cleanKeyField(parsed.collectionSlug);
    return reqId ? `nft-swap:${reqId}` : slug ? `nft-swap:slug:${slug}` : null;
  }

  if (tag === 'nft-negotiate-card') {
    const inqId = cleanKeyField(parsed.inquiryId);
    const pin = cleanKeyField(parsed.pinId);
    const kind = cleanKeyField(parsed.kind) || cleanKeyField(parsed.mode) || 'quote';
    if (inqId) return `nft-negotiate:${kind}:${inqId}`;
    if (pin) return `nft-negotiate:${kind}:${pin}`;
    return null;
  }

  if (tag === 'nft-fill-card') {
    const side = cleanKeyField(parsed.side) || 'fill';
    const ord = cleanKeyField(parsed.orderId) || cleanKeyField(parsed.txId) || cleanKeyField(parsed.deliveryTxId);
    const pin = cleanKeyField(parsed.pinId);
    if (ord) return `nft-fill:${side}:${ord}`;
    if (pin) return `nft-fill:${side}:${pin}`;
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
    const tag: NftCardBackstopTag = COMPACT_TAG_ALIASES[rawTag] ?? (rawTag as NftCardBackstopTag);
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
 * Extract protocol card fences emitted by structured CLI skills (such as
 * `metabot-token-broker` or `metabot-trade-metaidmarket-v2`) executed via DSH
 * `bash`. Only matches genuine JSON skill envelopes (`{ success: true, cardType, message }`)
 * so reading documentation or grepping source files never triggers false captures.
 */
export function extractEmittedSkillBashCardFences(toolResultText: string): CapturedNftCardFence[] {
  if (
    !toolResultText ||
    !toolResultText.includes('"cardType"') ||
    !toolResultText.includes('"message"')
  ) {
    return [];
  }
  const trimmed = toolResultText.trim();
  const candidates: string[] = [trimmed];
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace && (firstBrace > 0 || lastBrace < trimmed.length - 1)) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown> | null;
      if (
        parsed &&
        typeof parsed === 'object' &&
        !Array.isArray(parsed) &&
        parsed.success === true &&
        typeof parsed.cardType === 'string' &&
        typeof parsed.message === 'string'
      ) {
        const fences = parseNftCardFencesFromMarkdown(parsed.message);
        if (fences.length > 0) return fences;
      }
    } catch {
      // Try next candidate slice
    }
  }
  return [];
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
