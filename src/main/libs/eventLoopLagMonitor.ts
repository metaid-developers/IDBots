/**
 * Main-process event-loop lag monitor (2026-10-16 first-sentence latency
 * work). Two production sessions (bd646510/c3419940) showed every bounded
 * cerebellum call settling ~14s past its own abort deadline, in the same
 * millisecond, after a total cowork.log silence — the signature of the
 * Electron main process being starved/blocked so setTimeout callbacks fire
 * late. JS-level budgets are defenseless against that, so the next
 * occurrence must at least be CAUGHT: this timer measures its own drift and
 * logs a WARN bracketing any stall window, giving the triage a liveness
 * timeline instead of a silent gap.
 *
 * 2026-11-03 stall forensics (session e2f359d7, 17-21s lags all day): the
 * root cause turned out to be HOST memory pressure, not in-process work — the
 * machine ran with ~14GB of swap in use, the kernel's memorystatus was
 * idle-killing daemons inside the stall windows, and a live sampling run of
 * the main process during healthy turns never caught the main thread busy
 * (always idle in mach_msg). So each WARN now carries memory diagnostics:
 * rss/heapUsed deltas across the stall (a big rss DROP means the OS paged the
 * process out and the loop starved on the page-in storm) plus system free
 * memory. The hint text names the swap signature explicitly when the lag is
 * ≥10s, so the next triage starts from evidence instead of archaeology.
 */

import os from 'node:os';

import { coworkLog } from './coworkLogger';

const LAG_MONITOR_INTERVAL_MS = 1000;
/** Drift below this is ordinary scheduling jitter; at or above it, log. */
const LAG_MONITOR_WARN_THRESHOLD_MS = 2000;
/** Lags at or above this carry the swap-pressure hint (2026-11-03 pattern). */
const LAG_MONITOR_SWAP_HINT_THRESHOLD_MS = 10_000;

let monitorStarted = false;

/**
 * Start the drift monitor once per process. The timer is unref'd so it never
 * holds the process open, and intentionally cheap on the healthy path: one
 * Date.now() diff per second; memory diagnostics are only read on the WARN
 * path.
 */
export function startEventLoopLagMonitor(): void {
  if (monitorStarted) return;
  monitorStarted = true;
  let lastTickAt = Date.now();
  let lastRss = process.memoryUsage().rss;
  const timer = setInterval(() => {
    const now = Date.now();
    const lagMs = now - lastTickAt - LAG_MONITOR_INTERVAL_MS;
    lastTickAt = now;
    if (lagMs >= LAG_MONITOR_WARN_THRESHOLD_MS) {
      const mem = process.memoryUsage();
      const rssDeltaMB = Math.round((mem.rss - lastRss) / 1024 / 1024);
      coworkLog('WARN', 'eventloop:lag',
        lagMs >= LAG_MONITOR_SWAP_HINT_THRESHOLD_MS
          ? 'Main-process event loop stalled; every in-process timer (cerebellum abort budgets, turn races) fired late by the same amount. Lags of this size on this host have matched system memory pressure / swap thrash (kernel memorystatus episodes) — check vm.swapusage and other apps before suspecting in-process work.'
          : 'Main-process event loop stalled; every in-process timer (cerebellum abort budgets, turn races) fired late by the same amount',
        {
          lagMs,
          rssMB: Math.round(mem.rss / 1024 / 1024),
          rssDeltaMB,
          heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
          sysFreeMB: Math.round(os.freemem() / 1024 / 1024),
        });
    }
    lastRss = process.memoryUsage().rss;
  }, LAG_MONITOR_INTERVAL_MS);
  timer.unref?.();
}
