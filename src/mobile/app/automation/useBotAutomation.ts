import { useCallback, useEffect, useRef, useState } from 'react';
import type { MetawebSurfRunInfo } from '@/types/metawebSurf';
import { t } from '../../i18n';
import { getMobileElectron } from '../appBridge';
import {
  DAILY_REPORT_ENABLED_KEY,
  DAILY_REPORT_HOUR_KEY,
  DEFAULT_DAILY_REPORT_HOUR,
  DEFAULT_SURF_CREATION_BUDGET,
  DEFAULT_SURF_INTERACTION_BUDGET,
  SURF_BEFORE_DREAM_ENABLED_KEY,
  SURF_CREATION_BUDGET_KEY,
  SURF_CREATION_MODE_KEY,
  SURF_INTERACTION_BUDGET_KEY,
  clampBudget,
  dailyReportUnavailableCopyKey,
  normalizeCreationMode,
  type SurfCreationMode,
} from './botAutomationModel';

export interface BotAutomationSettings {
  surfBeforeDream: boolean;
  interactionBudget: number;
  creationBudget: number;
  creationMode: SurfCreationMode;
  dailyEnabled: boolean;
  dailyHour: number;
  experimentalAutomation: boolean;
}

export function useBotAutomation(metabotId: number, metabotType: 'twin' | 'worker' | 'welcome') {
  const [settings, setSettings] = useState<BotAutomationSettings>({
    surfBeforeDream: metabotType === 'twin',
    interactionBudget: DEFAULT_SURF_INTERACTION_BUDGET,
    creationBudget: DEFAULT_SURF_CREATION_BUDGET,
    creationMode: 'organic',
    dailyEnabled: false,
    dailyHour: DEFAULT_DAILY_REPORT_HOUR,
    experimentalAutomation: false,
  });
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [runs, setRuns] = useState<MetawebSurfRunInfo[]>([]);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [busy, setBusy] = useState<'surf' | 'daily' | null>(null);
  const requestRef = useRef(0);

  const reloadRuns = useCallback(async () => {
    try {
      const result = await getMobileElectron().surf.listRuns(metabotId, 8);
      if (!result.success) throw new Error(result.error || t('mobile.automation.loadFailed'));
      const next = Array.isArray(result.runs) ? result.runs : [];
      setRuns(next);
      setRunningId(next.find((run) => run.status === 'running')?.id ?? null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('mobile.automation.loadFailed'));
    }
  }, [metabotId]);

  const load = useCallback(async () => {
    const request = ++requestRef.current;
    setLoaded(false);
    setError(null);
    const api = getMobileElectron();
    const read = async (key: string) => {
      const result = await api.metabot.getSetting(metabotId, key);
      if (!result.success) throw new Error(result.error || t('mobile.automation.loadFailed'));
      return result.value ?? null;
    };
    try {
      const [beforeDream, interaction, creation, mode, dailyEnabled, dailyHour, experimental, ] = await Promise.all([
        read(SURF_BEFORE_DREAM_ENABLED_KEY),
        read(SURF_INTERACTION_BUDGET_KEY),
        read(SURF_CREATION_BUDGET_KEY),
        read(SURF_CREATION_MODE_KEY),
        read(DAILY_REPORT_ENABLED_KEY),
        read(DAILY_REPORT_HOUR_KEY),
        api.experimentalAutomation.get(),
      ]);
      if (request !== requestRef.current) return;
      setSettings({
        surfBeforeDream: beforeDream === null ? metabotType === 'twin' : beforeDream !== '0',
        interactionBudget: clampBudget(interaction ?? '', DEFAULT_SURF_INTERACTION_BUDGET, 500),
        creationBudget: clampBudget(creation ?? '', DEFAULT_SURF_CREATION_BUDGET, 20),
        creationMode: normalizeCreationMode(mode),
        dailyEnabled: dailyEnabled === '1',
        dailyHour: clampBudget(dailyHour ?? '', DEFAULT_DAILY_REPORT_HOUR, 23),
        experimentalAutomation: experimental.enabled,
      });
      setLoaded(true);
    } catch (cause) {
      if (request === requestRef.current) {
        setError(cause instanceof Error ? cause.message : t('mobile.automation.loadFailed'));
        setLoaded(true);
      }
    }
    await reloadRuns();
  }, [metabotId, metabotType, reloadRuns]);

  useEffect(() => {
    void load();
    const off = getMobileElectron().surf.onStatusChanged?.((payload) => {
      if (payload.metabotId !== metabotId) return;
      if (payload.status === 'running') setRunningId(payload.runId);
      else {
        setRunningId(null);
        setBusy((current) => current === 'surf' ? null : current);
        void reloadRuns();
      }
    });
    return () => {
      requestRef.current += 1;
      off?.();
    };
  }, [load, metabotId, reloadRuns]);

  const saveSetting = useCallback(async (key: string, value: string): Promise<boolean> => {
    setSaving(true);
    setError(null);
    try {
      const api = getMobileElectron();
      const result = await api.metabot.setSetting(metabotId, key, value);
      if (!result.success) throw new Error(result.error || t('mobile.automation.saveFailed'));
      const confirmed = await api.metabot.getSetting(metabotId, key);
      if (!confirmed.success || confirmed.value !== value) throw new Error(t('mobile.automation.saveFailed'));
      setSettings((current) => {
        switch (key) {
          case SURF_BEFORE_DREAM_ENABLED_KEY: return { ...current, surfBeforeDream: value !== '0' };
          case SURF_INTERACTION_BUDGET_KEY: return { ...current, interactionBudget: Number(value) };
          case SURF_CREATION_BUDGET_KEY: return { ...current, creationBudget: Number(value) };
          case SURF_CREATION_MODE_KEY: return { ...current, creationMode: normalizeCreationMode(value) };
          case DAILY_REPORT_ENABLED_KEY: return { ...current, dailyEnabled: value === '1' };
          case DAILY_REPORT_HOUR_KEY: return { ...current, dailyHour: Number(value) };
          default: return current;
        }
      });
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('mobile.automation.saveFailed'));
      return false;
    } finally {
      setSaving(false);
    }
  }, [metabotId]);

  const setExperimentalAutomation = useCallback(async (enabled: boolean): Promise<boolean> => {
    setSaving(true);
    setError(null);
    try {
      const api = getMobileElectron();
      const result = await api.experimentalAutomation.set(enabled);
      if (!result.success) throw new Error(result.error || t('mobile.automation.saveFailed'));
      const confirmed = await api.experimentalAutomation.get();
      if (confirmed.enabled !== enabled) throw new Error(t('mobile.automation.saveFailed'));
      setSettings((current) => ({ ...current, experimentalAutomation: enabled }));
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('mobile.automation.saveFailed'));
      return false;
    } finally {
      setSaving(false);
    }
  }, []);

  const runSurf = useCallback(async (): Promise<void> => {
    if (busy || runningId) return;
    setBusy('surf');
    setError(null);
    try {
      const result = await getMobileElectron().surf.runNow(metabotId);
      if (!result.success || !result.runId) throw new Error(result.error || t('mobile.automation.surfFailed'));
      setRunningId(result.runId);
      await reloadRuns();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('mobile.automation.surfFailed'));
    } finally {
      setBusy(null);
    }
  }, [busy, metabotId, reloadRuns, runningId]);

  const runDaily = useCallback(async (): Promise<string | null> => {
    if (busy) return null;
    setBusy('daily');
    setError(null);
    try {
      const result = await getMobileElectron().dailyReport.runNow();
      if (result.status === 'completed') return result.sessionId;
      if (result.status === 'unavailable') throw new Error(t(dailyReportUnavailableCopyKey(result.reason)));
      if (result.status === 'skipped') throw new Error(t('mobile.automation.dailySkipped'));
      throw new Error(result.error || t('mobile.automation.dailyFailed'));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('mobile.automation.dailyFailed'));
      return null;
    } finally {
      setBusy(null);
    }
  }, [busy]);

  return {
    settings,
    loaded,
    saving,
    error,
    setError,
    runs,
    runningId,
    busy,
    saveSetting,
    setExperimentalAutomation,
    runSurf,
    runDaily,
    reloadRuns,
    reload: load,
  };
}
