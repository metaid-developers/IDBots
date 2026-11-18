/**
 * Bounded store reads backing the Live Stage companion rail:
 *  - CoworkStore.listRecentPeerSessions (a2a peers, recency window, LIMIT)
 *  - CoworkStore.getLatestPeerSessionIdentity (LIMIT 1 peer snapshot)
 *  - GroupTaskStore.listOpenTasksForMetabot (chair-or-member, open statuses)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';

const require = Module.createRequire(import.meta.url);
const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');
const { CoworkStore } = require('../dist-electron/main/coworkStore.js');
const { GroupTaskStore } = require('../dist-electron/main/groupTaskStore.js');

const makeTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-stage-store-queries-'));

async function harness(t) {
  const tempDir = makeTempDir();
  const store = await SqliteStore.create(tempDir);
  const db = store.getDatabase();
  const coworkStore = new CoworkStore(db, () => {});
  const groupTaskStore = new GroupTaskStore(db, store.getSaveFunction());
  // Windows CI: release the sql.js handle before the tolerant temp rm.
  t.after(() => {
    try { store.close(); } catch {}
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  });
  return { store, db, coworkStore, groupTaskStore };
}

const a2aSession = (store, metabotId, peerId, overrides = {}) => store.createSession(
  'peer chat', '/tmp', '', 'local', [], metabotId, 'a2a',
  peerId, overrides.peerName ?? null, overrides.peerAvatar ?? null,
);

const stampActivity = (db, sessionId, activityAt) => {
  db.run('UPDATE cowork_sessions SET activity_at = ?, updated_at = ? WHERE id = ?', [activityAt, activityAt, sessionId]);
};

test('listRecentPeerSessions returns only recent a2a peers of the metabot, newest first, LIMIT-bound', async (t) => {
  const { db, coworkStore } = await harness(t);
  const now = Date.now();
  const fresh = a2aSession(coworkStore, 1, 'gmid-peer-a', { peerName: 'Nova' });
  stampActivity(db, fresh.id, now - 1_000);
  const older = a2aSession(coworkStore, 1, 'gmid-peer-b', { peerName: 'Kite' });
  stampActivity(db, older.id, now - 5_000);
  // Excluded rows: stale activity, another bot's session, a standard
  // session, an archived a2a session, and a peer-less a2a row.
  const stale = a2aSession(coworkStore, 1, 'gmid-peer-stale');
  stampActivity(db, stale.id, now - 20 * 60_000);
  const otherBot = a2aSession(coworkStore, 2, 'gmid-peer-c');
  stampActivity(db, otherBot.id, now - 500);
  const standard = coworkStore.createSession('plain', '/tmp', '', 'local', [], 1, 'standard');
  stampActivity(db, standard.id, now - 500);
  const archived = a2aSession(coworkStore, 1, 'gmid-peer-archived');
  stampActivity(db, archived.id, now - 500);
  db.run('UPDATE cowork_sessions SET archived_at = ? WHERE id = ?', [now, archived.id]);
  const noPeer = coworkStore.createSession('empty peer', '/tmp', '', 'local', [], 1, 'a2a', null, null, null);
  stampActivity(db, noPeer.id, now - 500);

  const rows = coworkStore.listRecentPeerSessions({ metabotId: 1, sinceMs: now - 10 * 60_000, limit: 4 });
  assert.deepEqual(rows.map((row) => row.peerGlobalMetaId), ['gmid-peer-a', 'gmid-peer-b']);
  assert.equal(rows[0].peerName, 'Nova');
  assert.equal(rows[0].activityAt, now - 1_000);
  // The limit binds: asking for 1 keeps only the freshest peer.
  const limited = coworkStore.listRecentPeerSessions({ metabotId: 1, sinceMs: now - 10 * 60_000, limit: 1 });
  assert.deepEqual(limited.map((row) => row.peerGlobalMetaId), ['gmid-peer-a']);
});

test('getLatestPeerSessionIdentity returns the freshest snapshot or null', async (t) => {
  const { db, coworkStore } = await harness(t);
  const now = Date.now();
  const oldThread = a2aSession(coworkStore, 1, 'gmid-peer-a', { peerName: 'Nova', peerAvatar: 'data:image/png;base64,AA==' });
  stampActivity(db, oldThread.id, now - 60_000);
  const newThread = a2aSession(coworkStore, 1, 'gmid-peer-a', { peerName: 'Nova v2', peerAvatar: 'nft://mrc721/abc' });
  stampActivity(db, newThread.id, now - 1_000);
  const identity = coworkStore.getLatestPeerSessionIdentity('gmid-peer-a');
  assert.equal(identity.peerName, 'Nova v2');
  assert.equal(identity.peerAvatar, 'nft://mrc721/abc');
  assert.equal(coworkStore.getLatestPeerSessionIdentity('gmid-missing'), null);
  assert.equal(coworkStore.getLatestPeerSessionIdentity(''), null);
});

test('listOpenTasksForMetabot keeps open chair/member tasks and drops the rest', async (t) => {
  const { db, groupTaskStore } = await harness(t);
  const chaired = groupTaskStore.createTask({
    groupId: 'group-chaired', title: 'Chaired task', goal: 'g',
    chairMetabotId: 7, createdBy: 'user',
  });
  const membered = groupTaskStore.createTask({
    groupId: 'group-membered', title: 'Member task', goal: 'g',
    chairMetabotId: 9, createdBy: 'user',
  });
  groupTaskStore.addMember({ taskId: membered.id, metabotId: 7, role: 'worker', displayName: 'Seven' });
  // Excluded: done status, archived, no group id, unrelated task,
  // removed-member task.
  const done = groupTaskStore.createTask({
    groupId: 'group-done', title: 'Done task', goal: 'g',
    chairMetabotId: 7, createdBy: 'user',
  });
  db.run("UPDATE group_tasks SET status = 'done' WHERE id = ?", [done.id]);
  const archived = groupTaskStore.createTask({
    groupId: 'group-archived', title: 'Archived task', goal: 'g',
    chairMetabotId: 7, createdBy: 'user',
  });
  groupTaskStore.archiveTask(archived.id);
  groupTaskStore.createTask({
    groupId: null, title: 'No group', goal: 'g',
    chairMetabotId: 7, createdBy: 'user',
  });
  groupTaskStore.createTask({
    groupId: 'group-other', title: 'Other task', goal: 'g',
    chairMetabotId: 9, createdBy: 'user',
  });
  const removed = groupTaskStore.createTask({
    groupId: 'group-removed', title: 'Removed task', goal: 'g',
    chairMetabotId: 9, createdBy: 'user',
  });
  groupTaskStore.addMember({ taskId: removed.id, metabotId: 7, role: 'worker', displayName: 'Seven' });
  groupTaskStore.markMemberRemoved({ taskId: removed.id, metabotId: 7 });

  const rows = groupTaskStore.listOpenTasksForMetabot(7);
  assert.deepEqual(rows.map((task) => task.groupId).sort(), ['group-chaired', 'group-membered']);
  assert.equal(rows.find((task) => task.id === chaired.id)?.status, 'planning');
  assert.deepEqual(groupTaskStore.listOpenTasksForMetabot(0), []);
});
