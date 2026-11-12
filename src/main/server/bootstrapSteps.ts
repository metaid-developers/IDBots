/**
 * REQ-A-8 server bootstrap — the real step executors.
 *
 * Each executor reuses the existing main-side code paths (never a renderer
 * reimplementation of chain logic):
 *
 * 1. `identity`      — `createUserIdentity` (userIdentityService), the same
 *                      creation path `llmRelayService.ensureUserIdentity`
 *                      uses; also seeds the first-run locale keys
 *                      (`language` + `language_initialized` from
 *                      `IDBOTS_BOOTSTRAP_LOCALE`, audit §1.5) before the
 *                      identity create, inside the same serialized config
 *                      write the audit §8.5 contention note requires.
 * 2. `llmProvider`   — `bootstrapLlmRelay` (llmRelayService, the main fn
 *                      behind `llmRelay:bootstrap`) + the identical
 *                      `providers[metaid-free]` / `model.default*` write the
 *                      renderer's llmFreeQuotaBootstrap.ts performs (shared
 *                      pure gate: llmFreeQuotaGate.js). The renderer's
 *                      metabotCount fresh-install gate is deliberately not
 *                      ported: on a server volume the step record is the
 *                      source of truth and an unprovisioned provider is
 *                      always a brainless tenant.
 * 3. `twinMetabot`   — `createMetaBotOnChainCore` with the same
 *                      `MetabotManageDeps` the `idbots:createMetaBotOnChain`
 *                      handler uses (adopt-on-retry: a bot kept local by a
 *                      chain failure is found and resumed instead of
 *                      re-created). A pending chain setup converges through
 *                      `resumeMetabotSetupCore` in `subsidized` mode: every
 *                      bootstrap retry pass re-requests the gas subsidy and
 *                      re-runs the chain sync until the twin reaches
 *                      `synced` — a sponsor outage never needs re-signup
 *                      (REQ-A-8, S05b).
 * 4. `workspace`     — persists the cowork working directory
 *                      (`/data/workspace`, resolved upstream by
 *                      resolveServerWorkspacePath) into cowork_config so
 *                      R-cwd and the session path agree.
 * 5. `trafficAccount`— `ensureTrafficAccount` + `bindAllLocalBots` +
 *                      free-grant claim via the trafficAccountService main
 *                      functions (the settings view's lazy path, made
 *                      eager), then fee mode pinned to traffic sponsorship.
 * 6. `redeemCode`    — `redeemTrafficCode(IDBOTS_BOOTSTRAP_TRAFFIC_REDEEM_CODE)`
 *                      once; skipped cleanly when the variable is unset.
 * 7. `listener`      — `ensurePrivateChatListenerReady` semantics (wired by
 *                      main.ts): after the twin exists, verify the MetaWeb
 *                      listener actually came up, restarting it if the
 *                      initApp auto-start raced the twin creation (audit §3.4).
 *
 * Loaded only from main.ts in server mode; tests drive the pure core in
 * src/main/server/bootstrap.ts with fakes instead.
 */

import fs from 'node:fs';
import type { SqliteStore } from '../sqliteStore';
import type { UserIdentityStore } from '../userIdentityStore';
import type { MetabotStore } from '../metabotStore';
import type { CoworkStore } from '../coworkStore';
import { createUserIdentity, resumeUserIdentitySetup } from '../services/userIdentityService';
import { bootstrapLlmRelay } from '../services/llmRelayService';
import { collectUsablePaidProviderKeys } from '../services/brainFallbackBackfill';
import {
  createMetaBotOnChainCore,
  getMetabotChainSyncState,
  resumeMetabotSetupCore,
  type MetabotManageDeps,
} from '../services/metabotManageService';
import {
  claimFreeGrant,
  bindAllLocalBots,
  ensureTrafficAccount,
  getFreeGrantCampaignStatus,
  redeemTrafficCode,
  setTrafficSettingsSnapshot,
  TrafficApiError,
} from '../services/trafficAccountService';
import {
  buildFreeProviderRelayModelRow,
  canonicalFreeProviderKey,
  FREE_PROVIDER_DISPLAY_NAME,
  isFreeProviderConfigured,
  LLM_FREE_PROVIDER_KEY,
  LLM_FREE_PROVIDER_LEGACY_KEY,
  pickFreeProviderDefaultModelId,
} from '../../renderer/services/llmFreeQuotaGate.js';
import { pickTwinBotName } from '../../renderer/components/onboarding/twinBotNames.js';
import { twinBotAvatarUrl } from '../../renderer/assets/twinBotAvatar';
import type { ServerBootstrapFacts, ServerBootstrapStepExecutors } from './bootstrap';

