/**
 * User Identity Service: create/import/logout the local human user identity
 * and publish its MetaID info pins (/info/name, /info/avatar, /info/chatpubkey).
 *
 * Bootstrap model (mirrors OAC's local-identity flow):
 *  1. Create the identity (wallet + mnemonic) and persist it locally.
 *  2. Claim the MVC gas subsidy. This is a distinct, retryable step: when it
 *     fails we do NOT attempt on-chain pins (they would all fail with
 *     "not enough balance").
 *  3. Publish the /info pins. Each successful pin stores its PinID, so a retry
 *     only republishes the pins that are still missing.
 *
 * The local identity is always kept, even when subsidy/pins fail, so the user
 * can retry from the profile panel (Retry subsidy / Retry chain sync) or fund
 * the MVC address directly.
 */

import * as bip39 from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import type { UserIdentityStore } from '../userIdentityStore';
import type { UserIdentity, UserSubsidyState, UserSyncState } from '../types/userIdentity';
import { createMetaBotWallet } from './metabotWalletService';
import { requestMvcGasSubsidy } from './mvcSubsidyService';
import { fetchMetaidRestoreProfile } from './metabotRestoreService';
import {
  createPinForIdentity,
  normalizeMetafileAvatarReference,
  parseDataUrlAvatar,
  type MvcCreatePinSessionSnapshot,
} from './metaidCore';
import { getRate as getGlobalFeeRate } from './feeRateStore';
import {
  buildNftAvatarDeclarationPayload,
  NFT_AVATAR_PATH,
  parseNftAvatarReference,
  prepareNftAvatarForIdentity,
} from './nftAvatarService';

export type UserInfoSyncStep = 'name' | 'avatar' | 'nftAvatar' | 'chatpubkey';

export interface UserInfoSyncStepPlan {
  key: UserInfoSyncStep;
  path: string;
  contentType: string;
  payload: string | Buffer;
  encoding?: 'base64';
}

export interface UserChainSyncResult {
  success: boolean;
  txids: string[];
  chatPublicKeyPinId?: string;
  namePinId?: string;
  avatarPinId?: string;
  nftAvatarPinId?: string;
  failedSteps: UserInfoSyncStep[];
  error?: string;
}

export interface UserSubsidyResult {
  success: boolean;
  error?: string;
  step1?: unknown;
  step2?: unknown;
}

export interface UserIdentityResult {
  success: boolean;
  error?: string;
  identity?: UserIdentity;
  /** Present only right after createUserIdentity so the UI can show the backup step. */
  mnemonic?: string;
  subsidy?: UserSubsidyResult;
  chainSync?: UserChainSyncResult;
  /** 'chain' when the profile came from on-chain data (import), 'local' otherwise. */
  profileSource?: 'chain' | 'local';
}

export interface UserIdentityServiceDeps {
  createPin?: typeof createPinForIdentity;
  requestSubsidy?: typeof requestMvcGasSubsidy;
  fetchProfile?: typeof fetchMetaidRestoreProfile;
  prepareNftAvatar?: typeof prepareNftAvatarForIdentity;
  sleep?: (ms: number) => Promise<void>;
}

const USER_PIN_STEP_INTERVAL_MS = 3000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestSubsidySafe(
  requestSubsidy: (options: { mvcAddress: string; mnemonic?: string; path?: string }) => Promise<UserSubsidyResult>,
  mvcAddress: string,
  mnemonic: string,
  path: string,
): Promise<UserSubsidyResult> {
  try {
    return await requestSubsidy({ mvcAddress, mnemonic, path });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: message };
  }
}

/**
 * Build the pin plan for the current identity. Only pins that are still
 * missing locally are included, so retries are idempotent:
 *  - name/avatar are candidates only when includeProfileSteps is true and
 *    their PinID is not recorded yet;
 *  - chatpubkey is included only while no chat_public_key_pin_id is recorded
 *    (protocol: chatpubkey is immutable).
 */
