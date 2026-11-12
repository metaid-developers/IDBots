export type BotBrowserTabAction =
  | 'open-tab'
  | 'close-tab'
  | 'switch-tab'
  | 'navigate-tab'
  | 'get-tabs'
  | 'get-active-tab'
  | 'get-content'
  | 'get-tab-info';

export type BotBrowserTabCommand = {
  action: BotBrowserTabAction;
  uri?: string;
  tabId?: number;
  /** Studio session whose live tab should own this command. */
  sessionId?: string;
  /** Display label for a newly opened tab (open-tab only). */
  label?: string;
  /** Keep the target tab active after navigate-tab resolves. */
  activate?: boolean;
  /** Allow a second session to open the same URI in its own tab. */
  dedupe?: boolean;
  /** Renderer-only routing flag: preserve the current app surface. */
  background?: boolean;
};

export type BotBrowserTabInfo = {
  id: number;
  uri: string | null;
  title: string | null;
  isActive: boolean;
};

/** Rendered page content of a tab (ABC getTabContent; empty for opaque MetaApp frames). */
export type BotBrowserTabContent = {
  tabId: number;
  uri: string | null;
  title: string | null;
  contentType: string;
  text: string;
  html: string;
  truncated: boolean;
  extractedAt: number;
};

/** Full resolve envelope of a tab (ABC getTabInfo). */
export type BotBrowserTabEnvelope = BotBrowserTabInfo & {
  current: unknown | null;
};

export type BotBrowserTabCommandResult = {
  action: BotBrowserTabAction;
  openedTabId?: number;
  tabs: BotBrowserTabInfo[];
  activeTab: BotBrowserTabInfo | null;
  /** The tab bound to command.sessionId, independent of the active tab. */
  sessionTab?: BotBrowserTabInfo | null;
  content?: BotBrowserTabContent | null;
  info?: BotBrowserTabEnvelope | null;
};

export type BotBrowserTabCommandResponse = {
  requestId: string;
  success: boolean;
  result?: BotBrowserTabCommandResult;
  error?: string;
};

type BrowserTabBridgeWebContents = {
  isDestroyed(): boolean;
  send(channel: string, payload: unknown): void;
};

type BrowserTabBridgeWindow = {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  isVisible(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
  webContents: BrowserTabBridgeWebContents;
};

type PendingRequest = {
  target: BrowserTabBridgeWebContents;
  resolve(result: BotBrowserTabCommandResult): void;
  reject(error: Error): void;
  timeout: NodeJS.Timeout;
};

export type BotBrowserTabBridge = {
  execute(command: BotBrowserTabCommand, opts?: { focusWindow?: boolean }): Promise<BotBrowserTabCommandResult>;
  handleResponse(
    source: BrowserTabBridgeWebContents,
    response: BotBrowserTabCommandResponse,
  ): void;
  dispose(): void;
};

export function createBotBrowserTabBridge(options: {
  getWindows(): BrowserTabBridgeWindow[];
  timeoutMs?: number;
}): BotBrowserTabBridge {
  const pending = new Map<string, PendingRequest>();
  const timeoutMs = options.timeoutMs ?? 10_000;
  let requestSequence = 0;
  let disposed = false;

  const execute = (command: BotBrowserTabCommand, opts?: { focusWindow?: boolean }): Promise<BotBrowserTabCommandResult> => {
    if (disposed) {
      return Promise.reject(new Error('Bot Browser tab bridge is disposed'));
    }

    const targetWindow = options.getWindows().find((window) => (
      !window.isDestroyed() && !window.webContents.isDestroyed()
    ));
    if (!targetWindow) {
      return Promise.reject(new Error('No IDBots window is available to control Bot Browser tabs'));
    }

    const requestId = `bot-browser-tab-${Date.now()}-${++requestSequence}`;
    const promise = new Promise<BotBrowserTabCommandResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error('Bot Browser tab command timed out'));
      }, timeoutMs);
      pending.set(requestId, {
        target: targetWindow.webContents,
        resolve,
        reject,
        timeout,
      });
    });

    try {
      // desktop-only: addressed to a specific window (not a broadcast).
      // focusWindow:false preserves the current app surface even when the
      // command activates a tab inside Studio.
      targetWindow.webContents.send('botBrowser:tab-command', {
        requestId,
        command: {
          ...command,
          background: opts?.focusWindow === false,
        },
      });
      // Background writes (Bot Internet projections into a non-active tab)
      // pass focusWindow: false so they never steal the OS focus.
      if (opts?.focusWindow !== false) {
        if (targetWindow.isMinimized()) targetWindow.restore();
        if (!targetWindow.isVisible()) targetWindow.show();
        targetWindow.focus();
      }
    } catch (error) {
      const request = pending.get(requestId);
      if (request) {
        clearTimeout(request.timeout);
        pending.delete(requestId);
        request.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }

    return promise;
  };

  const handleResponse = (
    source: BrowserTabBridgeWebContents,
    response: BotBrowserTabCommandResponse,
  ): void => {
    const requestId = String(response?.requestId ?? '').trim();
    if (!requestId) return;
    const request = pending.get(requestId);
    if (!request || request.target !== source) return;

    clearTimeout(request.timeout);
    pending.delete(requestId);
    if (!response.success || !response.result) {
      request.reject(new Error(String(response.error || 'Bot Browser tab command failed')));
      return;
    }
    request.resolve(response.result);
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    for (const request of pending.values()) {
      clearTimeout(request.timeout);
      request.reject(new Error('Bot Browser tab bridge was closed'));
    }
    pending.clear();
  };

  return { execute, handleResponse, dispose };
}
