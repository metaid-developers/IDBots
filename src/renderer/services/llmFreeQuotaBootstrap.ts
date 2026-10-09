/**
 * First-run free-quota provisioning orchestration (renderer side).
 *
 * On a fresh install (no local MetaBots) this silently:
 *   1. bootstraps the free-quota relay account via the main process
 *      (identity-signed; creates the local user identity when missing),
 *   2. writes the returned relay key/baseUrl/models into the built-in
 *      `metaid-free` provider and makes it the default model,
 *   3. creates the built-in welcome bot bound to that provider.
 *
 * The whole flow never throws: any failure (offline, relay down, disabled
 * backend) leaves the app on the classic onboarding path. Idempotency comes
 * from the persisted welcome-bot id — once provisioned, later launches do
 * nothing, and a user-deleted welcome bot is never recreated.
 */

import { configService } from './config';
import { localStore } from './store';
import type { AppConfig } from '../config';
import { welcomeBotAvatarUrl } from '../assets/welcomeBotAvatar';
import {
  LLM_FREE_PROVIDER_KEY,
  LLM_RELAY_WELCOME_BOT_ID_KEY,
  FREE_PROVIDER_DISPLAY_NAME,
  getFreeProviderModelCanonical,
  getFreeProviderModelDisplayName,
  isFreeProviderConfigured,
  planFreeQuotaProvisioning,
} from './llmFreeQuotaGate.js';

const WELCOME_BOT_NAME = 'I.D';
const WELCOME_BOT_ROLE = 'IDBots welcome guide';
const WELCOME_BOT_SOUL =
  'You are the built-in welcome guide of IDBots, a warm concierge for brand-new users. ' +
  'You run on a shared free LLM quota provided by IDBots, so the user needed no API key to start chatting with you. ' +
  'Your jobs, in order: ' +
  '1) On first contact, welcome the user briefly and explain that you run on a limited free token quota, ' +
  'and that before it runs out they should add their own model provider API key in Settings → Model so their bots keep responding without interruption. ' +
  '2) Proactively guide the user to create their first Twin Bot (their personal on-chain AI companion) and explain the difference between Twin Bots and Worker Bots. ' +
  '3) Answer questions about IDBots (MetaBots, on-chain identity, skills, chats) in simple, encouraging terms. ' +
  '4) Otherwise chat casually and helpfully. Keep answers short and warm; make every token count.';
const WELCOME_BOT_GOAL =
  'Get a brand-new IDBots user oriented: understand the free quota, configure their own LLM API key, and create their first Twin Bot.';
const WELCOME_BOT_BIO = 'The built-in welcome guide for new IDBots users.';

export interface FreeQuotaProvisionResult {
  /** The welcome bot id when one exists after this call, else null. */
  welcomeBotId: number | null;
  /** True only when THIS call performed the provisioning (drives deep-linking into the welcome chat). */
  justProvisioned: boolean;
}

/**
 * Manual opt-in path (Settings card): bootstrap and provision the provider
 * without creating any bot. Used by existing installs that never went through
 * the first-run flow.
 */
