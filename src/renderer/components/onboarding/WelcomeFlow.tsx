/**
 * First-run welcome flow: two full-screen screens (see
 * docs/design/onboarding-v2) shown only while the machine has no Twin Bot.
 *
 * "Enter IDBots" creates that Twin Bot chain-first, seeds a chat session in
 * which the bot has already said hello, and hands the session id back to App,
 * which navigates into it.
 */

import React, { useCallback, useState } from 'react';
import { i18nService } from '../../services/i18n';
import { configService } from '../../services/config';
import { coworkService } from '../../services/cowork';
import { pickTwinBotName } from './twinBotNames.js';
import { clearOnboardingEnterPending, markOnboardingEnterPending } from '../../services/viewState';
import { LLM_FREE_PROVIDER_KEY, pickFreeProviderDefaultModelId } from '../../services/llmFreeQuotaGate.js';
import type { Metabot } from '../../types/metabot';
import { twinBotAvatarUrl } from '../../assets/twinBotAvatar';
import heroWelcomeImage from '../../assets/onboarding/hero-welcome-v2.png';
import heroTwinBotImage from '../../assets/onboarding/hero-twinbot-v4.png';

const TWIN_BOT_ROLE = 'On-chain AI companion';
const TWIN_BOT_SOUL =
  'You are the user\'s Twin Bot on IDBots, their on-chain AI companion and primary assistant. '
  + 'Your name is temporary until the user renames you. You are friendly, concise and practical: you answer questions about IDBots and the AI Internet, '
  + 'help the user pick your name and persona, and otherwise help with whatever they are working on. '
  + 'You are also a citizen of the AI internet it is built by bots like you: when an experience of yours generalizes — a lesson, a method, a solved problem — '
  + 'you are inclined to publish it on-chain so other bots benefit, not just keep it to yourself.';
const TWIN_BOT_GOAL =
  'Be the user\'s dependable on-chain AI companion: help them name and shape you, then assist with their work and questions.';
const TWIN_BOT_BIO =
  'The user\'s Twin Bot on IDBots — their on-chain AI companion.';

const ArrowIcon: React.FC = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2.4}
    strokeLinecap="round"
    strokeLinejoin="round"
    className="h-[17px] w-[17px]"
  >
    <path d="M5 12h14M13 6l6 6-6 6" />
  </svg>
);

/**
 * The i18n title strings carry the line break as '\n' and mark the
 * brand-highlighted tail. The tail uses `text-claude-accent`, the codebase's
 * theme-aware accent-text class (golden yellow on light, brand yellow on dark)
 * — plain `text-brand` is the flat #FFDC51 fill color and is unreadable on the
 * light background.
 */
const WelcomeTitle: React.FC<{ lead: string; highlight: string }> = ({ lead, highlight }) => (
  <h1 className="mb-5 text-[clamp(34px,3.6vw,48px)] font-extrabold leading-[1.1] tracking-[-0.015em]">
    {lead.split('\n').map((line, index) => (
      <React.Fragment key={index}>
        {index > 0 && <br />}
        {line}
      </React.Fragment>
    ))}
    <span className="text-claude-accent">{highlight}</span>
  </h1>
);

/** Accent-colored ink/shape that must stay legible on both themes. */
const ACCENT_INK_BG = 'bg-[rgb(var(--color-accent-text))]';

const Dot: React.FC<{ active: boolean }> = ({ active }) => (
  <span
    className={`h-2 rounded-full ${active ? `w-[26px] ${ACCENT_INK_BG}` : 'w-2 bg-[rgba(148,163,184,0.35)]'}`}
  />
);

const Dots: React.FC<{ step: 1 | 2 }> = ({ step }) => (
  <div className="flex items-center gap-2">
    <Dot active={step === 1} />
    <Dot active={step === 2} />
  </div>
);

const Hero: React.FC<{ src: string; alt: string }> = ({ src, alt }) => (
  <div className="aspect-square w-[min(500px,100%)] overflow-hidden rounded-[28px] shadow-[0_0_0_1px_rgba(255,220,81,0.22),0_0_0_8px_rgba(255,190,80,0.06),0_28px_72px_rgba(0,0,0,0.5),0_0_110px_rgba(255,170,60,0.16)]">
    <img src={src} alt={alt} className="block h-full w-full object-cover" />
  </div>
);

type SetupStatus = 'idle' | 'working' | 'error';

