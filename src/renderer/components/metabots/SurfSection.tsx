/**
 * MetaWeb surf ("AI 冲浪") section in Studio Linear Style B.
 */

import React, { useEffect, useState } from 'react';
import {
  AdjustmentsHorizontalIcon,
  ChatBubbleBottomCenterTextIcon,
  GlobeAltIcon,
  PencilSquareIcon,
  QuestionMarkCircleIcon,
  RocketLaunchIcon,
} from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import {
  buildMetaBotToggleViewModel,
  METABOT_BTN_FLAT_CLASS,
  METABOT_CLEAN_INPUT_CLASS,
  METABOT_COMPACT_SELECT_CLASS,
  METABOT_GROUP_BOX_CLASS,
  METABOT_GROUP_LABEL_CLASS,
  METABOT_GROUP_LABEL_ROW_CLASS,
  METABOT_GROUP_NOTE_CLASS,
  METABOT_GROUP_ROW_CLASS,
  METABOT_ROW_HINT_CLASS,
  METABOT_ROW_ICON_CLASS,
  METABOT_ROW_TITLE_CLASS,
} from './metaBotCardPresentation.js';
import SurfReportsPanel from './SurfReportsPanel';
import Tooltip from '../ui/Tooltip';

// Keep in sync with src/main/services/surfSettings.ts (pinned by
// tests/quotaRendererSync.test.mjs).
const SURF_BEFORE_DREAM_ENABLED_KEY = 'surf_before_dream_enabled';
const SURF_INTERACTION_BUDGET_KEY = 'surf_interaction_budget';
const DEFAULT_SURF_INTERACTION_BUDGET = 50;
const MAX_SURF_INTERACTION_BUDGET = 500;
const MIN_SURF_INTERACTION_BUDGET = 0;
const SURF_CREATION_BUDGET_KEY = 'surf_creation_budget';
const SURF_CREATION_MODE_KEY = 'surf_creation_mode';
const DEFAULT_SURF_CREATION_BUDGET = 3;
const MAX_SURF_CREATION_BUDGET = 20;
const MIN_SURF_CREATION_BUDGET = 0;
const SURF_CREATION_MODES = ['off', 'organic', 'encouraged'] as const;
const DEFAULT_SURF_CREATION_MODE: (typeof SURF_CREATION_MODES)[number] = 'organic';

const clampBudget = (raw: string): number | null => {
  const num = Number(raw);
  if (!Number.isFinite(num)) return null;
  return Math.min(MAX_SURF_INTERACTION_BUDGET, Math.max(MIN_SURF_INTERACTION_BUDGET, Math.round(num)));
};

const clampCreationBudget = (raw: string): number | null => {
  const num = Number(raw);
  if (!Number.isFinite(num)) return null;
  return Math.min(MAX_SURF_CREATION_BUDGET, Math.max(MIN_SURF_CREATION_BUDGET, Math.round(num)));
};

const creationModeI18nKey: Record<(typeof SURF_CREATION_MODES)[number], string> = {
  off: 'surfCreationModeOff',
  organic: 'surfCreationModeOrganic',
  encouraged: 'surfCreationModeEncouraged',
};

interface SurfSectionProps {
  metabotId: number;
  metabotType: 'twin' | 'worker' | 'welcome';
}

