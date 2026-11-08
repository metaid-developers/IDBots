import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';

const require = Module.createRequire(import.meta.url);
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'electron') {
    return { app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => process.cwd() } };
  }
  return originalLoad.apply(this, arguments);
};
const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');
const { CoworkStore } = require('../dist-electron/main/coworkStore.js');
const { CoworkRunner } = require('../dist-electron/main/libs/coworkRunner.js');
const { CoworkCrossSessionService } = require('../dist-electron/main/services/coworkCrossSession.js');
const { CrossSessionDeliveryStore } = require('../dist-electron/main/crossSessionDeliveryStore.js');
const { buildDispatchReportMessage, tailDispatchReportExcerpt, DISPATCH_REPORT_EXCERPT_MAX_CHARS } = require('../dist-electron/main/libs/coworkCrossSessionReport.js');
Module._load = originalLoad;

// ---------------------------------------------------------------------------
// Pure composer: buildDispatchReportMessage / tailDispatchReportExcerpt
// ---------------------------------------------------------------------------

test('dispatch report excerpt is tail-biased and flags truncation', () => {
  assert.equal(tailDispatchReportExcerpt(null), null);
  assert.equal(tailDispatchReportExcerpt('   '), null);
  const short = tailDispatchReportExcerpt('SELLER_REPORT_C: C1-C4 all green');
  assert.equal(short.truncated, false);
  assert.equal(short.excerpt, 'SELLER_REPORT_C: C1-C4 all green');

  const long = 'x'.repeat(DISPATCH_REPORT_EXCERPT_MAX_CHARS + 500);
  const tail = tailDispatchReportExcerpt(long);
  assert.equal(tail.truncated, true);
  assert.equal(tail.excerpt.length, DISPATCH_REPORT_EXCERPT_MAX_CHARS);
  assert.equal(tail.excerpt, long.slice(long.length - DISPATCH_REPORT_EXCERPT_MAX_CHARS));
});

test('dispatch report message covers completed, no-reply, and failed outcomes deterministically', () => {
  const completed = buildDispatchReportMessage({
    deliveryId: 'delivery-1',
    targetSessionId: 'worker-session',
    outcome: 'completed',
    finalReply: 'C4 verified. SELLER_REPORT_C follows.',
    finalReplyTruncated: false,
  });
  assert.match(completed, /\[DISPATCH-REPORT\] 你此前投递到会话 worker-session 的消息（deliveryId delivery-1）已执行完毕，outcome=completed。/);
  assert.match(completed, /<worker_report trust="untrusted">C4 verified\. SELLER_REPORT_C follows\.<\/worker_report>/);
  assert.ok(!completed.includes('仅截取末尾'));

  const truncated = buildDispatchReportMessage({
    deliveryId: 'delivery-1',
    targetSessionId: 'worker-session',
    outcome: 'completed',
    finalReply: 'tail only',
    finalReplyTruncated: true,
  });
  assert.match(truncated, /仅截取末尾/);

  const noReply = buildDispatchReportMessage({
    deliveryId: 'delivery-2',
    targetSessionId: 'worker-session',
    outcome: 'completed',
    finalReply: null,
  });
  assert.match(noReply, /outcome=completed/);
  assert.match(noReply, /该回合没有产生可见回复/);
  assert.ok(!noReply.includes('worker_report'));

  const failed = buildDispatchReportMessage({
    deliveryId: 'delivery-3',
    targetSessionId: 'worker-session',
    outcome: 'failed',
    failureReason: 'persistent outage',
    finalReply: null,
  });
  assert.match(failed, /outcome=failed/);
  assert.match(failed, /失败原因：persistent outage/);

  // Determinism: identical inputs → identical bytes (the dispatch_report:<id>
  // idempotency dedupe relies on this).
  const again = buildDispatchReportMessage({
    deliveryId: 'delivery-1',
    targetSessionId: 'worker-session',
    outcome: 'completed',
    finalReply: 'C4 verified. SELLER_REPORT_C follows.',
    finalReplyTruncated: false,
  });
  assert.equal(again, completed);
});

// ---------------------------------------------------------------------------
// Service-level: notifySource stamps the inserted message metadata
// ---------------------------------------------------------------------------

async function openWorld(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-dispatch-report-'));
  const sqliteStore = await SqliteStore.create(dir);
  const coworkStore = new CoworkStore(sqliteStore.getDatabase(), sqliteStore.getSaveFunction());
  const deliveryStore = new CrossSessionDeliveryStore(
    sqliteStore.getDatabase(),
    sqliteStore.getSaveFunction(),
    { backoffMs: options.backoffMs ?? [20, 20] },
  );
  const source = coworkStore.createSession('source', dir, '', 'local', [], 1);
  const target = coworkStore.createSession('target', dir, '', 'local', [], 1);
  const runner = new CoworkRunner(coworkStore, { crossSessionDeliveryStore: deliveryStore });
  const calls = [];
  runner.continueSession = async (sessionId, prompt) => {
    calls.push({ sessionId, prompt });
    if (options.onContinue) await options.onContinue(sessionId, calls.length);
  };
  return { dir, sqliteStore, coworkStore, deliveryStore, runner, calls, source, target };
}

