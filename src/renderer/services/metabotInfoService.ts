/**
 * Fetch MetaBot / MetaID user info (name, avatar, chatpubkey) by globalMetaId
 * from file.metaid.io metafile-indexer API. Reusable for Gig Square provider display
 * and other features that need remote MetaBot info.
 */

const METAFILE_INFO_BASE = 'https://file.metaid.io/metafile-indexer/api/v1/info/metaid';
const METAFILE_CONTENT_BASE = 'https://file.metaid.io/metafile-indexer/thumbnail';

export interface MetaidInfoResult {
  name?: string;
  avatarUrl?: string | null;
  chatpubkey?: string | null;
  globalMetaId?: string;
  metaid?: string;
  address?: string;
}

/**
 * Resolve avatar to image URL. Same pattern as serviceIcon in GigSquareView:
 * https://file.metaid.io/metafile-indexer/api/v1/files/content/<pinid>
 * API may return: avatarId (pinid), avatar ("/content/" or "/content/<pinid>"), or metafile://<pinid>.
 */
function resolveAvatarUrl(data: Record<string, unknown>): string | null {
  const avatarId = typeof data.avatarId === 'string' ? data.avatarId.trim() : '';
  if (avatarId) {
    return `${METAFILE_CONTENT_BASE}/${encodeURIComponent(avatarId)}`;
  }
  const avatar = typeof data.avatar === 'string' ? data.avatar.trim() : '';
  if (avatar && avatar.toLowerCase().startsWith('http')) return avatar;
  if (avatar && avatar.toLowerCase().startsWith('metafile://')) {
    const pinid = avatar.slice('metafile://'.length).trim();
    if (pinid) return `${METAFILE_CONTENT_BASE}/${encodeURIComponent(pinid)}`;
  }
  if (avatar && !avatar.startsWith('http')) {
    const pinid = avatar.replace(/^\/content\/?/i, '').trim();
    if (pinid) return `${METAFILE_CONTENT_BASE}/${encodeURIComponent(pinid)}`;
  }
  const contentId = typeof (data as Record<string, unknown>).contentId === 'string'
    ? (data as Record<string, unknown>).contentId.trim()
    : '';
  if (contentId) return `${METAFILE_CONTENT_BASE}/${encodeURIComponent(contentId)}`;
  return null;
}

/**
 * Fetch MetaBot / user info by globalMetaId from file.metaid.io.
 * Returns name, avatarUrl (for display, same as serviceIcon), and optional chatpubkey.
 */
export async function fetchMetaidInfoByGlobalId(
  globalMetaId: string
): Promise<MetaidInfoResult> {
  const id = (globalMetaId || '').trim();
  if (!id) {
    return {};
  }
  const url = `${METAFILE_INFO_BASE}/${encodeURIComponent(id)}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Metabot info fetch failed: ${res.status}`);
  }
  const json = (await res.json()) as {
    code?: number;
    message?: string;
    data?: Record<string, unknown>;
  };
  if (json.code !== 1 && json.code !== undefined) {
    throw new Error(json.message || 'Metabot info request failed');
  }
  const data = json.data || {};
  const name = typeof data.name === 'string' ? data.name.trim() || undefined : undefined;
  const chatpubkey = typeof data.chatpubkey === 'string' ? data.chatpubkey.trim() || null : null;
  const avatarUrl = resolveAvatarUrl(data);
  return {
    name,
    avatarUrl: avatarUrl || undefined,
    chatpubkey: chatpubkey || undefined,
    globalMetaId: typeof data.globalMetaId === 'string' ? data.globalMetaId : id,
    metaid: typeof data.metaid === 'string' ? data.metaid : undefined,
    address: typeof data.address === 'string' ? data.address : undefined,
  };
}
