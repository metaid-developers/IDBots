// Session attribution for chain writes — the minimal "请求者维度" change.
// Spec: pin://64fbb0ad049ead723c788c26b9495845190fd49d6fd6e7600006a22e9aa487f8i0
// (Karvis, 2026-10-28) + the 2026-11-19 main re-verification comment.
//
// Contract under test:
//   a. fixed origin grammar: rpc#s=<sid>#m=<ok|mismatch|unknown> and
//      tool:omni_cast#s=<sid>; no declaration keeps the bare legacy origin;
//   b. the verdict is a pure function of (session owner, request metabot):
//      ok / mismatch / unknown, with strict mode turning mismatch into 409;
//   c. the lookup reads cowork_sessions.metabot_id through the same sql.js
//      handle the RPC server uses;
//   d. G1/G2/G3 replay on the real ledger schema: new rows never land as bare
//      'rpc' or bare 'tool:omni_cast', and G2's SQL actually sees a mismatch
//      and an unknown session;
//   e. wiring: the RPC handler and omni_cast both call the shared helpers.
//
// Runs against the compiled output (pnpm run compile:electron first).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';
import { fileURLToPath } from 'node:url';
import { getCompiledStores, getSqlJs } from './memoryTestUtils.mjs';

const require = Module.createRequire(import.meta.url);
const {
  RPC_STRICT_CALLER_SESSION_ENV,
  buildOmniCastOrigin,
  buildRpcCreatePinOrigin,
  classifyCallerSession,
  isStrictCallerSessionEnabled,
  lookupCoworkSessionMetabotId,
  normalizeCallerSessionId,
  shouldRejectCallerSession,
} = require('../dist-electron/main/services/chainWriteAttribution.js');
const { SqliteStore } = getCompiledStores();

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function openStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-attribution-'));
  const SQL = await getSqlJs();
  const db = new SQL.Database();
  const store = new SqliteStore(db, path.join(dir, 'test.sqlite'));
  store.initializeTables(dir);
  return { dir, store };
}

function insertSession(db, id, metabotId) {
  const now = Date.now();
  db.run(
    `INSERT INTO cowork_sessions (id, title, status, cwd, metabot_id, created_at, updated_at)
     VALUES (?, ?, 'idle', ?, ?, ?, ?)`,
    [id, `session ${id}`, os.tmpdir(), metabotId, now, now],
  );
}

function insertWrite(db, { metabotId, pinId, origin, occurredAtMs }) {
  db.run(
    `INSERT INTO metabot_chain_writes (metabot_id, pin_id, origin, occurred_at_ms)
     VALUES (?, ?, ?, ?)`,
    [metabotId, pinId, origin, occurredAtMs],
  );
}

function count(db, sql, params = []) {
  return db.exec(sql, params)[0]?.values?.[0]?.[0] ?? 0;
}

test('normalizes only safe session tokens', () => {
  assert.equal(
    normalizeCallerSessionId('  a53a5aef-243b-4efe-9261-c6e08c56ffa8  '),
    'a53a5aef-243b-4efe-9261-c6e08c56ffa8',
  );
  assert.equal(normalizeCallerSessionId('sess_1:part-2.ok'), 'sess_1:part-2.ok');
  assert.equal(normalizeCallerSessionId(''), undefined);
  assert.equal(normalizeCallerSessionId('   '), undefined);
  assert.equal(normalizeCallerSessionId('bad#sess#m=ok'), undefined, 'a # would forge the grammar');
  assert.equal(normalizeCallerSessionId('x'.repeat(129)), undefined);
  assert.equal(normalizeCallerSessionId(42), undefined);
  assert.equal(normalizeCallerSessionId(null), undefined);
});

test('classifies the declared session against the signing metabot', () => {
  assert.equal(classifyCallerSession(7, 7), 'ok');
  assert.equal(classifyCallerSession(7, 8), 'mismatch');
  assert.equal(classifyCallerSession(null, 7), 'unknown');
  assert.equal(classifyCallerSession(undefined, 7), 'unknown');
});

test('builds the fixed origin grammar and preserves the bare fallback', () => {
  assert.equal(buildRpcCreatePinOrigin(undefined, undefined), 'rpc');
  assert.equal(buildRpcCreatePinOrigin('sess-1', 'ok'), 'rpc#s=sess-1#m=ok');
  assert.equal(buildRpcCreatePinOrigin('sess-1', 'mismatch'), 'rpc#s=sess-1#m=mismatch');
  assert.equal(buildRpcCreatePinOrigin('sess-1', 'unknown'), 'rpc#s=sess-1#m=unknown');
  assert.equal(buildRpcCreatePinOrigin('sess-1'), 'rpc#s=sess-1#m=unknown');
  assert.equal(buildOmniCastOrigin('sess-1'), 'tool:omni_cast#s=sess-1');
  assert.equal(buildOmniCastOrigin(undefined), 'tool:omni_cast');
  assert.equal(buildOmniCastOrigin('bad#id'), 'tool:omni_cast');
});

test('strict mode is an explicit opt-in and only refuses a positive mismatch', () => {
  assert.equal(isStrictCallerSessionEnabled({ [RPC_STRICT_CALLER_SESSION_ENV]: '1' }), true);
  assert.equal(isStrictCallerSessionEnabled({ [RPC_STRICT_CALLER_SESSION_ENV]: ' TRUE ' }), true);
  assert.equal(isStrictCallerSessionEnabled({ [RPC_STRICT_CALLER_SESSION_ENV]: 'on' }), true);
  assert.equal(isStrictCallerSessionEnabled({ [RPC_STRICT_CALLER_SESSION_ENV]: '0' }), false);
  assert.equal(isStrictCallerSessionEnabled({}), false);

  assert.equal(shouldRejectCallerSession('mismatch', true), true);
  assert.equal(shouldRejectCallerSession('mismatch', false), false);
  assert.equal(shouldRejectCallerSession('ok', true), false);
  assert.equal(shouldRejectCallerSession('unknown', true), false);
  assert.equal(shouldRejectCallerSession(undefined, true), false);
});