function dispose(world) {
  try { world.sqliteStore.close(); } catch { /* already closed */ }
  try { fs.rmSync(world.dir, { recursive: true, force: true }); } catch { /* Windows best effort */ }
}

async function waitFor(assertion, timeoutMs = 2000) {
  const startedAt = Date.now();
  let lastError;
  while (Date.now() - startedAt < timeoutMs) {
    try { assertion(); return; } catch (error) { lastError = error; await new Promise((resolve) => setTimeout(resolve, 5)); }
  }
  if (lastError) throw lastError;
  assertion();
}

test('insertUserMessage accepts the scheduled-task pseudo-source namespace', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-dispatch-report-pseudo-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
  const sqliteStore = await SqliteStore.create(dir);
  t.after(() => { try { sqliteStore.close(); } catch { /* best effort */ } });
  const coworkStore = new CoworkStore(sqliteStore.getDatabase(), sqliteStore.getSaveFunction());
  const service = new CoworkCrossSessionService(coworkStore);
  const target = coworkStore.createSession('origin chat', dir, '', 'local', [], 1);

  // `scheduled-task:<id>` has NO cowork_sessions row by design (scheduler run
  // reports failed before their worker session opened) — it must not be
  // rejected as SESSION_NOT_FOUND, same as the group-task namespace.
  const result = service.insertUserMessage({
    sourceSessionId: 'scheduled-task:9f1c2f0e-1111-4222-8333-444455556666',
    targetSessionId: target.id,
    message: 'run failed before its session opened',
    deliveryId: 'schedule_report:x:y',
  });
  assert.equal(result.ok, true);
  assert.equal(result.message.metadata.sourceSessionId, 'scheduled-task:9f1c2f0e-1111-4222-8333-444455556666');
});

test('insertUserMessage stamps crossSessionNotifySource only when requested', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-dispatch-report-meta-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
  const sqliteStore = await SqliteStore.create(dir);
  t.after(() => { try { sqliteStore.close(); } catch { /* best effort */ } });
  const coworkStore = new CoworkStore(sqliteStore.getDatabase(), sqliteStore.getSaveFunction());
  const service = new CoworkCrossSessionService(coworkStore);
  const source = coworkStore.createSession('source', dir, '', 'local', [], 1);
  const target = coworkStore.createSession('target', dir, '', 'local', [], 1);

  const flagged = service.insertUserMessage({
    sourceSessionId: source.id,
    targetSessionId: target.id,
    message: 'work order',
    deliveryId: 'flagged-dispatch',
    notifySource: true,
  });
  assert.equal(flagged.ok, true);
  assert.equal(flagged.message.metadata.crossSessionNotifySource, true);
  assert.equal(flagged.message.metadata.crossSessionDeliveryId, 'flagged-dispatch');

  const plain = service.insertUserMessage({
    sourceSessionId: source.id,
    targetSessionId: target.id,
    message: 'fyi notice',
    deliveryId: 'plain-relay',
  });
  assert.equal(plain.ok, true);
  assert.equal('crossSessionNotifySource' in plain.message.metadata, false);
});

test('a notifySource dispatch reports back into the source session when the turn settles', async () => {
  const world = await openWorld();
  try {
    const queued = world.runner.insertCrossSessionMessageAndQueue({
      sourceSessionId: world.source.id,
      targetSessionId: world.target.id,
      message: 'run Phase C and print SELLER_REPORT_C',
      deliveryId: 'phase-c-dispatch',
      notifySource: true,
    });
    assert.equal(queued.insert.ok, true);

    await waitFor(() => assert.equal(world.deliveryStore.getById('phase-c-dispatch').state, 'completed'));
    // The dispatched turn settled; the host must arm the return path.
    await waitFor(() => {
      const report = world.deliveryStore.getById('dispatch_report:phase-c-dispatch');
      assert.ok(report, 'dispatch_report delivery row must exist');
      assert.equal(report.state, 'completed');
      assert.equal(report.sourceSessionId, world.target.id);
      assert.equal(report.targetSessionId, world.source.id);
    });

    // The report is a real cross-session message in the SOURCE session.
    const sourceMessages = world.coworkStore.getSessionMessages(world.source.id);
    const reportMessage = sourceMessages.find((message) => message.id === 'dispatch_report:phase-c-dispatch');
    assert.ok(reportMessage, 'dispatch report message inserted into the source session');
    assert.match(reportMessage.content, /\[DISPATCH-REPORT\]/);
    assert.match(reportMessage.content, /outcome=completed/);
    assert.equal(reportMessage.metadata.sourceSessionId, world.target.id);
    assert.equal(reportMessage.metadata.crossSessionDeliveryId, 'dispatch_report:phase-c-dispatch');

    // The report itself was queued as a turn in the source session exactly once.
    const reportCalls = world.calls.filter((call) => call.sessionId === world.source.id);
    assert.equal(reportCalls.length, 1);
    assert.match(reportCalls[0].prompt, /\[DISPATCH-REPORT\]/);
  } finally {
    dispose(world);
  }
});