export function buildUserInfoSyncSteps(
  identity: Pick<
    UserIdentity,
    | 'name'
    | 'avatar'
    | 'avatar_fallback'
    | 'mvc_address'
    | 'nft_avatar_synced_reference'
    | 'chat_public_key'
    | 'chat_public_key_pin_id'
    | 'name_pin_id'
    | 'avatar_pin_id'
  >,
  options: { includeProfileSteps: boolean; forceAvatarClear?: boolean },
): UserInfoSyncStepPlan[] {
  const steps: UserInfoSyncStepPlan[] = [];

  if (options.includeProfileSteps) {
    if (!identity.name_pin_id && identity.name.trim()) {
      steps.push({ key: 'name', path: '/info/name', contentType: 'text/plain', payload: identity.name });
    }
    const nftReference = parseNftAvatarReference(identity.avatar);
    const metafileReference = !nftReference ? normalizeMetafileAvatarReference(identity.avatar) : null;
    const avatarData = !metafileReference
      ? parseDataUrlAvatar(nftReference ? identity.avatar_fallback : identity.avatar)
      : null;
    if (!identity.avatar_pin_id && metafileReference) {
      steps.push({
        key: 'avatar',
        path: '/info/avatar',
        contentType: 'text/plain',
        payload: metafileReference,
      });
    } else if (!identity.avatar_pin_id && avatarData) {
      steps.push({
        key: 'avatar',
        path: '/info/avatar',
        contentType: `${avatarData.mime};binary`,
        payload: avatarData.buffer,
        encoding: 'base64',
      });
    } else if (options.forceAvatarClear && !identity.avatar_pin_id && !identity.avatar) {
      steps.push({ key: 'avatar', path: '/info/avatar', contentType: 'text/plain', payload: '' });
    }
    const currentNftReference = nftReference ? identity.avatar!.trim() : '';
    if (currentNftReference !== (identity.nft_avatar_synced_reference ?? '')) {
      steps.push({
        key: 'nftAvatar',
        path: NFT_AVATAR_PATH,
        contentType: 'application/json',
        payload: nftReference
          ? buildNftAvatarDeclarationPayload({ itemPinId: nftReference.itemPinId, ownerAddress: identity.mvc_address })
          : '',
      });
    }
  }

  const chatPubKey = typeof identity.chat_public_key === 'string' ? identity.chat_public_key.trim() : '';
  if (!identity.chat_public_key_pin_id && chatPubKey) {
    steps.push({ key: 'chatpubkey', path: '/info/chatpubkey', contentType: 'text/plain', payload: chatPubKey });
  }
  return steps;
}

/** Persist the PinID of a successfully published step. */
function persistStepPin(
  userStore: UserIdentityStore,
  stepKey: UserInfoSyncStep,
  pinId: string,
  nftReference = '',
): void {
  const patch: Parameters<UserIdentityStore['update']>[0] = {};
  if (stepKey === 'name') patch.name_pin_id = pinId;
  if (stepKey === 'avatar') patch.avatar_pin_id = pinId;
  if (stepKey === 'nftAvatar') {
    patch.nft_avatar_pin_id = pinId;
    patch.nft_avatar_synced_reference = nftReference;
  }
  if (stepKey === 'chatpubkey') patch.chat_public_key_pin_id = pinId;
  userStore.update(patch);
}

/**
 * Publish pending pins for the current identity. Best-effort per step with a
 * 3s gap (indexer delay) and threaded outpoint exclusions to avoid UTXO
 * double-spend across sequential pins of the same wallet. Every successful
 * step persists its PinID so later retries skip it.
 */
