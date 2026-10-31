// CoworkRunner.rejudgePendingCerebellumFollowUps — the startup re-judge sweep
// for the Follow-Up Tasks (待跟进任务) bucket.
//
// Pending 'cerebellum' verdicts written by an older gate revision (lower
// threshold, different instructions, no end-of-run follow-up tag) would
// otherwise park in Follow-Up until their session happens to turn again — a
// weekly scheduled task could strand a stale pending for weeks. The sweep
// re-classifies each pending row under the CURRENT gate, sequentially.
//
// Contract under test:
//   a. listPendingFollowUpSessionIds — only the requested lane, oldest
//      verdict first, limit respected, manual/ask_user/cleared rows excluded;
//   b. the sweep re-judges every listed row through the injected gate and
//      applies the verdict (false settles back, true re-parks);
//   c. a `[FOLLOW_UP: none]` tag settles the row WITHOUT spending a gate call
//      (the deterministic end-of-run contract path);
//   d. manual pins and ask_user markers are never listed, never re-judged;
//   e. the sweep is fail-open: a store error returns 0 instead of throwing.
//
// Runs against the compiled output (pnpm run compile:electron first).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';

import { getCompiledStores, getSqlJs } from './memoryTestUtils.mjs';

const require = Module.createRequire(import.meta.url);

function loadCoworkRunner() {
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request) {
    if (request === 'electron') {
      return {
        app: {
          isPackaged: false,
          getAppPath: () => process.cwd(),
          getPath: () => process.cwd(),
        },
      };
    }
    return originalLoad.apply(this, arguments);
  };
  try {
    const compiledRunner = fs.existsSync(new URL('../dist-electron/main/libs/coworkRunner.js', import.meta.url))
      ? '../dist-electron/main/libs/coworkRunner.js'
      : '../dist-electron/libs/coworkRunner.js';
    return require(compiledRunner).CoworkRunner;
  } finally {
    Module._load = originalLoad;
  }
}

const CoworkRunner = loadCoworkRunner();
const { SqliteStore, CoworkStore } = getCompiledStores();

const makeTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-followup-sweep-'));
const cleanupDir = (dir) => fs.rmSync(dir, { recursive: true, force: true });

