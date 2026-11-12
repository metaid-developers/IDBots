/**
 * Stale model-binding reconcile (HOST-FIX-RFP 2026-09-28, D2 — the zhipu
 * silent-drop incident).
 *
 * The provider catalog is user-editable: providers get renamed, removed, or
 * have their model lists refreshed. Persisted bindings that point INTO the
 * catalog do not age with it — `cowork_sessions.model` / `model_provider`
 * (session-level picks) and `metabots.llm_id` / `llm_provider` (+ the fallback
 * pair) keep naming providers that no longer exist, and every turn then fails
 * at route resolution ("Provider 'zhipu' does not offer enabled model
 * 'glm-5.3'") with, historically, zero user-visible signal until someone
 * reverse-engineered the silence.
 *
 * This startup health check runs right after the legacy llm_id migration and
 * reconciles every stored binding against the LIVE catalog:
 *
 *  - AUTO-REBIND when the model id is offered by exactly ONE enabled provider
 *    — the provider hint is repointed (or filled) and the binding heals with
 *    the exact model the user/bot originally picked. Ambiguous cases (the
 *    model id is offered by several enabled providers) are NEVER guessed:
 *    picking one would silently change billing/keys.
 *  - FLAG when the binding cannot heal (model offered by no enabled provider,
 *    or ambiguous without a valid hint): a warning is logged, the flag is
 *    returned for the caller's report, and flagged SESSIONS get one readable
 *    system message in their transcript (the UI model pickers already render
 *    stale bot brains / session picks red as "unavailable").
 *
 * Like the llm-brain migration this goes through the store update paths (no
 * raw SQL) and never publishes on-chain pins — the next intentional brain edit
 * re-publishes /info/llm. Idempotent: healed bindings validate on the next
 * run, and flagged sessions are not re-noticed while their last message is
 * already the health-check notice.
 *
 * Deps are injected so the reconcile is unit-testable from compiled output
 * against in-memory stores.
 */

import type { Metabot, MetabotUpdate } from '../types/metabot';
import { tApp } from '../libs/appLanguage';
import { canonicalFreeProviderKey, FREE_PROVIDER_DISPLAY_NAME, LLM_FREE_PROVIDER_KEY } from '../../renderer/services/llmFreeQuotaGate.js';

export interface StaleBindingProvider {
  enabled?: boolean;
  models?: Array<{ id?: string }>;
}

export interface StaleBindingAppConfig {
  providers?: Record<string, StaleBindingProvider | undefined>;
}

export interface StaleBindingSessionSummary {
  id: string;
  title?: string | null;
  sessionType?: string | null;
  model?: string | null;
  modelProvider?: string | null;
  /** Last-activity timestamp, used to pin updated_at back after a host notice. */
  updatedAt?: number | null;
}

export interface StaleBindingFlag {
  scope: 'session' | 'bot';
  id: string | number;
  name: string;
  /** Which binding field is stale ('model_provider', 'llm_provider', ...). */
  field: string;
  model: string;
  provider: string | null;
  reason: string;
  /** Session flags only: pre-notice activity timestamp for the liveness pin. */
  updatedAt?: number | null;
  /** Session flags only: 'a2a' transcripts hide system bubbles — never noticed. */
  sessionType?: string | null;
}

export interface StaleModelBindingReconcileDeps {
  metabotStore: {
    listMetabots(): Metabot[];
    updateMetabot(id: number, input: MetabotUpdate): unknown;
  };
  coworkStore: {
    listSessions(): StaleBindingSessionSummary[];
    setSessionModel(id: string, model: string | null, effort?: string | null, modelProvider?: string | null): void;
  };
  getAppConfig: () => StaleBindingAppConfig | null | undefined;
  /** Visible surface for flagged session bindings (system message in the transcript). */
  insertSessionSystemMessage?: (sessionId: string, content: string) => void;
  /** Last transcript message, for notice dedup across app restarts. */
  getLastSessionMessage?: (sessionId: string) => { type?: string; content?: string } | null;
  /**
   * Pin a session's updated_at back after the host-inserted notice so the
   * group-task daemon never reads the notice as member activity (the same
   * liveness guard coworkStore documents for host notices).
   */
  pinSessionUpdatedAt?: (sessionId: string, updatedAtMs: number) => void;
  log?: (message: string) => void;
  warn?: (message: string) => void;
}

