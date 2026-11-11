import { fetchFromLocalOrFallback } from './localIndexerProxy';
import { fetchMrc721ItemInfo, type Mrc721ItemSummary } from './mrc721Service';
import { resolvePinAssetSource } from './pinAssetService';
import { parseProtocolPinContent } from './protocolPinContent';

export const NFT_AVATAR_PATH = '/info/nftAvatar';
export const NFT_AVATAR_VERIFICATION_TTL_MS = 30_000;

const NFT_AVATAR_PATTERN = /^nft:\/\/mrc721\/([0-9a-f]{64}i\d+)(?:\?([^#]*))?$/i;
const RAW_PIN_BASE = 'https://manapi.metaid.io';

export interface NftAvatarReference {
  itemPinId: string;
  ownerAddress?: string;
  globalMetaId?: string;
}

export interface NftAvatarDeclaration {
  itemPinId: string;
  ownerAddress: string;
  declarationPinId: string;
}

export interface NftAvatarFacts {
  itemPinId: string;
  collectionPinId?: string;
  collectionName?: string;
  ownerAddress?: string;
  declarationPinId?: string;
  ownershipVerified: boolean;
}

export interface NftAvatarResolution {
  avatarUrl: string | null;
  nft: NftAvatarFacts;
}

export interface PreparedNftAvatar {
  reference: string;
  avatarUrl: string;
  declarationPayload: string;
  nft: NftAvatarFacts;
}

interface NftAvatarServiceDeps {
  fetchItemInfo?: (pinId: string) => Promise<Mrc721ItemSummary | null>;
  fetchDeclaration?: (identity: { ownerAddress?: string; globalMetaId?: string }) => Promise<NftAvatarDeclaration | null>;
  resolveArtwork?: (reference: string) => Promise<string | null>;
}

export function parseNftAvatarReference(reference: string | null | undefined): NftAvatarReference | null {
  const normalized = typeof reference === 'string' ? reference.trim() : '';
  if (!normalized) return null;
  const match = normalized.match(NFT_AVATAR_PATTERN);
  if (!match?.[1]) return null;
  const params = new URLSearchParams(match[2] ?? '');
  const ownerAddress = (params.get('owner') ?? '').trim();
  const globalMetaId = (params.get('metaid') ?? '').trim();
  return {
    itemPinId: match[1].toLowerCase(),
    ...(ownerAddress ? { ownerAddress } : {}),
    ...(globalMetaId ? { globalMetaId } : {}),
  };
}

export function buildNftAvatarReference(input: NftAvatarReference): string {
  const itemPinId = input.itemPinId.trim().toLowerCase();
  if (!/^[0-9a-f]{64}i\d+$/.test(itemPinId)) throw new Error('Invalid MRC-721 item pin id');
  const params = new URLSearchParams();
  if (input.ownerAddress?.trim()) params.set('owner', input.ownerAddress.trim());
  if (input.globalMetaId?.trim()) params.set('metaid', input.globalMetaId.trim());
  const query = params.toString();
  return `nft://mrc721/${itemPinId}${query ? `?${query}` : ''}`;
}

export function buildNftAvatarDeclarationPayload(input: { itemPinId: string; ownerAddress: string }): string {
  const itemPinId = input.itemPinId.trim().toLowerCase();
  const ownerAddress = input.ownerAddress.trim();
  if (!/^[0-9a-f]{64}i\d+$/.test(itemPinId) || !ownerAddress) {
    throw new Error('NFT avatar declaration requires an item pin id and owner address');
  }
  return JSON.stringify({ protocol: 'mrc721', itemPinId, ownerAddress });
}

function extractPinRows(payload: unknown): Record<string, unknown>[] {
  const envelope = payload as { data?: unknown } | null;
  const data = envelope?.data ?? payload;
  if (Array.isArray(data)) return data.filter((row) => row && typeof row === 'object');
  if (!data || typeof data !== 'object') return [];
  const record = data as Record<string, unknown>;
  const list = record.list ?? record.pins ?? record.rows;
  return Array.isArray(list) ? list.filter((row) => row && typeof row === 'object') : [];
}

export async function fetchLatestNftAvatarDeclaration(
  identity: { ownerAddress?: string; globalMetaId?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<NftAvatarDeclaration | null> {
  const globalMetaId = identity.globalMetaId?.trim();
  const ownerAddress = identity.ownerAddress?.trim();
  if (!globalMetaId && !ownerAddress) return null;
  const subject = globalMetaId || ownerAddress;
  const route = globalMetaId
    ? `/api/metaid/pin/list/${encodeURIComponent(subject)}`
    : `/api/address/pin/list/${encodeURIComponent(subject)}`;
  const query = `?path=${encodeURIComponent(NFT_AVATAR_PATH)}&size=1`;
  const remoteUrl = `${RAW_PIN_BASE}${route}${query}`;
  const response = fetchImpl === fetch
    ? await fetchFromLocalOrFallback(`${route}${query}`, remoteUrl)
    : await fetchImpl(remoteUrl);
  if (!response.ok) return null;
  const row = extractPinRows(await response.json().catch(() => null))[0];
  if (!row) return null;
  const declarationPinId = String(row.pinId ?? row.id ?? row.pinid ?? '').trim().toLowerCase();
  const body = parseProtocolPinContent(row);
  if (!body) return null;
  if (body.protocol !== 'mrc721') return null;
  const itemPinId = String(body.itemPinId ?? '').trim().toLowerCase();
  const declaredOwner = String(body.ownerAddress ?? '').trim();
  if (!/^[0-9a-f]{64}i\d+$/.test(itemPinId) || !declaredOwner || !declarationPinId) return null;
  const signerAddress = String(row.address ?? row.createAddress ?? row.create_address ?? '').trim();
  if (signerAddress && signerAddress !== declaredOwner) return null;
  if (ownerAddress && declaredOwner !== ownerAddress) return null;
  return { itemPinId, ownerAddress: declaredOwner, declarationPinId };
}

function defaultItemInfo(pinId: string): Promise<Mrc721ItemSummary | null> {
  return fetchMrc721ItemInfo({ pinId });
}

async function resolveDeclaration(
  parsed: NftAvatarReference,
  deps: NftAvatarServiceDeps,
): Promise<NftAvatarDeclaration | null> {
  if (!parsed.ownerAddress && !parsed.globalMetaId) return null;
  const fetchDeclaration = deps.fetchDeclaration ?? fetchLatestNftAvatarDeclaration;
  return fetchDeclaration({ ownerAddress: parsed.ownerAddress, globalMetaId: parsed.globalMetaId });
}

export async function resolveNftAvatar(
  parsed: NftAvatarReference,
  deps: NftAvatarServiceDeps = {},
): Promise<NftAvatarResolution> {
  const nft: NftAvatarFacts = { itemPinId: parsed.itemPinId, ownershipVerified: false };
  try {
    const fetchItemInfo = deps.fetchItemInfo ?? defaultItemInfo;
    const item = await fetchItemInfo(parsed.itemPinId);
    if (!item || item.burned) return { avatarUrl: null, nft };
    if (item.collectionPinId?.trim()) nft.collectionPinId = item.collectionPinId.trim();
    if (item.collectionName?.trim()) nft.collectionName = item.collectionName.trim();
    if (item.ownerAddress?.trim()) nft.ownerAddress = item.ownerAddress.trim();
    const declaration = await resolveDeclaration(parsed, deps);
    if (
      declaration
      && declaration.itemPinId === parsed.itemPinId
      && declaration.ownerAddress === parsed.ownerAddress
      && item.ownerAddress === parsed.ownerAddress
    ) {
      nft.ownershipVerified = true;
      nft.declarationPinId = declaration.declarationPinId;
    }
    const cover = item.cover?.trim();
    const avatarUrl = cover ? await (deps.resolveArtwork ?? resolvePinAssetSource)(cover) : null;
    return { avatarUrl: avatarUrl ?? null, nft };
  } catch {
    return { avatarUrl: null, nft: { ...nft, ownershipVerified: false } };
  }
}

export async function prepareNftAvatarForIdentity(
  input: { reference: string; ownerAddress: string; globalMetaId?: string | null },
  deps: NftAvatarServiceDeps = {},
): Promise<PreparedNftAvatar> {
  const parsed = parseNftAvatarReference(input.reference);
  const ownerAddress = input.ownerAddress.trim();
  const globalMetaId = input.globalMetaId?.trim() || undefined;
  if (!parsed || !ownerAddress) throw new Error('NFT_AVATAR_INVALID_REFERENCE');
  try {
    const fetchItemInfo = deps.fetchItemInfo ?? defaultItemInfo;
    const item = await fetchItemInfo(parsed.itemPinId);
    if (!item || item.burned) throw new Error('NFT_AVATAR_ITEM_UNAVAILABLE');
    if (!item.ownerAddress || item.ownerAddress !== ownerAddress) {
      throw new Error('NFT_AVATAR_NOT_OWNED');
    }
    const cover = item.cover?.trim();
    if (!cover) throw new Error('NFT_AVATAR_ARTWORK_UNAVAILABLE');
    const avatarUrl = await (deps.resolveArtwork ?? resolvePinAssetSource)(cover);
    if (!avatarUrl) throw new Error('NFT_AVATAR_ARTWORK_UNAVAILABLE');
    const reference = buildNftAvatarReference({ itemPinId: parsed.itemPinId, ownerAddress, globalMetaId });
    return {
      reference,
      avatarUrl,
      declarationPayload: buildNftAvatarDeclarationPayload({ itemPinId: parsed.itemPinId, ownerAddress }),
      nft: {
        itemPinId: parsed.itemPinId,
        ...(item.collectionPinId ? { collectionPinId: item.collectionPinId } : {}),
        ...(item.collectionName ? { collectionName: item.collectionName } : {}),
        ownerAddress,
        ownershipVerified: true,
      },
    };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('NFT_AVATAR_')) throw error;
    throw new Error('NFT_AVATAR_OWNERSHIP_UNAVAILABLE');
  }
}

export async function resolveLatestNftAvatarForIdentity(
  identity: { ownerAddress?: string; globalMetaId?: string },
  deps: NftAvatarServiceDeps = {},
): Promise<NftAvatarResolution & { reference: string } | null> {
  try {
    const declaration = await (deps.fetchDeclaration ?? fetchLatestNftAvatarDeclaration)(identity);
    if (!declaration) return null;
    const reference = buildNftAvatarReference({
      itemPinId: declaration.itemPinId,
      ownerAddress: declaration.ownerAddress,
      globalMetaId: identity.globalMetaId,
    });
    const resolved = await resolveNftAvatar(parseNftAvatarReference(reference)!, {
      ...deps,
      fetchDeclaration: async () => declaration,
    });
    if (!resolved.nft.ownershipVerified) return null;
    return { ...resolved, reference };
  } catch {
    return null;
  }
}

export function clearNftAvatarItemFactsCache(): void {
  // Kept for compatibility with the existing test/IPC cache reset seam. Item
  // ownership and declarations are deliberately read fresh instead of cached.
}