export async function syncUserIdentityToChain(
  userStore: UserIdentityStore,
  options: { includeProfileSteps: boolean; forceAvatarClear?: boolean },
  deps: UserIdentityServiceDeps = {},
): Promise<UserChainSyncResult> {
  const createPin = deps.createPin ?? createPinForIdentity;
  const sleep = deps.sleep ?? defaultSleep;

  const identity = userStore.get();
  if (!identity) {
    return { success: false, txids: [], failedSteps: [], error: 'USER_IDENTITY_MISSING' };
  }

  let identityForSteps = identity;
  const nftNeedsSync = parseNftAvatarReference(identity.avatar)
    && (identity.avatar !== (identity.nft_avatar_synced_reference ?? '') || !identity.avatar_pin_id || !identity.avatar_fallback);
  if (options.includeProfileSteps && nftNeedsSync) {
    try {
      const prepared = await (deps.prepareNftAvatar ?? prepareNftAvatarForIdentity)({
        reference: identity.avatar!,
        ownerAddress: identity.mvc_address,
        globalMetaId: identity.globalmetaid,
      });
      identityForSteps = { ...identity, avatar: prepared.reference, avatar_fallback: prepared.avatarUrl };
      userStore.update({ avatar: prepared.reference, avatar_fallback: prepared.avatarUrl });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      userStore.update({ sync_state: 'failed', sync_error: message });
      return { success: false, txids: [], failedSteps: ['avatar', 'nftAvatar'], error: message };
    }
  }
  const steps = buildUserInfoSyncSteps(identityForSteps, options);
  const txids: string[] = [];
  const failedSteps: UserInfoSyncStep[] = [];
  let lastError = '';
  const sessionSnapshot: MvcCreatePinSessionSnapshot = {
    excludeOutpoints: [],
    preferredFundingUtxos: [],
  };

  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    const current = userStore.get() ?? identityForSteps;
    try {
      const result = await createPin({
        mnemonic: current.mnemonic,
        path: current.path,
        metaidData: {
          operation: 'create',
          path: step.path,
          contentType: step.contentType,
          payload: step.payload,
          encoding: step.encoding,
        },
        options: { feeRate: getGlobalFeeRate('mvc') },
        sessionSnapshot,
      });
      const txid = result.txids[0];
      if (!txid) {
        failedSteps.push(step.key);
        lastError = `${step.key} pin failed: no txid`;
      } else {
        txids.push(txid);
        const pinId = result.pinId ?? `${txid}i0`;
        persistStepPin(
          userStore,
          step.key,
          pinId,
          parseNftAvatarReference(identityForSteps.avatar) ? identityForSteps.avatar! : '',
        );
        if (Array.isArray(result.spentOutpoints) && result.spentOutpoints.length > 0) {
          sessionSnapshot.excludeOutpoints.push(...result.spentOutpoints);
        }
        sessionSnapshot.preferredFundingUtxos = result.changeUtxo ? [result.changeUtxo] : [];
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failedSteps.push(step.key);
      lastError = `${step.key}: ${message}`;
    }

    if (index < steps.length - 1) {
      await sleep(USER_PIN_STEP_INTERVAL_MS);
    }
  }

  const syncState: UserSyncState = failedSteps.length === 0 ? 'synced' : (txids.length > 0 ? 'partial' : 'failed');
  userStore.update({
    sync_state: syncState,
    sync_error: failedSteps.length > 0 ? lastError : null,
  });

  const latest = userStore.get();
  return {
    success: failedSteps.length === 0,
    txids,
    chatPublicKeyPinId: latest?.chat_public_key_pin_id ?? undefined,
    namePinId: latest?.name_pin_id ?? undefined,
    avatarPinId: latest?.avatar_pin_id ?? undefined,
    nftAvatarPinId: latest?.nft_avatar_pin_id ?? undefined,
    failedSteps,
    error: failedSteps.length > 0 ? lastError : undefined,
  };
}

