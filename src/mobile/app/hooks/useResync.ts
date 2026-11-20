import { useEffect, useRef, useState } from 'react';
import type { CoworkSession } from '@/types/cowork';
import type {
  CoworkResyncGuard,
  CoworkResyncSnapshot,
  PendingPermissionEntry,
} from '@/services/coworkSessionController';
import type { MockElectronAPI } from '../../bridge/types';
import { getAppBridge, getMobileElectron, hasAppBridge } from '../appBridge';
import type { AppBridge } from '../appBridge';
import { getNativeAdapter } from '../../native/nativeAdapter';

export type ResyncSnapshot = CoworkResyncSnapshot;

export interface ResyncContextSource {
  getOpenSessionId: () => string | null;
  getStreamingMessage: () => { sessionId: string; messageId: string } | null;
  beginResync?: () => CoworkResyncGuard;
}

export function findResyncStream(
  session: CoworkSession | null,
  fallback: { sessionId: string; messageId: string } | null,
): { sessionId: string; messageId: string } | null {
  if (!session) return fallback;
  for (let index = session.messages.length - 1; index >= 0; index -= 1) {
    const message = session.messages[index]!;
    if (message.type === 'assistant' && message.metadata?.isStreaming) {
      return { sessionId: session.id, messageId: message.id };
    }
  }
  if (session.status !== 'running') return null;
  for (let index = session.messages.length - 1; index >= 0; index -= 1) {
    const message = session.messages[index]!;
    if (message.type === 'assistant' && !message.metadata?.isFinal) {
      return { sessionId: session.id, messageId: message.id };
    }
  }
  return fallback?.sessionId === session.id ? fallback : null;
}

/**
 * The ordered resync sequence itself, exported for tests: a fake electron
 * records the invoke order. Each step tolerates individual failures (the
 * socket may drop again mid-resync) so one bad invoke never aborts the rest.
 */
export async function performResync(
  electron: Pick<MockElectronAPI, 'cowork' | 'mobile'>,
  context: ResyncContextSource,
): Promise<ResyncSnapshot> {
  const guard = context.beginResync?.();
  let session: CoworkSession | null = null;
  const sessionId = context.getOpenSessionId();
  if (sessionId) {
    try {
      const result = await electron.cowork.getSession(sessionId, { messageLimit: 200 });
      if (result?.success && result.session) {
        session = result.session as CoworkSession;
      }
    } catch {
      // Keep the current transcript while the connection is unavailable.
    }
  }

  let liveContent: ResyncSnapshot['liveContent'] = null;
  const streaming = findResyncStream(session, context.getStreamingMessage());
  if (streaming) {
    try {
      const live = await electron.cowork.getStreamLiveContent(streaming);
      if (live?.success && typeof live.content === 'string') {
        liveContent = { ...streaming, content: live.content };
      }
    } catch {
      // The next stream event or reconnect retries this heal.
    }
  }

  let pendingPermissions: PendingPermissionEntry[] = [];
  try {
    const pending = await electron.mobile.listPendingPermissions();
    if (Array.isArray(pending)) {
      pendingPermissions = pending as PendingPermissionEntry[];
    }
  } catch {
    // Permission surfacing retries on the next reconnect.
  }

  return { session, liveContent, pendingPermissions, ...(guard ? { guard } : {}) };
}

export function recoverNativeAppState(
  active: boolean,
  bridge: Pick<AppBridge, 'connection' | 'gateway'>,
  resync: () => void,
): void {
  if (!active) return;
  const wasOnline = bridge.connection.getState() === 'online';
  bridge.gateway?.reconnectNow();
  if (wasOnline) resync();
}

/**
 * Subscribes to whichever bridge is active and runs the resync sequence on
 * every (re)connect. `onSnapshot` (useChat.applyResync) consumes steps 1–3
 * for the open chat; the returned counter (step 4) is the dependency the
 * tasks/meters/me hooks use to refresh their lists.
 */
export function useResync(
  context: ResyncContextSource,
  onSnapshot: (snapshot: ResyncSnapshot) => void,
): number {
  const [resyncCounter, setResyncCounter] = useState(0);
  // Latest-ref pattern: the shell passes fresh closures every render and the
  // long-lived subscription must always call the current ones.
  const contextRef = useRef(context);
  const onSnapshotRef = useRef(onSnapshot);
  contextRef.current = context;
  onSnapshotRef.current = onSnapshot;
  const runningRef = useRef(false);
  const runAgainRef = useRef(false);

  useEffect(() => {
    if (!hasAppBridge()) return undefined;
    const bridge = getAppBridge();
    let disposed = false;

    const run = async (): Promise<void> => {
      if (runningRef.current) {
        // A resync is already in flight (reconnect storm): schedule one more.
        runAgainRef.current = true;
        return;
      }
      runningRef.current = true;
      try {
        const snapshot = await performResync(getMobileElectron(), contextRef.current);
        if (disposed) return;
        onSnapshotRef.current(snapshot);
        // Step 4: list refresh for the screens' hooks.
        setResyncCounter((counter) => counter + 1);
      } finally {
        runningRef.current = false;
        if (runAgainRef.current && !disposed) {
          runAgainRef.current = false;
          void run();
        }
      }
    };

    let offReconnect: () => void;
    if (bridge.gateway) {
      offReconnect = bridge.gateway.onReconnected(() => void run());
    } else {
      // Mock bridge: only a transition back to online from a non-online state
      // counts as a reconnect (the initial 'online' fires no event).
      let previous = bridge.connection.getState();
      offReconnect = bridge.connection.onChange((state) => {
        const wasNonOnline = previous !== 'online';
        previous = state;
        if (state === 'online' && wasNonOnline) {
          void run();
        }
      });
    }
    const offAppState = getNativeAdapter().onAppStateChange((active) => {
      if (!disposed) recoverNativeAppState(active, bridge, () => void run());
    });
    return () => {
      disposed = true;
      offReconnect();
      offAppState();
    };
  }, []);

  return resyncCounter;
}
