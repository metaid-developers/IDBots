/**
 * Main-process renderer-hang watchdog (2026-10-30 WTL follow-up).
 *
 * `render-process-gone` covers a renderer that CRASHED. It says nothing about
 * one that is alive but wedged: on 2026-10-30 a renderer sat at 100% CPU for
 * 34 hours inside a page loop while the app stayed up and the log stayed
 * silent. The owner found out only because his Mac felt slow, and a restart
 * fixed it. The whole cost of that bug landed on his attention.
 *
 * This monitor is deliberately NOTIFY-ONLY. It samples renderer ('Tab')
 * process CPU from app.getAppMetrics() on a cheap, unref'd interval, decides
 * from the sample series, and calls the injected reporter at most ONCE per
 * sustained episode. It never reloads, kills, or otherwise touches the
 * renderer: self-healing would hide the failure mode, while one explicit WARN
 * turns the next occurrence into a triage instead of a mystery.
 *
 * CPU is measured as percent-of-one-core from `cumulativeCPUUsage` deltas,
 * not from `percentCPUUsage`: measured on Electron 41.10.5 / macOS with 12
 * logical cores, a renderer burning exactly one core (99.9% by cumulative
 * delta) reports 8.33% in `percentCPUUsage` because that field is normalized
 * to total machine capacity. A threshold on the normalized field would be
 * unreachable for exactly the single-threaded page loop that caused the
 * 34-hour spin. See createRendererCpuCollector.
 *
 * The decision core (`evaluateRendererHang`) has no Electron dependency, so a
 * fabricated sample series can exercise it in both directions.
 */

export interface RendererCpuSample {
  /** Epoch ms when the sample was taken. */
  at: number;
  /** CPU of the busiest renderer as percent-of-one-core at `at` (may exceed 100). */
  cpuPercent: number;
}

export type RendererHangReason =
  | 'no-samples'
  | 'stale-samples'
  | 'below-threshold'
  | 'sustained-window-incomplete'
  | 'already-reported'
  | 'hang';

export interface RendererHangEvaluationInput {
  /** Samples already collected, in any order; garbage entries are ignored. */
  samples: readonly RendererCpuSample[];
  /** Epoch ms of the current decision. */
  now: number;
  /** At or above this percentage counts as high CPU (boundary inclusive). */
  cpuThresholdPct: number;
  /** How long the at/above-threshold run must last before it is a hang. */
  sustainedMs: number;
  /** Longest tolerated gap between samples; older evidence is not usable. */
  hangThresholdMs: number;
  /** Epoch ms of the last report for the current episode, or null/absent. */
  lastRaisedAtMs?: number | null;
}

export interface RendererHangEvaluation {
  hang: boolean;
  reason: RendererHangReason;
  /** CPU of the newest usable sample (null when the series has none). */
  cpuPercent: number | null;
  /** Length of the current uninterrupted at/above-threshold run. */
  sustainedForMs: number;
  /** Start of that run (null when there is no run). */
  runStartAtMs: number | null;
}

export interface RendererHangPayload {
  cpuPercent: number;
  sustainedMs: number;
  at: number;
}

/** Defaults chosen for a desk-side app, not a server: a 10-minute spin is already pathological. */
export const RENDERER_HANG_DEFAULTS = {
  cpuThresholdPct: 80,
  sustainedMs: 10 * 60 * 1000,
  hangThresholdMs: 60 * 1000,
  sampleIntervalMs: 30 * 1000,
} as const;

const emptyEvaluation = (reason: RendererHangReason, cpuPercent: number | null = null): RendererHangEvaluation => ({
  hang: false,
  reason,
  cpuPercent,
  sustainedForMs: 0,
  runStartAtMs: null,
});

/**
 * Decide whether the collected series describes a renderer hang.
 *
 * The sustained window is measured to the NEWEST SAMPLE, never to `now`: time
 * the watchdog did not observe must not count toward the threshold. A
 * below-threshold sample OR a gap longer than `hangThresholdMs` starts a new
 * run at the newer sample, so neither a dip nor an unobserved gap can be
 * stitched into a false 10-minute run.
 */
