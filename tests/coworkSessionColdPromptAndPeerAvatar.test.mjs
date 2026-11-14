import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');
const { CoworkStore } = require('../dist-electron/main/coworkStore.js');

function disposeStore(sqliteStore, dir) {
  try {
    sqliteStore.close();
  } catch {
    // already closed
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows handle tolerance
  }
}

test('CoworkStore stores system_prompt out-of-line in cowork_session_prompts and migrates legacy inline rows without data loss', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-cold-prompt-'));
  const sqliteStore = await SqliteStore.create(dir);
  try {
    const db = sqliteStore.getDatabase();
    const coworkStore = new CoworkStore(db, sqliteStore.getSaveFunction(), { deferHeavyStartupMaintenance: true });

    const bigPrompt = 'You are an expert assistant.\n' + 'rule line\n'.repeat(2000);
    const created = coworkStore.createSession('Out-of-line Prompt', '/tmp', bigPrompt, 'local', [], null);

    const inlineCol = db.exec('SELECT system_prompt FROM cowork_sessions WHERE id = ?', [created.id])[0]?.values?.[0]?.[0];
    assert.equal(inlineCol, '', 'new sessions must keep cowork_sessions.system_prompt empty to avoid overflow pages');
    assert.equal(coworkStore.getSessionWithoutMessages(created.id)?.systemPrompt, bigPrompt);

    coworkStore.updateSession(created.id, { systemPrompt: 'Updated compact prompt' });
    assert.equal(coworkStore.getSessionWithoutMessages(created.id)?.systemPrompt, 'Updated compact prompt');

    // Simulate a pre-upgrade row that still carries its prompt inline on cowork_sessions.
    const legacy = coworkStore.createSession('Legacy Inline Prompt', '/tmp', '', 'local', [], null);
    db.run('DELETE FROM cowork_session_prompts WHERE session_id = ?', [legacy.id]);
    db.run('UPDATE cowork_sessions SET system_prompt = ? WHERE id = ?', ['Legacy inline text', legacy.id]);
    assert.equal(
      coworkStore.getSessionWithoutMessages(legacy.id)?.systemPrompt,
      'Legacy inline text',
      'dual-read must return legacy inline prompt even before deferred maintenance runs',
    );

    const maintenance = coworkStore.runHeavyStartupMaintenance();
    assert.equal(maintenance.migratedInlineSessionPrompts, 1);
    const legacyInlineAfter = db.exec('SELECT system_prompt FROM cowork_sessions WHERE id = ?', [legacy.id])[0]?.values?.[0]?.[0];
    assert.equal(legacyInlineAfter, '');
    assert.equal(coworkStore.getSessionWithoutMessages(legacy.id)?.systemPrompt, 'Legacy inline text');
  } finally {
    disposeStore(sqliteStore, dir);
  }
});

test('listSessions omits inline data: peerAvatar when requested and listSessionPeerAvatars resolves them in batch', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-peer-avatar-'));
  const sqliteStore = await SqliteStore.create(dir);
  try {
    const db = sqliteStore.getDatabase();
    const coworkStore = new CoworkStore(db, sqliteStore.getSaveFunction());

    const dataUri = 'data:image/png;base64,' + 'A'.repeat(4096);
    const httpUri = 'https://example.com/peer.png';
    const sData = coworkStore.createSession('Peer Data Avatar', '/tmp', '', 'local', [], null, 'a2a', 'idq1peer1', 'Peer 1', dataUri);
    const sHttp = coworkStore.createSession('Peer URL Avatar', '/tmp', '', 'local', [], null, 'a2a', 'idq1peer2', 'Peer 2', httpUri);

    const defaultList = coworkStore.listSessions();
    assert.equal(defaultList.find((s) => s.id === sData.id)?.peerAvatar, dataUri);

    const slimList = coworkStore.listSessions({ omitInlinePeerDataAvatar: true });
    const slimData = slimList.find((s) => s.id === sData.id);
    const slimHttp = slimList.find((s) => s.id === sHttp.id);
    assert.ok(slimData);
    assert.equal(slimData.peerAvatar, null);
    assert.equal(typeof slimData.peerAvatarVersion, 'number');
    assert.equal(slimHttp?.peerAvatar, httpUri);
    assert.equal(slimHttp?.peerAvatarVersion, undefined);

    const resolved = coworkStore.listSessionPeerAvatars([sData.id]);
    assert.deepEqual(resolved, [{ sessionId: sData.id, peerAvatar: dataUri }]);
  } finally {
    disposeStore(sqliteStore, dir);
  }
});
