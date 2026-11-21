/**
 * commerceInviteAttribution — parse/persist the promo-pack invite attribution
 * parameters (`inviter=<globalMetaId>&shop=<shopPinId>`) carried by the seed
 * card QR / landing link (cold-start plan B2: a new user arriving through an
 * invite should be able to one-click add the inviting shop owner as a friend).
 *
 * Pure helpers plus a guarded localStorage pair, injectable storage for tests.
 */

import { normalizeGlobalMetaId, normalizeShopMetaAppPinId } from '../components/commerce/commerceBridgeContract';

export const INVITE_ATTRIBUTION_STORAGE_KEY = 'idbots.commerce.inviteAttribution';

export interface InviteAttribution {
  inviter: string;
  shop: string;
  recordedAt: number;
}

export interface InviteAttributionInput {
  inviter: string;
  shop: string;
}

/**
 * Parse an attribution query from a landing URL, a bare query string or a
 * full link pasted by a user. Returns null unless BOTH parameters are valid
 * (inviter: idq1… globalMetaId, shop: pin id) — partial attribution is
 * dropped so a tampered link can never bind a bogus inviter.
 */
export function parseInviteAttribution(source: unknown): InviteAttributionInput | null {
  const raw = typeof source === 'string' ? source.trim() : '';
  if (!raw) return null;
  let query = raw;
  const questionMark = raw.indexOf('?');
  if (questionMark !== -1) query = raw.slice(questionMark + 1);
  if (query.includes('#')) query = query.split('#', 1)[0] ?? '';
  let inviter = '';
  let shop = '';
  for (const pair of query.split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    const key = pair.slice(0, eq).trim().toLowerCase();
    let value = pair.slice(eq + 1);
    try {
      value = decodeURIComponent(value);
    } catch {
      // keep raw value; validators below reject malformed encodings anyway
    }
    if (key === 'inviter') inviter = normalizeGlobalMetaId(value);
    else if (key === 'shop') shop = normalizeShopMetaAppPinId(value);
  }
  if (!inviter || !shop) return null;
  return { inviter, shop };
}

interface MinimalStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const memoryFallback = (): MinimalStorage => {
  let value: string | null = null;
  return {
    getItem: () => value,
    setItem: (_key, next) => {
      value = next;
    },
    removeItem: () => {
      value = null;
    },
  };
};

const defaultStorage = (): MinimalStorage => {
  try {
    if (typeof localStorage !== 'undefined') return localStorage;
  } catch {
    // opaque origin / disabled storage — fall through
  }
  return memoryFallback();
};

export function saveInviteAttribution(
  input: InviteAttributionInput,
  storage: MinimalStorage = defaultStorage(),
): InviteAttribution | null {
  const valid = parseInviteAttribution(`${'https://landing.local'}?inviter=${encodeURIComponent(input.inviter)}&shop=${encodeURIComponent(input.shop)}`);
  if (!valid) return null;
  const record: InviteAttribution = { ...valid, recordedAt: Date.now() };
  try {
    storage.setItem(INVITE_ATTRIBUTION_STORAGE_KEY, JSON.stringify(record));
  } catch {
    return null;
  }
  return record;
}

/** Read the pending inviter for the first-run "add your inviter as a friend" hint. Null when absent/corrupt. */
export function readPendingInviteAttribution(storage: MinimalStorage = defaultStorage()): InviteAttribution | null {
  let raw: string | null = null;
  try {
    raw = storage.getItem(INVITE_ATTRIBUTION_STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const record = parsed as { inviter?: unknown; shop?: unknown; recordedAt?: unknown };
    if (typeof record.inviter !== 'string' || typeof record.shop !== 'string') return null;
    const valid = parseInviteAttribution(`?inviter=${encodeURIComponent(record.inviter)}&shop=${encodeURIComponent(record.shop)}`);
    if (!valid) return null;
    return {
      inviter: valid.inviter,
      shop: valid.shop,
      recordedAt: typeof record.recordedAt === 'number' && record.recordedAt > 0 ? record.recordedAt : 0,
    };
  } catch {
    return null;
  }
}

export function clearInviteAttribution(storage: MinimalStorage = defaultStorage()): void {
  try {
    storage.removeItem(INVITE_ATTRIBUTION_STORAGE_KEY);
  } catch {
    // storage unavailable — nothing to clear
  }
}
