import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { WebSocket } from 'ws';
import { sha256Hex } from '../src/crypto.js';
import { api, freshDb, seedUserAndTenant, startTestApp, type TestApp } from './helpers.js';
import { StubUpstream } from '../src/services/asr/upstream-stub.js';
import { dayStartMs, insertUsageRow, finalizeUsageRow } from '../src/services/asr/usage.js';
import type { AsrGatewayOptions } from '../src/services/asr/gateway.js';

/**
 * Integration tests for the ASR voice gateway (`/asr/v1/ws`): auth
 * pass/reject, quota at connect and mid-session, upstream disconnect
 * recovery, usage recording, and one end-to-end voice stream over the stub
 * upstream. Fake docker is unnecessary (the gateway never touches tenants),
 * so only a user + session row are seeded.
 */

const USER_ID = 'u_asr_gw';
const PHONE = '+8613900007702';
const SESSION_TOKEN = 'asr-gw-test-session-token';

interface GwFrame {
  type?: string;
  [key: string]: unknown;
}

function connect(base: string, origin: string, options: { cookie?: string | null } = {}): WebSocket {
  const headers: Record<string, string> = { Origin: origin };
  if (options.cookie) {
    headers.Cookie = options.cookie;
  }
  return new WebSocket(`${base.replace(/^http/, 'ws')}/asr/v1/ws`, { headers });
}

function waitOpen(ws: WebSocket, ms = 4000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ws open timed out')), ms);
    ws.once('open', () => {
      clearTimeout(timer);
      resolve();
    });
    ws.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function waitClose(ws: WebSocket, ms = 6000): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ws close timed out')), ms);
    ws.once('close', (code, reason) => {
      clearTimeout(timer);
      resolve({ code, reason: reason.toString('utf8') });
    });
  });
}

function frameCollector(ws: WebSocket): {
  frames: GwFrame[];
  waitFrame: (pred: (f: GwFrame) => boolean, ms?: number) => Promise<GwFrame>;
} {
  const frames: GwFrame[] = [];
  const waiters: Array<{ pred: (f: GwFrame) => boolean; resolve: (f: GwFrame) => void; timer: ReturnType<typeof setTimeout> }> = [];
  ws.on('message', (data: Buffer, isBinary: boolean) => {
    if (isBinary) {
      return; // gateway never sends binary to the client
    }
    const frame = JSON.parse(data.toString('utf8')) as GwFrame;
    frames.push(frame);
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      if (waiters[i].pred(frame)) {
        clearTimeout(waiters[i].timer);
        waiters[i].resolve(frame);
        waiters.splice(i, 1);
      }
    }
  });
  const waitFrame = (pred: (f: GwFrame) => boolean, ms = 5000): Promise<GwFrame> =>
    new Promise((resolve, reject) => {
      const existing = [...frames].reverse().find(pred);
      if (existing) {
        resolve(existing);
        return;
      }
      const timer = setTimeout(() => reject(new Error(`frame wait timed out; have ${JSON.stringify(frames)}`)), ms);
      waiters.push({ pred, resolve, timer });
    });
  return { frames, waitFrame };
}

const AUDIO_CHUNK = Buffer.alloc(3200, 1); // 100 ms of s16le 16 kHz mono

interface GwTest {
  app: TestApp;
  origin: string;
  cookie: string;
}

async function setupGw(asr?: AsrGatewayOptions): Promise<GwTest> {
  const db = freshDb();
  seedUserAndTenant(db, { userId: USER_ID, phone: PHONE, tenantId: 't_asr_gw', status: 'ready' });
  const now = Date.now();
  db.prepare(
    `INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at, expires_at, user_agent, ip)
     VALUES (?, ?, ?, ?, ?, 'test', '127.0.0.1')`,
  ).run(sha256Hex(SESSION_TOKEN), USER_ID, now, now, now + 3600_000);
  const app = await startTestApp({
    db,
    dockerUrl: 'http://127.0.0.1:1', // never used by the ASR gateway
    asr,
  });
  return { app, origin: app.baseUrl, cookie: `idb_session=${SESSION_TOKEN}` };
}

