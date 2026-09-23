/**
 * Regression coverage for the gateway-wide JSON object body guard.
 *
 * Every POST route on the local MetaID RPC gateway used to read its own body
 * inline and then read a property off `JSON.parse(body)`. `JSON.parse` accepts
 * `null`, arrays and scalars, so such a body reached a property read that threw
 * inside the async request handler: the caller received NO response (the
 * request hung until it timed out) and the process logged an unhandled
 * rejection. This file drives the real compiled gateway over real HTTP, one
 * request per route, and asserts the guard's contract instead.
 *
 * The route list is derived from the server source, so a newly added POST route
 * is covered without touching this file, and the only allowed exception is
 * asserted explicitly.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import Module from 'node:module';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const RPC_SERVER_SOURCE = new URL('../src/main/services/metaidRpcServer.ts', import.meta.url);

/**
 * The one POST route this guard does not own: `/api/idbots/wallet/transfer`
 * gets the same treatment from the wallet-transfer field-contract change
 * (its rejections already carry a per-route contract), so keeping its inline
 * read here avoids two conflicting edits to the same hunk.
 */
const UNGUARDED_POST_ROUTES = ['/api/idbots/wallet/transfer'];

/**
 * Accepted body fields of the routes that advertise a field contract.
 *
 * Hard-coded from the routes' own validation logic on purpose: the test must
 * fail if the implementation's table drifts from what the routes actually read,
 * so it is not allowed to be derived from that table.
 */
const EXPECTED_FIELD_CONTRACTS = {
  '/api/idbots/resolve-metabot-id': ['name'],
  '/api/idbots/metabot/account-summary': ['metabot_id'],
  '/api/idbots/address/balance': ['addresses', 'metabot_id'],
  '/api/idbots/wallet/balance': ['address', 'chain', 'metabot_id', 'metabot_ids'],
  '/api/idbots/wallet/transfer/records': ['limit', 'metabot_id'],
  '/api/idbots/wallet/btc/sign-message': ['encoding', 'message', 'metabot_id'],
  '/api/idbots/wallet/mrc20/transfer': [
    'amount',
    'decimal',
    'fee_rate',
    'mrc20_id',
    'metabot_id',
    'symbol',
    'to_address',
  ],
  '/api/idbots/group-task/list': ['status'],
  '/api/idbots/group-task/show': ['before_id', 'limit', 'task_id', 'view'],
};

/**
 * Routes for which an empty body legitimately means `{}`, taken from the
 * baseline source: these parsed their body with `body || '{}'` on
 * `upstream/main` — the ten in this file plus five that delegate to
 * `chatGatewayRoutes.ts` / `memoryGatewayRoutes.ts`, whose own `parseJsonBody`
 * uses `rawBody || '{}'` — plus `/api/idbots/list-metabots`, which reads no body
 * at all. Every other route wrote a bare `JSON.parse(body)`, where an empty body
 * was a `SyntaxError` reported as 400 `Invalid JSON body` — so the guard keeps
 * that meaning instead of quietly turning an empty body into "no fields
 * supplied".
 *
 * Hard-coded on purpose (the implementation's own choice of policy is not the
 * reference), so a policy change on any route fails this test.
 */
const EMPTY_BODY_MEANS_OBJECT_ROUTES = [
  '/api/idbots/bot-browser/open',
  '/api/idbots/bot-browser/tabs',
  '/api/idbots/chat/group-history',
  '/api/idbots/chat/private-history',
  '/api/idbots/chat/private-send',
  '/api/idbots/group-task/export',
  '/api/idbots/group-task/list',
  '/api/idbots/group-task/search-candidates',
  '/api/idbots/group-task/search-remote-candidates',
  '/api/idbots/list-metabots',
  '/api/idbots/memory/create',
  '/api/idbots/memory/list',
  '/api/idbots/metabot/homepage/set-metaapp',
  '/api/idbots/wallet/balance',
  '/api/idbots/wallet/mvc/transfer',
  '/api/idbots/wallet/transfer/records',
];