/**
 * Create a brand-new user identity with a fresh mnemonic.
 *
 * options.deferSubsidy is the silent first-run provisioning mode: the wallet
 * is generated and stored (fully signable, which is all the relay bootstrap
 * needs) but the MVC gas subsidy is NOT claimed and nothing is published —
 * subsidy_state stays 'pending'. A fresh install that is about to import the
 * user's real identity would otherwise burn one subsidy per reinstall on an
 * identity it discards minutes later. confirmDeferredUserIdentitySetup funds
 * and publishes the identity once the user adopts it. Implies deferChainSync.
 */
export async function createUserIdentity(
  userStore: UserIdentityStore,
  input: { name: string; avatar?: string | null },
  deps: UserIdentityServiceDeps = {},
  options: { deferChainSync?: boolean; deferSubsidy?: boolean } = {},
): Promise<UserIdentityResult> {
  if (userStore.get()) {
    return { success: false, error: 'USER_IDENTITY_EXISTS' };
  }
  const name = (input.name ?? '').trim();
  if (!name) {
    return { success: false, error: 'NAME_EMPTY' };
  }
  const rawAvatar = (input.avatar ?? '').trim() || null;
  const metafileAvatar = normalizeMetafileAvatarReference(rawAvatar);
  const avatar = metafileAvatar ?? rawAvatar;
  if (avatar && !metafileAvatar && !parseDataUrlAvatar(avatar)) {
    return { success: false, error: 'INVALID_AVATAR' };
  }

  const requestSubsidy = deps.requestSubsidy ?? requestMvcGasSubsidy;
  const wallet = await createMetaBotWallet({});

  if (options.deferSubsidy) {
    const identity = userStore.insert({
      mnemonic: wallet.mnemonic,
      path: wallet.path,
      mvc_address: wallet.mvc_address,
      btc_address: wallet.btc_address,
      doge_address: wallet.doge_address,
      public_key: wallet.public_key,
      chat_public_key: wallet.chat_public_key,
      chat_public_key_pin_id: null,
      metaid: wallet.metaid,
      globalmetaid: wallet.globalmetaid,
      name,
      avatar,
      subsidy_state: 'pending',
      subsidy_error: null,
      sync_state: 'pending',
      sync_error: null,
    });
    return {
      success: true,
      identity,
      mnemonic: wallet.mnemonic,
      profileSource: 'local',
    };
  }

  // 1. Claim MVC gas subsidy. When it fails, skip on-chain pins: without gas
  // every pin would fail with "not enough balance" and waste user attempts.
  const subsidy = await requestSubsidySafe(
    requestSubsidy,
    wallet.mvc_address,
    wallet.mnemonic,
    wallet.path,
  );

  const subsidyState: UserSubsidyState = subsidy.success ? 'claimed' : 'failed';
  const identity = userStore.insert({
    mnemonic: wallet.mnemonic,
    path: wallet.path,
    mvc_address: wallet.mvc_address,
    btc_address: wallet.btc_address,
    doge_address: wallet.doge_address,
    public_key: wallet.public_key,
    chat_public_key: wallet.chat_public_key,
    chat_public_key_pin_id: null,
    metaid: wallet.metaid,
    globalmetaid: wallet.globalmetaid,
    name,
    avatar,
    subsidy_state: subsidyState,
    subsidy_error: subsidy.success ? null : (subsidy.error ?? 'Traffic subsidy request failed.'),
    sync_state: subsidy.success ? 'pending' : 'failed',
    sync_error: subsidy.success ? null : 'MVC subsidy must be claimed before syncing to chain.',
  });

  if (!subsidy.success) {
    return {
      success: true,
      identity,
      mnemonic: wallet.mnemonic,
      subsidy,
      profileSource: 'local',
    };
  }

  // deferChainSync (first-run free-quota bootstrap): skip the awaited pin
  // publish so the caller can proceed immediately; sync_state stays 'pending'
  // and the caller drives resumeUserIdentitySetup in the background.
  if (options.deferChainSync) {
    return {
      success: true,
      identity: userStore.get() ?? identity,
      mnemonic: wallet.mnemonic,
      subsidy,
      profileSource: 'local',
    };
  }

  const chainSync = await syncUserIdentityToChain(userStore, { includeProfileSteps: true }, deps);
  return {
    success: true,
    identity: userStore.get() ?? identity,
    mnemonic: wallet.mnemonic,
    subsidy,
    chainSync,
    profileSource: 'local',
  };
}

