import { Buffer } from 'buffer';
import * as bip39 from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import type { MetabotStore } from '../metabotStore';
import type { Metabot, MetabotType } from '../types/metabot';
import { createMetaBotWallet } from './metabotWalletService';
import { assertCanCreateMetabot, normalizeMetabotLlmEffort } from './metabotManageService';
import { fetchContentWithFallback, fetchJsonWithFallbackOnMiss } from './localIndexerProxy';
import { resolveLatestNftAvatarForIdentity } from './nftAvatarService';

/** Restored Bot wallets must be 12-word BIP39 phrases (same rule as the IPC restore flow). */
const RESTORE_MNEMONIC_WORDS = 12;

const METAID_INFO_BY_ADDRESS = 'https://file.metaid.io/metafile-indexer/api/v1/info/address';
const METAID_INFO_BY_METAID = 'https://file.metaid.io/metafile-indexer/api/v1/info/metaid';
const METAID_CONTENT_BASE = 'https://file.metaid.io/metafile-indexer/content';

export interface MetaidAddressInfo {
  globalMetaId?: string;
  globalMetaid?: string;
  metaid?: string;
  metaId?: string;
  pinId?: string;
  name?: string;
  nameId?: string;
  namePinId?: string;
  address?: string;
  avatar?: string;
  avatarId?: string;
  avatarPinId?: string;
  bio?: unknown;
  bioId?: string;
  bioPinId?: string;
  persona?: unknown;
  personaId?: string;
  personaPinId?: string;
  llm?: unknown;
  LLM?: unknown;
  llmId?: string;
  LLMId?: string;
  llmPinId?: string;
  LLMPinId?: string;
  chatSkills?: unknown;
  chatSkillsId?: string;
  chatSkillsPinId?: string;
  chatpubkey?: string;
  chatPublicKey?: string;
  chatpubkeyId?: string;
  chatPublicKeyPinId?: string;
}

export interface MetaidBioProfile {
  role: string;
  soul: string;
  goal: string | null;
  bio: string | null;
  /** Deprecated legacy value from old `/info/bio` JSON background field. */
  background: string | null;
  llm_id: string | null;
  /** Provider key the restored brain model was picked from (new pins only). */
  llm_provider: string | null;
  /** Reasoning effort for the restored primary brain (new pins only). */
  llm_effort: string | null;
  tools: string[];
  skills: string[];
  allowChatSkills: string[];
  boss_id: number | null;
  boss_global_metaid: string | null;
  created_by: string;
}

export interface MetaidRestoreProfile {
  name: string;
  avatarDataUrl: string | null;
  nftAvatarReference?: string | null;
  nftAvatarPinId?: string | null;
  /** Latest useful profile pin id among Bot Info profile paths; stored as local metabot_info_pinid. */
  metabotInfoPinId: string | null;
  chatpubkeyPinId: string | null;
  bio: MetaidBioProfile;
  raw: MetaidAddressInfo;
}

const normalizeString = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const normalizeOptionalString = (value: unknown): string | null => {
  const normalized = normalizeString(value);
  return normalized ? normalized : null;
};

const normalizeFirstNonEmpty = (...values: unknown[]): string | null => {
  for (const value of values) {
    const normalized = normalizeOptionalString(value);
    if (normalized) return normalized;
  }
  return null;
};

const normalizeStringArray = (value: unknown): string[] => {
  if (!value) return [];
  if (Array.isArray(value)) {
    return dedupeStringArray(value);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return [];
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return dedupeStringArray(parsed);
      }
    } catch {
      return dedupeStringArray(trimmed.split(','));
    }
  }
  return [];
};

const dedupeStringArray = (values: unknown[]): string[] => {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = String(value ?? '').trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
};

const normalizeBossId = (value: unknown): number | null => {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.floor(n) : null;
};