const unhandledRejections = [];
process.on('unhandledRejection', (reason) => {
  unhandledRejections.push(reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason));
});

function readRpcServerSource() {
  return fs.readFileSync(RPC_SERVER_SOURCE, 'utf8');
}

/** Every POST route the gateway dispatches, read out of its own source. */
function listPostRoutes(source) {
  const constants = new Map();
  for (const match of source.matchAll(/^const ([A-Z0-9_]+_PATH) = '([^']+)';$/gm)) {
    constants.set(match[1], match[2]);
  }

  const routes = [];
  for (const match of source.matchAll(/req\.method === 'POST' && pathname === ([A-Z0-9_]+)\)/g)) {
    const routePath = constants.get(match[1]);
    assert.ok(routePath, `unresolved route constant in source: ${match[1]}`);
    routes.push(routePath);
  }

  // `/api/metaid/create-pin` is the fall-through route (negative guard), so the
  // pattern above cannot see it.
  const createPin = source.match(/req\.method !== 'POST' \|\| pathname !== '([^']+)'/);
  assert.ok(createPin, 'create-pin fall-through guard not found in the gateway source');
  routes.push(createPin[1]);

  return routes;
}

const POST_ROUTES = listPostRoutes(readRpcServerSource());
const GUARDED_POST_ROUTES = POST_ROUTES.filter((route) => !UNGUARDED_POST_ROUTES.includes(route));

/**
 * Routes whose request body is parsed by one of the delegated gateway route
 * modules rather than in `metaidRpcServer.ts` itself.
 *
 * Derived from the server source rather than hard-coded: a route is delegated
 * when its dispatch block calls a chat/memory gateway handler with the raw body
 * string. Those modules decide their own empty-body meaning (see the module
 * check below), so a behavioural review of this file alone cannot see it — the
 * first version of this guard mis-classified exactly these five routes.
 */
function listDelegatedBodyRoutes(source) {
  const constants = new Map();
  for (const match of source.matchAll(/^const ([A-Z0-9_]+_PATH) = '([^']+)';$/gm)) {
    constants.set(match[1], match[2]);
  }

  const guards = [];
  for (const match of source.matchAll(/if \(req\.method === 'POST' && pathname === ([A-Z0-9_]+)\) \{/g)) {
    guards.push({ name: match[1], start: match.index, end: source.length });
  }
  for (let i = 0; i < guards.length - 1; i += 1) guards[i].end = guards[i + 1].start;

  const delegated = [];
  for (const guard of guards) {
    const block = source.slice(guard.start, guard.end);
    if (/\((?:chatGatewayDeps|getMemoryBackend), body\)/.test(block)) {
      delegated.push(constants.get(guard.name));
    }
  }
  return delegated;
}

const DELEGATED_BODY_ROUTES = listDelegatedBodyRoutes(readRpcServerSource());

// Pin the bearer token for this process: the gateway mirrors its token into
// <userData>/metaid-rpc-token (userData is mocked to os.tmpdir() here) and
// adopts a leftover mirror, which would mismatch this run's client token.
process.env.IDBOTS_RPC_TOKEN = process.env.IDBOTS_RPC_TOKEN || 'test-rpc-token-body-guard';

function createMetabotStore() {
  return {
    getMetabotById(id) {
      if (id !== 1) return null;
      return {
        id: 1,
        name: 'Trader',
        mvc_address: '1MvcAddress',
        btc_address: '1BtcAddress',
        doge_address: 'DogeAddress',
        public_key: 'pub-key',
      };
    },
    getMetabotWalletByMetabotId(id) {
      if (id !== 1) return null;
      return { mnemonic: 'test mnemonic', path: "m/44'/10001'/0'/0/0" };
    },
  };
}

function resolveCompiledMetaidRpcServerPath() {
  return require.resolve('../dist-electron/main/services/metaidRpcServer.js');
}