describe('asr gateway auth (cookie + origin)', () => {
  let t: GwTest;

  before(async () => {
    t = await setupGw();
  });

  after(async () => {
    await t.app.close();
  });

  test('no cookie → close 4101', async () => {
    const ws = connect(t.app.baseUrl, t.origin, { cookie: null });
    const closed = waitClose(ws);
    await waitOpen(ws);
    const { code } = await closed;
    assert.equal(code, 4101);
  });

  test('bad Origin → close 4103', async () => {
    const ws = connect(t.app.baseUrl, 'https://evil.example.com', { cookie: t.cookie });
    const closed = waitClose(ws);
    await waitOpen(ws);
    const { code } = await closed;
    assert.equal(code, 4103);
  });

  test('valid cookie + origin → asr.open (e2e happy path over the stub)', async () => {
    const ws = connect(t.app.baseUrl, t.origin, { cookie: t.cookie });
    const { waitFrame } = frameCollector(ws);
    await waitOpen(ws);
    const open = await waitFrame((f) => f.type === 'asr.open');
    assert.ok(typeof open.sessionId === 'string' && (open.sessionId as string).startsWith('stub-'));
    assert.ok(typeof open.remainingMs === 'number' && (open.remainingMs as number) > 0);

    for (let i = 0; i < 4; i += 1) {
      ws.send(AUDIO_CHUNK);
    }
    const partial = await waitFrame((f) => f.type === 'asr.partial');
    assert.ok((partial.text as string).length > 0);

    ws.send(JSON.stringify({ type: 'finish' }));
    const final = await waitFrame((f) => f.type === 'asr.final');
    assert.equal(final.text, '今天天气怎么样');
    const done = await waitFrame((f) => f.type === 'asr.done');
    assert.ok((done.usageSeconds as number) >= 0);
    assert.ok(typeof done.remainingMs === 'number');

    const { code } = await waitClose(ws);
    assert.equal(code, 1000);

    // Usage was recorded: finalized row for this user.
    const row = t.app.app.db
      .prepare('SELECT upstream, ended_at, seconds, audio_bytes, finished, close_code FROM asr_usage WHERE user_id = ?')
      .get(USER_ID) as { upstream: string; ended_at: number; seconds: number; audio_bytes: number; finished: number; close_code: number };
    assert.equal(row.upstream, 'stub');
    assert.ok(row.ended_at !== null, 'row finalized');
    assert.ok(row.seconds >= 0);
    assert.equal(row.audio_bytes, AUDIO_CHUNK.length * 4);
    assert.equal(row.finished, 1);
    assert.equal(row.close_code, 1000);
  });

  test('abort tears down cleanly and records an unfinished row', async () => {
    const ws = connect(t.app.baseUrl, t.origin, { cookie: t.cookie });
    const { waitFrame } = frameCollector(ws);
    await waitOpen(ws);
    await waitFrame((f) => f.type === 'asr.open');
    ws.send(AUDIO_CHUNK);
    ws.send(JSON.stringify({ type: 'abort' }));
    const { code } = await waitClose(ws);
    assert.equal(code, 1000);
    const rows = t.app.app.db
      .prepare('SELECT finished, close_code FROM asr_usage WHERE user_id = ? ORDER BY id')
      .all(USER_ID) as Array<{ finished: number; close_code: number }>;
    const last = rows[rows.length - 1]!;
    assert.equal(last.finished, 0);
  });

  test('unknown text control frame → close 4106', async () => {
    const ws = connect(t.app.baseUrl, t.origin, { cookie: t.cookie });
    await waitOpen(ws);
    ws.send('not json at all');
    const { code } = await waitClose(ws);
    assert.equal(code, 4106);
  });

  test('GET /api/v1/asr/quota reflects recorded usage', async () => {
    const res = await api(t.app.baseUrl, '/api/v1/asr/quota', { cookie: t.cookie });
    assert.equal(res.status, 200);
    const body = res.json as { limitSeconds: number; usedSeconds: number; remainingSeconds: number; upstream: string };
    assert.equal(body.limitSeconds, 3600); // 60 min default
    assert.ok(body.usedSeconds >= 0);
    assert.ok(body.remainingSeconds <= body.limitSeconds);
    assert.equal(body.upstream, 'stub');
  });

  test('GET /api/v1/asr/quota without cookie → 401', async () => {
    const res = await api(t.app.baseUrl, '/api/v1/asr/quota', { cookie: null });
    assert.equal(res.status, 401);
  });
});

