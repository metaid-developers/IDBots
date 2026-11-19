import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Server-mode runtime skeleton tests (REQ-A-1/2/3/4/5/7/10/31/32/33).
 *
 * The pure seams (src/main/server/*.ts, compiled to dist-electron/main) are
 * exercised directly from plain node. Where behavior lives inside Electron
 * main.ts, this file asserts the guarded branches statically against the
 * TypeScript source — full Electron behavior (actually booting windowless
 * under Xvfb) cannot run under plain node and is covered by the tenant
 * image conformance run instead.
 */

const require = createRequire(import.meta.url);

const serverMode = require('../dist-electron/main/server/serverMode.js');
const serverLogger = require('../dist-electron/main/server/logger.js');
const serverShutdown = require('../dist-electron/main/server/shutdown.js');
const dshTurn = require('../dist-electron/main/libs/coworkDshTurn.js');

const srcMainDir = path.join(process.cwd(), 'src', 'main');
const mainTsPath = path.join(srcMainDir, 'main.ts');
const mainTs = fs.readFileSync(mainTsPath, 'utf8');

const SERVER_ENV = { IDBOTS_SERVER_MODE: '1', IDBOTS_TENANT_ID: 't_testtenant0000000001' };
const DESKTOP_ENV = {};

// ---------------------------------------------------------------------------
// REQ-A-1: the mode switch gates everything.
// ---------------------------------------------------------------------------

test('REQ-A-1 isServerMode honors IDBOTS_SERVER_MODE only', () => {
  assert.equal(serverMode.isServerMode(SERVER_ENV), true);
  assert.equal(serverMode.isServerMode({ IDBOTS_SERVER_MODE: '0' }), false);
  assert.equal(serverMode.isServerMode({ IDBOTS_SERVER_MODE: 'true' }), false);
  assert.equal(serverMode.isServerMode(DESKTOP_ENV), false);
  assert.equal(serverMode.isServerMode({}), false);
});

test('REQ-A-1 main.ts checks the flag before every server-mode branch', () => {
  // Every server-only behavior must be inside an isServerMode() branch.
  assert.match(mainTs, /if \(isServerMode\(\)\) \{[\s\S]*?installServerShutdownHandlers/s);
  assert.match(mainTs, /if \(isServerMode\(\)\) \{[\s\S]*?installServerConsoleLogger/s);
  assert.match(mainTs, /if \(isServerMode\(\)\) return;/s);
});

// ---------------------------------------------------------------------------
// REQ-A-7: C1 data-path resolutions reuse libs/runtimeDataPaths.ts.
// ---------------------------------------------------------------------------

test('REQ-A-7 applyServerModeEnvDefaults sets C1 /data defaults only in server mode', () => {
  const serverEnv = { IDBOTS_SERVER_MODE: '1' };
  serverMode.applyServerModeEnvDefaults(serverEnv);
  assert.equal(serverEnv.IDBOTS_USER_DATA_PATH, '/data/userdata');
  assert.equal(serverEnv.IDBOTS_APP_DATA_PATH, '/data/appdata');

  // Explicit overrides always win.
  const overridden = { IDBOTS_USER_DATA_PATH: '/custom/u', IDBOTS_APP_DATA_PATH: '/custom/a' };
  serverMode.applyServerModeEnvDefaults(overridden);
  assert.equal(overridden.IDBOTS_USER_DATA_PATH, '/custom/u');
  assert.equal(overridden.IDBOTS_APP_DATA_PATH, '/custom/a');

  // Desktop is byte-identical: nothing is written.
  const desktopEnv = {};
  serverMode.applyServerModeEnvDefaults(desktopEnv);
  assert.deepEqual(desktopEnv, {});
});

test('REQ-A-7 resolveServerDataPaths matches configureUserDataPath resolution', () => {
  const resolved = serverMode.resolveServerDataPaths('/home/u/.config', '/home/u/.config/IDBots', 'IDBots', SERVER_ENV);
  assert.equal(resolved.userDataPath, path.resolve('/data/userdata'));
  assert.equal(resolved.appDataPath, path.resolve('/data/appdata'));

  const desktop = serverMode.resolveServerDataPaths('/home/u/.config', '/home/u/.config/IDBots', 'IDBots', DESKTOP_ENV);
  assert.equal(desktop.userDataPath, '/home/u/.config/IDBots');
  assert.equal(desktop.appDataPath, '/home/u/.config');
});

test('REQ-A-7 workspace path defaults to /data/workspace in server mode only', () => {
  const desktopDefault = path.join('/home/u', 'idbots', 'project');
  assert.equal(serverMode.resolveServerWorkspacePath(desktopDefault, SERVER_ENV), path.resolve('/data/workspace'));
  assert.equal(
    serverMode.resolveServerWorkspacePath(desktopDefault, { ...SERVER_ENV, IDBOTS_WORKSPACE_PATH: '/custom/ws' }),
    path.resolve('/custom/ws'),
  );
  assert.equal(serverMode.resolveServerWorkspacePath(desktopDefault, DESKTOP_ENV), desktopDefault);
});

test('REQ-A-7 main.ts applies env defaults before configureUserDataPath', () => {
  const defaultsAt = mainTs.indexOf('applyServerModeEnvDefaults();');
  assert.notEqual(defaultsAt, -1, 'applyServerModeEnvDefaults call missing');
  assert.ok(
    defaultsAt < mainTs.indexOf('configureUserDataPath();'),
    'applyServerModeEnvDefaults must run before configureUserDataPath()',
  );
});

// ---------------------------------------------------------------------------
// REQ-A-10: JSON-line logging + redaction. Desktop never installs it.
// ---------------------------------------------------------------------------

test('REQ-A-10 buildServerLogLine emits the C1 JSON shape', () => {
  const line = serverLogger.buildServerLogLine('info', 'main', 'hello', 't_x');
  const parsed = JSON.parse(line);
  assert.equal(typeof parsed.ts, 'string');
  assert.equal(parsed.level, 'info');
  assert.equal(parsed.tenant, 't_x');
  assert.equal(parsed.component, 'main');
  assert.equal(parsed.msg, 'hello');
});

test('REQ-A-10 redaction: gateway secret, apiKey, mnemonic, phone', () => {
  const secret = 'gw-secret-value-123456';
  const cases = [
    ['token=' + secret, /gw-secret-value/],
    ['{"apiKey": "sk-abcdef1234567890"}', /sk-abcdef/],
    ["apiKey='pk_live_9988776655'", /pk_live/],
    ['call me at +8613812345678 now', /13812345678/],
    ['backup phone 8613812345678', /13812345678/],
    ['mnemonic: witch collapse practice feed shame open despair creek road again ice least', /witch collapse/],
  ];
  for (const [input, leakPattern] of cases) {
    const redacted = serverLogger.redactServerLogText(input, [secret]);
    assert.doesNotMatch(redacted, leakPattern, `leak in: ${input}`);
  }
  // The surrounding prose survives.
  const redacted = serverLogger.redactServerLogText('user +8613812345678 says hi', []);
  assert.match(redacted, /says hi/);
  assert.match(redacted, /\[phone redacted\]/);
});

test('REQ-A-10 makeServerLogger writes one JSON line per call to the right stream', () => {
  const stdoutChunks = [];
  const stderrChunks = [];
  const fakeStdout = { write: (chunk) => stdoutChunks.push(String(chunk)) };
  const fakeStderr = { write: (chunk) => stderrChunks.push(String(chunk)) };
  const log = serverLogger.makeServerLogger({ tenantId: 't_log', stdout: fakeStdout, stderr: fakeStderr });
  log('info', 'gateway', 'listening', { port: 8790 });
  log('warn', 'main', 'careful');
  log('error', 'shutdown', 'boom');
  assert.equal(stdoutChunks.length, 1);
  assert.equal(stderrChunks.length, 2);
  const parsed = JSON.parse(stdoutChunks[0].trim());
  assert.deepEqual({ level: parsed.level, tenant: parsed.tenant, component: parsed.component, msg: parsed.msg, port: parsed.port },
    { level: 'info', tenant: 't_log', component: 'gateway', msg: 'listening', port: 8790 });
});

test('REQ-A-10 installServerConsoleLogger funnels console into JSON lines (desktop main.ts never installs it)', () => {
  const chunks = [];
  const fakeStdout = { write: (chunk) => chunks.push(String(chunk)) };
  const originalLog = console.log;
  try {
    serverLogger.installServerConsoleLogger({ tenantId: 't_wrap', stdout: fakeStdout, stderr: fakeStdout });
    console.log('hello %s', 'world', 42);
    console.error('bad', new Error('x'));
  } finally {
    console.log = originalLog;
  }
  assert.equal(chunks.length, 2);
  for (const chunk of chunks) {
    const parsed = JSON.parse(chunk.trim());
    assert.equal(parsed.tenant, 't_wrap');
    assert.equal(parsed.component, 'main');
  }
  assert.match(chunks[0], /hello world 42/);
  // Desktop gate: main.ts installs the wrapper only under isServerMode().
  assert.match(mainTs, /if \(isServerMode\(\)\) \{\s*\/\/ REQ-A-10[\s\S]*?installServerConsoleLogger\(\);[\s\S]*?\} else \{\s*initLogger\(\);/);
});

test('REQ-A-10 gateway logger is wired to the server logger in server mode', () => {
  const wiringTs = fs.readFileSync(path.join(srcMainDir, 'gateway', 'wiring.ts'), 'utf8');
  assert.match(wiringTs, /makeGatewayLogger\(serverMode, tenantId\)/);
  assert.match(wiringTs, /makeServerLogger\(\{ tenantId \}\)/);
});

// ---------------------------------------------------------------------------
// REQ-A-3: graceful shutdown ordering + the 20 s hard watchdog.
// ---------------------------------------------------------------------------

test('REQ-A-3 shutdown ordering: gateway 4012 → cleanup → sqlite flush → exit 0', async () => {
  const calls = [];
  const run = serverShutdown.runServerShutdown({
    getGateway: () => ({
      close: async (opts) => {
        calls.push(['gateway.close', opts?.code]);
      },
    }),
    runAppCleanup: async () => {
      calls.push(['runAppCleanup']);
    },
    flushSqlite: () => {
      calls.push(['flushSqlite']);
    },
    exit: (code) => {
      calls.push(['exit', code]);
    },
    log: () => {},
    watchdogMs: 60_000,
  });
  run.start();
  await run.finished;
  assert.deepEqual(calls, [
    ['gateway.close', 4012],
    ['runAppCleanup'],
    ['flushSqlite'],
    ['exit', 0],
  ]);
});

test('REQ-A-3 shutdown watchdog exists, is unref-able, and forces exit(1) on stall', async () => {
  const calls = [];
  const run = serverShutdown.runServerShutdown({
    getGateway: () => null,
    runAppCleanup: () => new Promise(() => {}), // hangs forever
    flushSqlite: () => {},
    exit: (code) => {
      calls.push(['exit', code]);
    },
    log: () => {},
    watchdogMs: 25,
  });
  assert.equal(typeof run.watchdog.unref, 'function', 'watchdog timer must be a real timer with unref()');
  run.start();
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.deepEqual(calls, [['exit', 1]]);
});

test('REQ-A-3 shutdown resolves even when gateway close and cleanup reject', async () => {
  const calls = [];
  const run = serverShutdown.runServerShutdown({
    getGateway: () => ({ close: async () => { throw new Error('close boom'); } }),
    runAppCleanup: async () => { throw new Error('cleanup boom'); },
    flushSqlite: () => { throw new Error('flush boom'); },
    exit: (code) => { calls.push(['exit', code]); },
    log: () => {},
    watchdogMs: 60_000,
  });
  run.start();
  await run.finished;
  assert.deepEqual(calls, [['exit', 0]], 'every phase fails soft and the sequence still reaches exit(0)');
});

test('REQ-A-3 shutdown is idempotent and start is single-fire', async () => {
  let cleanups = 0;
  const run = serverShutdown.runServerShutdown({
    getGateway: () => ({ close: async () => {} }),
    runAppCleanup: async () => { cleanups += 1; },
    flushSqlite: () => {},
    exit: () => {},
    log: () => {},
    watchdogMs: 60_000,
  });
  run.start();
  run.start();
  await run.finished;
  assert.equal(cleanups, 1);
});

test('REQ-A-3 main.ts installs server shutdown only in server mode; desktop keeps legacy handlers', () => {
  assert.match(mainTs, /if \(isServerMode\(\)\) \{\s*installServerShutdownHandlers\(\{/);
  assert.match(mainTs, /\} else \{\s*process\.once\('SIGINT', \(\) => handleTerminationSignal\('SIGINT'\)\);/);
  // The hard watchdog budget is 20 s (compiled shutdown module).
  const shutdownJs = fs.readFileSync(path.join(process.cwd(), 'dist-electron', 'main', 'server', 'shutdown.js'), 'utf8');
  assert.match(shutdownJs, /SERVER_SHUTDOWN_WATCHDOG_MS = 20_000|SERVER_SHUTDOWN_WATCHDOG_MS\s*=\s*20000/);
});

test('REQ-A-3 shutdown phases are logged through the server logger', async () => {
  const levels = [];
  const phases = [];
  const run = serverShutdown.runServerShutdown({
    getGateway: () => ({ close: async () => {} }),
    runAppCleanup: async () => {},
    flushSqlite: () => {},
    exit: () => {},
    log: (level, phase) => { levels.push(level); phases.push(phase); },
    watchdogMs: 60_000,
  });
  assert.equal(typeof run.watchdog.unref, 'function', 'watchdog timer must be a real timer with unref()');
  run.start();
  await run.finished;
  assert.ok(phases.includes('gateway-close'));
  assert.ok(phases.includes('app-cleanup'));
  assert.ok(phases.includes('sqlite-flush'));
  assert.ok(phases.includes('exit'));
  assert.ok(levels.every((level) => ['info', 'warn', 'error'].includes(level)));
});

// ---------------------------------------------------------------------------
// REQ-A-31: DSH idle-session reclaim — server ≤ 10 min, desktop unchanged.
// ---------------------------------------------------------------------------

test('REQ-A-31 server mode reclaims the idle DSH session within 10 minutes', () => {
  const desktopTtl = dshTurn.DSH_RUNTIME_IDLE_TTL_MS;
  assert.equal(desktopTtl, 30 * 60_000, 'desktop default must stay 30 minutes');
  assert.equal(serverMode.resolveDshRuntimeIdleTtlMs(desktopTtl, SERVER_ENV), 10 * 60_000);
  assert.ok(serverMode.resolveDshRuntimeIdleTtlMs(desktopTtl, SERVER_ENV) <= 10 * 60_000);
  assert.equal(serverMode.resolveDshRuntimeIdleTtlMs(desktopTtl, DESKTOP_ENV), desktopTtl, 'desktop value unchanged');
  assert.equal(serverMode.DSH_RUNTIME_IDLE_TTL_SERVER_MS, 10 * 60_000);
});

test('REQ-A-31 the hub TTL is a named constant (no magic 30-minute literal)', () => {
  const source = fs.readFileSync(path.join(srcMainDir, 'libs', 'coworkDshTurn.ts'), 'utf8');
  assert.match(source, /export const DSH_RUNTIME_IDLE_TTL_MS = 30 \* 60_000/);
  assert.doesNotMatch(source, /30 \* 60 \* 1000/);
  // The runner wires the server-mode override into the hub options.
  const runnerTs = fs.readFileSync(path.join(srcMainDir, 'libs', 'coworkRunner.ts'), 'utf8');
  assert.match(runnerTs, /runtimeIdleTtlMs: resolveDshRuntimeIdleTtlMs\(DSH_RUNTIME_IDLE_TTL_MS\)/);
  assert.match(runnerTs, /runtimeIdleMemoryPressureAware: !isServerMode\(\)/);
  const serverTtl = serverMode.resolveDshRuntimeIdleTtlMs(dshTurn.DSH_RUNTIME_IDLE_TTL_MS, SERVER_ENV);
  assert.equal(
    dshTurn.resolveDshRuntimeIdleTtlMsForMemory(serverTtl, 128, false),
    10 * 60_000,
    'host pressure must not collapse the server TTL to the desktop 45-second emergency window',
  );
  assert.equal(
    dshTurn.resolveDshRuntimeIdleTtlMsForMemory(dshTurn.DSH_RUNTIME_IDLE_TTL_MS, 128, true),
    45_000,
    'desktop keeps its existing critical-pressure protection',
  );
});

// ---------------------------------------------------------------------------
// REQ-A-32: no remote debugging port / inspector anywhere in server mode.
// ---------------------------------------------------------------------------

test('REQ-A-32 no remote-debugging-port / inspector switch exists in src/main', () => {
  const listTsFiles = (dir) => {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...listTsFiles(full));
      else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(full);
    }
    return out;
  };
  for (const file of listTsFiles(srcMainDir)) {
    const source = fs.readFileSync(file, 'utf8');
    assert.equal(
      source.includes('remote-debugging-port'),
      false,
      `${path.basename(file)} mentions remote-debugging-port`,
    );
    for (const line of source.split('\n')) {
      if (!line.includes('appendSwitch')) continue;
      assert.doesNotMatch(line, /inspect|remote-debugging/i, `${path.basename(file)}: ${line.trim()}`);
    }
  }
});

test('REQ-A-32 verbose Chromium logging (ELECTRON_ENABLE_LOGGING) is gated off in server mode', () => {
  assert.match(mainTs, /if \(enableVerboseLogging && !isServerMode\(\)\) \{/);
});

// ---------------------------------------------------------------------------
// REQ-A-33: staggered background jobs — deterministic, bounded, desktop-zero.
// ---------------------------------------------------------------------------

test('REQ-A-33 jitter is deterministic per (tenant, label) and bounded', () => {
  const a1 = serverMode.computeServerBootJitterMs('t_tenantA', 'listener');
  const a2 = serverMode.computeServerBootJitterMs('t_tenantA', 'listener');
  const b1 = serverMode.computeServerBootJitterMs('t_tenantB', 'listener');
  assert.equal(a1, a2, 'same tenant + label must jitter identically across restarts');
  assert.notEqual(a1, b1, 'different tenants must (with overwhelming probability) differ');
  assert.ok(a1 >= 0 && a1 < serverMode.SERVER_BOOT_JITTER_MAX_MS);
  assert.ok(b1 >= 0 && b1 < serverMode.SERVER_BOOT_JITTER_MAX_MS);
  assert.equal(serverMode.SERVER_BOOT_JITTER_MAX_MS, 120_000);
  // Different labels of one tenant spread apart (not all jobs pile up).
  const labels = ['listener', 'fee-rate', 'skill-sync', 'metaapp-sync', 'skill-services', 'tier:idle'];
  const jitters = new Set(labels.map((label) => serverMode.computeServerBootJitterMs('t_tenantA', label)));
  assert.ok(jitters.size >= labels.length - 1, 'per-label jitter should spread a tenant\'s jobs');
});

test('REQ-A-33 boot delay is the plain base delay on desktop', () => {
  assert.equal(serverMode.resolveServerBootDelayMs(7_000, 'listener', DESKTOP_ENV), 7_000);
  const serverDelay = serverMode.resolveServerBootDelayMs(7_000, 'listener', SERVER_ENV);
  assert.ok(serverDelay >= 7_000 && serverDelay < 7_000 + serverMode.SERVER_BOOT_JITTER_MAX_MS);
});

test('REQ-A-33 main.ts routes boot jobs and startup tiers through the jitter seam', () => {
  const startupTiersTs = fs.readFileSync(path.join(srcMainDir, 'libs', 'startupTiers.ts'), 'utf8');
  assert.match(startupTiersTs, /const effectiveDelayMs = resolveServerBootDelayMs\(delayMs, `tier:\$\{label\}`\);/);
  assert.match(mainTs, /startServerAwareBootJob\('metaweb listener start'/);
  assert.match(mainTs, /startServerAwareBootJob\('fee rate store init'/);
  assert.match(mainTs, /startServerAwareBootJob\('skill manager sync\+watch'/);
  assert.match(mainTs, /startServerAwareBootJob\('metaapp manager sync\+watch'/);
  assert.match(mainTs, /startServerAwareBootJob\('skill services startAll'/);
});

// ---------------------------------------------------------------------------
// REQ-A-2/4/5: windowless startup, desktop subsystems off, tool filter.
// ---------------------------------------------------------------------------

test('REQ-A-2 main.ts creates no window in server mode and keeps running windowless', () => {
  assert.match(mainTs, /if \(isServerMode\(\)\) \{\s*startupLog\('server mode: no window; starting window-gated services directly'\);/);
  assert.match(mainTs, /createAppWindow\(\);\s*\}/, 'desktop window creation stays in the else branch');
  assert.match(mainTs, /app\.on\('window-all-closed', \(\) => \{\s*if \(isServerMode\(\)\) return;/);
  assert.match(mainTs, /app\.on\('activate', \(\) => \{\s*if \(isServerMode\(\)\) return;/);
});

test('REQ-A-2 the scheduler + heavy maintenance start without a window in server mode', () => {
  assert.match(mainTs, /scheduleStartupTier\('server: task scheduler start', 0, \(\) => \{\s*didInitAppOnce = true;\s*scheduleCoworkStoreHeavyMaintenance\(\);\s*getScheduler\(\)\.start\(\);/);
  // Desktop trigger unchanged: still behind the first window's ready-to-show.
  assert.match(mainTs, /win\.once\('ready-to-show', \(\) => \{\s*startupLog\('window ready-to-show'\);[\s\S]*?if \(!didInitAppOnce\) \{\s*didInitAppOnce = true;\s*scheduleCoworkStoreHeavyMaintenance\(\);\s*createTray\(\(\) => mainWindow, getStore\(\)\);\s*getScheduler\(\)\.start\(\);[\s\S]*?startSleepGuardRefresh\(\);/);
});

test('REQ-A-2 startup:rendererInitialized stays a log-only handler (nothing waits on it)', () => {
  const handlerAt = mainTs.indexOf("registerIpcHandler('startup:rendererInitialized'");
  assert.notEqual(handlerAt, -1);
  const body = mainTs.slice(handlerAt, handlerAt + 600);
  assert.doesNotMatch(body, /await /, 'the handler must not block on anything');
});

test('REQ-A-2 no hidden BrowserWindow for precise geolocation in server mode', () => {
  const at = mainTs.indexOf('const requestSystemLocationFix');
  assert.notEqual(at, -1);
  const body = mainTs.slice(at, at + 700);
  assert.match(body, /if \(isServerMode\(\)\) \{\s*throw new Error\('Precise geolocation requires a renderer window/);
});

test('REQ-A-4 desktop subsystems are gated: menu, auto-launch, sleep/power guard', () => {
  assert.match(mainTs, /if \(!isServerMode\(\)\) \{\s*setupApplicationMenu\(\);\s*\}/);
  assert.match(mainTs, /if \(!isServerMode\(\) && !getStore\(\)\.get\('auto_launch_initialized'\)\)/);
  assert.match(mainTs, /const startSleepGuardRefresh = \(\): void => \{\s*\/\/ REQ-A-4[\s\S]*?if \(isServerMode\(\)\) return;/);
  assert.match(mainTs, /const recomputeSleepGuard = \(\): void => \{\s*\/\/ REQ-A-4[\s\S]*?if \(isServerMode\(\)\) return;/);
  // Tray creation lives only in the desktop ready-to-show path; updateTrayMenu
  // no-ops without a tray, so no server-mode branch is needed there.
  const trayCalls = (mainTs.match(/createTray\(/g) || []).length;
  assert.equal(trayCalls, 1, 'createTray must be called exactly once (the desktop ready-to-show path)');
});

test('REQ-A-5 server mode never offers desktop-only agent tools to the model', () => {
  const disabled = serverMode.SERVER_MODE_DISABLED_AGENT_TOOLS;
  for (const name of [
    'bot_browser_tabs', 'bot_browser_open_uri', 'bot_browser_preview_local', 'bot_browser_read_page',
    'bot_browser_fork_current_app', 'bot_browser_publish_app', 'bot_browser_screenshot', 'bot_browser_act',
    'browser_open', 'screenshot', 'open_metaapp', 'resolve_metaapp_url', 'project_query',
  ]) {
    assert.ok(disabled.has(name), `${name} must be in the server-mode disabled list`);
  }
  // Desktop no-op.
  const tools = [{ name: 'screenshot' }, { name: 'conversation_search' }];
  assert.equal(serverMode.filterServerModeAgentTools(tools).length, 2);
  // Server mode filters.
  const prev = process.env.IDBOTS_SERVER_MODE;
  process.env.IDBOTS_SERVER_MODE = '1';
  try {
    const filtered = serverMode.filterServerModeAgentTools(tools);
    assert.deepEqual(filtered.map((tool) => tool.name), ['conversation_search']);
  } finally {
    if (prev === undefined) delete process.env.IDBOTS_SERVER_MODE;
    else process.env.IDBOTS_SERVER_MODE = prev;
  }
  // The assembly seam applies the filter on every return path.
  const runnerTs = fs.readFileSync(path.join(srcMainDir, 'libs', 'coworkRunner.ts'), 'utf8');
  assert.equal((runnerTs.match(/filterServerModeAgentTools\(/g) || []).length, 4, 'all four tool-list returns must filter');
  // MCP local servers: composition providers return nothing in server mode.
  assert.match(mainTs, /mcpServerProvider:[\s\S]*?if \(isServerMode\(\)\) return \[\];/);
  assert.match(mainTs, /mcpServersForMetabot:[\s\S]*?if \(isServerMode\(\)\) return \[\];/);
});


// ---------------------------------------------------------------------------
// Cloud mobile owner-chat performance profile.
// ---------------------------------------------------------------------------

test('mobile owner-chat profile only matches interactive standard cowork UI sessions', () => {
  const standard = { sessionType: 'standard', autoOrigin: null };
  assert.equal(serverMode.isMobileOwnerChatSession({ serverMode: true, session: standard, sourceChannel: 'cowork_ui' }), true);
  assert.equal(serverMode.isMobileOwnerChatSession({ serverMode: false, session: standard, sourceChannel: 'cowork_ui' }), false);
  assert.equal(serverMode.isMobileOwnerChatSession({ serverMode: true, session: { ...standard, autoOrigin: 'schedule' }, sourceChannel: 'cowork_ui' }), false);
  assert.equal(serverMode.isMobileOwnerChatSession({ serverMode: true, session: { ...standard, sessionType: 'browser' }, sourceChannel: 'cowork_ui' }), false);
  assert.equal(serverMode.isMobileOwnerChatSession({ serverMode: true, session: { ...standard, sessionType: 'a2a' }, sourceChannel: 'cowork_ui' }), false);
  assert.equal(serverMode.isMobileOwnerChatSession({ serverMode: true, session: standard, sourceChannel: 'im:telegram' }), false);
  assert.equal(serverMode.isMobileOwnerChatSession({ serverMode: true, session: null, sourceChannel: 'cowork_ui' }), false);
});

test('mobile tool families start slim, expand on explicit intent, and stay expanded for follow-ups', () => {
  const resolve = serverMode.resolveMobileToolExpansions;
  assert.deepEqual(resolve(undefined, '你好，简单回答即可'), []);
  const financial = resolve([], '请查看钱包余额和 NFT 持仓');
  assert.deepEqual(financial, ['financial']);
  const financialSticky = resolve(financial, '继续');
  assert.deepEqual(financialSticky, ['financial']);
  const worker = resolve(financialSticky, '再发布一个 MetaTask 竞赛任务');
  assert.deepEqual(worker, ['workerEconomy', 'financial']);
  const social = resolve(worker, '然后到群聊里发一条 buzz');
  assert.deepEqual(social, ['workerEconomy', 'financial', 'social']);
  assert.deepEqual(resolve(social, '按刚才的方案继续'), social);
  assert.deepEqual(resolve([], 'What time is it?'), []);
  assert.deepEqual(resolve([], 'open a group task'), ['workerEconomy']);
  assert.deepEqual(resolve([], 'send this in the group chat'), ['social']);
});

test('mobile tool and effort gates are wired separately from Studio and desktop', () => {
  const runnerTs = fs.readFileSync(path.join(srcMainDir, 'libs', 'coworkRunner.ts'), 'utf8');
  assert.match(runnerTs, /const fastOwnerChatMode = assistantMode \|\| mobileOwnerChatMode/);
  assert.equal((runnerTs.match(/assistantMode: fastOwnerChatMode/g) || []).length, 5);
  assert.match(runnerTs, /\|\| !fastOwnerChatMode/);
  assert.deepEqual(
    serverMode.resolveMobileToolMountPolicy({ isStudioOwnerChat: false, isMobileOwnerChat: false, expansions: [] }),
    { workerEconomy: true, financial: true, social: true },
  );
  assert.deepEqual(
    serverMode.resolveMobileToolMountPolicy({ isStudioOwnerChat: true, isMobileOwnerChat: false, expansions: [] }),
    { workerEconomy: false, financial: true, social: false },
  );
  assert.deepEqual(
    serverMode.resolveMobileToolMountPolicy({ isStudioOwnerChat: false, isMobileOwnerChat: true, expansions: [] }),
    { workerEconomy: false, financial: false, social: false },
  );
  assert.deepEqual(
    serverMode.resolveMobileToolMountPolicy({ isStudioOwnerChat: false, isMobileOwnerChat: true, expansions: ['workerEconomy', 'financial', 'social'] }),
    { workerEconomy: true, financial: true, social: true },
  );
  assert.match(runnerTs, /resolveMobileToolMountPolicy\(\{ isStudioOwnerChat, isMobileOwnerChat, expansions: mobileExpansions \}\)/);
  assert.match(runnerTs, /this\.buildDshHostTools\(sessionId, prompt\)/);
  assert.match(runnerTs, /this\.buildSessionInlineTools\(sessionId, passthrough, undefined, currentUserText\)/);
});

test('server mode hard-disables the desktop CUA provider before legacy opt-ins', () => {
  assert.match(
    mainTs,
    /computer: \(metabotId: number \| null\) => \{\s*\/\/ Cloud tenants[\s\S]*?if \(isServerMode\(\)\) return false;[\s\S]*?isCoworkComputerUseEnabled/,
  );
});
