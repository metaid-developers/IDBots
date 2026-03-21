/**
 * Fetch MetaBot / MetaID user info by globalMetaId. Avatar resolution is
 * performed in the main process so renderer consumers stay local-first.
 */

export interface MetaidInfoResult {
  name?: string;
  avatarUrl?: string | null;
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
  const result = await window.electron.p2p.getUserInfo({ globalMetaId: id });
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
    chatpubkey: chatpubkey || undefined,
    globalMetaId: typeof data.globalMetaId === 'string' ? data.globalMetaId : id,
    metaid: typeof data.metaid === 'string' ? data.metaid : undefined,
    address: typeof data.address === 'string' ? data.address : undefined,
  };
}
