import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { coworkService } from '../../services/cowork';
import { i18nService } from '../../services/i18n';
import { useSelector } from 'react-redux';
import { RootState } from '../../store';
import {
  PlusCircleIcon,
  ChevronRightIcon,
  ArrowPathIcon,
  ExclamationTriangleIcon,
  Cog6ToothIcon,
} from '@heroicons/react/24/outline';
import type {
  CoworkUserMemoryEntry,
  CoworkMemoryStats,
  CoworkMemoryPolicy,
  CoworkMemoryScopesOverview,
  CoworkMetaIDContactSummary,
  CoworkMetaIDContactDetail,
  CoworkKnowledgeEntry,
  CoworkKnowledgeKind,
  MemoryHygieneConfig,
  MemoryHygieneRunStats,
  TeamCultureEntry,
  TeamCultureActiveCounts,
  TeamCultureDistillationRecord,
  TeamCultureKind,
  TaskCommTrendRow,
} from '../../types/cowork';
import MetaIDContactPanel, { ContactGlobalMetaIdHint } from './MetaIDContactPanel';
import DreamTelemetryPanel from './DreamTelemetryPanel';
import CapabilityDraftsPanel, { type CapabilityDraftItem } from './CapabilityDraftsPanel';
import BrainIcon from '../icons/BrainIcon';

type MetabotOption = {
  id: number;
  name: string;
  avatar: string | null;
  metabot_type: string;
  globalmetaid: string | null;
};

type MemorySection = 'knowledge' | 'contacts' | 'facts' | 'dream' | 'culture';

/** Usage classes a user may assign manually. `self_identity` is dream-protected. */
type EditableUsageClass = 'profile_fact' | 'preference' | 'operational_preference' | 'work_review' | 'value_boundary';

type DreamDiarySummary = {
  id: string;
  metabotId: number;
  summaryDate: string;
  summaryText: string;
  sections: Record<string, string>;
  stats: Record<string, number>;
  sessionRefs?: Array<{ sessionId: string; title: string; sessionType: string; isOrder: boolean }>;
  llmId: string | null;
  createdAt: number;
  updatedAt: number;
};

type DreamDiaryRun = {
  id: string;
  metabotId: number;
  dreamDate: string;
  status: 'running' | 'completed' | 'failed' | 'terminal-failed';
  attemptCount: number;
  llmId: string | null;
  dreamVersion: number;
  error: string | null;
  telemetry?: Record<string, unknown> | null;
  startedAt: number;
  completedAt: number | null;
  nextRetryAt: number | null;
};

type GuardLevel = 'strict' | 'standard' | 'relaxed';

interface PolicyDraft {
  memoryEnabled: boolean;
  memoryImplicitUpdateEnabled: boolean;
  memoryLlmJudgeEnabled: boolean;
  memoryGuardLevel: GuardLevel;
  memoryUserMemoriesMaxItems: number;
}

const formatLocalDateInput = (date: Date): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const formatTimestamp = (timestamp: number | null): string => {
  if (!Number.isFinite(timestamp as number) || (timestamp as number) <= 0) return '-';
  try {
    return new Date(timestamp as number).toLocaleString();
  } catch {
    return '-';
  }
};

const getUsageClassLabel = (usageClass?: CoworkUserMemoryEntry['usageClass']): string | null => {
  if (usageClass === 'self_identity') return i18nService.t('coworkMemorySelfIdentity');
  if (usageClass === 'profile_fact') return i18nService.t('coworkMemoryUsageProfileFact');
  if (usageClass === 'preference') return i18nService.t('coworkMemoryUsagePreference');
  if (usageClass === 'operational_preference') return i18nService.t('coworkMemoryUsageOperationalPreference');
  if (usageClass === 'work_review') return i18nService.t('coworkMemoryUsageWorkReview');
  if (usageClass === 'value_boundary') return i18nService.t('coworkMemoryUsageValueBoundary');
  return null;
};

const getKnowledgeKindLabel = (kind: CoworkKnowledgeKind): string => {
  if (kind === 'know_how') return i18nService.t('memoryKnowledgeKindKnowHow');
  if (kind === 'pitfall') return i18nService.t('memoryKnowledgeKindPitfall');
  return i18nService.t('memoryKnowledgeKindPrinciple');
};

const getKnowledgeOriginLabel = (origin: CoworkKnowledgeEntry['origin']): string => {
  if (origin === 'dream') return i18nService.t('memoryKnowledgeOriginDream');
  if (origin === 'user') return i18nService.t('memoryKnowledgeOriginUser');
  return i18nService.t('memoryKnowledgeOriginAgent');
};

const KNOWLEDGE_KIND_ACCENT: Record<CoworkKnowledgeKind, string> = {
  know_how: 'border-emerald-500/50 text-emerald-600 dark:text-emerald-400',
  pitfall: 'border-amber-500/50 text-amber-600 dark:text-amber-400',
  principle: 'border-sky-500/50 text-sky-600 dark:text-sky-400',
};