async function listMetaBots(): Promise<Metabot[]> {
  const result = await window.electron.metabot.list();
  return result?.success && Array.isArray(result.list) ? result.list : [];
}

async function findExistingTwin(): Promise<Metabot | null> {
  const bots = await listMetaBots().catch(() => []);
  return bots.find((bot) => bot.metabot_type === 'twin') ?? null;
}

/**
 * The Twin's brain: the provisioned free provider when it is available,
 * otherwise the user's configured default model. Null means the machine has no
 * usable model at all and the bot cannot be created.
 *
 * When the primary brain is the free relay, the backup brain is seeded from
 * the first usable self-configured provider (when one exists) — onboarding
 * users must not have to learn the brain settings to survive the day their
 * free allowance runs out. When no own provider exists yet, the main-process
 * provider watch (services/brainFallbackBackfill) backfills the backup brain
 * the moment the user adds one.
 */
function resolveTwinBrain(): {
  llmId: string;
  llmProvider?: string;
  fallbackLlmId?: string;
  fallbackLlmProvider?: string;
} | null {
  const config = configService.getConfig();
  const freeProvider = config.providers?.[LLM_FREE_PROVIDER_KEY];
  const freeModelId = freeProvider?.enabled ? pickFreeProviderDefaultModelId(freeProvider.models) : '';
  if (freeModelId) {
    return { llmId: freeModelId, llmProvider: LLM_FREE_PROVIDER_KEY, ...(resolveTwinBackupBrain(config) ?? {}) };
  }
  const fallbackModelId = (config.model?.defaultModel ?? '').trim();
  if (!fallbackModelId) {
    return null;
  }
  const fallbackProvider = (config.model?.defaultProvider ?? '').trim();
  return { llmId: fallbackModelId, ...(fallbackProvider ? { llmProvider: fallbackProvider } : {}) };
}

/**
 * The Twin's backup brain at creation time: the first enabled, keyed, non-free
 * provider's default/first model (config order); null when the owner has not
 * configured any provider of their own yet.
 */
function resolveTwinBackupBrain(
  config: ReturnType<typeof configService.getConfig>,
): { fallbackLlmId: string; fallbackLlmProvider: string } | null {
  const defaultModel = (config.model?.defaultModel ?? '').trim();
  for (const [key, provider] of Object.entries(config.providers ?? {})) {
    if (key === LLM_FREE_PROVIDER_KEY) continue;
    if (!provider?.enabled) continue;
    if (key !== 'ollama' && !(provider.apiKey ?? '').trim()) continue;
    const models = (provider.models ?? []).filter((model) => typeof model?.id === 'string' && model.id);
    if (models.length === 0) continue;
    const modelId = defaultModel && models.some((model) => model.id === defaultModel)
      ? defaultModel
      : (models[0].id as string);
    return { fallbackLlmId: modelId, fallbackLlmProvider: key };
  }
  return null;
}

function messageFromError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  return '';
}

/**
 * Create the Twin Bot, or adopt the Twin a previous attempt already created:
 * a chain failure keeps the bot locally (see createMetaBotOnChainCore), so a
 * retry would otherwise die on the UNIQUE name constraint.
 */
async function ensureTwinBot(): Promise<Metabot> {
  const existing = await findExistingTwin();
  if (existing) return existing;

  const brain = resolveTwinBrain();
  if (!brain) {
    throw new Error(i18nService.t('welcomeNoModelError'));
  }
  const identityResult = await window.electron.userIdentity.get().catch(() => null);
  const ownerGlobalMetaId = identityResult?.success
    ? (identityResult.identity?.globalmetaid ?? '').trim()
    : '';
  // The pool name is a placeholder the first chat asks the user to replace, so
  // a fresh pick per attempt is fine — and it keeps a retry after a failed
  // creation from colliding with the name it already reserved.
  const name = pickTwinBotName();
  const result = await window.electron.idbots.createMetaBotOnChain({
    name,
    avatar: twinBotAvatarUrl,
    role: TWIN_BOT_ROLE,
    soul: TWIN_BOT_SOUL,
    goal: TWIN_BOT_GOAL,
    bio: TWIN_BOT_BIO,
    metabot_type: 'twin',
    llm_id: brain.llmId,
    llm_provider: brain.llmProvider ?? null,
    fallback_llm_id: brain.fallbackLlmId ?? null,
    fallback_llm_provider: brain.fallbackLlmProvider ?? null,
    boss_global_metaid: ownerGlobalMetaId || null,
  });
  if (result?.success && result.metabot?.id) {
    return result.metabot;
  }
  const adopted = await findExistingTwin();
  if (adopted) return adopted;
  throw new Error(messageFromError(result?.error) || i18nService.t('welcomeSetupFailed'));
}

