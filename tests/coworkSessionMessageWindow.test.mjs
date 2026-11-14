import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createCoworkStore,
  createSqliteStore,
} from './memoryTestUtils.mjs';

/**
 * A session view is a bounded window: the newest messages plus the cursor that
 * pages older ones in. Before this, every non-A2A session view carried the whole
 * transcript (11,554 messages / 12.1MB for the largest session in a live
 * library), re-serialized over IPC on every open, stream completion and summary
 * refresh. The window must stay a faithful slice of the transcript: paging it
 * all the way down has to reproduce getSessionMessages' order exactly.
 */

const seedSession = (store, db, title, count, sessionType = 'standard') => {
  const session = sessionType === 'standard'
    ? store.createSession(title, '/tmp/window', '', 'local')
    : store.createSession(title, '/tmp/window', '', 'local', [], 1, sessionType, 'peer-gmid');
  const ids = [];
  for (let index = 1; index <= count; index += 1) {
    ids.push(store.addMessage(session.id, {
      type: index % 2 === 0 ? 'assistant' : 'user',
      content: `message-${index}`,
    }).id);
  }
  return { session, ids };
};

/** Walk the window downwards through the IPC-shaped pager and return the whole transcript. */
const drainWindow = (store, sessionId, pageSize) => {
  const window = store.getSessionView(sessionId, pageSize);
  const collected = window.messages.map((message) => message.id);
  let history = window.messageHistory;
  let guard = 0;
  while (history?.hasMoreBefore && guard < 200) {
    guard += 1;
    const page = store.getSessionMessagesPage(sessionId, {
      beforeSequence: history.beforeSequence,
      beforeTranscriptCursor: history.beforeTranscriptCursor ?? null,
      limit: history.pageSize,
    });
    assert.equal(page.messages.length > 0, true, 'a hasMoreBefore page must carry messages');
    collected.unshift(...page.messages.map((message) => message.id));
    history = {
      hasMoreBefore: page.hasMoreBefore,
      beforeSequence: page.beforeSequence,
      beforeTranscriptCursor: page.beforeTranscriptCursor ?? null,
      pageSize: history.pageSize,
    };
  }
  return { collected, window, guard };
};

test('a standard session opens on its newest messages and pages the rest in', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const store = createCoworkStore(db);
    const { session, ids } = seedSession(store, db, 'long standard', 250);

    const view = store.getSessionView(session.id);
    assert.equal(view.messages.length, 100);
    assert.equal(view.messageHistory.hasMoreBefore, true);
    assert.equal(view.messageHistory.pageSize, 100);
    assert.equal(view.messageHistory.beforeSequence, null);
    assert.equal(typeof view.messageHistory.beforeTranscriptCursor, 'string');
    // The window is the NEWEST slice, in transcript order.
    assert.deepEqual(view.messages.map((message) => message.id), ids.slice(-100));

    const { collected } = drainWindow(store, session.id, 100);
    assert.equal(collected.length, ids.length);
    assert.deepEqual(collected, ids);
    // ...and a full load still returns the same order.
    assert.deepEqual(store.getSession(session.id).messages.map((message) => message.id), ids);
  } finally {
    cleanup();
  }
});

test('a session shorter than the window is unaffected', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const store = createCoworkStore(db);
    const { session, ids } = seedSession(store, db, 'short standard', 3);

    const view = store.getSessionView(session.id);
    assert.deepEqual(view.messages.map((message) => message.id), ids);
    assert.equal(view.messageHistory.hasMoreBefore, false);
    assert.equal(view.messageHistory.beforeTranscriptCursor, null);
  } finally {
    cleanup();
  }
});

test('the window follows transcript order when it disagrees with insertion order', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const store = createCoworkStore(db);
    const { session, ids } = seedSession(store, db, 'migrated tail', 150);
    // A migrated copy appended old turns with fresh sequences: the transcript
    // (created_at) order and the insertion order genuinely diverge, so a window
    // that walked sequences would show a different tail.
    const transcriptOrder = ids.slice();
    const moved = transcriptOrder.splice(147, 3);
    transcriptOrder.unshift(...moved);
    for (const [position, id] of transcriptOrder.entries()) {
      db.run('UPDATE cowork_messages SET created_at = ? WHERE id = ?', [1_000_000 + position, id]);
    }
    const expectedTail = transcriptOrder.slice(-100);

    const view = store.getSessionView(session.id);
    assert.deepEqual(view.messages.map((message) => message.id), expectedTail);
    const { collected } = drainWindow(store, session.id, 100);
    assert.deepEqual(collected, transcriptOrder);
    assert.deepEqual(store.getSession(session.id).messages.map((message) => message.id), transcriptOrder);
  } finally {
    cleanup();
  }
});

test('browser sessions open on a bounded newest-messages window and page older messages in', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const store = createCoworkStore(db);
    const { session, ids } = seedSession(store, db, 'browser panel', 150, 'browser');

    const view = store.getSessionView(session.id);
    assert.equal(view.messages.length, 100);
    assert.equal(view.messageHistory.hasMoreBefore, true);
    assert.deepEqual(view.messages.map((message) => message.id), ids.slice(-100));

    const { collected } = drainWindow(store, session.id, 100);
    assert.deepEqual(collected, ids);
  } finally {
    cleanup();
  }
});

test('an A2A session keeps its display window and sequence cursor', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const store = createCoworkStore(db);
    const { session } = seedSession(store, db, 'peer bot', 250, 'a2a');

    const view = store.getSessionView(session.id, 20);
    assert.equal(view.messages.length, 20);
    assert.equal(view.messageHistory.hasMoreBefore, true);
    assert.equal(view.messageHistory.beforeSequence, 231);
    assert.equal(view.messageHistory.beforeTranscriptCursor, undefined);
    assert.equal(view.messageHistory.beforeEpisodeIndex, null);
  } finally {
    cleanup();
  }
});

test('a window cursor is opaque and rejected when malformed', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const store = createCoworkStore(db);
    const { session, ids } = seedSession(store, db, 'cursor guard', 12);

    const view = store.getSessionView(session.id, 5);
    assert.equal(view.messages.length, 5);
    const cursor = view.messageHistory.beforeTranscriptCursor;
    assert.equal(typeof cursor, 'string');

    // A malformed cursor must not throw or silently page from the top with a
    // different order: it falls back to the newest window.
    for (const bad of [null, '', 'nonsense', '1:2', '1:2:3:4', `${'9'.repeat(20)}:1:1`]) {
      const page = store.getSessionMessagesPage(session.id, {
        beforeTranscriptCursor: bad,
        limit: 5,
      });
      assert.deepEqual(page.messages.map((message) => message.id), ids.slice(-5));
    }

    const paged = store.getSessionMessagesPage(session.id, {
      beforeTranscriptCursor: cursor,
      limit: 5,
    });
    assert.deepEqual(paged.messages.map((message) => message.id), ids.slice(-10, -5));
    assert.equal(paged.hasMoreBefore, true);
  } finally {
    cleanup();
  }
});
