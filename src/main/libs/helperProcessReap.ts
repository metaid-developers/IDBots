/**
 * Reap helper processes an agent left behind (server mode only).
 *
 * Skill scripts run through the DSH runtime's bash tool. The runtime's own
 * subprocess manager already removes what it can reach: every tool subprocess
 * is its own process group and its members are signalled when the runtime
 * exits. What escapes it is a helper that moved into a session or group of
 * its own — `setsid`, a daemonising launcher, a `start_new_session` child —
 * or anything the runtime was SIGKILLed before it could clean up. Such a
 * process is re-parented to PID 1 and then outlives its runtime. On the
 * tenant host (2026-11-27) one tenant kept two idle headless Chromium
 * instances (about 1.2 GiB) for three hours after its last turn, with the
 * runtime that started them long gone; earlyoom killed 237 chromium
 * processes across the fleet in one minute the same evening.
 *
 * The sweep: inside a tenant container exactly one process legitimately has
 * PID 1 as its parent — the app's own main process (docker-init is PID 1 and
 * the entrypoint exec'd into it). Everything else re-parented to PID 1 has
 * lost its parent. It runs only while no runtime slot is alive and no turn is
 * in flight: then no agent work can be running, so nothing can still be using
 * such a process.
 *
 * Everything here is pure: enumeration, signalling and time are injected.
 */

import { readdirSync, readFileSync } from 'node:fs';

/** One `/proc/<pid>/stat` row, reduced to what the sweep needs. */
export interface ProcStatEntry {
  pid: number;
  ppid: number;
  comm: string;
  /** Kernel start time in clock ticks — the identity that outlives PID reuse. */
  startTimeTicks: string;
}

/**
 * Commands that legitimately live with PID 1 as their parent inside a tenant
 * container: the entrypoint launches the session bus through `dbus-launch`,
 * which forks the daemon and exits (deploy/tenant-image/entrypoint.sh).
 * Everything else the entrypoint starts (Xvfb) stays a child of the app.
 */
export const ORPHAN_SWEEP_PROTECTED_COMM: ReadonlySet<string> = new Set(['dbus-daemon']);

/**
 * Parse a `/proc/<pid>/stat` line. `comm` is wrapped in parentheses and may
 * itself contain spaces and parentheses, so the fields are read after the
 * LAST closing parenthesis: state, ppid, … — `starttime` is field 22 of the
 * whole line, i.e. the 20th field after `comm`.
 */
export function parseProcStat(pid: number, statLine: string): ProcStatEntry | null {
  const open = statLine.indexOf('(');
  const close = statLine.lastIndexOf(')');
  if (open <= 0 || close <= open) return null;
  const fields = statLine.slice(close + 2).split(' ');
  const ppid = Number(fields[1]);
  const startTimeTicks = fields[19];
  if (!Number.isInteger(ppid) || ppid < 0 || !startTimeTicks) return null;
  return { pid, ppid, comm: statLine.slice(open + 1, close), startTimeTicks };
}

/** Processes that lost their parent: parent is PID 1, and not PID 1, the
 *  caller itself, or a protected entrypoint daemon. */