function resolveCompiledMetaidRpcEndpointPath() {
  return require.resolve('../dist-electron/main/services/metaidRpcEndpoint.js');
}

const { getMetaidRpcToken } = require(resolveCompiledMetaidRpcEndpointPath());
const RPC_AUTH_HEADERS = {
  'Content-Type': 'application/json',
  Authorization: `Bearer ${getMetaidRpcToken()}`,
};

async function startRpcServerForTest() {
  const originalLoad = Module._load;
  Module._load = function patchedModuleLoad(request, parent, isMain) {
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
    const compiledPath = resolveCompiledMetaidRpcServerPath();
    delete require.cache[compiledPath];
    ({ startMetaidRpcServer } = require(compiledPath));
  } finally {
    Module._load = originalLoad;
  }

  const server = startMetaidRpcServer(
    () => createMetabotStore(),
    () => ({
      getDatabase() {
        return {};
      },
      getSaveFunction() {
        return () => {};
      },
    }),
    () => ({
      listUserMemories() {
        return [];
      },
      createUserMemory() {
        throw new Error('memory routes are not exercised in this test');
      },
    }),
  );

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
  if (!port) {
    server.close();
    throw new Error('failed to resolve test server port');
  }

  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

let server;
let baseUrl;

before(async () => {
  ({ server, baseUrl } = await startRpcServerForTest());
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

/**
 * POST a raw body. A request that never gets a response is reported as
 * `status: 0` instead of hanging the test run — that is exactly the failure
 * mode this file exists to catch.
 */
async function postRaw(route, rawBody) {
  try {
    const response = await fetch(`${baseUrl}${route}`, {
      method: 'POST',
      headers: RPC_AUTH_HEADERS,
      body: rawBody,
      signal: AbortSignal.timeout(4000),
    });
    return { status: response.status, json: await response.json() };
  } catch (err) {
    return { status: 0, json: null, transportError: `${err.name}: ${err.message}` };
  }
}

/**
 * The rejection contract every guarded route must carry: the converged union
 * shape `{ path, fields, body, schemaVersion: 1 }` — `fields` is always
 * listed (`{}` when the route advertises none), the body requirement is
 * stated, and `schemaVersion: 1` pins the shape for callers. Returns the list
 * of shape failures, so the sweeps can collect them per route.
 */
function contractShapeFailures(route, contract, label) {
  const failures = [];
  if (contract?.path !== route) {
    failures.push(`${label}: contract.path = ${JSON.stringify(contract?.path)}`);
  }
  const fields = contract?.fields;
  if (typeof fields !== 'object' || fields === null || Array.isArray(fields)) {
    failures.push(`${label}: contract.fields = ${JSON.stringify(fields)} (must always be listed)`);
  } else {
    const expected = [...(EXPECTED_FIELD_CONTRACTS[route] ?? [])].sort();
    const actual = Object.keys(fields).sort();
    if (actual.length !== expected.length || actual.some((key, i) => key !== expected[i])) {
      failures.push(`${label}: contract.fields keys = ${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`);
    }
  }
  if (contract?.body !== 'JSON object') failures.push(`${label}: contract.body = ${JSON.stringify(contract?.body)}`);
  if (contract?.schemaVersion !== 1) failures.push(`${label}: contract.schemaVersion = ${JSON.stringify(contract?.schemaVersion)}`);
  return failures;
}

test('gateway exposes the expected POST routes', () => {
  assert.ok(POST_ROUTES.length >= 30, `expected a full route sweep, got ${POST_ROUTES.length}`);
  assert.deepEqual(
    POST_ROUTES.filter((route) => !GUARDED_POST_ROUTES.includes(route)),
    UNGUARDED_POST_ROUTES,
    'the set of routes outside the shared body guard changed',
  );
});

test('every POST route rejects a JSON null body with 400, a contract, and a response', async () => {
  const failures = [];
  for (const route of GUARDED_POST_ROUTES) {
    const { status, json } = await postRaw(route, 'null');
    if (status !== 400) {
      failures.push(`${route}: status ${status} (expected 400)`);
      continue;
    }
    if (json?.success !== false) failures.push(`${route}: success !== false`);
    if (!/expected a JSON object \(received null\)/.test(String(json?.error))) {
      failures.push(`${route}: error = ${JSON.stringify(json?.error)}`);
    }
    if (json?.error_code !== 'BODY_NOT_OBJECT') {
      failures.push(`${route}: error_code = ${JSON.stringify(json?.error_code)}`);
    }
    failures.push(...contractShapeFailures(route, json?.contract, route));
  }
  assert.deepEqual(failures, [], `null-body sweep failures:\n${failures.join('\n')}`);
});

test('every POST route rejects non-object JSON literals instead of guessing fields', async () => {
  const cases = [
    { raw: '[1,2,3]', received: 'array' },
    { raw: '"a string"', received: 'string' },
    { raw: '42', received: 'number' },
    { raw: 'true', received: 'boolean' },
  ];
  const failures = [];
  for (const route of GUARDED_POST_ROUTES) {
    for (const { raw, received } of cases) {
      const { status, json } = await postRaw(route, raw);
      if (status !== 400) {
        failures.push(`${route} + ${raw}: status ${status} (expected 400)`);
        continue;
      }
      if (!new RegExp(`expected a JSON object \\(received ${received}\\)`).test(String(json?.error))) {
        failures.push(`${route} + ${raw}: error = ${JSON.stringify(json?.error)}`);
      }
      if (json?.error_code !== 'BODY_NOT_OBJECT') {
        failures.push(`${route} + ${raw}: error_code = ${JSON.stringify(json?.error_code)}`);
      }
      failures.push(...contractShapeFailures(route, json?.contract, `${route} + ${raw}`));
    }
  }
  assert.deepEqual(failures, [], `non-object sweep failures:\n${failures.join('\n')}`);
});

test('malformed JSON keeps the historical "Invalid JSON body" message', async () => {
  for (const route of ['/api/idbots/wallet/balance', '/api/idbots/resolve-metabot-id', '/api/idbots/group-task/show']) {
    const { status, json } = await postRaw(route, '{"metabot_id": ');
    assert.equal(status, 400, `${route} should reject malformed JSON`);
    assert.equal(json.error, 'Invalid JSON body');
    assert.equal(json.error_code, 'BODY_NOT_JSON');
    assert.deepEqual(contractShapeFailures(route, json.contract, route), [], `${route}: contract shape`);
  }
});

test('an empty body keeps the meaning each route already gave it — and never stalls', async () => {
  // Routes that wrote `JSON.parse(body || '{}')` keep going with `{}`.
  const tolerantBalance = await postRaw('/api/idbots/wallet/balance', '');
  assert.equal(tolerantBalance.status, 400);
  assert.match(String(tolerantBalance.json.error), /metabot_id, metabot_ids, or address is required/);

  const tolerantOpen = await postRaw('/api/idbots/bot-browser/open', '');
  assert.notEqual(tolerantOpen.json.error, 'Invalid JSON body');

  // Routes that wrote a bare `JSON.parse(body)` reported an empty body as
  // invalid JSON; that is unchanged apart from being answered at all.
  const strictResolve = await postRaw('/api/idbots/resolve-metabot-id', '');
  assert.equal(strictResolve.status, 400);
  assert.equal(strictResolve.json.error, 'Invalid JSON body');
  assert.equal(strictResolve.json.error_code, 'BODY_NOT_JSON');

  const strictShow = await postRaw('/api/idbots/group-task/show', '');
  assert.equal(strictShow.status, 400);
  assert.equal(strictShow.json.error, 'Invalid JSON body');
  assert.equal(strictShow.json.error_code, 'BODY_NOT_JSON');

  const stalled = [];
  const misclassified = [];
  for (const route of GUARDED_POST_ROUTES) {
    const { status, json } = await postRaw(route, '');
    if (status === 0) {
      stalled.push(route);
      continue;
    }
    const invalidJsonBody = json?.error === 'Invalid JSON body';
    const expectedTolerant = EMPTY_BODY_MEANS_OBJECT_ROUTES.includes(route);
    if (invalidJsonBody === expectedTolerant) {
      misclassified.push(`${route}: ${expectedTolerant ? 'expected to accept an empty body' : 'expected 400 Invalid JSON body'} but got ${JSON.stringify(json?.error)}`);
    }
    if (invalidJsonBody && json?.error_code !== 'BODY_NOT_JSON') {
      misclassified.push(`${route}: Invalid JSON body answered with error_code ${JSON.stringify(json?.error_code)}`);
    }
  }
  assert.deepEqual(stalled, [], `routes that returned no response for an empty body:\n${stalled.join('\n')}`);
  assert.deepEqual(misclassified, [], `empty-body policy drift:\n${misclassified.join('\n')}`);
});

test('the ledger-named routes advertise the fields their validation actually reads', async () => {
  for (const [route, expectedFields] of Object.entries(EXPECTED_FIELD_CONTRACTS)) {
    assert.ok(POST_ROUTES.includes(route), `${route} is not a POST route of the gateway`);
    const { status, json } = await postRaw(route, 'null');
    assert.equal(status, 400, `${route} should reject a null body`);
    assert.ok(json.contract.fields, `${route}: contract.fields must always be listed`);
    assert.deepEqual(
      Object.keys(json.contract.fields).sort(),
      [...expectedFields].sort(),
      `${route} field contract drifted`,
    );
    assert.equal(json.contract.schemaVersion, 1, `${route}: contract schemaVersion drifted`);
  }
});

test('no gateway route reads its request body inline any more', () => {
  const source = readRpcServerSource();
  const inlineLoops = (source.match(/for await \(const chunk of req\)/g) || []).length;
  assert.equal(
    inlineLoops,
    UNGUARDED_POST_ROUTES.length,
    `expected the inline body read to survive only for ${UNGUARDED_POST_ROUTES.join(', ')}`,
  );
  assert.match(source, /readRpcJsonObjectBody\(/, 'the shared body guard is not wired into the gateway');
});

test('the empty-body policy covers the routes that delegate their parsing', () => {
  assert.ok(DELEGATED_BODY_ROUTES.length >= 5, `expected the delegated gateways routes, got ${DELEGATED_BODY_ROUTES.length}`);

  // Which empty-body meaning the delegated modules give their routes: they parse
  // with `rawBody || '{}'`, i.e. an empty body is "no fields supplied". If that
  // changes, the routes' explicit policy has to be revisited, so this check
  // fails loudly instead of letting the two drift apart.
  for (const modulePath of [
    new URL('../src/main/services/chatGatewayRoutes.ts', import.meta.url),
    new URL('../src/main/services/memoryGatewayRoutes.ts', import.meta.url),
  ]) {
    const moduleSource = fs.readFileSync(modulePath, 'utf8');
    assert.match(
      moduleSource,
      /JSON\.parse\(rawBody \|\| '\{\}'\)/,
      `${modulePath.pathname} no longer treats an empty body as {} — re-check the emptyBody policy of the routes that delegate to it`,
    );
  }

  const missing = DELEGATED_BODY_ROUTES.filter((route) => !EMPTY_BODY_MEANS_OBJECT_ROUTES.includes(route));
  assert.deepEqual(missing, [], `delegated routes missing from the empty-body tolerant list:\n${missing.join('\n')}`);
});

test('the sweep raised no unhandled rejection', async () => {
  // Rejections surface on the next microtask turn; give them room to land.
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.deepEqual(unhandledRejections, []);
});
