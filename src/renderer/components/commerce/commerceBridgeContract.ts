/**
 * commerceBridgeContract — the DOM-free, renderer-agnostic contract for the
 * commerce/social bridge methods MetaApps may call
 * (`browser.commerce.askTwinToBuy`, `browser.social.addFriendPrompt`,
 * `browser.commerce.openPromoPack`).
 *
 * Both embedders share it:
 *   - the Bot Browser (browserIframeBridge relays the request to
 *     BotBrowserSurface, which re-validates here before opening any UI);
 *   - the inline chat bubble (InlineMetaAppBlock validates here directly).
 *
 * Security posture (REQ-E-01): these methods are pure UI-intent raisers.
 * Nothing here ever signs, pays, transfers or sends — every path only opens a
 * host-owned confirmation surface the user must click. All inputs are
 * sanitized before any of that happens: pin/globalMetaId shapes, price
 * ranges, control-character stripping and hard length caps so a hostile
 * MetaApp cannot inject newlines or oversized payloads into host modals.
 */

export type CommerceIntentKind = 'askTwinToBuy' | 'addFriendPrompt' | 'openPromoPack';

export const COMMERCE_BRIDGE_METHODS: readonly string[] = [
  'browser.commerce.askTwinToBuy',
  'browser.social.addFriendPrompt',
  'browser.commerce.openPromoPack',
];

export const COMMERCE_METHOD_TO_INTENT: Record<string, CommerceIntentKind> = {
  'browser.commerce.askTwinToBuy': 'askTwinToBuy',
  'browser.social.addFriendPrompt': 'addFriendPrompt',
  'browser.commerce.openPromoPack': 'openPromoPack',
};

/** Window events the host dispatches after the user approves an intent (WS-D mounts downstream UIs). */
export const COMMERCE_INTENT_WINDOW_EVENT = 'idbots:commerce-intent';
export const SOCIAL_FRIEND_PROMPT_WINDOW_EVENT = 'idbots:social-friend-prompt';

export type CommerceIntentSource = 'bot-browser' | 'inline-metaapp';

export interface BridgeContractError {
  code: string;
  message: string;
}

/**
 * Sanitizer results: the sanitized value itself, or a SanitizeFailure carrying
 * a machine-readable bridge error. A dedicated failure CLASS (not a boolean
 * discriminated union) is deliberate: this repo compiles with
 * strictNullChecks off, under which boolean-literal discriminants do NOT
 * narrow, while instanceof narrowing always does.
 */
export class SanitizeFailure {
  readonly error: BridgeContractError;

  constructor(error: BridgeContractError) {
    this.error = error;
  }
}

export type SanitizeResult<T> = T | SanitizeFailure;

export type AskTwinToBuyMode = 'buy_me' | 'negotiate' | 'inquire_unlisted';
export const ASK_TWIN_TO_BUY_MODES: readonly AskTwinToBuyMode[] = ['buy_me', 'negotiate', 'inquire_unlisted'];

export interface AskTwinToBuyParams {
  itemPinId: string;
  collectionId?: string;
  collectionName: string;
  itemName: string;
  tokenIndex?: string;
  sellerGlobalMetaId: string;
  sellerName?: string;
  priceMeMilli?: number;
  priceCnyCents?: number;
  mode: AskTwinToBuyMode;
  shopMetaAppPinId?: string;
}

export interface AddFriendPromptParams {
  targetGlobalMetaId: string;
  targetName?: string;
  greeting?: string;
}

export interface PromoFeaturedItem {
  itemPinId: string;
  itemName: string;
  coverUrl?: string;
  priceMeMilli?: number;
  priceCnyCents?: number;
}

export interface OpenPromoPackParams {
  shopOwnerGlobalMetaId: string;
  shopOwnerName?: string;
  shopSlogan?: string;
  shopMetaAppPinId?: string;
  featuredItems: PromoFeaturedItem[];
}

export interface CommerceIntentEventDetail {
  intent: CommerceIntentKind;
  source: CommerceIntentSource;
  params: AskTwinToBuyParams | AddFriendPromptParams | OpenPromoPackParams;
  /** Present for askTwinToBuy so WS-D's purchase flow can attribute the actor. */
  actorId?: string;
}

const ITEM_PIN_ID_RE = /^[0-9a-f]{64}i\d+$/i;
const GLOBAL_META_ID_RE = /^idq1[a-z0-9]{30,64}$/;
const COVER_URL_RE = /^(metafile:\/\/[0-9a-f]{64}i\d+|https?:\/\/\S+)$/i;
const MAX_SAFE = Number.MAX_SAFE_INTEGER;

const TEXT_CAPS = {
  name: 120,
  shortName: 80,
  slogan: 200,
  greeting: 300,
  tokenIndex: 24,
  url: 512,
  pinId: 66,
} as const;