test('a default dispatch (no notifySource) stays fire-and-forget with no report row', async () => {
  const world = await openWorld();
  try {
    world.runner.insertCrossSessionMessageAndQueue({
      sourceSessionId: world.source.id,
      targetSessionId: world.target.id,
      message: 'internal relay, own notify path',
      deliveryId: 'orch-style-dispatch',
    });
    await waitFor(() => assert.equal(world.deliveryStore.getById('orch-style-dispatch').state, 'completed'));
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(world.deliveryStore.getById('dispatch_report:orch-style-dispatch'), null);
    assert.equal(world.calls.filter((call) => call.sessionId === world.source.id).length, 0);
  } finally {
    dispose(world);
  }
});

test('a terminally failed dispatch reports the failure back to the source session', async () => {
  const world = await openWorld({
    backoffMs: [5, 5],
    // Only the TARGET session's turns fail; the source session must stay
    // healthy so the failure report itself can complete.
    onContinue: (sessionId) => {
      if (sessionId === world?.target?.id) throw new Error('persistent outage');
    },
  });
  try {
    world.runner.insertCrossSessionMessageAndQueue({
      sourceSessionId: world.source.id,
      targetSessionId: world.target.id,
      message: 'work order that will never start',
      deliveryId: 'doomed-dispatch',
      notifySource: true,
    });
    await waitFor(() => assert.equal(world.deliveryStore.getById('doomed-dispatch').state, 'failed'));
    await waitFor(() => {
      const report = world.deliveryStore.getById('dispatch_report:doomed-dispatch');
      assert.ok(report, 'terminal delivery failure must still report back');
      assert.equal(report.state, 'completed');
    });
    const reportMessage = world.coworkStore.getSessionMessages(world.source.id)
      .find((message) => message.id === 'dispatch_report:doomed-dispatch');
    assert.ok(reportMessage);
    assert.match(reportMessage.content, /outcome=failed/);
    assert.match(reportMessage.content, /失败原因：persistent outage/);
  } finally {
    dispose(world);
  }
});

// ---------------------------------------------------------------------------
// Store: notify_source column round-trip + legacy-table migration
// ---------------------------------------------------------------------------

test('delivery store persists the notifySource flag', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-dispatch-report-store-'));
  try {
    const sqliteStore = await SqliteStore.create(dir);
    try {
      const deliveryStore = new CrossSessionDeliveryStore(sqliteStore.getDatabase(), sqliteStore.getSaveFunction());
      const flagged = deliveryStore.enqueue({
        sourceSessionId: 'a',
        targetSessionId: 'b',
        message: 'm',
        deliveryId: 'flagged',
        notifySource: true,
      });
      assert.equal(flagged.notifySource, true);
      const plain = deliveryStore.enqueue({
        sourceSessionId: 'a',
        targetSessionId: 'b',
        message: 'm2',
        deliveryId: 'plain',
      });
      assert.equal(plain.notifySource, false);
      assert.equal(deliveryStore.getById('flagged').notifySource, true);
    } finally {
      try { sqliteStore.close(); } catch { /* already closed */ }
    }
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Windows best effort */ }
  }
});

test('delivery store migrates a pre-notify_source table via ALTER', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-dispatch-report-migrate-'));
  try {
    const sqliteStore = await SqliteStore.create(dir);
    try {
      const db = sqliteStore.getDatabase();
      // Recreate the legacy shape (no notify_source column), as an upgraded
      // user's database would carry it.
      db.run('DROP TABLE IF EXISTS cowork_cross_session_deliveries;');
      db.run(`
        CREATE TABLE cowork_cross_session_deliveries (
          id TEXT PRIMARY KEY,
          source_session_id TEXT NOT NULL,
          target_session_id TEXT NOT NULL,
          message TEXT NOT NULL,
          message_id TEXT,
          rendered_message TEXT,
          state TEXT NOT NULL DEFAULT 'pending'
            CHECK(state IN ('pending','running','completed','failed','cancelled')),
          attempts INTEGER NOT NULL DEFAULT 0,
          next_attempt_at INTEGER NOT NULL DEFAULT 0,
          last_error TEXT,
          created_at INTEGER NOT NULL,
          inserted_at INTEGER,
          started_at INTEGER,
          completed_at INTEGER,
          updated_at INTEGER NOT NULL
        );
      `);
      const deliveryStore = new CrossSessionDeliveryStore(db, sqliteStore.getSaveFunction());
      const row = deliveryStore.enqueue({
        sourceSessionId: 'a',
        targetSessionId: 'b',
        message: 'm',
        deliveryId: 'after-migration',
        notifySource: true,
      });
      assert.equal(row.notifySource, true);
      assert.equal(deliveryStore.getById('after-migration').notifySource, true);
    } finally {
      try { sqliteStore.close(); } catch { /* already closed */ }
    }
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Windows best effort */ }
  }
});
