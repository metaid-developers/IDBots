// Store pins for the Studio chapter model (2026-11-19 Phase 1, owner ruling
// 方案 B — chapters close INSIDE one cw- session; no session rollover):
// cowork_session_chapters rows carry the durable chapter cards that survive
// compaction. Run `pnpm run compile:electron` first (mirrors
// conversationRecallStore.test.mjs).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');
const { CoworkStore } = require('../dist-electron/main/coworkStore.js');

const here = path.dirname(fileURLToPath(import.meta.url));
const runnerSource = readFileSync(path.join(here, '../src/main/libs/coworkRunner.ts'), 'utf8');

async function openStore(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const sqliteStore = await SqliteStore.create(dir);
  const db = sqliteStore.getDatabase();
  const save = sqliteStore.getSaveFunction();
  const coworkStore = new CoworkStore(db, save);
  return { coworkStore, sqliteStore, dir };
}

/** Windows teardown: close before the tolerant rm (house pattern). */
function disposeStore(sqliteStore, dir) {
  try {
    sqliteStore.close();
  } catch {
    // already closed
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // a lingering Windows handle must never fail the test during cleanup
  }
}

function seedSession(store, title = 'Chapter test') {
  return store.createSession(title, process.cwd());
}

test('ensureActiveStudioChapter lazily opens chapter #1 exactly once', async () => {
  const { coworkStore, sqliteStore, dir } = await openStore('idbots-chapters-');
  try {
    const session = seedSession(coworkStore);
    assert.equal(coworkStore.listStudioChapters(session.id).length, 0, 'no chapters before the first Studio turn');
    const first = coworkStore.ensureActiveStudioChapter(session.id, 7);
    assert.ok(first, 'chapter #1 opens');
    assert.equal(first.chapterIndex, 1);
    assert.equal(first.endedAt, null);
    assert.equal(first.metabotId, 7);
    const again = coworkStore.ensureActiveStudioChapter(session.id, 7);
    assert.equal(again.id, first.id, 'the active chapter is reused, never duplicated');
    assert.equal(coworkStore.listStudioChapters(session.id).length, 1);
    // Other sessions are untouched.
    const other = seedSession(coworkStore, 'Other');
    assert.equal(coworkStore.getActiveStudioChapter(other.id), null);
  } finally {
    disposeStore(sqliteStore, dir);
  }
});

test('closeStudioChapter writes the card and the next ensure opens chapter #2', async () => {
  const { coworkStore, sqliteStore, dir } = await openStore('idbots-chapters-');
  try {
    const session = seedSession(coworkStore);
    coworkStore.ensureActiveStudioChapter(session.id, null);
    const closed = coworkStore.closeStudioChapter(session.id, {
      closeReason: 'manual',
      title: 'NFT 钱包排查',
      summaryMarkdown: '决定用 MCP\n\n- 产物: pin://abc\n- 开放循环: 等主人确认',
      contentJson: JSON.stringify({ open_loops: ['等主人确认'] }),
      tokenWatermark: 321000,
      llmId: 'glm-5.3-flash',
    });
    assert.ok(closed, 'close returns the updated row');
    assert.equal(closed.endedAt != null, true);
    assert.equal(closed.closeReason, 'manual');
    assert.equal(closed.title, 'NFT 钱包排查');
    assert.equal(closed.tokenWatermark, 321000);
    // Closing again without a new active chapter is a no-op.
    assert.equal(coworkStore.closeStudioChapter(session.id, { closeReason: 'manual' }), null);
    // Next ensure opens chapter #2, chapter #1 stays closed.
    const second = coworkStore.ensureActiveStudioChapter(session.id, null);
    assert.equal(second.chapterIndex, 2);
    const all = coworkStore.listStudioChapters(session.id);
    assert.equal(all.length, 2);
    assert.deepEqual(all.map((chapter) => chapter.chapterIndex), [1, 2]);
    assert.equal(all[0].endedAt != null, true);
    assert.equal(all[1].endedAt, null);
  } finally {
    disposeStore(sqliteStore, dir);
  }
});