test('reads cowork_sessions.metabot_id and maps the three verdicts', async () => {
  const { dir, store } = await openStore();
  try {
    const db = store.getDatabase();
    insertSession(db, 'sess-owner', 9);

    assert.equal(lookupCoworkSessionMetabotId(db, 'sess-owner'), 9);
    assert.equal(lookupCoworkSessionMetabotId(db, 'sess-missing'), null);

    const own = lookupCoworkSessionMetabotId(db, 'sess-owner');
    assert.equal(classifyCallerSession(own, 9), 'ok');
    assert.equal(classifyCallerSession(own, 10), 'mismatch');
    assert.equal(
      buildRpcCreatePinOrigin('sess-owner', classifyCallerSession(own, 9)),
      'rpc#s=sess-owner#m=ok',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('G1/G2/G3 replay on the real ledger schema', async () => {
  const { dir, store } = await openStore();
  try {
    const db = store.getDatabase();
    insertSession(db, 'sess-owner', 9);
    const cutoff = Date.now();

    // Rows from before the cutover are outside the criteria window.
    insertWrite(db, { metabotId: 9, pinId: 'legacy-rpc', origin: 'rpc', occurredAtMs: cutoff - 1_000 });
    insertWrite(db, { metabotId: 9, pinId: 'legacy-omni', origin: 'tool:omni_cast', occurredAtMs: cutoff - 1_000 });

    // Post-change rows are produced by the same decision path the handler and
    // omni_cast use.
    insertWrite(db, {
      metabotId: 9,
      pinId: 'rpc-ok',
      origin: buildRpcCreatePinOrigin(
        'sess-owner',
        classifyCallerSession(lookupCoworkSessionMetabotId(db, 'sess-owner'), 9),
      ),
      occurredAtMs: cutoff + 1,
    });
    insertWrite(db, {
      metabotId: 9,
      pinId: 'omni-ok',
      origin: buildOmniCastOrigin('sess-owner'),
      occurredAtMs: cutoff + 2,
    });

    const G1 = `SELECT COUNT(*) FROM metabot_chain_writes
                WHERE origin = 'rpc' AND occurred_at_ms >= ?`;
    const G2 = `
      WITH parsed AS (
        SELECT metabot_id, origin,
          substr(origin, instr(origin, '#s=') + 3,
                 instr(substr(origin, instr(origin, '#s=') + 3), '#') - 1) AS sid
        FROM metabot_chain_writes
        WHERE origin LIKE 'rpc#s=%' AND occurred_at_ms >= ?
      )
      SELECT COUNT(*) FROM parsed p
      LEFT JOIN cowork_sessions s ON s.id = p.sid
      WHERE s.id IS NULL OR s.metabot_id <> p.metabot_id`;
    const G3 = `SELECT COUNT(*) FROM metabot_chain_writes
                WHERE origin = 'tool:omni_cast' AND occurred_at_ms >= ?`;

    assert.equal(count(db, G1, [cutoff]), 0, 'G1: no new bare rpc rows');
    assert.equal(count(db, G2, [cutoff]), 0, 'G2: clean rows resolve and are same-owner');
    assert.equal(count(db, G3, [cutoff]), 0, 'G3: no new bare tool:omni_cast rows');

    // The criteria must SEE the two anomalies they exist to catch.
    insertWrite(db, {
      metabotId: 10,
      pinId: 'rpc-mismatch',
      origin: buildRpcCreatePinOrigin('sess-owner', 'mismatch'),
      occurredAtMs: cutoff + 3,
    });
    insertWrite(db, {
      metabotId: 9,
      pinId: 'rpc-unknown',
      origin: buildRpcCreatePinOrigin('ghost-session', 'unknown'),
      occurredAtMs: cutoff + 4,
    });
    assert.equal(count(db, G1, [cutoff]), 0);
    assert.equal(count(db, G3, [cutoff]), 0);
    assert.equal(count(db, G2, [cutoff]), 2, 'G2 flags 1 mismatch + 1 unknown session');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('RPC handler and omni_cast share the same attribution helpers', () => {
  const rpc = fs.readFileSync(path.join(REPO_ROOT, 'src/main/services/metaidRpcServer.ts'), 'utf8');
  assert.match(rpc, /from '\.\/chainWriteAttribution'/);
  assert.match(rpc, /caller_session_id\?: unknown/);
  assert.match(rpc, /lookupCoworkSessionMetabotId\(getStore\(\)\.getDatabase\(\), callerSessionId\)/);
  assert.match(rpc, /shouldRejectCallerSession\(callerSessionMatch, isStrictCallerSessionEnabled\(\)\)/);
  assert.match(rpc, /origin: buildRpcCreatePinOrigin\(callerSessionId, callerSessionMatch\)/);
  assert.match(rpc, /res\.writeHead\(409\)/);

  const omni = fs.readFileSync(path.join(REPO_ROOT, 'src/main/libs/omniCasterAgentTools.ts'), 'utf8');
  assert.match(omni, /from '\.\.\/services\/chainWriteAttribution'/);
  assert.match(omni, /origin: buildOmniCastOrigin\(sessionId\)/);
  assert.doesNotMatch(omni, /origin: 'tool:omni_cast'/);
});