/** Strip control characters (including CR/LF/TAB so a listing name can never forge host-modal line breaks), collapse whitespace, trim, cap. */
export function cleanCommerceText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return '';
  const stripped = value.replace(/[\u0000-\u001f\u007f]/g, ' ');
  const collapsed = stripped.replace(/\s+/g, ' ').trim();
  return collapsed.length > maxLength ? collapsed.slice(0, maxLength) : collapsed;
}

/** Pin-id / globalMetaId normalizers validate the WHOLE trimmed string first — truncating before the anchored regex could silently turn an oversized pin into a valid one. */
export function normalizeItemPinId(value: unknown): string {
  if (typeof value !== 'string') return '';
  const raw = value.trim().toLowerCase();
  return ITEM_PIN_ID_RE.test(raw) ? raw : '';
}

export function normalizeShopMetaAppPinId(value: unknown): string {
  return normalizeItemPinId(value);
}

/** GlobalMetaIds are `idq1…` lowercase base32-style identifiers (42 chars today; length band kept tolerant). */
export function normalizeGlobalMetaId(value: unknown): string {
  if (typeof value !== 'string') return '';
  const raw = value.trim().toLowerCase();
  return GLOBAL_META_ID_RE.test(raw) ? raw : '';
}

/** Truthiness-friendly price validation: undefined when acceptable. */
function priceError(value: unknown, field: string): BridgeContractError | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'string' && value.trim() === '') return undefined;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > MAX_SAFE) {
    return { code: 'invalid_price', message: `${field} must be a non-negative integer.` };
  }
  return undefined;
}

function normalizePrice(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > MAX_SAFE) return undefined;
  return parsed;
}

function sanitizeMode(value: unknown): AskTwinToBuyMode {
  const raw = typeof value === 'string' ? value.trim() : '';
  return (ASK_TWIN_TO_BUY_MODES as readonly string[]).includes(raw)
    ? (raw as AskTwinToBuyMode)
    : 'buy_me';
}

export function sanitizeAskTwinToBuy(value: unknown): SanitizeResult<AskTwinToBuyParams> {
  if (!isPlainRecord(value)) {
    return new SanitizeFailure({ code: 'invalid_request', message: 'askTwinToBuy params must be an object.' });
  }
  const itemPinId = normalizeItemPinId(value.itemPinId);
  if (!itemPinId) {
    return new SanitizeFailure({ code: 'invalid_item_pin_id', message: 'itemPinId must be a 64-hex pin id with an output index.' });
  }
  const sellerGlobalMetaId = normalizeGlobalMetaId(value.sellerGlobalMetaId);
  if (!sellerGlobalMetaId) {
    return new SanitizeFailure({ code: 'invalid_global_meta_id', message: 'sellerGlobalMetaId must be a valid idq1… GlobalMetaID.' });
  }
  const itemName = cleanCommerceText(value.itemName, TEXT_CAPS.name);
  if (!itemName) {
    return new SanitizeFailure({ code: 'invalid_request', message: 'itemName is required.' });
  }
  const meError = priceError(value.priceMeMilli, 'priceMeMilli');
  if (meError) return new SanitizeFailure(meError);
  const cnyError = priceError(value.priceCnyCents, 'priceCnyCents');
  if (cnyError) return new SanitizeFailure(cnyError);
  const collectionId = normalizeItemPinId(value.collectionId) || '';
  const shopMetaAppPinId = normalizeShopMetaAppPinId(value.shopMetaAppPinId) || '';
  const tokenIndexRaw = cleanCommerceText(value.tokenIndex, TEXT_CAPS.tokenIndex);
  return {
    itemPinId,
    collectionName: cleanCommerceText(value.collectionName, TEXT_CAPS.shortName) || '',
    itemName,
    sellerGlobalMetaId,
    sellerName: cleanCommerceText(value.sellerName, TEXT_CAPS.shortName) || '',
    tokenIndex: /^\d{1,12}$/.test(tokenIndexRaw) ? tokenIndexRaw : '',
    collectionId: collectionId || undefined,
    shopMetaAppPinId: shopMetaAppPinId || undefined,
    priceMeMilli: normalizePrice(value.priceMeMilli),
    priceCnyCents: normalizePrice(value.priceCnyCents),
    mode: sanitizeMode(value.mode),
  };
}

