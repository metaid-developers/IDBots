/**
 * Daily Report ("每日主动简报") row for the MetaBot editor's Advanced tab (Twin-only).
 * Unified into a single Studio Linear row: [Icon + Title + Hint] on left,
 * [Hour Select + Run Now Button + Enable Switch] on right.
 */

import React, { useEffect, useState } from 'react';
import { NewspaperIcon, PlayIcon, QuestionMarkCircleIcon } from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import {
  buildMetaBotToggleViewModel,
  METABOT_BTN_FLAT_CLASS,
  METABOT_COMPACT_SELECT_CLASS,
  METABOT_GROUP_ROW_CLASS,
  METABOT_MICRO_BADGE_CLASS,
  METABOT_ROW_HINT_CLASS,
  METABOT_ROW_ICON_CLASS,
  METABOT_ROW_TITLE_CLASS,
} from './metaBotCardPresentation.js';
import TwinBadge from './TwinBadge';
import Tooltip from '../ui/Tooltip';

const DAILY_REPORT_ENABLED_KEY = 'dailyReport.enabled';
const DAILY_REPORT_HOUR_KEY = 'dailyReport.hour';
const DEFAULT_DAILY_REPORT_HOUR = 8;
const MIN_DAILY_REPORT_HOUR = 0;
const MAX_DAILY_REPORT_HOUR = 23;

const getDailyReportApi = (): typeof window.electron.dailyReport | null =>
  (typeof window.electron?.dailyReport?.runNow === 'function' ? window.electron.dailyReport : null);

const DAILY_REPORT_UNAVAILABLE_REASON_KEYS: Record<string, string> = {
  no_twin: 'dailyReportRunNowUnavailableNoTwin',
  experimental_disabled: 'dailyReportRunNowUnavailableExperimentalOff',
  feature_disabled: 'dailyReportRunNowUnavailableDisabled',
  deferred: 'dailyReportRunNowUnavailableFreshInstall',
  already_running: 'dailyReportRunNowAlreadyRunning',
};

const clampHour = (raw: string): number | null => {
  const num = Number(raw);
  if (!Number.isFinite(num)) return null;
  return Math.min(MAX_DAILY_REPORT_HOUR, Math.max(MIN_DAILY_REPORT_HOUR, Math.round(num)));
};

const formatHourOptionLabel = (hour: number): string => `${String(hour).padStart(2, '0')}:00`;

interface DailyReportSectionProps {
  metabotId: number;
}