const parseJsonObject = (value: unknown): Record<string, unknown> | null => {
  if (!value) return null;
  if (typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

const looksLikeJsonObject = (value: string): boolean => parseJsonObject(value) !== null;

const parseLegacyMetaidBio = (bio: unknown): MetaidBioProfile => {
  const empty: MetaidBioProfile = {
    role: '',
    soul: '',
    goal: null,
    bio: null,
    background: null,
    llm_id: null,
    llm_provider: null,
    llm_effort: null,
    tools: [],
    skills: [],
    allowChatSkills: [],
    boss_id: null,
    boss_global_metaid: null,
    created_by: '0000',
  };

  if (!bio) return empty;

  const raw = parseJsonObject(bio);
  if (!raw) return empty;

  return {
    role: normalizeString(raw.role),
    soul: normalizeString(raw.soul),
    goal: normalizeOptionalString(raw.goal),
    bio: normalizeOptionalString(raw.bio ?? raw.background),
    background: normalizeOptionalString(raw.background),
    llm_id: normalizeOptionalString(raw.llm ?? raw.llm_id),
    llm_provider: null,
    llm_effort: null,
    tools: normalizeStringArray(raw.tools),
    skills: normalizeStringArray(raw.skills),
    allowChatSkills: normalizeStringArray(raw.allowChatSkills ?? raw.allow_chat_skills),
    boss_id: normalizeBossId(raw.boss_id ?? raw.bossId),
    boss_global_metaid: normalizeOptionalString(raw.boss_global_metaid ?? raw.bossGlobalMetaId),
    created_by: normalizeString(raw.createdBy ?? raw.created_by) || '0000',
  };
};

const hasOwn = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);

const hasProtocolPinId = (...values: unknown[]): boolean => normalizeFirstNonEmpty(...values) !== null;

const hasProtocolPayload = (payload: unknown, ...pinIds: unknown[]): boolean => {
  if (payload !== null && payload !== undefined) return true;
  return hasProtocolPinId(...pinIds);
};

const parsePersonaPayload = (payload: unknown): {
  present: boolean;
  role: string;
  soul: string;
  goal: string | null;
} => {
  const raw = parseJsonObject(payload);
  return {
    present: true,
    role: raw ? normalizeString(raw.role) : '',
    soul: raw ? normalizeString(raw.soul) : '',
    goal: raw ? normalizeOptionalString(raw.goal) : null,
  };
};

const emptyPersonaPayload = (): {
  present: boolean;
  role: string;
  soul: string;
  goal: string | null;
} => {
  return { present: false, role: '', soul: '', goal: null };
};

interface LlmPayloadParse {
  present: boolean;
  primaryProvider: string | null;
  primaryModelProvider: string | null;
  primaryEffort: string | null;
}

const parseLlmPayload = (payload: unknown): LlmPayloadParse => {
  const raw = parseJsonObject(payload);
  return {
    present: true,
    primaryProvider: raw ? normalizeOptionalString(raw.primaryProvider) : null,
    primaryModelProvider: raw ? normalizeOptionalString(raw.primaryModelProvider) : null,
    primaryEffort: raw ? normalizeOptionalString(raw.primaryEffort) : null,
  };
};

const emptyLlmPayload = (): LlmPayloadParse => ({ present: false, primaryProvider: null, primaryModelProvider: null, primaryEffort: null });

const parseChatSkillsPayload = (payload: unknown): { present: boolean; allowChatSkills: string[] } => {
  const raw = parseJsonObject(payload);
  return {
    present: true,
    allowChatSkills: raw ? normalizeStringArray(raw.allowPrivateChatSkills) : [],
  };
};

const emptyChatSkillsPayload = (): { present: boolean; allowChatSkills: string[] } => ({ present: false, allowChatSkills: [] });

const resolveAvatarPinId = (avatar?: string | null, avatarId?: string | null): string | null => {
  const id = normalizeString(avatarId);
  if (id) return id;
  const raw = normalizeString(avatar);
  if (!raw) return null;
  const match = raw.match(/content\/([^/?#]+)$/);
  return match ? match[1] : null;
};

export function parseMetaidRestoreProfileInfo(info: MetaidAddressInfo): Pick<MetaidRestoreProfile, 'bio' | 'metabotInfoPinId' | 'chatpubkeyPinId' | 'raw'> {
  const legacy = parseLegacyMetaidBio(info.bio);
  const plainBio = typeof info.bio === 'string' && !looksLikeJsonObject(info.bio) ? normalizeOptionalString(info.bio) : null;
  const persona = (hasOwn(info, 'persona') || hasProtocolPinId(info.personaId, info.personaPinId))
    && hasProtocolPayload(info.persona, info.personaId, info.personaPinId)
    ? parsePersonaPayload(info.persona)
    : emptyPersonaPayload();
  const llm = (hasOwn(info, 'llm') || hasProtocolPinId(info.llmId, info.llmPinId))
    && hasProtocolPayload(info.llm, info.llmId, info.llmPinId)
    ? parseLlmPayload(info.llm)
    : (hasOwn(info, 'LLM') || hasProtocolPinId(info.LLMId, info.LLMPinId))
      && hasProtocolPayload(info.LLM, info.LLMId, info.LLMPinId)
      ? parseLlmPayload(info.LLM)
      : emptyLlmPayload();
  const chatSkills = (hasOwn(info, 'chatSkills') || hasProtocolPinId(info.chatSkillsId, info.chatSkillsPinId))
    && hasProtocolPayload(info.chatSkills, info.chatSkillsId, info.chatSkillsPinId)
    ? parseChatSkillsPayload(info.chatSkills)
    : emptyChatSkillsPayload();
  const avatarPinId = resolveAvatarPinId(
    info.avatar ?? null,
    normalizeFirstNonEmpty(info.avatarId, info.avatarPinId),
  );

  const bio: MetaidBioProfile = {
    ...legacy,
    bio: plainBio ?? legacy.bio,
    role: persona.present ? persona.role : legacy.role,
    soul: persona.present ? persona.soul : legacy.soul,
    goal: persona.present ? persona.goal : legacy.goal,
    llm_id: llm.present ? llm.primaryProvider : legacy.llm_id,
    llm_provider: llm.present ? llm.primaryModelProvider : legacy.llm_provider,
    llm_effort: llm.present ? llm.primaryEffort : legacy.llm_effort,
    allowChatSkills: chatSkills.present ? chatSkills.allowChatSkills : legacy.allowChatSkills,
  };

  return {
    bio,
    metabotInfoPinId: normalizeFirstNonEmpty(
      info.chatSkillsId,
      info.chatSkillsPinId,
      info.llmId,
      info.LLMId,
      info.llmPinId,
      info.LLMPinId,
      info.personaId,
      info.personaPinId,
      info.bioId,
      info.bioPinId,
      info.nameId,
      info.namePinId,
      avatarPinId,
      info.pinId,
    ),
    chatpubkeyPinId: normalizeFirstNonEmpty(info.chatpubkeyId, info.chatPublicKeyPinId),
    raw: info,
  };
}

const unwrapMetaidInfo = (payload: unknown): Record<string, unknown> | null => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }

  const record = payload as Record<string, unknown>;
  const nested = record.MetaIdInfo ?? record.metaIdInfo ?? record.metaidInfo;
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    return {
      ...record,
      ...(nested as Record<string, unknown>),
    };
  }

  return record;
};

/**
 * Profile-content keys that make a metaid-info payload a real hit. Bare
 * identity metadata (metaid / globalMetaId / address) does NOT count: a fresh
 * local P2P node answers address/metaid lookups with a stub that carries only
 * that mapping while every profile field is empty (`isInit: false`). Treating
 * the stub as a hit skips the remote fallback and starves callers that need
 * profile fields (name / avatar / chatpubkey). A bare `pinId` is deliberately
 * not content either — it can point at any pin and does not prove that a
 * profile pin is synced locally.
 */
const METAID_PROFILE_CONTENT_KEYS = [
  'name',
  'avatar',
  'avatarId',
  'avatarPinId',
  'chatpubkey',
  'chatPublicKey',
  'nameId',
  'namePinId',
] as const;

export function isSemanticallyEmptyMetaidInfoPayload(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') {
    return true;
  }
  const data = (payload as { data?: unknown }).data;
  const info = unwrapMetaidInfo(data);
  if (!info) {
    return true;
  }
  const hasContentValue = METAID_PROFILE_CONTENT_KEYS.some((key) => {
    const value = info[key];
    return typeof value === 'string' && value.trim().length > 0;
  });
  // A content-less payload is always a semantic miss — including one that
  // merely carries `isInit: true`: the init flag is not evidence that the
  // profile pins are available locally, so profile readers must be allowed to
  // reach the remote indexer for the complete record.
  return !hasContentValue;
}

