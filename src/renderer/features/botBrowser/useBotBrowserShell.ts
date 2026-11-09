import { useCallback, useRef, useState } from 'react';
import type { Metabot } from '../../types/metabot';
import type { MetaAppRecord } from '../../types/metaApp';
import {
  buildBotPageBrowserUri,
  buildLocalMetabotActorId,
} from './botBrowserIntent.js';
import {
  buildMetaAppBrowserUri,
  canOpenMetaAppInBrowser,
} from '../../components/metaapps/metaAppLaunch.js';
import { SURFACE_MODE_CHANGE_EVENT } from '../../hooks/chatExperienceModeSource';
import type {
  BotBrowserOpenUriInput,
  BotBrowserSurfaceHandle,
  BotBrowserSurfaceMode,
  BotBrowserTabCommand,
  BotBrowserTabCommandResult,
  BotInternetPane,
} from './types';

// Daily twin interaction lives on the Bot Internet surface (owner ruling
// 2026-11-08): it is the app's default landing surface, while Bot Home stays
// the full professional harness. The last explicit choice is remembered across
// restarts; machines without that stored value still land on Bot Internet.
// This slot is ALSO the chat experience mode's source of truth since the
// 2026-11-09 surface ruling (hooks/chatExperienceModeSource.ts) — the Settings
// toggle is retired.
const SURFACE_MODE_STORAGE_KEY = 'idbots.botBrowser.surfaceMode';
const readStoredSurfaceMode = (): BotBrowserSurfaceMode => {
  try {
    const stored = window.localStorage.getItem(SURFACE_MODE_STORAGE_KEY);
    return stored === 'home' || stored === 'browser' ? stored : 'browser';
  } catch {
    return 'browser';
  }
};
const writeStoredSurfaceMode = (mode: BotBrowserSurfaceMode) => {
  try {
    window.localStorage.setItem(SURFACE_MODE_STORAGE_KEY, mode);
  } catch {
    // localStorage unavailable: the choice just stays this session's.
  }
};

interface UseBotBrowserShellInput {
  showToast: (message: string) => void;
}