const DailyReportSection: React.FC<DailyReportSectionProps> = ({ metabotId }) => {
  const [enabled, setEnabled] = useState(false);
  const [enabledLoaded, setEnabledLoaded] = useState(false);
  const [hour, setHour] = useState(String(DEFAULT_DAILY_REPORT_HOUR));
  const [experimentalAllowed, setExperimentalAllowed] = useState(true);
  const [settingsError, setSettingsError] = useState('');
  const [runNowBusy, setRunNowBusy] = useState(false);
  const [runNowNote, setRunNowNote] = useState<{ kind: 'success' | 'info' | 'error'; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setEnabled(false);
    setEnabledLoaded(false);
    setHour(String(DEFAULT_DAILY_REPORT_HOUR));
    setSettingsError('');
    setRunNowNote(null);
    window.electron.metabot.getSetting(metabotId, DAILY_REPORT_ENABLED_KEY)
      .then((result) => {
        if (cancelled) return;
        setEnabled(result.success ? result.value === '1' : false);
        setEnabledLoaded(true);
      })
      .catch(() => {
        if (cancelled) return;
        setEnabled(false);
        setEnabledLoaded(true);
      });
    window.electron.metabot.getSetting(metabotId, DAILY_REPORT_HOUR_KEY)
      .then((result) => {
        if (cancelled) return;
        const clamped = result.success && result.value != null ? clampHour(result.value) : null;
        setHour(String(clamped === null ? DEFAULT_DAILY_REPORT_HOUR : clamped));
      })
      .catch(() => {
        if (cancelled) return;
        setHour(String(DEFAULT_DAILY_REPORT_HOUR));
      });
    return () => { cancelled = true; };
  }, [metabotId]);

  useEffect(() => {
    let cancelled = false;
    window.electron.experimentalAutomation.get()
      .then(({ enabled: allowed }) => {
        if (cancelled) return;
        setExperimentalAllowed(allowed);
      })
      .catch(() => {
        if (cancelled) return;
        setExperimentalAllowed(true);
      });
    return () => { cancelled = true; };
  }, []);

  const enabledToggleView = buildMetaBotToggleViewModel({
    enabled,
    disabled: !enabledLoaded || !experimentalAllowed,
  });

  const handleEnabledToggle = () => {
    if (!enabledLoaded || !experimentalAllowed) return;
    const next = !enabled;
    setEnabled(next);
    setSettingsError('');
    const revert = (message: string) => {
      setEnabled(!next);
      setSettingsError(message);
    };
    window.electron.metabot.setSetting(metabotId, DAILY_REPORT_ENABLED_KEY, next ? '1' : '0')
      .then((result) => {
        if (!result.success) revert(result.error || i18nService.t('dailyReportSettingSaveFailed'));
      })
      .catch(() => revert(i18nService.t('dailyReportSettingSaveFailed')));
  };

  const handleHourChange = (next: string) => {
    if (!experimentalAllowed) return;
    const prev = hour;
    setHour(next);
    setSettingsError('');
    window.electron.metabot.setSetting(metabotId, DAILY_REPORT_HOUR_KEY, next)
      .then((result) => {
        if (!result.success) {
          setHour(prev);
          setSettingsError(result.error || i18nService.t('dailyReportSettingSaveFailed'));
        }
      })
      .catch(() => {
        setHour(prev);
        setSettingsError(i18nService.t('dailyReportSettingSaveFailed'));
      });
  };

  const handleRunNow = () => {
    if (runNowBusy || !enabled || !enabledLoaded || !experimentalAllowed) return;
    const api = getDailyReportApi();
    if (!api || typeof api.runNow !== 'function') {
      setRunNowNote({ kind: 'error', text: i18nService.t('dailyReportRunNowUnavailable').replace('{reason}', 'dailyReport ipc not registered') });
      return;
    }
    setRunNowBusy(true);
    setRunNowNote(null);
    api.runNow()
      .then((result) => {
        if (!result || typeof result !== 'object') {
          setRunNowNote({ kind: 'error', text: i18nService.t('dailyReportRunNowFailed').replace('{error}', 'unknown') });
          return;
        }
        switch (result.status) {
          case 'completed':
            if (result.sessionId) {
              window.dispatchEvent(new CustomEvent('cowork:viewSession', { detail: { sessionId: result.sessionId } }));
            }
            setRunNowNote({ kind: 'success', text: i18nService.t('dailyReportRunNowCompleted') });
            break;
          case 'skipped':
            setRunNowNote({ kind: 'info', text: i18nService.t('dailyReportRunNowSkipped') });
            break;
          case 'failed':
            setRunNowNote({ kind: 'error', text: i18nService.t('dailyReportRunNowFailed').replace('{error}', result.error || 'unknown') });
            break;
          case 'unavailable': {
            const reasonKey = DAILY_REPORT_UNAVAILABLE_REASON_KEYS[result.reason];
            const reasonText = reasonKey ? i18nService.t(reasonKey) : (result.reason || 'unknown');
            setRunNowNote({ kind: 'error', text: i18nService.t('dailyReportRunNowUnavailable').replace('{reason}', reasonText) });
            break;
          }
          default:
            setRunNowNote({ kind: 'error', text: i18nService.t('dailyReportRunNowFailed').replace('{error}', 'unknown') });
        }
      })
      .catch((error) => {
        setRunNowNote({
          kind: 'error',
          text: i18nService.t('dailyReportRunNowFailed').replace('{error}', error instanceof Error ? error.message : 'unknown'),
        });
      })
      .finally(() => setRunNowBusy(false));
  };

  return (
    <div
      className={experimentalAllowed ? '' : 'opacity-65'}
      data-slot="metabot-daily-report-section"
    >
      <div className={METABOT_GROUP_ROW_CLASS} data-slot="metabot-daily-report-enabled-row">
        <div className="flex items-start gap-2.5 min-w-0 flex-1">
          <NewspaperIcon className={METABOT_ROW_ICON_CLASS} aria-hidden />
          <div className="min-w-0 flex-1">
            <div id="metabot-daily-report-enabled-label" className={METABOT_ROW_TITLE_CLASS}>
              <span>{i18nService.t('dailyReportSectionTitle')}</span>
              <TwinBadge />
              <span className={METABOT_MICRO_BADGE_CLASS}>
                {i18nService.t('dailyReportExperimentalBadge')}
              </span>
              <Tooltip content={i18nService.t('dailyReportSectionTooltip')}>
                <QuestionMarkCircleIcon
                  className="h-3.5 w-3.5 text-[#8c96a6] dark:text-[#64748b] hover:text-[#181d25] dark:hover:text-[#f3f5f8] shrink-0 cursor-help transition-colors"
                  aria-label="More info"
                />
              </Tooltip>
            </div>
            <p className={METABOT_ROW_HINT_CLASS}>
              {i18nService.t('dailyReportSectionHint')}
            </p>
            {!experimentalAllowed && (
              <p className="mt-1 text-[11.5px] text-amber-600 dark:text-amber-400">
                {i18nService.t('dailyReportGlobalSwitchRequired')}
              </p>
            )}
            {settingsError && (
              <p className="mt-1 text-[11.5px] text-red-600 dark:text-red-400">{settingsError}</p>
            )}
            {runNowNote && (
              <p
                className={`mt-1 text-[11.5px] ${
                  runNowNote.kind === 'success'
                    ? 'text-[#0f9d68] dark:text-[#34d399]'
                    : runNowNote.kind === 'info'
                      ? 'text-[#5a6577] dark:text-[#94a3b8]'
                      : 'text-red-600 dark:text-red-400'
                }`}
              >
                {runNowNote.text}
              </p>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0" data-slot="metabot-daily-report-hour-row">
          <select
            id="metabot-daily-report-hour"
            aria-label={i18nService.t('dailyReportHourLabel')}
            value={hour}
            onChange={(e) => handleHourChange(e.target.value)}
            disabled={!experimentalAllowed || !enabled}
            className={`${METABOT_COMPACT_SELECT_CLASS} tabular-nums`}
            data-slot="metabot-daily-report-hour-select"
          >
            {Array.from({ length: MAX_DAILY_REPORT_HOUR - MIN_DAILY_REPORT_HOUR + 1 }, (_, i) => {
              const value = String(MIN_DAILY_REPORT_HOUR + i);
              return (
                <option key={value} value={value}>
                  {formatHourOptionLabel(MIN_DAILY_REPORT_HOUR + i)}
                </option>
              );
            })}
          </select>

          {experimentalAllowed && (
            <span data-slot="metabot-daily-report-run-now-row" className="inline-flex">
              <button
                type="button"
                data-slot="metabot-daily-report-run-now"
                onClick={handleRunNow}
                disabled={runNowBusy || !enabledLoaded || !enabled}
                className={METABOT_BTN_FLAT_CLASS}
                title={!enabled ? i18nService.t('dailyReportRunNowDisabledHint') : i18nService.t('dailyReportRunNowButton')}
              >
                <PlayIcon className="h-3.5 w-3.5" aria-hidden />
                <span>{runNowBusy ? i18nService.t('dailyReportRunNowRunning') : i18nService.t('dailyReportRunNowButton')}</span>
              </button>
            </span>
          )}

          <div
            role="switch"
            aria-checked={enabled}
            aria-labelledby="metabot-daily-report-enabled-label"
            data-slot="metabot-daily-report-enabled-switch"
            title={i18nService.t('dailyReportEnableToggle')}
            className={enabledToggleView.trackClass}
            onClick={handleEnabledToggle}
          >
            <div className={enabledToggleView.knobClass} />
          </div>
        </div>
      </div>
    </div>
  );
};

export default DailyReportSection;
