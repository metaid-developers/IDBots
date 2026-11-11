import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * REQ-A-15..REQ-A-22 — gateway server integration tests. Starts the compiled
 * server (dist-electron/main/gateway/server.js) on an ephemeral port with
 * fake injected deps (no electron!) and exercises it over real HTTP and a
 * real ws client.
 */

const require = createRequire(import.meta.url);

const server = require('../dist-electron/main/gateway/server.js');
const tokens = require('../dist-electron/main/gateway/tokens.js');
const { WebSocket } = require('ws');

const SECRET = 'test-gateway-secret';
const TENANT = 't_testtenant0000000001';
const WRONG_SECRET = 'test-gateway-secreX';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeTenantTree(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-server-')));
  const paths = {
    dataRoot: path.join(base, 'data'),
    workspaceRoot: path.join(base, 'data', 'workspace'),
    uploadsRoot: path.join(base, 'data', 'workspace', 'uploads'),
  };
  fs.mkdirSync(paths.uploadsRoot, { recursive: true });
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return { base, paths };
}

function readyState(overrides = {}) {
  return {
    phase: 'ready',
    version: '0.0.0-test',
    commit: 'testcommit',
    contractVersion: '1.0.0',
    onboarding: {
      identity: 'done',
      llmProvider: 'done',
      twinMetabot: 'done',
      workspace: 'done',
      trafficAccount: 'done',
      redeemCode: 'skipped',
      globalMetaId: null,
      twinMetabotId: null,
    },
    error: null,
    ...overrides,
  };
}

/**
 * Start a gateway on an ephemeral port with fake deps. `overrides.gateway`
 * wins over individual dep overrides.
 */
async function startServer(t, overrides = {}) {
  const { base, paths } = makeTenantTree(t);
  const calls = [];
  const logs = [];
  let broadcastListener = null;
  const storedAppConfig = overrides.storedAppConfig ?? null;
  const gateway = {
    host: '127.0.0.1',
    port: 0,
    secret: SECRET,
    tenantId: TENANT,
    tier: 'P1',
    contractVersion: '1.0.0',
    appVersion: '0.0.0-test',
    commit: 'testcommit',
    paths,
    readiness: () => readyState(overrides.readinessOverrides),
    invokeHandler: overrides.invokeHandler
      ? async (channel, clientId, args) => overrides.invokeHandler(channel, clientId, args)
      : async (channel, clientId, args) => {
          calls.push({ channel, clientId, args });
          // The real store:get handler returns the stored row; mirror that so
          // R-store redaction/merge are exercised end-to-end.
          if (channel === 'store:get') return storedAppConfig;
          return { ok: true, channel };
        },
    hasHandler: overrides.hasHandler ? (channel) => overrides.hasHandler(channel) : () => true,
    addBroadcastListener: (listener) => {
      broadcastListener = listener;
      return () => {
        broadcastListener = null;
      };
    },
    storeGet: overrides.storeGet
      ? (key) => overrides.storeGet(key)
      : (key) => (key === 'app_config' ? storedAppConfig : undefined),
    revealMnemonic: overrides.revealMnemonic ?? (async () => 'word1 word2 word3'),
    logger: (level, component, msg, extra) => logs.push({ level, component, msg, extra }),
    ...(overrides.gateway ?? {}),
  };
  const handle = await server.startGateway(gateway);
  t.after(async () => {
    await handle.close();
  });
  return {
    handle,
    calls,
    logs,
    paths,
    base,
    broadcast: (channel, args) => {
      assert.ok(broadcastListener, 'broadcast listener registered');
      broadcastListener(channel, args);
    },
  };
}

function gatewayHeaders(extra = {}) {
  return { 'X-IDBots-Gateway-Secret': SECRET, ...extra };
}

/** Local yyyy-mm-dd, matching upload.ts's day-folder layout. */
function localDateStamp(now = new Date()) {
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

async function httpRequest(port, method, pathname, { secret = SECRET, headers = {}, body } = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: {
      ...(secret === null ? {} : { 'X-IDBots-Gateway-Secret': secret }),
      ...headers,
    },
    body,
  });
  return res;
}

// ---------------------------------------------------------------------------
// WebSocket client helper
// ---------------------------------------------------------------------------

let invokeCounter = 0;

