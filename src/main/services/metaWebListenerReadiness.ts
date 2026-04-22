import type { ListenerConfig } from './metaWebListenerService';

export interface PrivateChatListenerReadinessInput {
  localGlobalMetaId: string;
  config?: Partial<ListenerConfig>;
  hasSocket: boolean;
  isSocketConnected: boolean;
}

export interface PrivateChatListenerReadinessPlan {
  success: boolean;
  config: ListenerConfig;
  persistConfig: boolean;
  shouldStartListener: boolean;
  shouldWaitForConnection: boolean;
  error?: string;
}

export const normalizeListenerConfig = (stored?: Partial<ListenerConfig>): ListenerConfig => ({
  enabled: stored?.enabled !== undefined ? stored.enabled : true,
  groupChats: stored?.groupChats !== undefined ? stored.groupChats : false,
  privateChats: stored?.privateChats !== undefined ? stored.privateChats : true,
  serviceRequests: stored?.serviceRequests !== undefined ? stored.serviceRequests : false,
});

export const shouldRunListener = (config: ListenerConfig): boolean =>
  config.enabled && (config.groupChats || config.privateChats || config.serviceRequests);

export function planPrivateChatListenerReadiness(
  input: PrivateChatListenerReadinessInput,
): PrivateChatListenerReadinessPlan {
  const localGlobalMetaId = String(input.localGlobalMetaId || '').trim();
  const connected = Boolean(input.isSocketConnected);
  let config = normalizeListenerConfig(input.config);
  let persistConfig = false;

  if (!localGlobalMetaId) {
    return {
      success: false,
      error: 'Local MetaBot globalMetaId is missing',
      config,
      persistConfig,
      shouldStartListener: false,
      shouldWaitForConnection: false,
    };
  }

  if (!config.privateChats || !shouldRunListener(config)) {
    config = normalizeListenerConfig({ ...config, enabled: true, privateChats: true });
    persistConfig = true;
  }

  if (connected) {
    return {
      success: true,
      config,
      persistConfig,
      shouldStartListener: false,
      shouldWaitForConnection: false,
    };
  }

  return {
    success: true,
    config,
    persistConfig,
    // If a socket exists but is disconnected, force a listener restart so
    // handshake requests do not keep timing out on stale sockets.
    shouldStartListener: persistConfig || !input.hasSocket || !connected,
    shouldWaitForConnection: true,
  };
}