export function findOrphanProcesses(processes: ProcStatEntry[], selfPid: number): ProcStatEntry[] {
  return processes.filter(
    (entry) => entry.ppid === 1
      && entry.pid !== 1
      && entry.pid !== selfPid
      && !ORPHAN_SWEEP_PROTECTED_COMM.has(entry.comm),
  );
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface OrphanSweepDeps {
  listProcesses: () => ProcStatEntry[];
  /** `process.kill` semantics; throws when the process is gone. */
  signal: (pid: number, signal: NodeJS.Signals | 0) => void;
  /** False while any agent work can be running — the sweep is a no-op then. */
  isAgentQuiescent: () => boolean;
  selfPid: number;
  log?: (level: 'info' | 'warn', message: string, detail?: Record<string, unknown>) => void;
  sleep?: (ms: number) => Promise<void>;
}

export interface OrphanSweepResult {
  status: 'busy' | 'clean' | 'swept';
  terminated: ProcStatEntry[];
}

/**
 * Terminate every orphan in the process table. SIGTERM first so a browser or
 * a server flushes and exits; after `graceMs` whatever is still the SAME
 * process (pid and start time both match — a recycled pid must never be
 * signalled) gets SIGKILL.
 */
export async function sweepOrphanProcesses(deps: OrphanSweepDeps, graceMs = 5_000): Promise<OrphanSweepResult> {
  if (!deps.isAgentQuiescent()) return { status: 'busy', terminated: [] };
  const orphans = findOrphanProcesses(deps.listProcesses(), deps.selfPid);
  if (orphans.length === 0) return { status: 'clean', terminated: [] };
  for (const entry of orphans) {
    try {
      deps.signal(entry.pid, 'SIGTERM');
    } catch {
      // exited between the listing and the signal
    }
  }
  await (deps.sleep ?? defaultSleep)(graceMs);
  const survivors = new Map(deps.listProcesses().map((entry) => [entry.pid, entry]));
  for (const entry of orphans) {
    const current = survivors.get(entry.pid);
    if (!current || current.startTimeTicks !== entry.startTimeTicks) continue;
    try {
      deps.signal(entry.pid, 'SIGKILL');
    } catch {
      // gone meanwhile
    }
  }
  deps.log?.('info', 'helperProcessReap.orphanSweep', {
    terminated: orphans.map((entry) => ({ pid: entry.pid, comm: entry.comm })),
  });
  return { status: 'swept', terminated: orphans };
}

export type HelperProcessSignalDeps = Pick<OrphanSweepDeps, 'listProcesses' | 'signal'>;

/** Production deps backed by procfs. Linux only — null everywhere else, where
 *  there is no /proc to walk and no tenant image to protect. */
export function createProcfsHelperProcessDeps(platform: string = process.platform): HelperProcessSignalDeps | null {
  if (platform !== 'linux') return null;
  return {
    listProcesses: (): ProcStatEntry[] => {
      let names: string[];
      try {
        names = readdirSync('/proc');
      } catch {
        return [];
      }
      const entries: ProcStatEntry[] = [];
      for (const name of names) {
        if (!/^\d+$/u.test(name)) continue;
        try {
          const entry = parseProcStat(Number(name), readFileSync(`/proc/${name}/stat`, 'utf8'));
          if (entry) entries.push(entry);
        } catch {
          // the process exited between readdir and read
        }
      }
      return entries;
    },
    signal: (pid, signal) => process.kill(pid, signal),
  };
}

export interface HelperProcessReaperOptions extends HelperProcessSignalDeps {
  isAgentQuiescent: () => boolean;
  selfPid: number;
  log?: OrphanSweepDeps['log'];
  intervalMs?: number;
  graceMs?: number;
}

/**
 * Runs the orphan sweep on an interval. Single-flight (a sweep that is still
 * waiting out its grace period is not started again), and its timer is
 * unref'd so it never keeps the process alive.
 */
export class HelperProcessReaper {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<OrphanSweepResult> | null = null;

  constructor(
    private readonly opts: HelperProcessReaperOptions,
    private readonly schedule: typeof setInterval = setInterval,
    private readonly cancel: typeof clearInterval = clearInterval,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = this.schedule(() => void this.sweep(), this.opts.intervalMs ?? 60_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    this.cancel(this.timer);
    this.timer = null;
  }

  sweep(): Promise<OrphanSweepResult> {
    if (!this.inFlight) {
      this.inFlight = sweepOrphanProcesses(this.opts, this.opts.graceMs)
        .catch((error: unknown): OrphanSweepResult => {
          this.opts.log?.('warn', 'helperProcessReap.orphanSweepFailed', {
            error: error instanceof Error ? error.message : String(error),
          });
          return { status: 'clean', terminated: [] };
        })
        .finally(() => {
          this.inFlight = null;
        });
    }
    return this.inFlight;
  }
}