function openClient(port, { clientId = 'client-1', secret = SECRET } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/gateway/v1/ws`, {
      headers: {
        ...(secret === null ? {} : { 'X-IDBots-Gateway-Secret': secret }),
        'X-IDBots-Client-Id': clientId,
      },
    });
    const pending = new Map();
    const events = [];
    const welcomeWaiters = [];
    let welcome = null;
    ws.on('message', (raw) => {
      const frame = JSON.parse(raw.toString());
      if (frame.type === 'welcome') {
        welcome = frame;
        for (const waiter of welcomeWaiters.splice(0)) waiter(frame);
      } else if (frame.type === 'result') {
        const entry = pending.get(frame.id);
        if (entry) {
          pending.delete(frame.id);
          clearTimeout(entry.timer);
          entry.resolve(frame);
        }
      } else {
        events.push(frame);
      }
    });
    ws.on('open', () => {
      resolve({
        ws,
        events,
        welcome: () => (welcome ? Promise.resolve(welcome) : new Promise((r) => welcomeWaiters.push(r))),
        invoke(channel, args = []) {
          const id = `inv-${++invokeCounter}`;
          ws.send(JSON.stringify({ v: 1, type: 'invoke', id, channel, args }));
          return new Promise((resolveInvoke, rejectInvoke) => {
            const timer = setTimeout(() => {
              pending.delete(id);
              rejectInvoke(new Error(`timed out waiting for result ${id}`));
            }, 10_000);
            pending.set(id, { resolve: resolveInvoke, timer });
          });
        },
        sendRaw(text) {
          ws.send(text);
        },
        nextEvent(predicate = () => true, timeoutMs = 3000) {
          const started = Date.now();
          return new Promise((resolveEvent, rejectEvent) => {
            const poll = () => {
              const index = events.findIndex(predicate);
              if (index >= 0) {
                resolveEvent(events.splice(index, 1)[0]);
                return;
              }
              if (Date.now() - started > timeoutMs) {
                rejectEvent(new Error('timed out waiting for event'));
                return;
              }
              setTimeout(poll, 20);
            };
            poll();
          });
        },
        close: () =>
          new Promise((resolveClose) => {
            if (ws.readyState === WebSocket.CLOSED) {
              resolveClose();
              return;
            }
            ws.once('close', () => resolveClose());
            ws.close();
          }),
      });
    });
    ws.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// HTTP: healthz / auth / readyz
// ---------------------------------------------------------------------------

test('http: /healthz answers 200 {"ok":true} without auth and never blocks', async (t) => {
  const { handle } = await startServer(t, {
    readinessOverrides: { phase: 'bootstrapping' },
  });
  const res = await httpRequest(handle.port, 'GET', '/healthz', { secret: null });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test('http: wrong or missing secret → 401 with no body detail on every route', async (t) => {
  const { handle } = await startServer(t);
  for (const [method, pathname] of [
    ['GET', '/readyz'],
    ['GET', '/gateway/v1/files/abc.def'],
    ['POST', '/gateway/v1/upload?name=x.txt'],
    ['POST', '/gateway/v1/sensitive/reveal-mnemonic'],
    ['GET', '/app/index.html'],
  ]) {
    const res = await httpRequest(handle.port, method, pathname, { secret: WRONG_SECRET });
    assert.equal(res.status, 401, `${method} ${pathname} with wrong secret`);
    assert.equal(await res.text(), '', `${method} ${pathname} must have an empty body`);
    const resMissing = await httpRequest(handle.port, method, pathname, { secret: null });
    assert.equal(resMissing.status, 401, `${method} ${pathname} without secret`);
  }
});

test('http: /readyz 200 when ready, 503 while bootstrapping, full body both ways', async (t) => {
  let phase = 'bootstrapping';
  const { handle } = await startServer(t, {
    gateway: { readiness: () => readyState({ phase }) },
  });
  const res503 = await httpRequest(handle.port, 'GET', '/readyz');
  assert.equal(res503.status, 503);
  const body503 = await res503.json();
  assert.equal(body503.ready, false);
  assert.equal(body503.phase, 'bootstrapping');
  assert.equal(body503.contractVersion, '1.0.0');
  assert.equal(body503.version, '0.0.0-test');
  assert.equal(body503.commit, 'testcommit');
  assert.equal(body503.error, null);
  assert.equal(body503.onboarding.identity, 'done');

  phase = 'degraded';
  const res200 = await httpRequest(handle.port, 'GET', '/readyz');
  assert.equal(res200.status, 200);
  const body200 = await res200.json();
  assert.equal(body200.ready, true);
  assert.equal(body200.phase, 'degraded');
});

// ---------------------------------------------------------------------------
// WebSocket: welcome, auth
// ---------------------------------------------------------------------------

test('ws: upgrade without the secret is rejected (401)', async (t) => {
  const { handle } = await startServer(t);
  await assert.rejects(
    () => openClient(handle.port, { secret: WRONG_SECRET }),
    /Unexpected server response: 401/,
  );
});

test('ws: welcome frame carries contract/app version, tenantId, time, ready, phase', async (t) => {
  const { handle } = await startServer(t);
  const client = await openClient(handle.port, { clientId: 'phone-1' });
  t.after(() => client.close());
  const welcome = await client.welcome();
  assert.equal(welcome.v, 1);
  assert.equal(welcome.type, 'welcome');
  assert.equal(welcome.contractVersion, '1.0.0');
  assert.equal(welcome.appVersion, '0.0.0-test');
  assert.equal(welcome.tenantId, TENANT);
  assert.equal(typeof welcome.serverTime, 'number');
  assert.equal(welcome.ready, true);
  assert.equal(welcome.phase, 'ready');
});

test('ws: ping frame answers a pong with the same ts', async (t) => {
  const { handle } = await startServer(t);
  const client = await openClient(handle.port);
  t.after(() => client.close());
  await client.welcome();
  client.sendRaw(JSON.stringify({ v: 1, type: 'ping', ts: 123456 }));
  const pong = await client.nextEvent((frame) => frame.type === 'pong');
  assert.equal(pong.ts, 123456);
});

test('ws: garbage frame yields INVALID_FRAME and an unknown-type frame is rejected', async (t) => {
  const { handle } = await startServer(t);
  const client = await openClient(handle.port);
  t.after(() => client.close());
  await client.welcome();
  client.sendRaw('this is not json');
  // Unanswerable (no id) — socket stays open, proven by the next invoke.
  const result = await client.invoke('cowork:session:list', []);
  assert.equal(result.ok, true);
});

// ---------------------------------------------------------------------------
// Invoke pipeline: allowlist, tiers, handlers, restrictions
// ---------------------------------------------------------------------------

test('ws: allowed P1 invoke round-trips through the injected handler with clientId', async (t) => {
  const { handle, calls } = await startServer(t);
  const client = await openClient(handle.port, { clientId: 'phone-9' });
  t.after(() => client.close());
  await client.welcome();
  const result = await client.invoke('cowork:session:list', [{ limit: 5 }]);
  assert.equal(result.ok, true);
  assert.equal(result.value.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].channel, 'cowork:session:list');
  assert.equal(calls[0].clientId, 'phone-9');
  assert.deepEqual(calls[0].args, [{ limit: 5 }]);
});

test('ws: N-tier, S-tier, and unknown channels → CHANNEL_NOT_ALLOWED (not dispatched)', async (t) => {
  const { handle, calls } = await startServer(t);
  const client = await openClient(handle.port);
  t.after(() => client.close());
  await client.welcome();
  for (const channel of ['api:fetch', 'shell:openExternal', 'cowork:sandbox:install', 'nope:notListed']) {
    const result = await client.invoke(channel, []);
    assert.equal(result.ok, false, channel);
    assert.equal(result.error.code, 'CHANNEL_NOT_ALLOWED', channel);
    assert.equal(result.error.retryable, false, channel);
  }
  assert.equal(calls.length, 0, 'denied channels must never reach the handler');
});

test('ws: H-tier mnemonic channels are denied over the socket (C2 sensitive route only)', async (t) => {
  const { handle } = await startServer(t);
  const client = await openClient(handle.port);
  t.after(() => client.close());
  await client.welcome();
  for (const channel of ['userIdentity:revealMnemonic', 'idbots:getMetaBotMnemonic']) {
    const result = await client.invoke(channel, []);
    assert.equal(result.ok, false, channel);
    assert.equal(result.error.code, 'CHANNEL_NOT_ALLOWED', channel);
  }
});

test('ws: P2 channels denied at tier P1 and allowed at tier P2', async (t) => {
  const p1 = await startServer(t);
  const p1Client = await openClient(p1.handle.port);
  t.after(() => p1Client.close());
  await p1Client.welcome();
  const denied = await p1Client.invoke('dream:getStatus', []);
  assert.equal(denied.ok, false);
  assert.equal(denied.error.code, 'CHANNEL_NOT_ALLOWED');

  const p2 = await startServer(t, { gateway: { tier: 'P2' } });
  const p2Client = await openClient(p2.handle.port);
  t.after(() => p2Client.close());
  await p2Client.welcome();
  const allowed = await p2Client.invoke('dream:getStatus', []);
  assert.equal(allowed.ok, true);
  const prefix = await p2Client.invoke('groupTask:list', []);
  assert.equal(prefix.ok, true, 'P2 prefix family allowed at tier P2');
  // N families stay denied even at tier P2.
  const stillDenied = await p2Client.invoke('api:fetch', []);
  assert.equal(stillDenied.error.code, 'CHANNEL_NOT_ALLOWED');
});

test('ws: allowlisted channel without a registered handler → CHANNEL_NOT_FOUND', async (t) => {
  const { handle } = await startServer(t, { hasHandler: () => false });
  const client = await openClient(handle.port);
  t.after(() => client.close());
  await client.welcome();
  const result = await client.invoke('cowork:session:list', []);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'CHANNEL_NOT_FOUND');
  assert.equal(result.error.retryable, false);
});

test('ws: R-cwd rejects /etc and accepts the workspace root', async (t) => {
  const { handle, calls, paths } = await startServer(t);
  const client = await openClient(handle.port);
  t.after(() => client.close());
  await client.welcome();
  const rejected = await client.invoke('cowork:session:start', [{ prompt: 'hi', cwd: '/etc' }]);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error.code, 'ARG_RESTRICTED');
  const accepted = await client.invoke('cowork:session:start', [{ prompt: 'hi', cwd: paths.workspaceRoot }]);
  assert.equal(accepted.ok, true);
  assert.equal(calls.length, 1);
});

test('ws: store:get app_config redacts every providers.*.apiKey end-to-end', async (t) => {
  const storedAppConfig = {
    providers: {
      deepseek: { apiKey: 'sk-real-secret', baseUrl: 'https://api.deepseek.com', apiFormat: 'openai' },
      anthropic: { apiKey: 'sk-ant-secret', baseUrl: 'https://api.anthropic.com', apiFormat: 'anthropic' },
    },
    theme: 'dark',
  };
  const { handle, calls } = await startServer(t, { storedAppConfig });
  const client = await openClient(handle.port);
  t.after(() => client.close());
  await client.welcome();
  const result = await client.invoke('store:get', ['app_config']);
  assert.equal(result.ok, true);
  assert.equal(result.value.providers.deepseek.apiKey, '__redacted__');
  assert.equal(result.value.providers.anthropic.apiKey, '__redacted__');
  assert.equal(result.value.providers.deepseek.baseUrl, 'https://api.deepseek.com');
  assert.equal(result.value.theme, 'dark');
  assert.equal(storedAppConfig.providers.deepseek.apiKey, 'sk-real-secret', 'stored value untouched');
  assert.deepEqual(calls[0].args, ['app_config']);
});

test('ws: store:set merges provider entries against the stored config before dispatch', async (t) => {
  const storedAppConfig = {
    providers: {
      deepseek: { apiKey: 'stored-key', baseUrl: 'https://stored.example', apiFormat: 'openai', enabled: true },
    },
    theme: 'dark',
  };
  const { handle, calls } = await startServer(t, { storedAppConfig });
  const client = await openClient(handle.port);
  t.after(() => client.close());
  await client.welcome();
  const result = await client.invoke('store:set', [
    'app_config',
    { providers: { deepseek: { apiKey: 'hacked', baseUrl: 'https://evil.example', apiFormat: 'x', enabled: false } }, theme: 'light' },
  ]);
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].channel, 'store:set');
  assert.deepEqual(calls[0].args, [
    'app_config',
    {
      providers: {
        deepseek: { apiKey: 'stored-key', baseUrl: 'https://stored.example', apiFormat: 'openai', enabled: false },
      },
      theme: 'light',
    },
  ]);
  // Adding a provider entry fails without dispatching.
  const rejected = await client.invoke('store:set', [
    'app_config',
    { providers: { deepseek: { enabled: true }, newp: { apiKey: 'x' } } },
  ]);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error.code, 'INVALID_ARGS');
  assert.equal(calls.length, 1, 'invalid set-merge must not dispatch');
});

test('ws: store:set serializes field patches against the latest config and preserves bootstrap/provider data', async (t) => {
  let stored = {
    language: 'en',
    language_initialized: true,
    theme: 'system',
    bootstrap: { workspace: '/data/workspace' },
    providers: {
      'metaid-free': {
        enabled: true,
        apiKey: 'relay-secret',
        baseUrl: 'https://relay.example',
        apiFormat: 'openai',
        models: [{ id: 'model-a' }],
      },
    },
  };
  let releaseFirstSet;
  let setCount = 0;
  const { handle } = await startServer(t, {
    storeGet: () => stored,
    invokeHandler: async (channel, _clientId, args) => {
      if (channel === 'store:get') return stored;
      if (channel !== 'store:set') return { ok: true };
      setCount += 1;
      if (setCount === 1) {
        await new Promise((resolve) => {
          releaseFirstSet = resolve;
        });
      }
      stored = args[1];
      return { success: true };
    },
  });
  const client = await openClient(handle.port);
  t.after(() => client.close());
  await client.welcome();

  const languageWrite = client.invoke('store:set', ['app_config', { language: 'zh' }]);
  const themeWrite = client.invoke('store:set', ['app_config', { theme: 'dark' }]);
  while (!releaseFirstSet) await new Promise((resolve) => setTimeout(resolve, 2));
  releaseFirstSet();
  assert.equal((await languageWrite).ok, true);
  assert.equal((await themeWrite).ok, true);

  assert.equal(stored.language, 'zh');
  assert.equal(stored.theme, 'dark');
  assert.equal(stored.language_initialized, true);
  assert.deepEqual(stored.bootstrap, { workspace: '/data/workspace' });
  assert.equal(stored.providers['metaid-free'].apiKey, 'relay-secret');
  assert.equal(stored.providers['metaid-free'].baseUrl, 'https://relay.example');
  assert.equal(stored.providers['metaid-free'].apiFormat, 'openai');
});

test('ws: store:remove and store:get of another key → ARG_RESTRICTED', async (t) => {
  const { handle, calls } = await startServer(t);
  const client = await openClient(handle.port);
  t.after(() => client.close());
  await client.welcome();
  const removed = await client.invoke('store:remove', ['app_config']);
  assert.equal(removed.ok, false);
  assert.equal(removed.error.code, 'ARG_RESTRICTED');
  const otherKey = await client.invoke('store:get', ['other_key']);
  assert.equal(otherKey.ok, false);
  assert.equal(otherKey.error.code, 'ARG_RESTRICTED');
  assert.equal(calls.length, 0);
});

// ---------------------------------------------------------------------------
// Limits: payload, rate, in-flight, sockets
// ---------------------------------------------------------------------------

test('ws: oversized frame → PAYLOAD_TOO_LARGE, socket stays open and can still invoke', async (t) => {
  const { handle } = await startServer(t);
  const client = await openClient(handle.port);
  t.after(() => client.close());
  await client.welcome();
  const big = await client.invoke('cowork:session:list', ['x'.repeat(1.2 * 1024 * 1024)]);
  assert.equal(big.ok, false);
  assert.equal(big.error.code, 'PAYLOAD_TOO_LARGE');
  assert.equal(big.error.retryable, false);
  // Socket is still fully usable (C2: "socket stays open").
  const followUp = await client.invoke('cowork:session:list', []);
  assert.equal(followUp.ok, true);
});

test('ws: invoke burst over 100 → RATE_LIMITED (retryable)', async (t) => {
  const { handle } = await startServer(t);
  const client = await openClient(handle.port);
  t.after(() => client.close());
  await client.welcome();
  const results = await Promise.all(
    Array.from({ length: 110 }, (_, i) => client.invoke('cowork:session:list', [i])),
  );
  const rateLimited = results.filter((r) => r.ok === false && r.error.code === 'RATE_LIMITED');
  assert.ok(rateLimited.length > 0, 'expected at least one RATE_LIMITED result');
  assert.ok(rateLimited.every((r) => r.error.retryable === true));
  assert.equal(results.length, 110, 'every invoke still gets exactly one result');
});

test('ws: more than 32 in-flight invokes → RATE_LIMITED, earlier ones keep running', async (t) => {
  const { handle } = await startServer(t, {
    gateway: { defaultTimeoutMs: 5000 },
    invokeHandler: () => new Promise(() => {}), // never resolves
  });
  const client = await openClient(handle.port);
  t.after(() => client.close());
  await client.welcome();
  for (let i = 1; i <= 32; i += 1) {
    client.sendRaw(JSON.stringify({ v: 1, type: 'invoke', id: `cap-${i}`, channel: 'cowork:session:list', args: [] }));
  }
  // The 33rd invoke exceeds the in-flight cap of 32.
  const capped = await client.invoke('cowork:session:list', []);
  assert.equal(capped.ok, false);
  assert.equal(capped.error.code, 'RATE_LIMITED');
  // The 32 in-flight invokes must not have produced results yet.
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(client.events.length, 0, 'no results or events while handlers hang');
});

test('ws: a 4th concurrent socket is closed with 4009', async (t) => {
  const { handle } = await startServer(t);
  const clients = [];
  for (let i = 0; i < 3; i += 1) {
    const client = await openClient(handle.port, { clientId: `phone-${i}` });
    clients.push(client);
  }
  t.after(async () => {
    for (const client of clients) await client.close();
  });
  const closed = await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${handle.port}/gateway/v1/ws`, {
      headers: { 'X-IDBots-Gateway-Secret': SECRET, 'X-IDBots-Client-Id': 'phone-4' },
    });
    const timer = setTimeout(() => reject(new Error('4th socket was not closed')), 3000);
    ws.on('close', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
    ws.on('error', reject);
  });
  assert.equal(closed, 4009);
});

