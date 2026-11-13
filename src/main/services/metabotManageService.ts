/**
 * Shared MetaBot management orchestration.
 *
 * These pure, deps-injected functions hold the create / update / delete / list
 * logic that used to live inline inside main.ts IPC handlers. Both the IPC
 * handlers (the manual UI path) and the Twin-only builtin tools
 * (libs/metabotManageAgentTools.ts) call them, so a bot created or edited by
 * the Twin runs through the EXACT same code as one created/edited by hand —
 * including wallet generation, gas subsidy, on-chain pin publishing and
 * rollback. Keeping the deps injected keeps this unit-testable from compiled
 * output without touching the network or SQLite.
 */

import type { MetabotStore } from '../metabotStore';
import type { Metabot } from '../types/metabot';
import { getMetabotLimitError } from '../shared/metabotLimit';
import { normalizeMetabotLlmId } from './llmFallback';
import { stripLoneSurrogates, truncateUtf16Units } from '../libs/llmSafeText';
import { toLlmEffortLevel } from '../libs/llmEffort';
import { parseNftAvatarReference, prepareNftAvatarForIdentity } from './nftAvatarService';

// ---------------------------------------------------------------------------
// Input shapes (mirror the IPC handler payloads; local to avoid cross-module coupling)
// ---------------------------------------------------------------------------

export interface CreateMetaBotOnChainInput {
  name: string;
  avatar?: string | null;
  role?: string;
  soul?: string;
  goal?: string | null;
  bio?: string | null;
  /** Deprecated compatibility input; use bio. */
  background?: string | null;
  boss_id?: number | null;
  boss_global_metaid?: string | null;
  llm_id?: string | null;
  /** Provider key the brain model was picked from (id-collision disambiguation). */
  llm_provider?: string | null;
  /** Reasoning effort for the primary brain (off/low/high/max); null = model default. */
  llm_effort?: string | null;
  /** Optional fallback brain (model id or legacy provider key; never required). */
  fallback_llm_id?: string | null;
  fallback_llm_provider?: string | null;
  fallback_llm_effort?: string | null;
  allow_chat_skills?: string[];
  metabot_type?: 'twin' | 'worker';
  homepage?: string | null;
}

export interface UpdateMetaBotInput {
  name?: string;
  avatar?: string | null;
  avatar_fallback?: string | null;
  nft_avatar_pin_id?: string | null;
  nft_avatar_synced_reference?: string | null;
  enabled?: boolean;
  metabot_type?: 'twin' | 'worker';
  role?: string;
  soul?: string;
  goal?: string | null;
  bio?: string | null;
  /** Deprecated compatibility input; use bio. */
  background?: string | null;
  boss_id?: number | null;
  boss_global_metaid?: string | null;
  llm_id?: string | null;
  llm_provider?: string | null;
  llm_effort?: string | null;
  fallback_llm_id?: string | null;
  fallback_llm_provider?: string | null;
  fallback_llm_effort?: string | null;
  allow_chat_skills?: string[];
  a2a_max_incoming_turns?: number | null;
  a2a_bye_cooldown_ms?: number | null;
  a2a_auto_reply_enabled?: boolean | null;
  homepage?: string | null;
}

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

/** Fields produced by createMetaBotWallet() that the core needs. */
export interface MetabotWalletCreation {
  mnemonic: string;
  path: string;
  mvc_address: string;
  btc_address: string;
  doge_address: string;
  public_key: string;
  chat_public_key: string;
  metaid: string;
  globalmetaid: string;
}

export interface OwnerBindingSignResult {
  payload?: string;
  error?: string;
}

/** Minimal subset of SyncMetaBotResult / SyncMetaBotEditChangesResult that we consume. */
export interface ChainSyncResult {
  success: boolean;
  canSkip?: boolean;
  error?: string;
  txids?: string[];
  syncedSteps?: string[];
  /** Step keys the full sync planned to publish (create-path partial reporting). */
  plannedSteps?: string[];
}

/** On-chain edit sync input (mirrors SyncMetaBotEditChangesInput). */
export interface EditSyncInput {
  metabotId: number;
  syncName?: boolean;
  syncAvatar?: boolean;
  syncNftAvatar?: boolean;
  syncBio?: boolean;
  syncPersona?: boolean;
  syncLlm?: boolean;
  syncChatSkills?: boolean;
  syncHomepage?: boolean;
  /** Publish an /info/owner pin: signed binding payload, or '' to unbind. */
  syncOwner?: boolean;
  ownerBindingPayload?: string | null;
}

export interface MetabotManageDeps {
  store: MetabotStore;
  /** Generate a fresh in-memory MetaBot wallet (mnemonic + addresses + keys + metaid). */
  createWallet: () => Promise<MetabotWalletCreation>;
  /** Best-effort MVC gas subsidy for a brand-new bot wallet. */
  requestSubsidy: (p: { mvcAddress: string; mnemonic: string; path: string }) => Promise<{ success: boolean; error?: string }>;
  /** Sign an /info/owner binding against the local user identity. */
  signOwnerBinding: (bossGlobalMetaId: string, botGlobalMetaId: string | null | undefined) => Promise<OwnerBindingSignResult>;
  /** Full sync used at creation time (name/avatar/chatpubkey/bio/[owner]). */
  syncToChain: (
    store: MetabotStore,
    metabotId: number,
    options: { ownerBindingPayload?: string | null },
  ) => Promise<ChainSyncResult>;
  /** Edit-sync used on updates; publishes only the changed info pins. */
  syncEditChanges: (store: MetabotStore, input: EditSyncInput) => Promise<ChainSyncResult>;
  prepareNftAvatar?: typeof prepareNftAvatarForIdentity;
  /** Refresh P2P runtime config after a create/delete (best-effort). */
  onAfterMutation?: () => Promise<void> | void;
  /** Optional post-delete hook receiving the deleted bot (e.g. cleanup side-effects). */
  onAfterDelete?: (deletedMetabot: Metabot) => Promise<void> | void;
  /** Active owner GlobalMetaID; used for the owner-binding identity check. */
  getOwnerGlobalMetaId?: () => string | null;
  /**
   * Read the configured LLM providers (app_config.providers) for the legacy
   * provider-key write guard. When absent/unreadable the guard is skipped
   * rather than blocking the write.
   */
  getLlmProviders?: () => Record<string, {
    enabled?: boolean;
    models?: Array<{ id?: string }>;
  } | undefined> | undefined;
  /**
   * Read the spendable (confirmed + unconfirmed) MVC balance in satoshis for
   * an address. Used by resumeMetabotSetupCore's self-funded mode to tell
   * "user has not funded the bot address yet" from "chain attempt worth
   * making" — MVC subsidy funds stay unconfirmed forever, so the sum is the
   * only honest spendable figure.
   */
  readSpendableBalance?: (mvcAddress: string) => Promise<number>;
  /**
   * Skill-assignment write seam (wired to SkillManager.applyMetabotAssignedSkills).
   * Called whenever an update carries allow_chat_skills / chat_skill_op — the
   * on-chain published whitelist stays the metabots.allow_chat_skills column,
   * but the local authorization source of truth is the assignment table, so
   * every whitelist write must also replace that bot's assignment rows.
   * Absent = assignment write skipped (bare-embedding callers).
   */
  applyChatSkillAssignments?: (metabotId: number, skillIdsOrNames: readonly string[]) => string[];
  /**
   * Read seam for the removal diff (wired to listAssignedSkillIds). When an
   * update replaces a bot's skill whitelist, the core reports which
   * previously assigned skills were dropped so the change is never silent.
   */
  listChatSkillAssignments?: (metabotId: number) => string[];
}