export function evaluateRendererHang(input: RendererHangEvaluationInput): RendererHangEvaluation {
  const { now, cpuThresholdPct, sustainedMs, hangThresholdMs } = input;
  const lastRaisedAtMs =
    typeof input.lastRaisedAtMs === 'number' && Number.isFinite(input.lastRaisedAtMs) && input.lastRaisedAtMs >= 0
      ? input.lastRaisedAtMs
      : null;

  const valid = input.samples
    .filter((sample): sample is RendererCpuSample => {
      if (!sample || typeof sample !== 'object') return false;
      return (
        Number.isFinite(sample.at) &&
        Number.isFinite(sample.cpuPercent) &&
        sample.at <= now &&
        sample.cpuPercent >= 0
      );
    })
    .sort((left, right) => left.at - right.at);

  if (valid.length === 0) return emptyEvaluation('no-samples');

  const latest = valid[valid.length - 1];
  if (now - latest.at > hangThresholdMs) return emptyEvaluation('stale-samples', latest.cpuPercent);

  if (latest.cpuPercent < cpuThresholdPct) return emptyEvaluation('below-threshold', latest.cpuPercent);

  let runStartAtMs = latest.at;
  for (let index = valid.length - 1; index > 0; index -= 1) {
    const newer = valid[index];
    const older = valid[index - 1];
    if (newer.at - older.at > hangThresholdMs) break;
    if (older.cpuPercent < cpuThresholdPct) break;
    runStartAtMs = older.at;
  }
  const sustainedForMs = latest.at - runStartAtMs;

  if (sustainedForMs < sustainedMs) {
    return { hang: false, reason: 'sustained-window-incomplete', cpuPercent: latest.cpuPercent, sustainedForMs, runStartAtMs };
  }

  // One report per episode: the episode is over only once a below-threshold
  // sample was actually OBSERVED after the previous report. A gap or a pruned
  // history is not evidence of recovery, so it must not re-arm the WARN (a
  // retention boundary would otherwise look like a brand-new run).
  const clearedSinceLastRaise =
    lastRaisedAtMs !== null &&
    valid.some((sample) => sample.at > lastRaisedAtMs && sample.cpuPercent < cpuThresholdPct);
  if (lastRaisedAtMs !== null && !clearedSinceLastRaise) {
    return { hang: false, reason: 'already-reported', cpuPercent: latest.cpuPercent, sustainedForMs, runStartAtMs };
  }

  return { hang: true, reason: 'hang', cpuPercent: latest.cpuPercent, sustainedForMs, runStartAtMs };
}

/** Structural subset of Electron's ProcessMetric that this module needs. */
export interface RendererProcessMetricLike {
  pid?: number;
  type?: string;
  cpu?: { percentCPUUsage?: number; cumulativeCPUUsage?: number };
}

export interface RendererCpuCollector {
  /**
   * Convert one app.getAppMetrics() snapshot taken at `at` into the busiest
   * renderer's CPU as percent-of-one-core, or null when no renderer can be
   * measured this tick (first sighting of every renderer sets its baseline).
   */
  read(metrics: readonly RendererProcessMetricLike[] | null | undefined, at: number): number | null;
}

/**
 * Per-core renderer CPU from `cumulativeCPUUsage` deltas.
 *
 * Deliberately NOT `percentCPUUsage`: on this macOS build (Electron 41.10.5,
 * 12 logical cores) a real renderer burning exactly one core measured 8.33%
 * there — the field is normalized to total machine capacity (99.9% of one
 * core, divided by 12). An 80% threshold on that field would be unreachable
 * for the single-threaded page loop that caused the 34-hour spin, leaving the
 * watchdog blind to the very failure it exists for. The cumulative delta over
 * wall time gives percent-of-one-core on any core count (and can exceed 100
 * for a multi-threaded renderer, which is honest).
 *
 * Defensive classification on purpose: Electron's page renderers are the
 * 'Tab' entries. GPU/Utility/Zygote/Unknown processes are not the surface the
 * spin came from, so they are ignored rather than guessed at; a malformed
 * metric is dropped instead of being read as a hang.
 */