export function useBotBrowserShell(input: UseBotBrowserShellInput) {
  const { showToast } = input;
  const browserRef = useRef<BotBrowserSurfaceHandle | null>(null);
  const pendingOpenUriRef = useRef<BotBrowserOpenUriInput | null>(null);
  const [surfaceMode, setSurfaceModeState] = useState<BotBrowserSurfaceMode>(readStoredSurfaceMode);
  const setSurfaceMode = useCallback((mode: BotBrowserSurfaceMode) => {
    writeStoredSurfaceMode(mode);
    setSurfaceModeState(mode);
    // Announce the face change in-window (cross-window listeners get the
    // native `storage` event from the write above). The chat experience mode
    // derives from this slot — see hooks/chatExperienceModeSource.ts — so the
    // announcement is what keeps live consumers honest across switches.
    try {
      window.dispatchEvent(new CustomEvent(SURFACE_MODE_CHANGE_EVENT, { detail: mode }));
    } catch {
      // No window (static tests): nothing to announce to.
    }
  }, []);
  const [internetPane, setInternetPane] = useState<BotInternetPane>('browser');
  const [hasMountedBrowser, setHasMountedBrowser] = useState(true);

  const messageFromError = (error: unknown, fallback: string): string => {
    if (error instanceof Error && error.message) return error.message;
    if (typeof error === 'string' && error.trim()) return error;
    return fallback;
  };

  const ensureBrowserActorAvailable = useCallback(async (): Promise<boolean> => {
    try {
      const result = await window.electron.metabot.list();
      if (!result?.success) {
        showToast(messageFromError(result?.error, 'Failed to load local Bots.'));
        return false;
      }

      if (Array.isArray(result.list) && result.list.length > 0) {
        return true;
      }

      // No local Bot: the registered human identity may still act as the
      // default Actor, so the Browser stays usable (no forced Bot creation).
      const identity = await window.electron.userIdentity.get();
      if (identity?.success && identity.identity?.globalmetaid) {
        return true;
      }

      showToast('No local Actor. Set up your identity or create a Bot first.');
      return false;
    } catch (error) {
      showToast(messageFromError(error, 'Failed to load local Bots.'));
      return false;
    }
  }, [showToast]);

  const showBrowser = useCallback(async (): Promise<boolean> => {
    if (!await ensureBrowserActorAvailable()) return false;
    setHasMountedBrowser(true);
    setSurfaceMode('browser');
    setInternetPane('browser');
    return true;
  }, [ensureBrowserActorAvailable]);

  const openUriWhenBrowserReady = useCallback((input: BotBrowserOpenUriInput) => {
    pendingOpenUriRef.current = input;
    if (!browserRef.current || !pendingOpenUriRef.current) return;
    const pending = pendingOpenUriRef.current;
    pendingOpenUriRef.current = null;
    void browserRef.current.openUri(pending);
  }, []);

  const onBrowserReady = useCallback(() => {
    if (!pendingOpenUriRef.current || !browserRef.current) return;
    const pending = pendingOpenUriRef.current;
    pendingOpenUriRef.current = null;
    void browserRef.current.openUri(pending);
  }, []);

  const openBrowserHome = useCallback(async () => {
    setHasMountedBrowser(true);
    setSurfaceMode('browser');
    setInternetPane('browser');
  }, []);

  const selectInternetPane = useCallback((pane: BotInternetPane) => {
    setHasMountedBrowser(true);
    setSurfaceMode('browser');
    setInternetPane(pane);
  }, []);

  const waitForBrowserSurface = useCallback(async (): Promise<BotBrowserSurfaceHandle> => {
    const deadline = Date.now() + 5_000;
    while (!browserRef.current && Date.now() < deadline) {
      await new Promise((resolve) => window.setTimeout(resolve, 25));
    }
    if (!browserRef.current) {
      throw new Error('Bot Browser surface is not available.');
    }
    return browserRef.current;
  }, []);

  const controlTabs = useCallback(async (
    command: BotBrowserTabCommand,
  ): Promise<BotBrowserTabCommandResult> => {
    setHasMountedBrowser(true);
    setSurfaceMode('browser');
    setInternetPane('browser');
    const browser = await waitForBrowserSurface();
    return browser.controlTabs(command);
  }, [waitForBrowserSurface]);

  const openNewTab = useCallback(async () => {
    await controlTabs({ action: 'open-tab' });
  }, [controlTabs]);

  const openLocalMetabot = useCallback(async (metabot: Metabot) => {
    const globalMetaId = metabot.globalmetaid?.trim() || '';
    const uri = buildBotPageBrowserUri(globalMetaId);
    const actorId = buildLocalMetabotActorId(metabot.id);
    if (!uri || !actorId) {
      showToast('This Bot does not have a valid GlobalMetaID.');
      return;
    }
    if (!await showBrowser()) return;
    openUriWhenBrowserReady({ uri, actorId, newTab: true });
  }, [openUriWhenBrowserReady, showBrowser, showToast]);

  const openRemoteBot = useCallback(async (target: { globalMetaId: string }) => {
    const uri = buildBotPageBrowserUri(target.globalMetaId);
    if (!uri) {
      showToast('Remote Bot GlobalMetaID is missing.');
      return;
    }
    if (!await showBrowser()) return;
    openUriWhenBrowserReady({ uri, newTab: true });
  }, [openUriWhenBrowserReady, showBrowser, showToast]);

  const openUri = useCallback(async (input: BotBrowserOpenUriInput) => {
    const uri = String(input?.uri ?? '').trim();
    const actorId = typeof input?.actorId === 'string' && input.actorId.trim()
      ? input.actorId.trim()
      : null;
    const newTab = input?.newTab === true;
    if (!uri) {
      showToast('Bot Browser URI is missing.');
      return;
    }
    if (!await showBrowser()) return;
    openUriWhenBrowserReady({ uri, actorId, newTab });
  }, [openUriWhenBrowserReady, showBrowser, showToast]);

  const openMetaApp = useCallback(async (app: MetaAppRecord): Promise<boolean> => {
    if (!canOpenMetaAppInBrowser(app)) {
      return false;
    }

    const uri = buildMetaAppBrowserUri(app);
    if (!uri) {
      return false;
    }

    if (!await showBrowser()) return true;
    openUriWhenBrowserReady({ uri, newTab: true });
    return true;
  }, [openUriWhenBrowserReady, showBrowser]);

  /** Open a MetaApp in the browser by its bare pin id (no local MetaAppRecord required). */
  const openMetaAppByPin = useCallback(async (pin: string): Promise<boolean> => {
    const normalized = String(pin ?? '').trim().toLowerCase();
    if (!normalized) return false;
    const uri = `metaapp://${encodeURIComponent(normalized)}`;
    if (!await showBrowser()) return true;
    openUriWhenBrowserReady({ uri, newTab: true });
    return true;
  }, [openUriWhenBrowserReady, showBrowser]);

  const switchToHome = useCallback(() => {
    setSurfaceMode('home');
  }, []);

  return {
    browserRef,
    surfaceMode,
    internetPane,
    isBrowserPaneVisible: surfaceMode === 'browser' && internetPane === 'browser',
    hasMountedBrowser,
    onBrowserReady,
    openBrowserHome,
    selectInternetPane,
    openNewTab,
    controlTabs,
    openLocalMetabot,
    openRemoteBot,
    openUri,
    openMetaApp,
    openMetaAppByPin,
    switchToHome,
  };
}