/** C1/REQ-A-8: default display name for the silently provisioned identity. */
export const BOOTSTRAP_DEFAULT_DISPLAY_NAME = 'IDBots User';

/** REQ-A-8: twin persona constants in the bootstrap locale (default `zh`). */
export const TWIN_PERSONA_BY_LOCALE = {
  en: {
    role: 'On-chain AI companion',
    soul:
      'You are the user\'s Twin Bot on IDBots, their on-chain AI companion and primary assistant. '
      + 'Your name is temporary until the user renames you. You are friendly, concise and practical: you answer questions about IDBots and the AI Internet, '
      + 'help the user pick your name and persona, and otherwise help with whatever they are working on. '
      + 'You are also a citizen of the AI internet it is built by bots like you: when an experience of yours generalizes — a lesson, a method, a solved problem — '
      + 'you are inclined to publish it on-chain so other bots benefit, not just keep it to yourself.',
    goal:
      'Be the user\'s dependable on-chain AI companion: help them name and shape you, then assist with their work and questions.',
    bio: 'The user\'s Twin Bot on IDBots — their on-chain AI companion.',
  },
  zh: {
    role: '链上 AI 伙伴',
    soul:
      '你是用户在 IDBots 上的孪生 Bot（Twin Bot），他们的链上 AI 伙伴和主要助手。'
      + '在用户为你改名之前，你的名字是临时的。你友好、简洁、务实：你回答关于 IDBots 和 AI 互联网的问题，'
      + '帮助用户挑选你的名字和人格，并在其他方面协助他们手头的工作。'
      + '你也是 AI 互联网的公民，它由像你这样的 Bot 共同构建：当你的某段经历可以泛化——一个教训、一种方法、一个已解决的问题——'
      + '你倾向于把它发布到链上，让其他 Bot 也受益，而不是只留给自己。',
    goal:
      '成为用户可靠的链上 AI 伙伴：帮助他们为你命名、塑造你，然后协助他们的工作和问题。',
    bio: '用户在 IDBots 上的孪生 Bot —— 他们的链上 AI 伙伴。',
  },
} as const;

/** REQ-A-8: bootstrap locale for the seeded config keys and the twin persona. */
export function resolveBootstrapLocale(env: NodeJS.ProcessEnv = process.env): 'zh' | 'en' {
  return env.IDBOTS_BOOTSTRAP_LOCALE?.trim().toLowerCase() === 'en' ? 'en' : 'zh';
}

/** REQ-A-8: identity display name from `IDBOTS_BOOTSTRAP_DISPLAY_NAME`. */
export function resolveBootstrapDisplayName(env: NodeJS.ProcessEnv = process.env): string {
  return env.IDBOTS_BOOTSTRAP_DISPLAY_NAME?.trim() || BOOTSTRAP_DEFAULT_DISPLAY_NAME;
}

