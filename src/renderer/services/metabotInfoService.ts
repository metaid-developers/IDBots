/**
 * Fetch MetaBot / MetaID user info by globalMetaId or MVC address. Avatar
 * resolution is performed in the main process so renderer consumers stay
 * local-first. The address flavor backs the chat NFT card identity chips
 * (owner/issuer) and hits the same indexer info route omni_read user_info
 * uses for addresses.
 */

export interface MetaidInfoResult {
  name?: string;
  avatarUrl?: string | null;
  nftAvatar?: string | null;
  nftAvatarOwnershipVerified?: boolean;
  chatpubkey?: string | null;
  globalMetaId?: string;
  metaid?: string;
  address?: string;
}

export async function fetchMetaidInfoByGlobalId(
  globalMetaId: string
): Promise<MetaidInfoResult> {
  const id = (globalMetaId || '').trim();
  if (!id) {
    return {};
  }
  return fetchMetaidInfo({ globalMetaId: id });
}

export async function fetchMetaidInfoByAddress(
  address: string
): Promise<MetaidInfoResult> {
  const id = (address || '').trim();
  if (!id) {
    return {};
  }
  return fetchMetaidInfo({ address: id });
}

async function fetchMetaidInfo(
  params: { globalMetaId: string } | { address: string }
): Promise<MetaidInfoResult> {
  const result = await window.electron.p2p.getUserInfo(params);
  const json = result as { code?: number; message?: string; data?: Record<string, unknown> };
  if (json.code !== 1 && json.code !== undefined) {
    throw new Error(json.message || 'Metabot info request failed');
  }
  const data = json.data || {};
  const name = typeof data.name === 'string' ? data.name.trim() || undefined : undefined;
  const chatpubkey = typeof data.chatpubkey === 'string' ? data.chatpubkey.trim() || null : null;
  const avatarUrl = typeof data.avatarUrl === 'string' ? data.avatarUrl.trim() || null : null;
  return {
    name,
    avatarUrl: avatarUrl || undefined,
    nftAvatar: typeof data.nftAvatar === 'string' ? data.nftAvatar : null,
    nftAvatarOwnershipVerified: data.nftAvatarOwnershipVerified === true,
    chatpubkey: chatpubkey || undefined,
    globalMetaId:
      typeof data.globalMetaId === 'string'
        ? data.globalMetaId
        : 'globalMetaId' in params
          ? params.globalMetaId
          : undefined,
    metaid: typeof data.metaid === 'string' ? data.metaid : undefined,
    address: typeof data.address === 'string' ? data.address : undefined,
  };
}

export async function resolveMetaidAvatarSource(
  reference: string | null | undefined
): Promise<string | null> {
  const ref = (reference || '').trim();
  if (!ref) {
    return null;
  }
  const result = await window.electron.p2p.resolveAvatarSource({ reference: ref });
  const json = result as { success?: boolean; avatarUrl?: string | null; error?: string };
  if (json.success === false) {
    throw new Error(json.error || 'Avatar resolution failed');
  }
  return typeof json.avatarUrl === 'string' ? json.avatarUrl.trim() || null : null;
}