const MemorySettings: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const coworkConfig = useSelector((state: RootState) => state.cowork.config);

  // --- MetaBot selection ---
  const [metabots, setMetabots] = useState<MetabotOption[]>([]);
  const [metabotId, setMetabotId] = useState<number | null>(null);

  // --- Section tabs ---
  const [activeSection, setActiveSection] = useState<MemorySection>('knowledge');

  // --- Knowledge ---
  const [knowledge, setKnowledge] = useState<CoworkKnowledgeEntry[]>([]);
  const [knowledgeLoading, setKnowledgeLoading] = useState(false);
  const [knowledgeKind, setKnowledgeKind] = useState<CoworkKnowledgeKind | 'all'>('all');
  const [knowledgeQuery, setKnowledgeQuery] = useState('');
  const [knowledgeCounts, setKnowledgeCounts] = useState<number>(0);
  const [editingKnowledgeId, setEditingKnowledgeId] = useState<string | null>(null);
  const [knowledgeDraftTopic, setKnowledgeDraftTopic] = useState('');
  const [knowledgeDraftSummary, setKnowledgeDraftSummary] = useState('');
  const [knowledgeDraftKind, setKnowledgeDraftKind] = useState<CoworkKnowledgeKind>('know_how');

  // --- Facts (owner-scope user_memories) ---
  const [facts, setFacts] = useState<CoworkUserMemoryEntry[]>([]);
  const [factsStats, setFactsStats] = useState<CoworkMemoryStats | null>(null);
  const [factsLoading, setFactsLoading] = useState(false);
  const [factsQuery, setFactsQuery] = useState('');
  const [factsShowArchived, setFactsShowArchived] = useState(false);
  const [scopes, setScopes] = useState<CoworkMemoryScopesOverview | null>(null);

  // --- Self-identity (the bot's self-cognition; dream-managed) ---
  const [selfIdentity, setSelfIdentity] = useState<CoworkUserMemoryEntry | null>(null);

  // --- Contacts (ID-anchored impressions) ---
  const [contacts, setContacts] = useState<CoworkMetaIDContactSummary[]>([]);
  const [contactsLoading, setContactsLoading] = useState(false);
  const [selectedContactId, setSelectedContactId] = useState<string | null>(null);
  const [contactDetail, setContactDetail] = useState<CoworkMetaIDContactDetail | null>(null);
  const [contactDetailLoading, setContactDetailLoading] = useState(false);

  // --- Dream diary ---
  const [dreamSummaries, setDreamSummaries] = useState<DreamDiarySummary[]>([]);
  const [dreamRuns, setDreamRuns] = useState<DreamDiaryRun[]>([]);
  const [dreamLoading, setDreamLoading] = useState(false);
  const [capabilityDrafts, setCapabilityDrafts] = useState<CapabilityDraftItem[]>([]);
  const [dreamExpandedId, setDreamExpandedId] = useState<string | null>(null);
  const [dreamRunDate, setDreamRunDate] = useState<string>(() => {
    const now = new Date();
    return formatLocalDateInput(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
  });
  const [dreamRunning, setDreamRunning] = useState(false);
  const [dreamNotice, setDreamNotice] = useState<string | null>(null);

  // --- Memory entry editor modal ---
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftText, setDraftText] = useState('');
  const [draftUsageClass, setDraftUsageClass] = useState<EditableUsageClass>('profile_fact');
  const [draftVisibility, setDraftVisibility] = useState<'local_only' | 'external_safe'>('local_only');
  const [showModal, setShowModal] = useState(false);

  // --- Policy ---
  const [policy, setPolicy] = useState<CoworkMemoryPolicy | null>(null);
  const [policyLoading, setPolicyLoading] = useState(false);
  const [policySaving, setPolicySaving] = useState(false);
  const [policyNotice, setPolicyNotice] = useState<string | null>(null);
  const [policyOpen, setPolicyOpen] = useState(false);
  const [useOverride, setUseOverride] = useState(false);
  const [draft, setDraft] = useState<PolicyDraft>({
    memoryEnabled: true,
    memoryImplicitUpdateEnabled: true,
    memoryLlmJudgeEnabled: true,
    memoryGuardLevel: 'strict',
    memoryUserMemoriesMaxItems: 20,
  });

  // --- Memory hygiene (active-forgetting / compression stroke) ---
  const [hygiene, setHygiene] = useState<MemoryHygieneConfig | null>(null);
  const [hygieneLastRun, setHygieneLastRun] = useState<MemoryHygieneRunStats | null>(null);
  const [hygieneOpen, setHygieneOpen] = useState(false);
  // Eight numeric knobs is a wall of inputs — keep the thresholds block
  // collapsed until the user asks for it.
  const [hygieneThresholdsOpen, setHygieneThresholdsOpen] = useState(false);
  const [hygieneSaving, setHygieneSaving] = useState(false);
  const [hygieneRunning, setHygieneRunning] = useState(false);
  const [hygieneNotice, setHygieneNotice] = useState<string | null>(null);

  // --- Team culture (fleet-shared; independent of the selected bot) ---
  const [cultureEntries, setCultureEntries] = useState<TeamCultureEntry[]>([]);
  const [cultureCounts, setCultureCounts] = useState<TeamCultureActiveCounts | null>(null);
  const [cultureLoading, setCultureLoading] = useState(false);
  const [cultureKindFilter, setCultureKindFilter] = useState<TeamCultureKind | 'all'>('all');
  const [cultureQuery, setCultureQuery] = useState('');
  const [cultureNotice, setCultureNotice] = useState<string | null>(null);
  const [editingCultureId, setEditingCultureId] = useState<string | null>(null);
  const [commTrend, setCommTrend] = useState<TaskCommTrendRow[]>([]);
  const [cultureEnabled, setCultureEnabled] = useState<boolean>(true);
  const [cultureDistillationLog, setCultureDistillationLog] = useState<TeamCultureDistillationRecord[]>([]);
  const [cultureDraft, setCultureDraft] = useState<{ kind: TeamCultureKind; topic: string; text: string }>({
    kind: 'convention',
    topic: '',
    text: '',
  });

  const [error, setError] = useState<string | null>(null);

  const selectedMetabot = useMemo(
    () => metabots.find((item) => item.id === metabotId) ?? null,
    [metabots, metabotId],
  );
  const observerGlobalMetaId = selectedMetabot?.globalmetaid?.trim() || null;

  // ---- MetaBot loading ----
  const loadMetabots = useCallback(async () => {
    try {
      const result = await window.electron?.metabot?.list();
      const list: MetabotOption[] = result?.success && Array.isArray(result.list)
        ? result.list
          .filter((item) => (
            typeof item?.id === 'number'
            && Number.isFinite(item.id)
            && item.id > 0
            && typeof item?.name === 'string'
          ))
          .map((item) => ({
            id: item.id,
            name: item.name,
            avatar: item.avatar ?? null,
            metabot_type: item.metabot_type === 'worker' ? 'worker' : 'twin',
            globalmetaid: item.globalmetaid ?? null,
          }))
        : [];
      setMetabots(list);
      setMetabotId((current) => {
        if (current != null && list.some((item) => item.id === current)) return current;
        const defaultTwin = list.find((item) => item.metabot_type === 'twin');
        if (defaultTwin) return defaultTwin.id;
        return list.length > 0 ? list[0].id : null;
      });
    } catch (loadError) {
      console.error('Failed to load MetaBots:', loadError);
      setMetabots([]);
      setMetabotId(null);
    }
  }, []);

  useEffect(() => {
    void loadMetabots();
  }, [loadMetabots]);

  // ---- Knowledge loading ----
  const loadKnowledge = useCallback(async () => {
    if (metabotId == null) {
      setKnowledge([]);
      setKnowledgeCounts(0);
      return;
    }
    setKnowledgeLoading(true);
    try {
      const [filtered, all] = await Promise.all([
        coworkService.listKnowledge({
          metabotId,
          kind: knowledgeKind === 'all' ? undefined : knowledgeKind,
          status: 'active',
          query: knowledgeQuery.trim() || undefined,
          limit: 200,
        }),
        coworkService.listKnowledge({ metabotId, status: 'active', limit: 500 }),
      ]);
      setKnowledge(filtered);
      setKnowledgeCounts(all.length);
    } catch (loadError) {
      console.error('Failed to load knowledge:', loadError);
      setKnowledge([]);
      setKnowledgeCounts(0);
    } finally {
      setKnowledgeLoading(false);
    }
  }, [metabotId, knowledgeKind, knowledgeQuery]);

  useEffect(() => {
    if (activeSection !== 'knowledge') return;
    const debounce = setTimeout(() => { void loadKnowledge(); }, 250);
    return () => clearTimeout(debounce);
  }, [activeSection, loadKnowledge]);

  const startEditKnowledge = (entry: CoworkKnowledgeEntry) => {
    setEditingKnowledgeId(entry.id);
    setKnowledgeDraftTopic(entry.topic);
    setKnowledgeDraftSummary(entry.summary);
    setKnowledgeDraftKind(entry.kind);
  };

  const cancelEditKnowledge = () => {
    setEditingKnowledgeId(null);
  };

  const handleSaveKnowledgeEdit = async () => {
    if (metabotId == null || editingKnowledgeId == null) return;
    const topic = knowledgeDraftTopic.trim();
    const summary = knowledgeDraftSummary.trim();
    if (!topic || !summary) return;
    try {
      const updated = await coworkService.updateKnowledge({
        id: editingKnowledgeId,
        metabotId,
        topic,
        summary,
        kind: knowledgeDraftKind,
      });
      if (updated) {
        setEditingKnowledgeId(null);
        await loadKnowledge();
      }
    } catch (saveError) {
      console.error('Failed to update knowledge:', saveError);
    }
  };

  const handleDeleteKnowledge = async (entry: CoworkKnowledgeEntry) => {
    if (metabotId == null) return;
    if (!window.confirm(i18nService.t('memoryKnowledgeDeleteHint'))) return;
    try {
      const ok = await coworkService.deleteKnowledge({ id: entry.id, metabotId });
      if (ok) {
        if (editingKnowledgeId === entry.id) setEditingKnowledgeId(null);
        await loadKnowledge();
      }
    } catch (deleteError) {
      console.error('Failed to delete knowledge:', deleteError);
    }
  };

  // ---- Self-identity loading (bot's self-cognition, dream-managed) ----
  const loadSelfIdentity = useCallback(async () => {
    if (metabotId == null) {
      setSelfIdentity(null);
      return;
    }
    try {
      const entries = await coworkService.listMemoryEntries({
        metabotId,
        scopeKind: 'owner',
        scopeKey: scopes?.owner?.key ?? 'owner:self',
        usageClass: 'self_identity',
        status: 'created',
        limit: 1,
      });
      setSelfIdentity(entries[0] ?? null);
    } catch (loadError) {
      console.error('Failed to load self-identity:', loadError);
      setSelfIdentity(null);
    }
  }, [metabotId, scopes]);

  useEffect(() => {
    void loadSelfIdentity();
  }, [loadSelfIdentity]);

  // ---- Facts loading ----
  const loadFacts = useCallback(async () => {
    if (metabotId == null) {
      setFacts([]);
      setFactsStats(null);
      return;
    }
    setFactsLoading(true);
    try {
      const [entries, stats] = await Promise.all([
        coworkService.listMemoryEntries({
          metabotId,
          scopeKind: 'owner',
          scopeKey: scopes?.owner?.key ?? 'owner:self',
          query: factsQuery.trim() || undefined,
          includeArchived: factsShowArchived,
        }),
        coworkService.getMemoryStats({
          metabotId,
          scopeKind: 'owner',
          scopeKey: scopes?.owner?.key ?? 'owner:self',
        }),
      ]);
      setFacts(entries);
      setFactsStats(stats);
    } catch (loadError) {
      console.error('Failed to load owner facts:', loadError);
      setFacts([]);
      setFactsStats(null);
    } finally {
      setFactsLoading(false);
    }
  }, [metabotId, factsQuery, factsShowArchived, scopes]);

  const loadScopes = useCallback(async () => {
    if (metabotId == null) {
      setScopes(null);
      return;
    }
    try {
      setScopes(await coworkService.listMemoryScopes({ metabotId }) ?? null);
    } catch (loadError) {
      console.error('Failed to load memory scopes:', loadError);
      setScopes(null);
    }
  }, [metabotId]);

  useEffect(() => {
    if (activeSection === 'facts') {
      const debounce = setTimeout(() => { void loadFacts(); }, 250);
      return () => clearTimeout(debounce);
    }
    return undefined;
  }, [activeSection, loadFacts]);

  useEffect(() => {
    if (metabotId == null) return;
    void loadScopes();
  }, [metabotId, loadScopes]);

  // ---- Contacts loading ----
  const loadContacts = useCallback(async () => {
    if (!observerGlobalMetaId) {
      setContacts([]);
      return;
    }
    setContactsLoading(true);
    try {
      setContacts(await coworkService.listMetaIDContacts({ observerGlobalMetaId: observerGlobalMetaId }));
    } catch (loadError) {
      console.error('Failed to load contacts:', loadError);
      setContacts([]);
    } finally {
      setContactsLoading(false);
    }
  }, [observerGlobalMetaId]);

  const loadContactDetail = useCallback(async (subjectGlobalMetaId: string | null) => {
    if (!observerGlobalMetaId || !subjectGlobalMetaId) {
      setContactDetail(null);
      return;
    }
    setContactDetailLoading(true);
    try {
      setContactDetail(await coworkService.getMetaIDContactDetail({
        observerGlobalMetaId: observerGlobalMetaId,
        subjectGlobalMetaId,
      }));
    } catch (loadError) {
      console.error('Failed to load contact detail:', loadError);
      setContactDetail(null);
    } finally {
      setContactDetailLoading(false);
    }
  }, [observerGlobalMetaId]);

  useEffect(() => {
    if (activeSection !== 'contacts') return;
    void loadContacts();
  }, [activeSection, loadContacts]);

  useEffect(() => {
    if (activeSection !== 'contacts' || !selectedContactId) {
      setContactDetail(null);
      return;
    }
    void loadContactDetail(selectedContactId);
  }, [activeSection, selectedContactId, loadContactDetail]);

  // ---- Dream diary loading ----
  const dreamEntries: Array<
    | { kind: 'summary'; date: string; summary: DreamDiarySummary }
    | { kind: 'failed'; date: string; run: DreamDiaryRun }
  > = useMemo(() => [
    ...dreamSummaries.map((summary) => ({ kind: 'summary' as const, date: summary.summaryDate, summary })),
    ...dreamRuns
      .filter((run) => run.status === 'failed' || run.status === 'terminal-failed')
      .filter((run) => !dreamSummaries.some((summary) => summary.summaryDate === run.dreamDate))
      .map((run) => ({ kind: 'failed' as const, date: run.dreamDate, run })),
  ].sort((a, b) => b.date.localeCompare(a.date)), [dreamSummaries, dreamRuns]);

  const loadDream = useCallback(async () => {
    if (metabotId == null) {
      setDreamSummaries([]);
      setDreamRuns([]);
      setCapabilityDrafts([]);
      return;
    }
    setDreamLoading(true);
    try {
      const [summariesResult, runsResult, draftsResult] = await Promise.all([
        window.electron?.dream?.listDailySummaries({ metabotId, limit: 60 }),
        window.electron?.dream?.listRuns({ metabotId, limit: 60 }),
        window.electron?.dream?.listCapabilityDrafts({ metabotId, limit: 200 }),
      ]);
      setDreamSummaries(
        (summariesResult?.success && Array.isArray(summariesResult.summaries) ? summariesResult.summaries : []) as DreamDiarySummary[],
      );
      setDreamRuns(
        (runsResult?.success && Array.isArray(runsResult.runs) ? runsResult.runs : []) as DreamDiaryRun[],
      );
      setCapabilityDrafts(
        (draftsResult?.success && Array.isArray(draftsResult.drafts) ? draftsResult.drafts : []) as CapabilityDraftItem[],
      );
    } catch (loadError) {
      console.error('Failed to load dream diary:', loadError);
      setDreamSummaries([]);
      setDreamRuns([]);
      setCapabilityDrafts([]);
    } finally {
      setDreamLoading(false);
    }
  }, [metabotId]);

  useEffect(() => {
    if (activeSection !== 'dream') return;
    void loadDream();
  }, [activeSection, loadDream]);

  const handleForceDream = async (dateOverride?: string) => {
    const targetDate = dateOverride ?? dreamRunDate;
    if (metabotId == null || !targetDate || dreamRunning) return;
    setDreamRunning(true);
    setDreamNotice(null);
    try {
      const result = await window.electron?.dream?.runNow({ metabotId, date: targetDate });
      if (!result?.success) {
        throw new Error(result?.error || i18nService.t('dreamDiaryForceFailed'));
      }
      if (result.run?.status === 'failed' || result.run?.status === 'terminal-failed') {
        setDreamNotice(`${i18nService.t('dreamDiaryForceFailed')}: ${result.run.error || i18nService.t('dreamDiaryForceFailed')}`);
      } else {
        setDreamNotice(i18nService.t('dreamDiaryForceCompleted'));
      }
      await loadDream();
    } catch (runError) {
      console.error('Failed to force dream:', runError);
      setDreamNotice(`${i18nService.t('dreamDiaryForceFailed')}: ${runError instanceof Error ? runError.message : String(runError)}`);
    } finally {
      setDreamRunning(false);
    }
  };

  const handleOpenSession = (sessionId: string) => {
    const trimmed = sessionId?.trim();
    if (!trimmed) return;
    onClose();
    window.dispatchEvent(new CustomEvent('cowork:viewSession', { detail: { sessionId: trimmed } }));
  };

  // ---- Policy loading ----
  const applyPolicyToDraft = useCallback((nextPolicy: CoworkMemoryPolicy) => {
    setDraft({
      memoryEnabled: nextPolicy.memoryEnabled,
      memoryImplicitUpdateEnabled: nextPolicy.memoryImplicitUpdateEnabled,
      memoryLlmJudgeEnabled: nextPolicy.memoryLlmJudgeEnabled,
      memoryGuardLevel: nextPolicy.memoryGuardLevel,
      memoryUserMemoriesMaxItems: nextPolicy.memoryUserMemoriesMaxItems,
    });
    setUseOverride(nextPolicy.source === 'metabot');
  }, []);

  const loadPolicy = useCallback(async () => {
    if (metabotId == null) {
      setPolicy(null);
      return;
    }
    setPolicyLoading(true);
    setPolicyNotice(null);
    try {
      const nextPolicy = await coworkService.getMemoryPolicy({ metabotId });
      if (!nextPolicy) {
        setPolicy(null);
        return;
      }
      setPolicy(nextPolicy);
      applyPolicyToDraft(nextPolicy);
    } catch (loadError) {
      console.error('Failed to load memory policy:', loadError);
      setPolicy(null);
    } finally {
      setPolicyLoading(false);
    }
  }, [metabotId, applyPolicyToDraft]);

  useEffect(() => {
    void loadPolicy();
  }, [loadPolicy]);

  // Sync draft from the global config whenever the metabot has no override and
  // the global redux values change (e.g. another tab updated them).
  useEffect(() => {
    if (policy?.source === 'global') {
      setDraft({
        memoryEnabled: coworkConfig.memoryEnabled ?? true,
        memoryImplicitUpdateEnabled: coworkConfig.memoryImplicitUpdateEnabled ?? true,
        memoryLlmJudgeEnabled: coworkConfig.memoryLlmJudgeEnabled ?? true,
        memoryGuardLevel: coworkConfig.memoryGuardLevel ?? 'strict',
        memoryUserMemoriesMaxItems: coworkConfig.memoryUserMemoriesMaxItems ?? 20,
      });
    }
  }, [
    policy?.source,
    coworkConfig.memoryEnabled,
    coworkConfig.memoryImplicitUpdateEnabled,
    coworkConfig.memoryLlmJudgeEnabled,
    coworkConfig.memoryGuardLevel,
    coworkConfig.memoryUserMemoriesMaxItems,
  ]);

  const draftBaseline: PolicyDraft = useMemo(() => {
    if (policy) {
      return {
        memoryEnabled: policy.memoryEnabled,
        memoryImplicitUpdateEnabled: policy.memoryImplicitUpdateEnabled,
        memoryLlmJudgeEnabled: policy.memoryLlmJudgeEnabled,
        memoryGuardLevel: policy.memoryGuardLevel,
        memoryUserMemoriesMaxItems: policy.memoryUserMemoriesMaxItems,
      };
    }
    return {
      memoryEnabled: coworkConfig.memoryEnabled ?? true,
      memoryImplicitUpdateEnabled: coworkConfig.memoryImplicitUpdateEnabled ?? true,
      memoryLlmJudgeEnabled: coworkConfig.memoryLlmJudgeEnabled ?? true,
      memoryGuardLevel: coworkConfig.memoryGuardLevel ?? 'strict',
      memoryUserMemoriesMaxItems: coworkConfig.memoryUserMemoriesMaxItems ?? 20,
    };
  }, [policy, coworkConfig]);

  const hasPolicyChanges = useMemo(() => (
    draft.memoryEnabled !== draftBaseline.memoryEnabled
    || draft.memoryImplicitUpdateEnabled !== draftBaseline.memoryImplicitUpdateEnabled
    || draft.memoryLlmJudgeEnabled !== draftBaseline.memoryLlmJudgeEnabled
    || draft.memoryGuardLevel !== draftBaseline.memoryGuardLevel
    || draft.memoryUserMemoriesMaxItems !== draftBaseline.memoryUserMemoriesMaxItems
  ), [draft, draftBaseline]);

  const handleSavePolicy = async () => {
    if (metabotId == null) return;
    setPolicySaving(true);
    setPolicyNotice(null);
    try {
      const normalizedMaxItems = Math.max(1, Math.min(60, Math.floor(draft.memoryUserMemoriesMaxItems || 20)));
      if (useOverride) {
        const saved = await coworkService.setMemoryPolicy({
          metabotId,
          memoryEnabled: draft.memoryEnabled,
          memoryImplicitUpdateEnabled: draft.memoryImplicitUpdateEnabled,
          memoryLlmJudgeEnabled: draft.memoryLlmJudgeEnabled,
          memoryGuardLevel: draft.memoryGuardLevel,
          memoryUserMemoriesMaxItems: normalizedMaxItems,
        });
        if (!saved) throw new Error(i18nService.t('coworkMemoryMetabotPolicySaveFailed'));
        setPolicy(saved);
        applyPolicyToDraft(saved);
      } else {
        await coworkService.updateConfig({
          memoryEnabled: draft.memoryEnabled,
          memoryImplicitUpdateEnabled: draft.memoryImplicitUpdateEnabled,
          memoryLlmJudgeEnabled: draft.memoryLlmJudgeEnabled,
          memoryGuardLevel: draft.memoryGuardLevel,
          memoryUserMemoriesMaxItems: normalizedMaxItems,
        });
        await loadPolicy();
      }
      setPolicyNotice(i18nService.t('memoryPolicySaved'));
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : i18nService.t('coworkMemoryMetabotPolicySaveFailed'));
    } finally {
      setPolicySaving(false);
    }
  };

  // Turning the override off resets the bot to the global default (deletes any
  // per-bot row); turning it on just routes the next save to the per-bot store.
  const handleToggleOverride = async (next: boolean) => {
    if (!next && metabotId != null && policy?.source === 'metabot') {
      setPolicySaving(true);
      try {
        const ok = await coworkService.deleteMemoryPolicy(metabotId);
        if (ok) {
          setPolicyNotice(i18nService.t('memoryPolicyResetDone'));
          await loadPolicy();
        }
      } catch (resetError) {
        setError(resetError instanceof Error ? resetError.message : i18nService.t('coworkMemoryMetabotPolicySaveFailed'));
      } finally {
        setPolicySaving(false);
      }
    }
    setUseOverride(next);
  };

  // ---- Memory hygiene (active forgetting) ----
  const loadHygiene = useCallback(async () => {
    try {
      const { config, lastRun } = await coworkService.getMemoryHygiene();
      setHygiene(config);
      setHygieneLastRun(lastRun);
    } catch (hygieneError) {
      console.error('Failed to load memory hygiene config:', hygieneError);
    }
  }, []);

  useEffect(() => {
    void loadHygiene();
  }, [loadHygiene]);

  const updateHygieneField = (field: keyof MemoryHygieneConfig, value: number | boolean) => {
    setHygiene((prev) => (prev ? { ...prev, [field]: value } : prev));
  };

  const handleSaveHygiene = async () => {
    if (!hygiene) return;
    setHygieneSaving(true);
    setHygieneNotice(null);
    try {
      const saved = await coworkService.setMemoryHygieneConfig({
        enabled: hygiene.enabled,
        observationRetentionDays: hygiene.observationRetentionDays,
        observationAnchorsPerPair: hygiene.observationAnchorsPerPair,
        episodeArchiveDays: hygiene.episodeArchiveDays,
        memoryDecayDays: hygiene.memoryDecayDays,
        tombstonePurgeDays: hygiene.tombstonePurgeDays,
        knowledgeRevisionKeep: hygiene.knowledgeRevisionKeep,
        dreamRunRetentionDays: hygiene.dreamRunRetentionDays,
        deepConsolidationEnabled: hygiene.deepConsolidationEnabled,
        deepConsolidationIntervalDays: hygiene.deepConsolidationIntervalDays,
      });
      if (!saved) throw new Error(i18nService.t('memoryHygieneSaveFailed'));
      setHygiene(saved);
      setHygieneNotice(i18nService.t('memoryHygieneSaved'));
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : i18nService.t('memoryHygieneSaveFailed'));
    } finally {
      setHygieneSaving(false);
    }
  };

  const handleToggleBotHygiene = async (next: boolean) => {
    if (metabotId == null) return;
    setHygieneSaving(true);
    try {
      const saved = await coworkService.setMemoryPolicy({ metabotId, hygieneEnabled: next });
      if (!saved) throw new Error(i18nService.t('coworkMemoryMetabotPolicySaveFailed'));
      setPolicy(saved);
      setHygieneNotice(i18nService.t(next ? 'memoryHygieneBotEnabled' : 'memoryHygieneBotDisabled'));
    } catch (toggleError) {
      setError(toggleError instanceof Error ? toggleError.message : i18nService.t('coworkMemoryMetabotPolicySaveFailed'));
    } finally {
      setHygieneSaving(false);
    }
  };

  // Per-bot dream participation: same per-bot policy row as hygiene, surfaced
  // in the Dream diary section where the owner looks for dream controls.
  const handleToggleBotDream = async (next: boolean) => {
    if (metabotId == null) return;
    setDreamRunning(true);
    setDreamNotice(null);
    try {
      const saved = await coworkService.setMemoryPolicy({ metabotId, dreamEnabled: next });
      if (!saved) throw new Error(i18nService.t('coworkMemoryMetabotPolicySaveFailed'));
      setPolicy(saved);
      setDreamNotice(i18nService.t(next ? 'memoryDreamBotEnabled' : 'memoryDreamBotDisabled'));
    } catch (toggleError) {
      setError(toggleError instanceof Error ? toggleError.message : i18nService.t('coworkMemoryMetabotPolicySaveFailed'));
    } finally {
      setDreamRunning(false);
    }
  };

  const handleRunHygieneNow = async () => {
    setHygieneRunning(true);
    setHygieneNotice(null);
    try {
      const { stats, error } = await coworkService.runMemoryHygieneNow();
      if (error) {
        throw new Error(/already in progress/i.test(error) ? i18nService.t('memoryHygieneInProgress') : error);
      }
      if (!stats) throw new Error(i18nService.t('memoryHygieneRunFailed'));
      setHygieneLastRun(stats);
      setHygieneNotice(stats.errors.length > 0
        ? `${i18nService.t('memoryHygieneRunPartial')} (${stats.errors.length}): ${stats.errors[0]}`
        : i18nService.t('memoryHygieneRunDone'));
    } catch (runError) {
      setHygieneNotice(`${i18nService.t('memoryHygieneRunFailed')}: ${runError instanceof Error ? runError.message : String(runError)}`);
    } finally {
      setHygieneRunning(false);
    }
  };

  // A scheduled nightly pass may land while the page is open — keep the
  // last-run panel live.
  useEffect(() => {
    const unsubscribe = window.electron?.cowork?.onMemoryHygieneStatusChanged?.((stats) => {
      if (stats) {
        setHygieneLastRun(stats);
      }
    });
    return () => {
      unsubscribe?.();
    };
  }, []);

  // ---- Team culture ----
  const loadCulture = useCallback(async () => {
    setCultureLoading(true);
    try {
      const { entries, activeCounts } = await coworkService.listTeamCulture({
        kind: cultureKindFilter,
        status: 'all',
        query: cultureQuery.trim() || undefined,
      });
      setCultureEntries(entries);
      setCultureCounts(activeCounts);
      setCommTrend(await coworkService.listTaskCommTrend());
      setCultureEnabled((await coworkService.getTeamCultureConfig()).enabled);
      setCultureDistillationLog(await coworkService.listTeamCultureDistillationLog());
    } catch (cultureError) {
      console.error('Failed to load team culture:', cultureError);
      setCultureEntries([]);
    } finally {
      setCultureLoading(false);
    }
  }, [cultureKindFilter, cultureQuery]);

  useEffect(() => {
    if (activeSection !== 'culture') return;
    void loadCulture();
  }, [activeSection, loadCulture]);

  const resetCultureEditor = () => {
    setEditingCultureId(null);
    setCultureDraft({ kind: 'convention', topic: '', text: '' });
  };

  const handleSaveCulture = async () => {
    if (!cultureDraft.topic.trim() || !cultureDraft.text.trim()) return;
    setCultureNotice(null);
    try {
      if (editingCultureId != null) {
        const { entry, error } = await coworkService.updateTeamCulture({
          id: editingCultureId,
          kind: cultureDraft.kind,
          topic: cultureDraft.topic,
          text: cultureDraft.text,
        });
        if (error || !entry) throw new Error(error || i18nService.t('memoryCultureSaveFailed'));
      } else {
        const { entry, displacedTopic, capacitySkipped, error } = await coworkService.upsertTeamCulture({
          kind: cultureDraft.kind,
          topic: cultureDraft.topic,
          text: cultureDraft.text,
        });
        if (error) throw new Error(error);
        if (!entry && capacitySkipped) {
          setCultureNotice(i18nService.t('memoryCultureCapacitySkip'));
          return;
        }
        if (!entry) throw new Error(i18nService.t('memoryCultureSaveFailed'));
        setCultureNotice(displacedTopic
          ? `${i18nService.t('memoryCultureSaved')} · ${i18nService.t('memoryCultureDisplaced')}: ${displacedTopic}`
          : i18nService.t('memoryCultureSaved'));
      }
      if (editingCultureId != null) setCultureNotice(i18nService.t('memoryCultureSaved'));
      resetCultureEditor();
      await loadCulture();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : i18nService.t('memoryCultureSaveFailed'));
    }
  };

  // ---- Memory entry modal (Facts CRUD) ----
  const resetEditor = () => {
    setEditingId(null);
    setDraftText('');
    setDraftUsageClass('profile_fact');
    setDraftVisibility('local_only');
    setShowModal(false);
  };

  useEffect(() => {
    resetEditor();
    setEditingKnowledgeId(null);
  }, [metabotId]);

  const draftExternalSafeAllowed = draftUsageClass === 'operational_preference';

  const handleSaveFact = async () => {
    if (metabotId == null) return;
    const text = draftText.trim();
    if (!text) return;
    setFactsLoading(true);
    try {
      const ownerKey = scopes?.owner?.key ?? 'owner:self';
      if (editingId) {
        await coworkService.updateMemoryEntry({
          metabotId,
          scopeKind: 'owner',
          scopeKey: ownerKey,
          usageClass: draftUsageClass,
          visibility: draftVisibility,
          id: editingId,
          text,
          status: 'created',
          isExplicit: true,
        });
      } else {
        await coworkService.createMemoryEntry({
          metabotId,
          scopeKind: 'owner',
          scopeKey: ownerKey,
          usageClass: draftUsageClass,
          visibility: draftVisibility,
          text,
          isExplicit: true,
        });
      }
      resetEditor();
      await loadFacts();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : i18nService.t('coworkMemoryCrudSaveFailed'));
    } finally {
      setFactsLoading(false);
    }
  };

  const handleEditFact = (entry: CoworkUserMemoryEntry) => {
    setEditingId(entry.id);
    setDraftText(entry.text);
    setDraftUsageClass(
      entry.usageClass === 'operational_preference'
      || entry.usageClass === 'work_review'
      || entry.usageClass === 'value_boundary'
      || entry.usageClass === 'preference'
        ? entry.usageClass
        : 'profile_fact',
    );
    setDraftVisibility(entry.visibility === 'external_safe' ? 'external_safe' : 'local_only');
    setShowModal(true);
  };

  const handleDeleteFact = async (entry: CoworkUserMemoryEntry) => {
    if (metabotId == null) return;
    setFactsLoading(true);
    try {
      await coworkService.deleteMemoryEntry({ id: entry.id, metabotId });
      if (editingId === entry.id) resetEditor();
      await loadFacts();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : i18nService.t('coworkMemoryCrudDeleteFailed'));
    } finally {
      setFactsLoading(false);
    }
  };

  // ---- Auto-dismiss notices ----
  useEffect(() => {
    if (policyNotice == null) return;
    const timer = setTimeout(() => setPolicyNotice(null), 3000);
    return () => clearTimeout(timer);
  }, [policyNotice]);

  useEffect(() => {
    if (dreamNotice == null) return;
    const timer = setTimeout(() => setDreamNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [dreamNotice]);

  // ============================================================
  // Render helpers
  // ============================================================
  const sectionTab = (key: MemorySection, label: string, count?: number) => {
    const active = activeSection === key;
    return (
      <button
        key={key}
        type="button"
        onClick={() => setActiveSection(key)}
        className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs transition-colors ${
          active
            ? 'border-claude-accent bg-claude-accent/5 text-claude-accent dark:bg-claude-accent/10 dark:text-claude-darkAccent'
            : 'dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover'
        }`}
      >
        <span>{label}</span>
        {typeof count === 'number' && (
          <span className={`rounded-full px-1.5 text-[10px] ${active ? 'bg-claude-accent/15' : 'dark:bg-claude-darkSurfaceHover bg-claude-surfaceHover'}`}>
            {count}
          </span>
        )}
      </button>
    );
  };

  const renderKnowledge = () => (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
          {i18nService.t('memoryKnowledgeHint')}
        </div>
        <div className="flex items-center gap-2">
          <select
            value={knowledgeKind}
            onChange={(event) => setKnowledgeKind(event.target.value as CoworkKnowledgeKind | 'all')}
            className="rounded-lg border px-2 py-1 text-xs dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface"
          >
            <option value="all">{i18nService.t('memoryKnowledgeKindAll')}</option>
            <option value="know_how">{i18nService.t('memoryKnowledgeKindKnowHow')}</option>
            <option value="pitfall">{i18nService.t('memoryKnowledgeKindPitfall')}</option>
            <option value="principle">{i18nService.t('memoryKnowledgeKindPrinciple')}</option>
          </select>
          <input
            type="text"
            value={knowledgeQuery}
            onChange={(event) => setKnowledgeQuery(event.target.value)}
            placeholder={i18nService.t('memoryKnowledgeSearchPlaceholder')}
            className="w-48 rounded-lg border px-2 py-1 text-xs dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface"
          />
        </div>
      </div>
      <div className="max-h-[520px] overflow-auto rounded-lg border dark:border-claude-darkBorder border-claude-border">
        {knowledgeLoading ? (
          <div className="px-3 py-3 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">{i18nService.t('loading')}</div>
        ) : knowledge.length === 0 ? (
          <div className="px-3 py-3 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">{i18nService.t('memoryKnowledgeEmpty')}</div>
        ) : (
          <div className="divide-y dark:divide-claude-darkBorder divide-claude-border">
            {knowledge.map((entry) => {
              const isEditing = editingKnowledgeId === entry.id;
              return (
                <div key={entry.id} className="px-3 py-2.5 text-xs hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors">
                  {isEditing ? (
                    <div className="space-y-2">
                      <div className="grid grid-cols-2 gap-2">
                        <label className="block">
                          <span className="block mb-1 text-[10px] dark:text-claude-darkTextSecondary text-claude-textSecondary">{i18nService.t('memoryKnowledgeTopicLabel')}</span>
                          <input
                            type="text"
                            value={knowledgeDraftTopic}
                            onChange={(event) => setKnowledgeDraftTopic(event.target.value)}
                            className="w-full rounded border px-2 py-1 text-xs dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface"
                          />
                        </label>
                        <label className="block">
                          <span className="block mb-1 text-[10px] dark:text-claude-darkTextSecondary text-claude-textSecondary">{i18nService.t('coworkMemoryCategoryAll')}</span>
                          <select
                            value={knowledgeDraftKind}
                            onChange={(event) => setKnowledgeDraftKind(event.target.value as CoworkKnowledgeKind)}
                            className="w-full rounded border px-2 py-1 text-xs dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface"
                          >
                            <option value="know_how">{i18nService.t('memoryKnowledgeKindKnowHow')}</option>
                            <option value="pitfall">{i18nService.t('memoryKnowledgeKindPitfall')}</option>
                            <option value="principle">{i18nService.t('memoryKnowledgeKindPrinciple')}</option>
                          </select>
                        </label>
                      </div>
                      <label className="block">
                        <span className="block mb-1 text-[10px] dark:text-claude-darkTextSecondary text-claude-textSecondary">{i18nService.t('memoryKnowledgeSummaryLabel')}</span>
                        <textarea
                          value={knowledgeDraftSummary}
                          onChange={(event) => setKnowledgeDraftSummary(event.target.value)}
                          className="min-h-[100px] w-full rounded border px-2 py-1 text-xs dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface"
                        />
                      </label>
                      <div className="flex justify-end gap-2">
                        <button
                          type="button"
                          onClick={cancelEditKnowledge}
                          className="rounded border px-2 py-1 text-[10px] dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
                        >
                          {i18nService.t('cancel')}
                        </button>
                        <button
                          type="button"
                          onClick={() => { void handleSaveKnowledgeEdit(); }}
                          disabled={!knowledgeDraftTopic.trim() || !knowledgeDraftSummary.trim()}
                          className="btn-idchat-primary-filled rounded px-2 py-1 text-[10px] disabled:opacity-60"
                        >
                          {i18nService.t('save')}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1 min-w-0 space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className={`rounded-full border px-2 py-0.5 ${KNOWLEDGE_KIND_ACCENT[entry.kind]}`}>
                            {getKnowledgeKindLabel(entry.kind)}
                          </span>
                          <span className="rounded-full border px-2 py-0.5 dark:border-claude-darkBorder border-claude-border dark:text-claude-darkTextSecondary text-claude-textSecondary">
                            {getKnowledgeOriginLabel(entry.origin)}
                          </span>
                          {entry.status === 'archived' && (
                            <span className="rounded-full border px-2 py-0.5 dark:border-claude-darkBorder border-claude-border opacity-60">
                              {i18nService.t('memoryKnowledgeArchived')}
                            </span>
                          )}
                          <span className="dark:text-claude-darkTextSecondary/70 text-claude-textSecondary/70">
                            {`${i18nService.t('memoryKnowledgeVersion')} v${entry.version}`}
                          </span>
                        </div>
                        <div className="font-medium dark:text-claude-darkText text-claude-text break-words">{entry.topic}</div>
                        <div className="dark:text-claude-darkTextSecondary text-claude-textSecondary break-words whitespace-pre-wrap">{entry.summary}</div>
                        <div className="text-[10px] dark:text-claude-darkTextSecondary/70 text-claude-textSecondary/70">
                          {formatTimestamp(entry.updatedAt)}
                        </div>
                      </div>
                      <div className="flex items-center gap-1 flex-shrink-0">
                        <button
                          type="button"
                          onClick={() => startEditKnowledge(entry)}
                          className="rounded border px-2 py-1 text-[10px] dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
                        >
                          {i18nService.t('edit')}
                        </button>
                        <button
                          type="button"
                          onClick={() => { void handleDeleteKnowledge(entry); }}
                          className="rounded border px-2 py-1 text-[10px] text-red-500 dark:border-claude-darkBorder border-claude-border hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
                        >
                          {i18nService.t('delete')}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );

  const renderContacts = () => (
    <div className="space-y-3">
      <div className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
        {i18nService.t('memoryContactsHint')}
      </div>
      {!selectedContactId ? (
        <>
          {contactsLoading ? (
            <div className="rounded-lg border px-3 py-3 text-xs dark:border-claude-darkBorder border-claude-border dark:text-claude-darkTextSecondary text-claude-textSecondary">{i18nService.t('loading')}</div>
          ) : contacts.length === 0 ? (
            <div className="rounded-lg border px-3 py-3 text-xs dark:border-claude-darkBorder border-claude-border dark:text-claude-darkTextSecondary text-claude-textSecondary">{i18nService.t('memoryContactsEmpty')}</div>
          ) : (
            <div className="max-h-[520px] overflow-auto rounded-lg border dark:border-claude-darkBorder divide-y dark:divide-claude-darkBorder divide-claude-border">
              {contacts.map((contact) => {
                const name = contact.name?.trim() || i18nService.t('coworkMemoryPeerUnknown');
                return (
                  <button
                    key={contact.globalMetaID}
                    type="button"
                    onClick={() => setSelectedContactId(contact.globalMetaID)}
                    className="w-full flex items-center justify-between gap-3 px-3 py-2.5 text-xs text-left hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="font-medium dark:text-claude-darkText text-claude-text break-words">{name}</div>
                      <ContactGlobalMetaIdHint globalMetaId={contact.globalMetaID} className="mt-0.5" />
                      <div className="mt-0.5 dark:text-claude-darkTextSecondary text-claude-textSecondary">
                        {`${i18nService.t('metaidContactLastSeen')}: ${formatTimestamp(contact.lastSeenAt)}`}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0 dark:text-claude-darkTextSecondary text-claude-textSecondary">
                      <span>{`${contact.interactionCount} ${i18nService.t('metaidContactInteractionCount')}`}</span>
                      <ChevronRightIcon className="h-3.5 w-3.5" />
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </>
      ) : (
        <div className="space-y-3">
          <button
            type="button"
            onClick={() => { setSelectedContactId(null); setContactDetail(null); }}
            className="text-xs text-claude-accent dark:text-claude-darkAccent hover:underline"
          >
            ← {i18nService.t('memoryContactsTitle')}
          </button>
          {contactDetailLoading ? (
            <div className="rounded-lg border px-3 py-3 text-xs dark:border-claude-darkBorder border-claude-border dark:text-claude-darkTextSecondary text-claude-textSecondary">{i18nService.t('loading')}</div>
          ) : contactDetail ? (
            <MetaIDContactPanel
              detail={contactDetail}
              facts={facts}
              factsLoading={factsLoading}
              onEditFact={handleEditFact}
              onDeleteFact={(entry) => { void handleDeleteFact(entry); }}
            />
          ) : (
            <div className="rounded-lg border px-3 py-3 text-xs dark:border-claude-darkBorder border-claude-border dark:text-claude-darkTextSecondary text-claude-textSecondary">{i18nService.t('coworkMemoryEmpty')}</div>
          )}
        </div>
      )}
    </div>
  );

  const renderFacts = () => (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
          {i18nService.t('memoryFactsHint')}
        </div>
        <div className="flex items-center gap-2">
          <label className="flex cursor-pointer items-center gap-1 text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
            <input
              type="checkbox"
              checked={factsShowArchived}
              onChange={(event) => setFactsShowArchived(event.target.checked)}
            />
            {i18nService.t('memoryFactsShowArchived')}
          </label>
          <input
            type="text"
            value={factsQuery}
            onChange={(event) => setFactsQuery(event.target.value)}
            placeholder={i18nService.t('coworkMemorySearchPlaceholder')}
            className="w-48 rounded-lg border px-2 py-1 text-xs dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface"
          />
          <button
            type="button"
            onClick={() => { resetEditor(); setShowModal(true); }}
            disabled={metabotId == null}
            className="btn-idchat-primary-filled inline-flex items-center justify-center px-3 py-1 text-xs disabled:opacity-60"
          >
            <PlusCircleIcon className="h-3.5 w-3.5 mr-1" />
            {i18nService.t('coworkMemoryCrudCreate')}
          </button>
        </div>
      </div>
      {factsStats && (
        <div className="text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
          {`${i18nService.t('coworkMemoryTotalLabel')}: ${factsStats.created + factsStats.stale} · ${i18nService.t('coworkMemoryActiveLabel')}: ${factsStats.created}`}
        </div>
      )}
      <div className="max-h-[520px] overflow-auto rounded-lg border dark:border-claude-darkBorder border-claude-border">
        {factsLoading ? (
          <div className="px-3 py-3 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">{i18nService.t('loading')}</div>
        ) : facts.length === 0 ? (
          <div className="px-3 py-3 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">{i18nService.t('coworkMemoryEmpty')}</div>
        ) : (
          <div className="divide-y dark:divide-claude-darkBorder divide-claude-border">
            {facts.map((entry) => (
              <div key={entry.id} className="px-3 py-2.5 text-xs hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0 space-y-1">
                    <div className="font-medium dark:text-claude-darkText text-claude-text break-words">{entry.text}</div>
                    <div className="flex flex-wrap items-center gap-2 dark:text-claude-darkTextSecondary text-claude-textSecondary">
                      {entry.usageClass !== 'self_identity' && (
                        <span className="rounded-full border px-2 py-0.5 dark:border-claude-darkBorder border-claude-border">
                          {entry.status === 'created' ? i18nService.t('coworkMemoryStatusActive') : i18nService.t('coworkMemoryStatusInactive')}
                        </span>
                      )}
                      {entry.archivedAt != null && (
                        <span className="rounded-full border px-2 py-0.5 text-amber-600 dark:text-amber-400 dark:border-claude-darkBorder border-claude-border">
                          {i18nService.t('memoryFactsArchivedBadge')}
                        </span>
                      )}
                      {getUsageClassLabel(entry.usageClass) && (
                        <span className="rounded-full border px-2 py-0.5 dark:border-claude-darkBorder border-claude-border text-claude-accent dark:text-claude-darkAccent">
                          {getUsageClassLabel(entry.usageClass)}
                        </span>
                      )}
                      <span>{formatTimestamp(entry.updatedAt)}</span>
                    </div>
                  </div>
                  {entry.usageClass !== 'self_identity' && (
                    <div className="flex items-center gap-1 flex-shrink-0">
                      {entry.archivedAt != null && (
                        <button
                          type="button"
                          onClick={async () => {
                            const ok = await coworkService.unarchiveMemoryEntry(entry.id);
                            if (ok) {
                              await loadFacts();
                            }
                          }}
                          className="rounded border px-2 py-1 text-[10px] text-claude-accent dark:text-claude-darkAccent dark:border-claude-darkBorder border-claude-border hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
                        >
                          {i18nService.t('memoryFactsRestore')}
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => handleEditFact(entry)}
                        className="rounded border px-2 py-1 text-[10px] dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
                      >
                        {i18nService.t('edit')}
                      </button>
                      <button
                        type="button"
                        onClick={() => { void handleDeleteFact(entry); }}
                        className="rounded border px-2 py-1 text-[10px] text-red-500 dark:border-claude-darkBorder border-claude-border hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
                      >
                        {i18nService.t('delete')}
                      </button>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );

  const renderDream = () => (
    <div className="space-y-3">
      <ToggleRow
        label={i18nService.t('memoryDreamBotToggle')}
        hint={i18nService.t('memoryDreamBotToggleHint')}
        checked={policy?.dreamEnabled ?? true}
        onChange={(value) => { void handleToggleBotDream(value); }}
        disabled={metabotId == null || dreamRunning}
      />
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
          {i18nService.t('memoryDreamHint')}
        </div>
        <div className="flex items-center gap-2">
          <input
            type="date"
            value={dreamRunDate}
            max={formatLocalDateInput(new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate() - 1))}
            onChange={(event) => setDreamRunDate(event.target.value)}
            className="rounded-lg border px-2 py-1 text-xs dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface"
            disabled={dreamRunning || metabotId == null}
          />
          <button
            type="button"
            onClick={() => { void handleForceDream(); }}
            title={i18nService.t('dreamDiaryForceHint')}
            disabled={dreamRunning || metabotId == null || !dreamRunDate}
            className="inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-xs dark:border-claude-darkBorder border-claude-border dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover disabled:cursor-not-allowed disabled:opacity-50"
          >
            <ArrowPathIcon className={`h-3.5 w-3.5 ${dreamRunning ? 'animate-spin' : ''}`} />
            <span>{dreamRunning ? i18nService.t('dreamDiaryForceRunning') : i18nService.t('dreamDiaryForceDream')}</span>
          </button>
        </div>
      </div>
      {dreamNotice && (
        <div className="text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary break-words">{dreamNotice}</div>
      )}
      <DreamTelemetryPanel runs={dreamRuns} />
      <CapabilityDraftsPanel drafts={capabilityDrafts} loading={dreamLoading} />
      <div className="max-h-[520px] overflow-auto rounded-lg border dark:border-claude-darkBorder border-claude-border">
        {dreamLoading ? (
          <div className="px-3 py-3 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">{i18nService.t('loading')}</div>
        ) : dreamEntries.length === 0 ? (
          <div className="px-3 py-3 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">{i18nService.t('dreamDiaryEmpty')}</div>
        ) : (
          <div className="divide-y dark:divide-claude-darkBorder divide-claude-border">
            {dreamEntries.map((entry) => {
              if (entry.kind === 'failed') {
                const { run } = entry;
                const isTerminal = run.status === 'terminal-failed';
                const retryPending = run.nextRetryAt == null || run.nextRetryAt <= Date.now();
                return (
                  <div key={`failed-${run.id}`} className="px-3 py-3 text-xs">
                    <div className="flex items-start gap-2">
                      <ExclamationTriangleIcon className="h-4 w-4 mt-0.5 flex-shrink-0 text-amber-500" />
                      <span className="flex-1 min-w-0">
                        <span className="font-medium dark:text-claude-darkText text-claude-text">{run.dreamDate}</span>
                        <span className="ml-2 rounded-full border px-2 py-0.5 text-amber-600 border-amber-300 dark:text-amber-400 dark:border-amber-500/40">
                          {isTerminal
                            ? i18nService.t('dreamDiaryTerminalBadge')
                            : i18nService.t('dreamDiaryFailedBadge')}
                        </span>
                        <span className="block mt-1 dark:text-claude-darkTextSecondary text-claude-textSecondary break-words">
                          {`${i18nService.t('dreamDiaryFailedAttempts')}: ${run.attemptCount}`}
                        </span>
                        {run.error && (
                          <span className="block mt-1 dark:text-claude-darkTextSecondary text-claude-textSecondary break-words">{run.error}</span>
                        )}
                        <span className="block mt-1 dark:text-claude-darkTextSecondary text-claude-textSecondary">
                          {isTerminal
                            ? i18nService.t('dreamDiaryTerminalNoRetry')
                            : retryPending
                              ? i18nService.t('dreamDiaryRetryPending')
                              : `${i18nService.t('dreamDiaryNextRetry')}: ${new Date(run.nextRetryAt ?? 0).toLocaleString()}`}
                        </span>
                      </span>
                      <button
                        type="button"
                        onClick={() => { setDreamRunDate(run.dreamDate); void handleForceDream(run.dreamDate); }}
                        title={i18nService.t('dreamDiaryForceHint')}
                        disabled={dreamRunning}
                        className="inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-xs dark:border-claude-darkBorder border-claude-border dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <ArrowPathIcon className={`h-3.5 w-3.5 ${dreamRunning ? 'animate-spin' : ''}`} />
                        <span>{i18nService.t('dreamDiaryRetryNow')}</span>
                      </button>
                    </div>
                  </div>
                );
              }
              const summary = entry.summary;
              const expanded = dreamExpandedId === summary.id;
              const sectionEntries = Object.entries(summary.sections ?? {}).filter(([, text]) => typeof text === 'string' && text.trim());
              return (
                <div key={summary.id} className="px-3 py-3 text-xs">
                  <button
                    type="button"
                    onClick={() => setDreamExpandedId(expanded ? null : summary.id)}
                    className="w-full flex items-start gap-2 text-left"
                  >
                    <ChevronRightIcon className={`h-4 w-4 mt-0.5 flex-shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`} />
                    <span className="flex-1 min-w-0">
                      <span className="font-medium dark:text-claude-darkText text-claude-text">{summary.summaryDate}</span>
                      <span className="block mt-1 dark:text-claude-darkTextSecondary text-claude-textSecondary break-words">{summary.summaryText}</span>
                    </span>
                  </button>
                  {expanded && (
                    <div className="mt-2 ml-6 space-y-2 border-l-2 pl-3 dark:border-claude-darkBorder border-claude-border">
                      {sectionEntries.map(([key, text]) => (
                        <div key={key}>
                          <span className="rounded-full border px-2 py-0.5 dark:border-claude-darkBorder border-claude-border">{i18nService.t(`dreamDiarySection_${key}`)}</span>
                          <span className="ml-2 dark:text-claude-darkTextSecondary text-claude-textSecondary break-words">{text}</span>
                        </div>
                      ))}
                      <div className="dark:text-claude-darkTextSecondary text-claude-textSecondary">
                        {`${i18nService.t('dreamDiaryStatsSessions')}: ${summary.stats?.sessionCount ?? 0} · ${i18nService.t('dreamDiaryStatsOrders')}: ${summary.stats?.orderCount ?? summary.stats?.orderSessionCount ?? 0} · ${i18nService.t('dreamDiaryStatsTasks')}: ${summary.stats?.taskRunCount ?? 0} · ${i18nService.t('dreamDiaryStatsMessages')}: ${summary.stats?.messageCount ?? 0}`}
                      </div>
                      {(summary.sessionRefs ?? []).length > 0 && (
                        <div className="space-y-1">
                          <div className="dark:text-claude-darkTextSecondary text-claude-textSecondary">{i18nService.t('dreamDiaryRelatedSessions')}</div>
                          {(summary.sessionRefs ?? []).map((ref) => (
                            <button
                              key={ref.sessionId}
                              type="button"
                              onClick={() => handleOpenSession(ref.sessionId)}
                              className="block text-claude-accent dark:text-claude-darkAccent hover:underline break-all text-left"
                              title={i18nService.t('dreamDiaryOpenSessionHint')}
                            >
                              {`IDBots://${ref.sessionId}${ref.title ? ` ${ref.title}` : ''}`}
                            </button>
                          ))}
                        </div>
                      )}
                      {summary.llmId && (
                        <div className="dark:text-claude-darkTextSecondary text-claude-textSecondary">{`LLM: ${summary.llmId}`}</div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );

  const renderPolicy = () => {
    const sourceLabel = useOverride
      ? i18nService.t('memoryPolicyScopeMetabot')
      : i18nService.t('memoryPolicyScopeGlobal');
    return (
      <div className="rounded-xl border dark:border-claude-darkBorder border-claude-border">
        <button
          type="button"
          onClick={() => setPolicyOpen((open) => !open)}
          className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left"
        >
          <div className="flex items-center gap-2">
            <Cog6ToothIcon className="h-4 w-4 text-claude-accent dark:text-claude-darkAccent" />
            <span className="text-sm font-medium dark:text-claude-darkText text-claude-text">{i18nService.t('memoryPolicyTitle')}</span>
            <span className="rounded-full border px-2 py-0.5 text-[10px] dark:border-claude-darkBorder border-claude-border dark:text-claude-darkTextSecondary text-claude-textSecondary">
              {sourceLabel}
            </span>
          </div>
          <ChevronRightIcon className={`h-4 w-4 transition-transform dark:text-claude-darkTextSecondary text-claude-textSecondary ${policyOpen ? 'rotate-90' : ''}`} />
        </button>
        {policyOpen && (
          <div className="space-y-4 border-t dark:border-claude-darkBorder border-claude-border px-4 py-4">
            <div className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
              {i18nService.t('memoryPolicyHint')}
            </div>
            {policyNotice && <div className="text-xs text-green-600 dark:text-green-400">{policyNotice}</div>}
            {error && <div className="text-xs text-red-500">{error}</div>}
            {policyLoading ? (
              <div className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">{i18nService.t('loading')}</div>
            ) : (
              <>
                {/* Override scope toggle */}
                <label className={`flex items-start gap-2 rounded-lg border px-3 py-2 cursor-pointer ${metabotId == null ? 'opacity-60 cursor-not-allowed' : ''} dark:border-claude-darkBorder border-claude-border`}>
                  <input
                    type="checkbox"
                    checked={useOverride}
                    onChange={(event) => { void handleToggleOverride(event.target.checked); }}
                    disabled={metabotId == null || policySaving}
                    className="mt-0.5"
                  />
                  <span>
                    <span className="block text-xs font-medium dark:text-claude-darkText text-claude-text">{i18nService.t('memoryPolicyUseOverride')}</span>
                    <span className="block text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
                      {useOverride ? i18nService.t('memoryPolicyScopeMetabot') : i18nService.t('memoryPolicyScopeGlobal')}
                    </span>
                  </span>
                </label>

                {/* Master switch */}
                <ToggleRow
                  label={i18nService.t('memoryPolicyMasterSwitch')}
                  hint={i18nService.t('memoryPolicyMasterSwitchHint')}
                  checked={draft.memoryEnabled}
                  onChange={(value) => setDraft((prev) => ({ ...prev, memoryEnabled: value }))}
                  disabled={metabotId == null || policySaving}
                />
                <ToggleRow
                  label={i18nService.t('memoryPolicyImplicit')}
                  hint={i18nService.t('memoryPolicyImplicitHint')}
                  checked={draft.memoryImplicitUpdateEnabled}
                  onChange={(value) => setDraft((prev) => ({ ...prev, memoryImplicitUpdateEnabled: value }))}
                  disabled={metabotId == null || policySaving || !draft.memoryEnabled}
                />

                {/* Guard level */}
                <div>
                  <span className="block text-xs font-medium dark:text-claude-darkText text-claude-text">{i18nService.t('memoryPolicyGuardLevel')}</span>
                  <div className="mt-1.5 grid grid-cols-3 gap-2">
                    {(['strict', 'standard', 'relaxed'] as GuardLevel[]).map((level) => {
                      const active = draft.memoryGuardLevel === level;
                      const hintKey = level === 'strict' ? 'memoryPolicyGuardStrictHint' : level === 'relaxed' ? 'memoryPolicyGuardRelaxedHint' : 'memoryPolicyGuardStandardHint';
                      const labelKey = level === 'strict' ? 'memoryPolicyGuardStrict' : level === 'relaxed' ? 'memoryPolicyGuardRelaxed' : 'memoryPolicyGuardStandard';
                      return (
                        <button
                          key={level}
                          type="button"
                          title={i18nService.t(hintKey)}
                          onClick={() => setDraft((prev) => ({ ...prev, memoryGuardLevel: level }))}
                          disabled={metabotId == null || policySaving || !draft.memoryEnabled}
                          className={`rounded-lg border px-2 py-1.5 text-xs transition-colors ${
                            active
                              ? 'border-claude-accent bg-claude-accent/5 text-claude-accent dark:bg-claude-accent/10 dark:text-claude-darkAccent'
                              : 'dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover'
                          } disabled:opacity-50 disabled:cursor-not-allowed`}
                        >
                          {i18nService.t(labelKey)}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Advanced */}
                <div className="space-y-3 rounded-lg border px-3 py-3 dark:border-claude-darkBorder border-claude-border">
                  <div className="text-[10px] uppercase tracking-wide dark:text-claude-darkTextSecondary text-claude-textSecondary">
                    {i18nService.t('memoryPolicyAdvanced')}
                  </div>
                  <ToggleRow
                    label={i18nService.t('memoryPolicyLlmJudge')}
                    hint={i18nService.t('memoryPolicyLlmJudgeHint')}
                    checked={draft.memoryLlmJudgeEnabled}
                    onChange={(value) => setDraft((prev) => ({ ...prev, memoryLlmJudgeEnabled: value }))}
                    disabled={metabotId == null || policySaving || !draft.memoryEnabled}
                  />
                  <div>
                    <label className="flex items-center justify-between gap-3">
                      <span className="text-xs dark:text-claude-darkText text-claude-text">
                        <span className="block">{i18nService.t('memoryPolicyMaxItems')}</span>
                        <span className="block text-[11px] font-normal dark:text-claude-darkTextSecondary text-claude-textSecondary">{i18nService.t('memoryPolicyMaxItemsHint')}</span>
                      </span>
                      <input
                        type="number"
                        min={1}
                        max={60}
                        value={draft.memoryUserMemoriesMaxItems}
                        onChange={(event) => {
                          const next = Number(event.target.value);
                          setDraft((prev) => ({ ...prev, memoryUserMemoriesMaxItems: Number.isFinite(next) ? next : 20 }));
                        }}
                        className="w-20 rounded border px-2 py-1 text-xs dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface"
                        disabled={metabotId == null || policySaving || !draft.memoryEnabled}
                      />
                    </label>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => { void handleSavePolicy(); }}
                  disabled={metabotId == null || policySaving || !hasPolicyChanges}
                  className="btn-idchat-primary-filled inline-flex items-center justify-center px-4 py-1.5 text-xs disabled:opacity-60"
                >
                  {policySaving ? i18nService.t('saving') : i18nService.t('memoryPolicySave')}
                </button>
              </>
            )}
          </div>
        )}
      </div>
    );
  };

  const hygieneThresholdFields: Array<{ field: keyof MemoryHygieneConfig; min: number; max: number; labelKey: string; hintKey: string }> = [
    { field: 'observationRetentionDays', min: 14, max: 3650, labelKey: 'memoryHygieneObsRetention', hintKey: 'memoryHygieneObsRetentionHint' },
    { field: 'observationAnchorsPerPair', min: 0, max: 50, labelKey: 'memoryHygieneObsAnchors', hintKey: 'memoryHygieneObsAnchorsHint' },
    { field: 'episodeArchiveDays', min: 14, max: 3650, labelKey: 'memoryHygieneEpisodeDays', hintKey: 'memoryHygieneEpisodeDaysHint' },
    { field: 'memoryDecayDays', min: 14, max: 3650, labelKey: 'memoryHygieneDecayDays', hintKey: 'memoryHygieneDecayDaysHint' },
    { field: 'tombstonePurgeDays', min: 30, max: 3650, labelKey: 'memoryHygieneTombstoneDays', hintKey: 'memoryHygieneTombstoneDaysHint' },
    { field: 'knowledgeRevisionKeep', min: 1, max: 50, labelKey: 'memoryHygieneRevKeep', hintKey: 'memoryHygieneRevKeepHint' },
    { field: 'dreamRunRetentionDays', min: 30, max: 3650, labelKey: 'memoryHygieneRunDays', hintKey: 'memoryHygieneRunDaysHint' },
    { field: 'deepConsolidationIntervalDays', min: 7, max: 365, labelKey: 'memoryHygieneDeepDays', hintKey: 'memoryHygieneDeepDaysHint' },
  ];

  const hygieneCountLabels: Record<string, string> = {
    observationsSuperseded: i18nService.t('memoryHygieneStatObs'),
    observationPairsCompacted: i18nService.t('memoryHygieneStatObsPairs'),
    episodesArchived: i18nService.t('memoryHygieneStatEpisodes'),
    memoriesArchived: i18nService.t('memoryHygieneStatMemories'),
    tombstonesPurged: i18nService.t('memoryHygieneStatTombstones'),
    knowledgeRevisionsPruned: i18nService.t('memoryHygieneStatRevisions'),
    dreamRunsPurged: i18nService.t('memoryHygieneStatRuns'),
    dreamFragmentsPurged: i18nService.t('memoryHygieneStatFragments'),
    cultureEntriesDecayed: i18nService.t('memoryHygieneStatCultureDecayed'),
    cultureRevisionsPruned: i18nService.t('memoryHygieneStatCultureRevisions'),
    skippedDisabled: i18nService.t('memoryHygieneStatSkipped'),
    deepConsolidationBots: i18nService.t('memoryHygieneStatDeepBots'),
    deepRetiredMemories: i18nService.t('memoryHygieneStatDeepMemories'),
    deepRetiredKnowledge: i18nService.t('memoryHygieneStatDeepKnowledge'),
    deepRewrittenKnowledge: i18nService.t('memoryHygieneStatDeepRewrites'),
  };

  const renderHygiene = () => {
    const lastRunText = hygieneLastRun
      ? `${i18nService.t('memoryHygieneLastRun')}: ${new Date(hygieneLastRun.ranAt).toLocaleString()} (${hygieneLastRun.trigger === 'manual' ? i18nService.t('memoryHygieneTriggerManual') : i18nService.t('memoryHygieneTriggerScheduled')})`
      : i18nService.t('memoryHygieneNeverRun');
    return (
      <div className="rounded-xl border dark:border-claude-darkBorder border-claude-border">
        <button
          type="button"
          onClick={() => setHygieneOpen((open) => !open)}
          className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left"
        >
          <div className="flex items-center gap-2">
            <BrainIcon className="h-4 w-4 text-claude-accent dark:text-claude-darkAccent" />
            <span className="text-sm font-medium dark:text-claude-darkText text-claude-text">{i18nService.t('memoryHygieneTitle')}</span>
            <span className="rounded-full border px-2 py-0.5 text-[10px] dark:border-claude-darkBorder border-claude-border dark:text-claude-darkTextSecondary text-claude-textSecondary">
              {hygiene?.enabled ? i18nService.t('memoryHygieneEnabledBadge') : i18nService.t('memoryHygieneDisabledBadge')}
            </span>
          </div>
          <ChevronRightIcon className={`h-4 w-4 transition-transform dark:text-claude-darkTextSecondary text-claude-textSecondary ${hygieneOpen ? 'rotate-90' : ''}`} />
        </button>
        {hygieneOpen && (
          <div className="space-y-4 border-t dark:border-claude-darkBorder border-claude-border px-4 py-4">
            <div className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
              {i18nService.t('memoryHygieneHint')}
            </div>
            <div className="text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">{lastRunText}</div>
            {hygieneNotice && <div className="text-xs text-green-600 dark:text-green-400">{hygieneNotice}</div>}

            {hygiene && (
              <>
                {/* Per-bot participation toggle */}
                <ToggleRow
                  label={i18nService.t('memoryHygieneBotToggle')}
                  hint={i18nService.t('memoryHygieneBotToggleHint')}
                  checked={policy?.hygieneEnabled ?? true}
                  onChange={(value) => { void handleToggleBotHygiene(value); }}
                  disabled={metabotId == null || hygieneSaving}
                />

                {/* Global master switch */}
                <ToggleRow
                  label={i18nService.t('memoryHygieneEnabled')}
                  hint={i18nService.t('memoryHygieneEnabledHint')}
                  checked={hygiene.enabled}
                  onChange={(value) => updateHygieneField('enabled', value)}
                  disabled={hygieneSaving}
                />

                {/* Deep consolidation (LLM belief-layer review) */}
                <ToggleRow
                  label={i18nService.t('memoryHygieneDeep')}
                  hint={i18nService.t('memoryHygieneDeepHint')}
                  checked={hygiene.deepConsolidationEnabled}
                  onChange={(value) => updateHygieneField('deepConsolidationEnabled', value)}
                  disabled={hygieneSaving || !hygiene.enabled}
                />

                {/* Thresholds — collapsed by default; eight numeric knobs
                    expanded at once reads as a wall of inputs */}
                <div className="rounded-lg border dark:border-claude-darkBorder border-claude-border">
                  <button
                    type="button"
                    onClick={() => setHygieneThresholdsOpen((open) => !open)}
                    className="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left"
                  >
                    <span className="text-[10px] uppercase tracking-wide dark:text-claude-darkTextSecondary text-claude-textSecondary">
                      {i18nService.t('memoryHygieneThresholds')}
                    </span>
                    <ChevronRightIcon className={`h-3.5 w-3.5 transition-transform dark:text-claude-darkTextSecondary text-claude-textSecondary ${hygieneThresholdsOpen ? 'rotate-90' : ''}`} />
                  </button>
                  {hygieneThresholdsOpen && (
                    <div className="space-y-3 border-t px-3 py-3 dark:border-claude-darkBorder border-claude-border">
                      {hygieneThresholdFields.map(({ field, min, max, labelKey, hintKey }) => (
                        <label key={field} className="flex items-center justify-between gap-3">
                          <span className="text-xs dark:text-claude-darkText text-claude-text">
                            <span className="block">{i18nService.t(labelKey)}</span>
                            <span className="block text-[11px] font-normal dark:text-claude-darkTextSecondary text-claude-textSecondary">{i18nService.t(hintKey)}</span>
                          </span>
                          <input
                            type="number"
                            min={min}
                            max={max}
                            value={Number(hygiene[field])}
                            onChange={(event) => {
                              const next = Number(event.target.value);
                              updateHygieneField(field, Number.isFinite(next) ? Math.max(min, Math.min(max, Math.floor(next))) : min);
                            }}
                            className="w-20 rounded border px-2 py-1 text-xs dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface"
                            disabled={hygieneSaving}
                          />
                        </label>
                      ))}
                    </div>
                  )}
                </div>

                {/* Last-run stats */}
                {hygieneLastRun && (
                  <div className="rounded-lg border px-3 py-3 text-[11px] dark:border-claude-darkBorder border-claude-border">
                    <div className="mb-1 uppercase tracking-wide dark:text-claude-darkTextSecondary text-claude-textSecondary">
                      {i18nService.t('memoryHygieneStatsTitle')}
                    </div>
                    {Object.keys(hygieneCountLabels).length > 0 && (
                      <div className="flex flex-wrap gap-x-4 gap-y-1 dark:text-claude-darkText text-claude-text">
                        {Object.entries(hygieneLastRun.counts)
                          .filter(([key]) => hygieneCountLabels[key])
                          .map(([key, value]) => (
                            <span key={key}>{`${hygieneCountLabels[key]}: ${value}`}</span>
                          ))}
                      </div>
                    )}
                    {hygieneLastRun.errors.length > 0 && (
                      <div className="mt-1 text-red-500">
                        {i18nService.t('memoryHygieneErrors')}: {hygieneLastRun.errors.join('; ')}
                      </div>
                    )}
                  </div>
                )}

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => { void handleSaveHygiene(); }}
                    disabled={hygieneSaving}
                    className="btn-idchat-primary-filled inline-flex items-center justify-center px-4 py-1.5 text-xs disabled:opacity-60"
                  >
                    {hygieneSaving ? i18nService.t('saving') : i18nService.t('memoryHygieneSave')}
                  </button>
                  <button
                    type="button"
                    onClick={() => { void handleRunHygieneNow(); }}
                    disabled={hygieneRunning}
                    className="inline-flex items-center justify-center gap-1 rounded-lg border px-4 py-1.5 text-xs disabled:opacity-60 dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text"
                  >
                    <ArrowPathIcon className={`h-3.5 w-3.5 ${hygieneRunning ? 'animate-spin' : ''}`} />
                    {hygieneRunning ? i18nService.t('memoryHygieneRunning') : i18nService.t('memoryHygieneRunNow')}
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    );
  };

  const cultureKindLabels: Record<TeamCultureKind, string> = {
    glossary: i18nService.t('memoryCultureKindGlossary'),
    convention: i18nService.t('memoryCultureKindConvention'),
    team_lesson: i18nService.t('memoryCultureKindTeamLesson'),
  };

  const cultureDistillOutcomeLabels: Record<string, string> = {
    applied: i18nService.t('memoryCultureDistillOutcomeApplied'),
    empty: i18nService.t('memoryCultureDistillOutcomeEmpty'),
    unparseable: i18nService.t('memoryCultureDistillOutcomeUnparseable'),
    'llm-error': i18nService.t('memoryCultureDistillOutcomeLlmError'),
    'apply-error': i18nService.t('memoryCultureDistillOutcomeApplyError'),
    'few-members': i18nService.t('memoryCultureDistillOutcomeFewMembers'),
    'no-summary': i18nService.t('memoryCultureDistillOutcomeNoSummary'),
    disabled: i18nService.t('memoryCultureDistillOutcomeDisabled'),
  };

  const renderCulture = () => (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
          {i18nService.t('memoryCultureHint')}
        </div>
        {cultureCounts && (
          <div className="shrink-0 text-[10px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
            {`${cultureCounts.glossary + cultureCounts.convention + cultureCounts.team_lesson} ${i18nService.t('memoryCultureActiveEntries')}`}
          </div>
        )}
      </div>
      {cultureNotice && <div className="text-xs text-green-600 dark:text-green-400">{cultureNotice}</div>}

      {/* Master switch: one gate for both group-task injection and
          task-close distillation LLM calls. */}
      <ToggleRow
        label={i18nService.t('memoryCultureEnabled')}
        hint={i18nService.t('memoryCultureEnabledHint')}
        checked={cultureEnabled}
        onChange={(value) => {
          setCultureEnabled(value);
          void coworkService.setTeamCultureConfig(value);
        }}
      />

      {/* Recent task-close distillation verdicts: why the latest closes did
          or did not land culture entries (previously every skip/failure was
          an invisible console.warn, reading as "the feature is dead"). */}
      <div className="space-y-1 rounded-lg border px-3 py-2 dark:border-claude-darkBorder border-claude-border">
        <div className="text-[10px] uppercase tracking-wide dark:text-claude-darkTextSecondary text-claude-textSecondary">
          {i18nService.t('memoryCultureDistillTitle')}
        </div>
        {cultureDistillationLog.length === 0 ? (
          <div className="text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
            {i18nService.t('memoryCultureDistillEmpty')}
          </div>
        ) : (
          <div className="space-y-1">
            {cultureDistillationLog.slice(0, 5).map((record, index) => (
              <div
                key={`${record.at}-${record.taskId ?? 'na'}-${index}`}
                className="text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary"
              >
                {`${new Date(record.at).toLocaleString()} · #${record.taskId ?? '-'} ${record.taskTitle} · ${cultureDistillOutcomeLabels[record.outcome] ?? record.outcome}`}
                {record.outcome === 'applied' && record.applied > 0
                  ? ` · +${record.applied} ${i18nService.t('memoryCultureDistillEntriesApplied')}`
                  : ''}
                {record.pendingConventions > 0
                  ? ` · ${record.pendingConventions} ${i18nService.t('memoryCultureDistillPendingCount')}`
                  : ''}
                {record.error ? ` · ${record.error}` : ''}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {(['all', 'glossary', 'convention', 'team_lesson'] as const).map((kind) => {
          const active = cultureKindFilter === kind;
          const label = kind === 'all' ? i18nService.t('memoryCultureKindAll') : cultureKindLabels[kind];
          return (
            <button
              key={kind}
              type="button"
              onClick={() => setCultureKindFilter(kind)}
              className={`rounded-lg border px-2.5 py-1 text-xs transition-colors ${
                active
                  ? 'border-claude-accent bg-claude-accent/5 text-claude-accent dark:bg-claude-accent/10 dark:text-claude-darkAccent'
                  : 'dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover'
              }`}
            >
              {label}
            </button>
          );
        })}
        <input
          type="text"
          value={cultureQuery}
          onChange={(event) => setCultureQuery(event.target.value)}
          placeholder={i18nService.t('memoryCultureSearchPlaceholder')}
          className="min-w-[160px] flex-1 rounded-lg border px-2 py-1.5 text-xs dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface"
        />
      </div>

      {/* Editor form (add or edit) */}
      <div className="space-y-2 rounded-lg border px-3 py-3 dark:border-claude-darkBorder border-claude-border">
        <div className="text-[10px] uppercase tracking-wide dark:text-claude-darkTextSecondary text-claude-textSecondary">
          {editingCultureId != null ? i18nService.t('memoryCultureEdit') : i18nService.t('memoryCultureAdd')}
        </div>
        <div className="flex items-center gap-2">
          <select
            value={cultureDraft.kind}
            onChange={(event) => setCultureDraft((prev) => ({ ...prev, kind: event.target.value as TeamCultureKind }))}
            className="rounded-lg border px-2 py-1.5 text-xs dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface"
          >
            {(Object.keys(cultureKindLabels) as TeamCultureKind[]).map((kind) => (
              <option key={kind} value={kind}>{cultureKindLabels[kind]}</option>
            ))}
          </select>
          <input
            type="text"
            value={cultureDraft.topic}
            onChange={(event) => setCultureDraft((prev) => ({ ...prev, topic: event.target.value }))}
            placeholder={i18nService.t('memoryCultureTopicLabel')}
            className="flex-1 rounded-lg border px-2 py-1.5 text-xs dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface"
          />
        </div>
        <textarea
          value={cultureDraft.text}
          onChange={(event) => setCultureDraft((prev) => ({ ...prev, text: event.target.value }))}
          placeholder={i18nService.t('memoryCultureTextLabel')}
          rows={2}
          className="w-full rounded-lg border px-2 py-1.5 text-xs dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface"
        />
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => { void handleSaveCulture(); }}
            disabled={!cultureDraft.topic.trim() || !cultureDraft.text.trim()}
            className="btn-idchat-primary-filled inline-flex items-center px-3 py-1 text-xs disabled:opacity-60"
          >
            {i18nService.t('memoryCultureSave')}
          </button>
          {editingCultureId != null && (
            <button
              type="button"
              onClick={resetCultureEditor}
              className="rounded-lg border px-3 py-1 text-xs dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text"
            >
              {i18nService.t('cancel')}
            </button>
          )}
        </div>
      </div>

      {cultureLoading ? (
        <div className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">{i18nService.t('loading')}</div>
      ) : cultureEntries.length === 0 ? (
        <div className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">{i18nService.t('memoryCultureEmpty')}</div>
      ) : (
        <div className="space-y-2">
          {cultureEntries.map((entry) => (            <div
              key={entry.id}
              className={`rounded-lg border px-3 py-2 dark:border-claude-darkBorder border-claude-border ${entry.status === 'archived' ? 'opacity-60' : ''}`}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-xs font-medium dark:text-claude-darkText text-claude-text">{entry.topic}</span>
                  <span className="rounded-full border px-1.5 text-[10px] dark:border-claude-darkBorder border-claude-border dark:text-claude-darkTextSecondary text-claude-textSecondary">
                    {cultureKindLabels[entry.kind]}
                  </span>
                  <span className="rounded-full border px-1.5 text-[10px] dark:border-claude-darkBorder border-claude-border dark:text-claude-darkTextSecondary text-claude-textSecondary">
                    {entry.origin === 'owner' ? i18nService.t('memoryCultureOriginOwner') : i18nService.t('memoryCultureOriginDistillation')}
                  </span>
                  {entry.pendingApproval && (
                    <span className="rounded-full border px-1.5 text-[10px] text-amber-600 dark:text-amber-400 dark:border-claude-darkBorder border-claude-border">
                      {i18nService.t('memoryCulturePendingBadge')}
                    </span>
                  )}
                  <span className="text-[10px] dark:text-claude-darkTextSecondary text-claude-textSecondary">v{entry.version}</span>
                  {entry.status === 'archived' && (
                    <span className="text-[10px] dark:text-claude-darkTextSecondary text-claude-textSecondary">{i18nService.t('memoryCultureArchived')}</span>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1.5 text-[11px]">
                  {entry.pendingApproval && (
                    <button
                      type="button"
                      onClick={async () => {
                        if (await coworkService.approveTeamCulture(entry.id)) {
                          await loadCulture();
                        }
                      }}
                      className="rounded border px-2 py-1 text-[10px] text-claude-accent hover:underline dark:text-claude-darkAccent dark:border-claude-darkBorder border-claude-border"
                    >
                      {i18nService.t('memoryCultureApprove')}
                    </button>
                  )}
                  {entry.status === 'archived' ? (
                    <button
                      type="button"
                      onClick={async () => { if (await coworkService.restoreTeamCulture(entry.id)) { await loadCulture(); } }}
                      className="text-claude-accent hover:underline dark:text-claude-darkAccent"
                    >
                      {i18nService.t('memoryCultureRestore')}
                    </button>
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={() => {
                          setEditingCultureId(entry.id);
                          setCultureDraft({ kind: entry.kind, topic: entry.topic, text: entry.text });
                        }}
                        className="text-claude-accent hover:underline dark:text-claude-darkAccent"
                      >
                        {i18nService.t('edit')}
                      </button>
                      <button
                        type="button"
                        onClick={async () => { if (await coworkService.archiveTeamCulture(entry.id)) { await loadCulture(); } }}
                        className="dark:text-claude-darkTextSecondary text-claude-textSecondary hover:underline"
                      >
                        {i18nService.t('memoryCultureArchive')}
                      </button>
                    </>
                  )}
                </div>
              </div>
              <div className="mt-1 text-xs break-words whitespace-pre-wrap dark:text-claude-darkText text-claude-text">
                {entry.text}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Communication-entropy observation: does the shared prior actually
          compress coordination? bytes per deliverable per task, over time. */}
      <div className="rounded-lg border px-3 py-3 dark:border-claude-darkBorder border-claude-border">
        <div className="text-[10px] uppercase tracking-wide dark:text-claude-darkTextSecondary text-claude-textSecondary">
          {i18nService.t('memoryCultureCommTrendTitle')}
        </div>
        <div className="mt-0.5 text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
          {i18nService.t('memoryCultureCommTrendHint')}
        </div>
        {commTrend.length === 0 ? (
          <div className="mt-1.5 text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
            {i18nService.t('memoryCultureCommTrendEmpty')}
          </div>
        ) : (
          <div className="mt-1.5 space-y-1">
            {commTrend.map((row) => {
              const ratio = row.deliverableCount > 0 && row.commTotalBytes != null
                ? Math.round(row.commTotalBytes / row.deliverableCount)
                : null;
              return (
                <div key={row.taskId} className="flex items-center justify-between gap-2 text-[11px] dark:text-claude-darkText text-claude-text">
                  <span className="truncate">#{row.taskId} {row.title}</span>
                  <span className="shrink-0 dark:text-claude-darkTextSecondary text-claude-textSecondary">
                    {`${row.commMessageCount ?? 0} ${i18nService.t('memoryCultureCommMsgs')} · ${row.commTotalBytes ?? 0} B · ${row.deliverableCount} ${i18nService.t('memoryCultureCommDeliverables')}${ratio != null ? ` · ${ratio} B/${i18nService.t('memoryCultureCommPerDeliverable')}` : ''}`}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );

  return (
    <div className="space-y-5">
      {/* Header + bot selector */}
      <div className="rounded-xl border px-4 py-4 dark:border-claude-darkBorder border-claude-border">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-sm font-medium dark:text-claude-darkText text-claude-text">{i18nService.t('coworkMemoryTitle')}</div>
            <div className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">{i18nService.t('memoryPageHint')}</div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">{i18nService.t('memorySelectMetabot')}</span>
            <select
              value={metabotId ?? ''}
              onChange={(event) => {
                const next = Number(event.target.value);
                setMetabotId(Number.isFinite(next) && next > 0 ? next : null);
                setSelectedContactId(null);
              }}
              className="min-w-[180px] rounded-lg border px-2 py-1.5 text-xs dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface"
              disabled={metabots.length === 0}
            >
              {metabots.length === 0 ? (
                <option value="">{i18nService.t('memoryNoMetabot')}</option>
              ) : (
                metabots.map((item) => (
                  <option key={item.id} value={item.id}>{item.name}</option>
                ))
              )}
            </select>
          </div>
        </div>
        {metabotId == null && (
          <div className="mt-3 text-xs text-amber-600 dark:text-amber-400">{i18nService.t('memoryNoMetabot')}</div>
        )}
      </div>

      {renderPolicy()}
      {renderHygiene()}

      {/* Self-cognition (dream-managed self-identity), surfaced on its own */}
      {metabotId != null && (
        <div className="rounded-xl border px-4 py-4 dark:border-claude-darkBorder border-claude-border">
          <div className="flex items-center gap-2">
            <BrainIcon className="h-4 w-4 text-claude-accent dark:text-claude-darkAccent" />
            <span className="text-sm font-medium dark:text-claude-darkText text-claude-text">{i18nService.t('memorySelfIdentityTitle')}</span>
          </div>
          <div className="mt-1 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
            {i18nService.t('memorySelfIdentityHint')}
          </div>
          <div className="mt-3 text-sm dark:text-claude-darkText text-claude-text break-words whitespace-pre-wrap">
            {selfIdentity?.text?.trim() || (
              <span className="text-xs italic dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {i18nService.t('memorySelfIdentityEmpty')}
              </span>
            )}
          </div>
          {selfIdentity && (
            <div className="mt-2 text-[10px] dark:text-claude-darkTextSecondary/70 text-claude-textSecondary/70">
              {formatTimestamp(selfIdentity.updatedAt)}
            </div>
          )}
        </div>
      )}

      {/* Section tabs */}
      <div className="flex flex-wrap items-center gap-2">
        {sectionTab('knowledge', i18nService.t('memorySectionKnowledge'), metabotId == null ? undefined : knowledgeCounts)}
        {sectionTab('contacts', i18nService.t('memorySectionContacts'), metabotId == null || contacts.length === 0 ? undefined : contacts.length)}
        {sectionTab('facts', i18nService.t('memorySectionFacts'), metabotId == null || !factsStats ? undefined : factsStats.created + factsStats.stale)}
        {sectionTab('dream', i18nService.t('memorySectionDream'), metabotId == null || dreamSummaries.length === 0 ? undefined : dreamSummaries.length)}
        {sectionTab('culture', i18nService.t('memorySectionCulture'), cultureCounts == null ? undefined : cultureCounts.glossary + cultureCounts.convention + cultureCounts.team_lesson)}
      </div>

      {/* Active section */}
      <div className="rounded-xl border px-4 py-4 dark:border-claude-darkBorder border-claude-border">
        {metabotId == null ? (
          <div className="py-6 text-center text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">{i18nService.t('memoryNoMetabot')}</div>
        ) : (
          <>
            {activeSection === 'knowledge' && renderKnowledge()}
            {activeSection === 'contacts' && renderContacts()}
            {activeSection === 'facts' && renderFacts()}
            {activeSection === 'dream' && renderDream()}
            {activeSection === 'culture' && renderCulture()}
          </>
        )}
      </div>

      {/* Memory entry editor modal */}
      {showModal && (
        <div
          className="absolute inset-0 z-20 flex items-center justify-center bg-black/35 px-4"
          onClick={resetEditor}
        >
          <div
            className="dark:bg-claude-darkSurface bg-claude-surface dark:border-claude-darkBorder border-claude-border border rounded-2xl shadow-xl w-full max-w-md"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-5 pt-5 pb-4 border-b dark:border-claude-darkBorder border-claude-border">
              <h3 className="text-base font-semibold dark:text-claude-darkText text-claude-text">
                {editingId ? i18nService.t('coworkMemoryCrudUpdate') : i18nService.t('coworkMemoryCrudCreate')}
              </h3>
            </div>
            <div className="px-5 py-4 space-y-4">
              <textarea
                value={draftText}
                onChange={(event) => setDraftText(event.target.value)}
                placeholder={i18nService.t('coworkMemoryCrudTextPlaceholder')}
                autoFocus
                className="min-h-[200px] w-full rounded-lg border px-3 py-2 text-sm dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface dark:text-claude-darkText text-claude-text focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30"
              />
              <div className="grid grid-cols-2 gap-3">
                <label className="block">
                  <span className="block mb-1 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">{i18nService.t('coworkMemoryCategoryAll')}</span>
                  <select
                    value={draftUsageClass}
                    onChange={(event) => {
                      const next = event.target.value as EditableUsageClass;
                      setDraftUsageClass(next);
                      if (next !== 'operational_preference') setDraftVisibility('local_only');
                    }}
                    className="w-full rounded-lg border px-2 py-1.5 text-xs dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface"
                  >
                    <option value="profile_fact">{i18nService.t('coworkMemoryUsageProfileFact')}</option>
                    <option value="preference">{i18nService.t('coworkMemoryUsagePreference')}</option>
                    <option value="operational_preference">{i18nService.t('coworkMemoryUsageOperationalPreference')}</option>
                    <option value="work_review">{i18nService.t('coworkMemoryUsageWorkReview')}</option>
                    <option value="value_boundary">{i18nService.t('coworkMemoryUsageValueBoundary')}</option>
                  </select>
                </label>
                <label className="block">
                  <span className="block mb-1 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">{i18nService.t('coworkMemoryVisibility')}</span>
                  <select
                    value={draftVisibility}
                    onChange={(event) => setDraftVisibility(event.target.value === 'external_safe' ? 'external_safe' : 'local_only')}
                    disabled={!draftExternalSafeAllowed}
                    className="w-full rounded-lg border px-2 py-1.5 text-xs dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface disabled:opacity-60"
                  >
                    <option value="local_only">{i18nService.t('coworkMemoryVisibilityLocalOnly')}</option>
                    <option value="external_safe">{i18nService.t('coworkMemoryVisibilityExternalSafe')}</option>
                  </select>
                </label>
              </div>
              {!draftExternalSafeAllowed && (
                <div className="text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">{i18nService.t('coworkMemoryVisibilityLockedHint')}</div>
              )}
            </div>
            <div className="flex justify-end space-x-2 px-5 pb-5">
              <button
                type="button"
                onClick={resetEditor}
                className="px-3 py-1.5 text-sm dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover rounded-xl border dark:border-claude-darkBorder border-claude-border transition-colors"
              >
                {i18nService.t('cancel')}
              </button>
              <button
                type="button"
                onClick={() => { void handleSaveFact(); }}
                disabled={!draftText.trim() || factsLoading}
                className="btn-idchat-primary-filled px-3 py-1.5 text-sm"
              >
                {i18nService.t('save')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

/** Compact labelled toggle row used inside the policy card. */
const ToggleRow: React.FC<{
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}> = ({ label, hint, checked, onChange, disabled }) => (
  <label className={`flex items-start justify-between gap-3 ${disabled ? 'opacity-60' : ''}`}>
    <span className="flex-1">
      <span className="block text-xs font-medium dark:text-claude-darkText text-claude-text">{label}</span>
      {hint && <span className="block text-[11px] font-normal dark:text-claude-darkTextSecondary text-claude-textSecondary">{hint}</span>}
    </span>
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors ${
        checked ? 'bg-claude-accent' : 'bg-gray-300 dark:bg-gray-600'
      } ${disabled ? 'cursor-not-allowed' : 'cursor-pointer'}`}
    >
      <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${checked ? 'translate-x-5' : 'translate-x-1'}`} />
    </button>
  </label>
);

export default MemorySettings;