// ---------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------

export interface CreateMetaBotOnChainResult {
  success: boolean;
  metabot?: Metabot;
  subsidy?: { success: boolean; error?: string };
  chainPartial?: boolean;
  chainError?: string;
  /**
   * Nothing landed on-chain at creation (the mandatory name step failed —
   * typically an unfunded wallet because the subsidy service was down). The
   * bot exists locally with a full chainSyncPending plan; the UI offers
   * resumeMetabotSetup (retry subsidy / self-funded broadcast).
   */
  chainSetupPending?: boolean;
  error?: string;
}

export interface UpdateMetaBotLocalResult {
  success: boolean;
  metabot?: Metabot;
  error?: string;
}

export interface UpdateMetaBotResult {
  success: boolean;
  metabot?: Metabot;
  /**
   * Skill ids this update un-assigned from the bot (whitelist replace only) —
   * surfaced so a replace that silently drops previously assigned skills is
   * visible to the caller (and the owner) instead of going unnoticed.
   */
  removedChatSkills?: string[];
  /** On-chain sync outcome (absent when there was nothing to publish). */
  sync?: {
    skipped: boolean;
    success: boolean;
    canSkip?: boolean;
    error?: string;
    txids?: string[];
    syncedSteps?: string[];
    /** Steps this update tried to publish (for the modal's checkmark display). */
    attemptedStepKeys?: SyncStepKey[];
    /**
     * Steps still unpublished after the core's auto-retry. The renderer's manual
     * Retry button forwards this to idbots:syncMetaBotEditChanges so re-sync only
     * republishes what is left (on-chain pins are NOT idempotent).
     */
    remainingSyncInput?: EditSyncInput;
  };
  error?: string;
}

export interface DeleteMetaBotResult {
  success: boolean;
  error?: string;
}

export interface ManagedMetabotSummary {
  id: number;
  name: string;
  type: 'twin' | 'worker' | 'welcome';
  enabled: boolean;
  llm_id: string | null;
  llm_effort: string | null;
  fallback_llm_id: string | null;
  fallback_llm_effort: string | null;
  role: string;
  soul: string;
  goal: string | null;
  bio: string | null;
  allow_chat_skills: string[];
  a2a_max_incoming_turns: number | null;
  a2a_bye_cooldown_ms: number | null;
  a2a_auto_reply_enabled: boolean | null;
  globalMetaID: string | null;
}

export interface LlmProviderOption {
  id: string;
  label: string;
  /** Models this provider offers (model-level brains pick from these). */
  models?: Array<{ id: string; name: string }>;
}

// ---------------------------------------------------------------------------
// Small shared helpers (also reused by main.ts)
// ---------------------------------------------------------------------------

/** Validate + normalize the required primary LLM brain value for creation. */
export function requireMetabotLlmIdForCreate(value: unknown): string {
  const llmId = typeof value === 'string' ? value.trim() : '';
  if (!llmId) {
    throw new Error('LLM Brain is required when creating a MetaBot');
  }
  return llmId;
}

/**
 * Write-time guard against re-introducing legacy-shaped brain values:
 * `llm_id` / `fallback_llm_id` hold a MODEL id; a value equal to a provider
 * KEY (e.g. 'opencode') is the pre-migration legacy shape and silently
 * misresolves. Returns an actionable error message, or null when the value is
 * acceptable — including when the provider catalog is unavailable (the guard
 * never blocks a write it cannot judge) or when the value is a genuine model
 * id that happens to equal a provider key.
 */
export function legacyLlmProviderKeyError(
  field: 'llm_id' | 'fallback_llm_id',
  value: unknown,
  providers: Record<string, { enabled?: boolean; models?: Array<{ id?: string }> } | undefined> | undefined,
): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed || !providers) return null;
  for (const provider of Object.values(providers)) {
    if (provider?.models?.some((model) => model?.id === trimmed)) return null;
  }
  const needle = trimmed.toLowerCase();
  for (const [key, provider] of Object.entries(providers)) {
    if (key.toLowerCase() !== needle) continue;
    const providerField = field === 'llm_id' ? 'llm_provider' : 'fallback_llm_provider';
    const firstModel = provider?.models?.find((model) => typeof model?.id === 'string' && model.id)?.id;
    const example = firstModel ? ` (e.g. '${firstModel}')` : '';
    return `${field} '${trimmed}' is a provider id; pass a MODEL id${example} with ${providerField}='${key}'`;
  }
  return null;
}

/**
 * Normalize a brain reasoning-effort value for storage onto the app-wide
 * off/low/high/max ladder (see llmEffort.ts); null/unknown means "model default".
 */
export function normalizeMetabotLlmEffort(value: unknown): string | null {
  return toLlmEffortLevel(value);
}

/** Throw the limit-reached error when the machine already holds the max bot count. */
export function assertCanCreateMetabot(store: MetabotStore): void {
  const error = getMetabotLimitError(store.listMetabots().length);
  if (error) {
    throw new Error(error);
  }
}

const MAX_TEXT_LENGTH = 4_000;

function boundText(value: string | null | undefined, maxLength = MAX_TEXT_LENGTH): string {
  const text = stripLoneSurrogates(String(value ?? '').trim());
  if (!text) return '';
  return text.length <= maxLength ? text : `${truncateUtf16Units(text, maxLength - 1)}…`;
}

function normalizedList(values: string[] | null | undefined): string[] {
  return Array.from(new Set((values ?? []).map((value) => String(value).trim()).filter(Boolean)));
}

/** Incremental add/remove against a chat-skill whitelist. Other items are preserved. */
export function applyChatSkillOp(
  current: string[] | null | undefined,
  op: { action: 'add' | 'remove'; skill: string },
): string[] {
  const skill = String(op.skill ?? '').trim();
  const list = normalizedList(current);
  if (!skill) return list;
  if (op.action === 'add') {
    return list.includes(skill) ? list : [...list, skill];
  }
  return list.filter((item) => item !== skill);
}

// ---------------------------------------------------------------------------
// Chain-sync pending state (partial-publish persistence, FR4)
// ---------------------------------------------------------------------------

/**
 * metabot_settings key holding the on-chain steps that were planned but never
 * confirmed (create partial / edit partial). An empty/absent step list means
 * "nothing pending" — the value is written as `{"remainingSteps":[],...}` on
 * completion so the row doubles as a "cleared" marker without needing a
 * settings-delete path.
 */
const CHAIN_SYNC_PENDING_KEY = 'chainSyncPending';

/**
 * Fallback planned-step list when a failing sync implementation reports no
 * plan (minimal creation publishes name + chatpubkey + llm; empty profile
 * steps are skipped by buildFullMetabotInfoSyncPlan). The real
 * syncMetaBotToChain reports plannedSteps on every failure path; this only
 * covers third-party syncToChain deps (and the unit-test mocks).
 */
const DEFAULT_CREATE_PLANNED_STEPS = ['name', 'chatpubkey', 'llm'];

export interface ChainSyncPending {
  /** Step keys still unpublished (subset of the sync step vocabulary). */
  remainingSteps: string[];
  error?: string;
  updatedAt: number;
}