// ---------------------------------------------------------------------------
// Timeouts
// ---------------------------------------------------------------------------

test('ws: slow handler → TIMEOUT (retryable), late resolution produces no second frame', async (t) => {
  let lateResolve;
  const { handle } = await startServer(t, {
    gateway: { defaultTimeoutMs: 80 },
    invokeHandler: () =>
      new Promise((resolve) => {
        lateResolve = () => resolve({ late: true });
      }),
  });
  const client = await openClient(handle.port);
  t.after(() => client.close());
  await client.welcome();
  const result = await client.invoke('cowork:session:list', []);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'TIMEOUT');
  assert.equal(result.error.retryable, true);
  // Let the handler finish in the background: no duplicate result may arrive.
  lateResolve();
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(client.events.length, 0, 'late handler completion must not send a second frame');
});

test('ws: throwing handler → HANDLER_ERROR with the message, retryable false', async (t) => {
  const { handle } = await startServer(t, {
    invokeHandler: async () => {
      throw new Error('boom in handler');
    },
  });
  const client = await openClient(handle.port);
  t.after(() => client.close());
  await client.welcome();
  const result = await client.invoke('cowork:session:list', []);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'HANDLER_ERROR');
  assert.equal(result.error.message, 'boom in handler');
  assert.equal(result.error.retryable, false);
});