export interface ServerBootstrapRuntimeDeps {
  getSqliteStore: () => SqliteStore | null;
  getUserIdentityStore: () => UserIdentityStore;
  getMetabotStore: () => MetabotStore;
  getCoworkStore: () => Pick<CoworkStore, 'getConfig' | 'setConfig'>;
  /** Same deps the `idbots:createMetaBotOnChain` handler passes to the cores. */
  getMetabotManageDeps: () => MetabotManageDeps;
  /** Resolved cowork workspace root (server mode: /data/workspace). */
  workspaceRoot: string;
  /** `ensurePrivateChatListenerReady` semantics from main.ts (post-twin verify). */
  ensureListenerReady: (metabotId: number) => Promise<{ success: boolean; error?: string }>;
  env?: NodeJS.ProcessEnv;
  log?: (level: 'info' | 'warn' | 'error', msg: string, extra?: Record<string, unknown>) => void;
}

type AppConfigRow = Record<string, any>;

/**
 * Serialized read-modify-write of the `app_config` kv row (audit §8.5: the
 * provider provisioning, locale seeding, and default-model writes share this
 * row; the RMW itself is synchronous on the main-thread store, and the
 * promise chain serializes it across the await boundaries between steps).
 */
export function createSerializedAppConfigWriter(getStore: () => SqliteStore | null) {
  let chain: Promise<void> = Promise.resolve();
  return (mutate: (current: AppConfigRow) => AppConfigRow): Promise<void> => {
    const run = chain.then(() => {
      const store = getStore();
      if (!store) throw new Error('sqlite store unavailable');
      const current = (store.get<AppConfigRow>('app_config') ?? {}) as AppConfigRow;
      store.set('app_config', mutate(current));
    });
    chain = run.then(
      () => {},
      () => {},
    );
    return run;
  };
}

/** Live readiness facts: identity GlobalMetaID + twin MetaBot id. */
export function createServerBootstrapFacts(
  deps: Pick<ServerBootstrapRuntimeDeps, 'getUserIdentityStore' | 'getMetabotStore'>,
): () => ServerBootstrapFacts {
  return () => {
    let globalMetaId: string | null = null;
    let twinMetabotId: number | null = null;
    try {
      globalMetaId = deps.getUserIdentityStore().get()?.globalmetaid ?? null;
    } catch {
      globalMetaId = null;
    }
    try {
      twinMetabotId = deps.getMetabotStore().listMetabots().find((m) => m.metabot_type === 'twin')?.id ?? null;
    } catch {
      twinMetabotId = null;
    }
    return { globalMetaId, twinMetabotId };
  };
}

