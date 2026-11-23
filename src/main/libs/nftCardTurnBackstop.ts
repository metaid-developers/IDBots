/**
 * Deterministic turn-end backstop for host-emitted chat NFT & Token protocol cards.
 *
 * Why this exists:
 * Mutating NFT / collection host tools (`mrc721_sell_intent`, `mrc721_mint`,
 * `mrc721_sell`, `mrc721_buy`, `mrc721_transfer`, `mrc721_offer`,
 * `mrc721_take_offer`, `mrc721_collection_create`, `mrc721_collection_update`,
 * `wallet_nft_*`) and `wallet_token_card` append a ```nft-card /
 * ```nft-collection-card / ```token-card fence to their tool result and ask
 * the agent to include it verbatim in its reply.
 * In Studio / Projector Mode (or when a model summarizes prose + projects an
 * HTML report), the model sometimes omits the fenced block from the chat
 * bubble, leaving the user with no visual card in the chat stream.
 *
 * The runner captures fences emitted by announcing tools during a turn and, if
 * any card identity was omitted from all visible assistant messages of that
 * turn, appends the missing fence(s) onto the turn's final visible assistant
 * reply after flushing stream overlays.
 */

export type NftCardBackstopTag = 'nft-card' | 'nft-collection-card' | 'token-card';

export interface CapturedNftCardFence {
  /** Canonical deduplication key (`nft:pin:...`, `nft:mc:...`, `col:...`, or `token:...`). */
  key: string;
  tag: NftCardBackstopTag;
  /** Full fenced markdown block (` ```nft-card\n{...}\n``` ` or ` ```token-card\n{...}\n``` `). */
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
]);

const NFT_CARD_FENCE_RE = /```(nft-card|nft-collection-card|token-card|tokencard)[ \t]*\r?\n([\s\S]*?)\r?\n```/gi;

export function normalizeHostToolBaseName(toolName: string): string {
  const trimmed = String(toolName ?? '').trim();
  if (!trimmed) return '';
  const mcpMatch = trimmed.match(/^mcp__[^_]+__(.+)$/);
  return (mcpMatch ? mcpMatch[1] : trimmed).trim().toLowerCase();
}

export function isNftCardBackstopTool(toolName: string): boolean {
  return ANNOUNCING_NFT_CARD_TOOLS.has(normalizeHostToolBaseName(toolName));
}

function deriveCardIdentityKey(tag: NftCardBackstopTag, parsed: Record<string, unknown>): string | null {
  if (tag === 'token-card') {
    const assetKey = typeof parsed.assetKey === 'string' ? parsed.assetKey.trim().toLowerCase() : '';
    if (assetKey) return `token:key:${assetKey}`;
    const symbol = typeof parsed.symbol === 'string' ? parsed.symbol.trim().toLowerCase() : '';
    if (symbol) return `token:sym:${symbol}`;
    return null;
  }

  if (tag === 'nft-collection-card') {
    const colId = typeof parsed.collectionId === 'string' ? parsed.collectionId.trim().toLowerCase() : '';
    if (colId) return `col:id:${colId}`;
    const colName = typeof parsed.collectionName === 'string' ? parsed.collectionName.trim().toLowerCase() : '';
    if (colName) return `col:name:${colName}`;
    return null;
  }

  const pinId = typeof parsed.pinId === 'string' ? parsed.pinId.trim().toLowerCase() : '';
  if (pinId) return `nft:pin:${pinId}`;

  const genesis = typeof parsed.genesis === 'string' ? parsed.genesis.trim().toLowerCase() : '';
  const codehash = typeof parsed.codehash === 'string' ? parsed.codehash.trim().toLowerCase() : '';
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
  if (
    !markdown
    || (
      !markdown.includes('```nft-card')
      && !markdown.includes('```nft-collection-card')
      && !markdown.includes('```token-card')
      && !markdown.includes('```tokencard')
    )
  ) {
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

export function extractEmittedNftCardFences(toolName: string, toolResultText: string): CapturedNftCardFence[] {
  if (!isNftCardBackstopTool(toolName) || !toolResultText) return [];
  return parseNftCardFencesFromMarkdown(toolResultText);
}

/**
 * Merge newly captured fences into the turn ledger. When the same item/album
 * is acted on multiple times in one turn (e.g. `mrc721_mint` followed by
 * `mrc721_sell_intent`), the newer fence supersedes the earlier one at the
 * latest chronological position so the final state (`selling` / `LISTED`) wins.
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
