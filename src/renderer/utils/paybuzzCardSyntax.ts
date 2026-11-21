/**
 * paybuzzCardSyntax — DOM-free parser, validator, badge formatter, and
 * serializer for `/protocols/paybuzz` fenced blocks (`paybuzz-card`).
 */

import { formatFtAssetBadge } from '../components/chat/ftCardSyntax';

export const PAYBUZZ_CARD_FENCE_TAG = 'paybuzz-card';
const PAYBUZZ_CARD_FENCE_TAGS = new Set(['paybuzz-card', 'paybuzz', 'paybuzzcard']);

export interface PaybuzzCardTokenPrice {
  assetKey: string;
  chain: 'btc' | 'mvc';
  symbol: string;
  decimals: number;
  amountBase: string;
  amountDisplay: string;
  receiveAddress: string;
  caVerified?: boolean;
}

export interface PaybuzzCardVipCollection {
  collectionPinId: string;
  collectionName: string;
}

export interface PaybuzzCardUnlockRules {
  mePriceMilli?: number;
  tokenPrices: PaybuzzCardTokenPrice[];
  vipMrc721Collections: PaybuzzCardVipCollection[];
}

export interface PaybuzzCardData {
  paybuzzPinId: string;
  title: string;
  preview: string;
  wordCount: number;
  authorMetaId: string;
  authorName?: string;
  authorMvcAddress?: string;
  shopMetaAppPinId?: string;
  unlockRules: PaybuzzCardUnlockRules;
}

export interface PaybuzzUnlockBadge {
  kind: 'token' | 'vip' | 'me';
  label: string;
  assetKey?: string;
  assetBadge?: string;
  symbol?: string;
  amountDisplay?: string;
  collectionPinId?: string;
}

function cleanStr(value: unknown, maxLen = 400): string {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, maxLen);
}

export function isPaybuzzCardFenceLanguage(lang: string | undefined | null): boolean {
  return PAYBUZZ_CARD_FENCE_TAGS.has(String(lang ?? '').trim().toLowerCase());
}

export function parsePaybuzzCardFence(raw: string): PaybuzzCardData | null {
  try {
    const obj = JSON.parse(String(raw ?? '').trim()) as Record<string, unknown>;
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;

    const paybuzzPinId = cleanStr(obj.paybuzzPinId ?? obj.pinId, 128).toLowerCase();
    const title = cleanStr(obj.title, 200);
    if (!paybuzzPinId || !title) return null;

    const preview = cleanStr(obj.preview, 600);
    const wordCount = Math.max(0, Math.trunc(Number(obj.wordCount ?? 0) || 0));
    const authorMetaId = cleanStr(obj.authorMetaId, 128);
    const authorName = cleanStr(obj.authorName, 80);
    const authorMvcAddress = cleanStr(obj.authorMvcAddress, 96);
    const shopMetaAppPinId = cleanStr(obj.shopMetaAppPinId, 128);

    const rawRules =
      obj.unlockRules && typeof obj.unlockRules === 'object' && !Array.isArray(obj.unlockRules)
        ? (obj.unlockRules as Record<string, unknown>)
        : {};

    const tokenPrices: PaybuzzCardTokenPrice[] = [];
    if (Array.isArray(rawRules.tokenPrices)) {
      for (const item of rawRules.tokenPrices.slice(0, 8)) {
        if (!item || typeof item !== 'object') continue;
        const r = item as Record<string, unknown>;
        const assetKey = cleanStr(r.assetKey, 180).toLowerCase();
        const symbol = cleanStr(r.symbol, 32) || 'TOKEN';
        const amountBase = cleanStr(String(r.amountBase ?? ''), 80);
        const amountDisplay = cleanStr(String(r.amountDisplay ?? amountBase), 48);
        const receiveAddress = cleanStr(r.receiveAddress, 120);
        if (!assetKey || !amountBase || !receiveAddress) continue;
        const chain: 'btc' | 'mvc' =
          r.chain === 'btc' || assetKey.startsWith('mrc20:') ? 'btc' : 'mvc';
        const decimals = Math.max(0, Math.trunc(Number(r.decimals ?? 8) || 0));
        tokenPrices.push({
          assetKey,
          chain,
          symbol,
          decimals,
          amountBase,
          amountDisplay,
          receiveAddress,
          ...(typeof r.caVerified === 'boolean' ? { caVerified: r.caVerified } : {}),
        });
      }
    }

    const vipMrc721Collections: PaybuzzCardVipCollection[] = [];
    if (Array.isArray(rawRules.vipMrc721Collections)) {
      for (const item of rawRules.vipMrc721Collections.slice(0, 8)) {
        if (!item || typeof item !== 'object') continue;
        const c = item as Record<string, unknown>;
        const collectionPinId = cleanStr(c.collectionPinId, 128).toLowerCase();
        if (!collectionPinId) continue;
        const collectionName = cleanStr(c.collectionName, 80) || 'VIP Member Card';
        vipMrc721Collections.push({ collectionPinId, collectionName });
      }
    }

    const mePriceMilli =
      rawRules.mePriceMilli != null && Number.isFinite(Number(rawRules.mePriceMilli)) && Number(rawRules.mePriceMilli) > 0
        ? Math.trunc(Number(rawRules.mePriceMilli))
        : undefined;

    if (
      tokenPrices.length === 0 &&
      vipMrc721Collections.length === 0 &&
      mePriceMilli === undefined
    ) {
      return null;
    }

    return {
      paybuzzPinId,
      title,
      preview,
      wordCount,
      authorMetaId,
      ...(authorName ? { authorName } : {}),
      ...(authorMvcAddress ? { authorMvcAddress } : {}),
      ...(shopMetaAppPinId ? { shopMetaAppPinId } : {}),
      unlockRules: {
        ...(mePriceMilli !== undefined ? { mePriceMilli } : {}),
        tokenPrices,
        vipMrc721Collections,
      },
    };
  } catch {
    return null;
  }
}

export function formatPaybuzzCardFence(data: PaybuzzCardData): string {
  return `\`\`\`${PAYBUZZ_CARD_FENCE_TAG}\n${JSON.stringify(data, null, 2)}\n\`\`\``;
}

export function formatPaybuzzUnlockBadges(rules: PaybuzzCardUnlockRules): PaybuzzUnlockBadge[] {
  const badges: PaybuzzUnlockBadge[] = [];
  for (const token of rules.tokenPrices) {
    badges.push({
      kind: 'token',
      label: `${token.amountDisplay} $${token.symbol}`,
      assetKey: token.assetKey,
      assetBadge: formatFtAssetBadge(token.assetKey),
      symbol: token.symbol,
      amountDisplay: token.amountDisplay,
    });
  }
  for (const col of rules.vipMrc721Collections) {
    badges.push({
      kind: 'vip',
      label: `VIP Card Free: ${col.collectionName}`,
      collectionPinId: col.collectionPinId,
    });
  }
  if (rules.mePriceMilli != null && rules.mePriceMilli > 0) {
    const meDisplay = (rules.mePriceMilli / 1000).toFixed(3).replace(/\.?0+$/, '');
    badges.push({
      kind: 'me',
      label: `${meDisplay} ME`,
    });
  }
  return badges;
}