describe('asr gateway daily quota', () => {
  test('exhausted at connect → close 4104', async () => {
    const t = await setupGw();
    try {
      const now = Date.now();
      const id = insertUsageRow(t.app.app.db, { userId: USER_ID, upstream: 'stub', startedAt: now - 3700_000 });
      finalizeUsageRow(t.app.app.db, { id, endedAt: now - 100_000, startedAt: now - 3700_000, audioBytes: 0, finished: true, closeCode: 1000 });
      const ws = connect(t.app.baseUrl, t.origin, { cookie: t.cookie });
      const closed = waitClose(ws);
      await waitOpen(ws);
      const { code } = await closed;
      assert.equal(code, 4104);
    } finally {
      await t.app.close();
    }
  });

  test('exhausted mid-session → asr.error QUOTA_EXHAUSTED then close 4104', async () => {
    const t = await setupGw({ dailyLimitSeconds: 1 });
    try {
      const ws = connect(t.app.baseUrl, t.origin, { cookie: t.cookie });
      const { waitFrame } = frameCollector(ws);
      await waitOpen(ws);
      await waitFrame((f) => f.type === 'asr.open');
      const err = await waitFrame((f) => f.type === 'asr.error' && f.code === 'QUOTA_EXHAUSTED', 6000);
      assert.equal(err.retryable, false);
      const { code } = await waitClose(ws);
      assert.equal(code, 4104);
    } finally {
      await t.app.close();
    }
  });

  test('session cap closes with 4104 even under the daily limit', async () => {
    const t = await setupGw({ maxSessionSeconds: 1 });
    try {
      const ws = connect(t.app.baseUrl, t.origin, { cookie: t.cookie });
      const { waitFrame } = frameCollector(ws);
      await waitOpen(ws);
      await waitFrame((f) => f.type === 'asr.open');
      const err = await waitFrame((f) => f.type === 'asr.error' && f.code === 'SESSION_CAP', 6000);
      assert.equal(err.code, 'SESSION_CAP');
      const { code } = await waitClose(ws);
      assert.equal(code, 4104);
    } finally {
      await t.app.close();
    }
  });
});

describe('asr gateway upstream recovery', () => {
  test('stub drop mid-stream: client socket survives via auto-reopen', async () => {
    const stub = new StubUpstream({ faults: { disconnectAfterMs: 250 }, transcript: '今天天气怎么样', expectedChunks: 4 });
    const t = await setupGw({ upstream: stub });
    try {
      const ws = connect(t.app.baseUrl, t.origin, { cookie: t.cookie });
      const { frames, waitFrame } = frameCollector(ws);
      await waitOpen(ws);
      await waitFrame((f) => f.type === 'asr.open');

      ws.send(AUDIO_CHUNK);
      const lost = await waitFrame((f) => f.type === 'asr.error' && f.code === 'UPSTREAM_LOST', 6000);
      assert.equal(lost.retryable, true);

      // The gateway reopens the upstream on the SAME client socket.
      const secondOpen = await waitFrame((f) => f.type === 'asr.open', 6000);
      assert.ok(typeof secondOpen.sessionId === 'string');

      // Streaming continues on the survived socket.
      for (let i = 0; i < 4; i += 1) {
        ws.send(AUDIO_CHUNK);
      }
      await waitFrame((f) => f.type === 'asr.partial');
      ws.send(JSON.stringify({ type: 'finish' }));
      const final = await waitFrame((f) => f.type === 'asr.final');
      assert.equal(final.text, '今天天气怎么样');
      await waitFrame((f) => f.type === 'asr.done');
      const { code } = await waitClose(ws);
      assert.equal(code, 1000);

      // Exactly one retryable error and two asr.open events in the stream.
      assert.equal(frames.filter((f) => f.type === 'asr.error').length, 1);
      assert.equal(frames.filter((f) => f.type === 'asr.open').length, 2);
    } finally {
      await t.app.close();
    }
  });

  test('quota accumulates across sessions on the same day', async () => {
    const t = await setupGw({ dailyLimitSeconds: 3600 });
    try {
      const runOne = async (): Promise<void> => {
        const ws = connect(t.app.baseUrl, t.origin, { cookie: t.cookie });
        const { waitFrame } = frameCollector(ws);
        await waitOpen(ws);
        await waitFrame((f) => f.type === 'asr.open');
        ws.send(AUDIO_CHUNK);
        await waitFrame((f) => f.type === 'asr.partial');
        ws.send(JSON.stringify({ type: 'finish' }));
        await waitFrame((f) => f.type === 'asr.done');
        await waitClose(ws);
      };
      await runOne();
      await runOne();
      const rows = t.app.app.db
        .prepare('SELECT COUNT(*) AS n, SUM(seconds) AS s FROM asr_usage WHERE user_id = ? AND started_at >= ?')
        .get(USER_ID, dayStartMs(Date.now())) as { n: number; s: number | null };
      assert.equal(rows.n, 2);
      assert.ok((rows.s ?? 0) > 0, 'accumulated seconds across both sessions');
    } finally {
      await t.app.close();
    }
  });
});