test('searchStudioChapters matches CLOSED chapter cards only, ranked by term count then recency', async () => {
  const { coworkStore, sqliteStore, dir } = await openStore('idbots-chapters-');
  try {
    const session = seedSession(coworkStore);
    const other = seedSession(coworkStore, 'Other session');
    // Chapter #1: matches both terms (older).
    coworkStore.ensureActiveStudioChapter(session.id, null);
    coworkStore.closeStudioChapter(session.id, {
      closeReason: 'task_boundary',
      title: '蓝色主题 falcon 上线',
      summaryMarkdown: '决定蓝色主题与 falcon 代号。',
    });
    // Chapter #2: matches one term (newer).
    coworkStore.ensureActiveStudioChapter(session.id, null);
    coworkStore.closeStudioChapter(session.id, {
      closeReason: 'budget',
      title: 'falcon 复盘',
      summaryMarkdown: 'falcon 上线后的小结。',
    });
    // Chapter #3: still open — must never surface.
    coworkStore.ensureActiveStudioChapter(session.id, null);
    // A closed chapter in ANOTHER session must never surface.
    coworkStore.ensureActiveStudioChapter(other.id, null);
    coworkStore.closeStudioChapter(other.id, { closeReason: 'manual', title: '蓝色 falcon 别处', summaryMarkdown: '别的会话' });

    const hits = coworkStore.searchStudioChapters(session.id, { terms: ['蓝色', 'falcon'], limit: 5 });
    assert.equal(hits.length, 2);
    assert.equal(hits[0].chapter.title, '蓝色主题 falcon 上线', 'two matched terms beat one');
    assert.equal(hits[1].chapter.title, 'falcon 复盘');
    assert.ok(hits.every((hit) => hit.chapter.sessionId === session.id), 'cross-session cards are excluded');
    assert.ok(hits.every((hit) => hit.chapter.endedAt != null), 'open chapters are excluded');
    assert.equal(coworkStore.searchStudioChapters(session.id, { terms: ['不存在词'] }).length, 0);
    assert.equal(coworkStore.searchStudioChapters(session.id, { terms: [] }).length, 0);
    assert.equal(coworkStore.searchStudioChapters(session.id, { terms: ['falcon'], limit: 1 }).length, 1, 'limit honoured');
  } finally {
    disposeStore(sqliteStore, dir);
  }
});

test('coworkRunner wires the chapter index into the studio volatile tail and recall', () => {
  // The volatile section is gated on Studio owner sessions and the dedup
  // layer (one injection per content generation, not per turn).
  assert.ok(
    runnerSource.includes("shouldInjectVolatile('session-chapters')"),
    'coworkRunner: the chapter index section must ride the dedup gate',
  );
  assert.ok(
    /sessionType === 'browser'[\s\S]{0,200}isAssistantModeOwnerChatSession\(sessionId\)/.test(runnerSource)
      || /isAssistantModeOwnerChatSession\(sessionId\)[\s\S]{0,200}sessionType === 'browser'/.test(runnerSource),
    'coworkRunner: the chapter index must be gated on Studio owner sessions',
  );
  assert.ok(
    runnerSource.includes('this.buildSessionChaptersPromptBlock(sessionId)'),
    'coworkRunner: the chapter index block builder must be wired',
  );
  assert.ok(
    runnerSource.includes('this.store.ensureActiveStudioChapter(sessionId'),
    'coworkRunner: chapter #1 opens lazily from the volatile build',
  );
  // conversation_recall searches chapter cards ahead of raw messages.
  assert.ok(
    runnerSource.includes('this.store.searchStudioChapters(sessionId, {'),
    'coworkRunner: conversation_recall must search chapter cards',
  );
  assert.ok(
    runnerSource.includes('[chapter #'),
    'coworkRunner: recall renders chapter-card blocks',
  );
});
