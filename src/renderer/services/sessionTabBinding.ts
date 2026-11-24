import type {
  BotBrowserTabCommand,
  BotBrowserTabCommandResult,
  BotBrowserTabInfo,
} from '../features/botBrowser/types';
import type { CoworkSession, CoworkSessionSummary } from '../types/cowork';
import { browserUrisMatch } from '../../main/shared/browserUriMatch';
import {
  loadPersistedBrowserSessionActiveRoles,
  loadPersistedBrowserSessionId,
  loadPersistedBrowserSessionPages,
  savePersistedBrowserSessionActiveRole,
  savePersistedBrowserSessionId,
  savePersistedBrowserSessionPage,
  type PersistedBrowserSessionPage,
} from './viewState';

/**
 * Fixed tab roles per Studio session (owner ruling 2026-11-12): every
 * conversation owns at most two Bot Browser tabs —
 *   'stage'    the host-owned Live Stage (liquid-orb presence); never
 *              navigated, switched or closed by generic commands;
 *   'showcase' reports, MetaApp previews, deliverables and ordinary opens;
 *              its last committed URI is the persisted "last page".
 * Tab ids are runtime-only; persisted pages record the SHOWCASE page only.
 */
export type SessionTabRole = 'stage' | 'showcase';

export interface SessionTabHost {
  controlTabs(command: BotBrowserTabCommand): Promise<BotBrowserTabCommandResult>;
  getOpenSession(): CoworkSession | null;
  openSession(sessionId: string): Promise<CoworkSession | null>;
  listBrowserSessions(): Promise<CoworkSessionSummary[]>;
  /** Resolve the Bot identity (`metabotId`) of a Studio session so all conversations of the same Bot share one Live Stage tab. */
  getSessionBotId?(sessionId: string): number | null;
}

export type SessionBrowserEvent = {
  type?: 'agent-browser:event';
  version?: 1;
  event?: unknown;
  payload?: {
    tabId?: unknown;
    uri?: unknown;
    title?: unknown;
  } | null;
};

export interface RevealSessionTabOptions {
  /**
   * When true (e.g. submitting a chat message while the Bot Browser pane is
   * already visible on screen), keep the currently active tab focused if it is
   * an interactive non-projection page (such as an open MetaApp), instead of
   * covering it with the Live Stage tab.
   */
  preserveActiveInteractiveTab?: boolean;
}

export interface SessionTabBinding {
  attach(host: SessionTabHost): void;
  rememberOpenSession(sessionId: string | null): void;
  prepareDraftTab(metabotId?: number | null, options?: RevealSessionTabOptions): Promise<number | null>;
  /**
   * Ensure the prewarmed draft tab exists on the stage entry, then patch its
   * frame with the selected bot's draft identity (metabotId null → the
   * default Twin name/fallback avatar). Idempotent; safe to re-call when the
   * draft's bot selection changes.
   */
  prepareDraftIdentity(metabotId: number | null): Promise<void>;
  bindNewSession(sessionId: string): Promise<void>;
  revealSessionTab(sessionId: string, options?: RevealSessionTabOptions): Promise<void>;
  restoreLastSession(): Promise<void>;
  controlSessionTab(
    command: BotBrowserTabCommand & { sessionId: string },
  ): Promise<BotBrowserTabCommandResult>;
  handleBrowserEvent(message: SessionBrowserEvent): void;
}

const MAX_BOUND_TABS = 200;

const uriOf = (tab: BotBrowserTabInfo | null | undefined): string =>
  String(tab?.uri ?? '').trim();

const titleOf = (tab: BotBrowserTabInfo | null | undefined): string | null => {
  const title = String(tab?.title ?? '').trim();
  return title || null;
};

const isBlank = (tab: BotBrowserTabInfo | null | undefined): boolean => !uriOf(tab);

/**
 * A Live Stage page — the persistent materialized entry
 * (`…/live-stage/<templateId>-<hash>/stage.html`) or a legacy per-turn file
 * (`…/reports/live-stage-*.html`). Stage chrome is never a showcase page and
 * is never adopted as one.
 */
