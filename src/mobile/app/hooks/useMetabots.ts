import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import type { MobileMetabot, MockSkill } from '../../bridge/types';
import { getMobileElectron, hasAppBridge } from '../appBridge';
import { getMetabotRoster, setMetabotRoster, subscribeMetabotRoster } from '../metabotRosterStore';
import { t } from '../../i18n';
import { buildModelGroupsFromConfig, type CatalogProviderGroup } from '../../../renderer/services/modelCatalog';

export interface MobileBotInput {
  name: string;
  role: string;
  soul: string;
  goal: string;
  bio: string;
  /** Editor-state avatar; undefined = untouched, null = explicitly removed. */
  avatar?: string | null;
  llmId: string;
  llmProvider: string;
  llmEffort: string | null;
  /** Fallback brain, aligned with the desktop Basic tab; '' = none. */
  fallbackLlmId: string;
  fallbackLlmProvider: string;
  fallbackLlmEffort: string | null;
  allowChatSkills: string[];
  /** A2A chat settings, aligned with the desktop Chat Settings tab. */
  a2aAutoReply: boolean;
  a2aMaxIncomingTurns: number;
  a2aByeCooldownMs: number;
}

export interface BotOperationResult {
  state: 'synced' | 'partial' | 'local' | 'failed' | 'uncertain';
  metabot?: MobileMetabot;
  message?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

export function useMetabots(): {
  bots: MobileMetabot[];
  skills: MockSkill[];
  modelGroups: CatalogProviderGroup[];
  loading: boolean;
  error: string | null;
  catalogError: string | null;
  reload: () => Promise<void>;
  createBot: (input: MobileBotInput) => Promise<BotOperationResult>;
  updateBot: (id: number, input: MobileBotInput) => Promise<BotOperationResult>;
  resumeBot: (id: number, mode: 'subsidized' | 'self-funded') => Promise<BotOperationResult>;
  syncBot: (id: number) => Promise<BotOperationResult>;
  setBotEnabled: (id: number, enabled: boolean) => Promise<BotOperationResult>;
  getBotBalance: (id: number) => Promise<{ success: boolean; value?: string; error?: string }>;
} {
  const bots = useSyncExternalStore(subscribeMetabotRoster, getMetabotRoster, getMetabotRoster);
  const [skills, setSkills] = useState<MockSkill[]>([]);
  const [modelGroups, setModelGroups] = useState<CatalogProviderGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!hasAppBridge()) {
      setError(t('mobile.chat.rosterUnavailable'));
      setCatalogError(t('mobile.me.botCatalogUnavailable'));
      setLoading(false);
      return;
    }
    setLoading(true);
    const [rosterResult, skillsResult, configResult] = await Promise.allSettled([
      getMobileElectron().metabot.list(),
      getMobileElectron().skills.list(),
      getMobileElectron().store.get('app_config'),
    ]);
    if (rosterResult.status === 'fulfilled' && rosterResult.value?.success && Array.isArray(rosterResult.value.list)) {
      setMetabotRoster(rosterResult.value.list);
      setError(null);
    } else {
      setError(t('mobile.chat.rosterUnavailable'));
    }
    if (skillsResult.status === 'fulfilled' && skillsResult.value?.success && Array.isArray(skillsResult.value.skills)) {
      setSkills(skillsResult.value.skills.filter((skill) => skill.enabled));
    }
    if (configResult.status === 'fulfilled') {
      setModelGroups(buildModelGroupsFromConfig((configResult.value ?? {}) as Parameters<typeof buildModelGroupsFromConfig>[0]));
      setCatalogError(null);
    } else {
      setCatalogError(t('mobile.me.botCatalogUnavailable'));
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const createBot = useCallback(async (input: MobileBotInput): Promise<BotOperationResult> => {
    try {
      const result = await getMobileElectron().idbots.createMetaBotOnChain({
        name: input.name,
        metabot_type: 'worker',
        role: input.role,
        soul: input.soul,
        goal: input.goal || null,
        bio: input.bio,
        llm_id: input.llmId,
        llm_provider: input.llmProvider || null,
        llm_effort: input.llmEffort,
        fallback_llm_id: input.fallbackLlmId || null,
        fallback_llm_provider: input.fallbackLlmProvider || null,
        fallback_llm_effort: input.fallbackLlmEffort,
        allow_chat_skills: input.allowChatSkills,
      });
      await reload();
      if (!result?.success) return { state: 'failed', metabot: result?.metabot, message: result?.error };
      if (result.chainSetupPending) {
        return { state: 'local', metabot: result.metabot, message: result.chainError || result.subsidy?.error };
      }
      if (result.chainPartial) {
        return { state: 'partial', metabot: result.metabot, message: result.chainError };
      }
      return result.metabot
        ? { state: 'synced', metabot: result.metabot }
        : { state: 'uncertain', message: 'The create result did not include the Bot' };
    } catch (error) {
      await reload();
      return { state: 'uncertain', message: errorMessage(error) };
    }
  }, [reload]);

  const updateBot = useCallback(async (id: number, input: MobileBotInput): Promise<BotOperationResult> => {
    try {
      const result = await getMobileElectron().metabot.update(id, {
        name: input.name,
        // undefined keys are dropped by the gateway's JSON frame, so an
        // untouched avatar (undefined) never reaches the handler, while an
        // explicit null removes it — matching metabot:update semantics.
        avatar: input.avatar,
        role: input.role,
        soul: input.soul,
        goal: input.goal || null,
        bio: input.bio,
        llm_id: input.llmId,
        llm_provider: input.llmProvider || null,
        llm_effort: input.llmEffort,
        fallback_llm_id: input.fallbackLlmId || null,
        fallback_llm_provider: input.fallbackLlmProvider || null,
        fallback_llm_effort: input.fallbackLlmEffort,
        allow_chat_skills: input.allowChatSkills,
        a2a_auto_reply_enabled: input.a2aAutoReply,
        a2a_max_incoming_turns: input.a2aMaxIncomingTurns,
        a2a_bye_cooldown_ms: input.a2aByeCooldownMs,
      });
      await reload();
      if (!result?.metabot) return { state: 'failed', message: result?.error || 'Bot update failed' };
      if (!result?.success) return { state: 'partial', metabot: result.metabot, message: result.error || result.sync?.error };
      if (result.sync && !result.sync.skipped && !result.sync.success) {
        return { state: 'partial', metabot: result.metabot, message: result.sync.error };
      }
      return { state: 'synced', metabot: result.metabot };
    } catch (error) {
      await reload();
      return { state: 'uncertain', message: errorMessage(error) };
    }
  }, [reload]);

  const resumeBot = useCallback(async (id: number, mode: 'subsidized' | 'self-funded'): Promise<BotOperationResult> => {
    try {
      const result = await getMobileElectron().idbots.resumeMetabotSetup({ metabotId: id, mode });
      await reload();
      if (result?.success) return { state: 'synced', metabot: result.metabot };
      return {
        state: result?.selfFundedBlocked ? 'failed' : 'partial',
        metabot: result?.metabot,
        message: result?.error || result?.chain?.error || result?.subsidy?.error,
      };
    } catch (error) {
      await reload();
      return { state: 'uncertain', message: errorMessage(error) };
    }
  }, [reload]);

  const syncBot = useCallback(async (id: number): Promise<BotOperationResult> => {
    try {
      const result = await getMobileElectron().idbots.syncMetaBot(id);
      await reload();
      return result?.success
        ? { state: 'synced' }
        : { state: 'partial', message: result?.error || 'Chain sync is still pending' };
    } catch (error) {
      await reload();
      return { state: 'uncertain', message: errorMessage(error) };
    }
  }, [reload]);

  const setBotEnabled = useCallback(async (id: number, enabled: boolean): Promise<BotOperationResult> => {
    try {
      const result = await getMobileElectron().metabot.setEnabled(id, enabled);
      await reload();
      return result?.success
        ? { state: 'synced', metabot: result.metabot }
        : { state: 'failed', message: result?.error };
    } catch (error) {
      return { state: 'uncertain', message: errorMessage(error) };
    }
  }, [reload]);

  const getBotBalance = useCallback(async (id: number) => {
    try {
      const result = await getMobileElectron().idbots.getAddressBalance({ metabotId: id });
      if (!result?.success) return { success: false, error: result?.error || 'Balance unavailable' };
      const mvc = result.balance?.mvc;
      if (!mvc || !Number.isFinite(mvc.value)) return { success: false, error: 'MVC balance unavailable' };
      return { success: true, value: `${mvc.value} ${mvc.unit}` };
    } catch (error) {
      return { success: false, error: errorMessage(error) };
    }
  }, []);

  return {
    bots,
    skills,
    modelGroups,
    loading,
    error,
    catalogError,
    reload,
    createBot,
    updateBot,
    resumeBot,
    syncBot,
    setBotEnabled,
    getBotBalance,
  };
}
