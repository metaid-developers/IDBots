import { useEffect, useState } from 'react';
import { ArrowPathIcon, PlayIcon } from '@heroicons/react/24/outline';
import type { MobileMetabot } from '../../bridge/types';
import { t } from '../../i18n';
import type { useMetabots, BotOperationResult } from '../hooks/useMetabots';
import { Switch } from '../components/Switch';
import { useBotAutomation } from './useBotAutomation';
import {
  DAILY_REPORT_ENABLED_KEY,
  DAILY_REPORT_HOUR_KEY,
  SURF_BEFORE_DREAM_ENABLED_KEY,
  SURF_CREATION_BUDGET_KEY,
  SURF_CREATION_MODE_KEY,
  SURF_INTERACTION_BUDGET_KEY,
  SURF_CREATION_MODES,
  clampBudget,
} from './botAutomationModel';

export type BotAutomationActions = Pick<ReturnType<typeof useMetabots>, 'setBotEnabled' | 'syncBot' | 'resumeBot'>;

export function BotAutomationSection(props: {
  bot: MobileMetabot;
  actions: BotAutomationActions;
  onOpenSession?: (sessionId: string) => Promise<boolean>;
  highlightRunId?: string;
}): JSX.Element {
  const controller = useBotAutomation(props.bot.id, props.bot.metabot_type);
  const [interactionBudget, setInteractionBudget] = useState(String(controller.settings.interactionBudget));
  const [creationBudget, setCreationBudget] = useState(String(controller.settings.creationBudget));
  const [operation, setOperation] = useState<BotOperationResult | null>(null);
  const [operationBusy, setOperationBusy] = useState(false);
  const [reportReady, setReportReady] = useState(false);
  const chainState = props.bot.chain_sync_state ?? (props.bot.metabot_info_pinid ? 'synced' : 'partial');

  useEffect(() => {
    if (!controller.loaded) return;
    setInteractionBudget(String(controller.settings.interactionBudget));
    setCreationBudget(String(controller.settings.creationBudget));
  }, [controller.loaded, controller.settings.interactionBudget, controller.settings.creationBudget]);

  const runOperation = async (action: () => Promise<BotOperationResult>) => {
    setOperationBusy(true);
    setOperation(null);
    try {
      setOperation(await action());
    } finally {
      setOperationBusy(false);
    }
  };

  const commit = async (key: string, value: string) => {
    if (!await controller.saveSetting(key, value)) await controller.reload();
  };
  const disabled = controller.saving || !controller.loaded;
  const dailyDisabled = disabled || !controller.settings.experimentalAutomation;

  return (
    <div className="space-y-3" data-testid="bot-automation-page">
      <section className="twin-panel twin-panel-padded space-y-3" data-testid="bot-operational-status">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="twin-list-title">{t('mobile.automation.statusTitle')}</h2>
            <p className={`text-xs ${chainState === 'synced' ? 'text-emerald-600' : 'text-amber-600'}`} data-testid="bot-automation-chain-state">
              {chainState === 'synced' ? t('mobile.me.botChainSynced') : t('mobile.me.botChainPending', { steps: props.bot.chain_sync_pending_steps?.join(', ') ?? '' })}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-[var(--text-secondary)]">{props.bot.enabled ? t('mobile.tasks.enabled') : t('mobile.tasks.disabled')}</span>
            <Switch
              checked={props.bot.enabled}
              disabled={operationBusy}
              onChange={(enabled) => void runOperation(() => props.actions.setBotEnabled(props.bot.id, enabled))}
              label={props.bot.enabled ? t('mobile.tasks.enabled') : t('mobile.tasks.disabled')}
            />
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {chainState !== 'synced' ? (
            <button type="button" className="twin-button twin-button-secondary" disabled={operationBusy} onClick={() => void runOperation(() => props.actions.syncBot(props.bot.id))}>
              <ArrowPathIcon className="h-4 w-4" aria-hidden />{t('mobile.me.botSync')}
            </button>
          ) : null}
          {props.bot.subsidy_state === 'failed' ? (
            <>
              <button type="button" className="twin-button twin-button-secondary" disabled={operationBusy} onClick={() => void runOperation(() => props.actions.resumeBot(props.bot.id, 'subsidized'))}>{t('mobile.me.botResume')}</button>
              <button type="button" className="twin-button twin-button-secondary" disabled={operationBusy} onClick={() => void runOperation(() => props.actions.resumeBot(props.bot.id, 'self-funded'))}>{t('mobile.me.botSelfFundResume')}</button>
            </>
          ) : null}
        </div>
        {operation ? <p className="text-xs text-[var(--text-secondary)]" data-testid="bot-automation-operation">{t(`mobile.me.botOutcome.${operation.state}`)}{operation.message ? ` · ${operation.message}` : ''}</p> : null}
      </section>

      <section className="twin-panel twin-panel-padded">
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm text-[var(--text-primary)]">{t('mobile.automation.masterSwitch')}</span>
          <Switch
            checked={controller.settings.experimentalAutomation}
            disabled={disabled}
            onChange={(enabled) => void controller.setExperimentalAutomation(enabled)}
            label={t('mobile.automation.masterSwitch')}
          />
        </div>
        <p className="mt-1 text-xs text-[var(--text-secondary)]">{t('mobile.automation.masterHint')}</p>
      </section>

      <section className="twin-panel twin-panel-padded space-y-3" data-testid="bot-surf-settings">
        <div>
          <h2 className="twin-list-title">{t('mobile.automation.surfTitle')}</h2>
          <p className="text-xs text-[var(--text-secondary)]">{t('mobile.automation.surfHint')}</p>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm text-[var(--text-primary)]">{t('mobile.automation.surfBeforeDream')}</span>
          <Switch
            checked={controller.settings.surfBeforeDream}
            disabled={disabled}
            onChange={(enabled) => void commit(SURF_BEFORE_DREAM_ENABLED_KEY, enabled ? '1' : '0')}
            label={t('mobile.automation.surfBeforeDream')}
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <label className="twin-label" htmlFor="bot-surf-interaction-budget">
            {t('mobile.automation.interactionBudget')}
            <input
              id="bot-surf-interaction-budget"
              type="number"
              min={0}
              max={500}
              className="twin-input"
              value={interactionBudget}
              disabled={disabled}
              onChange={(event) => setInteractionBudget(event.target.value)}
              onBlur={() => {
                const next = clampBudget(interactionBudget, controller.settings.interactionBudget, 500);
                setInteractionBudget(String(next));
                if (next !== controller.settings.interactionBudget) void commit(SURF_INTERACTION_BUDGET_KEY, String(next));
              }}
            />
          </label>
          <label className="twin-label" htmlFor="bot-surf-creation-budget">
            {t('mobile.automation.creationBudget')}
            <input
              id="bot-surf-creation-budget"
              type="number"
              min={0}
              max={20}
              className="twin-input"
              value={creationBudget}
              disabled={disabled}
              onChange={(event) => setCreationBudget(event.target.value)}
              onBlur={() => {
                const next = clampBudget(creationBudget, controller.settings.creationBudget, 20);
                setCreationBudget(String(next));
                if (next !== controller.settings.creationBudget) void commit(SURF_CREATION_BUDGET_KEY, String(next));
              }}
            />
          </label>
        </div>
        <p className="text-xs text-[var(--text-secondary)]">{t('mobile.automation.budgetHint')}</p>
        <label className="twin-label" htmlFor="bot-surf-creation-mode">
          {t('mobile.automation.creationMode')}
          <select
            id="bot-surf-creation-mode"
            className="twin-input"
            value={controller.settings.creationMode}
            disabled={disabled}
            onChange={(event) => void commit(SURF_CREATION_MODE_KEY, event.target.value)}
          >
            {SURF_CREATION_MODES.map((mode) => <option key={mode} value={mode}>{t(`mobile.automation.creationMode.${mode}`)}</option>)}
          </select>
        </label>
        <button
          type="button"
          className="twin-button twin-button-primary twin-button-full"
          disabled={controller.busy !== null || controller.runningId !== null}
          onClick={() => void controller.runSurf()}
          data-testid="bot-surf-run-now"
        >
          <PlayIcon className="h-4 w-4" aria-hidden />
          {controller.runningId ? t('mobile.automation.surfRunning') : t('mobile.automation.surfNow')}
        </button>
      </section>

      {props.bot.metabot_type === 'twin' ? (
        <section className={`twin-panel twin-panel-padded space-y-3 ${dailyDisabled ? 'opacity-60' : ''}`} data-testid="bot-daily-settings">
          <div>
            <h2 className="twin-list-title">{t('mobile.automation.dailyTitle')}</h2>
            <p className="text-xs text-[var(--text-secondary)]">{t('mobile.automation.dailyHint')}</p>
          </div>
          {!controller.settings.experimentalAutomation ? <p className="text-xs text-amber-600">{t('mobile.automation.dailyGateRequired')}</p> : null}
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm text-[var(--text-primary)]">{t('mobile.automation.dailyEnabled')}</span>
            <Switch
              checked={controller.settings.dailyEnabled}
              disabled={dailyDisabled}
              onChange={(enabled) => void commit(DAILY_REPORT_ENABLED_KEY, enabled ? '1' : '0')}
              label={t('mobile.automation.dailyEnabled')}
            />
          </div>
          <label className="twin-label" htmlFor="bot-daily-hour">
            {t('mobile.automation.dailyHour')}
            <select
              id="bot-daily-hour"
              className="twin-input"
              value={controller.settings.dailyHour}
              disabled={dailyDisabled}
              onChange={(event) => void commit(DAILY_REPORT_HOUR_KEY, event.target.value)}
            >
              {Array.from({ length: 24 }, (_, hour) => <option key={hour} value={hour}>{String(hour).padStart(2, '0')}:00</option>)}
            </select>
          </label>
          <button
            type="button"
            className="twin-button twin-button-secondary twin-button-full"
            disabled={dailyDisabled || !controller.settings.dailyEnabled || controller.busy !== null}
            onClick={() => {
              setReportReady(false);
              void controller.runDaily().then(async (sessionId) => {
                if (!sessionId) return;
                setReportReady(true);
                if (props.onOpenSession && !await props.onOpenSession(sessionId)) controller.setError(t('mobile.automation.openResultFailed'));
              });
            }}
            data-testid="bot-daily-run-now"
          >
            <PlayIcon className="h-4 w-4" aria-hidden />
            {controller.busy === 'daily' ? t('mobile.automation.dailyRunning') : t('mobile.automation.dailyNow')}
          </button>
          {reportReady ? <p className="text-sm text-emerald-600" role="status">{t('mobile.automation.dailyReady')}</p> : null}
        </section>
      ) : null}

      {controller.error ? (
        <div className="twin-notice twin-notice-error" role="alert">
          <p>{controller.error}</p>
          <button type="button" className="min-h-[44px]" onClick={() => void controller.reload()}>{t('mobile.common.retry')}</button>
        </div>
      ) : null}

      <section className="space-y-2" data-testid="bot-surf-reports">
        <div className="flex items-center justify-between gap-2">
          <h2 className="twin-section-label">{t('mobile.automation.reportsTitle')}</h2>
          <button type="button" className="min-h-[44px] px-2 text-xs text-[var(--text-primary)]" onClick={() => void controller.reloadRuns()}>
            {t('mobile.common.retry')}
          </button>
        </div>
        {controller.runs.length === 0 ? <p className="twin-empty-copy">{t('mobile.automation.noReports')}</p> : null}
        {controller.runs.map((run) => (
          <details key={run.id} className="twin-panel twin-panel-padded" data-testid={`surf-run-${run.id}`} open={props.highlightRunId === run.id}>
            <summary className="min-h-[44px] cursor-pointer text-sm">
              {new Date(run.createdAt).toLocaleString()} · {t(`mobile.automation.status.${run.status}`)}
            </summary>
            <p className="text-xs text-[var(--text-secondary)]">{t(`mobile.automation.trigger.${run.trigger}`)}</p>
            <p className="mt-2 text-xs text-[var(--text-secondary)]">
              {t('mobile.automation.runStats', { fetched: run.stats.fetched, saved: run.stats.savedToKb, posted: run.stats.posted })}
            </p>
            {run.error ? <p className="mt-2 whitespace-pre-wrap break-words text-xs text-red-600">{run.error}</p> : null}
            {run.reportMarkdown ? <pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-[var(--bg-main)] p-3 text-xs text-[var(--text-primary)]">{run.reportMarkdown}</pre> : null}
          </details>
        ))}
      </section>
    </div>
  );
}