const isLiveStagePageUri = (uri: string | null | undefined): boolean => {
  const value = String(uri ?? '');
  if (!value) return false;
  if (value.includes('/reports/live-stage-')) return true;
  return value.includes('/live-stage/') && /\/stage\.html(?:[?#]|$)/.test(value);
};

/**
 * True when `tab` is a live interactive non-projection page (e.g. an open
 * `metaapp://`, `metaid://`, `https://`, or non-`/reports/` preview app) that
 * the owner is actively viewing and must not have covered on prompt submit.
 */
const isInteractiveNonProjectionTab = (tab: BotBrowserTabInfo | null | undefined): boolean => {
  const value = uriOf(tab);
  if (!value || isLiveStagePageUri(value)) return false;
  if (value.includes('welcome-genesis') || value.includes('/reports/')) return false;
  return true;
};

const roleOf = (command: Pick<BotBrowserTabCommand, 'role'>): SessionTabRole =>
  command.role === 'stage' ? 'stage' : 'showcase';

const tabKey = (sessionId: string, role: SessionTabRole): string => `${sessionId}\u0000${role}`;

type TabBinding = { sessionId: string; role: SessionTabRole; tabId: number };

export function createSessionTabBinding(): SessionTabBinding {
  let host: SessionTabHost | null = null;
  let pendingDraftTabId: number | null = null;
  /** Concurrent prepareDraftTab callers share this one in-flight promise. */
  let prepareDraftPromise: Promise<number | null> | null = null;
  const sessionTabs = new Map<string, TabBinding>();
  /** One persistent Live Stage tab per Bot (`metabotId -> tabId`) across Studio conversations. */
  const botStageTabs = new Map<number, number>();
  const sessionPages = new Map<string, PersistedBrowserSessionPage>();
  const sessionActiveRoles = new Map<string, SessionTabRole>();
  let pagesLoaded = false;
  let restoreStarted = false;
  let queue: Promise<void> = Promise.resolve();
  let stageEntryUriPromise: Promise<string | null> | null = null;

  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    const result = queue.then(task, task);
    queue = result.then(() => undefined, () => undefined);
    return result;
  };

  const ensurePagesLoaded = (): void => {
    if (pagesLoaded) return;
    pagesLoaded = true;
    for (const [sessionId, page] of Object.entries(loadPersistedBrowserSessionPages())) {
      sessionPages.set(sessionId, page);
    }
    for (const [sessionId, role] of Object.entries(loadPersistedBrowserSessionActiveRoles())) {
      sessionActiveRoles.set(sessionId, role);
    }
  };

  const rememberActiveRole = (sessionId: string, role: SessionTabRole): void => {
    ensurePagesLoaded();
    const normalized = sessionId.trim();
    if (!normalized) return;
    sessionActiveRoles.delete(normalized);
    if (role === 'showcase') {
      sessionActiveRoles.set(normalized, 'showcase');
      while (sessionActiveRoles.size > MAX_BOUND_TABS) {
        const oldest = sessionActiveRoles.keys().next();
        if (oldest.done) break;
        sessionActiveRoles.delete(oldest.value);
      }
    }
    savePersistedBrowserSessionActiveRole(normalized, role);
  };

  const pageFor = (sessionId: string): PersistedBrowserSessionPage | null => {
    ensurePagesLoaded();
    const persisted = sessionPages.get(sessionId);
    if (persisted) {
      // The persisted "last page" is the SHOWCASE page only: a legacy
      // per-turn stage file (or the persistent entry URI) is stage chrome and
      // must never be restored as the session's showcase page.
      if (isLiveStagePageUri(persisted.uri)) return null;
      return persisted;
    }
    const open = host?.getOpenSession();
    if (open?.id !== sessionId) return null;
    const uri = String(open.browserUri ?? '').trim();
    if (!uri || isLiveStagePageUri(uri)) return null;
    return { uri, title: String(open.browserTitle ?? '').trim() || null };
  };

  const rememberPage = (sessionId: string, uri: string, title?: string | null): void => {
    ensurePagesLoaded();
    const normalizedUri = uri.trim();
    if (!normalizedUri || isLiveStagePageUri(normalizedUri)) return;
    const normalizedTitle = title?.trim() || null;
    const previous = sessionPages.get(sessionId);
    if (previous?.uri === normalizedUri && previous.title === normalizedTitle) return;
    sessionPages.delete(sessionId);
    const page = { uri: normalizedUri, title: normalizedTitle };
    sessionPages.set(sessionId, page);
    while (sessionPages.size > MAX_BOUND_TABS) {
      const oldest = sessionPages.keys().next();
      if (oldest.done) break;
      sessionPages.delete(oldest.value);
    }
    savePersistedBrowserSessionPage(sessionId, page);
  };

  const botIdOf = (sessionId: string): number | null => {
    const raw = host?.getSessionBotId?.(sessionId);
    if (typeof raw === 'number' && Number.isInteger(raw) && raw > 0) return raw;
    const open = host?.getOpenSession();
    if (open?.id === sessionId && typeof open.metabotId === 'number' && open.metabotId > 0) {
      return open.metabotId;
    }
    return null;
  };

  const ownerOfTab = (tabId: number): TabBinding | null => {
    for (const binding of sessionTabs.values()) {
      if (binding.tabId === tabId) return binding;
    }
    return null;
  };

  const rememberTab = (sessionId: string, role: SessionTabRole, tabId: number): void => {
    const botId = role === 'stage' ? botIdOf(sessionId) : null;
    if (botId != null) {
      botStageTabs.set(botId, tabId);
    }
    for (const [key, binding] of sessionTabs) {
      if (binding.tabId !== tabId || key === tabKey(sessionId, role)) continue;
      // Same-Bot Studio sessions share a single Live Stage tab: keep sibling
      // stage bindings of the same Bot intact while still evicting foreign/showcase claims.
      if (
        role === 'stage'
        && binding.role === 'stage'
        && botId != null
        && botIdOf(binding.sessionId) === botId
      ) {
        continue;
      }
      sessionTabs.delete(key);
    }
    sessionTabs.delete(tabKey(sessionId, role));
    sessionTabs.set(tabKey(sessionId, role), { sessionId, role, tabId });
    while (sessionTabs.size > MAX_BOUND_TABS) {
      const oldest = sessionTabs.keys().next();
      if (oldest.done) break;
      sessionTabs.delete(oldest.value);
    }
  };

  const controlTabs = async (
    command: BotBrowserTabCommand,
  ): Promise<BotBrowserTabCommandResult | null> => {
    if (!host) return null;
    try {
      return await host.controlTabs(command);
    } catch {
      return null;
    }
  };

  const listTabs = async (): Promise<BotBrowserTabCommandResult | null> =>
    controlTabs({ action: 'get-tabs' });

  const liveBotStageTab = (
    botId: number | null,
    tabs: BotBrowserTabInfo[],
  ): BotBrowserTabInfo | null => {
    if (botId == null) return null;
    const tabId = botStageTabs.get(botId);
    if (tabId == null) return null;
    const tab = tabs.find((entry) => entry.id === tabId) ?? null;
    if (!tab) {
      botStageTabs.delete(botId);
      return null;
    }
    return tab;
  };

  const liveBoundTab = (
    sessionId: string,
    role: SessionTabRole,
    tabs: BotBrowserTabInfo[],
  ): BotBrowserTabInfo | null => {
    const binding = sessionTabs.get(tabKey(sessionId, role));
    if (binding) {
      const tab = tabs.find((entry) => entry.id === binding.tabId) ?? null;
      if (tab) return tab;
      sessionTabs.delete(tabKey(sessionId, role));
    }
    if (role === 'stage') {
      const shared = liveBotStageTab(botIdOf(sessionId), tabs);
      if (shared) {
        rememberTab(sessionId, 'stage', shared.id);
        return shared;
      }
    }
    return null;
  };

  /**
   * The persistent stage entry URI, fetched once from the main process (the
   * materialized `<userData>/live-stage/<template>-<hash>/stage.html`). Null
   * when the bridge is unavailable — callers degrade to today's behavior.
   */
  const stageEntryUri = (): Promise<string | null> => {
    stageEntryUriPromise ??= (async () => {
      try {
        const response = await window.electron?.studioLiveStage?.getStageEntry?.();
        const uri = typeof response?.uri === 'string' ? response.uri.trim() : '';
        return uri || null;
      } catch {
        return null;
      }
    })();
    return stageEntryUriPromise;
  };

  const canAdopt = (
    sessionId: string,
    role: SessionTabRole,
    tab: BotBrowserTabInfo,
    uri: string,
  ): boolean => {
    // Stage chrome is never a showcase page.
    if (role === 'showcase' && isLiveStagePageUri(uriOf(tab))) return false;
    const owner = ownerOfTab(tab.id);
    if (owner && (owner.sessionId !== sessionId || owner.role !== role)) return false;
    if (isBlank(tab) || browserUrisMatch(uriOf(tab), uri)) return true;
    const lastPage = pageFor(sessionId);
    return browserUrisMatch(lastPage?.uri, uriOf(tab));
  };

  const finish = async (
    action: BotBrowserTabCommand['action'],
    tabId: number,
    fallback: BotBrowserTabCommandResult,
  ): Promise<BotBrowserTabCommandResult> => {
    const snapshot = await listTabs();
    const result = snapshot ?? fallback;
    const sessionTab = result.tabs.find((tab) => tab.id === tabId)
      ?? (result.activeTab?.id === tabId ? result.activeTab : null);
    return {
      ...result,
      action,
      openedTabId: tabId,
      sessionTab,
    };
  };

  /**
   * Stage-role tab resolution. The stage tab is host-owned: it is only ever
   * the session's bound stage tab, the prewarmed draft tab (blank or already
   * showing the entry), or a fresh tab opened with dedupe:false — the entry
   * URI is shared by every session, so URI-dedupe must never merge two
   * sessions' stage tabs. Nothing is persisted for the stage role.
   */
  const ensureStageTab = async (input: {
    sessionId: string;
    action: 'open-tab' | 'navigate-tab';
    uri: string;
    label?: string;
    activate: boolean;
    /**
     * First projection of a brand-new session: adopt the pending draft when
     * it is unowned and blank/on the entry, with NO open-session condition.
     */
    draftClaim?: boolean;
  }): Promise<BotBrowserTabCommandResult> => {
    const snapshot = await listTabs();
    if (!snapshot) throw new Error('Bot Browser tabs are not available.');
    const tabs = snapshot.tabs;
    const activeBefore = snapshot.activeTab ?? tabs.find((tab) => tab.isActive) ?? null;
    const uri = input.uri.trim();
    let target = liveBoundTab(input.sessionId, 'stage', tabs);
    // Why the pending draft could not be adopted — logged when a fresh stage
    // tab opens instead, so the next missed-claim is explainable.
    let draftRejectReason = 'no draft';

    if (!target && pendingDraftTabId != null) {
      const pending = tabs.find((tab) => tab.id === pendingDraftTabId) ?? null;
      if (pending) {
        const owner = ownerOfTab(pending.id);
        const open = host?.getOpenSession() ?? null;
        // The prewarmed draft may be claimed while the real session is still
        // being created: the open session is then the optimistic placeholder
        // (or nothing). The incoming session must be completely unbound — no
        // persisted showcase page and no tab in either role — before it may
        // take the draft over; a bound session always gets its own stage tab.
        // draftClaim (first projection of a brand-new session) skips the
        // open-session condition entirely.
        const openIsThisSession = open?.id === input.sessionId;
        const openIsPlaceholder = !open || open.id.startsWith('optimistic-browser-');
        const sessionUnbound = pageFor(input.sessionId) == null
          && !liveBoundTab(input.sessionId, 'stage', tabs)
          && !liveBoundTab(input.sessionId, 'showcase', tabs);
        const ownerOk = !owner || (owner.sessionId === input.sessionId && owner.role === 'stage');
        const uriOk = isBlank(pending) || browserUrisMatch(uriOf(pending), uri);
        const sessionOk = input.draftClaim === true
          || openIsThisSession
          || (openIsPlaceholder && sessionUnbound);
        const adoptable = ownerOk && uriOk && sessionOk;
        if (!ownerOk) draftRejectReason = 'draft owned';
        else if (!uriOk) draftRejectReason = 'draft URI mismatch';
        else if (!sessionOk) draftRejectReason = 'claim rule failed';
        if (adoptable) target = pending;
      } else {
        pendingDraftTabId = null;
      }
    }

    // The open conversation's stage may take over the browser's sole blank
    // or matching-entry unowned tab instead of stacking a second tab next to it.
    if (!target && tabs.length === 1 && (isBlank(tabs[0]) || browserUrisMatch(uriOf(tabs[0]), uri))
      && tabs[0].id !== pendingDraftTabId
      && ownerOfTab(tabs[0].id) == null && host?.getOpenSession()?.id === input.sessionId) {
      target = tabs[0];
    }

    let fallback = snapshot;
    if (target) {
      rememberTab(input.sessionId, 'stage', target.id);
      if (pendingDraftTabId === target.id) pendingDraftTabId = null;
      if (!browserUrisMatch(uriOf(target), uri)) {
        const navigated = await controlTabs({
          action: 'navigate-tab',
          tabId: target.id,
          uri,
          activate: input.activate,
        });
        if (!navigated) throw new Error(`Bot Browser tab ${target.id} could not be navigated.`);
        fallback = navigated;
      } else if (input.activate && !target.isActive) {
        const switched = await controlTabs({ action: 'switch-tab', tabId: target.id });
        if (!switched) throw new Error(`Bot Browser tab ${target.id} could not be activated.`);
        fallback = switched;
      }
    } else {
      console.warn(`[sessionTabBinding] opening a new stage tab for ${input.sessionId}: ${draftRejectReason}`);
      const opened = await controlTabs({
        action: 'open-tab',
        uri,
        ...(input.label?.trim() ? { label: input.label.trim() } : {}),
        // The stage entry URI is shared by design: never let ABC dedupe this
        // open onto another session's stage tab.
        dedupe: false,
      });
      const tabId = opened?.openedTabId ?? opened?.activeTab?.id ?? null;
      if (!opened || tabId == null) throw new Error('The stage tab could not be opened.');
      rememberTab(input.sessionId, 'stage', tabId);
      if (pendingDraftTabId === tabId) pendingDraftTabId = null;
      fallback = opened;
      target = opened.tabs.find((tab) => tab.id === tabId)
        ?? (opened.activeTab?.id === tabId ? opened.activeTab : null);
      if (!input.activate && activeBefore && activeBefore.id !== tabId) {
        const restored = await controlTabs({ action: 'switch-tab', tabId: activeBefore.id });
        if (restored) fallback = restored;
      }
    }

    if (!target) throw new Error('The stage tab could not be confirmed.');
    if (input.activate) rememberActiveRole(input.sessionId, 'stage');
    return finish(input.action, target.id, fallback);
  };

  const ensureSessionTab = async (input: {
    sessionId: string;
    role: SessionTabRole;
    action: 'open-tab' | 'navigate-tab';
    uri?: string;
    label?: string;
    hintTabId?: number;
    activate: boolean;
    matchByUri: boolean;
    draftClaim?: boolean;
  }): Promise<BotBrowserTabCommandResult> => {
    if (input.role === 'stage') {
      if (!input.uri?.trim()) throw new Error('The stage tab requires the stage entry URI.');
      return ensureStageTab({
        sessionId: input.sessionId,
        action: input.action,
        uri: input.uri,
        label: input.label,
        activate: input.activate,
        draftClaim: input.draftClaim,
      });
    }
    const snapshot = await listTabs();
    if (!snapshot) throw new Error('Bot Browser tabs are not available.');
    const tabs = snapshot.tabs;
    const activeBefore = snapshot.activeTab ?? tabs.find((tab) => tab.isActive) ?? null;
    const uri = input.uri?.trim() ?? '';
    let target = liveBoundTab(input.sessionId, 'showcase', tabs);

    if (!target && input.hintTabId != null) {
      const hinted = tabs.find((tab) => tab.id === input.hintTabId) ?? null;
      if (hinted && canAdopt(input.sessionId, 'showcase', hinted, uri)) target = hinted;
    }

    if (!target && uri && input.matchByUri) {
      target = tabs.find((tab) => (
        browserUrisMatch(uriOf(tab), uri)
        && canAdopt(input.sessionId, 'showcase', tab, uri)
      )) ?? null;
    }

    const canUsePendingDraft = !pageFor(input.sessionId)
      || host?.getOpenSession()?.id === input.sessionId;
    if (!target && pendingDraftTabId != null) {
      const pending = tabs.find((tab) => tab.id === pendingDraftTabId) ?? null;
      if (pending) {
        const owner = ownerOfTab(pending.id);
        // Stage chrome is never a showcase page — a prewarmed draft already
        // showing the stage entry must not be adopted here.
        if (canUsePendingDraft && !isLiveStagePageUri(uriOf(pending))
          && (!owner || (owner.sessionId === input.sessionId && owner.role === 'showcase'))) target = pending;
      } else {
        pendingDraftTabId = null;
      }
    }

    if (!target) {
      const activeBlank = activeBefore && isBlank(activeBefore) ? activeBefore : null;
      const canUseBlank = (tab: BotBrowserTabInfo): boolean => (
        (tab.id !== pendingDraftTabId || canUsePendingDraft)
        && canAdopt(input.sessionId, 'showcase', tab, uri)
      );
      if (activeBlank && canUseBlank(activeBlank)) {
        target = activeBlank;
      } else if (tabs.length === 1 && isBlank(tabs[0]) && canUseBlank(tabs[0])) {
        target = tabs[0];
      }
    }

    let fallback = snapshot;
    if (target) {
      rememberTab(input.sessionId, 'showcase', target.id);
      if (pendingDraftTabId === target.id) pendingDraftTabId = null;
      if (uri && !browserUrisMatch(uriOf(target), uri)) {
        const navigated = await controlTabs({
          action: 'navigate-tab',
          tabId: target.id,
          uri,
          activate: input.activate,
        });
        if (!navigated) throw new Error(`Bot Browser tab ${target.id} could not be navigated.`);
        fallback = navigated;
      } else if (input.activate && !target.isActive) {
        const switched = await controlTabs({ action: 'switch-tab', tabId: target.id });
        if (!switched) throw new Error(`Bot Browser tab ${target.id} could not be activated.`);
        fallback = switched;
      }
    } else {
      const uriOwnedByAnotherSession = uri && tabs.some((tab) => {
        const owner = ownerOfTab(tab.id);
        return browserUrisMatch(uriOf(tab), uri)
          && owner != null
          && owner.sessionId !== input.sessionId;
      });
      const opened = await controlTabs({
        action: 'open-tab',
        ...(uri ? { uri } : {}),
        ...(input.label?.trim() ? { label: input.label.trim() } : {}),
        ...(uriOwnedByAnotherSession ? { dedupe: false } : {}),
      });
      const tabId = opened?.openedTabId ?? opened?.activeTab?.id ?? null;
      if (!opened || tabId == null) throw new Error('The session tab could not be opened.');
      rememberTab(input.sessionId, 'showcase', tabId);
      if (pendingDraftTabId === tabId) pendingDraftTabId = null;
      fallback = opened;
      target = opened.tabs.find((tab) => tab.id === tabId)
        ?? (opened.activeTab?.id === tabId ? opened.activeTab : null);
      if (!input.activate && activeBefore && activeBefore.id !== tabId) {
        const restored = await controlTabs({ action: 'switch-tab', tabId: activeBefore.id });
        if (restored) fallback = restored;
      }
    }

    if (!target) throw new Error('The session tab could not be confirmed.');
    const committedUri = uri || uriOf(target);
    if (committedUri) rememberPage(input.sessionId, committedUri, titleOf(target));
    if (input.activate) rememberActiveRole(input.sessionId, 'showcase');
    return finish(input.action, target.id, fallback);
  };

  /**
   * Idempotent draft prewarm: concurrent callers share one in-flight promise,
   * and a still-valid pending draft (alive, unowned, blank or on the stage
   * entry) is reused — never a second draft tab. An unowned ACTIVE tab
   * already on the entry URI counts as reusable too (covers the second
   * prewarm entry point firing after the first draft navigated).
   */
  const prepareDraftTab = (
    explicitMetabotId?: number | null,
    options?: RevealSessionTabOptions,
  ): Promise<number | null> => {
    prepareDraftPromise ??= enqueue(async () => {
      try {
        const uri = await stageEntryUri();
        const snapshot = await listTabs();
        const tabs = snapshot?.tabs ?? [];
        const active = snapshot?.activeTab ?? tabs.find((tab) => tab.isActive) ?? null;
        const keepActiveInteractive =
          options?.preserveActiveInteractiveTab === true && isInteractiveNonProjectionTab(active);
        const entryUri = uri?.toLowerCase() ?? null;
        const onEntry = (tab: BotBrowserTabInfo): boolean =>
          entryUri != null && browserUrisMatch(uriOf(tab), entryUri);

        // Single Live Stage per Bot: when starting a new Studio conversation
        // for a Bot that ALREADY owns a Live Stage tab, keep that existing
        // stage tab instead of spawning a second Live Stage tab.
        const openBotId =
          typeof explicitMetabotId === 'number' && Number.isInteger(explicitMetabotId) && explicitMetabotId > 0
            ? explicitMetabotId
            : typeof host?.getOpenSession()?.metabotId === 'number' && host.getOpenSession()!.metabotId! > 0
              ? host.getOpenSession()!.metabotId!
              : botStageTabs.size === 1
                ? [...botStageTabs.keys()][0]
                : null;
        const existingBotStage = liveBotStageTab(openBotId, tabs);
        if (existingBotStage && (isBlank(existingBotStage) || onEntry(existingBotStage))) {
          if (uri && !onEntry(existingBotStage)) {
            await controlTabs({
              action: 'navigate-tab',
              tabId: existingBotStage.id,
              uri,
              activate: false,
            });
          }
          if (!keepActiveInteractive && !existingBotStage.isActive) {
            await controlTabs({ action: 'switch-tab', tabId: existingBotStage.id });
          }
          return existingBotStage.id;
        }

        let draft: BotBrowserTabInfo | null = null;
        if (pendingDraftTabId != null) {
          const pending = tabs.find((tab) => tab.id === pendingDraftTabId) ?? null;
          if (pending && ownerOfTab(pending.id) == null && (isBlank(pending) || onEntry(pending))) {
            draft = pending;
          } else {
            // Owned, navigated away, or gone — it is no longer a draft.
            pendingDraftTabId = null;
          }
        }
        if (!draft && active && ownerOfTab(active.id) == null) {
          if (onEntry(active) || isBlank(active)) draft = active;
        }

        if (draft) {
          pendingDraftTabId = draft.id;
          if (uri && !onEntry(draft)) {
            const navigated = await controlTabs({
              action: 'navigate-tab',
              tabId: draft.id,
              uri,
              activate: false,
            });
            if (!navigated) throw new Error(`Bot Browser tab ${draft.id} could not be navigated.`);
          }
          if (!keepActiveInteractive && !draft.isActive) {
            await controlTabs({ action: 'switch-tab', tabId: draft.id });
          }
          return pendingDraftTabId;
        }

        const opened = await controlTabs({ action: 'open-tab' });
        pendingDraftTabId = opened?.openedTabId ?? opened?.activeTab?.id ?? null;
        if (uri && pendingDraftTabId != null) {
          const openedDraft = (await listTabs())?.tabs.find((tab) => tab.id === pendingDraftTabId) ?? null;
          if (openedDraft && !browserUrisMatch(uriOf(openedDraft), uri)) {
            await controlTabs({
              action: 'navigate-tab',
              tabId: pendingDraftTabId,
              uri,
              activate: false,
            });
          }
        }
        if (keepActiveInteractive && active && pendingDraftTabId != null && active.id !== pendingDraftTabId) {
          await controlTabs({ action: 'switch-tab', tabId: active.id });
        }
        return pendingDraftTabId;
      } catch {
        pendingDraftTabId = null;
        return null;
      }
    }).finally(() => {
      prepareDraftPromise = null;
    });
    return prepareDraftPromise;
  };

  const prepareDraftIdentity = (metabotId: number | null): Promise<void> =>
    prepareDraftTab(metabotId).then(async (tabId) => {
      if (tabId == null) return;
      try {
        await window.electron?.studioLiveStage?.prepareDraft?.({
          tabId,
          metabotId: typeof metabotId === 'number' && Number.isInteger(metabotId) && metabotId > 0 ? metabotId : null,
        });
      } catch {
        // Draft identity is cosmetic; the first session patch overwrites it.
      }
    }).then(() => undefined);

  const bindNewSession = (sessionId: string): Promise<void> => enqueue(async () => {
    try {
      const page = pageFor(sessionId);
      if (page) {
        await ensureSessionTab({
          sessionId,
          role: 'showcase',
          action: 'open-tab',
          uri: page.uri,
          activate: true,
          matchByUri: true,
        });
        return;
      }
      // A fresh conversation's first tab is the stage: the pending draft was
      // prewarmed onto the stage entry, so binding it here means the owner
      // sees the live presence immediately and the first projection only
      // patches. The showcase tab appears with the first report.
      const stageUri = await stageEntryUri();
      if (stageUri) {
        await ensureSessionTab({
          sessionId,
          role: 'stage',
          action: 'open-tab',
          uri: stageUri,
          activate: true,
          matchByUri: false,
          // bindNewSession only runs for a brand-new session: the pending
          // draft is adopted unconditionally (unowned, blank or on entry).
          draftClaim: true,
        });
        return;
      }
      await ensureSessionTab({
        sessionId,
        role: 'showcase',
        action: 'open-tab',
        activate: true,
        matchByUri: true,
      });
    } catch {
      // The next projection or selection retries the binding.
    }
  });

  const reveal = async (
    sessionId: string,
    options?: { restoreLastActiveRole?: boolean; preserveActiveInteractiveTab?: boolean },
  ): Promise<void> => {
    ensurePagesLoaded();
    const snapshot = await listTabs();
    const tabs = snapshot?.tabs ?? [];
    const activeBefore = snapshot?.activeTab ?? tabs.find((tab) => tab.isActive) ?? null;
    const keepCurrentInteractiveTab =
      options?.preserveActiveInteractiveTab === true && isInteractiveNonProjectionTab(activeBefore);
    const page = pageFor(sessionId);
    const wantShowcaseActive = options?.restoreLastActiveRole === true
      && page != null
      && sessionActiveRoles.get(sessionId) === 'showcase';
    // Reveal the session's bound stage tab (or open the persistent stage entry
    // as the stage role), AND when the session also has a persisted showcase
    // report page (`pageFor(sessionId)`), restore its showcase tab beside the
    // stage tab so reopening the app reconstructs the full Studio workspace
    // (both Live Stage and report tab, honoring whichever tab was last active).
    const stageTab = liveBoundTab(sessionId, 'stage', tabs);
    let stageAvailable = Boolean(stageTab);
    if (stageTab) {
      if (!keepCurrentInteractiveTab && !wantShowcaseActive && !stageTab.isActive) {
        await controlTabs({ action: 'switch-tab', tabId: stageTab.id });
        rememberActiveRole(sessionId, 'stage');
      }
    } else {
      const stageUri = await stageEntryUri();
      if (stageUri) {
        stageAvailable = true;
        await ensureSessionTab({
          sessionId,
          role: 'stage',
          action: 'open-tab',
          uri: stageUri,
          activate: !keepCurrentInteractiveTab,
          matchByUri: false,
        });
      } else if (!keepCurrentInteractiveTab) {
        // No stage entry available (prewarm IPC missing): keep the legacy
        // behavior of restoring the session's last showcase page.
        await ensureSessionTab({
          sessionId,
          role: 'showcase',
          action: 'open-tab',
          uri: page?.uri,
          ...(page?.title ? { label: page.title } : {}),
          activate: true,
          matchByUri: true,
        });
      }
    }
    if (stageAvailable && page) {
      const afterStageTabs = (await listTabs())?.tabs ?? tabs;
      const showcaseTab = liveBoundTab(sessionId, 'showcase', afterStageTabs);
      if (!showcaseTab) {
        await ensureSessionTab({
          sessionId,
          role: 'showcase',
          action: 'open-tab',
          uri: page.uri,
          ...(page.title ? { label: page.title } : {}),
          activate: !keepCurrentInteractiveTab && wantShowcaseActive,
          matchByUri: true,
        });
      } else if (!keepCurrentInteractiveTab && wantShowcaseActive && !showcaseTab.isActive) {
        await controlTabs({ action: 'switch-tab', tabId: showcaseTab.id });
        rememberActiveRole(sessionId, 'showcase');
      }
    }
    try {
      await window.electron?.studioLiveStage?.showSession?.(sessionId);
    } catch {
      // Stage redelivery is best-effort; the tab itself is already revealed.
    }
  };

  const revealSessionTab = (sessionId: string, options?: RevealSessionTabOptions): Promise<void> => enqueue(async () => {
    try {
      await reveal(sessionId, { preserveActiveInteractiveTab: options?.preserveActiveInteractiveTab });
    } catch {
      // Session selection remains usable when the Browser bridge is unavailable.
    }
  });

  const restoreLastSession = (): Promise<void> => {
    if (restoreStarted) return Promise.resolve();
    restoreStarted = true;
    return enqueue(async () => {
      try {
        if (!host) return;
        let sessionId = loadPersistedBrowserSessionId();
        let session = sessionId ? await host.openSession(sessionId) : null;
        if (!session) {
          const candidates = (await host.listBrowserSessions())
            .filter((entry) => entry.sessionType === 'browser')
            .sort((a, b) => Number(b.updatedAt ?? 0) - Number(a.updatedAt ?? 0));
          sessionId = candidates[0]?.id ?? null;
          session = sessionId ? await host.openSession(sessionId) : null;
        }
        if (!session) return;
        await reveal(session.id, { restoreLastActiveRole: true });
      } catch {
        // Boot never fails because a convenience restore could not load a tab.
      }
    });
  };

  const sessionSnapshot = async (
    command: BotBrowserTabCommand & { sessionId: string },
  ): Promise<BotBrowserTabCommandResult> => {
    const role = roleOf(command);
    const snapshot = await listTabs();
    if (!snapshot) throw new Error('Bot Browser tabs are not available.');
    let sessionTab = liveBoundTab(command.sessionId, role, snapshot.tabs);
    if (!sessionTab && role === 'showcase') {
      const lastPage = pageFor(command.sessionId);
      if (lastPage) {
        sessionTab = snapshot.tabs.find((tab) => (
          browserUrisMatch(uriOf(tab), lastPage.uri) && canAdopt(command.sessionId, 'showcase', tab, lastPage.uri)
        )) ?? null;
        if (sessionTab) rememberTab(command.sessionId, 'showcase', sessionTab.id);
      }
    }
    return {
      ...snapshot,
      action: command.action,
      sessionTab,
    };
  };

  const controlSessionTab = (
    command: BotBrowserTabCommand & { sessionId: string },
  ): Promise<BotBrowserTabCommandResult> => enqueue(async () => {
    const role = roleOf(command);
    if (command.action === 'get-tabs' || command.action === 'get-active-tab') {
      return sessionSnapshot(command);
    }
    if (command.action === 'open-tab' || command.action === 'navigate-tab') {
      return ensureSessionTab({
        sessionId: command.sessionId,
        role,
        action: command.action,
        uri: command.uri,
        label: command.label,
        hintTabId: command.tabId,
        activate: command.action === 'open-tab' ? command.activate !== false : command.activate === true,
        matchByUri: command.action === 'open-tab',
        draftClaim: command.draftClaim === true,
      });
    }
    if (command.action === 'switch-tab') {
      // Role activation (host → renderer): reveal the session's stage or
      // showcase tab, but only while that session is the one on screen —
      // never yank the view of a different conversation.
      const open = host?.getOpenSession();
      const empty: BotBrowserTabCommandResult = {
        action: 'switch-tab',
        tabs: [],
        activeTab: null,
        sessionTab: null,
      };
      if (open?.id !== command.sessionId) return empty;
      const snapshot = await listTabs();
      if (!snapshot) throw new Error('Bot Browser tabs are not available.');
      const bound = liveBoundTab(command.sessionId, role, snapshot.tabs);
      if (!bound) return { ...snapshot, action: 'switch-tab', sessionTab: null };
      if (!bound.isActive) {
        const switched = await controlTabs({ action: 'switch-tab', tabId: bound.id });
        if (!switched) throw new Error(`Bot Browser tab ${bound.id} could not be activated.`);
        rememberActiveRole(command.sessionId, role);
        return finish('switch-tab', bound.id, switched);
      }
      rememberActiveRole(command.sessionId, role);
      return { ...snapshot, action: 'switch-tab', sessionTab: bound };
    }
    const result = await controlTabs(command);
    if (!result) throw new Error(`Bot Browser command ${command.action} failed.`);
    return result;
  });

  const adoptCommittedActiveTab = (tabId: number, uri: string, title: string | null): void => {
    globalThis.setTimeout(() => {
      void (async () => {
        if (ownerOfTab(tabId) || pendingDraftTabId === tabId) return;
        // Stage chrome never becomes a session's showcase page.
        if (isLiveStagePageUri(uri)) return;
        const open = host?.getOpenSession();
        if (open?.sessionType !== 'browser' || open.id.startsWith('optimistic-browser-')) return;
        const snapshot = await listTabs();
        const tab = snapshot?.tabs.find((entry) => entry.id === tabId);
        if (!tab?.isActive || ownerOfTab(tabId) || pendingDraftTabId === tabId) return;
        // Adoption never moves an existing binding: only a session with NO
        // bound tab in either role may adopt the active tab, as showcase.
        if (liveBoundTab(open.id, 'stage', snapshot?.tabs ?? [])
          || liveBoundTab(open.id, 'showcase', snapshot?.tabs ?? [])) return;
        rememberTab(open.id, 'showcase', tabId);
        rememberPage(open.id, uri, title);
      })().catch(() => {});
    }, 0);
  };

  const handleBrowserEvent = (message: SessionBrowserEvent): void => {
    if (message?.type !== 'agent-browser:event' || message.version !== 1) return;
    const tabId = Number(message.payload?.tabId);
    if (!Number.isInteger(tabId) || tabId <= 0) return;
    if (message.event === 'tab-closed') {
      for (const [key, binding] of sessionTabs) {
        if (binding.tabId === tabId) {
          sessionTabs.delete(key);
          if (binding.role === 'showcase') rememberActiveRole(binding.sessionId, 'stage');
        }
      }
      for (const [botId, mappedTabId] of botStageTabs) {
        if (mappedTabId === tabId) botStageTabs.delete(botId);
      }
      if (pendingDraftTabId === tabId) pendingDraftTabId = null;
      return;
    }
    const owner = ownerOfTab(tabId);
    if (message.event === 'tab-activated') {
      if (owner) rememberActiveRole(owner.sessionId, owner.role);
      return;
    }
    if (message.event === 'navigation-committed') {
      const uri = String(message.payload?.uri ?? '').trim();
      if (!uri) return;
      const title = String(message.payload?.title ?? '').trim() || null;
      // Only showcase navigations persist a "last page"; stage navigations
      // (entry loads, heal re-projections) are host plumbing.
      if (owner?.role === 'showcase') rememberPage(owner.sessionId, uri, title);
      else if (!owner) adoptCommittedActiveTab(tabId, uri, title);
      return;
    }
    if (!owner || owner.role !== 'showcase') return;
    if (message.event === 'title-updated') {
      const page = pageFor(owner.sessionId);
      if (page) rememberPage(owner.sessionId, page.uri, String(message.payload?.title ?? '').trim() || null);
    }
  };

  return {
    attach: (next) => {
      host = next;
    },
    rememberOpenSession: (sessionId) => {
      savePersistedBrowserSessionId(sessionId);
    },
    prepareDraftTab,
    prepareDraftIdentity,
    bindNewSession,
    revealSessionTab,
    restoreLastSession,
    controlSessionTab,
    handleBrowserEvent,
  };
}

export const sessionTabBinding = createSessionTabBinding();
