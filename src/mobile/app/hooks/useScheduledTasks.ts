import { useCallback, useEffect, useRef, useState } from 'react';
import type { ScheduledTask, ScheduledTaskInput, ScheduledTaskRun, Schedule } from '../../bridge/types';
import { getMobileElectron } from '../appBridge';
import { t } from '../../i18n';
import type { OpenWorkSession } from './useWorkActivity';

export interface ScheduledTaskDraft {
  name: string;
  prompt: string;
  schedule: Schedule;
}

export function buildScheduledTaskCreateInput(
  draft: ScheduledTaskDraft,
  twinMetabotId: number | null,
  workingDirectory: string,
): ScheduledTaskInput | null {
  if (twinMetabotId === null || !Number.isInteger(twinMetabotId) || twinMetabotId <= 0) return null;
  return {
    name: draft.name,
    description: '',
    prompt: draft.prompt,
    schedule: draft.schedule,
    workingDirectory: workingDirectory.trim(),
    systemPrompt: '',
    executionMode: 'auto',
    metabotId: twinMetabotId,
    memoryAccess: 'none',
    expiresAt: null,
    notifyPlatforms: [],
    enabled: true,
  };
}

type TaskAction = 'save' | 'toggle' | 'run' | 'stop' | 'delete';
type TaskResult = {
  success?: boolean;
  error?: string;
  task?: ScheduledTask;
  result?: boolean;
};