// ---------------------------------------------------------------------------
// Readiness gate
// ---------------------------------------------------------------------------

test('ws: bootstrapping tenant → TENANT_NOT_READY (retryable) except bootstrap channels', async (t) => {
  const { handle, calls } = await startServer(t, {
    readinessOverrides: { phase: 'bootstrapping' },
  });
  const client = await openClient(handle.port);
  t.after(() => client.close());
  const welcome = await client.welcome();
  assert.equal(welcome.ready, false);
  assert.equal(welcome.phase, 'bootstrapping');
  const blocked = await client.invoke('cowork:session:list', []);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error.code, 'TENANT_NOT_READY');
  assert.equal(blocked.error.retryable, true);
  const allowed = await client.invoke('app:getVersion', []);
  assert.equal(allowed.ok, true);
  const bootstrapStatus = await client.invoke('mobile:bootstrap:status', []);
  assert.equal(bootstrapStatus.ok, true);
  assert.equal(calls.length, 2);
});

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

test('ws: allowlisted events fan out to every socket; denied and other-key store:changed do not', async (t) => {
  const { handle, broadcast } = await startServer(t);
  const clientA = await openClient(handle.port, { clientId: 'a' });
  const clientB = await openClient(handle.port, { clientId: 'b' });
  t.after(async () => {
    await clientA.close();
    await clientB.close();
  });
  await clientA.welcome();
  await clientB.welcome();

  broadcast('cowork:stream:message', [{ text: 'hello from main' }]);
  const eventA = await clientA.nextEvent((frame) => frame.type === 'event' && frame.channel === 'cowork:stream:message');
  const eventB = await clientB.nextEvent((frame) => frame.type === 'event' && frame.channel === 'cowork:stream:message');
  for (const event of [eventA, eventB]) {
    assert.equal(event.v, 1);
    assert.deepEqual(event.args, [{ text: 'hello from main' }]);
  }

  // N-tier event: never forwarded.
  broadcast('window:state-changed', [{ maximized: true }]);
  // store:changed for a key other than app_config: not forwarded.
  broadcast('store:changed', [{ key: 'other_key' }]);
  // P2 event while running at tier P1: not forwarded.
  broadcast('metatask:update', [{ id: 1 }]);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(clientA.events.length, 0, 'denied events must not reach socket A');
  assert.equal(clientB.events.length, 0, 'denied events must not reach socket B');

  // store:changed for app_config is forwarded.
  broadcast('store:changed', [{ key: 'app_config' }]);
  await clientA.nextEvent((frame) => frame.type === 'event' && frame.channel === 'store:changed');
  await clientB.nextEvent((frame) => frame.type === 'event' && frame.channel === 'store:changed');
});

