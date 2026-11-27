// The web-search bridge must not be an always-on tenant process (2026-11-27
// tenant host: 9 of 17 tenants held an idle bridge at about 95 MiB each, and
// none had searched since boot).
//
// Two halves, both pinned here:
//   - the app side: server mode prepares the web-search runtime but does NOT
//     start the bridge at boot — the skill's search.sh starts it on first use;
//     desktop keeps its pre-started bridge (its QEMU skill sandbox can only
//     reach a server the app started on the host);
//   - the bridge side (SKILLs/web-search/server/idle.ts): in server mode the
//     bridge exits by itself after a quiet period, served requests count as
//     activity, health probes alone do not.
//
// Requires: SKILLs/web-search built (pnpm run build:skill:web-search).

import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path';

const require = createRequire(import.meta.url);
const here = import.meta.dirname;
const skillDist = path.resolve(here, '..', 'SKILLs', 'web-search', 'dist', 'server');
const built = fs.existsSync(path.join(skillDist, 'idle.js'));
const notBuilt = built ? false : 'SKILLs/web-search is not built (pnpm run build:skill:web-search)';

const idle = built ? require(path.join(skillDist, 'idle.js')) : null;
const BridgeServer = built ? require(path.join(skillDist, 'index.js')).default : null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (predicate, timeoutMs, what) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(25);
  }
  throw new Error(`timeout waiting for ${what}`);
};

// ---------------------------------------------------------------------------
// The app side (static: src/main/skillServices.ts has no light harness)
// ---------------------------------------------------------------------------