interface ScheduledTasksOptions {
  twinMetabotId: number | null;
  onOpenSession: OpenWorkSession;
  resyncCounter?: number;
  onChanged?: () => void;
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function useScheduledTasks({ twinMetabotId, onOpenSession, resyncCounter = 0, onChanged }: ScheduledTasksOptions) {
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<Record<string, TaskAction>>({});
  const [runsByTask, setRunsByTask] = useState<Record<string, ScheduledTaskRun[]>>({});
  const [historyErrors, setHistoryErrors] = useState<Record<string, string>>({});
  const [historyLoading, setHistoryLoading] = useState<Record<string, boolean>>({});
  const loadedRunsRef = useRef<Set<string>>(new Set());
  const requestRef = useRef(0);
  const historyRequestsRef = useRef(new Map<string, number>());
  const pendingRef = useRef<Record<string, TaskAction>>({});

  const reload = useCallback(async (): Promise<boolean> => {
    const request = ++requestRef.current;
    try {
      const result = await getMobileElectron().scheduledTasks.list();
      if (request !== requestRef.current) return false;
      if (!result?.success || !Array.isArray(result.tasks)) {
        setLoadError(result?.error ?? t('mobile.tasks.loadFailed'));
        return false;
      }
      setTasks(result.tasks);
      setLoadError(null);
      onChanged?.();
      return true;
    } catch (error) {
      if (request === requestRef.current) {
        setLoadError(errorText(error, t('mobile.tasks.loadFailed')));
      }
      return false;
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  }, [onChanged]);

  const loadRuns = useCallback(async (taskId: string): Promise<boolean> => {
    const request = (historyRequestsRef.current.get(taskId) ?? 0) + 1;
    historyRequestsRef.current.set(taskId, request);
    setHistoryLoading((previous) => ({ ...previous, [taskId]: true }));
    try {
      const result = await getMobileElectron().scheduledTasks.listRuns(taskId, 20);
      if (historyRequestsRef.current.get(taskId) !== request) return false;
      if (!result?.success || !Array.isArray(result.runs)) {
        setHistoryErrors((previous) => ({ ...previous, [taskId]: result?.error ?? t('mobile.tasks.historyFailed') }));
        return false;
      }
      loadedRunsRef.current.add(taskId);
      setRunsByTask((previous) => ({ ...previous, [taskId]: result.runs }));
      setHistoryErrors((previous) => {
        const next = { ...previous };
        delete next[taskId];
        return next;
      });
      return true;
    } catch (error) {
      if (historyRequestsRef.current.get(taskId) === request) {
        setHistoryErrors((previous) => ({ ...previous, [taskId]: errorText(error, t('mobile.tasks.historyFailed')) }));
      }
      return false;
    } finally {
      if (historyRequestsRef.current.get(taskId) === request) {
        setHistoryLoading((previous) => ({ ...previous, [taskId]: false }));
      }
    }
  }, []);

  useEffect(() => {
    void reload();
    const api = getMobileElectron().scheduledTasks;
    const offStatus = api.onStatusUpdate(({ taskId, state }: { taskId: string; state: ScheduledTask['state'] }) => {
      setTasks((previous) => previous.map((task) => (task.id === taskId ? { ...task, state: { ...state } } : task)));
    });
    const offRun = api.onRunUpdate(({ run }: { run: ScheduledTaskRun }) => {
      setRunsByTask((previous) => {
        if (!loadedRunsRef.current.has(run.taskId)) return previous;
        const runs = previous[run.taskId] ?? [];
        const index = runs.findIndex((entry) => entry.id === run.id);
        const nextRuns = index >= 0
          ? runs.map((entry) => (entry.id === run.id ? { ...run } : entry))
          : [{ ...run }, ...runs];
        return { ...previous, [run.taskId]: nextRuns };
      });
      if (run.status === 'skipped') return;
      // Receipt tiering (desktop 2026-11-18): map terminal tiers onto the
      // coarse task state — normal exit (completed / completed_empty) is
      // success, abnormal exit (crashed / timeout) is error.
      const lastStatus: 'running' | 'success' | 'error'
        = run.status === 'running'
          ? 'running'
          : run.status === 'success' || run.status === 'completed' || run.status === 'completed_empty'
            ? 'success'
            : 'error';
      setTasks((previous) => previous.map((task) => {
        if (task.id !== run.taskId) return task;
        return {
          ...task,
          state: {
            ...task.state,
            lastStatus,
            lastRunAtMs: run.finishedAt ? Date.parse(run.finishedAt) : task.state.lastRunAtMs,
            lastError: run.error,
            runningAtMs: run.status === 'running' ? Date.parse(run.startedAt) : null,
          },
        };
      }));
    });
    return () => {
      requestRef.current += 1;
      offStatus();
      offRun();
    };
  }, [reload, resyncCounter]);

  const perform = useCallback(async (
    key: string,
    action: TaskAction,
    invoke: () => Promise<TaskResult>,
  ): Promise<TaskResult | null> => {
    if (pendingRef.current[key]) return null;
    pendingRef.current = { ...pendingRef.current, [key]: action };
    setPending(pendingRef.current);
    setErrors((previous) => {
      const next = { ...previous };
      delete next[key];
      return next;
    });
    try {
      const result = await invoke();
      if (!result?.success) throw new Error(result?.error || t('mobile.tasks.actionFailed'));
      return result;
    } catch (error) {
      const message = errorText(error, t('mobile.tasks.actionFailed'));
      setErrors((previous) => ({ ...previous, [key]: message }));
      return null;
    } finally {
      const next = { ...pendingRef.current };
      delete next[key];
      pendingRef.current = next;
      setPending(next);
    }
  }, []);

  const createTask = useCallback(async (input: ScheduledTaskDraft): Promise<boolean> => {
    if (twinMetabotId === null) {
      setErrors((previous) => ({ ...previous, create: t('mobile.tasks.twinUnavailable') }));
      return false;
    }
    const api = getMobileElectron();
    const config = await api.cowork.getConfig().catch(() => null);
    const createInput = buildScheduledTaskCreateInput(
      input,
      twinMetabotId,
      config?.success ? config.config?.workingDirectory ?? '' : '',
    );
    if (!createInput) {
      setErrors((previous) => ({ ...previous, create: t('mobile.tasks.twinUnavailable') }));
      return false;
    }
    const created = await perform('create', 'save', () => api.scheduledTasks.create(createInput));
    if (!created?.task) return false;
    await reload();
    return true;
  }, [perform, reload, twinMetabotId]);

  const updateTask = useCallback(async (id: string, input: ScheduledTaskDraft): Promise<boolean> => {
    const updated = await perform(id, 'save', () => getMobileElectron().scheduledTasks.update(id, {
      name: input.name,
      prompt: input.prompt,
      schedule: input.schedule,
    }));
    if (!updated?.task) return false;
    setTasks((previous) => previous.map((task) => (task.id === id ? updated.task! : task)));
    onChanged?.();
    return true;
  }, [onChanged, perform]);

  const toggleTask = useCallback(async (id: string, enabled: boolean): Promise<boolean> => {
    const updated = await perform(id, 'toggle', () => getMobileElectron().scheduledTasks.toggle(id, enabled));
    if (!updated?.task) return false;
    setTasks((previous) => previous.map((task) => (task.id === id ? updated.task! : task)));
    return true;
  }, [perform]);

  const runTask = useCallback(async (id: string): Promise<boolean> => {
    const started = await perform(id, 'run', () => getMobileElectron().scheduledTasks.runManually(id));
    if (!started) return false;
    await reload();
    return true;
  }, [perform, reload]);

  const stopTask = useCallback(async (id: string): Promise<boolean> => {
    const stopped = await perform(id, 'stop', async () => {
      const result = await getMobileElectron().scheduledTasks.stop(id);
      if (result?.success && result.result !== true) {
        return { ...result, success: false, error: t('mobile.tasks.stopNotRunning') };
      }
      return result;
    });
    if (!stopped) return false;
    await Promise.all([reload(), loadedRunsRef.current.has(id) ? loadRuns(id) : Promise.resolve(false)]);
    return true;
  }, [loadRuns, perform, reload]);

  const deleteTask = useCallback(async (id: string): Promise<boolean> => {
    const deleted = await perform(id, 'delete', async () => {
      const result = await getMobileElectron().scheduledTasks.delete(id);
      if (result?.success && result.result !== true) {
        return { ...result, success: false, error: t('mobile.tasks.actionFailed') };
      }
      return result;
    });
    if (!deleted) return false;
    loadedRunsRef.current.delete(id);
    historyRequestsRef.current.delete(id);
    setRunsByTask((previous) => {
      const next = { ...previous };
      delete next[id];
      return next;
    });
    await reload();
    return true;
  }, [perform, reload]);

  const openRun = useCallback(async (run: ScheduledTaskRun): Promise<boolean> => {
    try {
      const opened = run.sessionId ? await onOpenSession(run.sessionId) : false;
      if (!opened) {
        setErrors((previous) => ({ ...previous, [run.taskId]: t('mobile.activity.sessionUnavailable') }));
        return false;
      }
      return true;
    } catch (error) {
      setErrors((previous) => ({ ...previous, [run.taskId]: errorText(error, t('mobile.activity.sessionUnavailable')) }));
      return false;
    }
  }, [onOpenSession]);

  return {
    tasks,
    loading,
    loadError,
    creating: pending.create === 'save',
    createError: errors.create ?? null,
    errorFor: (id: string) => errors[id] ?? null,
    pendingFor: (id: string) => pending[id] ?? null,
    historyLoadingFor: (id: string) => historyLoading[id] === true,
    historyErrorFor: (id: string) => historyErrors[id] ?? null,
    reload,
    createTask,
    updateTask,
    toggleTask,
    runTask,
    stopTask,
    deleteTask,
    openRun,
    runsFor: (taskId: string) => runsByTask[taskId] ?? [],
    loadRuns,
  };
}