test('ws: store:changed app_config values are defensively redacted', async (t) => {
  const { handle, broadcast } = await startServer(t);
  const client = await openClient(handle.port);
  t.after(() => client.close());
  await client.welcome();
  broadcast('store:changed', [{ key: 'app_config', value: { providers: { deepseek: { apiKey: 'sk-secret' } } } }]);
  const event = await client.nextEvent((frame) => frame.type === 'event' && frame.channel === 'store:changed');
  assert.equal(event.args[0].value.providers.deepseek.apiKey, '__redacted__');
});

// ---------------------------------------------------------------------------
// File route
// ---------------------------------------------------------------------------

test('http: file route streams with Range support; tampered/wrong-tenant/expired tokens 404', async (t) => {
  const { handle, paths } = await startServer(t);
  const reportPath = path.join(paths.dataRoot, 'docs', 'report.md');
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, '# quarterly report\n0123456789');

  const token = tokens.signFileToken(SECRET, TENANT, reportPath, 'attachment', Date.now() + 60_000);

  const full = await httpRequest(handle.port, 'GET', `/gateway/v1/files/${token}`);
  assert.equal(full.status, 200);
  assert.equal(await full.text(), '# quarterly report\n0123456789');
  assert.equal(full.headers.get('content-type'), 'text/markdown');
  assert.match(full.headers.get('content-disposition'), /^attachment; filename="report\.md"$/);
  assert.equal(full.headers.get('accept-ranges'), 'bytes');

  const ranged = await httpRequest(handle.port, 'GET', `/gateway/v1/files/${token}`, {
    headers: { Range: 'bytes=0-3' },
  });
  assert.equal(ranged.status, 206);
  assert.equal(await ranged.text(), '# qu');
  assert.equal(ranged.headers.get('content-range'), `bytes 0-3/${fs.statSync(reportPath).size}`);
  assert.equal(Number(ranged.headers.get('content-length')), 4);

  const suffix = await httpRequest(handle.port, 'GET', `/gateway/v1/files/${token}`, {
    headers: { Range: 'bytes=-4' },
  });
  assert.equal(suffix.status, 206);
  assert.equal(await suffix.text(), '6789');

  const unsatisfiable = await httpRequest(handle.port, 'GET', `/gateway/v1/files/${token}`, {
    headers: { Range: 'bytes=99999-' },
  });
  assert.equal(unsatisfiable.status, 416);
  assert.equal(unsatisfiable.headers.get('content-range'), `bytes */${fs.statSync(reportPath).size}`);

  // Tampered signature.
  const [payload, sig] = token.split('.');
  const tampered = `${payload}.${sig.startsWith('A') ? `B${sig.slice(1)}` : `A${sig.slice(1)}`}`;
  assert.equal((await httpRequest(handle.port, 'GET', `/gateway/v1/files/${tampered}`)).status, 404);
  // Another tenant's token.
  const otherTenant = tokens.signFileToken(SECRET, 't_someoneelse000000001', reportPath, 'attachment', Date.now() + 60_000);
  assert.equal((await httpRequest(handle.port, 'GET', `/gateway/v1/files/${otherTenant}`)).status, 404);
  // Expired token.
  const expired = tokens.signFileToken(SECRET, TENANT, reportPath, 'attachment', Date.now() - 1);
  assert.equal((await httpRequest(handle.port, 'GET', `/gateway/v1/files/${expired}`)).status, 404);
  // Missing file.
  const missing = tokens.signFileToken(SECRET, TENANT, path.join(paths.dataRoot, 'gone.md'), 'attachment', Date.now() + 60_000);
  assert.equal((await httpRequest(handle.port, 'GET', `/gateway/v1/files/${missing}`)).status, 404);
});