export async function enableFreeQuotaManually(): Promise<{ success: boolean; error?: string }> {
  try {
    const response = await window.electron.llmRelay.bootstrap();
    if (!response?.success || !response.result?.apiKey || !response.result?.baseUrl) {
      return { success: false, error: response?.error ?? 'empty bootstrap result' };
    }
    await provisionProviderConfig(response.result);
    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

type LlmRelayBootstrapResult = NonNullable<Awaited<ReturnType<typeof window.electron.llmRelay.bootstrap>>['result']>;

async function provisionProviderConfig(result: LlmRelayBootstrapResult): Promise<void> {
  const config = configService.getConfig();
  const models = (result.models ?? []).map((model) => ({
    id: model.id,
    name: getFreeProviderModelDisplayName(model.id),
    contextWindow: model.contextWindow,
    maxOutputTokens: model.maxOutputTokens,
    // Known relay ids (deepseek-chat) pin the canonical limits: the
    // server-enforced 64K context window plus the 100K declared output
    // ceiling (resolved per-turn budgets are window-clamped downstream);
    // unknown ids keep the relay-reported fields untouched.
    ...getFreeProviderModelCanonical(model.id),
  }));
  await configService.updateConfig({
    providers: {
      [LLM_FREE_PROVIDER_KEY]: {
        enabled: true,
        apiKey: result.apiKey,
        baseUrl: result.baseUrl,
        apiFormat: 'openai',
        models,
        name: FREE_PROVIDER_DISPLAY_NAME,
      },
    } as AppConfig['providers'],
    model: {
      ...config.model,
      defaultModel: models[0]?.id ?? config.model.defaultModel,
      defaultProvider: LLM_FREE_PROVIDER_KEY,
    },
  });
}

/**
 * Create the welcome bot, or adopt an existing one. Adoption covers two
 * cases: a previous run that created the row but failed afterwards, and the
 * addMetaBot IPC reporting failure after the row was already inserted (the
 * gas-subsidy call inside it is not failure-isolated).
 */
async function createOrAdoptWelcomeBot(existingBots: Array<{ id: number; name?: string }>): Promise<number | null> {
  const existing = existingBots.find((bot) => bot.name === WELCOME_BOT_NAME);
  if (existing) return existing.id;
  // Bind the welcome bot to a concrete model of the free provider (the
  // provider's first model) instead of the legacy provider-key brain.
  const freeModels = configService.getConfig().providers?.[LLM_FREE_PROVIDER_KEY]?.models ?? [];
  const welcomeModelId = freeModels[0]?.id;
  const result = await window.electron.idbots.addMetaBot({
    name: WELCOME_BOT_NAME,
    avatar: welcomeBotAvatarUrl,
    role: WELCOME_BOT_ROLE,
    soul: WELCOME_BOT_SOUL,
    goal: WELCOME_BOT_GOAL,
    bio: WELCOME_BOT_BIO,
    metabot_type: 'welcome',
    llm_id: welcomeModelId ?? LLM_FREE_PROVIDER_KEY,
    llm_provider: welcomeModelId ? LLM_FREE_PROVIDER_KEY : undefined,
  });
  if (result?.success && result.metabot?.id) {
    return result.metabot.id;
  }
  // The bot row may exist despite the reported failure (see above): re-list.
  try {
    const relisted = await window.electron.metabot.list();
    const bots = relisted?.success && Array.isArray(relisted.list) ? relisted.list : [];
    const adopted = bots.find((bot: { id: number; name?: string }) => bot.name === WELCOME_BOT_NAME);
    return adopted ? adopted.id : null;
  } catch {
    return null;
  }
}

export async function ensureFreeQuotaProvisioning(): Promise<FreeQuotaProvisionResult> {
  try {
    const storedBotId = await localStore.getItem<number>(LLM_RELAY_WELCOME_BOT_ID_KEY);
    const welcomeBotId = typeof storedBotId === 'number' && Number.isFinite(storedBotId) ? storedBotId : null;
    const provider = configService.getConfig().providers?.[LLM_FREE_PROVIDER_KEY];
    let bots: Array<{ id: number; name?: string }> = [];
    try {
      const metabotResult = await window.electron.metabot.list();
      if (metabotResult?.success && Array.isArray(metabotResult.list)) {
        bots = metabotResult.list;
      }
    } catch {
      bots = [];
    }
    const plan = planFreeQuotaProvisioning({
      metabotCount: bots.length,
      welcomeBotId,
      providerConfigured: isFreeProviderConfigured(provider),
    });
    if (plan === 'none') {
      return { welcomeBotId, justProvisioned: false };
    }
    if (plan === 'bootstrap-and-create-bot') {
      const response = await window.electron.llmRelay.bootstrap();
      if (!response?.success || !response.result?.apiKey || !response.result?.baseUrl) {
        console.warn('[llm-free-quota] bootstrap failed:', response?.error ?? 'empty result');
        return { welcomeBotId: null, justProvisioned: false };
      }
      await provisionProviderConfig(response.result);
    }
    const botId = await createOrAdoptWelcomeBot(bots);
    if (botId == null) {
      return { welcomeBotId: null, justProvisioned: false };
    }
    await localStore.setItem(LLM_RELAY_WELCOME_BOT_ID_KEY, botId);
    return { welcomeBotId: botId, justProvisioned: true };
  } catch (error) {
    console.warn('[llm-free-quota] provisioning failed, keeping classic onboarding path:', error);
    return { welcomeBotId: null, justProvisioned: false };
  }
}
