export interface AppCleanupDeps {
  destroyTray: () => void;
  stopSkillWatching: () => void;
  closeMetaidRpcServer: () => void;
  stopCoworkSessions: () => void;
  /**
   * Dream review P3: drain the write-behind hot-layer exposure buffer so the
   * last turns' telemetry rows land before the database closes. Optional so
   * older cleanup callers still type-check. */
  flushHotLayerExposures?: () => void;
  /**
   * Session-log guard (T-C): before the DSH runtime drains, flush and verify
   * the first-frame invariant of every active session log. Read-only on the
   * files (fsync only). Optional so older cleanup callers still type-check.
   */
  guardSessionLogs?: () => Promise<void>;
  /** Drain every DSH runtime subprocess. Optional so older cleanup
   *  callers that only stop cowork sessions still type-check. */
  closeDshRuntime?: () => Promise<void>;
  /** Polling daemons that keep launching cowork/LLM turns. They must stop
   *  BEFORE the DSH runtime closes — otherwise their in-window turns crash
   *  with `DshKernel: closed` (the 2026-09-12 mass A2A session 'error'
   *  incident). Optional so older cleanup callers still type-check. */
  stopPrivateChatDaemon?: () => Promise<void> | void;
  stopGroupTaskDaemon?: () => void;
  stopOpenTeamGuestDaemon?: () => void;
  stopOpenAICompatProxy: () => Promise<void>;
  /** Loopback web-tools proxy the DSH runtimes search through; stopped after
   *  the runtime closes (optional so older cleanup callers still type-check). */
  stopWebToolsProxy?: () => Promise<void>;
  stopSkillServices: () => Promise<void>;
  stopIMGateways: () => Promise<void>;
  stopScheduler: () => void;
  stopCognitiveOrchestrator: () => void;
  stopDreamService: () => void;
  /** Optional so older cleanup callers that predate the hygiene service still type-check. */
  stopMemoryHygieneService?: () => void;
  stopProviderDiscovery: () => void;
  /** Drop a pending coalesced MetaTask sweep timer (optional: older callers). */
  stopMetaTaskSweeps?: () => void;
  deactivateGroupChatTasks: () => void;
  log: (message: string) => void;
  error: (message: string, error: unknown) => void;
}

export async function runAppCleanup(deps: AppCleanupDeps): Promise<void> {
  deps.log('[Main] App is quitting, starting cleanup...');
  // Turn-generating loops first: no new scheduled/orchestrated/chat turns may
  // start once cowork sessions and the DSH runtime begin tearing down.
  await Promise.resolve(deps.stopPrivateChatDaemon?.()).catch((error: unknown) => {
    deps.error('[PrivateChat] Error stopping daemon on quit:', error);
  });
  deps.stopGroupTaskDaemon?.();
  deps.stopOpenTeamGuestDaemon?.();
  deps.stopScheduler();
  deps.stopCognitiveOrchestrator();
  deps.destroyTray();
  deps.stopSkillWatching();
  deps.closeMetaidRpcServer();
  deps.stopCoworkSessions();
  // Dream review P3: last turns may still hold buffered exposure telemetry.
  try {
    deps.flushHotLayerExposures?.();
  } catch (error) {
    deps.error('Failed to flush hot-layer exposure buffer:', error);
  }
  // T-C: session logs are flushed and first-frame-verified BEFORE the runtime
  // drains. The 2026-10-19 incident left 0-byte and header-less artifacts with
  // mtimes on this exact instant; the guard cannot prevent every truncation,
  // but it makes one durable and visible instead of silent. Read-only: a
  // failed check logs, never rewrites.
  //
  // The guard shares the quit watchdog's 5s budget with closeDshRuntime; on a
  // slow disk / AV scan its per-session stat+fsync+read-back sequence could
  // crowd the runtime close past the watchdog — forcing the exit into exactly
  // the truncation class the guard exists to prevent. Bound the guard itself:
  // past ~1.5s, draining the runtime matters more than one more fsync, and
  // the startup invariant scan re-checks whatever the quit guard missed.
  const SESSION_LOG_GUARD_DEADLINE_MS = 1_500;
  await Promise.race([
    deps.guardSessionLogs?.().catch((error) => {
      deps.error('[SessionLogGuard] Quit-time session-log guard failed:', error);
    }) ?? Promise.resolve(),
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, SESSION_LOG_GUARD_DEADLINE_MS);
      timer.unref?.();
    }),
  ]);

  await deps.closeDshRuntime?.().catch((error) => {
    deps.error('Failed to close DSH runtime:', error);
  });

  await deps.stopWebToolsProxy?.().catch((error) => {
    deps.error('Failed to stop the DSH web-tools proxy:', error);
  });

  await deps.stopOpenAICompatProxy().catch((error) => {
    deps.error('Failed to stop OpenAI compatibility proxy:', error);
  });

  await deps.stopSkillServices().catch((error) => {
    deps.error('[SkillServices] Error stopping services on quit:', error);
  });

  await deps.stopIMGateways().catch((error) => {
    deps.error('[IM Gateway] Error stopping gateways on quit:', error);
  });

  deps.stopDreamService();
  deps.stopMemoryHygieneService?.();
  deps.stopProviderDiscovery();
  deps.stopMetaTaskSweeps?.();
  deps.deactivateGroupChatTasks();
}