/**
 * Stricter miss check for restore flows, which need a usable profile name: a
 * payload without one must fall through to the remote indexer even when the
 * local node already holds other profile fields (the name pin may simply not
 * be synced yet).
 */
export function isSemanticallyEmptyRestoreProfilePayload(payload: unknown): boolean {
  if (isSemanticallyEmptyMetaidInfoPayload(payload)) {
    return true;
  }
  const data = (payload as { data?: unknown }).data;
  const info = unwrapMetaidInfo(data);
  const name = info && typeof info.name === 'string' ? info.name.trim() : '';
  return name.length === 0;
}

const fetchMetaidInfo = async (
  localPath: string,
  remoteUrl: string,
  isSemanticMiss: (payload: unknown) => boolean = isSemanticallyEmptyMetaidInfoPayload,
): Promise<MetaidAddressInfo | null> => {
  const res = await fetchJsonWithFallbackOnMiss(localPath, remoteUrl, isSemanticMiss, {
    degradeToLocalOnRemoteError: true,
  });
  if (!res.ok) {
    throw new Error(`metaid info fetch failed: ${res.status} ${res.statusText}`);
  }
  const json = (await res.json()) as { code?: number; message?: string; data?: MetaidAddressInfo };
  if (json?.code != null && json.code !== 1) {
    throw new Error(json?.message || 'metaid info response error');
  }
  return (unwrapMetaidInfo(json?.data) as MetaidAddressInfo | null) ?? null;
};