/**
 * Import a user identity from an existing mnemonic (12 or 24 words, matching
 * Metalet's import algorithm: plain BIP39 validation + identical derivation).
 * When the account already has an on-chain profile, its name/avatar win and
 * are not re-published; the derived chat key must match the on-chain
 * /info/chatpubkey (mismatch means a wrong derivation path). Without an
 * on-chain profile the identity imports with an empty name — the user sets it
 * later from the profile panel (which publishes /info/name).
 */
export async function importUserIdentity(
  userStore: UserIdentityStore,
  input: { mnemonic: string; path?: string },
  deps: UserIdentityServiceDeps = {},
): Promise<UserIdentityResult> {
  if (userStore.get()) {
    return { success: false, error: 'USER_IDENTITY_EXISTS' };
  }
  const mnemonic = (input.mnemonic ?? '').trim().toLowerCase().split(/\s+/).join(' ');
  const words = mnemonic ? mnemonic.split(' ') : [];
  if ((words.length !== 12 && words.length !== 24) || !bip39.validateMnemonic(mnemonic, wordlist)) {
    return { success: false, error: 'INVALID_MNEMONIC' };
  }
  const path = (input.path ?? '').trim() || "m/44'/10001'/0'/0/0";

  const fetchProfile = deps.fetchProfile ?? fetchMetaidRestoreProfile;
  const wallet = await createMetaBotWallet({ mnemonic, path });

  let profile: Awaited<ReturnType<typeof fetchMetaidRestoreProfile>> | null = null;
  try {
    profile = await fetchProfile(wallet.mvc_address);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message !== 'CHAIN_INFO_EMPTY' && message !== 'NAME_EMPTY') {
      return { success: false, error: message };
    }
  }

  let name: string;
  let avatar: string | null;
  let chatPublicKeyPinId: string | null = null;
  let profileSource: 'chain' | 'local';
  if (profile) {
    const onChainChatPubKey = (profile.raw.chatpubkey ?? profile.raw.chatPublicKey ?? '').trim();
    if (onChainChatPubKey && onChainChatPubKey !== wallet.chat_public_key) {
      return { success: false, error: 'CHAT_PUBKEY_MISMATCH' };
    }
    name = profile.name;
    avatar = profile.nftAvatarReference ?? profile.avatarDataUrl ?? null;
    chatPublicKeyPinId = profile.chatpubkeyPinId ?? null;
    profileSource = 'chain';
  } else {
    // No on-chain profile: import with an empty name; the user sets (and
    // publishes) it later from the profile panel.
    name = '';
    avatar = null;
    profileSource = 'local';
  }

  const requestSubsidy = deps.requestSubsidy ?? requestMvcGasSubsidy;
  const subsidy = await requestSubsidySafe(
    requestSubsidy,
    wallet.mvc_address,
    mnemonic,
    path,
  );
  const subsidyState: UserSubsidyState = subsidy.success ? 'claimed' : 'failed';

  const identity = userStore.insert({
    mnemonic,
    path,
    mvc_address: wallet.mvc_address,
    btc_address: wallet.btc_address,
    doge_address: wallet.doge_address,
    public_key: wallet.public_key,
    chat_public_key: wallet.chat_public_key,
    chat_public_key_pin_id: chatPublicKeyPinId,
    metaid: wallet.metaid,
    globalmetaid: wallet.globalmetaid,
    name,
    avatar,
    avatar_fallback: profile?.avatarDataUrl ?? null,
    nft_avatar_pin_id: profile?.nftAvatarPinId ?? null,
    nft_avatar_synced_reference: profile?.nftAvatarReference ?? '',
    subsidy_state: subsidyState,
    subsidy_error: subsidy.success ? null : (subsidy.error ?? 'Traffic subsidy request failed.'),
    sync_state: subsidy.success ? 'pending' : 'failed',
    sync_error: subsidy.success ? null : 'MVC subsidy must be claimed before syncing to chain.',
  });

  // Only sync when the subsidy is available; a chain import with a full
  // on-chain profile needs no pins anyway.
  const needsWrites = buildUserInfoSyncSteps(identity, { includeProfileSteps: false }).length > 0;
  if (!subsidy.success && needsWrites) {
    return { success: true, identity, subsidy, profileSource };
  }

  const chainSync = await syncUserIdentityToChain(
    userStore,
    { includeProfileSteps: profileSource === 'local' },
    deps,
  );
  return { success: true, identity: userStore.get() ?? identity, subsidy, chainSync, profileSource };
}

