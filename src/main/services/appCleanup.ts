export interface AppCleanupDeps {
  destroyTray: () => void;
  stopSkillWatching: () => void;
  closeMetaidRpcServer: () => void;
  stopCoworkSessions: () => void;
  stopOpenAICompatProxy: () => Promise<void>;
  stopSkillServices: () => Promise<void>;
  stopIMGateways: () => Promise<void>;
  stopScheduler: () => void;
  stopCognitiveOrchestrator: () => void;
  stopP2P: () => Promise<void>;
  stopHeartbeatServices: () => void;
  deactivateGroupChatTasks: () => void;
  log: (message: string) => void;
  error: (message: string, error: unknown) => void;
}

export async function runAppCleanup(deps: AppCleanupDeps): Promise<void> {
  deps.log('[Main] App is quitting, starting cleanup...');
  deps.destroyTray();
  deps.stopSkillWatching();
  deps.closeMetaidRpcServer();
  deps.stopCoworkSessions();

  await deps.stopOpenAICompatProxy().catch((error) => {
    deps.error('Failed to stop OpenAI compatibility proxy:', error);
  });

  await deps.stopSkillServices().catch((error) => {
    deps.error('[SkillServices] Error stopping services on quit:', error);
  });

  await deps.stopIMGateways().catch((error) => {
    deps.error('[IM Gateway] Error stopping gateways on quit:', error);
  });

  await deps.stopP2P().catch((error) => {
    deps.error('[p2p] Error stopping local indexer on quit:', error);
  });

  deps.stopScheduler();
  deps.stopCognitiveOrchestrator();
  deps.stopHeartbeatServices();
  deps.deactivateGroupChatTasks();
}