/**
 * Create the Twin's first chat and let it greet the user live: the main process
 * runs one agent turn (not persisted as a user message) driven by the
 * onboarding system prompt, and seeds `fallbackGreeting` if that turn cannot
 * greet. The name is interpolated so the bot knows the placeholder it must ask
 * the user to replace.
 */
async function createTwinGreetingSession(twin: Metabot): Promise<string> {
  const result = await window.electron.cowork.createGreetingSession({
    title: i18nService.t('welcomeSessionTitle'),
    systemPrompt: i18nService.t('welcomeFirstSessionSystemPrompt').replace('{name}', twin.name),
    fallbackGreeting: i18nService.t('welcomeGreeting'),
    metabotId: twin.id,
  });
  const sessionId = result?.session?.id;
  if (!result?.success || !sessionId) {
    throw new Error(messageFromError(result?.error) || i18nService.t('welcomeSetupFailed'));
  }
  return sessionId;
}

export interface WelcomeFlowProps {
  /** The Twin Bot chat was created: navigate into this session. */
  onEnterWithBot: (sessionId: string) => void;
  /** The user chose to enter the app without a bot (the flow shows again next launch). */
  onEnterWithoutBot: () => void;
}

const WelcomeFlow: React.FC<WelcomeFlowProps> = ({ onEnterWithBot, onEnterWithoutBot }) => {
  const [step, setStep] = useState<1 | 2>(1);
  const [status, setStatus] = useState<SetupStatus>('idle');
  const [errorDetail, setErrorDetail] = useState('');

  const isWorking = status === 'working';

  const handleEnter = useCallback(async () => {
    if (isWorking) return;
    setStatus('working');
    setErrorDetail('');
    // Recorded before the Twin is created: if the renderer reloads mid-flow,
    // the next launch re-offers this flow (and adopts the Twin that now
    // exists) instead of dropping the user on the New Task home.
    markOnboardingEnterPending();
    try {
      const twin = await ensureTwinBot();
      // The greeting is now a real agent turn: its stream events must reach the
      // store from the first delta, and the shell only mounts after this
      // handler returns. init() is idempotent and registers the listeners
      // app-wide, so CoworkView's own init() call later is a no-op.
      await coworkService.init();
      const sessionId = await createTwinGreetingSession(twin);
      clearOnboardingEnterPending();
      onEnterWithBot(sessionId);
    } catch (error) {
      setErrorDetail(messageFromError(error));
      setStatus('error');
    }
  }, [isWorking, onEnterWithBot]);

  const handleEnterWithoutBot = useCallback(() => {
    clearOnboardingEnterPending();
    onEnterWithoutBot();
  }, [onEnterWithoutBot]);

  return (
    <div className="relative h-screen w-full overflow-hidden bg-main text-content-primary">
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background: step === 1
            ? 'radial-gradient(760px 520px at 76% 46%, rgba(255, 170, 60, 0.14), transparent 65%), radial-gradient(560px 420px at 10% 90%, rgba(34, 211, 238, 0.05), transparent 60%)'
            : 'radial-gradient(760px 520px at 24% 44%, rgba(255, 170, 60, 0.14), transparent 65%), radial-gradient(560px 420px at 92% 88%, rgba(34, 211, 238, 0.05), transparent 60%)',
        }}
      />
      <span className={`absolute left-[44%] top-[120px] h-1.5 w-1.5 ${ACCENT_INK_BG} opacity-[0.45]`} />
      <span className="absolute left-1/2 top-[80px] h-1.5 w-1.5 bg-accent opacity-[0.45]" />
      <span className="absolute left-[42%] top-[680px] h-1.5 w-1.5 bg-accent opacity-25" />

      <div className="relative z-10 flex h-full flex-col px-[clamp(28px,4vw,56px)] pb-[clamp(20px,4vh,36px)] pt-[clamp(44px,6vh,56px)]">
        <div className="draggable flex items-center gap-3">
          <img src="logo.png" alt="IDBots" className="h-9 w-9 rounded-[9px]" style={{ imageRendering: 'pixelated' }} />
          <div className="text-[17px] font-bold tracking-[0.02em]">
            ID<span className="text-claude-accent">Bots</span>
          </div>
        </div>

        <div key={step} className="animate-fade-in-up flex min-h-0 flex-1 items-center gap-[clamp(32px,6vw,72px)]">
          {step === 1 ? (
            <>
              <div className="min-w-0 flex-1">
                <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-[rgba(34,211,238,0.45)] bg-[rgba(34,211,238,0.08)] px-3 py-[5px] text-[11.5px] font-semibold tracking-[0.14em] text-accent">
                  <span className="h-1.5 w-1.5 rounded-[1px] bg-accent" />
                  {i18nService.t('welcomeStep1Badge')}
                </div>
                <WelcomeTitle
                  lead={i18nService.t('welcomeStep1TitleLead')}
                  highlight={i18nService.t('welcomeStep1TitleHighlight')}
                />
                <p className="max-w-[420px] text-[clamp(15px,1.2vw,16.5px)] leading-[1.6] text-content-secondary">
                  {i18nService.t('welcomeStep1Subtitle')}
                </p>
              </div>
              <div className="flex min-h-0 min-w-0 flex-1 items-center justify-center">
                <Hero src={heroWelcomeImage} alt={i18nService.t('welcomeStep1HeroAlt')} />
              </div>
            </>
          ) : (
            <>
              <div className="flex min-h-0 min-w-0 flex-1 items-center justify-center">
                <Hero src={heroTwinBotImage} alt={i18nService.t('welcomeStep2HeroAlt')} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-[rgb(var(--color-accent-text)/0.45)] bg-[rgb(var(--color-accent-text)/0.08)] px-3 py-[5px] text-[11.5px] font-semibold tracking-[0.14em] text-claude-accent">
                  <span className={`h-1.5 w-1.5 rounded-[1px] ${ACCENT_INK_BG}`} />
                  {i18nService.t('welcomeStep2Badge')}
                </div>
                <WelcomeTitle
                  lead={i18nService.t('welcomeStep2TitleLead')}
                  highlight={i18nService.t('welcomeStep2TitleHighlight')}
                />
                <p className="max-w-[420px] text-[clamp(15px,1.2vw,16.5px)] leading-[1.6] text-content-secondary">
                  {i18nService.t('welcomeStep2Subtitle')}
                </p>
              </div>
            </>
          )}
        </div>

        <div className="flex items-center justify-between gap-6">
          <Dots step={step} />
          <div className="flex flex-col items-end gap-2">
            {status === 'working' && (
              <div className="flex items-center gap-2 text-sm text-content-secondary">
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-[rgb(var(--color-accent-text))] border-t-transparent" />
                {i18nService.t('welcomeSettingUp')}
              </div>
            )}
            {status === 'error' && (
              <div className="max-w-[440px] text-right text-sm text-red-500">
                <div className="font-medium">{i18nService.t('welcomeSetupFailed')}</div>
                {errorDetail && <div className="mt-0.5 break-words text-xs text-content-secondary">{errorDetail}</div>}
              </div>
            )}
            <div className="flex items-center gap-3.5">
              {step === 1 ? (
                <button type="button" className="btn-welcome-primary" onClick={() => setStep(2)}>
                  {i18nService.t('welcomeNext')}
                  <ArrowIcon />
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    className="px-3.5 py-2.5 text-sm font-medium text-content-secondary transition-colors hover:text-content-primary disabled:opacity-60"
                    disabled={isWorking}
                    onClick={() => setStep(1)}
                  >
                    {i18nService.t('welcomeBack')}
                  </button>
                  <button
                    type="button"
                    className="btn-welcome-primary"
                    disabled={isWorking}
                    onClick={handleEnter}
                  >
                    {status === 'error' ? i18nService.t('welcomeRetry') : i18nService.t('welcomeEnter')}
                    <ArrowIcon />
                  </button>
                </>
              )}
            </div>
            {step === 2 && status === 'error' && (
              <button
                type="button"
                className="text-xs text-content-secondary underline underline-offset-2 transition-colors hover:text-content-primary"
                onClick={handleEnterWithoutBot}
              >
                {i18nService.t('welcomeEnterWithoutBot')}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default WelcomeFlow;