/** Log out: delete the local identity (on-chain pins stay as-is). */
export function logoutUserIdentity(userStore: UserIdentityStore): boolean {
  return userStore.remove();
}

/** Re-request the MVC gas subsidy for the current identity (retry action). */
export async function retryUserIdentitySubsidy(
  userStore: UserIdentityStore,
  deps: UserIdentityServiceDeps = {},
): Promise<UserIdentityResult> {
  const identity = userStore.get();
  if (!identity) {
    return { success: false, error: 'USER_IDENTITY_MISSING' };
  }
  const requestSubsidy = deps.requestSubsidy ?? requestMvcGasSubsidy;
  const subsidy = await requestSubsidySafe(
    requestSubsidy,
    identity.mvc_address,
    identity.mnemonic,
    identity.path,
  );
  const updated = userStore.update({
    subsidy_state: subsidy.success ? 'claimed' : 'failed',
    subsidy_error: subsidy.success ? null : (subsidy.error ?? 'Traffic subsidy request failed.'),
    sync_state: subsidy.success ? 'pending' : 'failed',
    sync_error: subsidy.success
      ? null
      : 'MVC subsidy must be claimed before syncing to chain.',
  });
  return { success: true, identity: updated ?? identity, subsidy };
}

/**
 * Claim the MVC gas subsidy for the current identity and record the outcome
 * (claimed -> sync pending; failed -> sync failed with an actionable error).
 * Shared by the resume flow and by the deferred-subsidy adoption paths.
 */
async function claimUserIdentitySubsidy(
  userStore: UserIdentityStore,
  identity: UserIdentity,
  deps: UserIdentityServiceDeps,
): Promise<UserSubsidyResult> {
  const requestSubsidy = deps.requestSubsidy ?? requestMvcGasSubsidy;
  const subsidy = await requestSubsidySafe(
    requestSubsidy,
    identity.mvc_address,
    identity.mnemonic,
    identity.path,
  );
  userStore.update({
    subsidy_state: subsidy.success ? 'claimed' : 'failed',
    subsidy_error: subsidy.success ? null : (subsidy.error ?? 'Traffic subsidy request failed.'),
    sync_state: subsidy.success ? 'pending' : 'failed',
    sync_error: subsidy.success
      ? null
      : 'MVC subsidy must be claimed before syncing to chain.',
  });
  return subsidy;
}

/**
 * Resume the bootstrap flow for the current identity: claim the subsidy when
 * it is not claimed yet, then publish every /info pin that is still missing.
 * Idempotent — safe to call repeatedly after failures.
 */