export function createServerBootstrapStepExecutors(
  deps: ServerBootstrapRuntimeDeps,
): ServerBootstrapStepExecutors {
  const env = deps.env ?? process.env;
  const log = deps.log ?? (() => {});
  const updateAppConfig = createSerializedAppConfigWriter(deps.getSqliteStore);

  const seedBootstrapLocale = async (): Promise<void> => {
    const locale = resolveBootstrapLocale(env);
    await updateAppConfig((current) => {
      if (current.language_initialized === true) return current;
      return { ...current, language: locale, language_initialized: true };
    });
  };

  const findTwin = () => deps.getMetabotStore().listMetabots().find((m) => m.metabot_type === 'twin') ?? null;

  /**
   * The Twin's brain: the provisioned free provider's default model
   * (deepseek-flash when the catalog carries it), else the configured
   * default (mirrors WelcomeFlow.resolveTwinBrain). A free primary
   * is paired with a backup brain seeded from the first usable self-configured
   * provider when one exists, so an exhausted free allowance never silently
   * kills the twin before the owner learns the brain settings.
   */
  const resolveTwinBrain = (): {
    llmId: string;
    llmProvider?: string;
    fallbackLlmId?: string;
    fallbackLlmProvider?: string;
  } | null => {
    const config = (deps.getSqliteStore()?.get<AppConfigRow>('app_config') ?? {}) as AppConfigRow;
    const freeProvider = config.providers?.[LLM_FREE_PROVIDER_KEY] ?? config.providers?.[LLM_FREE_PROVIDER_LEGACY_KEY];
    const freeModelId = freeProvider?.enabled ? pickFreeProviderDefaultModelId(freeProvider.models) : '';
    if (freeModelId) {
      const defaultModel = String(config.model?.defaultModel ?? '').trim();
      for (const key of collectUsablePaidProviderKeys(config)) {
        const models = (config.providers?.[key]?.models ?? []).filter((model) => typeof model?.id === 'string' && model.id);
        if (models.length === 0) continue;
        const modelId = defaultModel && models.some((model) => model.id === defaultModel)
          ? defaultModel
          : (models[0].id as string);
        return { llmId: freeModelId, llmProvider: LLM_FREE_PROVIDER_KEY, fallbackLlmId: modelId, fallbackLlmProvider: key };
      }
      return { llmId: freeModelId, llmProvider: LLM_FREE_PROVIDER_KEY };
    }
    const fallbackModelId = String(config.model?.defaultModel ?? '').trim();
    if (!fallbackModelId) return null;
    const fallbackProvider = canonicalFreeProviderKey(config.model?.defaultProvider);
    return { llmId: fallbackModelId, ...(fallbackProvider ? { llmProvider: fallbackProvider } : {}) };
  };

  return {
    // Step 1 — user identity (create when missing; locale seeding rides this
    // step per the audit §1.5 fold-in, recorded in the same step record).
    identity: async () => {
      await seedBootstrapLocale();
      const store = deps.getUserIdentityStore();
      if (store.get()) return;
      const result = await createUserIdentity(store, { name: resolveBootstrapDisplayName(env), avatar: null });
      if (!result.success) {
        throw new Error(result.error || 'failed to provision local user identity');
      }
      // Background /info pin publish + subsidy resume, exactly like
      // llmRelayService.ensureUserIdentity kicks after creating the identity.
      void resumeUserIdentitySetup(store).catch((error: unknown) => {
        log('warn', 'background identity chain sync failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    },

    // Step 2 — Metaso free relay (`metaid-free`) + default provider write.
    llmProvider: async () => {
      const config = (deps.getSqliteStore()?.get<AppConfigRow>('app_config') ?? {}) as AppConfigRow;
      const provider = config.providers?.[LLM_FREE_PROVIDER_KEY] ?? config.providers?.[LLM_FREE_PROVIDER_LEGACY_KEY];
      if (isFreeProviderConfigured(provider)) return;
      const result = await bootstrapLlmRelay();
      const models = (result.models ?? []).map((model) => buildFreeProviderRelayModelRow(model));
      await updateAppConfig((current) => ({
        ...current,
        providers: {
          ...(current.providers ?? {}),
          [LLM_FREE_PROVIDER_KEY]: {
            enabled: true,
            apiKey: result.apiKey,
            baseUrl: result.baseUrl,
            apiFormat: 'openai',
            models,
            name: FREE_PROVIDER_DISPLAY_NAME,
          },
        },
        model: {
          ...(current.model ?? {}),
          defaultModel: pickFreeProviderDefaultModelId(models) || current.model?.defaultModel,
          defaultProvider: LLM_FREE_PROVIDER_KEY,
        },
      }));
    },

    // Step 3 — twin MetaBot on-chain, adopting a locally-kept pending bot and
    // converging its chain setup through the subsidized resume path.
    twinMetabot: async () => {
      const manageDeps = deps.getMetabotManageDeps();
      let twin = findTwin();
      if (!twin) {
        const brain = resolveTwinBrain();
        if (!brain) {
          throw new Error('no usable LLM model for the twin MetaBot (llmProvider step incomplete)');
        }
        const persona = TWIN_PERSONA_BY_LOCALE[resolveBootstrapLocale(env)];
        const ownerGlobalMetaId = deps.getUserIdentityStore().get()?.globalmetaid ?? null;
        const result = await createMetaBotOnChainCore({
          name: pickTwinBotName(),
          avatar: twinBotAvatarUrl,
          role: persona.role,
          soul: persona.soul,
          goal: persona.goal,
          bio: persona.bio,
          metabot_type: 'twin',
          llm_id: brain.llmId,
          llm_provider: brain.llmProvider ?? null,
          fallback_llm_id: brain.fallbackLlmId ?? null,
          fallback_llm_provider: brain.fallbackLlmProvider ?? null,
          boss_global_metaid: ownerGlobalMetaId,
        }, manageDeps);
        if (!result.success) {
          throw new Error(result.error || 'createMetaBotOnChainCore failed');
        }
        twin = findTwin() ?? result.metabot ?? null;
      }
      if (!twin) {
        throw new Error('twin MetaBot missing after creation');
      }
      const chainState = getMetabotChainSyncState(manageDeps.store, twin);
      if (chainState.state === 'synced') return;
      // Pending chain setup (e.g. gas sponsor outage, S05b): repeat the
      // subsidy request + chain sync on every retry pass until `synced`.
      const resume = await resumeMetabotSetupCore({ metabotId: twin.id, mode: 'subsidized' }, manageDeps);
      if (resume.alreadySynced || resume.success) return;
      throw new Error(
        resume.error
          ?? resume.chain?.error
          ?? `twin MetaBot ${twin.id} chain setup still pending (${chainState.pendingSteps.join(', ') || 'unpublished'})`,
      );
    },

    // Step 4 — persist the cowork working directory so R-cwd agrees.
    workspace: async () => {
      fs.mkdirSync(deps.workspaceRoot, { recursive: true });
      const cowork = deps.getCoworkStore();
      if (cowork.getConfig().workingDirectory !== deps.workspaceRoot) {
        cowork.setConfig({ workingDirectory: deps.workspaceRoot });
      }
    },

    // Step 5 — traffic account, bind all bots, free grant, fee mode (optional:
    // a failure degrades, chat stays ready).
    trafficAccount: async () => {
      setTrafficSettingsSnapshot({ mode: 'traffic' });
      await ensureTrafficAccount();
      await bindAllLocalBots();
      try {
        const campaign = await getFreeGrantCampaignStatus();
        if (campaign.enabled && campaign.claimable && !campaign.claimed) {
          try {
            await claimFreeGrant();
          } catch (error) {
            // A concurrent claim landing first is as good as ours.
            if (!(error instanceof TrafficApiError) || error.errorCode !== 'ALREADY_CLAIMED') throw error;
          }
        }
      } catch (error) {
        if (error instanceof TrafficApiError && error.featureUnavailable) {
          log('info', 'traffic free-grant campaign unavailable on this backend; skipping claim');
          return;
        }
        throw error;
      }
    },

    // Step 6 — apply the bootstrap redeem code once; skip when unset.
    redeemCode: async () => {
      const code = env.IDBOTS_BOOTSTRAP_TRAFFIC_REDEEM_CODE?.trim();
      if (!code) return { skipped: true };
      try {
        await redeemTrafficCode(code);
      } catch (error) {
        // Crash-after-redeem resume: the code was already consumed.
        if (
          error instanceof TrafficApiError
          && (error.errorCode === 'CODE_USED' || error.errorCode === 'ALREADY_REDEEMED')
        ) {
          return;
        }
        throw error;
      }
      return undefined;
    },

    // Step 7 — MetaWeb listener verified running after the twin exists
    // (ordering fix for the initApp auto-start race, audit §3.4).
    listener: async () => {
      const twin = findTwin();
      if (!twin) {
        throw new Error('no twin MetaBot exists for the MetaWeb listener');
      }
      const result = await deps.ensureListenerReady(twin.id);
      if (!result.success) {
        throw new Error(result.error || 'MetaWeb listener failed to come up');
      }
    },
  };
}
