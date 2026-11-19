import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(import.meta.dirname, '..');

/** Electron stub — adapterSandbox only needs app.isPackaged + app.getAppPath(). */
const electronStub = {
  app: { isPackaged: false, getAppPath: () => projectRoot },
};
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'electron') return electronStub;
  return originalLoad.call(this, request, parent, isMain);
};

/** 陈旧产物守卫（同 agentGameTwoPhaseStart）：本套件直接对 gitignored 的
 *  dist-electron 编译产物跑回归。缺产物或缺特征 → 显式红灯 + 重编译指引。 */
const DIST_RUNTIME_JS = path.join(projectRoot, 'dist-electron', 'main', 'agentGame', 'runtime.js');
(function assertFreshAgentGameDist() {
  let src;
  try {
    src = fs.readFileSync(DIST_RUNTIME_JS, 'utf8');
  } catch {
    throw new Error(`[stale-dist-guard] ${DIST_RUNTIME_JS} 不存在：先编译 electron 主进程（node_modules/.bin/tsc --project electron-tsconfig.json）再跑本套件`);
  }
  if (!src.includes('seat.claimed')) {
    throw new Error('[stale-dist-guard] dist-electron/main/agentGame/runtime.js 缺 seat.claimed 特征（旧产物）：请重编译后重跑');
  }
})();

setTimeout(() => {
  console.error('[suite-watchdog] 套件 60s 未结束：静默挂起，强制 exit 1');
  process.exit(1);
}, 60_000).unref();

/** Minimal SqliteDatabase-shape adapter over node:sqlite (mirrors agentGameTwoPhaseStart). */
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

/** 对局语义 fixture adapter（ESM 十导出）：seat.claimed 按 meta.senderMetaId 占座
 *  （镜像蓝本 xiangqi-adapter 的归因口径），并把每次 reduce 看到的 meta 记进
 *  state.log 供断言 —— 尺子直接量「归因是否来自消息元数据」。 */
