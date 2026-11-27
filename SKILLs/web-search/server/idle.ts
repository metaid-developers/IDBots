/**
 * Idle exit policy for the bridge server.
 *
 * The server is a whole Node process with Playwright loaded — about 95 MiB on
 * the tenant image before a single search — and the Chromium it launches for a
 * search outlives that search: only stopping the server closes it. On a cloud
 * tenant, where one machine hosts every user, an always-on bridge is memory
 * nobody is using. There the server exits by itself after a quiet period. The
 * skill's search.sh health-checks before every request and starts the bridge
 * again when it is gone, so the price of having exited is one start-up on the
 * first search after a pause.
 *
 * Desktop keeps the always-on bridge. Its QEMU skill sandbox can only reach a
 * server the app started on the host (10.0.2.2:8923), so there the bridge must
 * never disappear.
 */

/**
 * Ten minutes, matching the DSH runtime's idle TTL in server mode
 * (DSH_RUNTIME_IDLE_TTL_SERVER_MS): once a conversation has been quiet this
 * long its runtime is gone too, and the next turn starts the skill afresh
 * either way.
 */
export const DEFAULT_IDLE_EXIT_MS = 10 * 60_000;

/**
 * `WEB_SEARCH_IDLE_EXIT_MS` wins when set (`0` disables it). Otherwise server
 * mode (`IDBOTS_SERVER_MODE=1`) exits after ten idle minutes and desktop never
 * does. A value that does not parse disables the exit rather than guessing.
 */
export function resolveIdleExitMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.WEB_SEARCH_IDLE_EXIT_MS?.trim();
  if (raw) {
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
  }
  return env.IDBOTS_SERVER_MODE === '1' ? DEFAULT_IDLE_EXIT_MS : 0;
}

/** True when the exit is enabled, nothing is being served, and the last
 *  activity is at least `idleExitMs` old. */
export function isIdle(
  now: number,
  lastActivityAt: number,
  inFlight: number,
  idleExitMs: number,
): boolean {
  return idleExitMs > 0 && inFlight === 0 && now - lastActivityAt >= idleExitMs;
}
