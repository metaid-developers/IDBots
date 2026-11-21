import { useCallback, useEffect, useRef, useState } from 'react';
import { getMobileElectron, hasAppBridge } from '../appBridge';
import { t } from '../../i18n';

/**
 * Memory-entry management hook (CM5). Backed by the P2 cowork:memory:*
 * channels; on P1 tenants the gateway answers CHANNEL_NOT_ALLOWED, surfaced
 * as `tierBlocked` so the UI can explain the tenant switch instead of a
 * generic failure. `query` is server-side substring matching on text.
 */

export type MemoryUsageClass =
  | 'profile_fact'
  | 'preference'
  | 'operational_preference'
  | 'self_identity'
  | 'work_review'
  | 'value_boundary';

export interface MemoryEntryView {
  id: string;
  text: string;
  confidence: number;
  isExplicit: boolean;
  status: 'created' | 'stale' | 'deleted';
  usageClass?: MemoryUsageClass;
  origin?: 'conversation' | 'dream';
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
}

export interface MemoryEntryDraft {
  text: string;
  /** self_identity is dream-written only — the create channel rejects it. */
  usageClass: Exclude<MemoryUsageClass, 'self_identity'>;
}

export const MEMORY_USAGE_CLASS_KEYS: Record<MemoryUsageClass, string> = {
  profile_fact: 'mobile.memory.class.profileFact',
  preference: 'mobile.memory.class.preference',
  operational_preference: 'mobile.memory.class.operationalPreference',
  self_identity: 'mobile.memory.class.selfIdentity',
  work_review: 'mobile.memory.class.workReview',
  value_boundary: 'mobile.memory.class.valueBoundary',
};

export function useMemoryEntries(): {
  entries: MemoryEntryView[];
  archivedEntries: MemoryEntryView[];
  loading: boolean;
  error: string | null;
  tierBlocked: boolean;
  query: string;
  setQuery: (query: string) => void;
  reload: () => Promise<void>;
  create: (draft: MemoryEntryDraft) => Promise<boolean>;
  updateText: (id: string, text: string) => Promise<boolean>;
  remove: (id: string) => Promise<boolean>;
  archive: (id: string) => Promise<boolean>;
  unarchive: (id: string) => Promise<boolean>;
} {
  const [entries, setEntries] = useState<MemoryEntryView[]>([]);
  const [archivedEntries, setArchivedEntries] = useState<MemoryEntryView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tierBlocked, setTierBlocked] = useState(false);
  const [query, setQuery] = useState('');
  const requestRef = useRef(0);

  const reload = useCallback(async (): Promise<void> => {
    const request = ++requestRef.current;
    const cowork = hasAppBridge() ? getMobileElectron().cowork : undefined;
    if (!cowork?.listMemoryEntries) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const trimmed = query.trim();
      const input = {
        query: trimmed || undefined,
        status: 'all' as const,
        limit: 200,
      };
      const result = await cowork.listMemoryEntries(input);
      if (request !== requestRef.current) return;
      if (!result?.success) {
        const code = (result as { error?: string } | null)?.error ?? '';
        setTierBlocked(code.includes('CHANNEL_NOT_ALLOWED'));
        setError(code.includes('CHANNEL_NOT_ALLOWED') ? t('mobile.memory.tierBlocked') : t('mobile.common.error'));
        setEntries([]);
        setArchivedEntries([]);
        setLoading(false);
        return;
      }
      const rows = result.entries ?? [];
      setEntries(rows.filter((row) => row.status === 'created'));
      setArchivedEntries(rows.filter((row) => row.status === 'stale'));
    } catch {
      if (request !== requestRef.current) return;
      setError(t('mobile.common.error'));
    }
    setLoading(false);
  }, [query]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const mutate = useCallback(async (run: (
    cowork: NonNullable<ReturnType<typeof getMobileElectron>['cowork']>,
  ) => Promise<{ success: boolean }>): Promise<boolean> => {
    const cowork = hasAppBridge() ? getMobileElectron().cowork : undefined;
    if (!cowork) return false;
    try {
      const result = await run(cowork);
      if (!result?.success) return false;
    } catch {
      return false;
    }
    await reload();
    return true;
  }, [reload]);

  const create = useCallback((draft: MemoryEntryDraft): Promise<boolean> => mutate(async (cowork) => (
    cowork.createMemoryEntry({ text: draft.text, usageClass: draft.usageClass })
  )), [mutate]);

  const updateText = useCallback((id: string, text: string): Promise<boolean> => mutate(async (cowork) => (
    cowork.updateMemoryEntry({ id, text })
  )), [mutate]);

  const remove = useCallback((id: string): Promise<boolean> => mutate(async (cowork) => (
    cowork.deleteMemoryEntry({ id })
  )), [mutate]);

  const archive = useCallback((id: string): Promise<boolean> => mutate(async (cowork) => (
    cowork.updateMemoryEntry({ id, status: 'stale' })
  )), [mutate]);

  const unarchive = useCallback((id: string): Promise<boolean> => mutate(async (cowork) => (
    cowork.unarchiveMemoryEntry({ id })
  )), [mutate]);

  return {
    entries,
    archivedEntries,
    loading,
    error,
    tierBlocked,
    query,
    setQuery,
    reload,
    create,
    updateText,
    remove,
    archive,
    unarchive,
  };
}