const SEAT_FIXTURE_ADAPTER_SOURCE = `
export function createMatch(config) { return { gameId: config.gameId }; }
export function initialState(config) { return { gameId: config.gameId, seat: config.seat, seats: {}, log: [] }; }
export function reduce(state, event) {
  const meta = event.meta || {};
  const sender = meta.senderMetaId || '';
  state.log.push({ type: event.type, sender: sender, index: meta.index ?? null, timestamp: meta.timestamp ?? null });
  if (event.type === 'seat.claimed') {
    if (!state.seats[sender]) state.seats[sender] = (event.payload && event.payload.requestedRole) || '';
  }
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

const RED_AGENT = 'idq1seat-red-agent-00000000000000000000000';
const BLACK_AGENT = 'idq1seat-black-agent-00000000000000000000';
const GROUP_ID = 'seat-group-1';
const RESOURCE_URI = 'metaapp://seat-fixture-pin-i0';

/** chainWrite 录制器：记录 (groupId, plaintext, opts)；可配置先失败 N 次。 */
function makeChainRecorder({ failFirst = 0 } = {}) {
  const calls = [];
  return {
    calls,
    async chainWrite(groupId, plaintext, opts) {
      calls.push({ groupId, plaintext, opts: opts ?? null });
      if (calls.length <= failFirst) {
        throw new Error(`chain write temporarily failed (attempt ${calls.length})`);
      }
      return { pinId: `seat-pin-${calls.length}` };
    },
  };
}

function buildHost({ failFirst = 0 } = {}) {
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-game-seat-'));
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
  const recorder = makeChainRecorder({ failFirst });
  const { createAgentGameHost } = require('../dist-electron/main/agentGame/index.js');
  const host = createAgentGameHost({
    db,
    saveDb: () => {},
    llmComplete: async () => {
      throw new Error('llm must not be reached by the seat-claim suite (match stays waiting)');
    },
    chainWrite: recorder.chainWrite,
    manifestFetch: async () => JSON.parse(fs.readFileSync(path.join(artifactDir, 'game-manifest.json'), 'utf8')),
    adapterPathFor: async (manifestUri, mf) => path.join(artifactDir, mf.adapter),
    resolveActor: () => BLACK_AGENT,
    actorNameFor: (globalMetaId) => (globalMetaId === BLACK_AGENT ? 'Black Bot' : ''),
    log: () => {},
  });
  return { host, db, recorder, adapterHash };
}

function startParams() {
  return {
    appId: 'seat.v1',
    sessionType: 'agent-game',
    groupId: GROUP_ID,
    gameId: 'fixture-game',
    manifestUri: 'metaapp://seat-fixture-pin-i0',
    rulesHash: 'sha256:seat-rules',
    seat: 'black',
    agentId: BLACK_AGENT,
    ttlMs: 3_600_000,
    budget: { llmCalls: 0, writes: 10 },
  };
}

/** 两阶段 start：返回 phase 2 的 session view（失败即断言失败）。 */
async function startSession(host) {
  const phaseOne = await host.handleSessionMethod('start', startParams(), BLACK_AGENT, { resourceUri: RESOURCE_URI });
  assert.equal(phaseOne.manualAction, true, 'phase 1 must issue a confirmation');
  const session = await host.handleSessionMethod('start', phaseOne.confirmRequest.payload, BLACK_AGENT, { resourceUri: RESOURCE_URI });
  assert.equal(session.__error || false, false, `phase 2 failed: ${session.code} ${session.message}`);
  return session;
}

async function waitFor(predicate, { timeoutMs = 8_000, stepMs = 20, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // await：同步/异步谓词统一取真值——Promise 对象本身恒为 truthy，
    // 不 await 会让轮询首轮即放行（假绿）。
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
    rulesHash: 'sha256:seat-rules',
    type,
    eventId: `row:${type}:${Math.random().toString(36).slice(2)}`,
    ...extra,
  });
}

async function serializedStateOf(host, sessionId) {
  const raw = host.store.getSerializedState(sessionId);
  return raw ? JSON.parse(raw) : null;
}

test('seat claim is written on-chain right after the phase-2 grant, signed as the session agent', { timeout: 20_000 }, async () => {
  const { host, db, recorder } = buildHost();
  try {
    const session = await startSession(host);

    // 授座后 seat.claimed 落链（复用 action 写路径：intent → pending → retry）。
    // The predicate must cover the persisted facts asserted below: chainWrite
    // being called (the recorder signal) is only the midpoint — the runtime
    // still has to markWriteStatus('committed'), `await sandbox.reduce(...)`,
    // and persistOwnedFields before the write-log row and the session budget
    // are readable. A calls-only wait can observe a pending ledger row or
    // writesUsed=0 on slow runners (same window as Windows CI run 36427382778).
    await waitFor(
      () => {
        if (recorder.calls.length < 1) return false;
        const logRow = db.exec(
          `SELECT status FROM agent_game_write_log WHERE group_id = ? AND action_seq = 0`,
          [GROUP_ID],
        )[0]?.values?.[0];
        if (String(logRow?.[0]) !== 'committed') return false;
        const sessionRow = db.exec(
          `SELECT budget_writes_used FROM agent_game_sessions WHERE session_id = ?`,
          [session.sessionId],
        )[0]?.values?.[0];
        return Boolean(sessionRow) && Number(sessionRow[0]) >= 1;
      },
      { label: 'seat.claimed chain write + ledger commit + persisted budget' },
    );
    const call = recorder.calls[0];
    assert.equal(call.groupId, GROUP_ID);
    // 身份写链：非 action 事件必须带 asAgentId（会话身份），归因才成立。
    assert.equal(call.opts?.asAgentId, BLACK_AGENT, 'seat.claimed must be signed as the session agent');

    const env = JSON.parse(call.plaintext);
    assert.equal(env.protocol, 'agent-game/1');
    assert.equal(env.type, 'seat.claimed');
    assert.equal(env.gameId, 'fixture-game');
    assert.equal(env.matchId, GROUP_ID);
    assert.equal(env.rulesHash, 'sha256:seat-rules');
    assert.ok(env.eventId.startsWith(`${BLACK_AGENT}:`), `eventId must be <agentId>:<uuid>, got ${env.eventId}`);
    assert.equal(env.payload.requestedRole, 'black');
    assert.equal(env.payload.name, 'Black Bot');
    assert.ok(!('actionSeq' in env), 'docs/07: actionSeq only exists on action events');

    // 幂等账本：action_seq=0（非 action 槽位），committed + pinId。
    const row = db.exec(
      `SELECT status, pin_id, attempts, session_id FROM agent_game_write_log WHERE group_id = ? AND action_seq = 0`,
      [GROUP_ID],
    )[0]?.values?.[0];
    assert.ok(row, 'seat.claimed write-log row must exist');
    assert.equal(String(row[0]), 'committed');
    assert.equal(String(row[1]), 'seat-pin-1');
    assert.equal(Number(row[2]) >= 1, true);
    assert.equal(String(row[3]), session.sessionId);

    // 预算记账：走子方（占座方）自付口径下写入计入 writesUsed。
    const view = await host.handleSessionMethod('status', { sessionId: session.sessionId }, BLACK_AGENT);
    assert.equal(view.budget.writesUsed, 1);
    assert.equal(view.status, 'running');

    // 本地归因守卫：post-write 本地 reduce 带 own-meta —— sender 是会话身份，
    // 不是 ''（若为 ''，fixture 的 seats 会被 '' 键占走）。
    await waitFor(async () => {
      const state = await serializedStateOf(host, session.sessionId);
      return Boolean(state && state.seats && state.seats[BLACK_AGENT]);
    }, { label: 'local seat attribution' });
    const state = await serializedStateOf(host, session.sessionId);
    assert.equal(state.seats[BLACK_AGENT], 'black');
  } finally {
    await host.dispose();
  }
});

test('seat claim write retries through the same ledger on failure and commits on a later attempt', { timeout: 45_000 }, async () => {
  const { host, db, recorder } = buildHost({ failFirst: 1 });
  try {
    const session = await startSession(host);

    await waitFor(
      () => {
        const row = db.exec(
          `SELECT status, attempts FROM agent_game_write_log WHERE group_id = ? AND action_seq = 0`,
          [GROUP_ID],
        )[0]?.values?.[0];
        if (!(Boolean(row) && String(row[0]) === 'committed' && Number(row[1]) >= 2)) return false;
        // A committed ledger row is NOT proof the session row caught up:
        // retryPendingWrite marks the write committed right after chainWrite,
        // then `await sandbox.reduce(...)` runs before persistOwnedFields
        // writes budget.writesUsed back — Windows CI run 36427382778 failed
        // below reading writesUsed=0 in that window. Wait for the persisted
        // budget itself.
        const sessionRow = db.exec(
          `SELECT budget_writes_used FROM agent_game_sessions WHERE session_id = ?`,
          [session.sessionId],
        )[0]?.values?.[0];
        return Boolean(sessionRow) && Number(sessionRow[0]) >= 1;
      },
      { timeoutMs: 25_000, stepMs: 50, label: 'seat.claimed retry-to-commit + persisted budget' },
    );

    assert.equal(recorder.calls.length, 2, 'exactly one failure + one successful retry');
    assert.equal(recorder.calls[1].opts?.asAgentId, BLACK_AGENT);
    const view = await host.handleSessionMethod('status', { sessionId: session.sessionId }, BLACK_AGENT);
    assert.equal(view.budget.writesUsed, 1, 'budget only counts the committed write');
    assert.equal(view.status, 'running', 'a failed write must not pause the session');
  } finally {
    await host.dispose();
  }
});

test('catch-up stamps events with row metadata (senderMetaId / index / timestamp) and never fabricates identity', { timeout: 20_000 }, async () => {
  const { host, db } = buildHost();
  try {
    const session = await startSession(host);
    // 等自家 seat.claimed 落链完成（轮询 write-log）。
    await waitFor(() => {
      const row = db.exec(
        `SELECT status FROM agent_game_write_log WHERE group_id = ? AND action_seq = 0`,
        [GROUP_ID],
      )[0]?.values?.[0];
      return String(row?.[0]) === 'committed';
    }, { label: 'own seat.claimed committed' });

    // 种入对局群历史：红方 match.created / 红方 action / 匿名 chat（sender 为 NULL）。
    // chain_timestamp 是索引器的 Unix 秒；宿主 runtime 的 withRowMeta 把它归一到
    // 毫秒后才写进 meta.timestamp（EventMeta 单位契约：毫秒），故 fixture 用真实
    // 10 位秒值、断言用 ×1000 的毫秒值 —— 这两种口径的混装就是 S1 时基缺陷。
    insertRow(db, {
      pinId: 'pin-match-created',
      senderGlobalMetaId: RED_AGENT,
      msgIndex: 1,
      chainTimestamp: 1_790_450_690,
      content: envelopeOf('match.created', { payload: { title: 'R vs B' } }),
    });
    insertRow(db, {
      pinId: 'pin-action-1',
      senderGlobalMetaId: RED_AGENT,
      msgIndex: 2,
      chainTimestamp: 1_790_450_691,
      content: envelopeOf('action', { actionSeq: 1, prevStateHash: 'sha256:a', stateHash: 'sha256:b', payload: { move: 'h2e2' } }),
    });
    insertRow(db, {
      pinId: 'pin-chat-anon',
      senderGlobalMetaId: null,
      msgIndex: 3,
      chainTimestamp: 1_790_450_692,
      content: envelopeOf('chat', { payload: {} }),
    });

    host.onGroupMessage(GROUP_ID);

    await waitFor(async () => {
      const state = await serializedStateOf(host, session.sessionId);
      return Boolean(state && state.log && state.log.length >= 4);
    }, { label: 'catch-up reduced seeded rows' });

    const state = await serializedStateOf(host, session.sessionId);
    const byType = (type) => state.log.filter((entry) => entry.type === type);

    // 红方 match.created：完整元组（index/timestamp/sender 全取自行，时间戳已归一为毫秒）。
    const created = byType('match.created');
    assert.equal(created.length, 1);
    assert.equal(created[0].sender, RED_AGENT);
    assert.equal(created[0].index, 1);
    assert.equal(created[0].timestamp, 1_790_450_690_000);

    // 走子归因恢复：action 的 senderMetaId 来自行元数据（此前恒为 ''）。
    const action = byType('action');
    assert.equal(action.length, 1);
    assert.equal(action[0].sender, RED_AGENT);
    assert.equal(action[0].index, 2);
    assert.equal(action[0].timestamp, 1_790_450_691_000);

    // 禁止凭空合成：行 sender 为 NULL → 元数据缺省（adapter 侧读作 ''）。
    const chat = byType('chat');
    assert.equal(chat.length, 1);
    assert.equal(chat[0].sender, '');
    assert.equal(chat[0].index, 3);
    assert.equal(chat[0].timestamp, 1_790_450_692_000);

    // 自家 seat.claimed：post-write 本地 reduce 的 own-meta 盖章归因正确。
    const ownClaim = byType('seat.claimed');
    assert.equal(ownClaim.length, 1);
    assert.equal(ownClaim[0].sender, BLACK_AGENT, 'own seat.claimed must attribute to the session agent, never ""');

    // 游标推进到最新消费行。
    assert.equal(host.store.getSession(session.sessionId).lastIndex, 3);
  } finally {
    await host.dispose();
  }
});