export async function resumeUserIdentitySetup(
  userStore: UserIdentityStore,
  deps: UserIdentityServiceDeps = {},
): Promise<UserIdentityResult> {
  const identity = userStore.get();
  if (!identity) {
    return { success: false, error: 'USER_IDENTITY_MISSING' };
  }

  let subsidy: UserSubsidyResult | undefined;
  if (identity.subsidy_state !== 'claimed') {
    subsidy = await claimUserIdentitySubsidy(userStore, identity, deps);
    if (!subsidy.success) {
      return {
        success: true,
        identity: userStore.get() ?? identity,
        subsidy,
        chainSync: {
          success: false,
          txids: [],
          failedSteps: [],
          error: subsidy.error ?? 'SUBSIDY_NOT_CLAIMED',
        },
      };
    }
    await (deps.sleep ?? defaultSleep)(USER_PIN_STEP_INTERVAL_MS);
  }

  const chainSync = await syncUserIdentityToChain(
    userStore,
    { includeProfileSteps: true },
    deps,
  );
  return {
    success: true,
    identity: userStore.get() ?? identity,
    subsidy,
    chainSync,
  };
}

/**
 * Fund and publish a silently provisioned identity once the user has adopted
 * it (created a MetaBot on it, backed up its mnemonic, asked for a chain
 * backup, or kept using an install that already holds their bots). Resolves
 * null when there is nothing to do — no identity, or its subsidy was already
 * claimed/failed through the regular paths — so callers can fire it from any
 * adoption signal without checking state first. A failure leaves the identity
 * 'failed' with the usual retry affordances in Settings.
 */
export async function confirmDeferredUserIdentitySetup(
  userStore: UserIdentityStore,
  deps: UserIdentityServiceDeps = {},
): Promise<UserIdentityResult | null> {
  const identity = userStore.get();
  if (!identity || identity.subsidy_state !== 'pending') {
    return null;
  }
  return resumeUserIdentitySetup(userStore, deps);
}

/**
 * Set/rename the user's name and publish it as /info/name (Bot Info
 * semantics: latest pin wins). The pin is published FIRST; the local record
 * is updated only on success, so local state never claims an unpublished
 * name.
 */