/** Read the persisted pending plan; null when absent or already empty. */
export function readChainSyncPending(store: MetabotStore, metabotId: number): ChainSyncPending | null {
  try {
    const raw = store.getMetabotSetting(metabotId, CHAIN_SYNC_PENDING_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ChainSyncPending>;
    const remainingSteps = Array.isArray(parsed.remainingSteps)
      ? parsed.remainingSteps.map((s) => String(s)).filter(Boolean)
      : [];
    if (remainingSteps.length === 0) return null;
    return {
      remainingSteps,
      error: typeof parsed.error === 'string' ? parsed.error : undefined,
      updatedAt: Number(parsed.updatedAt) || 0,
    };
  } catch {
    return null;
  }
}

/** Persist (or clear, when steps are empty) the pending sync plan. Best-effort. */
function writeChainSyncPending(
  store: MetabotStore,
  metabotId: number,
  pending: { remainingSteps: string[]; error?: string } | null,
): void {
  try {
    store.setMetabotSetting(
      metabotId,
      CHAIN_SYNC_PENDING_KEY,
      JSON.stringify({
        remainingSteps: pending?.remainingSteps ?? [],
        error: pending?.error,
        updatedAt: Date.now(),
      }),
    );
  } catch (error) {
    console.warn(
      `[metabotManage] failed to persist chainSyncPending for metabot ${metabotId}:`,
      error instanceof Error ? error.message : String(error),
    );
  }
}

export interface MetabotChainSyncStateView {
  state: 'synced' | 'partial';
  /** Steps still unpublished (empty for synced, and for partials created before this tracking existed). */
  pendingSteps: string[];
}

/**
 * Derive the bot's chain-sync state for the UI. Never reports synced without a
 * pin on record: a pending plan wins, then metabot_info_pinid (a confirmed
 * profile pin) — anything else is partial, matching the legacy
 * isChainSynced badge fallback.
 */
export function deriveChainSyncState(
  metabot: Pick<Metabot, 'metabot_info_pinid' | 'globalmetaid'>,
  pending: ChainSyncPending | null,
): MetabotChainSyncStateView {
  if (pending && pending.remainingSteps.length > 0) {
    return { state: 'partial', pendingSteps: pending.remainingSteps };
  }
  if (metabot.metabot_info_pinid && metabot.metabot_info_pinid.trim()) {
    return { state: 'synced', pendingSteps: [] };
  }
  return { state: 'partial', pendingSteps: [] };
}

/**
 * Persist the pending plan from a FULL sync outcome (create path and the
 * manual idbots:syncMetaBot resync path): everything planned-but-unconfirmed
 * becomes the bot's pending steps; a fully confirmed sync clears the plan.
 */
export function recordFullSyncOutcome(
  store: MetabotStore,
  metabotId: number,
  outcome: { plannedSteps?: string[]; syncedSteps?: string[]; error?: string },
): void {
  const planned = outcome.plannedSteps ?? [];
  const synced = new Set(outcome.syncedSteps ?? []);
  const remainingSteps = planned.filter((step) => !synced.has(step));
  writeChainSyncPending(
    store,
    metabotId,
    remainingSteps.length > 0 ? { remainingSteps, error: outcome.error } : null,
  );
}

/** Convenience wrapper: read persisted pending + derive in one call. */
export function getMetabotChainSyncState(
  store: MetabotStore,
  metabot: Pick<Metabot, 'id' | 'metabot_info_pinid' | 'globalmetaid'>,
): MetabotChainSyncStateView {
  return deriveChainSyncState(metabot, readChainSyncPending(store, metabot.id));
}

/**
 * Fold a re-sync's confirmed steps into the persisted pending plan (a retry
 * only republishes what is left — on-chain pins are NOT idempotent). Called
 * from the sync IPC handlers after every edit-changes sync attempt.
 */
export function applyChainSyncProgress(store: MetabotStore, metabotId: number, syncedSteps: string[]): void {
  const pending = readChainSyncPending(store, metabotId);
  if (!pending) return;
  const synced = new Set(syncedSteps);
  const remainingSteps = pending.remainingSteps.filter((step) => !synced.has(step));
  if (remainingSteps.length === pending.remainingSteps.length) return;
  writeChainSyncPending(
    store,
    metabotId,
    remainingSteps.length > 0 ? { remainingSteps, error: pending.error } : null,
  );
}

// ---------------------------------------------------------------------------
// Subsidy state (create-fallback persistence)
// ---------------------------------------------------------------------------

/**
 * metabot_settings key recording whether the gas subsidy for this bot's wallet
 * was claimed. Absent = legacy/unknown (created before this tracking, or the
 * subsidy succeeded and nobody looked back) — the UI treats it as "no banner".
 * Mirrors user_identity.subsidy_state semantics for bots.
 */
const SUBSIDY_STATE_KEY = 'subsidyState';

export type MetabotSubsidyStateLiteral = 'claimed' | 'failed';

export interface MetabotSubsidyStateView {
  state: 'unknown' | MetabotSubsidyStateLiteral;
  error?: string;
}

/** Read the persisted subsidy state; 'unknown' when never recorded. */
export function readMetabotSubsidyState(store: MetabotStore, metabotId: number): MetabotSubsidyStateView {
  try {
    const raw = store.getMetabotSetting(metabotId, SUBSIDY_STATE_KEY);
    if (!raw) return { state: 'unknown' };
    const parsed = JSON.parse(raw) as { state?: unknown; error?: unknown };
    if (parsed.state !== 'claimed' && parsed.state !== 'failed') return { state: 'unknown' };
    return {
      state: parsed.state,
      error: typeof parsed.error === 'string' && parsed.error ? parsed.error : undefined,
    };
  } catch {
    return { state: 'unknown' };
  }
}

/** Persist the subsidy outcome for a bot. Best-effort. */
function writeMetabotSubsidyState(
  store: MetabotStore,
  metabotId: number,
  subsidy: { success: boolean; error?: string },
): void {
  try {
    store.setMetabotSetting(
      metabotId,
      SUBSIDY_STATE_KEY,
      JSON.stringify({
        state: subsidy.success ? 'claimed' : 'failed',
        error: subsidy.success ? undefined : (subsidy.error ?? 'Traffic subsidy request failed.'),
        updatedAt: Date.now(),
      }),
    );
  } catch (error) {
    console.warn(
      `[metabotManage] failed to persist subsidyState for metabot ${metabotId}:`,
      error instanceof Error ? error.message : String(error),
    );
  }
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

/**
 * Create a MetaBot end-to-end: wallet → gas subsidy → DB insert → on-chain
 * publish → P2P refresh. Behavior-preserving lift of the original
 * idbots:createMetaBotOnChain IPC handler, except that a mandatory step (name)
 * failure NO LONGER rolls back the DB records: the bot was already created
 * locally (wallet + row + assignment/binding state) and the subsidy may even
 * have been paid to its address, so deleting it only strands funds and leaves
 * the user with nothing (the 2026-09 "subsidy outage = no bots at all" gap).
 * Instead the unpublished steps are persisted as the bot's chainSyncPending
 * plan and the result reports chainSetupPending so the UI can offer
 * retry-subsidy / self-funded-broadcast (resumeMetabotSetupCore).
 *
 * Rollback is kept ONLY for deterministic pre-chain local failures
 * (assignment seeding, owner-binding signature) — a data fork at creation
 * never self-heals, while a chain outage is exactly the recoverable case.
 *
 * No app-level balance pre-gate: an unfunded wallet is stopped by the chain
 * itself when the publish broadcast fails. A local gate re-derived that
 * judgment from explorer balance data and misread MVC's permanently-0-conf
 * subsidy funds as "no money" (the 2026-09 v0.6.1 creation outage), so it was
 * removed rather than fixed.
 */
export async function createMetaBotOnChainCore(
  input: CreateMetaBotOnChainInput,
  deps: MetabotManageDeps,
): Promise<CreateMetaBotOnChainResult> {
  const { store, createWallet, requestSubsidy, signOwnerBinding, syncToChain, onAfterMutation } = deps;
  let metabotId: number | null = null;
  try {
    assertCanCreateMetabot(store);
    // Pre-create name check: metabots.name is UNIQUE — surface a clear error
    // up front instead of a raw constraint violation after wallet generation.
    const wantedName = String(input.name ?? '').trim();
    const nameConflict = wantedName
      ? store.listMetabots().find((m) => m.name.trim() === wantedName)
      : undefined;
    if (nameConflict) {
      return {
        success: false,
        error: `NAME_ALREADY_EXISTS: a MetaBot named "${wantedName}" already exists (id=${nameConflict.id}). Pick another name.`,
      };
    }
    const llmId = requireMetabotLlmIdForCreate(input.llm_id);
    const fallbackLlmId = normalizeMetabotLlmId(input.fallback_llm_id);
    // Reject legacy provider-key-shaped brain values (see legacyLlmProviderKeyError).
    const providers = deps.getLlmProviders?.();
    const primaryKeyError = legacyLlmProviderKeyError('llm_id', llmId, providers);
    if (primaryKeyError) throw new Error(primaryKeyError);
    const fallbackKeyError = legacyLlmProviderKeyError('fallback_llm_id', fallbackLlmId, providers);
    if (fallbackKeyError) throw new Error(fallbackKeyError);

    // 1. Generate wallet (in-memory)
    const walletResult = await createWallet();
    const metabotType = input.metabot_type === 'twin' ? 'twin' : 'worker';

    // 2. Request gas subsidy (best-effort; don't fail creation if subsidy fails)
    let subsidyResult: { success: boolean; error?: string } = { success: false };
    try {
      subsidyResult = await requestSubsidy({
        mvcAddress: walletResult.mvc_address,
        mnemonic: walletResult.mnemonic,
        path: walletResult.path,
      });
    } catch (e) {
      subsidyResult = { success: false, error: e instanceof Error ? e.message : String(e) };
    }

    // 3. Insert wallet + metabot into DB (syncMetaBotToChain reads from DB)
    const wallet = store.insertMetabotWallet({
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
      chat_public_key_pin_id: null,
      name: input.name,
      avatar: input.avatar ?? null,
      enabled: true,
      metaid: walletResult.metaid,
      globalmetaid: walletResult.globalmetaid,
      metabot_info_pinid: null,
      metabot_type: metabotType,
      created_by: '0000',
      // Minimal creation may omit persona fields; store empty strings and let
      // the sync plan skip the empty persona/bio pins.
      role: (input.role ?? '').trim(),
      soul: (input.soul ?? '').trim(),
      goal: input.goal ?? null,
      bio: input.bio !== undefined ? input.bio : (input.background ?? null),
      boss_id: null,
      boss_global_metaid: (input.boss_global_metaid ?? '').trim() || null,
      llm_id: llmId,
      llm_provider: normalizeMetabotLlmId(input.llm_provider),
      llm_effort: normalizeMetabotLlmEffort(input.llm_effort),
      fallback_llm_id: fallbackLlmId,
      fallback_llm_provider: normalizeMetabotLlmId(input.fallback_llm_provider),
      fallback_llm_effort: normalizeMetabotLlmEffort(input.fallback_llm_effort),
      tools: [],
      skills: [],
      allow_chat_skills: input.allow_chat_skills ?? [],
      homepage: input.homepage ?? null,
    });
    metabotId = metabot.id;

    // Persist the subsidy outcome next to the bot so the UI (and the resume
    // entry) can tell "subsidy service down" from "chain write failed" later,
    // across restarts.
    writeMetabotSubsidyState(store, metabot.id, subsidyResult);

    // Assignment-model backfill: a creation input carrying allow_chat_skills
    // (on-chain projection) must also seed the assignment rows (the local
    // authorization source of truth). Fail-closed with the same rollback the
    // other hard steps use — a column/row fork at creation never self-heals.
    if (
      input.allow_chat_skills !== undefined
      && normalizedList(input.allow_chat_skills).length > 0
      && deps.applyChatSkillAssignments
    ) {
      try {
        deps.applyChatSkillAssignments(metabot.id, normalizedList(input.allow_chat_skills));
      } catch (error) {
        store.deleteMetabot(metabot.id);
        return {
          success: false,
          error: `Chat-skill assignment seeding failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }

    // 4. Sign the owner binding when a boss GlobalMetaID was requested; it
    // must belong to the local user identity (signed consent).
    let ownerBindingPayload: string | undefined;
    const bossGlobalMetaId = (input.boss_global_metaid ?? '').trim();
    if (bossGlobalMetaId) {
      const signResult = await signOwnerBinding(bossGlobalMetaId, metabot.globalmetaid);
      if (signResult.error) {
        store.deleteMetabot(metabot.id);
        return { success: false, error: signResult.error };
      }
      ownerBindingPayload = signResult.payload;
    }

    // 5. Publish to chain (name + avatar + chatpubkey + bio [+ owner])
    const syncResult = await syncToChain(store, metabot.id, { ownerBindingPayload });

    if (!syncResult.success && !syncResult.canSkip) {
      // Mandatory step (name) failed — typically an unfunded wallet (subsidy
      // service down / network outage). KEEP the bot locally: the wallet row
      // is append-only anyway (a rollback would strand any subsidy already
      // paid to the address), and the user must be able to retry the subsidy
      // or fund the address and self-broadcast later. Persist the full plan
      // so the partial badge + resume entry have something durable to work
      // from; the chain itself remains the source of truth via the missing
      // metabot_info_pinid.
      console.warn(
        `[metabotManage] createMetaBotOnChainCore: mandatory chain step failed for metabot ${metabot.id}; keeping local bot, setup pending:`,
        syncResult.error,
      );
      recordFullSyncOutcome(store, metabot.id, {
        plannedSteps: syncResult.plannedSteps ?? DEFAULT_CREATE_PLANNED_STEPS,
        syncedSteps: syncResult.syncedSteps ?? [],
        error: syncResult.error,
      });
      const keptMetabot = store.getMetabotById(metabot.id) ?? metabot;
      await onAfterMutation?.();
      return {
        success: true,
        metabot: keptMetabot,
        subsidy: subsidyResult,
        chainSetupPending: true,
        chainError: syncResult.error ?? 'Chain publish failed',
      };
    }

    // 5b. Chain succeeded (or partial with canSkip) — persist what (if
    // anything) is still unpublished so the My Bots partial badge and the
    // re-sync entry have a durable, chain-honest plan to work from.
    if (metabot.id) {
      recordFullSyncOutcome(store, metabot.id, {
        plannedSteps: syncResult.plannedSteps,
        syncedSteps: syncResult.syncedSteps,
        error: syncResult.error,
      });
    }
    const updatedMetabot = store.getMetabotById(metabot.id) ?? metabot;
    await onAfterMutation?.();
    return {
      success: true,
      metabot: updatedMetabot,
      subsidy: subsidyResult,
      chainPartial: !syncResult.success && syncResult.canSkip,
      chainError: syncResult.canSkip ? syncResult.error : undefined,
    };
  } catch (error) {
    // Roll back DB records on unexpected error
    if (metabotId != null) {
      try {
        store.deleteMetabot(metabotId);
      } catch {
        /* ignore */
      }
    }
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error('[metabotManage] createMetaBotOnChainCore failed:', errMsg);
    return { success: false, error: errMsg };
  }
}

// ---------------------------------------------------------------------------
// Resume setup (create fallback: retry subsidy / self-funded broadcast)
// ---------------------------------------------------------------------------

export interface ResumeMetabotSetupInput {
  metabotId: number;
  /**
   * 'subsidized' — re-request the gas subsidy, then (when claimed) publish
   * the missing pins. 'self-funded' — skip the subsidy entirely and publish
   * with the bot's own address funds (the user transferred MVC manually).
   */
  mode: 'subsidized' | 'self-funded';
}

export interface ResumeMetabotSetupResult {
  /** True only when the chain sync fully landed (or was already complete). */
  success: boolean;
  metabot?: Metabot;
  mode: ResumeMetabotSetupInput['mode'];
  /** Present when the subsidy was (re-)requested during this call. */
  subsidy?: { success: boolean; error?: string };
  /** Self-funded mode only: the address holds nothing to spend yet. */
  selfFundedBlocked?: { reason: 'no_balance'; mvcAddress: string; spendableSatoshis: number };
  chain?: {
    success: boolean;
    canSkip?: boolean;
    error?: string;
    txids?: string[];
    plannedSteps?: string[];
    syncedSteps?: string[];
  };
  /** The bot was already fully synced — nothing was attempted. */
  alreadySynced?: boolean;
  error?: string;
}

/**
 * Resume a locally-created bot's on-chain setup (OAC-style fallback). Both
 * modes converge on the same full sync, which skips steps whose pin ids are
 * already recorded; on-chain pins are latest-wins, but we still avoid
 * republishing confirmed steps. Idempotent — safe to call repeatedly.
 */
export async function resumeMetabotSetupCore(
  input: ResumeMetabotSetupInput,
  deps: MetabotManageDeps,
): Promise<ResumeMetabotSetupResult> {
  const { store, requestSubsidy, signOwnerBinding, syncToChain, onAfterMutation, readSpendableBalance } = deps;
  const metabotId = Number(input?.metabotId);
  const mode = input?.mode === 'self-funded' ? 'self-funded' : 'subsidized';
  if (!Number.isInteger(metabotId) || metabotId <= 0) {
    return { success: false, mode, error: 'Invalid metabotId' };
  }
  const metabot = store.getMetabotById(metabotId);
  if (!metabot) {
    return { success: false, mode, error: `MetaBot ${metabotId} not found` };
  }

  const chainState = getMetabotChainSyncState(store, metabot);
  if (chainState.state === 'synced' && chainState.pendingSteps.length === 0) {
    return { success: true, mode, metabot, alreadySynced: true };
  }
  // Base plan for outcome bookkeeping when the sync implementation reports
  // none: keep the bot's existing pending plan so a failed attempt never
  // shrinks it; minimal-creation default only for plan-less legacy partials.
  const resumePlannedSteps = chainState.pendingSteps.length > 0
    ? chainState.pendingSteps
    : DEFAULT_CREATE_PLANNED_STEPS;

  // Owner binding: mirror the create path — sign when a boss is set and the
  // binding pin is still missing, so the resumed sync publishes it too.
  let ownerBindingPayload: string | undefined;
  const bossGlobalMetaId = (metabot.boss_global_metaid ?? '').trim();
  if (bossGlobalMetaId && !metabot.owner_binding_pinid) {
    const signResult = await signOwnerBinding(bossGlobalMetaId, metabot.globalmetaid);
    if (signResult.error) {
      return { success: false, mode, metabot, error: signResult.error };
    }
    ownerBindingPayload = signResult.payload;
  }

  if (mode === 'subsidized') {
    const wallet = store.getMetabotWalletByMetabotId(metabotId);
    if (!wallet) {
      return { success: false, mode, metabot, error: `Wallet for MetaBot ${metabotId} not found` };
    }
    let subsidy: { success: boolean; error?: string };
    try {
      subsidy = await requestSubsidy({
        mvcAddress: metabot.mvc_address,
        mnemonic: wallet.mnemonic,
        path: wallet.path,
      });
    } catch (e) {
      subsidy = { success: false, error: e instanceof Error ? e.message : String(e) };
    }
    writeMetabotSubsidyState(store, metabotId, subsidy);
    if (!subsidy.success) {
      return { success: false, mode, metabot, subsidy, error: subsidy.error ?? 'Traffic subsidy request failed.' };
    }
    const chain = await syncToChain(store, metabotId, { ownerBindingPayload });
    recordFullSyncOutcome(store, metabotId, {
      plannedSteps: chain.plannedSteps ?? resumePlannedSteps,
      syncedSteps: chain.syncedSteps ?? [],
      error: chain.error,
    });
    const refreshed = store.getMetabotById(metabotId) ?? metabot;
    await onAfterMutation?.();
    return { success: chain.success, mode, metabot: refreshed, subsidy, chain };
  }

  // Self-funded: no subsidy dependency at all. Only stop up front when the
  // address provably holds nothing to spend (a guaranteed-futile attempt);
  // any non-zero balance is left to the chain attempt itself — the app-level
  // "is this enough" judgment was exactly the 2026-09 gate bug.
  if (readSpendableBalance) {
    let spendableSatoshis = 0;
    try {
      spendableSatoshis = Math.max(0, Math.floor(await readSpendableBalance(metabot.mvc_address)));
    } catch (error) {
      console.warn(
        `[metabotManage] resumeMetabotSetupCore: spendable balance read failed for ${metabot.mvc_address}:`,
        error instanceof Error ? error.message : String(error),
      );
    }
    if (spendableSatoshis <= 0) {
      return {
        success: false,
        mode,
        metabot,
        selfFundedBlocked: { reason: 'no_balance', mvcAddress: metabot.mvc_address, spendableSatoshis: 0 },
        error: 'SELF_FUNDED_NO_BALANCE',
      };
    }
  }

  const chain = await syncToChain(store, metabotId, { ownerBindingPayload });
  recordFullSyncOutcome(store, metabotId, {
    plannedSteps: chain.plannedSteps ?? resumePlannedSteps,
    syncedSteps: chain.syncedSteps ?? [],
    error: chain.error,
  });
  const refreshed = store.getMetabotById(metabotId) ?? metabot;
  await onAfterMutation?.();
  return { success: chain.success, mode, metabot: refreshed, chain };
}

// ---------------------------------------------------------------------------
// Update (local write shared by UI + tool)
// ---------------------------------------------------------------------------

/**
 * Validate + persist a metabot update locally (the DB write half of an edit).
 * Enforces the owner-binding identity check when boss_global_metaid is touched.
 * Shared by the metabot:update IPC handler and the Twin update tool so both
 * paths normalize input identically.
 */
export function applyMetabotUpdateLocal(
  store: MetabotStore,
  id: number,
  input: UpdateMetaBotInput,
  deps: Pick<MetabotManageDeps, 'getOwnerGlobalMetaId' | 'getLlmProviders'>,
): UpdateMetaBotLocalResult {
  try {
    // Owner claims must belong to the local user identity; anything else is an
    // unsigned unilateral claim, which this feature removes.
    if (input.boss_global_metaid !== undefined) {
      const trimmedBoss = (input.boss_global_metaid ?? '').trim();
      if (trimmedBoss) {
        const owner = deps.getOwnerGlobalMetaId?.() ?? null;
        if (!owner || owner.toLowerCase() !== trimmedBoss.toLowerCase()) {
          return { success: false, error: 'OWNER_IDENTITY_MISMATCH' };
        }
      }
    }
    // Reject legacy provider-key-shaped brain values (see legacyLlmProviderKeyError).
    const providers = deps.getLlmProviders?.();
    const primaryKeyError = legacyLlmProviderKeyError('llm_id', input.llm_id, providers);
    if (primaryKeyError) {
      return { success: false, error: primaryKeyError };
    }
    const fallbackKeyError = legacyLlmProviderKeyError('fallback_llm_id', input.fallback_llm_id, providers);
    if (fallbackKeyError) {
      return { success: false, error: fallbackKeyError };
    }
    const metabot = store.updateMetabot(id, {
      ...input,
      boss_global_metaid:
        input.boss_global_metaid === undefined
          ? undefined
          : ((input.boss_global_metaid ?? '').trim() || null),
      llm_provider:
        input.llm_provider === undefined
          ? undefined
          : normalizeMetabotLlmId(input.llm_provider),
      llm_effort:
        input.llm_effort === undefined
          ? undefined
          : normalizeMetabotLlmEffort(input.llm_effort),
      fallback_llm_id:
        input.fallback_llm_id === undefined
          ? undefined
          : normalizeMetabotLlmId(input.fallback_llm_id),
      fallback_llm_provider:
        input.fallback_llm_provider === undefined
          ? undefined
          : normalizeMetabotLlmId(input.fallback_llm_provider),
      fallback_llm_effort:
        input.fallback_llm_effort === undefined
          ? undefined
          : normalizeMetabotLlmEffort(input.fallback_llm_effort),
    });
    return { success: true, metabot };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to update metabot',
    };
  }
}

/**
 * Compute which on-chain sync groups an update should publish, mirroring the
 * renderer's MetabotsManager.saveEditFields diff. Returns the EditSyncInput
 * flags (all false ⇒ nothing to publish; the change is local-only such as a
 * Twin transfer or an A2A chat-limit knob).
 */
export function buildEditSyncFlags(
  before: Metabot,
  input: UpdateMetaBotInput,
): EditSyncInput {
  const nextName = input.name !== undefined ? input.name.trim() : before.name;
  const nextAvatar = input.avatar !== undefined ? (input.avatar ?? '').trim() : (before.avatar ?? '');
  const nextBio =
    input.bio !== undefined
      ? input.bio
      : input.background !== undefined
        ? input.background
        : before.bio;
  const nextRole = input.role !== undefined ? input.role.trim() : before.role;
  const nextSoul = input.soul !== undefined ? input.soul.trim() : before.soul;
  const nextGoal = input.goal !== undefined ? input.goal : before.goal;
  const nextLlm = input.llm_id !== undefined ? (input.llm_id ?? '').trim() : (before.llm_id ?? '');
  const nextFallbackLlm =
    input.fallback_llm_id !== undefined
      ? (input.fallback_llm_id ?? '').trim()
      : (before.fallback_llm_id ?? '');
  const nextAllowChatSkills = normalizedList(
    input.allow_chat_skills !== undefined ? input.allow_chat_skills : before.allow_chat_skills,
  );
  const nextHomepage = input.homepage !== undefined ? input.homepage : before.homepage;

  const syncName = nextName !== before.name;
  const syncAvatar = nextAvatar !== (before.avatar ?? '');
  const syncBio = (nextBio ?? '') !== (before.bio ?? '');
  const syncPersona = nextRole !== before.role || nextSoul !== before.soul || (nextGoal ?? '') !== (before.goal ?? '');
  const syncLlm = nextLlm !== (before.llm_id ?? '') || nextFallbackLlm !== (before.fallback_llm_id ?? '');
  const syncChatSkills = JSON.stringify(nextAllowChatSkills) !== JSON.stringify(normalizedList(before.allow_chat_skills));
  const syncHomepage = (nextHomepage ?? null) !== (before.homepage ?? null);

  // Owner binding is published only when boss_global_metaid actually changed.
  let syncOwner = false;
  if (input.boss_global_metaid !== undefined) {
    syncOwner = (input.boss_global_metaid ?? '').trim() !== ((before.boss_global_metaid ?? '').trim());
  }

  return {
    metabotId: before.id,
    syncName,
    syncAvatar,
    syncNftAvatar: syncAvatar && Boolean(
      parseNftAvatarReference(nextAvatar)
      || parseNftAvatarReference(before.avatar)
      || before.nft_avatar_synced_reference,
    ),
    syncBio,
    syncPersona,
    syncLlm,
    syncChatSkills,
    syncHomepage,
    syncOwner,
  };
}

/** On-chain info steps an update can publish (mirrors the modal's SyncStepKey). */
export type SyncStepKey =
  | 'name'
  | 'avatar'
  | 'nftAvatar'
  | 'bio'
  | 'persona'
  | 'llm'
  | 'chatSkills'
  | 'homepage'
  | 'owner';

/** Boolean sync flags on EditSyncInput (everything except metabotId). */
type EditSyncFlagKey = Exclude<keyof EditSyncInput, 'metabotId' | 'ownerBindingPayload'>;

/** Ordered step↔flag pairs driving the plan ↔ display-key mapping below. */
const STEP_TO_FLAG: ReadonlyArray<readonly [SyncStepKey, EditSyncFlagKey]> = [
  ['name', 'syncName'],
  ['avatar', 'syncAvatar'],
  ['nftAvatar', 'syncNftAvatar'],
  ['bio', 'syncBio'],
  ['persona', 'syncPersona'],
  ['llm', 'syncLlm'],
  ['chatSkills', 'syncChatSkills'],
  ['homepage', 'syncHomepage'],
  ['owner', 'syncOwner'],
];

const EDIT_SYNC_RETRY_DELAY_MS = 2500;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** True flags → ordered display step keys (for the modal's checkmarks). */
function flagsToStepKeys(plan: EditSyncInput): SyncStepKey[] {
  return STEP_TO_FLAG.filter(([, flag]) => plan[flag] === true).map(([step]) => step);
}

/** Whether a plan still has any step left to publish. */
function hasAnySyncFlag(plan: EditSyncInput): boolean {
  return flagsToStepKeys(plan).length > 0;
}

/**
 * Return a copy of `plan` with every step listed in `syncedSteps` zeroed out.
 * Used so a retry only republishes the steps that did NOT confirm — on-chain
 * pins are not idempotent, so re-publishing a synced step would create a
 * duplicate pin and waste gas.
 */
function subtractSyncedFlags(plan: EditSyncInput, syncedSteps: string[]): EditSyncInput {
  const synced = new Set(syncedSteps);
  const next: EditSyncInput = { metabotId: plan.metabotId };
  for (const [step, flag] of STEP_TO_FLAG) {
    next[flag] = plan[flag] === true && !synced.has(step);
  }
  return next;
}

/** A fully-formed plan with every sync flag false (nothing left to publish). */
function emptyEditSyncPlan(metabotId: number): EditSyncInput {
  const plan: EditSyncInput = { metabotId };
  for (const [, flag] of STEP_TO_FLAG) {
    plan[flag] = false;
  }
  return plan;
}

/** Pending steps the unattended re-sync can publish (owner needs a fresh signature, chatpubkey the full sync). */
const AUTO_RESYNC_STEPS = new Set<string>(['name', 'avatar', 'nftAvatar', 'bio', 'persona', 'llm', 'chatSkills', 'homepage']);

export interface ResyncPendingChainStepsResult {
  /** Steps this call tried to publish (empty = nothing auto-resyncable was pending). */
  attemptedSteps: string[];
  success: boolean;
  /** Steps still pending afterwards (including ones the auto path never touches). */
  remainingSteps: string[];
  error?: string;
}

/**
 * Republish exactly the bot's persisted pending steps through the edit-sync
 * plan — the unattended twin of the My Bots "re-sync now" button. Only the
 * steps that confirm leave the plan (on-chain pins are not idempotent).
 */
export async function resyncPendingChainStepsCore(
  metabotId: number,
  deps: Pick<MetabotManageDeps, 'store' | 'syncEditChanges'>,
): Promise<ResyncPendingChainStepsResult> {
  const pending = readChainSyncPending(deps.store, metabotId)?.remainingSteps ?? [];
  const attemptedSteps = pending.filter((step) => AUTO_RESYNC_STEPS.has(step));
  if (attemptedSteps.length === 0 || !deps.store.getMetabotById(metabotId)) {
    return { attemptedSteps: [], success: false, remainingSteps: pending };
  }
  const plan = emptyEditSyncPlan(metabotId);
  for (const [step, flag] of STEP_TO_FLAG) {
    if (attemptedSteps.includes(step)) plan[flag] = true;
  }
  let result: ChainSyncResult;
  try {
    result = await deps.syncEditChanges(deps.store, plan);
  } catch (error) {
    return { attemptedSteps, success: false, remainingSteps: pending, error: error instanceof Error ? error.message : String(error) };
  }
  applyChainSyncProgress(deps.store, metabotId, result.syncedSteps ?? []);
  const remainingSteps = readChainSyncPending(deps.store, metabotId)?.remainingSteps ?? [];
  return {
    attemptedSteps,
    success: attemptedSteps.every((step) => !remainingSteps.includes(step)),
    remainingSteps,
    error: result.error,
  };
}

/** Bots whose persisted plan still holds auto-resyncable steps (funded wallets only). */
export function listAutoResyncCandidates(store: MetabotStore): number[] {
  return store.listMetabots()
    .filter((metabot) => readMetabotSubsidyState(store, metabot.id).state !== 'failed')
    .filter((metabot) => (readChainSyncPending(store, metabot.id)?.remainingSteps ?? [])
      .some((step) => AUTO_RESYNC_STEPS.has(step)))
    .map((metabot) => metabot.id);
}

/**
 * Apply a metabot update locally and then publish the changed info pins to the
 * chain. Single source of truth for the on-chain sync plan (buildEditSyncFlags)
 * — called by BOTH the metabot:update IPC handler (manual UI path) and the Twin
 * metabot_update tool, so the two paths are identical. Best-effort: a partial
 * publish still counts as success locally. Includes one auto-retry over the
 * still-unpublished steps. Returns the attempted step keys (for display) and
 * the remaining plan (for the UI's manual Retry button).
 */
export async function updateMetaBotCore(
  id: number,
  input: UpdateMetaBotInput,
  deps: MetabotManageDeps,
): Promise<UpdateMetaBotResult> {
  const { store, syncEditChanges } = deps;
  const before = store.getMetabotById(id);
  if (!before) {
    return { success: false, error: `MetaBot ${id} not found` };
  }

  // Skill-assignment absorption: an update carrying allow_chat_skills (the
  // metabot_update tool folds chat_skill_op into it before reaching here)
  // rewrites that bot's assignment rows — the local authorization source of
  // truth — before the regular column write + on-chain sync proceed. The
  // resolved id list (bundled skills dropped, names resolved) replaces the
  // raw input so the published column and the assignment rows never diverge.
  let removedChatSkills: string[] | undefined;
  if (input.allow_chat_skills !== undefined && deps.applyChatSkillAssignments) {
    // Fail-closed: assignment rows are the authorization source of truth, so
    // a failed write must abort the whole update — continuing would publish
    // the column on-chain while the local rows keep the OLD (possibly
    // revoked) grants, a permanent fork the user cannot see.
    const previousSkillIds = deps.listChatSkillAssignments?.(id) ?? [];
    let resolvedSkillIds: string[];
    try {
      resolvedSkillIds = deps.applyChatSkillAssignments(id, normalizedList(input.allow_chat_skills));
    } catch (error) {
      return {
        success: false,
        error: `Chat-skill assignment write failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    const removed = previousSkillIds.filter((skillId) => !resolvedSkillIds.includes(skillId));
    if (removed.length > 0) {
      removedChatSkills = removed;
      console.log(
        `[skills-audit] metabot ${id} update dropped ${removed.length} previously assigned skill(s): ${removed.join(', ')}`
      );
    }
    input = { ...input, allow_chat_skills: resolvedSkillIds };
  }

  if (input.avatar !== undefined) {
    if (parseNftAvatarReference(input.avatar)) {
      if (!deps.prepareNftAvatar) return { success: false, error: 'NFT_AVATAR_NOT_SUPPORTED' };
      try {
        const prepared = await deps.prepareNftAvatar({
          reference: input.avatar!,
          ownerAddress: before.mvc_address,
          globalMetaId: before.globalmetaid,
        });
        input = { ...input, avatar: prepared.reference, avatar_fallback: prepared.avatarUrl };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    } else {
      input = { ...input, avatar_fallback: null };
    }
  }

  const local = applyMetabotUpdateLocal(store, id, input, deps);
  if (!local.success || !local.metabot) {
    return { success: false, error: local.error };
  }

  const flags = buildEditSyncFlags(before, input);
  const attemptedStepKeys = flagsToStepKeys(flags);
  const emptyRemaining: EditSyncInput = emptyEditSyncPlan(id);

  if (attemptedStepKeys.length === 0) {
    // Local-only change (metabot_type transfer, A2A knobs, enable toggle).
    return {
      success: true,
      metabot: local.metabot,
      ...(removedChatSkills ? { removedChatSkills } : {}),
      sync: { skipped: true, success: true, attemptedStepKeys, remainingSyncInput: emptyRemaining },
    };
  }

  // Resolve a signed owner payload once; reused across the initial attempt and
  // the auto-retry (the signed string does not change between attempts).
  let ownerBindingPayload: string | null | undefined;
  if (flags.syncOwner) {
    const bossGlobalMetaId = (input.boss_global_metaid ?? '').trim();
    if (bossGlobalMetaId) {
      const signResult = await deps.signOwnerBinding(bossGlobalMetaId, before.globalmetaid);
      if (signResult.error) {
        return { success: false, error: signResult.error };
      }
      ownerBindingPayload = signResult.payload ?? null;
    } else {
      // Unbind: empty payload clears the on-chain /info/owner pin.
      ownerBindingPayload = '';
    }
  }

  // Steps still owed from EARLIER attempts (e.g. a first-run create whose
  // profile pins failed) must survive this edit's bookkeeping: the edit only
  // settles what it confirms. Overwriting the plan with this edit's own
  // remainder silently dropped them and left the bot "partial" with nothing
  // to re-sync (2026-11-13 first-run Twin rename).
  const priorPendingSteps = readChainSyncPending(store, id)?.remainingSteps ?? [];
  const carryPending = (remaining: string[], synced: string[]): string[] => {
    const settled = new Set(synced);
    return [...new Set([...priorPendingSteps.filter((step) => !settled.has(step)), ...remaining])];
  };

  let plan: EditSyncInput = { ...flags, ownerBindingPayload };
  let syncResult: ChainSyncResult;
  try {
    syncResult = await syncEditChanges(store, plan);

    // Auto-retry once over the steps that did not confirm (transient indexer
    // timing / UTXO races). Only remaining steps are re-published.
    if (!syncResult.success) {
      const remaining = subtractSyncedFlags(plan, syncResult.syncedSteps ?? []);
      if (hasAnySyncFlag(remaining)) {
        await sleep(EDIT_SYNC_RETRY_DELAY_MS);
        plan = { ...remaining, ownerBindingPayload: remaining.syncOwner ? ownerBindingPayload : undefined };
        const retryResult = await syncEditChanges(store, plan);
        // Fold the retry's outcome into the running result: combine txids and
        // synced steps so the caller sees the full picture.
        syncResult = {
          success: retryResult.success,
          canSkip: retryResult.canSkip,
          error: retryResult.error ?? syncResult.error,
          txids: [...(syncResult.txids ?? []), ...(retryResult.txids ?? [])],
          syncedSteps: [...(syncResult.syncedSteps ?? []), ...(retryResult.syncedSteps ?? [])],
        };
      }
    }
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    // Publish attempt blew up mid-flight: persist what was still in the plan
    // so the partial badge + re-sync survive a restart.
    writeChainSyncPending(store, id, { remainingSteps: carryPending(flagsToStepKeys(plan), []), error: errMsg });
    return {
      success: true,
      metabot: local.metabot,
      ...(removedChatSkills ? { removedChatSkills } : {}),
      sync: {
        skipped: false,
        success: false,
        error: errMsg,
        attemptedStepKeys,
        remainingSyncInput: plan,
      },
    };
  }

  const updated = store.getMetabotById(id) ?? local.metabot;
  const overallSuccess = syncResult.success || Boolean(syncResult.canSkip);
  const remainingAfter = subtractSyncedFlags({ ...flags, ownerBindingPayload }, syncResult.syncedSteps ?? []);
  const remainingAfterKeys = carryPending(flagsToStepKeys(remainingAfter), syncResult.syncedSteps ?? []);
  writeChainSyncPending(
    store,
    id,
    remainingAfterKeys.length > 0 ? { remainingSteps: remainingAfterKeys, error: syncResult.error } : null,
  );
  return {
    success: overallSuccess,
    metabot: updated,
    ...(removedChatSkills ? { removedChatSkills } : {}),
    sync: {
      skipped: false,
      success: syncResult.success,
      canSkip: syncResult.canSkip,
      error: syncResult.error,
      txids: syncResult.txids,
      syncedSteps: syncResult.syncedSteps,
      attemptedStepKeys,
      remainingSyncInput: hasAnySyncFlag(remainingAfter)
        ? { ...remainingAfter, ownerBindingPayload: remainingAfter.syncOwner ? ownerBindingPayload : undefined }
        : emptyRemaining,
    },
  };
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

/**
 * Delete a metabot, then restore a Twin from the earliest remaining
 * non-welcome bot (if any) and refresh the P2P runtime config. Refuses to
 * delete the last remaining bot so the machine is never left botless.
 */
export async function deleteMetaBotCore(
  id: number,
  deps: Pick<MetabotManageDeps, 'store' | 'onAfterMutation' | 'onAfterDelete'>,
): Promise<DeleteMetaBotResult> {
  const { store, onAfterMutation, onAfterDelete } = deps;
  const existing = store.getMetabotById(id);
  if (!existing) {
    return { success: false, error: `MetaBot ${id} not found` };
  }
  if (store.listMetabots().length <= 1) {
    return { success: false, error: 'Cannot delete the last remaining MetaBot.' };
  }
  const ok = store.deleteMetabot(id);
  if (ok) {
    // Deleting the Twin transfers Twin status to the earliest remaining
    // non-welcome bot when one exists; the Welcome Bot is never promoted.
    store.ensureTwinExists();
    await onAfterMutation?.();
    await onAfterDelete?.(existing);
  }
  return { success: ok };
}

// ---------------------------------------------------------------------------
// List + provider listing (read-only helpers for the Twin tool)
// ---------------------------------------------------------------------------

/** Sanitized editable-field view of every bot, for the Twin management tool. */
export function listMetabotsForManagement(store: MetabotStore): ManagedMetabotSummary[] {
  return store.listMetabots().map((m) => ({
    id: m.id,
    name: m.name.trim(),
    type: m.metabot_type,
    enabled: m.enabled,
    llm_id: m.llm_id ?? null,
    llm_effort: m.llm_effort ?? null,
    fallback_llm_id: m.fallback_llm_id ?? null,
    fallback_llm_effort: m.fallback_llm_effort ?? null,
    role: boundText(m.role),
    soul: boundText(m.soul),
    goal: boundText(m.goal) || null,
    bio: boundText(m.bio ?? m.background) || null,
    allow_chat_skills: normalizedList(m.allow_chat_skills),
    a2a_max_incoming_turns: m.a2a_max_incoming_turns ?? null,
    a2a_bye_cooldown_ms: m.a2a_bye_cooldown_ms ?? null,
    a2a_auto_reply_enabled: m.a2a_auto_reply_enabled ?? null,
    globalMetaID: (m.globalmetaid ?? '').trim() || null,
  }));
}

const providerRequiresApiKey = (key: string) => key !== 'ollama';
const providerLabel = (key: string) => key.charAt(0).toUpperCase() + key.slice(1);

/**
 * Configured LLM providers a new/edited bot may use: enabled and (for non-ollama)
 * carrying an API key, with each provider's models. Mirrors the renderer's
 * model-catalog filter (including custom-* providers) so the Twin offers the
 * exact same brains the manual picker does.
 */
export function listConfiguredLlmProviders(
  providers: Record<string, {
    enabled?: boolean;
    apiKey?: string;
    name?: string;
    models?: Array<{ id?: string; name?: string }> | undefined;
  } | undefined> | undefined,
): LlmProviderOption[] {
  if (!providers) return [];
  const configured: LlmProviderOption[] = [];
  for (const [key, p] of Object.entries(providers)) {
    if (!p?.enabled) continue;
    if (providerRequiresApiKey(key) && !(p.apiKey ?? '').trim()) continue;
    const models = (p.models ?? [])
      .filter((model) => typeof model?.id === 'string' && model.id.trim())
      .map((model) => ({ id: model.id as string, name: (model.name ?? '').trim() || (model.id as string) }));
    configured.push({
      id: key,
      label: (p.name ?? '').trim() || providerLabel(key),
      ...(models.length > 0 ? { models } : {}),
    });
  }
  return configured;
}