export interface StaleModelBindingReconcileResult {
  /** Bindings healed by repointing/filling the provider hint. */
  reboundSessions: number;
  reboundBots: number;
  /** Bindings that cannot heal automatically — see StaleBindingFlag.reason. */
  flagged: StaleBindingFlag[];
}

/** Marker prefix so restarts can tell "already noticed" without parsing. */
const NOTICE_MARKER = '[model-binding]';

/** Enabled provider keys whose catalog offers `modelId`, in config order. */
function enabledProvidersOffering(
  providers: Record<string, StaleBindingProvider | undefined>,
  modelId: string,
): string[] {
  const matches: string[] = [];
  for (const [key, provider] of Object.entries(providers)) {
    if (!provider?.enabled) continue;
    if (provider.models?.some((model) => model?.id === modelId)) matches.push(key);
  }
  return matches;
}

/** True when ANY provider row (enabled or not) lists the model — model-shaped. */
function isKnownModelId(
  providers: Record<string, StaleBindingProvider | undefined>,
  modelId: string,
): boolean {
  for (const provider of Object.values(providers)) {
    if (provider?.models?.some((model) => model?.id === modelId)) return true;
  }
  return false;
}

function providerOffers(
  providers: Record<string, StaleBindingProvider | undefined>,
  providerKey: string,
  modelId: string,
): boolean {
  const needle = providerKey.toLowerCase();
  for (const [key, provider] of Object.entries(providers)) {
    if (key.toLowerCase() !== needle) continue;
    return Boolean(provider?.enabled) && Boolean(provider.models?.some((model) => model?.id === modelId));
  }
  return false;
}

function buildFlagReason(
  candidateCount: number,
  candidates: string[],
): string {
  return candidateCount === 0
    ? 'no enabled provider offers this model'
    : `ambiguous: multiple enabled providers offer this model (${candidates.join(', ')}); provider selection is required`;
}

function buildSessionNotice(flag: StaleBindingFlag): string {
  // User-facing provider label: the built-in relay shows its product name,
  // never the internal provider key (canonical or pre-rename legacy).
  const providerLabel = flag.provider && canonicalFreeProviderKey(flag.provider) === LLM_FREE_PROVIDER_KEY
    ? FREE_PROVIDER_DISPLAY_NAME
    : flag.provider;
  const providerPart = providerLabel
    ? tApp(`（供应商 ${providerLabel}）`, ` (provider ${providerLabel})`)
    : '';
  const reasonPart = flag.reason.startsWith('ambiguous')
    ? tApp(
      `多个已启用供应商都提供该模型（${flag.reason.replace(/^ambiguous: multiple enabled providers offer this model \((.*)\); provider selection is required$/, '$1')}），无法确定使用哪一个`,
      flag.reason,
    )
    : tApp('当前没有任何已启用的供应商提供该模型', flag.reason);
  return tApp(
    `${NOTICE_MARKER} 模型绑定体检：本会话保存的模型「${flag.model}」${providerPart}已无法解析——${reasonPart}。请在会话头部的模型选择器中重新选择模型；修复之前该会话的回合会持续失败（群任务派单会被停泊而不是丢弃）。`,
    `${NOTICE_MARKER} Model-binding health check: this session's saved model '${flag.model}'${providerPart} no longer resolves — ${reasonPart}. Re-pick the model in the session header picker; turns keep failing until you do (group-task dispatches are parked, not dropped).`,
  );
}

/**
 * Reconcile every stored model binding against the live provider catalog.
 * Runs once at startup (after the legacy llm_id migration), best-effort: the
 * caller wraps it in try/catch and a failure never blocks app boot.
 */
