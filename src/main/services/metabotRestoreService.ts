import { Buffer } from 'buffer';
import { fetchContentWithFallback, fetchJsonWithFallbackOnMiss } from './localIndexerProxy';

const METAID_INFO_BY_ADDRESS = 'https://file.metaid.io/metafile-indexer/api/v1/info/address';
const METAID_INFO_BY_METAID = 'https://file.metaid.io/metafile-indexer/api/v1/info/metaid';
const METAID_CONTENT_BASE = 'https://file.metaid.io/metafile-indexer/content';

export interface MetaidAddressInfo {
  globalMetaId?: string;
  metaid?: string;
  name?: string;
  nameId?: string;
  address?: string;
  avatar?: string;
  avatarId?: string;
  bio?: unknown;
  bioId?: string;
  chatpubkey?: string;
  chatpubkeyId?: string;
}

export interface MetaidBioProfile {
  role: string;
  soul: string;
  goal: string | null;
  background: string | null;
  llm_id: string | null;
  tools: string[];
  skills: string[];
  boss_id: number | null;
  boss_global_metaid: string | null;
  created_by: string;
}

export interface MetaidRestoreProfile {
  name: string;
  avatarDataUrl: string | null;
  chatpubkeyPinId: string | null;
  bio: MetaidBioProfile;
  raw: MetaidAddressInfo;
}

const normalizeString = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const normalizeOptionalString = (value: unknown): string | null => {
  const normalized = normalizeString(value);
  return normalized ? normalized : null;
};

const normalizeStringArray = (value: unknown): string[] => {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.map((item) => String(item)).map((item) => item.trim()).filter(Boolean);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return [];
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.map((item) => String(item)).map((item) => item.trim()).filter(Boolean);
      }
    } catch {
      return [];
    }
  }
  return [];
};

const normalizeBossId = (value: unknown): number | null => {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.floor(n) : null;
};

const parseMetaidBio = (bio: unknown): MetaidBioProfile => {
  const empty: MetaidBioProfile = {
    role: '',
    soul: '',
    goal: null,
    background: null,
    llm_id: null,
    tools: [],
    skills: [],
    boss_id: null,
    boss_global_metaid: null,
    created_by: '0000',
  };

  if (!bio) return empty;

  let raw: Record<string, unknown> | null = null;
  if (typeof bio === 'string') {
    const trimmed = bio.trim();
    if (!trimmed) return empty;
    try {
      const parsed = JSON.parse(trimmed);
      raw = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
    } catch {
      raw = null;
    }
  } else if (typeof bio === 'object' && !Array.isArray(bio)) {
    raw = bio as Record<string, unknown>;
  }

  if (!raw) return empty;

  return {
    role: normalizeString(raw.role),
    soul: normalizeString(raw.soul),
    goal: normalizeOptionalString(raw.goal),
    background: normalizeOptionalString(raw.background),
    llm_id: normalizeOptionalString(raw.llm ?? raw.llm_id),
    tools: normalizeStringArray(raw.tools),
    skills: normalizeStringArray(raw.skills),
    boss_id: normalizeBossId(raw.boss_id ?? raw.bossId),
    boss_global_metaid: normalizeOptionalString(raw.boss_global_metaid ?? raw.bossGlobalMetaId),
    created_by: normalizeString(raw.createdBy ?? raw.created_by) || '0000',
  };
};

const resolveAvatarPinId = (avatar?: string | null, avatarId?: string | null): string | null => {
  const id = normalizeString(avatarId);
  if (id) return id;
  const raw = normalizeString(avatar);
  if (!raw) return null;
  const match = raw.match(/content\/([^/?#]+)$/);
  return match ? match[1] : null;
};

export function isSemanticallyEmptyMetaidInfoPayload(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') {
    return true;
  }
  const data = (payload as { data?: unknown }).data;
  if (!data || typeof data !== 'object') {
    return true;
  }
  const info = data as Record<string, unknown>;
  const identityKeys = ['metaid', 'globalMetaId', 'name', 'address', 'avatar', 'avatarId', 'chatpubkey', 'pinId', 'nameId'];
  const hasIdentityValue = identityKeys.some((key) => {
    const value = info[key];
    return typeof value === 'string' && value.trim().length > 0;
  });
  if (hasIdentityValue) {
    return false;
  }
  return info.isInit !== true;
}

const fetchMetaidInfo = async (localPath: string, remoteUrl: string): Promise<MetaidAddressInfo | null> => {
  const res = await fetchJsonWithFallbackOnMiss(localPath, remoteUrl, isSemanticallyEmptyMetaidInfoPayload);
  if (!res.ok) {
    throw new Error(`metaid info fetch failed: ${res.status} ${res.statusText}`);
  }
  const json = (await res.json()) as { code?: number; message?: string; data?: MetaidAddressInfo };
  if (json?.code != null && json.code !== 1) {
    throw new Error(json?.message || 'metaid info response error');
  }
  return json?.data ?? null;
};

export const fetchMetaidInfoByAddress = async (address: string): Promise<MetaidAddressInfo | null> => {
  const trimmed = address.trim();
  if (!trimmed) return null;
  const url = `${METAID_INFO_BY_ADDRESS}/${encodeURIComponent(trimmed)}`;
  const localPath = `/api/v1/users/info/address/${encodeURIComponent(trimmed)}`;
  return fetchMetaidInfo(localPath, url);
};

export const fetchMetaidInfoByMetaid = async (metaid: string): Promise<MetaidAddressInfo | null> => {
  const trimmed = metaid.trim();
  if (!trimmed) return null;
  const url = `${METAID_INFO_BY_METAID}/${encodeURIComponent(trimmed)}`;
  const localPath = `/api/v1/users/info/metaid/${encodeURIComponent(trimmed)}`;
  return fetchMetaidInfo(localPath, url);
};

const fetchAvatarDataUrl = async (pinId: string): Promise<string | null> => {
  const trimmed = pinId.trim();
  if (!trimmed) return null;
  const url = `${METAID_CONTENT_BASE}/${encodeURIComponent(trimmed)}`;
  const res = await fetchContentWithFallback(trimmed, url);
  if (!res.ok) {
    throw new Error(`avatar fetch failed: ${res.status} ${res.statusText}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  if (!buffer.length) return null;
  const mime = res.headers.get('content-type') || 'image/png';
  return `data:${mime};base64,${buffer.toString('base64')}`;
};

export const fetchMetaidRestoreProfile = async (address: string): Promise<MetaidRestoreProfile> => {
  const info = await fetchMetaidInfoByAddress(address);
  if (!info) {
    throw new Error('CHAIN_INFO_EMPTY');
  }
  const name = normalizeString(info.name);
  if (!name) {
    throw new Error('NAME_EMPTY');
  }
  const bio = parseMetaidBio(info.bio);
  const avatarPinId = resolveAvatarPinId(info.avatar ?? null, info.avatarId ?? null);
  let avatarDataUrl: string | null = null;
  if (avatarPinId) {
    try {
      avatarDataUrl = await fetchAvatarDataUrl(avatarPinId);
    } catch (err) {
      console.warn('[MetaBot] restore avatar fetch failed', err instanceof Error ? err.message : String(err));
    }
  }
  const chatpubkeyPinId = normalizeOptionalString(info.chatpubkeyId);
  return {
    name,
    avatarDataUrl,
    chatpubkeyPinId,
    bio,
    raw: info,
  };
};
