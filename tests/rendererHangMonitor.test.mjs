// Renderer-hang watchdog (2026-10-30 WTL): the decision core must fire ONLY
// on a sustained at/above-threshold run — never on a dip, a gap, a stale
// series or a re-read of the same episode — and the sampler must raise
// exactly one report per episode and re-arm only after an observed recovery.
// The monitor is notify-only, so these assertions are the whole safety story:
// there is no reload/kill path to test because none exists.
//
// The collection layer is pinned here too: renderer CPU is derived as
// percent-of-one-core from cumulativeCPUUsage deltas. Measured on Electron
// 41.10.5 / macOS / 12 cores, a renderer burning one full core reports 8.33%
// in percentCPUUsage (normalized to total machine capacity) but 100% by the
// cumulative delta — an 80% threshold on the normalized field would never
// catch the single-threaded page loop this watchdog exists for.
//
// Requires: pnpm run compile:electron

import assert from 'node:assert/strict'
import test from 'node:test'
import Module from 'node:module'

const require = Module.createRequire(import.meta.url)
const {
  evaluateRendererHang,
  createRendererCpuCollector,
  createRendererHangSampler,
  startRendererHangMonitor,
  RENDERER_HANG_DEFAULTS,
} = require('../dist-electron/main/libs/rendererHangMonitor.js')

const MINUTE = 60 * 1000
const BASE = { cpuThresholdPct: 80, sustainedMs: 5 * MINUTE, hangThresholdMs: 2 * MINUTE }

/** One sample per `stepMs`, starting at t=0. */
const series = (values, stepMs = MINUTE) => values.map((cpuPercent, index) => ({ at: index * stepMs, cpuPercent }))
const evaluate = (samples, now, extra = {}) => evaluateRendererHang({ samples, now, ...BASE, ...extra })
/** A single renderer whose cumulative CPU time is `cpuSeconds` at epoch `at`. */
const renderer = (at, cpuSeconds, pid = 42) => [{ pid, type: 'Tab', cpu: { cumulativeCPUUsage: cpuSeconds } }]

test('no samples or a garbage series never reads as a hang', () => {
  const empty = evaluate([], 0)
  assert.equal(empty.hang, false)
  assert.equal(empty.reason, 'no-samples')

  const garbage = evaluate(
    [
      null,
      undefined,
      { at: Number.NaN, cpuPercent: 100 },
      { at: 10 * MINUTE, cpuPercent: 100 }, // future: not observed yet
      { at: 2 * MINUTE, cpuPercent: Number.POSITIVE_INFINITY },
      { at: 3 * MINUTE, cpuPercent: -1 },
      { at: '4', cpuPercent: 100 },
    ],
    5 * MINUTE,
  )
  assert.equal(garbage.hang, false)
  assert.equal(garbage.reason, 'no-samples')
  assert.equal(garbage.cpuPercent, null)
})

test('a below-threshold series never raises', () => {
  const verdict = evaluate(series([79, 60, 10, 0, 79, 79]), 5 * MINUTE)
  assert.equal(verdict.hang, false)
  assert.equal(verdict.reason, 'below-threshold')
  assert.equal(verdict.sustainedForMs, 0)
})

test('exactly at the threshold counts once the window is met (boundary inclusive)', () => {
  const short = evaluate(series([80, 80, 80, 80, 80]), 4 * MINUTE)
  assert.equal(short.hang, false)
  assert.equal(short.reason, 'sustained-window-incomplete')
  assert.equal(short.sustainedForMs, 4 * MINUTE)

  const full = evaluate(series([80, 80, 80, 80, 80, 80]), 5 * MINUTE)
  assert.equal(full.hang, true)
  assert.equal(full.reason, 'hang')
  assert.equal(full.cpuPercent, 80)
  assert.equal(full.runStartAtMs, 0)
  assert.equal(full.sustainedForMs, 5 * MINUTE)
})

