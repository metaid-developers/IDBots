import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Module from 'node:module';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(import.meta.dirname, '..');

/**
 * Agent-Game bot channel (owner directive 2026-09-24):
 *   1. runtime.start() guarantees group membership BEFORE the first on-chain
 *      write (room 924-2: the black seat's seat.claimed was on chain but the
 *      chat-api server diverts non-member writes — no history, no WS fanout);
 *   2. local-bot actors auto-approve their session start (no card);
 *   3. ALL game writes (seat claims AND actions) are signed as the session
 *      agent's bot wallet (走子方自付, decision ④);
 *   4. the RPC route POST /api/idbots/agent-game/session mirrors
 *      browser.app.session.* params for local bot actors.
 */

/** Electron stub — adapterSandbox only needs app.isPackaged + app.getAppPath(). */
const electronStub = {
  app: { isPackaged: false, getAppPath: () => projectRoot },
};
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'electron') return electronStub;
  return originalLoad.call(this, request, parent, isMain);
};

/** 陈旧产物守卫：本套件直接对 gitignored 的 dist-electron 编译产物跑回归。 */
const DIST_RUNTIME_JS = path.join(projectRoot, 'dist-electron', 'main', 'agentGame', 'runtime.js');
(function assertFreshAgentGameDist() {
  let src;
  try {
    src = fs.readFileSync(DIST_RUNTIME_JS, 'utf8');
  } catch {
    throw new Error(`[stale-dist-guard] ${DIST_RUNTIME_JS} 不存在：先编译 electron 主进程（node_modules/.bin/tsc --project electron-tsconfig.json）再跑本套件`);
  }
  if (!src.includes('ensureGroupMembership')) {
    throw new Error('[stale-dist-guard] dist runtime 缺 ensureGroupMembership 特征（旧产物）：请重编译后重跑');
  }
})();

setTimeout(() => {
  console.error('[suite-watchdog] 套件 90s 未结束：静默挂起，强制 exit 1');
  process.exit(1);
}, 90_000).unref();

/** Minimal SqliteDatabase-shape adapter over node:sqlite (mirrors agentGameSeatClaim). */
class TestSqliteDb {
  constructor() {
    this.db = new DatabaseSync(':memory:');
  }

  exec(sql, params = []) {
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(sql)) {
      this.db.exec(sql);
      return [];
    }
    const stmt = this.db.prepare(sql);
    if (/^\s*(SELECT|PRAGMA)/i.test(sql)) {
      const rows = stmt.all(...params);
      const columns = stmt.columns().map((column) => column.name || column.column || '');
      return [{ columns, values: rows.map((row) => columns.map((column) => row[column])) }];
    }
    stmt.run(...params);
    return [];
  }

  run(sql, params = []) {
    return this.exec(sql, params);
  }
}