export function createRendererCpuCollector(): RendererCpuCollector {
  const previousByPid = new Map<number, { cumulativeCPUUsage: number; at: number }>();
  return {
    read(metrics, at) {
      if (!Array.isArray(metrics)) return null;
      const seenPids = new Set<number>();
      let peak: number | null = null;
      for (const metric of metrics) {
        if (!metric || metric.type !== 'Tab') continue;
        if (typeof metric.pid !== 'number' || !Number.isFinite(metric.pid)) continue;
        seenPids.add(metric.pid);
        const cumulativeCPUUsage = metric.cpu?.cumulativeCPUUsage;
        if (typeof cumulativeCPUUsage !== 'number' || !Number.isFinite(cumulativeCPUUsage)) continue;

        const previous = previousByPid.get(metric.pid);
        previousByPid.set(metric.pid, { cumulativeCPUUsage, at });
        if (!previous || at <= previous.at) continue;
        const deltaCpuSeconds = cumulativeCPUUsage - previous.cumulativeCPUUsage;
        const deltaWallSeconds = (at - previous.at) / 1000;
        if (deltaCpuSeconds < 0 || deltaWallSeconds <= 0) continue; // pid reuse / counter reset
        const cpuPercent = (deltaCpuSeconds / deltaWallSeconds) * 100;
        if (peak === null || cpuPercent > peak) peak = cpuPercent;
      }
      // Forget pids that disappeared so a later pid reuse cannot inherit a
      // stale baseline from a dead renderer.
      for (const pid of previousByPid.keys()) {
        if (!seenPids.has(pid)) previousByPid.delete(pid);
      }
      return peak;
    },
  };
}

export interface RendererHangSamplerOptions {
  cpuThresholdPct?: number;
  sustainedMs?: number;
  hangThresholdMs?: number;
  /** Sample history kept for the run calculation; defaults to sustainedMs + hangThresholdMs. */
  retentionMs?: number;
}

export interface RendererHangSampler {
  /** Feed one metrics snapshot; returns a payload only when a NEW episode is reported. */
  sample(metrics: readonly RendererProcessMetricLike[] | null | undefined, at: number): RendererHangPayload | null;
}

/**
 * Stateful collection layer without the timer: tests drive it with a
 * fabricated clock and metrics, so one-report-per-episode and re-arm are
 * asserted deterministically instead of by waiting on wall-clock intervals.
 */
export function createRendererHangSampler(options: RendererHangSamplerOptions = {}): RendererHangSampler {
  const cpuThresholdPct = options.cpuThresholdPct ?? RENDERER_HANG_DEFAULTS.cpuThresholdPct;
  const sustainedMs = options.sustainedMs ?? RENDERER_HANG_DEFAULTS.sustainedMs;
  const hangThresholdMs = options.hangThresholdMs ?? RENDERER_HANG_DEFAULTS.hangThresholdMs;
  // Keep the whole sustained window plus one tolerated gap: pruning the
  // run-start sample on the very tick that would cross the threshold would
  // otherwise hide the hang.
  const retentionMs = Math.max(options.retentionMs ?? sustainedMs + hangThresholdMs, 0);
  const samples: RendererCpuSample[] = [];
  const cpuCollector = createRendererCpuCollector();
  let lastRaisedAtMs: number | null = null;

  return {
    sample(metrics, at) {
      const cpuPercent = cpuCollector.read(metrics, at);
      if (cpuPercent !== null) {
        samples.push({ at, cpuPercent });
      }
      const cutoff = at - retentionMs;
      while (samples.length > 0 && samples[0].at < cutoff) {
        samples.shift();
      }

      const evaluation = evaluateRendererHang({
        samples,
        now: at,
        cpuThresholdPct,
        sustainedMs,
        hangThresholdMs,
        lastRaisedAtMs,
      });

      if (evaluation.reason === 'below-threshold') {
        // An observed recovery re-arms the episode; the decision core also
        // re-arms on the same evidence, this keeps the sampler's own state
        // honest for the next raise.
        lastRaisedAtMs = null;
      }
      if (!evaluation.hang) return null;

      lastRaisedAtMs = at;
      return {
        cpuPercent: evaluation.cpuPercent ?? cpuPercent ?? 0,
        sustainedMs: evaluation.sustainedForMs,
        at,
      };
    },
  };
}