export const fetchMetaidInfoByAddress = async (
  address: string,
  isSemanticMiss: (payload: unknown) => boolean = isSemanticallyEmptyMetaidInfoPayload,
): Promise<MetaidAddressInfo | null> => {
  const trimmed = address.trim();
  if (!trimmed) return null;
  const url = `${METAID_INFO_BY_ADDRESS}/${encodeURIComponent(trimmed)}`;
  const localPath = `/api/v1/users/info/address/${encodeURIComponent(trimmed)}`;
  return fetchMetaidInfo(localPath, url, isSemanticMiss);
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
  const info = await fetchMetaidInfoByAddress(address, isSemanticallyEmptyRestoreProfilePayload);
  if (!info) {
    throw new Error('CHAIN_INFO_EMPTY');
  }
  const name = normalizeString(info.name);
  if (!name) {
    throw new Error('NAME_EMPTY');
  }
  const parsed = parseMetaidRestoreProfileInfo(info);
  const avatarPinId = resolveAvatarPinId(
    info.avatar ?? null,
    normalizeFirstNonEmpty(info.avatarId, info.avatarPinId),
  );
  let avatarDataUrl: string | null = null;
  if (avatarPinId) {
    try {
      avatarDataUrl = await fetchAvatarDataUrl(avatarPinId);
    } catch (err) {
      console.warn('[MetaBot] restore avatar fetch failed', err instanceof Error ? err.message : String(err));
    }
  }
  const nftAvatar = await resolveLatestNftAvatarForIdentity({
    ownerAddress: address,
    globalMetaId: info.globalMetaId,
  });
  return {
    name,
    avatarDataUrl: nftAvatar?.avatarUrl ?? avatarDataUrl,
    nftAvatarReference: nftAvatar?.reference ?? null,
    nftAvatarPinId: nftAvatar?.nft.declarationPinId ?? null,
    metabotInfoPinId: parsed.metabotInfoPinId,
    chatpubkeyPinId: parsed.chatpubkeyPinId,
    bio: parsed.bio,
    raw: info,
  };
};