test('a single below-threshold sample resets the sustained window', () => {
  const eleven = series([95, 95, 95, 95, 95, 10, 95, 95, 95, 95, 95])
  const early = evaluate(eleven, 10 * MINUTE)
  assert.equal(early.hang, false)
  assert.equal(early.reason, 'sustained-window-incomplete')
  assert.equal(early.runStartAtMs, 6 * MINUTE)
  assert.equal(early.sustainedForMs, 4 * MINUTE)

  const full = evaluate(series([95, 95, 95, 95, 95, 10, 95, 95, 95, 95, 95, 95]), 11 * MINUTE)
  assert.equal(full.hang, true)
  assert.equal(full.reason, 'hang')
  assert.equal(full.runStartAtMs, 6 * MINUTE)
  assert.equal(full.sustainedForMs, 5 * MINUTE)
})

test('an unobserved gap longer than the tolerated cadence breaks the run', () => {
  const samples = [
    { at: 0, cpuPercent: 95 },
    { at: MINUTE, cpuPercent: 95 },
    { at: 7 * MINUTE, cpuPercent: 95 },
    { at: 8 * MINUTE, cpuPercent: 95 },
    { at: 9 * MINUTE, cpuPercent: 95 },
  ]
  const early = evaluate(samples, 8 * MINUTE, { sustainedMs: 2 * MINUTE })
  assert.equal(early.hang, false)
  assert.equal(early.reason, 'sustained-window-incomplete')
  assert.equal(early.sustainedForMs, MINUTE)

  const full = evaluate(samples, 9 * MINUTE, { sustainedMs: 2 * MINUTE })
  assert.equal(full.hang, true)
  assert.equal(full.runStartAtMs, 7 * MINUTE)
  assert.equal(full.sustainedForMs, 2 * MINUTE)
})

test('a stale sample series is not evidence of a hang', () => {
  const verdict = evaluate(series([95, 95, 95, 95, 95, 95]), 5 * MINUTE + 2 * MINUTE + 1)
  assert.equal(verdict.hang, false)
  assert.equal(verdict.reason, 'stale-samples')
})

test('one report per episode; only an observed recovery re-arms the core', () => {
  const high = series([95, 95, 95, 95, 95, 95])
  const first = evaluate(high, 5 * MINUTE)
  assert.equal(first.hang, true)

  const sameEpisode = evaluate(high, 5 * MINUTE, { lastRaisedAtMs: 5 * MINUTE })
  assert.equal(sameEpisode.hang, false)
  assert.equal(sameEpisode.reason, 'already-reported')

  // A pruned history whose oldest retained sample is newer than the last
  // report is still the same episode: no below-threshold sample was observed.
  const prunedHistory = series([95, 95, 95, 95, 95, 95]).map((sample) => ({ ...sample, at: sample.at + 10 * MINUTE }))
  const stillSame = evaluate(prunedHistory, 15 * MINUTE, { lastRaisedAtMs: 5 * MINUTE })
  assert.equal(stillSame.hang, false)
  assert.equal(stillSame.reason, 'already-reported')

  const recovered = evaluate(
    series([95, 95, 95, 95, 95, 95, 20, 95, 95, 95, 95, 95, 95]),
    12 * MINUTE,
    { lastRaisedAtMs: 5 * MINUTE },
  )
  assert.equal(recovered.hang, true)
  assert.equal(recovered.reason, 'hang')
  assert.equal(recovered.runStartAtMs, 7 * MINUTE)
  assert.equal(recovered.sustainedForMs, 5 * MINUTE)
})

