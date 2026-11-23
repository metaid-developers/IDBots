/**
 * 进程详情 · 档案层 data hook (design: process-detail-body-redesign §5/§7).
 *
 * One read for the archive (N2 `processDossier:get`), one deeper read only when
 * the 200-event cap is actually hit (N3 `longtermTask:events`), and one pin
 * naming pass for chain anchors (N1 `metaweb:pinInfo`).
 *
 * The component stays pure: everything that can fail (bridge missing, read
 * failed, pin unreachable) is folded into `ProcessDossierView` here, so the
 * display never has to guess what a missing field means.
 */

import { useEffect, useMemo, useState } from 'react';
import type {
  LongTermSubtask,
  LongTermTaskDetail,
} from '../../types/longTermTask';
import type {
  MetawebPinInfo,
  ProcessDossierAttempt,
  ProcessDossierRun,
  ProcessDossierSnapshot,
} from '../../types/processDossier';
import {
  buildAnchorRows,
  buildCheckModel,
  buildDossierRounds,
  dossierTierOf,
  type DossierAnchorRow,
  type DossierCheckModel,
  type DossierRound,
  type DossierSubtaskMeta,
  type DossierTier,
} from '../../utils/processDossier';

export type PinLookupState =
  | { status: 'pending' }
  | { status: 'named'; info: MetawebPinInfo }
  | { status: 'unnamed' }
  | { status: 'unreachable' };

export interface ProcessDossierView {
  status: 'idle' | 'loading' | 'ready' | 'unsupported' | 'error';
  error: string | null;
  tier: DossierTier;
  task: LongTermTaskDetail | null;
  subtask: LongTermSubtask | null;
  checks: DossierCheckModel;
  rounds: DossierRound[];
  anchors: DossierAnchorRow[];
  pinLookup: ReadonlyMap<string, PinLookupState>;
  attempts: ProcessDossierAttempt[];
  runs: ProcessDossierRun[];
  /** true when even the deeper event read hit its 500-row ceiling. */
  eventsCapped: boolean;
}

interface SnapshotState {
  status: ProcessDossierView['status'];
  snapshot: ProcessDossierSnapshot | null;
  error: string | null;
}

const EMPTY_CHECKS: DossierCheckModel = { rows: [], passed: 0, total: 0, inferred: false };

const errorText = (error: unknown): string => (
  error instanceof Error ? error.message : String(error ?? '')
);

/** How many chain anchors get a naming pass per open (one IPC each). */
export const DOSSIER_PIN_LOOKUP_LIMIT = 12;

export const useProcessDossier = (
  sessionId: string | null | undefined,
  autoOrigin: string | null | undefined,
  enabled: boolean,
  reloadToken: number = 0,
): ProcessDossierView => {
  const [state, setState] = useState<SnapshotState>({ status: 'idle', snapshot: null, error: null });
  const [pinLookup, setPinLookup] = useState<Map<string, PinLookupState>>(() => new Map());

  useEffect(() => {
    if (!enabled || !sessionId) {
      setState({ status: 'idle', snapshot: null, error: null });
      return () => undefined;
    }
    const api = window.electron?.processDossier;
    if (!api?.get) {
      // Older host / mobile shell: say the channel is not connected instead of
      // rendering an empty dossier that reads as "nothing was verified".
      setState({ status: 'unsupported', snapshot: null, error: null });
      return () => undefined;
    }
    let cancelled = false;
    setState({ status: 'loading', snapshot: null, error: null });
    void (async () => {
      try {
        const result = await api.get({ sessionId });
        if (cancelled) return;
        if (!result?.success || !result.dossier) {
          setState({ status: 'error', snapshot: null, error: result?.error ?? null });
          return;
        }
        let snapshot = result.dossier;
        // N3: the detail projection caps at 200 events. When the cap is hit, one
        // deeper read (≤500) is the documented fix — never silently truncate a
        // long task's timeline.
        if (
          snapshot.task
          && snapshot.events.length >= snapshot.eventLimit
          && snapshot.eventLimit < 500
          && typeof window.electron?.longtermTask?.events === 'function'
        ) {
          try {
            const deeper = await window.electron.longtermTask.events({ taskId: snapshot.task.id, limit: 500 });
            if (cancelled) return;
            if (deeper?.success && Array.isArray(deeper.events)) {
              snapshot = { ...snapshot, events: deeper.events, eventLimit: 500 };
            }
          } catch {
            // The shallow read still stands; the block header reports the cap.
          }
        }
        setState({ status: 'ready', snapshot, error: null });
      } catch (error) {
        if (!cancelled) setState({ status: 'error', snapshot: null, error: errorText(error) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId, enabled, reloadToken]);

  const task = state.snapshot?.task ?? null;
  const subtask = useMemo(() => {
    const snapshot = state.snapshot;
    if (!snapshot?.task || !snapshot.subtaskId) return null;
    return snapshot.task.subtasks.find((entry) => entry.id === snapshot.subtaskId) ?? null;
  }, [state.snapshot]);

  const anchors = useMemo(
    () => buildAnchorRows(subtask?.evidence, subtask?.submission?.artifacts),
    [subtask],
  );

  useEffect(() => {
    if (!enabled) {
      setPinLookup(new Map());
      return () => undefined;
    }
    const ids = Array.from(new Set(
      anchors.map((row) => row.pinId).filter((id): id is string => Boolean(id)),
    )).slice(0, DOSSIER_PIN_LOOKUP_LIMIT);
    if (ids.length === 0) {
      setPinLookup(new Map());
      return () => undefined;
    }
    const api = window.electron?.metaweb?.pinInfo;
    if (typeof api !== 'function') {
      // No naming channel: every anchor honestly reads as 未点名 (id only).
      setPinLookup(new Map(ids.map((id) => [id, { status: 'unnamed' } as PinLookupState])));
      return () => undefined;
    }
    let cancelled = false;
    setPinLookup(new Map(ids.map((id) => [id, { status: 'pending' } as PinLookupState])));
    void (async () => {
      for (const id of ids) {
        let next: PinLookupState;
        try {
          const result = await api({ pinId: id });
          next = result?.success && result.info
            ? { status: 'named', info: result.info }
            : { status: result?.code === 'unavailable' ? 'unreachable' : 'unnamed' };
        } catch {
          next = { status: 'unreachable' };
        }
        if (cancelled) return;
        setPinLookup((previous) => {
          const updated = new Map(previous);
          updated.set(id, next);
          return updated;
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, anchors]);

  const rounds = useMemo(() => {
    if (!task) return [];
    const meta = new Map<string, DossierSubtaskMeta>();
    for (const entry of task.subtasks) {
      meta.set(entry.id, { title: entry.title, channel: entry.preferredChannel ?? null });
    }
    return buildDossierRounds(state.snapshot?.events, meta);
  }, [task, state.snapshot]);

  return useMemo(() => {
    const snapshot = state.snapshot;
    const tier = dossierTierOf(autoOrigin);
    return {
      status: state.status,
      error: state.error,
      tier,
      task,
      subtask,
      checks: subtask ? buildCheckModel(subtask) : EMPTY_CHECKS,
      rounds,
      anchors,
      pinLookup,
      attempts: snapshot?.attempts ?? [],
      runs: snapshot?.runs ?? [],
      eventsCapped: Boolean(
        snapshot?.task
        && snapshot.events.length >= snapshot.eventLimit
        && snapshot.eventLimit >= 500,
      ),
    };
  }, [state, autoOrigin, task, subtask, rounds, anchors, pinLookup]);
};