test('server mode prepares the web-search runtime without starting the bridge; desktop still pre-starts it', () => {
  const source = fs.readFileSync(path.resolve(here, '..', 'src', 'main', 'skillServices.ts'), 'utf8');
  const startAll = source.slice(source.indexOf('async startAll(): Promise<void> {'), source.indexOf('async stopAll(): Promise<void> {'));
  assert.match(
    startAll,
    /if \(isServerMode\(\)\) \{\s*await this\.prepareWebSearchRuntime\(\);\s*\} else \{\s*await this\.startWebSearchService\(\);\s*\}/,
    'startAll must branch on server mode: prepare only in a tenant, pre-start on desktop',
  );
  const prepare = source.slice(
    source.indexOf('private async prepareWebSearchRuntime(): Promise<void> {'),
    source.indexOf('async startWebSearchService(): Promise<void> {'),
  );
  assert.match(prepare, /ensureWebSearchRuntimeReady\(skillPath\)/, 'the self-healing runtime check must survive without the pre-start');
  assert.doesNotMatch(prepare, /startWebSearchServiceProcess|spawn\(/, 'preparing must never launch the bridge process');
});

// ---------------------------------------------------------------------------
// The policy
// ---------------------------------------------------------------------------

test('resolveIdleExitMs: server mode defaults to ten minutes, desktop to never, WEB_SEARCH_IDLE_EXIT_MS wins', { skip: notBuilt }, () => {
  assert.equal(idle.DEFAULT_IDLE_EXIT_MS, 10 * 60_000);
  assert.equal(idle.resolveIdleExitMs({}), 0, 'desktop never exits by itself');
  assert.equal(idle.resolveIdleExitMs({ IDBOTS_SERVER_MODE: '1' }), 10 * 60_000);
  assert.equal(idle.resolveIdleExitMs({ IDBOTS_SERVER_MODE: '0' }), 0);
  assert.equal(idle.resolveIdleExitMs({ IDBOTS_SERVER_MODE: '1', WEB_SEARCH_IDLE_EXIT_MS: '0' }), 0, 'an explicit 0 disables it');
  assert.equal(idle.resolveIdleExitMs({ WEB_SEARCH_IDLE_EXIT_MS: '1500' }), 1500, 'an explicit value also works on desktop');
  assert.equal(idle.resolveIdleExitMs({ IDBOTS_SERVER_MODE: '1', WEB_SEARCH_IDLE_EXIT_MS: ' 30000 ' }), 30_000);
  assert.equal(idle.resolveIdleExitMs({ IDBOTS_SERVER_MODE: '1', WEB_SEARCH_IDLE_EXIT_MS: 'soon' }), 0, 'an unparsable value disables rather than guesses');
  assert.equal(idle.resolveIdleExitMs({ IDBOTS_SERVER_MODE: '1', WEB_SEARCH_IDLE_EXIT_MS: '-5' }), 0);
});

test('isIdle needs the exit enabled, nothing in flight, and the quiet period to have elapsed', { skip: notBuilt }, () => {
  assert.equal(idle.isIdle(10_000, 0, 0, 1_000), true);
  assert.equal(idle.isIdle(10_000, 0, 0, 0), false, 'exit disabled');
  assert.equal(idle.isIdle(10_000, 9_500, 0, 1_000), false, 'too soon');
  assert.equal(idle.isIdle(10_000, 0, 1, 1_000), false, 'a request is being served');
  assert.equal(idle.isIdle(1_000, 0, 0, 1_000), true, 'exactly at the boundary');
});

// ---------------------------------------------------------------------------
// The real bridge (built server, ephemeral port, exit captured instead of
// process.exit)
// ---------------------------------------------------------------------------

async function startBridge(exits) {
  const server = new BridgeServer(
    { server: { host: '127.0.0.1', port: 0 } },
    { exit: (code) => exits.push(code) },
  );
  await server.start();
  return server;
}

const getJson = async (url) => {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
};

const withIdleExit = async (ms, body) => {
  const previous = process.env.WEB_SEARCH_IDLE_EXIT_MS;
  process.env.WEB_SEARCH_IDLE_EXIT_MS = String(ms);
  const started = [];
  try {
    return await body(async () => {
      const exits = [];
      const server = await startBridge(exits);
      started.push(server);
      return { server, exits, port: server.listeningPort };
    });
  } finally {
    if (previous === undefined) delete process.env.WEB_SEARCH_IDLE_EXIT_MS;
    else process.env.WEB_SEARCH_IDLE_EXIT_MS = previous;
    for (const server of started) await server.stop().catch(() => undefined);
  }
};

test('the bridge exits by itself once idle, and its health probe reports the policy', { skip: notBuilt }, async () => {
  await withIdleExit(400, async (bridge) => {
    const { server, exits, port } = await bridge();
    assert.ok(port > 0, 'an ephemeral port must be assigned');
    const status = await getJson(`http://127.0.0.1:${port}/api/health`);
    assert.equal(status?.data?.status, 'healthy');
    assert.equal(status.data.idleExitMs, 400);
    assert.equal(typeof status.data.idleForSeconds, 'number');

    await waitFor(() => exits.length > 0, 5000, 'the idle exit');
    assert.deepEqual(exits, [0], 'exactly one exit, code 0');
    assert.equal(server.listeningPort, null, 'the listener must be closed');
    assert.equal(await getJson(`http://127.0.0.1:${port}/api/health`), null);
  });
});

test('served requests keep the bridge up; health probes alone do not', { skip: notBuilt }, async () => {
  // The window is seconds wide on purpose. Node's first fetch pays the HTTP
  // client's start-up, and on a loaded machine that alone can outrun a
  // sub-second window: the served bridge then looks idle before its first
  // request ever lands (seen on main, 2026-11-28, with a 700 ms window).
  const idleMs = 3000;
  await withIdleExit(idleMs, async (bridge) => {
    const served = await bridge();
    const probed = await bridge();
    try {
      // Longer than one idle period: the served bridge gets a request every
      // ~250 ms throughout, the other bridge nothing but health probes, the
      // way search.sh checks before each use.
      const serveUntil = Date.now() + idleMs + 1500;
      let servedRequests = 0;
      while (Date.now() < serveUntil) {
        const status = await getJson(`http://127.0.0.1:${served.port}/api/browser/status`);
        assert.equal(status?.success, true);
        await getJson(`http://127.0.0.1:${probed.port}/api/health`);
        servedRequests += 1;
        await sleep(250);
      }
      assert.ok(servedRequests >= 5, `the served bridge must actually have been used (${servedRequests} requests)`);
      assert.deepEqual(served.exits, [], 'a bridge that is being used must not exit');

      await waitFor(() => probed.exits.length > 0, idleMs + 2000, 'the merely probed bridge to exit');
      assert.deepEqual(probed.exits, [0], 'probing is not activity: an unused bridge still leaves');

      await waitFor(() => served.exits.length > 0, idleMs + 3000, 'the served bridge to exit once requests stop');
      assert.deepEqual(served.exits, [0]);
    } finally {
      await served.server.stop().catch(() => undefined);
      await probed.server.stop().catch(() => undefined);
    }
  });
});

test('with the exit disabled the bridge never leaves on its own', { skip: notBuilt }, async () => {
  await withIdleExit(0, async (bridge) => {
    const { server, exits, port } = await bridge();
    await sleep(1300);
    assert.deepEqual(exits, []);
    assert.equal((await getJson(`http://127.0.0.1:${port}/api/health`))?.data?.idleExitMs, 0);
    assert.equal(await server.exitIfIdle(), false, 'the idle check itself must decline');
  });
});