test('renderer CPU is per-core from cumulative deltas, not the normalized percentCPUUsage field', () => {
  const collector = createRendererCpuCollector()
  // First sighting only establishes the baseline; percentCPUUsage would have
  // said 8.33% here (one core / 12 cores) — it is not even consulted.
  assert.equal(
    collector.read([
      { pid: 10, type: 'Tab', cpu: { percentCPUUsage: 8.33, cumulativeCPUUsage: 1 } },
      { pid: 99, type: 'GPU', cpu: { percentCPUUsage: 99, cumulativeCPUUsage: 100 } },
    ], 0),
    null,
  )
  // 0.5 CPU-seconds over 1s wall = 50% of one core.
  assert.equal(
    collector.read([
      { pid: 10, type: 'Tab', cpu: { cumulativeCPUUsage: 1.5 } },
      { pid: 11, type: 'Tab', cpu: { cumulativeCPUUsage: 7 } },
    ], 1000),
    50,
  )
  // 2.5 CPU-seconds over 0.5s wall = 500% (multi-threaded), busiest wins.
  assert.equal(
    collector.read([
      { pid: 10, type: 'Tab', cpu: { cumulativeCPUUsage: 4 } },
      { pid: 11, type: 'Tab', cpu: { cumulativeCPUUsage: 7.05 } },
    ], 1500),
    500,
  )
  // A vanished pid is forgotten: its return is a fresh baseline, not a stale delta.
  assert.equal(collector.read([{ pid: 10, type: 'Tab', cpu: { cumulativeCPUUsage: 4.5 } }], 2000), 100)
  assert.equal(collector.read([{ pid: 11, type: 'Tab', cpu: { cumulativeCPUUsage: 9 } }], 2500), null)
  // Only 'Tab' entries are renderers; anything else contributes nothing.
  assert.equal(collector.read([{ pid: 99, type: 'GPU', cpu: { cumulativeCPUUsage: 200 } }], 3000), null)
  assert.equal(collector.read(null, 3500), null)
})

test('sampler reports exactly once per episode and re-arms after recovery', () => {
  const sampler = createRendererHangSampler({ cpuThresholdPct: 80, sustainedMs: 5 * MINUTE, hangThresholdMs: 2 * MINUTE })
  // The shell ticks once at start, which only establishes the pid baseline.
  assert.equal(sampler.sample(renderer(0, 0), 0), null)

  const reports = []
  // One busy core: 60 CPU-seconds per 60 wall-seconds.
  for (let minute = 1; minute <= 8; minute += 1) {
    const payload = sampler.sample(renderer(minute * MINUTE, minute * 60), minute * MINUTE)
    if (payload) reports.push(payload)
  }
  assert.equal(reports.length, 1)
  assert.deepEqual(reports[0], { cpuPercent: 100, sustainedMs: 5 * MINUTE, at: 6 * MINUTE })

  // Observed recovery: 1 CPU-second over the next minute = 1.7%, re-arms.
  assert.equal(sampler.sample(renderer(9 * MINUTE, 8 * 60 + 1), 9 * MINUTE), null)

  const second = []
  for (let minute = 10; minute <= 15; minute += 1) {
    const payload = sampler.sample(renderer(minute * MINUTE, 8 * 60 + 1 + (minute - 9) * 60), minute * MINUTE)
    if (payload) second.push(payload)
  }
  assert.equal(second.length, 1)
  assert.equal(second[0].at, 15 * MINUTE)
  assert.equal(second[0].cpuPercent, 100)
})

test('the interval shell starts once, logs its cadence, and stops idempotently', () => {
  const logs = []
  const log = (level, tag, message, extra) => logs.push({ level, tag, message, extra })
  const getMetrics = () => []

  const first = startRendererHangMonitor(getMetrics, { sampleIntervalMs: 60 * 1000, log })
  const second = startRendererHangMonitor(getMetrics, { sampleIntervalMs: 60 * 1000, log })
  assert.equal(first, second, 'a second start returns the running monitor, not a second timer')

  const started = logs.filter((entry) => entry.message.includes('started'))
  assert.equal(started.length, 1)
  assert.equal(started[0].level, 'INFO')
  assert.equal(started[0].tag, 'renderer:hang')
  assert.match(started[0].message, /60000ms/)
  assert.equal(started[0].extra.sampleIntervalMs, 60 * 1000)
  assert.equal(started[0].extra.cpuThresholdPct, RENDERER_HANG_DEFAULTS.cpuThresholdPct)
  assert.equal(started[0].extra.sustainedMs, RENDERER_HANG_DEFAULTS.sustainedMs)

  first()
  first()
  assert.equal(logs.filter((entry) => entry.message.includes('stopped')).length, 1)

  const third = startRendererHangMonitor(getMetrics, { sampleIntervalMs: 60 * 1000, log })
  assert.notEqual(third, first, 'after stop a new start installs a fresh monitor')
  third()
})