export type RendererHangLogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
export type RendererHangLog = (level: RendererHangLogLevel, tag: string, message: string, extra?: Record<string, unknown>) => void;

export interface RendererHangMonitorOptions extends RendererHangSamplerOptions {
  sampleIntervalMs?: number;
  now?: () => number;
  /** Called at most once per sustained episode; the only output of the monitor. */
  onHang?: (payload: RendererHangPayload) => void;
  /** Optional sink for the start/cadence line and reporter failures; main passes coworkLog. */
  log?: RendererHangLog;
}

let activeStop: (() => void) | null = null;

/**
 * Start the watchdog once per process. The timer is unref'd so it never holds
 * the app open, and this function is idempotent: a second call while running
 * returns the same stop handle instead of installing a second sampler.
 */
export function startRendererHangMonitor(
  getMetrics: () => readonly RendererProcessMetricLike[] | null | undefined,
  options: RendererHangMonitorOptions = {},
): () => void {
  if (activeStop) return activeStop;

  const now = options.now ?? Date.now;
  const sampleIntervalMs = Math.max(1, options.sampleIntervalMs ?? RENDERER_HANG_DEFAULTS.sampleIntervalMs);
  const log = options.log;
  const sampler = createRendererHangSampler(options);
  let metricsFailureActive = false;
  let stopped = false;

  const tick = (): void => {
    const at = now();
    let metrics: readonly RendererProcessMetricLike[] | null | undefined;
    try {
      metrics = getMetrics();
    } catch (error) {
      // Log once per failure streak: a broken metrics read must not turn the
      // watchdog itself into a 30-second log spammer.
      if (!metricsFailureActive) {
        metricsFailureActive = true;
        log?.('WARN', 'renderer:hang', 'Renderer hang watchdog cannot read app.getAppMetrics(); it stays blind until the call recovers', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }
    if (metricsFailureActive) {
      metricsFailureActive = false;
      log?.('INFO', 'renderer:hang', 'Renderer hang watchdog recovered app.getAppMetrics() reads');
    }

    const payload = sampler.sample(metrics, at);
    if (!payload) return;
    try {
      options.onHang?.(payload);
    } catch (error) {
      // The reporter is the only output; if it throws, the watchdog must keep
      // sampling instead of taking the main process down with it.
      log?.('WARN', 'renderer:hang', 'Renderer hang reporter threw; the watchdog keeps sampling', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const timer = setInterval(tick, sampleIntervalMs);
  timer.unref?.();

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    if (activeStop === stop) activeStop = null;
    log?.('INFO', 'renderer:hang', 'Renderer hang watchdog stopped');
  };
  activeStop = stop;

  log?.('INFO', 'renderer:hang', `Renderer hang watchdog started (notify-only: never reloads or kills); sampling renderer CPU every ${sampleIntervalMs}ms`, {
    sampleIntervalMs,
    cpuThresholdPct: options.cpuThresholdPct ?? RENDERER_HANG_DEFAULTS.cpuThresholdPct,
    sustainedMs: options.sustainedMs ?? RENDERER_HANG_DEFAULTS.sustainedMs,
    hangThresholdMs: options.hangThresholdMs ?? RENDERER_HANG_DEFAULTS.hangThresholdMs,
  });

  // Prime each renderer pid's cumulative-CPU baseline once: a pid's first
  // sighting cannot produce a delta, so without this the first interval would
  // be spent establishing baselines instead of measuring.
  tick();

  return stop;
}
