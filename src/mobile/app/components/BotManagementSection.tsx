import { useState } from 'react';
import { PencilSquareIcon, PlusIcon } from '@heroicons/react/24/outline';
import { t } from '../../i18n';
import type { MobileMetabot } from '../../bridge/types';
import { useMetabots, type BotOperationResult } from '../hooks/useMetabots';
import { sortBotsForList } from '../botList';
import { BotAvatar } from './BotAvatar';
import { TwinBadge } from './TwinBadge';
import { BotEditorForm, type EditorBrainOption } from './BotEditorForm';
import { BottomSheet } from './BottomSheet';
import { Section } from './Section';
import { Switch } from './Switch';

interface BotFormState {
  bot: MobileMetabot | null;
  busy: boolean;
  outcome: BotOperationResult | null;
}

/**
 * Me → MetaBots section (UX batch 2026-10-28).
 * List rows render avatar + name + role, sorted Twin-first then
 * created_at ascending (see src/mobile/app/botList.ts).
 */
export function BotManagementSection(): JSX.Element {
  const manager = useMetabots();
  const [formState, setFormState] = useState<BotFormState | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [problem, setProblem] = useState<BotOperationResult | null>(null);
  const brainOptions: EditorBrainOption[] = manager.modelGroups.flatMap((group) => group.models.map((model) => ({
    providerKey: group.id,
    modelId: model.id,
    label: `${group.name} · ${model.name}`,
  })));
  const sortedBots = sortBotsForList(manager.bots);

  const runRowAction = async (id: number, action: () => Promise<BotOperationResult>) => {
    setBusyId(id);
    setProblem(null);
    try {
      const result = await action();
      if (result.state === 'synced') setNotice(t('mobile.me.botSyncConfirmed'));
      else setProblem(result);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Section title={t('mobile.me.botsTitle')}>
      {notice ? <p className="mb-2 text-sm text-emerald-600" aria-live="polite">{notice}</p> : null}
      {problem ? (
        <div className="mb-2 rounded-xl border border-amber-300 bg-amber-50 p-3 text-amber-800" data-testid="bot-row-problem">
          <p className="text-sm font-medium">{t(`mobile.me.botOutcome.${problem.state}`)}</p>
          {problem.message ? <p className="mt-1 break-words text-xs">{problem.message}</p> : null}
        </div>
      ) : null}
      {manager.loading ? <p className="py-2 text-sm text-[var(--text-secondary)]">{t('mobile.common.loading')}</p> : null}
      {manager.error ? (
        <div className="mb-2 flex items-center justify-between gap-2">
          <p className="text-xs text-red-600">{manager.error}</p>
          <button type="button" onClick={() => void manager.reload()} className="min-h-[44px] px-2 text-xs text-[var(--text-primary)]">
            {t('mobile.common.retry')}
          </button>
        </div>
      ) : null}
      {sortedBots.map((bot) => {
        const chainState = bot.chain_sync_state ?? (bot.metabot_info_pinid ? 'synced' : 'partial');
        const pendingSteps = bot.chain_sync_pending_steps ?? [];
        return (
          <div key={bot.id} className="border-b border-[var(--border-color)] py-3 last:border-b-0" data-testid={`bot-row-${bot.id}`}>
            <div className="flex min-h-[44px] items-center gap-2">
              <BotAvatar name={bot.name} avatar={bot.avatar} testId={`bot-avatar-${bot.id}`} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[15px] text-[var(--text-primary)]">
                  {bot.name}
                  {bot.metabot_type === 'twin' ? (
                    <span className="ml-2 inline-flex"><TwinBadge /></span>
                  ) : (
                    <span className="ml-2 text-xs text-[var(--text-secondary)]">{t('mobile.me.botType.worker')}</span>
                  )}
                </p>
                {bot.role ? (
                  <p className="truncate text-xs text-[var(--text-secondary)]" data-testid={`bot-role-${bot.id}`}>
                    {bot.role}
                  </p>
                ) : null}
                <p
                  className={`mt-1 text-xs ${chainState === 'synced' ? 'text-emerald-600' : 'text-amber-600'}`}
                  data-testid={`bot-chain-${bot.id}`}
                  data-state={chainState}
                >
                  {chainState === 'synced'
                    ? t('mobile.me.botChainSynced')
                    : t('mobile.me.botChainPending', { steps: pendingSteps.join(', ') })}
                </p>
                {busyId === bot.id ? (
                  <p className="mt-1 text-xs text-[var(--text-secondary)]" data-testid={`bot-syncing-${bot.id}`} aria-live="polite">
                    {t('mobile.me.botSyncing')}
                  </p>
                ) : null}
              </div>
              <Switch
                checked={bot.enabled}
                disabled={busyId === bot.id}
                onChange={(checked) => void runRowAction(bot.id, () => manager.setBotEnabled(bot.id, checked))}
                label={`${bot.name} · ${t(bot.enabled ? 'mobile.tasks.enabled' : 'mobile.tasks.disabled')}`}
              />
              <button
                type="button"
                onClick={() => setFormState({ bot, busy: false, outcome: null })}
                aria-label={`${t('mobile.me.botEdit')} · ${bot.name}`}
                className="flex min-h-[44px] min-w-[44px] items-center justify-center text-[var(--text-secondary)] active:text-[var(--text-primary)]"
              >
                <PencilSquareIcon className="h-5 w-5" aria-hidden />
              </button>
            </div>
            {chainState === 'partial' ? (
              <div className="mt-1 flex flex-wrap gap-2">
                {bot.subsidy_state === 'failed' ? (
                  <>
                    <button
                      type="button"
                      disabled={busyId === bot.id}
                      onClick={() => void runRowAction(bot.id, () => manager.resumeBot(bot.id, 'subsidized'))}
                      className="min-h-[44px] rounded-lg border border-amber-400 px-3 text-xs text-amber-700"
                    >
                      {t('mobile.me.botResume')}
                    </button>
                    <button
                      type="button"
                      disabled={busyId === bot.id}
                      onClick={() => void runRowAction(bot.id, () => manager.resumeBot(bot.id, 'self-funded'))}
                      className="min-h-[44px] rounded-lg border border-amber-400 px-3 text-xs text-amber-700"
                    >
                      {t('mobile.me.botSelfFundResume')}
                    </button>
                  </>
                ) : null}
                <button
                  type="button"
                  disabled={busyId === bot.id}
                  onClick={() => void runRowAction(bot.id, () => manager.syncBot(bot.id))}
                  className="min-h-[44px] rounded-lg border border-[var(--border-color)] px-3 text-xs text-[var(--text-primary)]"
                >
                  {t('mobile.me.botSync')}
                </button>
              </div>
            ) : null}
          </div>
        );
      })}
      <button
        type="button"
        onClick={() => setFormState({ bot: null, busy: false, outcome: null })}
        className="mt-2 flex min-h-[44px] w-full items-center justify-center gap-1 rounded-xl border border-[var(--border-color)] py-2 text-sm text-[var(--text-primary)] active:bg-[var(--bg-hover)]"
        data-testid="bot-create"
      >
        <PlusIcon className="h-4 w-4" aria-hidden />
        {t('mobile.me.botCreate')}
      </button>
      {formState ? (
        <BottomSheet
          title={formState.bot ? t('mobile.me.botEdit') : t('mobile.me.botCreate')}
          onClose={formState.busy ? () => undefined : () => setFormState(null)}
        >
          <BotEditorForm
            key={formState.bot?.id ?? 'new'}
            state={formState}
            brainOptions={brainOptions}
            skills={manager.skills}
            catalogError={manager.catalogError}
            getBalance={manager.getBotBalance}
            onClose={() => setFormState(null)}
            onSave={async (input) => {
              const editing = formState.bot;
              setFormState((current) => current ? { ...current, busy: true, outcome: null } : current);
              const result = editing ? await manager.updateBot(editing.id, input) : await manager.createBot(input);
              if (result.state === 'synced') {
                setNotice(t(editing ? 'mobile.me.botUpdated' : 'mobile.me.botCreatedSynced'));
                setFormState(null);
                return;
              }
              setFormState((current) => current ? { ...current, busy: false, outcome: result } : current);
            }}
          />
        </BottomSheet>
      ) : null}
    </Section>
  );
}
