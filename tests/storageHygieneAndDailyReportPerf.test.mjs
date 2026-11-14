import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');
const { DreamStore } = require('../dist-electron/main/dreamStore.js');
const { ChainContentHistoryStore } = require('../dist-electron/main/chainContentHistoryStore.js');
const { pruneStaleDshSkillEnvFiles, ensureDshSkillEnvChannel, writeDshSkillSessionEnvFile } = require('../dist-electron/main/libs/dshSkillSessionEnv.js');

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

test('DreamStore gzip-compresses large prompt-layer snapshots and compacts legacy uncompressed rows without data loss', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-snap-hygiene-'));
  const sqliteStore = await SqliteStore.create(dir);
  try {
    const db = sqliteStore.getDatabase();
    const dreamStore = new DreamStore(db, sqliteStore.getSaveFunction());

    const payload = {
      version: 1,
      memories: Array.from({ length: 40 }, (_, i) => ({
        id: `mem-${i}`,
        text: `Repeated prompt snapshot memory entry #${i} with durable facts and context. `.repeat(6),
        fingerprint: `fp-${i}`,
        status: 'created',
        archivedAt: null,
        usageClass: 'general',
      })),
      promotedProcedureIds: ['proc-1', 'proc-2'],
    };

    const saved = dreamStore.savePromptLayerSnapshot({
      metabotId: 1,
      dreamDate: '2026-11-14',
      payload,
    });
    assert.equal(saved.payload.memories.length, 40);
    assert.deepEqual(saved.payload.promotedProcedureIds, ['proc-1', 'proc-2']);

    const storedRaw = String(
      db.exec("SELECT payload_json FROM metabot_prompt_layer_snapshots WHERE metabot_id = 1 AND dream_date = '2026-11-14'")[0]?.values?.[0]?.[0] ?? '',
    );
    assert.ok(storedRaw.startsWith('gz:'), 'large snapshot must be stored gzip-compressed');
    assert.ok(storedRaw.length < JSON.stringify(payload).length / 3, 'gzip compression shrinks repetitive snapshot by >3x');

    // Insert a legacy uncompressed row and compact it in-place.
    const legacyJson = JSON.stringify(payload);
    db.run(
      `INSERT INTO metabot_prompt_layer_snapshots (id, metabot_id, dream_date, created_at, payload_json, status)
       VALUES ('legacy-snap', 1, '2026-11-10', 1000, ?, 'superseded')`,
      [legacyJson],
    );
    const compacted = dreamStore.compactPromptLayerSnapshots(50);
    assert.equal(compacted, 1);
    assert.equal(dreamStore.getPromptLayerSnapshot(1, '2026-11-10')?.payload.memories.length, 40);
  } finally {
    disposeStore(sqliteStore, dir);
  }
});

test('ChainContentHistoryStore.pruneOldChainReads drops stale non-KB reads while preserving KB-saved entries', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-chain-reads-'));
  const sqliteStore = await SqliteStore.create(dir);
  try {
    const db = sqliteStore.getDatabase();
    const chainStore = new ChainContentHistoryStore(db, sqliteStore.getSaveFunction());

    chainStore.recordRead({
      metabotId: 1,
      pinId: 'a'.repeat(64) + 'i0',
      contentText: 'old ephemeral read',
      readAtMs: 1_000,
    });
    chainStore.recordRead({
      metabotId: 1,
      pinId: 'b'.repeat(64) + 'i0',
      contentText: 'old KB-saved read',
      readAtMs: 1_000,
    });
    chainStore.markReadSavedToKb(1, 'b'.repeat(64) + 'i0', 'kb-1');

    const deleted = chainStore.pruneOldChainReads({ cutoffMs: 5_000 });
    assert.equal(deleted, 1);
    assert.equal(chainStore.getReadByPinId(1, 'a'.repeat(64) + 'i0'), null);
    assert.ok(chainStore.getReadByPinId(1, 'b'.repeat(64) + 'i0'));
  } finally {
    disposeStore(sqliteStore, dir);
  }
});

test('pruneStaleDshSkillEnvFiles removes expired .env sidecars while keeping loader.sh and fresh sessions', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-skill-env-gc-'));
  try {
    ensureDshSkillEnvChannel(dir);
    const staleFile = writeDshSkillSessionEnvFile(dir, 'stale-session-1', { DEMO_KEY: '1' });
    const freshFile = writeDshSkillSessionEnvFile(dir, 'fresh-session-2', { DEMO_KEY: '2' });
    assert.ok(staleFile && freshFile);

    const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000);
    fs.utimesSync(staleFile, tenDaysAgo, tenDaysAgo);

    const removed = pruneStaleDshSkillEnvFiles(dir);
    assert.equal(removed, 1);
    assert.equal(fs.existsSync(staleFile), false);
    assert.equal(fs.existsSync(freshFile), true);
    assert.equal(fs.existsSync(path.join(dir, 'dsh-skill-env', 'loader.sh')), true);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});