export function sanitizeAddFriendPrompt(value: unknown): SanitizeResult<AddFriendPromptParams> {
  if (!isPlainRecord(value)) {
    return new SanitizeFailure({ code: 'invalid_request', message: 'addFriendPrompt params must be an object.' });
  }
  const targetGlobalMetaId = normalizeGlobalMetaId(value.targetGlobalMetaId);
  if (!targetGlobalMetaId) {
    return new SanitizeFailure({ code: 'invalid_global_meta_id', message: 'targetGlobalMetaId must be a valid idq1… GlobalMetaID.' });
  }
  return {
    targetGlobalMetaId,
    targetName: cleanCommerceText(value.targetName, TEXT_CAPS.shortName) || '',
    greeting: cleanCommerceText(value.greeting, TEXT_CAPS.greeting) || '',
  };
}

export function sanitizePromoFeaturedItems(value: unknown): SanitizeResult<PromoFeaturedItem[]> {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    return new SanitizeFailure({ code: 'invalid_request', message: 'featuredItems must be an array.' });
  }
  if (value.length > 6) {
    return new SanitizeFailure({ code: 'invalid_request', message: 'featuredItems accepts at most 6 items.' });
  }
  const items: PromoFeaturedItem[] = [];
  for (const entry of value) {
    if (!isPlainRecord(entry)) {
      return new SanitizeFailure({ code: 'invalid_request', message: 'Each featured item must be an object.' });
    }
    const itemPinId = normalizeItemPinId(entry.itemPinId);
    if (!itemPinId) {
      return new SanitizeFailure({ code: 'invalid_item_pin_id', message: 'featuredItems[].itemPinId must be a valid pin id.' });
    }
    const entryMeError = priceError(entry.priceMeMilli, 'featuredItems[].priceMeMilli');
    if (entryMeError) return new SanitizeFailure(entryMeError);
    const entryCnyError = priceError(entry.priceCnyCents, 'featuredItems[].priceCnyCents');
    if (entryCnyError) return new SanitizeFailure(entryCnyError);
    const coverUrlRaw = cleanCommerceText(entry.coverUrl, TEXT_CAPS.url);
    let coverUrl: string | undefined;
    if (coverUrlRaw && COVER_URL_RE.test(coverUrlRaw)) {
      coverUrl = coverUrlRaw.toLowerCase().startsWith('metafile://')
        ? `metafile://${normalizeShopMetaAppPinId(coverUrlRaw.slice('metafile://'.length))}` || undefined
        : coverUrlRaw;
    }
    items.push({
      itemPinId,
      itemName: cleanCommerceText(entry.itemName, TEXT_CAPS.shortName) || '',
      coverUrl,
      priceMeMilli: normalizePrice(entry.priceMeMilli),
      priceCnyCents: normalizePrice(entry.priceCnyCents),
    });
  }
  return items;
}

export function sanitizeOpenPromoPack(value: unknown): SanitizeResult<OpenPromoPackParams> {
  if (!isPlainRecord(value)) {
    return new SanitizeFailure({ code: 'invalid_request', message: 'openPromoPack params must be an object.' });
  }
  const shopOwnerGlobalMetaId = normalizeGlobalMetaId(value.shopOwnerGlobalMetaId);
  if (!shopOwnerGlobalMetaId) {
    return new SanitizeFailure({ code: 'invalid_global_meta_id', message: 'shopOwnerGlobalMetaId must be a valid idq1… GlobalMetaID.' });
  }
  const featuredItems = sanitizePromoFeaturedItems(value.featuredItems);
  if (featuredItems instanceof SanitizeFailure) return featuredItems;
  return {
    shopOwnerGlobalMetaId,
    shopOwnerName: cleanCommerceText(value.shopOwnerName, TEXT_CAPS.shortName) || '',
    shopSlogan: cleanCommerceText(value.shopSlogan, TEXT_CAPS.slogan) || '',
    shopMetaAppPinId: normalizeShopMetaAppPinId(value.shopMetaAppPinId) || undefined,
    featuredItems,
  };
}

/**
 * Promo-pack ownership gate: only the shop owner's own actor may open the
 * ammo pack (REQ-E-01). `actorGlobalMetaId` is the caller's current Bot
 * Browser / inline session actor; empty means "no actor" — also forbidden.
 */
export function checkPromoPackOwnership(
  params: OpenPromoPackParams,
  actorGlobalMetaId: string | null | undefined,
): SanitizeResult<true> {
  const actor = typeof actorGlobalMetaId === 'string' ? actorGlobalMetaId.trim().toLowerCase() : '';
  if (!actor) {
    return new SanitizeFailure({ code: 'forbidden', message: 'No active actor: the promo pack is owner-only.' });
  }
  if (actor !== params.shopOwnerGlobalMetaId) {
    return new SanitizeFailure({ code: 'forbidden', message: 'Only the shop owner may open the promo pack.' });
  }
  return true;
}

export function isCommerceBridgeMethod(method: unknown): method is string {
  return typeof method === 'string' && (COMMERCE_BRIDGE_METHODS as readonly string[]).includes(method);
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
