import { useSyncExternalStore } from 'react';
import {
  LINEAGE_OVERRIDE_STORAGE_KEY,
  parseLineageOverrides,
  serializeLineageOverrides,
  type LineageBucket,
  type LineageOverrides,
} from './processCenter';

/**
 * The 出口路由 override store (lineage v1, owner ruling 17:30).
 *
 * The pure parsing/serialising lives in `processCenter.ts`; this module owns the
 * ONE live copy plus the subscription, because two independent surfaces read it
 * and they must never disagree:
 *   · the rail badge (how many items need the owner),
 *   · the hub's 待你拍板 strip + 「bot 事项」silent bar.
 * A row flipped by the valve has to move BOTH numbers on the same tick — that
 * is the "三源同步" the order asks for, and it is why this is a store and not
 * per-component state.
 *
 * Storage is localStorage only (`idbots.processHub.lineageOverrides`): a
 * view-level routing choice, reversible per row, never a DB migration.
 */

let cache: Record<string, LineageBucket> | null = null;
const listeners = new Set<() => void>();

const readFromStorage = (): Record<string, LineageBucket> => {
  try {
    return parseLineageOverrides(window.localStorage.getItem(LINEAGE_OVERRIDE_STORAGE_KEY));
  } catch {
    // localStorage unavailable (private mode / quota): behave as "no overrides",
    // which is the documented default — every awaited run is bot-digested.
    return {};
  }
};

/** Stable snapshot (the same object until a write happens). */
export const getLineageOverrides = (): LineageOverrides => {
  if (cache === null) cache = readFromStorage();
  return cache;
};

const notify = () => {
  for (const listener of listeners) listener();
};

/** Flip ONE session's bucket and persist. Returns the new bucket. */
export const setLineageBucket = (sessionId: string, bucket: LineageBucket): LineageBucket => {
  const next: Record<string, LineageBucket> = { ...getLineageOverrides(), [sessionId]: bucket };
  cache = next;
  try {
    window.localStorage.setItem(LINEAGE_OVERRIDE_STORAGE_KEY, serializeLineageOverrides(next));
  } catch {
    // Persisting failed: the in-memory flip still applies for this session, so
    // the surface the owner just used never lies about what it did.
  }
  notify();
  return bucket;
};

export const subscribeLineageOverrides = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** Test/relaunch helper: drop the cache so the next read re-reads storage. */
export const resetLineageOverrideCache = (): void => {
  cache = null;
  notify();
};

/** The live map, subscribed — every consumer re-renders on a flip. */
export const useLineageOverrides = (): LineageOverrides =>
  useSyncExternalStore(subscribeLineageOverrides, getLineageOverrides, getLineageOverrides);