async function openCoworkStore(dir) {
  const SQL = await getSqlJs();
  const dbPath = path.join(dir, 'test.sqlite');
  const db = fs.existsSync(dbPath) ? new SQL.Database(fs.readFileSync(dbPath)) : new SQL.Database();
  const store = new SqliteStore(db, dbPath);
  store.initializeTables(dir);
  return new CoworkStore(store.getDatabase(), store.getSaveFunction());
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('listPendingFollowUpSessionIds: only the requested lane, oldest first, limit respected', async () => {
  const dir = makeTempDir();
  const cowork = await openCoworkStore(dir);
  try {
    const oldest = cowork.createSession('[定时] Old run', dir);
    const newest = cowork.createSession('[定时] New run', dir);
    const manual = cowork.createSession('[长期] Owner-pinned', dir);
    const askUser = cowork.createSession('[长期] Pending ask', dir);
    for (const id of [oldest.id, newest.id, manual.id, askUser.id]) {
      cowork.setSessionAutoOrigin(id, 'schedule');
    }

    cowork.setSessionFollowUp(oldest.id, 'cerebellum');
    await sleep(5);
    cowork.setSessionFollowUp(newest.id, 'cerebellum');
    await sleep(5);
    cowork.setSessionFollowUp(manual.id, 'manual');
    cowork.setSessionFollowUp(askUser.id, 'ask_user');

    assert.deepEqual(cowork.listPendingFollowUpSessionIds('cerebellum', 100), [oldest.id, newest.id]);
    assert.deepEqual(cowork.listPendingFollowUpSessionIds('cerebellum', 1), [oldest.id], 'oldest verdict first');
    assert.deepEqual(cowork.listPendingFollowUpSessionIds('cerebellum', 0), [], 'non-positive limit lists nothing');
    assert.deepEqual(
      cowork.listPendingFollowUpSessionIds('manual', 100),
      [manual.id],
      'the lane filter matches the requested lane only — and the sweep only ever asks for cerebellum',
    );
  } finally {
    try { cowork.close?.(); } catch { /* store close is best-effort in tests */ }
    cleanupDir(dir);
  }
});

test('rejudgePendingCerebellumFollowUps: re-judges every listed row, applies verdicts, honors the tag', async () => {
  const dir = makeTempDir();
  const cowork = await openCoworkStore(dir);
  try {
    const plain = cowork.createSession('[定时] Plain report run', dir);
    const ownerAsk = cowork.createSession('[定时] Real decision run', dir);
    const taggedNone = cowork.createSession('[定时] Tagged-none run', dir);
    const manual = cowork.createSession('[定时] Owner-pinned run', dir);
    for (const id of [plain.id, ownerAsk.id, taggedNone.id, manual.id]) {
      cowork.setSessionAutoOrigin(id, 'schedule');
    }

    cowork.addMessage(plain.id, {
      type: 'assistant',
      content: '巡检完成：三个端点全部健康，延迟正常，无异常项。',
    });
    cowork.addMessage(ownerAsk.id, {
      type: 'assistant',
      content: '迁移方案已就绪：A 成本低、B 更稳。请确认用哪个方案，我再继续执行。',
    });
    cowork.addMessage(taggedNone.id, {
      type: 'assistant',
      content: '全部闭环：安装、烟测、回执上链均完成，等待方是另一个 bot，不需要主人处理。\n[FOLLOW_UP: none]',
    });
    cowork.addMessage(manual.id, {
      type: 'assistant',
      content: '一份旧报告。',
    });

    cowork.setSessionFollowUp(plain.id, 'cerebellum');
    cowork.setSessionFollowUp(ownerAsk.id, 'cerebellum');
    cowork.setSessionFollowUp(taggedNone.id, 'cerebellum');
    cowork.setSessionFollowUp(manual.id, 'manual');

    const gateCalls = [];
    const runner = new CoworkRunner(cowork, {
      cerebellumSessionFollowUpGate: async (input) => {
        gateCalls.push(input);
        return input.lastAssistantText.includes('请确认');
      },
    });

    const judged = await runner.rejudgePendingCerebellumFollowUps();
    assert.equal(judged, 3, 'three cerebellum rows listed (manual pin excluded)');

    const rowOf = (id) => {
      const session = cowork.getSession(id);
      return { state: session.followUpState, source: session.followUpSource };
    };
    assert.deepEqual(rowOf(plain.id), { state: null, source: null }, 'gate false settles the row back');
    assert.deepEqual(rowOf(ownerAsk.id), { state: 'pending', source: 'cerebellum' }, 'gate true re-parks');
    assert.deepEqual(rowOf(taggedNone.id), { state: null, source: null }, 'a none tag settles without the gate');
    assert.deepEqual(rowOf(manual.id), { state: 'pending', source: 'manual' }, 'manual pin untouched');

    assert.equal(gateCalls.length, 2, 'the tagged-none row never reaches the gate');
    assert.ok(
      gateCalls.every((call) => typeof call.sessionTitle === 'string' && typeof call.lastAssistantText === 'string'),
    );
  } finally {
    try { cowork.close?.(); } catch { /* store close is best-effort in tests */ }
    cleanupDir(dir);
  }
});

test('rejudgePendingCerebellumFollowUps: store errors fail open (returns 0, never throws)', async () => {
  const brokenStore = {
    listPendingFollowUpSessionIds() {
      throw new Error('boom');
    },
  };
  const runner = new CoworkRunner(brokenStore, {
    cerebellumSessionFollowUpGate: async () => true,
  });
  assert.equal(await runner.rejudgePendingCerebellumFollowUps(), 0);
});