// ---------------------------------------------------------------------------
// restoreMetabotFromMnemonicCore
// ---------------------------------------------------------------------------

/**
 * Core of the `idbots:restoreMetaBotFromMnemonic` flow: derive the wallet,
 * optionally verify its expected GlobalMetaID, build the local Bot from either
 * an encrypted-backup profile or the on-chain /info profile, mirror chat-skill
 * assignments, and heal the zero-Twin edge. The standalone IPC flow keeps the
 * original chain-profile behavior when no override is supplied.
 */
export interface RestoreMetabotCoreInput {
  mnemonic: string;
  path?: string;
  boss_global_metaid?: string | null;
  expectedGlobalMetaId?: string;
  metabotType?: Exclude<MetabotType, 'welcome'>;
  profileOverride?: MetaidRestoreProfile;
}

export interface RestoreMetabotCoreDeps {
  /** Mirrors allow_chat_skills into the assignment table (main.ts injects the SkillManager call). */
  applyAssignedSkills?: (metabotId: number, skills: string[]) => void;
}

export type RestoreMetabotCoreResult =
  | { success: true; metabot: Metabot }
  | { success: false; error: string };

export const restoreMetabotFromMnemonicCore = async (
  store: MetabotStore,
  input: RestoreMetabotCoreInput,
  deps: RestoreMetabotCoreDeps = {},
): Promise<RestoreMetabotCoreResult> => {
  try {
    const mnemonic = (input?.mnemonic ?? '').trim().toLowerCase();
    const pathInput = (input?.path ?? "m/44'/10001'/0'/0/0").trim();
    const path = pathInput || "m/44'/10001'/0'/0/0";
    const words = mnemonic.split(/\s+/).filter(Boolean);

    console.log('[MetaBot] restore requested', { path, wordCount: words.length });

    if (words.length !== RESTORE_MNEMONIC_WORDS) {
      return { success: false, error: 'MNEMONIC_INVALID' };
    }
    if (!bip39.validateMnemonic(mnemonic, wordlist)) {
      return { success: false, error: 'MNEMONIC_INVALID' };
    }
    if (!path) {
      return { success: false, error: 'PATH_INVALID' };
    }

    const existingWallet = store.getMetabotWalletByMnemonicNormalized(mnemonic);
    const effectivePath = existingWallet?.path?.trim() || path;
    if (existingWallet) {
      const linked = store.getMetabotByWalletId(existingWallet.id);
      if (linked) {
        return { success: false, error: 'METABOT_WALLET_IN_USE' };
      }
      if (pathInput !== existingWallet.path?.trim()) {
        console.log('[MetaBot] restore: reusing existing wallet row; using stored derivation path', {
          storedPath: existingWallet.path,
          requestedPath: pathInput,
        });
      }
    }
    assertCanCreateMetabot(store);

    const walletResult = await createMetaBotWallet({
      mnemonic: existingWallet?.mnemonic ?? mnemonic,
      path: effectivePath,
    });
    console.log('[MetaBot] restore wallet derived', {
      mvc: walletResult.mvc_address,
      globalmetaid: walletResult.globalmetaid,
      reusedWalletRow: Boolean(existingWallet),
    });
    const expectedGlobalMetaId = input.expectedGlobalMetaId?.trim();
    if (expectedGlobalMetaId && walletResult.globalmetaid.trim() !== expectedGlobalMetaId) {
      return { success: false, error: 'BOT_IDENTITY_MISMATCH' };
    }

    const profile = input.profileOverride ?? await fetchMetaidRestoreProfile(walletResult.mvc_address);
    const name = profile.name.trim();
    if (!name) {
      return { success: false, error: 'NAME_EMPTY' };
    }

    const exists = store.listMetabots().some((m) => m.name.trim().toLowerCase() === name.toLowerCase());
    if (exists) {
      return { success: false, error: 'NAME_DUPLICATE' };
    }

    const wallet =
      existingWallet ??
      store.insertMetabotWallet({
        mnemonic: walletResult.mnemonic,
        path: walletResult.path,
      });

    const metabot = store.createMetabot({
      wallet_id: wallet.id,
      mvc_address: walletResult.mvc_address,
      btc_address: walletResult.btc_address,
      doge_address: walletResult.doge_address,
      public_key: walletResult.public_key,
      chat_public_key: walletResult.chat_public_key,
      chat_public_key_pin_id: profile.chatpubkeyPinId ?? null,
      name,
      avatar: profile.nftAvatarReference ?? profile.avatarDataUrl ?? null,
      avatar_fallback: profile.avatarDataUrl ?? null,
      nft_avatar_pin_id: profile.nftAvatarPinId ?? null,
      nft_avatar_synced_reference: profile.nftAvatarReference ?? '',
      enabled: true,
      metaid: walletResult.metaid,
      globalmetaid: walletResult.globalmetaid,
      metabot_info_pinid: profile.metabotInfoPinId ?? null,
      metabot_type: input.metabotType ?? 'worker',
      created_by: profile.bio.created_by || '0000',
      role: profile.bio.role || '',
      soul: profile.bio.soul || '',
      goal: profile.bio.goal ?? null,
      bio: profile.bio.bio ?? null,
      boss_id: profile.bio.boss_id ?? null,
      boss_global_metaid: (input?.boss_global_metaid ?? '').trim() || (profile.bio.boss_global_metaid ?? null),
      llm_id: profile.bio.llm_id ?? null,
      llm_provider: profile.bio.llm_provider ?? null,
      llm_effort: normalizeMetabotLlmEffort(profile.bio.llm_effort),
      tools: profile.bio.tools ?? [],
      skills: profile.bio.skills ?? [],
      allow_chat_skills: profile.bio.allowChatSkills ?? [],
    });

    // Assignment-model backfill: the restored row's allow_chat_skills column
    // is the on-chain projection — mirror it into the assignment table (the
    // local authorization source of truth) or the bot silently loses every
    // chat skill (IM baseline = assigned-only). Best-effort: restore has no
    // rollback, and a retried restore would duplicate the bot row.
    if (deps.applyAssignedSkills) {
      try {
        deps.applyAssignedSkills(
          metabot.id,
          profile.bio.allowChatSkills ?? []
        );
      } catch (assignmentError) {
        console.warn(
          '[MetaBot] restore: chat-skill assignment backfill failed (re-save the bot\'s skills in My Bots to heal):',
          assignmentError instanceof Error ? assignmentError.message : String(assignmentError)
        );
      }
    }
    console.log('[MetaBot] restore success', { id: metabot.id, name: metabot.name });
    // The chain-backup orchestrator finalizes the original Twin after all IDs
    // are known; standalone restore still heals a fleet with no Twin here.
    store.ensureTwinExists();
    // Re-read: ensureTwinExists may have promoted this bot to twin.
    return { success: true, metabot: store.getMetabotById(metabot.id) ?? metabot };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error('[MetaBot] restore failed:', errMsg);
    return { success: false, error: errMsg };
  }
};
