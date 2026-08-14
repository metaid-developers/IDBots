/**
 * Phase 4 (SDD R4.1) memory gateway route tests.
 *
 * Two levels:
 *   1. pure route-logic tests — `handleMemoryListRoute` /
 *      `handleMemoryCreateRoute` (memoryGatewayRoutes.ts) driven by a real
 *      CoworkStore over an in-memory sql.js database: create + list round-trip
 *      and every validation error path,
 *   2. one integration test — boots the REAL metaidRpcServer (mocked electron
 *      + listenWithRetry, same pattern as metaidRpcWalletRoutes.test.mjs) and
 *      exercises POST /api/idbots/memory/create and /api/idbots/memory/list
 *      over real HTTP, proving the routes are wired into the gateway chain.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import Module from 'node:module';
import { createRequire } from 'node:module';
import { createCoworkStore, createSqliteStore, getRow } from './memoryTestUtils.mjs';

const require = createRequire(import.meta.url);

function resolveCompiledModulePath(relative) {
  const candidates = [`../dist-electron/main/${relative}`, `../dist-electron/${relative}`];
  for (const candidate of candidates) {
    try {
      return require.resolve(candidate);
    } catch {
      // Try next compile output layout.
    }
  }
  return require.resolve(candidates[0]);
}

const {
  handleMemoryCreateRoute,
  handleMemoryListRoute,
} = require(resolveCompiledModulePath('services/memoryGatewayRoutes.js'));

const createBody = (overrides = {}) => JSON.stringify({
  metabot_id: 1,
  text: 'The client prefers concise replies',
  ...overrides,
});

async function makeMemoryBackend() {
  const { db, cleanup } = await createSqliteStore();
  const coworkStore = createCoworkStore(db);
  return { db, coworkStore, cleanup };
}

test('create + list round-trip persists a camelCase memory entry', async () => {
  const { coworkStore, cleanup } = await makeMemoryBackend();
  try {
    const created = handleMemoryCreateRoute(
      () => coworkStore,
      createBody({
        scope: { kind: 'contact', key: 'metaweb_private:peer:peer-123' },
        usage_class: 'preference',
        is_explicit: true,
      }),
    );
    assert.equal(created.status, 200);
    assert.equal(created.body.success, true);
    const memory = created.body.memory;
    assert.equal(typeof memory.id, 'string');
    assert.equal(memory.text, 'The client prefers concise replies');
    assert.equal(memory.scopeKind, 'contact');
    assert.equal(memory.scopeKey, 'metaweb_private:peer:peer-123');
    assert.equal(memory.usageClass, 'preference');
    assert.equal(memory.origin, 'conversation');
    assert.equal(memory.isExplicit, true);
    assert.equal(memory.status, 'created');

    const listed = handleMemoryListRoute(() => coworkStore, JSON.stringify({
      metabot_id: 1,
      scope: { kind: 'contact', key: 'metaweb_private:peer:peer-123' },
    }));
    assert.equal(listed.status, 200);
    assert.equal(listed.body.success, true);
    assert.ok(Array.isArray(listed.body.memories));
    assert.equal(listed.body.memories.length, 1);
    assert.equal(listed.body.memories[0].id, memory.id);
  } finally {
    cleanup();
  }
});

test('owner scope defaults to owner:self when scope.kind is owner without a key', async () => {
  const { coworkStore, cleanup } = await makeMemoryBackend();
  try {
    const created = handleMemoryCreateRoute(
      () => coworkStore,
      createBody({ scope: { kind: 'owner' } }),
    );
    assert.equal(created.status, 200);
    assert.equal(created.body.memory.scopeKind, 'owner');
    assert.equal(created.body.memory.scopeKey, 'owner:self');
  } finally {
    cleanup();
  }
});

test('no scope falls back to the owner scope', async () => {
  const { coworkStore, cleanup } = await makeMemoryBackend();
  try {
    const created = handleMemoryCreateRoute(() => coworkStore, createBody());
    assert.equal(created.status, 200);
    assert.equal(created.body.memory.scopeKind, 'owner');
    assert.equal(created.body.memory.scopeKey, 'owner:self');
  } finally {
    cleanup();
  }
});

test('list filters by scope, status, usage_class and query', async () => {
  const { coworkStore, cleanup } = await makeMemoryBackend();
  try {
    handleMemoryCreateRoute(() => coworkStore, createBody({
      text: 'owner memory one',
      scope: { kind: 'owner' },
      usage_class: 'profile_fact',
    }));
    handleMemoryCreateRoute(() => coworkStore, createBody({
      text: 'owner memory two',
      scope: { kind: 'owner' },
      usage_class: 'preference',
    }));
    handleMemoryCreateRoute(() => coworkStore, createBody({
      text: 'contact memory',
      scope: { kind: 'contact', key: 'metaweb_private:peer:peer-9' },
    }));

    // The unscoped list defaults to the owner scope (backend contract), so the
    // contact memory is only visible through an explicit contact scope.
    const all = handleMemoryListRoute(() => coworkStore, JSON.stringify({ metabot_id: 1 }));
    assert.equal(all.body.memories.length, 2);

    const contactScope = handleMemoryListRoute(() => coworkStore, JSON.stringify({
      metabot_id: 1,
      scope: { kind: 'contact', key: 'metaweb_private:peer:peer-9' },
    }));
    assert.deepEqual(contactScope.body.memories.map((m) => m.text), ['contact memory']);

    const ownerOnly = handleMemoryListRoute(() => coworkStore, JSON.stringify({
      metabot_id: 1,
      scope: { kind: 'owner' },
    }));
    assert.equal(ownerOnly.body.memories.length, 2);

    const preferenceOnly = handleMemoryListRoute(() => coworkStore, JSON.stringify({
      metabot_id: 1,
      usage_class: 'preference',
    }));
    assert.deepEqual(preferenceOnly.body.memories.map((m) => m.text), ['owner memory two']);

    const queryHit = handleMemoryListRoute(() => coworkStore, JSON.stringify({
      metabot_id: 1,
      query: 'memory two',
    }));
    assert.deepEqual(queryHit.body.memories.map((m) => m.text), ['owner memory two']);

    const statusCreated = handleMemoryListRoute(() => coworkStore, JSON.stringify({
      metabot_id: 1,
      status: 'created',
    }));
    assert.equal(statusCreated.body.memories.length, 2, 'unscoped status filter stays inside the owner scope');
  } finally {
    cleanup();
  }
});

test('create with a source provenance records a source row', async () => {
  const { db, coworkStore, cleanup } = await makeMemoryBackend();
  try {
    const created = handleMemoryCreateRoute(() => coworkStore, createBody({
      origin: 'dream',
      source: { session_id: 'sess-1', role: 'assistant', source_type: 'dream', dream_date: '2026-08-01' },
    }));
    assert.equal(created.status, 200);
    assert.equal(created.body.memory.origin, 'dream');
    const sourceRow = getRow(
      db,
      'SELECT session_id, role, source_type, dream_date FROM user_memory_sources WHERE memory_id = ?',
      [created.body.memory.id],
    );
    assert.equal(sourceRow.session_id, 'sess-1');
    assert.equal(sourceRow.role, 'assistant');
    assert.equal(sourceRow.source_type, 'dream');
    assert.equal(sourceRow.dream_date, '2026-08-01');
  } finally {
    cleanup();
  }
});

test('validation: invalid JSON body is rejected with 400', async () => {
  const { coworkStore, cleanup } = await makeMemoryBackend();
  try {
    const result = handleMemoryCreateRoute(() => coworkStore, '{not json');
    assert.equal(result.status, 400);
    assert.equal(result.body.success, false);
    assert.match(result.body.error, /Invalid JSON/);
  } finally {
    cleanup();
  }
});

test('validation: missing metabot_id is rejected with 400', async () => {
  const { coworkStore, cleanup } = await makeMemoryBackend();
  try {
    for (const body of ['{}', JSON.stringify({ text: 'no bot' }), JSON.stringify({ metabot_id: -1 })]) {
      const result = handleMemoryCreateRoute(() => coworkStore, body);
      assert.equal(result.status, 400, body);
      assert.match(result.body.error, /metabot_id/);
    }
  } finally {
    cleanup();
  }
});

test('validation: empty text is rejected with 400', async () => {
  const { coworkStore, cleanup } = await makeMemoryBackend();
  try {
    for (const bad of [undefined, '', '   ']) {
      const result = handleMemoryCreateRoute(
        () => coworkStore,
        createBody(bad === undefined ? { text: undefined } : { text: bad }),
      );
      assert.equal(result.status, 400, JSON.stringify(bad));
      assert.equal(result.body.error, 'text is required');
    }
  } finally {
    cleanup();
  }
});

test('validation: invalid status / usage_class / scope kind / contact-key are typed 400s', async () => {
  const { coworkStore, cleanup } = await makeMemoryBackend();
  try {
    const badStatus = handleMemoryListRoute(() => coworkStore, JSON.stringify({ metabot_id: 1, status: 'bogus' }));
    assert.equal(badStatus.status, 400);
    assert.match(badStatus.body.error, /status/);

    const badUsage = handleMemoryListRoute(() => coworkStore, JSON.stringify({ metabot_id: 1, usage_class: 'nope' }));
    assert.equal(badUsage.status, 400);
    assert.match(badUsage.body.error, /usage_class/);

    const badScopeKind = handleMemoryCreateRoute(() => coworkStore, createBody({ scope: { kind: 'planet' } }));
    assert.equal(badScopeKind.status, 400);
    assert.match(badScopeKind.body.error, /scope\.kind/);

    const contactWithoutKey = handleMemoryCreateRoute(() => coworkStore, createBody({ scope: { kind: 'contact' } }));
    assert.equal(contactWithoutKey.status, 400);
    assert.match(contactWithoutKey.body.error, /scope\.key/);

    const keyWithoutKind = handleMemoryCreateRoute(() => coworkStore, createBody({ scope: { key: 'x' } }));
    assert.equal(keyWithoutKind.status, 400);
    assert.match(keyWithoutKind.body.error, /scope\.kind/);

    const badOrigin = handleMemoryCreateRoute(() => coworkStore, createBody({ origin: 'hallucination' }));
    assert.equal(badOrigin.status, 400);
    assert.match(badOrigin.body.error, /origin/);

    const badVisibility = handleMemoryCreateRoute(() => coworkStore, createBody({ visibility: 'public' }));
    assert.equal(badVisibility.status, 400);
    assert.match(badVisibility.body.error, /visibility/);
  } finally {
    cleanup();
  }
});

test('integration: real gateway routes memory create + list over HTTP', async () => {
  const { coworkStore, cleanup } = await makeMemoryBackend();
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') {
      return {
        app: {
          getPath() {
            return os.tmpdir();
          },
          getAppPath() {
            return process.cwd();
          },
        },
        BrowserWindow: {
          getAllWindows() {
            return [];
          },
        },
      };
    }
    if (request === './httpListenWithRetry' || request.endsWith('/httpListenWithRetry')) {
      return {
        listenWithRetry(server, _port, host, options = {}) {
          server.listen(0, host, () => {
            if (typeof options.onListening === 'function') options.onListening();
          });
        },
      };
    }
    return originalLoad(request, parent, isMain);
  };

  let startMetaidRpcServer;
  try {
    const compiledRpcServerPath = resolveCompiledModulePath('services/metaidRpcServer.js');
    delete require.cache[compiledRpcServerPath];
    ({ startMetaidRpcServer } = require(compiledRpcServerPath));
  } finally {
    Module._load = originalLoad;
  }

  const server = startMetaidRpcServer(
    () => ({}),
    () => ({
      getDatabase() {
        return {};
      },
      getSaveFunction() {
        return () => {};
      },
    }),
    () => coworkStore,
    undefined,
  );

  try {
    await new Promise((resolve, reject) => {
      if (server.listening) {
        resolve();
        return;
      }
      server.once('listening', resolve);
      server.once('error', reject);
    });
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : null;
    assert.ok(port, 'server should bind a test port');
    const baseUrl = `http://127.0.0.1:${port}`;

    const post = (pathname, body) =>
      fetch(`${baseUrl}${pathname}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      });

    // create over HTTP
    const createResponse = await post('/api/idbots/memory/create', {
      metabot_id: 1,
      text: 'gateway round-trip memory',
      scope: { kind: 'owner' },
      usage_class: 'profile_fact',
    });
    assert.equal(createResponse.status, 200);
    const created = await createResponse.json();
    assert.equal(created.success, true);
    assert.equal(created.memory.text, 'gateway round-trip memory');
    assert.equal(created.memory.scopeKey, 'owner:self');

    // list over HTTP sees it
    const listResponse = await post('/api/idbots/memory/list', { metabot_id: 1 });
    assert.equal(listResponse.status, 200);
    const listed = await listResponse.json();
    assert.equal(listed.success, true);
    assert.deepEqual(listed.memories.map((m) => m.text), ['gateway round-trip memory']);

    // validation errors over HTTP
    const badResponse = await post('/api/idbots/memory/create', { metabot_id: 1 });
    assert.equal(badResponse.status, 400);
    const bad = await badResponse.json();
    assert.equal(bad.success, false);
    assert.equal(bad.error, 'text is required');

    const missingBot = await post('/api/idbots/memory/list', {});
    assert.equal(missingBot.status, 400);
  } finally {
    await new Promise((resolve) => server.close(() => resolve()));
    cleanup();
  }
});