function createAgentGameTables(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS agent_game_sessions (
    session_id TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'paused',
    app_id TEXT NOT NULL,
    group_id TEXT NOT NULL,
    game_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    seat TEXT NOT NULL,
    rules_hash TEXT NOT NULL,
    adapter_hash TEXT NOT NULL,
    manifest_uri TEXT NOT NULL,
    protocol_paths TEXT,
    budget_llm_calls INTEGER NOT NULL DEFAULT 0,
    budget_llm_calls_used INTEGER NOT NULL DEFAULT 0,
    budget_writes INTEGER NOT NULL DEFAULT 0,
    budget_writes_used INTEGER NOT NULL DEFAULT 0,
    last_index INTEGER,
    last_action_seq INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    expires_at INTEGER NOT NULL DEFAULT 0,
    consent TEXT,
    lease_id TEXT,
    lease_expires_at INTEGER,
    serialized_state TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );`);
  db.exec(`CREATE TABLE IF NOT EXISTS agent_game_grants (
    resource_uri TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    app_id TEXT NOT NULL,
    group_id TEXT NOT NULL,
    game_id TEXT NOT NULL,
    rules_hash TEXT NOT NULL,
    adapter_hash TEXT NOT NULL,
    seat TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    ttl_ms INTEGER NOT NULL DEFAULT 0,
    expires_at INTEGER NOT NULL DEFAULT 0,
    budget_llm_calls INTEGER NOT NULL DEFAULT 0,
    budget_writes INTEGER NOT NULL DEFAULT 0,
    protocol_paths TEXT,
    revoked_at INTEGER,
    reason TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (resource_uri, actor_id, app_id, group_id, game_id, rules_hash, adapter_hash, seat)
  );`);
  db.exec(`CREATE TABLE IF NOT EXISTS agent_game_write_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id TEXT NOT NULL,
    action_seq INTEGER NOT NULL,
    event_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    pin_id TEXT,
    tx_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (group_id, action_seq, event_id)
  );`);
  db.exec(`CREATE TABLE IF NOT EXISTS agent_game_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    session_id TEXT,
    actor_id TEXT,
    fields TEXT,
    ts INTEGER NOT NULL
  );`);
  db.exec(`CREATE TABLE IF NOT EXISTS group_chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pin_id TEXT UNIQUE NOT NULL,
    tx_id TEXT,
    group_id TEXT NOT NULL,
    channel_id TEXT,
    sender_metaid TEXT NOT NULL,
    sender_global_metaid TEXT,
    sender_address TEXT,
    sender_name TEXT,
    sender_avatar TEXT,
    sender_chat_pubkey TEXT,
    protocol TEXT NOT NULL,
    content TEXT,
    content_type TEXT,
    encryption TEXT,
    reply_pin TEXT,
    mention TEXT,
    chain_timestamp INTEGER,
    chain TEXT,
    raw_data TEXT,
    is_processed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );`);
  db.exec(`ALTER TABLE group_chat_messages ADD COLUMN msg_index INTEGER;`);
}

/** 对局语义 fixture adapter（镜像 agentGameSeatClaim）：seat.claimed 按
 *  meta.senderMetaId 占座，两座齐 → playing，轮到 state.seat 走子。 */
const SEAT_FIXTURE_ADAPTER_SOURCE = `
export function createMatch(config) { return { gameId: config.gameId }; }
export function initialState(config) { return { gameId: config.gameId, seat: config.seat, seats: {}, moves: [] }; }
export function reduce(state, event) {
  const meta = event.meta || {};
  const sender = meta.senderMetaId || '';
  if (event.type === 'seat.claimed') {
    if (!state.seats[sender]) state.seats[sender] = (event.payload && event.payload.requestedRole) || '';
  }
  if (event.type === 'action') state.moves.push({ sender, seq: event.actionSeq });
  return state;
}
export function getTurn(state) {
  return Object.keys(state.seats).length >= 2
    ? { phase: 'playing', seat: state.seat }
    : { phase: 'waiting', seat: null };
}
export function getObservation(state) { return { seats: state.seats }; }
export function getActionSchema() { return { type: 'object' }; }
export function parseAction(text) { return { action: { move: String(text).slice(0, 16) } }; }
export function validateAction() { return { valid: true }; }
export function serializeState(state) { return JSON.stringify(state); }
export function getResult() { return { finished: false }; }
`;

const BLACK_AGENT = 'idq1seatjoin-black-agent-00000000000000000000';
const RED_AGENT = 'idq1seatjoin-red-agent-0000000000000000000000';
const GROUP_ID = 'seatjoin-group-1';
const RESOURCE_URI = 'metaapp://seatjoin-fixture-pin-i0';

function makeChainRecorder() {
  const calls = [];
  return {
    calls,
    async chainWrite(groupId, plaintext, opts) {
      calls.push({ groupId, plaintext, opts: opts ?? null });
      return { pinId: `join-pin-${calls.length}` };
    },
  };
}

/** buildHost：可注入 ensureAgentGroupMember / autoApproveActor / llmComplete。 */
function buildHost({
  ensureAgentGroupMember,
  autoApproveActor,
  llmComplete,
  failFirst = 0,
} = {}) {
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-game-seatjoin-'));
  fs.writeFileSync(path.join(artifactDir, 'adapter.js'), SEAT_FIXTURE_ADAPTER_SOURCE);
  fs.writeFileSync(path.join(artifactDir, 'package.json'), JSON.stringify({ type: 'module' }));
  const adapterHash = `sha256:${crypto.createHash('sha256').update(SEAT_FIXTURE_ADAPTER_SOURCE).digest('hex')}`;
  const manifest = {
    protocol: 'agent-game/1',
    gameId: 'fixture-game',
    rulesVersion: '1',
    adapter: './adapter.js',
    adapterHash,
    turnModel: 'sequential',
    informationModel: 'public',
    maxPlayers: 2,
  };
  fs.writeFileSync(path.join(artifactDir, 'game-manifest.json'), JSON.stringify(manifest));

  const db = new TestSqliteDb();
  createAgentGameTables(db);
  const recorder = makeChainRecorder();
  // 座位认领写入失败 N 次：验证 membership 失败不阻塞会话的用例复用。
  let writes = 0;
  const chainWrite = async (groupId, plaintext, opts) => {
    writes++;
    if (writes <= failFirst) throw new Error(`chain write temporarily failed (attempt ${writes})`);
    return recorder.chainWrite(groupId, plaintext, opts);
  };
  const { createAgentGameHost } = require('../dist-electron/main/agentGame/index.js');
  const host = createAgentGameHost({
    db,
    saveDb: () => {},
    llmComplete: llmComplete ?? (async () => {
      throw new Error('llm must not be reached unless the test drives a move');
    }),
    chainWrite,
    manifestFetch: async () => JSON.parse(fs.readFileSync(path.join(artifactDir, 'game-manifest.json'), 'utf8')),
    adapterPathFor: async (manifestUri, mf) => path.join(artifactDir, mf.adapter),
    resolveActor: () => BLACK_AGENT,
    actorNameFor: (globalMetaId) => (globalMetaId === BLACK_AGENT ? 'Black Bot' : ''),
    ensureAgentGroupMember,
    autoApproveActor,
    log: () => {},
  });
  return { host, db, recorder, adapterHash };
}

function startParams(overrides = {}) {
  return {
    appId: 'seatjoin.v1',
    sessionType: 'agent-game',
    groupId: GROUP_ID,
    gameId: 'fixture-game',
    manifestUri: 'metaapp://seatjoin-fixture-pin-i0',
    rulesHash: 'sha256:seatjoin-rules',
    seat: 'black',
    agentId: BLACK_AGENT,
    ttlMs: 3_600_000,
    budget: { llmCalls: 5, writes: 10 },
    ...overrides,
  };
}

async function waitFor(predicate, { timeoutMs = 20_000, stepMs = 20, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  throw new Error(`waitFor timeout: ${label}`);
}

function insertRow(db, { pinId, groupId = GROUP_ID, senderGlobalMetaId, msgIndex, chainTimestamp, content }) {
  db.run(
    `INSERT INTO group_chat_messages
      (pin_id, group_id, sender_metaid, sender_global_metaid, protocol, content, encryption, chain_timestamp, msg_index)
     VALUES (?, ?, ?, ?, 'simplegroupchat', ?, 'aes', ?, ?)`,
    [pinId, groupId, 'legacy-metaid', senderGlobalMetaId, content, chainTimestamp, msgIndex],
  );
}

function envelopeOf(type, extra = {}) {
  return JSON.stringify({
    protocol: 'agent-game/1',
    gameId: 'fixture-game',
    matchId: GROUP_ID,
    rulesHash: 'sha256:seatjoin-rules',
    type,
    eventId: `row:${type}:${Math.random().toString(36).slice(2)}`,
    ...extra,
  });
}

function auditQuery(db, type) {
  const res = db.exec('SELECT type, actor_id, fields FROM agent_game_audit WHERE type = ? ORDER BY id', [type]);
  const rows = res[0]?.values ?? [];
  return rows.map(([t, actor, fields]) => ({ type: t, actorId: actor, fields: JSON.parse(fields || '{}') }));
}

/* ------------------------------------------------------------------ */
/* 1. membership bootstrap                                             */
/* ------------------------------------------------------------------ */

/** 两阶段 start（无 auto-approve 的宿主必须走完整授权舞蹈）。 */
async function startSession(host, { agentId = BLACK_AGENT, overrides = {} } = {}) {
  const phaseOne = await host.handleSessionMethod('start', startParams({ agentId, ...overrides }), agentId, { resourceUri: RESOURCE_URI });
  assert.equal(phaseOne.manualAction, true, 'phase 1 must issue a confirmation');
  const session = await host.handleSessionMethod('start', phaseOne.confirmRequest.payload, agentId, { resourceUri: RESOURCE_URI });
  assert.equal(session.__error || false, false, `phase 2 failed: ${session.code} ${session.message}`);
  return session;
}

test('membership hook runs before the seat.claimed write and charges the join pin to the budget', { timeout: 45_000 }, async () => {
  const calls = [];
  const { host, recorder } = buildHost({
    ensureAgentGroupMember: async (agentId, groupId) => {
      calls.push({ agentId, groupId });
      return { joined: true, chargedWrite: true };
    },
  });
  try {
    const session = await startSession(host);
    assert.equal(calls.length, 1, 'hook must run exactly once per start');
    assert.equal(calls[0].agentId, BLACK_AGENT);
    assert.equal(calls[0].groupId, GROUP_ID);
    await waitFor(() => recorder.calls.length >= 1, { label: 'seat.claimed chain write' });
    // 预算实账：join pin（1）+ seat.claimed（1）= 2；用 waitFor 等 ledger 收敛。
    await waitFor(async () => {
      const status = await host.handleSessionMethod('status', { sessionId: session.sessionId }, BLACK_AGENT);
      return status.budget?.writesUsed === 2;
    }, { label: 'writesUsed = join + seat.claimed' });
  } finally {
    await host.dispose();
  }
});

test('membership hook failure is non-fatal: session still starts and claims its seat', { timeout: 45_000 }, async () => {
  const { host, recorder } = buildHost({
    ensureAgentGroupMember: async () => {
      throw new Error('indexer unreachable');
    },
  });
  try {
    const session = await startSession(host);
    await waitFor(() => recorder.calls.length >= 1, { label: 'seat.claimed chain write despite hook failure' });
    assert.equal(JSON.parse(recorder.calls[0].plaintext).type, 'seat.claimed');
  } finally {
    await host.dispose();
  }
});

/* ------------------------------------------------------------------ */
/* 2. local-bot auto-approve fast lane                                 */
/* ------------------------------------------------------------------ */

test('local-bot actor starts without the card; third-party actor keeps the two-phase path', { timeout: 45_000 }, async () => {
  const { host, db } = buildHost({
    autoApproveActor: (actorId) => actorId === BLACK_AGENT,
  });
  try {
    // 本地 bot：直达 session，无 manualAction。
    const direct = await host.handleSessionMethod('start', startParams(), BLACK_AGENT, { resourceUri: RESOURCE_URI });
    assert.equal(direct.__error || false, false, `direct start failed: ${direct.code} ${direct.message}`);
    assert.equal(direct.manualAction, undefined, 'auto-approved start must not go through the card');
    assert.equal(direct.seat, 'black');
    // 幂等复用：同 (groupId, seat, agentId, rulesHash) 再次 start 返回既有 session。
    const again = await host.handleSessionMethod('start', startParams(), BLACK_AGENT, { resourceUri: RESOURCE_URI });
    assert.equal(again.sessionId, direct.sessionId, 'repeat start must reuse the session');
    const granted = auditQuery(db, 'consent-granted');
    assert.equal(granted.length, 1, 'exactly one consent grant');
    assert.equal(granted[0].fields.via, 'auto-approve-local-bot');
    // 第三方 actor：仍走两阶段授权卡。
    const thirdParty = await host.handleSessionMethod(
      'start',
      startParams({ agentId: RED_AGENT, seat: 'red' }),
      RED_AGENT,
      { resourceUri: RESOURCE_URI },
    );
    assert.equal(thirdParty.manualAction, true, 'third-party actor must receive the manual card');
    assert.ok(thirdParty.confirmRequest?.payload?.confirmToken, 'third-party actor gets a confirm token');
  } finally {
    await host.dispose();
  }
});

/* ------------------------------------------------------------------ */
/* 3. 走子方自付：action 写链带会话身份                                  */
/* ------------------------------------------------------------------ */

test('action writes are signed as the session agent bot (mover pays), not the owner', { timeout: 60_000 }, async () => {
  let llmCalls = 0;
  const { host, db, recorder } = buildHost({
    autoApproveActor: (actorId) => actorId === BLACK_AGENT,
    llmComplete: async () => {
      llmCalls++;
      return { content: JSON.stringify({ move: 'h2e2' }), toolCalls: [] };
    },
  });
  try {
    const session = await host.handleSessionMethod('start', startParams(), BLACK_AGENT, { resourceUri: RESOURCE_URI });
    assert.equal(session.__error || false, false);
    await waitFor(() => recorder.calls.some((c) => JSON.parse(c.plaintext).type === 'seat.claimed'), { label: 'own seat.claimed' });
    // 对手（红方）的 seat.claimed 从群消息面进来 → playing → 本座（黑）走子。
    insertRow(db, {
      pinId: 'peer-red-claim-pin',
      senderGlobalMetaId: RED_AGENT,
      msgIndex: 1,
      chainTimestamp: Date.now(),
      content: envelopeOf('seat.claimed', { payload: { requestedRole: 'red', name: 'Red Bot' } }),
    });
    host.onGroupMessage(GROUP_ID);
    // The peer claim lands right after the own claim was recorded, i.e. while
    // that write's finalize may still be running. That used to race: the
    // finalize overwrote the state the catch-up had just applied, and this
    // wait timed out at whatever budget it had (v1.1.3 tag runs: 25 s, 38 s).
    // Per-session serialization in the runtime made the order deterministic;
    // agentGameSeatClaim "a group message landing while the seat claim is
    // being finalized" pins it with a gated sandbox. A timeout here is a real
    // hang again — do not widen it.
    await waitFor(() => recorder.calls.some((c) => JSON.parse(c.plaintext).type === 'action'), { label: 'action write' });
    assert.ok(llmCalls >= 1, 'the host brain must have produced the move');
    const actionCall = recorder.calls.find((c) => JSON.parse(c.plaintext).type === 'action');
    assert.equal(actionCall.opts?.asAgentId, BLACK_AGENT, 'action must be signed as the session agent (走子方自付)');
    const env = JSON.parse(actionCall.plaintext);
    assert.equal(env.actionSeq, 1);
    assert.ok(env.stateHash && env.stateHash.startsWith('sha256:'), 'action carries the post-reduce stateHash');
  } finally {
    await host.dispose();
  }
});

/* ------------------------------------------------------------------ */
/* 4. RPC 路由：POST /api/idbots/agent-game/session                     */
/* ------------------------------------------------------------------ */

test('rpc agent-game/session: validation, local-bot gate, and dispatch', { timeout: 45_000 }, async () => {
  const electronStubRpc = {
    app: {
      getPath: () => os.tmpdir(),
      getAppPath: () => process.cwd(),
    },
    BrowserWindow: { getAllWindows: () => [] },
  };
  process.env.IDBOTS_RPC_TOKEN = process.env.IDBOTS_RPC_TOKEN || 'test-rpc-token-agent-game-session';
  const handled = [];
  const server = await (async () => {
    const patchedLoad = function patchedModuleLoad(request, parent, isMain) {
      if (request === 'electron') return electronStubRpc;
      if (request === './httpListenWithRetry' || request.endsWith('/httpListenWithRetry')) {
        return {
          listenWithPortFallback(server, _port, host, options = {}) {
            server.listen(0, host, () => {
              if (typeof options.onPortSelected === 'function') options.onPortSelected(server.address().port);
              if (typeof options.onListening === 'function') options.onListening();
            });
          },
          listenWithRetry(server, _port, host, options = {}) {
            server.listen(0, host, () => {
              if (typeof options.onListening === 'function') options.onListening();
            });
          },
        };
      }
      return originalLoad.call(this, request, parent, isMain);
    };
    Module._load = patchedLoad;
    try {
      const compiledPath = require.resolve('../dist-electron/main/services/metaidRpcServer.js');
      delete require.cache[compiledPath];
      const { startMetaidRpcServer } = require(compiledPath);
      const { getMetaidRpcToken } = require(require.resolve('../dist-electron/main/services/metaidRpcEndpoint.js'));
      const roster = {
        listMetabots: () => [
          { id: 15, name: 'Builder阿码', globalmetaid: BLACK_AGENT },
        ],
        getMetabotById: (id) => (id === 15 ? { id: 15, name: 'Builder阿码', globalmetaid: BLACK_AGENT } : null),
        getMetabotByGlobalMetaId: (gid) => (gid === BLACK_AGENT ? { id: 15, name: 'Builder阿码', globalmetaid: BLACK_AGENT } : null),
        getMetabotWalletByMetabotId: () => null,
      };
      return {
        server: startMetaidRpcServer(() => roster, () => ({ getDatabase() { return {}; }, getSaveFunction() { return () => {}; } }), () => ({
          listUserMemories() { return []; },
          createUserMemory() { throw new Error('not exercised'); },
        }), {
          agentGameSession: async (input) => {
            handled.push(input);
            return { sessionId: 'rpc-session-1', seat: 'black' };
          },
        }),
        token: getMetaidRpcToken(),
      };
    } finally {
      Module._load = originalLoad;
    }
  })();
  const { server: httpServer, token } = server;
  await new Promise((resolve, reject) => {
    if (httpServer.listening) { resolve(); return; }
    httpServer.once('listening', resolve);
    httpServer.once('error', reject);
  });
  const address = httpServer.address();
  const port = typeof address === 'object' && address ? address.port : null;
  assert.ok(port, 'test server port');
  const baseUrl = `http://127.0.0.1:${port}`;
  const post = (body) => fetch(`${baseUrl}/api/idbots/agent-game/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  try {
    // Invalid JSON.
    {
      const res = await post('{not json');
      assert.equal(res.status, 400);
    }
    // Missing method.
    {
      const res = await post({ actor_id: BLACK_AGENT });
      const json = await res.json();
      assert.equal(res.status, 400);
      assert.match(json.error, /method is required/);
    }
    // Missing actor.
    {
      const res = await post({ method: 'start' });
      const json = await res.json();
      assert.equal(res.status, 400);
      assert.match(json.error, /actor_id/);
    }
    // Non-local actor → 403（三方 bot 走浏览器桥授权卡，不经本通道）。
    {
      const res = await post({ method: 'start', actor_id: RED_AGENT });
      const json = await res.json();
      assert.equal(res.status, 403);
      assert.match(json.error, /not a local MetaBot/);
    }
    // actor_id 直传：dispatch 收到 method/payload/actorId 与合成 resourceUri。
    {
      const res = await post({ method: 'start', actor_id: BLACK_AGENT, payload: { groupId: 'g1', seat: 'black' } });
      const json = await res.json();
      assert.equal(res.status, 200);
      assert.equal(json.success, true);
      assert.equal(json.result.sessionId, 'rpc-session-1');
      assert.equal(handled.length, 1);
      assert.equal(handled[0].method, 'start');
      assert.equal(handled[0].actorId, BLACK_AGENT);
      assert.equal(handled[0].resourceUri, `rpc://agent-game/${BLACK_AGENT}`);
      assert.deepEqual(handled[0].payload, { groupId: 'g1', seat: 'black' });
    }
    // metabot_name 解析 → globalMetaId。
    {
      const res = await post({ method: 'list', metabot_name: 'Builder阿码', payload: {} });
      const json = await res.json();
      assert.equal(res.status, 200);
      assert.equal(handled.length, 2);
      assert.equal(handled[1].actorId, BLACK_AGENT);
    }
    // metabot_id 解析 → globalMetaId。
    {
      const res = await post({ method: 'status', metabot_id: 15, payload: { sessionId: 's1' } });
      assert.equal(res.status, 200);
      assert.equal(handled.length, 3);
      assert.equal(handled[2].actorId, BLACK_AGENT);
    }
  } finally {
    httpServer.close();
  }
});