export async function updateUserIdentityName(
  userStore: UserIdentityStore,
  input: { name: string },
  deps: UserIdentityServiceDeps = {},
): Promise<UserIdentityResult> {
  const identity = userStore.get();
  if (!identity) {
    return { success: false, error: 'USER_IDENTITY_MISSING' };
  }
  const name = (input.name ?? '').trim();
  if (!name) {
    return { success: false, error: 'NAME_EMPTY' };
  }
  if (name === identity.name) {
    return { success: true, identity, profileSource: 'local' };
  }
  // Renaming publishes a pin, so it needs gas. Surface a clear, actionable
  // error instead of a raw "Not enough balance" from the chain worker.
  // Legacy identities without a recorded subsidy state and without any pinned
  // chat key are also treated as unclaimed (their setup never completed).
  if (
    identity.subsidy_state === 'failed' ||
    (!identity.subsidy_state && !identity.chat_public_key_pin_id)
  ) {
    return { success: false, error: 'SUBSIDY_NOT_CLAIMED' };
  }
  // A silently provisioned identity (deferred subsidy) adopted through its
  // first rename: fund it and publish the base pins now, but let the NEW name
  // be its first /info/name instead of the placeholder. The pause mirrors the
  // inter-pin interval of the sync flow so the name pin does not race the
  // chat-key pin for the same funding UTXO.
  if (identity.subsidy_state === 'pending') {
    const subsidy = await claimUserIdentitySubsidy(userStore, identity, deps);
    if (!subsidy.success) {
      return { success: false, error: 'SUBSIDY_NOT_CLAIMED' };
    }
    await (deps.sleep ?? defaultSleep)(USER_PIN_STEP_INTERVAL_MS);
    const baseSync = await syncUserIdentityToChain(userStore, { includeProfileSteps: false }, deps);
    if (baseSync.txids.length > 0) {
      await (deps.sleep ?? defaultSleep)(USER_PIN_STEP_INTERVAL_MS);
    }
  }

  const createPin = deps.createPin ?? createPinForIdentity;
  let result: Awaited<ReturnType<typeof createPinForIdentity>>;
  try {
    result = await createPin({
      mnemonic: identity.mnemonic,
      path: identity.path,
      metaidData: {
        operation: 'create',
        path: '/info/name',
        contentType: 'text/plain',
        payload: name,
      },
      options: { feeRate: getGlobalFeeRate('mvc') },
    });
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (!result.txids[0]) {
    return { success: false, error: 'name pin failed: no txid' };
  }

  // When the chat-key pin is still missing (a deferred identity whose base
  // sync just failed), stay 'partial' so Settings keeps the retry path.
  const chatKeyPinned = Boolean(userStore.get()?.chat_public_key_pin_id);
  const updated = userStore.update({
    name,
    name_pin_id: result.pinId ?? `${result.txids[0]}i0`,
    sync_state: chatKeyPinned ? 'synced' : 'partial',
    sync_error: null,
  });
  return {
    success: true,
    identity: updated ?? undefined,
    chainSync: {
      success: true,
      txids: result.txids,
      namePinId: result.pinId ?? `${result.txids[0]}i0`,
      failedSteps: [],
    },
    profileSource: 'local',
  };
}

/** Set a plain or wallet-owned NFT avatar, or clear both avatar declarations. */
export async function updateUserIdentityAvatar(
  userStore: UserIdentityStore,
  input: { avatar: string | null },
  deps: UserIdentityServiceDeps = {},
): Promise<UserIdentityResult> {
  const identity = userStore.get();
  if (!identity) return { success: false, error: 'USER_IDENTITY_MISSING' };
  const avatar = typeof input?.avatar === 'string' ? input.avatar.trim() : '';
  const nftReference = parseNftAvatarReference(avatar);
  const metafileReference = !nftReference ? normalizeMetafileAvatarReference(avatar) : null;
  let stagedAvatar = avatar;
  let avatarFallback: string | null = null;

  if (nftReference) {
    try {
      const prepared = await (deps.prepareNftAvatar ?? prepareNftAvatarForIdentity)({
        reference: avatar,
        ownerAddress: identity.mvc_address,
        globalMetaId: identity.globalmetaid,
      });
      stagedAvatar = prepared.reference;
      avatarFallback = prepared.avatarUrl;
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  } else if (metafileReference) {
    stagedAvatar = metafileReference;
  } else if (avatar && !parseDataUrlAvatar(avatar)) {
    return { success: false, error: 'INVALID_AVATAR' };
  }

  const declarationAlreadySynced = (identity.nft_avatar_synced_reference ?? '') === (nftReference ? stagedAvatar : '');
  if (
    stagedAvatar === (identity.avatar ?? '')
    && identity.avatar_pin_id
    && declarationAlreadySynced
  ) {
    return { success: true, identity, profileSource: 'local' };
  }
  if (!stagedAvatar && !identity.avatar && !identity.avatar_pin_id && !identity.nft_avatar_synced_reference) {
    return { success: true, identity, profileSource: 'local' };
  }

  if (stagedAvatar) {
    if (identity.subsidy_state === 'failed' || (!identity.subsidy_state && !identity.chat_public_key_pin_id)) {
      return { success: false, error: 'SUBSIDY_NOT_CLAIMED' };
    }
    if (identity.subsidy_state === 'pending') {
      const subsidy = await claimUserIdentitySubsidy(userStore, identity, deps);
      if (!subsidy.success) return { success: false, error: 'SUBSIDY_NOT_CLAIMED' };
    }
  }

  userStore.update({
    avatar: stagedAvatar || null,
    avatar_fallback: avatarFallback,
    avatar_pin_id: null,
  });
  const chainSync = await syncUserIdentityToChain(
    userStore,
    { includeProfileSteps: true, forceAvatarClear: !stagedAvatar },
    deps,
  );
  return {
    success: true,
    identity: userStore.get() ?? identity,
    chainSync,
    profileSource: 'local',
  };
}