const SurfSection: React.FC<SurfSectionProps> = ({ metabotId, metabotType }) => {
  const [surfBeforeDream, setSurfBeforeDream] = useState(metabotType === 'twin');
  const [surfBeforeDreamLoaded, setSurfBeforeDreamLoaded] = useState(false);
  const [surfBudget, setSurfBudget] = useState(String(DEFAULT_SURF_INTERACTION_BUDGET));
  const [creationBudget, setCreationBudget] = useState(String(DEFAULT_SURF_CREATION_BUDGET));
  const [creationMode, setCreationMode] = useState<(typeof SURF_CREATION_MODES)[number]>(DEFAULT_SURF_CREATION_MODE);
  const [settingsError, setSettingsError] = useState('');
  const [surfNowError, setSurfNowError] = useState('');
  const [surfNowBusy, setSurfNowBusy] = useState(false);
  const [running, setRunning] = useState(false);
  const [runVersion, setRunVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const typeDefaultOn = metabotType === 'twin';
    setSurfBeforeDream(typeDefaultOn);
    setSurfBeforeDreamLoaded(false);
    setSurfBudget(String(DEFAULT_SURF_INTERACTION_BUDGET));
    setCreationBudget(String(DEFAULT_SURF_CREATION_BUDGET));
    setCreationMode(DEFAULT_SURF_CREATION_MODE);
    setSettingsError('');
    setSurfNowError('');
    window.electron.metabot.getSetting(metabotId, SURF_BEFORE_DREAM_ENABLED_KEY)
      .then((result) => {
        if (cancelled) return;
        setSurfBeforeDream(result.success && result.value != null ? result.value !== '0' : typeDefaultOn);
        setSurfBeforeDreamLoaded(true);
      })
      .catch(() => {
        if (cancelled) return;
        setSurfBeforeDream(typeDefaultOn);
        setSurfBeforeDreamLoaded(true);
      });
    window.electron.metabot.getSetting(metabotId, SURF_INTERACTION_BUDGET_KEY)
      .then((result) => {
        if (cancelled) return;
        const clamped = result.success && result.value != null ? clampBudget(result.value) : null;
        setSurfBudget(clamped === null ? String(DEFAULT_SURF_INTERACTION_BUDGET) : String(clamped));
      })
      .catch(() => {
        if (cancelled) return;
        setSurfBudget(String(DEFAULT_SURF_INTERACTION_BUDGET));
      });
    window.electron.metabot.getSetting(metabotId, SURF_CREATION_BUDGET_KEY)
      .then((result) => {
        if (cancelled) return;
        const clamped = result.success && result.value != null ? clampCreationBudget(result.value) : null;
        setCreationBudget(clamped === null ? String(DEFAULT_SURF_CREATION_BUDGET) : String(clamped));
      })
      .catch(() => {
        if (cancelled) return;
        setCreationBudget(String(DEFAULT_SURF_CREATION_BUDGET));
      });
    window.electron.metabot.getSetting(metabotId, SURF_CREATION_MODE_KEY)
      .then((result) => {
        if (cancelled) return;
        const raw = result.success ? result.value : null;
        setCreationMode(
          raw && (SURF_CREATION_MODES as readonly string[]).includes(raw)
            ? (raw as (typeof SURF_CREATION_MODES)[number])
            : DEFAULT_SURF_CREATION_MODE,
        );
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [metabotId, metabotType]);

  // Live surf status for this bot (mirrors the dreamStatusChanged pattern in
  // MetabotsManager). Every event also bumps runVersion so the reports panel
  // picks up the new/updated run row.
  useEffect(() => {
    let cancelled = false;
    setRunning(false);
    window.electron.surf.listRuns(metabotId, 1)
      .then((result) => {
        if (cancelled) return;
        const latest = result.success ? result.runs?.[0] : undefined;
        if (latest?.status === 'running') setRunning(true);
      })
      .catch(() => undefined);
    const off = window.electron.surf?.onStatusChanged?.((payload) => {
      if (payload.metabotId !== metabotId) return;
      setRunning(payload.status === 'running');
      setRunVersion((v) => v + 1);
    });
    return () => {
      cancelled = true;
      off?.();
    };
  }, [metabotId]);

  const surfBeforeDreamToggleView = buildMetaBotToggleViewModel({
    enabled: surfBeforeDream,
    disabled: !surfBeforeDreamLoaded,
  });

  const handleBeforeDreamToggle = () => {
    if (!surfBeforeDreamLoaded) return;
    const next = !surfBeforeDream;
    setSurfBeforeDream(next);
    setSettingsError('');
    const revert = (message: string) => {
      setSurfBeforeDream(!next);
      setSettingsError(message);
    };
    window.electron.metabot.setSetting(metabotId, SURF_BEFORE_DREAM_ENABLED_KEY, next ? '1' : '0')
      .then((result) => {
        if (!result.success) revert(result.error || i18nService.t('surfSettingSaveFailed'));
      })
      .catch(() => revert(i18nService.t('surfSettingSaveFailed')));
  };

  const handleBudgetCommit = () => {
    const clamped = clampBudget(surfBudget);
    const next = clamped === null ? String(DEFAULT_SURF_INTERACTION_BUDGET) : String(clamped);
    setSurfBudget(next);
    setSettingsError('');
    window.electron.metabot.setSetting(metabotId, SURF_INTERACTION_BUDGET_KEY, next)
      .then((result) => {
        if (!result.success) setSettingsError(result.error || i18nService.t('surfSettingSaveFailed'));
      })
      .catch(() => setSettingsError(i18nService.t('surfSettingSaveFailed')));
  };

  const handleCreationBudgetCommit = () => {
    const clamped = clampCreationBudget(creationBudget);
    const next = clamped === null ? String(DEFAULT_SURF_CREATION_BUDGET) : String(clamped);
    setCreationBudget(next);
    setSettingsError('');
    window.electron.metabot.setSetting(metabotId, SURF_CREATION_BUDGET_KEY, next)
      .then((result) => {
        if (!result.success) setSettingsError(result.error || i18nService.t('surfSettingSaveFailed'));
      })
      .catch(() => setSettingsError(i18nService.t('surfSettingSaveFailed')));
  };

  const handleCreationModeChange = (next: (typeof SURF_CREATION_MODES)[number]) => {
    const prev = creationMode;
    setCreationMode(next);
    setSettingsError('');
    window.electron.metabot.setSetting(metabotId, SURF_CREATION_MODE_KEY, next)
      .then((result) => {
        if (!result.success) {
          setCreationMode(prev);
          setSettingsError(result.error || i18nService.t('surfSettingSaveFailed'));
        }
      })
      .catch(() => {
        setCreationMode(prev);
        setSettingsError(i18nService.t('surfSettingSaveFailed'));
      });
  };

  const handleSurfNow = () => {
    if (running || surfNowBusy) return;
    setSurfNowBusy(true);
    setSurfNowError('');
    window.electron.surf.runNow(metabotId)
      .then((result) => {
        if (!result.success) {
          setSurfNowError(i18nService.t('surfNowFailed').replace('{error}', result.error || 'unknown'));
        } else {
          setRunning(true);
        }
      })
      .catch((error) => {
        setSurfNowError(i18nService.t('surfNowFailed').replace('{error}', error instanceof Error ? error.message : 'unknown'));
      })
      .finally(() => setSurfNowBusy(false));
  };

  return (
    <div className="space-y-5" data-slot="metabot-surf-section">
      <div>
        <div className={METABOT_GROUP_LABEL_ROW_CLASS}>
          <div className="flex items-center gap-1.5 min-w-0">
            <span className={METABOT_GROUP_LABEL_CLASS}>{i18nService.t('surfSectionTitle')}</span>
            <Tooltip content={i18nService.t('surfSectionTooltip')}>
              <QuestionMarkCircleIcon
                className="h-3.5 w-3.5 text-[#8c96a6] dark:text-[#64748b] hover:text-[#181d25] dark:hover:text-[#f3f5f8] shrink-0 cursor-help transition-colors"
                aria-label="More info"
              />
            </Tooltip>
            <span className={`hidden sm:inline ${METABOT_GROUP_NOTE_CLASS}`}>
              · {i18nService.t('surfSectionHint')}
            </span>
          </div>
          <span className={METABOT_GROUP_NOTE_CLASS}>{i18nService.t('metabotGroupImmediateNote')}</span>
        </div>

        {(settingsError || surfNowError) && (
          <p className="mb-2 text-xs text-red-600 dark:text-rose-400 whitespace-pre-wrap break-words">
            {settingsError || surfNowError}
          </p>
        )}

        <div className={METABOT_GROUP_BOX_CLASS}>
          {/* Row 1: Surf before dream + Surf now */}
          <div className={METABOT_GROUP_ROW_CLASS} data-slot="metabot-surf-before-dream-row">
            <div className="flex items-start gap-2.5 min-w-0 flex-1">
              <GlobeAltIcon className={METABOT_ROW_ICON_CLASS} aria-hidden />
              <div>
                <label id="metabot-surf-before-dream-label" className={METABOT_ROW_TITLE_CLASS}>
                  {i18nService.t('surfBeforeDreamToggle')}
                </label>
                <p className={METABOT_ROW_HINT_CLASS}>{i18nService.t('surfBeforeDreamHint')}</p>
              </div>
            </div>

            <div className="flex items-center gap-2.5 shrink-0" data-slot="metabot-surf-now-row">
              <button
                type="button"
                data-slot="metabot-surf-now"
                onClick={handleSurfNow}
                disabled={running || surfNowBusy}
                className={METABOT_BTN_FLAT_CLASS}
              >
                <RocketLaunchIcon className="h-3.5 w-3.5" aria-hidden />
                <span>{running || surfNowBusy ? i18nService.t('surfNowRunning') : i18nService.t('surfNowButton')}</span>
              </button>

              <div
                role="switch"
                aria-checked={surfBeforeDream}
                aria-labelledby="metabot-surf-before-dream-label"
                data-slot="metabot-surf-before-dream-switch"
                title={i18nService.t('surfBeforeDreamToggle')}
                className={surfBeforeDreamToggleView.trackClass}
                onClick={handleBeforeDreamToggle}
              >
                <div className={surfBeforeDreamToggleView.knobClass} />
              </div>
            </div>
          </div>

          {/* Row 2: Interaction budget */}
          <div className={METABOT_GROUP_ROW_CLASS} data-slot="metabot-surf-budget-row">
            <div className="flex items-start gap-2.5 min-w-0 flex-1">
              <ChatBubbleBottomCenterTextIcon className={METABOT_ROW_ICON_CLASS} aria-hidden />
              <div>
                <label htmlFor="metabot-surf-budget" className={METABOT_ROW_TITLE_CLASS}>
                  {i18nService.t('surfInteractionBudgetLabel')}
                </label>
                <p className={METABOT_ROW_HINT_CLASS}>{i18nService.t('surfInteractionBudgetHint')}</p>
              </div>
            </div>

            <input
              id="metabot-surf-budget"
              type="number"
              min={MIN_SURF_INTERACTION_BUDGET}
              max={MAX_SURF_INTERACTION_BUDGET}
              step={1}
              value={surfBudget}
              onChange={(e) => setSurfBudget(e.target.value)}
              onBlur={handleBudgetCommit}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              }}
              className={`${METABOT_CLEAN_INPUT_CLASS} !w-24 text-right tabular-nums shrink-0`}
            />
          </div>

          {/* Row 3: Creation budget */}
          <div className={METABOT_GROUP_ROW_CLASS} data-slot="metabot-surf-creation-budget-row">
            <div className="flex items-start gap-2.5 min-w-0 flex-1">
              <PencilSquareIcon className={METABOT_ROW_ICON_CLASS} aria-hidden />
              <div>
                <label htmlFor="metabot-surf-creation-budget" className={METABOT_ROW_TITLE_CLASS}>
                  {i18nService.t('surfCreationBudgetLabel')}
                </label>
                <p className={METABOT_ROW_HINT_CLASS}>{i18nService.t('surfCreationBudgetHint')}</p>
              </div>
            </div>

            <input
              id="metabot-surf-creation-budget"
              type="number"
              min={MIN_SURF_CREATION_BUDGET}
              max={MAX_SURF_CREATION_BUDGET}
              step={1}
              value={creationBudget}
              onChange={(e) => setCreationBudget(e.target.value)}
              onBlur={handleCreationBudgetCommit}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              }}
              className={`${METABOT_CLEAN_INPUT_CLASS} !w-24 text-right tabular-nums shrink-0`}
            />
          </div>

          {/* Row 4: Creation mode */}
          <div className={METABOT_GROUP_ROW_CLASS} data-slot="metabot-surf-creation-mode-row">
            <div className="flex items-start gap-2.5 min-w-0 flex-1">
              <AdjustmentsHorizontalIcon className={METABOT_ROW_ICON_CLASS} aria-hidden />
              <div>
                <label htmlFor="metabot-surf-creation-mode" className={METABOT_ROW_TITLE_CLASS}>
                  {i18nService.t('surfCreationModeLabel')}
                </label>
                <p className={METABOT_ROW_HINT_CLASS}>{i18nService.t('surfCreationModeHint')}</p>
              </div>
            </div>

            <select
              id="metabot-surf-creation-mode"
              value={creationMode}
              onChange={(e) => handleCreationModeChange(e.target.value as (typeof SURF_CREATION_MODES)[number])}
              className={`${METABOT_COMPACT_SELECT_CLASS} shrink-0`}
              data-slot="metabot-surf-creation-mode-select"
            >
              {SURF_CREATION_MODES.map((mode) => (
                <option key={mode} value={mode}>
                  {i18nService.t(creationModeI18nKey[mode])}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      <SurfReportsPanel metabotId={metabotId} refreshToken={runVersion} />
    </div>
  );
};

export default SurfSection;