test('http: file route never reaches the handler for bad tokens (no leaks in responses)', async (t) => {
  const { handle } = await startServer(t, {
    gateway: { hasHandler: () => true },
  });
  // A token whose payload is not even valid base64url JSON must 404 cleanly.
  assert.equal((await httpRequest(handle.port, 'GET', '/gateway/v1/files/not-a-token')).status, 404);
  assert.equal((await httpRequest(handle.port, 'GET', '/gateway/v1/files/')).status, 404);
});

test('F-11: authorized downloads of office/pdf documents carry the correct content-type', async (t) => {
  const { handle, paths } = await startServer(t);
  const cases = [
    ['report.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['移动端验收测试 A-04.pdf', 'application/pdf'],
    ['sheet.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ['deck.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  ];
  for (const [name, expectedMime] of cases) {
    const filePath = path.join(paths.dataRoot, 'docs', name);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, 'PK\u0003\u0004 document bytes');
    const token = tokens.signFileToken(SECRET, TENANT, filePath, 'attachment', Date.now() + 60_000);
    const res = await httpRequest(handle.port, 'GET', `/gateway/v1/files/${token}`);
    assert.equal(res.status, 200, name);
    assert.equal(res.headers.get('content-type'), expectedMime, name);
    if (/^[\x20-\x7E]+$/.test(name)) {
      assert.equal(res.headers.get('content-disposition'), `attachment; filename="${name}"`);
    } else {
      // Non-ASCII basenames ship the RFC 5987 form.
      assert.match(
        res.headers.get('content-disposition'),
        new RegExp(`^attachment; filename="download"; filename\\*=UTF-8''${encodeURIComponent(name)}$`),
      );
    }
  }
});

test('http: inline MetaApp resources render with browser MIME while attachments stay downloads', async (t) => {
  const { handle, paths } = await startServer(t);
  const cases = [
    ['index.html', 'text/html; charset=utf-8'],
    ['data-entries.js', 'text/javascript; charset=utf-8'],
    ['styles.css', 'text/css; charset=utf-8'],
    ['font.woff2', 'font/woff2'],
  ];
  for (const [name, expectedMime] of cases) {
    const filePath = path.join(paths.dataRoot, 'metaapp', name);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${name} bytes`);
    const token = tokens.signFileToken(SECRET, TENANT, filePath, 'inline', Date.now() + 60_000);
    const res = await httpRequest(handle.port, 'GET', `/gateway/v1/files/${token}`);
    assert.equal(res.status, 200, name);
    assert.equal(res.headers.get('content-type'), expectedMime, name);
    assert.equal(res.headers.get('content-disposition'), `inline; filename="${name}"`);
  }

  const attachmentToken = tokens.signFileToken(
    SECRET,
    TENANT,
    path.join(paths.dataRoot, 'metaapp', 'index.html'),
    'attachment',
    Date.now() + 60_000,
  );
  const attachment = await httpRequest(handle.port, 'GET', `/gateway/v1/files/${attachmentToken}`);
  assert.equal(attachment.headers.get('content-type'), 'application/octet-stream');
  assert.match(attachment.headers.get('content-disposition'), /^attachment; filename="index\.html"$/);
});

// ---------------------------------------------------------------------------
// Upload route
// ---------------------------------------------------------------------------

test('http: upload stores under uploads/{yyyy-mm-dd}/{uuid}-{name} and reports path/size/mime', async (t) => {
  const { handle, paths } = await startServer(t);
  const res = await httpRequest(handle.port, 'POST', `/gateway/v1/upload?name=${encodeURIComponent('hello world.txt')}`, {
    headers: { 'Content-Type': 'text/plain' },
    body: 'hello upload',
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.size, 12);
  assert.equal(body.mime, 'text/plain');
  assert.ok(body.path.startsWith(paths.uploadsRoot + path.sep), 'stored under the uploads root');
  assert.ok(
    body.path.startsWith(path.join(paths.uploadsRoot, localDateStamp()) + path.sep),
    'stored under the local-date day folder',
  );
  assert.match(path.basename(body.path), /^\w{8}-\w{4}-\w{4}-\w{4}-\w{12}-hello world\.txt$/);
  assert.equal(fs.readFileSync(body.path, 'utf8'), 'hello upload');
});

test('http: upload blocks executables (415), rejects oversize bodies (413)', async (t) => {
  const { handle, paths } = await startServer(t);

  const blocked = await httpRequest(handle.port, 'POST', '/gateway/v1/upload?name=evil.exe', {
    headers: { 'Content-Type': 'application/octet-stream' },
    body: 'MZ',
  });
  assert.equal(blocked.status, 415);

  const blockedByMime = await httpRequest(handle.port, 'POST', '/gateway/v1/upload?name=blob.bin', {
    headers: { 'Content-Type': 'application/x-msdownload' },
    body: 'MZ',
  });
  assert.equal(blockedByMime.status, 415);

  const oversize = await httpRequest(handle.port, 'POST', '/gateway/v1/upload?name=big.bin', {
    headers: { 'Content-Type': 'application/octet-stream' },
    body: Buffer.alloc(25 * 1024 * 1024 + 1, 1),
  });
  assert.equal(oversize.status, 413);

  // No partial file may survive a failed upload.
  const dayDir = path.join(paths.uploadsRoot, localDateStamp());
  if (fs.existsSync(dayDir)) {
    assert.equal(fs.readdirSync(dayDir).length, 0, 'failed uploads leave no partial files');
  }
});

// ---------------------------------------------------------------------------
// Sensitive route
// ---------------------------------------------------------------------------

test('http: reveal-mnemonic verifies the reverify token, answers no-store, and audits without the mnemonic', async (t) => {
  const revealCalls = [];
  const { handle, logs } = await startServer(t, {
    revealMnemonic: async (target) => {
      revealCalls.push(target);
      return target.target === 'user' ? 'user mnemonic words' : `metabot ${target.metabotId} mnemonic`;
    },
  });
  const token = tokens.signReverifyToken(SECRET, TENANT, 'reveal-mnemonic', Date.now() + 120_000, 'nonce-ok');

  const res = await httpRequest(handle.port, 'POST', '/gateway/v1/sensitive/reveal-mnemonic', {
    headers: { 'X-IDBots-Reverify': token, 'X-IDBots-Client-Id': 'phone-7' },
    body: JSON.stringify({ target: 'user' }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await res.json(), { mnemonic: 'user mnemonic words' });
  assert.deepEqual(revealCalls, [{ target: 'user' }]);

  const audit = logs.find((entry) => entry.component === 'gateway.sensitive' && entry.level === 'info');
  assert.ok(audit, 'audit line captured');
  assert.equal(audit.extra.target, 'user');
  assert.equal(audit.extra.clientId, 'phone-7');
  assert.equal(typeof audit.extra.ts, 'number');
  for (const entry of logs) {
    assert.equal(JSON.stringify(entry).includes('user mnemonic words'), false, 'mnemonic must never appear in logs');
  }

  // Metabot target.
  const token2 = tokens.signReverifyToken(SECRET, TENANT, 'reveal-mnemonic', Date.now() + 120_000, 'nonce-mb');
  const metabotRes = await httpRequest(handle.port, 'POST', '/gateway/v1/sensitive/reveal-mnemonic', {
    headers: { 'X-IDBots-Reverify': token2 },
    body: JSON.stringify({ target: 'metabot', metabotId: 3 }),
  });
  assert.equal(metabotRes.status, 200);
  assert.deepEqual(await metabotRes.json(), { mnemonic: 'metabot 3 mnemonic' });
  assert.deepEqual(revealCalls[1], { target: 'metabot', metabotId: 3 });

  // Malformed bodies.
  const token3 = tokens.signReverifyToken(SECRET, TENANT, 'reveal-mnemonic', Date.now() + 120_000, 'nonce-bad');
  const badBody = await httpRequest(handle.port, 'POST', '/gateway/v1/sensitive/reveal-mnemonic', {
    headers: { 'X-IDBots-Reverify': token3 },
    body: JSON.stringify({ target: 'unknown' }),
  });
  assert.equal(badBody.status, 400);
});

test('http: reveal-mnemonic rejects reused nonces and wrong-purpose tokens (403)', async (t) => {
  const { handle } = await startServer(t);
  const token = tokens.signReverifyToken(SECRET, TENANT, 'reveal-mnemonic', Date.now() + 120_000, 'nonce-reuse');
  const headers = { 'X-IDBots-Reverify': token };
  const first = await httpRequest(handle.port, 'POST', '/gateway/v1/sensitive/reveal-mnemonic', {
    headers,
    body: JSON.stringify({ target: 'user' }),
  });
  assert.equal(first.status, 200);
  const reuse = await httpRequest(handle.port, 'POST', '/gateway/v1/sensitive/reveal-mnemonic', {
    headers,
    body: JSON.stringify({ target: 'user' }),
  });
  assert.equal(reuse.status, 403, 'reused nonce rejected');

  const wrongPurpose = tokens.signReverifyToken(SECRET, TENANT, 'some-other-purpose', Date.now() + 120_000, 'nonce-wp');
  const wrong = await httpRequest(handle.port, 'POST', '/gateway/v1/sensitive/reveal-mnemonic', {
    headers: { 'X-IDBots-Reverify': wrongPurpose },
    body: JSON.stringify({ target: 'user' }),
  });
  assert.equal(wrong.status, 403, 'wrong-purpose token rejected');

  const missing = await httpRequest(handle.port, 'POST', '/gateway/v1/sensitive/reveal-mnemonic', {
    body: JSON.stringify({ target: 'user' }),
  });
  assert.equal(missing.status, 403, 'missing reverify header rejected');
});

// ---------------------------------------------------------------------------
// Static bundle
// ---------------------------------------------------------------------------

test('http: /app/* 404s without a static bundle dir', async (t) => {
  const { handle } = await startServer(t);
  const res = await httpRequest(handle.port, 'GET', '/app/index.html');
  assert.equal(res.status, 404);
});

test('http: /app/* serves the bundle with index no-cache and hashed assets immutable', async (t) => {
  const bundle = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-bundle-')));
  t.after(() => fs.rmSync(bundle, { recursive: true, force: true }));
  fs.writeFileSync(path.join(bundle, 'index.html'), '<html><body>mobile</body></html>');
  fs.writeFileSync(path.join(bundle, 'app-DiWRgTda.js'), 'console.log(1)');
  fs.writeFileSync(path.join(bundle, 'logo.png'), 'png');

  const { handle } = await startServer(t, { gateway: { staticBundleDir: bundle } });

  const index = await httpRequest(handle.port, 'GET', '/app/');
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-type'), /text\/html/);
  assert.equal(index.headers.get('cache-control'), 'no-cache');
  assert.equal(await index.text(), '<html><body>mobile</body></html>');

  const indexExplicit = await httpRequest(handle.port, 'GET', '/app/index.html');
  assert.equal(indexExplicit.status, 200);
  assert.equal(indexExplicit.headers.get('cache-control'), 'no-cache');

  const hashed = await httpRequest(handle.port, 'GET', '/app/app-DiWRgTda.js');
  assert.equal(hashed.status, 200);
  assert.equal(hashed.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  // MIME regression (2026-10-24 white screen): module scripts must be
  // text/javascript. The pre-fix logic served application/octet-stream here
  // and Chrome refused to execute the bundle.
  assert.equal(hashed.headers.get('content-type'), 'text/javascript; charset=utf-8');

  const unhashed = await httpRequest(handle.port, 'GET', '/app/logo.png');
  assert.equal(unhashed.status, 200);
  assert.equal(unhashed.headers.get('cache-control'), 'no-cache');
  assert.equal(unhashed.headers.get('content-type'), 'image/png');

  const traversal = await httpRequest(handle.port, 'GET', `/app/${encodeURIComponent('..')}/${encodeURIComponent('..')}/secret.txt`);
  assert.equal(traversal.status, 404);

  const missing = await httpRequest(handle.port, 'GET', '/app/nope.txt');
  assert.equal(missing.status, 404);
});

test('http: /app/* bundle MIME — browser-executable types for js/css/webmanifest; signed downloads still octet-stream', async (t) => {
  // Negative control: against the pre-fix bundle route (`.html` ternary +
  // mimeForPath from fileSign.ts) each bundle assertion below fails with
  // `application/octet-stream` — verified red on 2026-10-24 before the fix
  // landed (see the fix commit message for the captured red run).
  const bundle = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-bundle-mime-')));
  t.after(() => fs.rmSync(bundle, { recursive: true, force: true }));
  fs.writeFileSync(path.join(bundle, 'index-Cj2fQa9x.js'), 'export default 1');
  fs.writeFileSync(path.join(bundle, 'index-Km3vTz8y.css'), 'body{margin:0}');
  fs.writeFileSync(path.join(bundle, 'manifest.webmanifest'), '{"name":"IDBots"}');

  const { handle } = await startServer(t, { gateway: { staticBundleDir: bundle } });

  const script = await httpRequest(handle.port, 'GET', '/app/index-Cj2fQa9x.js');
  assert.equal(script.status, 200);
  assert.equal(script.headers.get('content-type'), 'text/javascript; charset=utf-8');

  const style = await httpRequest(handle.port, 'GET', '/app/index-Km3vTz8y.css');
  assert.equal(style.status, 200);
  assert.equal(style.headers.get('content-type'), 'text/css; charset=utf-8');

  const manifest = await httpRequest(handle.port, 'GET', '/app/manifest.webmanifest');
  assert.equal(manifest.status, 200);
  assert.equal(manifest.headers.get('content-type'), 'application/manifest+json');

  // Control: the signed download route keeps its download semantics — a .js
  // file downloads as application/octet-stream by design (fileSign.ts).
  const { paths } = makeTenantTree(t);
  const downloadPath = path.join(paths.dataRoot, 'exports', 'session-log.js');
  fs.mkdirSync(path.dirname(downloadPath), { recursive: true });
  fs.writeFileSync(downloadPath, 'console.log("not a page")');
  const token = tokens.signFileToken(SECRET, TENANT, downloadPath, 'attachment', Date.now() + 60_000);

  const download = await httpRequest(handle.port, 'GET', `/gateway/v1/files/${token}`);
  assert.equal(download.status, 200);
  assert.equal(download.headers.get('content-type'), 'application/octet-stream');
  assert.match(download.headers.get('content-disposition'), /^attachment; filename="session-log\.js"$/);
});

// ---------------------------------------------------------------------------
// close()
// ---------------------------------------------------------------------------

test('close(): shuts the server down and terminates open sockets with 4012', async (t) => {
  const { base, paths } = makeTenantTree(t);
  const handle = await server.startGateway({
    host: '127.0.0.1',
    port: 0,
    secret: SECRET,
    tenantId: TENANT,
    tier: 'P1',
    contractVersion: '1.0.0',
    appVersion: '0.0.0-test',
    commit: 'testcommit',
    paths,
    readiness: () => readyState(),
    invokeHandler: async () => ({ ok: true }),
    hasHandler: () => true,
    addBroadcastListener: () => () => {},
    revealMnemonic: async () => 'mnemonic',
    logger: () => {},
  });
  const client = await openClient(handle.port);
  await client.welcome();
  const closePromise = handle.close({ code: 4012, reason: 'test shutdown' });
  const code = await new Promise((resolve) => {
    client.ws.on('close', (closeCode) => resolve(closeCode));
  });
  await closePromise;
  assert.equal(code, 4012);
  await assert.rejects(() => httpRequest(handle.port, 'GET', '/healthz', { secret: null }), /fetch failed/);
  fs.rmSync(base, { recursive: true, force: true });
});