export function reconcileStaleModelBindings(
  deps: StaleModelBindingReconcileDeps,
): StaleModelBindingReconcileResult {
  const log = deps.log ?? ((message: string) => console.log(message));
  const warn = deps.warn ?? ((message: string) => console.warn(message));
  const result: StaleModelBindingReconcileResult = { reboundSessions: 0, reboundBots: 0, flagged: [] };

  const appConfig = deps.getAppConfig();
  const providers = appConfig?.providers ?? {};
  if (!appConfig || Object.keys(providers).length === 0) {
    log('[stale-binding-reconcile] skipped: no provider config available');
    return result;
  }

  // --- Session-level picks (cowork_sessions.model / model_provider) ---
  for (const session of deps.coworkStore.listSessions()) {
    const model = session.model?.trim();
    if (!model) continue;
    const hint = session.modelProvider?.trim() || null;
    if (hint && providerOffers(providers, hint, model)) continue; // binding valid

    const candidates = enabledProvidersOffering(providers, model);
    if (candidates.length === 1) {
      deps.coworkStore.setSessionModel(session.id, model, undefined, candidates[0]);
      result.reboundSessions += 1;
      log(
        `[stale-binding-reconcile] session ${session.id}: rebound '${model}' to provider '${candidates[0]}'` +
        `${hint ? ` (was '${hint}')` : ' (hint was empty)'}`,
      );
      continue;
    }
    const flag: StaleBindingFlag = {
      scope: 'session',
      id: session.id,
      name: session.title?.trim() || session.id,
      field: 'model_provider',
      model,
      provider: hint,
      reason: buildFlagReason(candidates.length, candidates),
      updatedAt: typeof session.updatedAt === 'number' ? session.updatedAt : null,
      sessionType: session.sessionType ?? null,
    };
    result.flagged.push(flag);
    warn(`[stale-binding-reconcile] session ${session.id}: '${model}'${hint ? ` @ '${hint}'` : ''} left as-is — ${flag.reason}`);
  }

  // --- Bot-level brains (metabots.llm_* / fallback_llm_*) ---
  const FIELD_PAIRS: Array<{
    modelField: 'llm_id' | 'fallback_llm_id';
    providerField: 'llm_provider' | 'fallback_llm_provider';
  }> = [
    { modelField: 'llm_id', providerField: 'llm_provider' },
    { modelField: 'fallback_llm_id', providerField: 'fallback_llm_provider' },
  ];
  for (const bot of deps.metabotStore.listMetabots()) {
    const update: MetabotUpdate = {};
    const changes: string[] = [];
    for (const { modelField, providerField } of FIELD_PAIRS) {
      const raw = bot[modelField];
      const model = typeof raw === 'string' ? raw.trim() : '';
      if (!model) continue;
      if (!isKnownModelId(providers, model)) {
        // Legacy provider-key-shaped value (or garbage) — the llm-brain
        // migration owns that case and resolution's fallbacks keep the bot
        // runnable; do not double-handle it here.
        continue;
      }
      const hint = typeof bot[providerField] === 'string' ? bot[providerField]!.trim() : '';
      if (hint && providerOffers(providers, hint, model)) continue; // binding valid

      const candidates = enabledProvidersOffering(providers, model);
      if (candidates.length === 1) {
        update[providerField] = candidates[0];
        changes.push(`${providerField} ${hint ? `'${hint}' ` : '(empty) '}-> '${candidates[0]}'`);
        continue;
      }
      const flag: StaleBindingFlag = {
        scope: 'bot',
        id: bot.id,
        name: bot.name,
        field: providerField,
        model,
        provider: hint || null,
        reason: buildFlagReason(candidates.length, candidates),
      };
      result.flagged.push(flag);
      warn(`[stale-binding-reconcile] bot ${bot.id} (${bot.name}): ${modelField} '${model}'${hint ? ` @ '${hint}'` : ''} left as-is — ${flag.reason}`);
    }
    if (Object.keys(update).length > 0) {
      deps.metabotStore.updateMetabot(bot.id, update);
      result.reboundBots += 1;
      log(`[stale-binding-reconcile] bot ${bot.id} (${bot.name}): rebound ${changes.join(', ')}`);
    }
  }

  // --- User-visible notice for flagged sessions (one per session per episode) ---
  if (deps.insertSessionSystemMessage) {
    for (const flag of result.flagged) {
      if (flag.scope !== 'session') continue;
      if (flag.sessionType === 'a2a') continue; // system bubbles are hidden in the A2A view
      const sessionId = String(flag.id);
      try {
        const last = deps.getLastSessionMessage?.(sessionId) ?? null;
        if (last?.type === 'system' && typeof last.content === 'string' && last.content.includes(NOTICE_MARKER)) {
          continue; // already noticed (this or an earlier launch); do not spam
        }
        const previousActivity = typeof flag.updatedAt === 'number' ? flag.updatedAt : null;
        deps.insertSessionSystemMessage(sessionId, buildSessionNotice(flag));
        if (previousActivity != null) deps.pinSessionUpdatedAt?.(sessionId, previousActivity);
      } catch (error) {
        warn(
          `[stale-binding-reconcile] session ${sessionId}: failed to insert the health-check notice: ` +
          `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  log(
    `[stale-binding-reconcile] done: ${result.reboundSessions} session(s) rebound, ` +
    `${result.reboundBots} bot(s) rebound, ${result.flagged.length} binding(s) flagged`,
  );
  return result;
}
