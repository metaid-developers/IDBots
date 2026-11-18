import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  LongTermBoard,
  LongTermTaskDetail,
  LongTermTaskUpdateInput,
} from '@/types/longTermTask';
import { getMobileElectron } from '../appBridge';
import { resolveLongTermResultSession } from '../activity';
import { resolveSubtaskSession } from '../unifiedTaskPresentation';
import { reduceLongTermUpdate, type OpenWorkSession } from './useWorkActivity';
import { t } from '../../i18n';

interface UnifiedTasksOptions {
  resyncCounter?: number;
  onOpenSession: OpenWorkSession;
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function useUnifiedTasks({ resyncCounter = 0, onOpenSession }: UnifiedTasksOptions) {
  const [board, setBoard] = useState<LongTermBoard | null>(null);
  const [details, setDetails] = useState<Record<string, LongTermTaskDetail>>({});
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const boardRequestRef = useRef(0);
  const detailRequestsRef = useRef(new Map<string, number>());
  const selectedTaskRef = useRef<string | null>(null);
  const sequenceRef = useRef(0);
  selectedTaskRef.current = selectedTaskId;

  const loadDetail = useCallback(async (taskId: string): Promise<LongTermTaskDetail | null> => {
    const request = (detailRequestsRef.current.get(taskId) ?? 0) + 1;
    detailRequestsRef.current.set(taskId, request);
    setDetailLoading(true);
    try {
      const result = await getMobileElectron().longtermTask.get({ taskId });
      if (detailRequestsRef.current.get(taskId) !== request) return null;
      if (!result?.success || !result.detail) {
        setActionError(result?.error ?? t('mobile.taskCenter.detailFailed'));
        return null;
      }
      setDetails((previous) => ({ ...previous, [taskId]: result.detail! }));
      setActionError(null);
      return result.detail;
    } catch (cause) {
      if (detailRequestsRef.current.get(taskId) === request) {
        setActionError(errorText(cause, t('mobile.taskCenter.detailFailed')));
      }
      return null;
    } finally {
      if (detailRequestsRef.current.get(taskId) === request) setDetailLoading(false);
    }
  }, []);

  const reload = useCallback(async (): Promise<boolean> => {
    const request = ++boardRequestRef.current;
    try {
      const result = await getMobileElectron().longtermTask.board();
      if (request !== boardRequestRef.current) return false;
      if (!result?.success || !result.board) {
        setError(result?.error ?? t('mobile.taskCenter.loadFailed'));
        return false;
      }
      setBoard(result.board);
      setError(null);
      return true;
    } catch (cause) {
      if (request === boardRequestRef.current) setError(errorText(cause, t('mobile.taskCenter.loadFailed')));
      return false;
    } finally {
      if (request === boardRequestRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
    const off = getMobileElectron().longtermTask.onUpdate((update) => {
      const reduced = reduceLongTermUpdate(sequenceRef.current, update);
      sequenceRef.current = reduced.seq;
      if (!reduced.reload) return;
      void reload();
      const taskId = selectedTaskRef.current;
      if (taskId && (update.taskIds.length === 0 || update.taskIds.includes(taskId))) void loadDetail(taskId);
    });
    const timer = setInterval(() => void reload(), 30_000);
    return () => {
      boardRequestRef.current += 1;
      off();
      clearInterval(timer);
    };
  }, [loadDetail, reload, resyncCounter]);

  const openDetail = useCallback((taskId: string) => {
    setActionError(null);
    setSelectedTaskId(taskId);
    void loadDetail(taskId);
  }, [loadDetail]);

  const closeDetail = useCallback(() => {
    setSelectedTaskId(null);
    setActionError(null);
  }, []);

  const openTaskChat = useCallback(async (taskId: string, subtaskId?: string): Promise<boolean> => {
    setPending(true);
    setActionError(null);
    try {
      const detail = await loadDetail(taskId);
      if (!detail) {
        setActionError(t('mobile.taskCenter.sessionUnavailable'));
        return false;
      }
      const subtask = subtaskId ? detail.subtasks.find((entry) => entry.id === subtaskId) : null;
      const sessionId = subtask ? resolveSubtaskSession(detail, subtask) : resolveLongTermResultSession(detail);
      const opened = sessionId ? await onOpenSession(sessionId) : false;
      if (!opened) {
        setActionError(t('mobile.taskCenter.sessionUnavailable'));
        return false;
      }
      return true;
    } catch (cause) {
      setActionError(errorText(cause, t('mobile.taskCenter.sessionUnavailable')));
      return false;
    } finally {
      setPending(false);
    }
  }, [loadDetail, onOpenSession]);

  const runAction = useCallback(async (
    taskId: string,
    invoke: (api: Window['electron']['longtermTask']) => Promise<{ ok: boolean; error?: string }>,
  ): Promise<boolean> => {
    setPending(true);
    setActionError(null);
    try {
      const result = await invoke(getMobileElectron().longtermTask);
      if (!result?.ok) throw new Error(result?.error || t('mobile.taskCenter.actionFailed'));
      await Promise.all([reload(), loadDetail(taskId)]);
      return true;
    } catch (cause) {
      setActionError(errorText(cause, t('mobile.taskCenter.actionFailed')));
      return false;
    } finally {
      setPending(false);
    }
  }, [loadDetail, reload]);

  const updateTask = useCallback((input: LongTermTaskUpdateInput) => (
    runAction(input.taskId, (api) => api.update(input))
  ), [runAction]);
  const setStage = useCallback((taskId: string, action: 'pause' | 'resume' | 'cancel') => (
    runAction(taskId, (api) => api.setStage({ taskId, action }))
  ), [runAction]);
  const completeTask = useCallback((taskId: string) => (
    runAction(taskId, (api) => api.complete({ taskId }))
  ), [runAction]);
  const acceptSubtask = useCallback((taskId: string, subtaskId: string) => (
    runAction(taskId, (api) => api.accept({ subtaskId }))
  ), [runAction]);
  const acceptAll = useCallback((taskId: string, subtaskIds: string[]) => (
    runAction(taskId, async (api) => {
      let firstError: string | null = null;
      for (const subtaskId of subtaskIds) {
        const result = await api.accept({ subtaskId });
        if (!result.ok && !firstError) firstError = result.error ?? t('mobile.taskCenter.actionFailed');
      }
      return firstError ? { ok: false, error: firstError } : { ok: true };
    })
  ), [runAction]);
  const rejectSubtask = useCallback((taskId: string, subtaskId: string, feedback: string) => (
    runAction(taskId, (api) => api.reject({ subtaskId, feedback }))
  ), [runAction]);
  const skipSubtask = useCallback((taskId: string, subtaskId: string, reason: string) => (
    runAction(taskId, (api) => api.subtaskSkip({ subtaskId, reason }))
  ), [runAction]);
  const unblockSubtask = useCallback((taskId: string, subtaskId: string) => (
    runAction(taskId, (api) => api.unblock({ subtaskId }))
  ), [runAction]);
  const beginSubtask = useCallback((taskId: string, subtaskId: string) => (
    runAction(taskId, (api) => api.begin({ subtaskId }))
  ), [runAction]);
  const moveSubtask = useCallback((taskId: string, subtaskId: string, direction: 'up' | 'down') => (
    runAction(taskId, (api) => api.moveSubtask({ subtaskId, direction }))
  ), [runAction]);

  return {
    board,
    cards: board?.cards ?? [],
    detail: selectedTaskId ? details[selectedTaskId] ?? null : null,
    selectedTaskId,
    loading,
    detailLoading,
    pending,
    error,
    actionError,
    reload,
    openDetail,
    closeDetail,
    openTaskChat,
    updateTask,
    setStage,
    completeTask,
    acceptSubtask,
    acceptAll,
    rejectSubtask,
    skipSubtask,
    unblockSubtask,
    beginSubtask,
    moveSubtask,
  };
}

export type UnifiedTaskScreen = ReturnType<typeof useUnifiedTasks>;
