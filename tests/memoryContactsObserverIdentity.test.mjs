import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);

const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');
const { MetabotStore } = require('../dist-electron/main/metabotStore.js');

/**
 * Observer identity for the Memory settings contacts tab: the panel resolves
 * its per-bot contact list against `selectedMetabot.globalmetaid`, which rides
 * the `idbots:getMetaBots` payload. 2026-10-26 (a8cf1c44) the renderer started
 * hardcoding `globalmetaid: null` because the slimmed selector payload dropped
 * the field — the contacts tab then silently rendered empty for every bot
 * while the underlying dream-impression pipeline kept writing fine. These
 * anchors pin the field at both ends of the chain.
 */

const makeTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-contacts-observer-'));

const insertWallet = (db, id) => {
  db.run(
    `INSERT INTO metabot_wallets (id, mnemonic, path, created_at)
     VALUES (?, ?, ?, ?)`,
    [id, `abandon ability able about above absent absorb abstract absurd abuse access accident ${id}`, "m/44'/10001'/0'/0/0", 1700000000000 + id]
  );
};

const insertMetabot = (db, { id, name, globalmetaid = null, type = 'worker', createdAt }) => {
  db.run(
    `INSERT INTO metabots (
      id, wallet_id, mvc_address, btc_address, doge_address, public_key, chat_public_key,
      name, enabled, metaid, globalmetaid, metabot_type, created_by, role, soul,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      id,
      `mvc-${id}`,
      `btc-${id}`,
      `doge-${id}`,
      `public-${id}`,
      `chat-public-${id}`,
      name,
      1,
      `metaid-${id}`,
      globalmetaid,
      type,
      '0000',
      `${name} role`,
      `${name} soul`,
      createdAt,
      createdAt,
    ]
  );
};

// House dispose pattern: close the store first, then remove the temp dir
// best-effort (a lingering sql.js handle must never fail the test).
test('getAllMetaBots carries globalmetaid so the contacts tab can resolve its observer', async () => {
  const tempDir = makeTempDir();
  const store = await SqliteStore.create(tempDir);
  try {
    const metabotStore = new MetabotStore(store.getDatabase(), store.getSaveFunction());
    insertWallet(store.getDatabase(), 1);
    insertWallet(store.getDatabase(), 2);
    insertMetabot(store.getDatabase(), {
      id: 1,
      name: 'Twin',
      globalmetaid: 'idq_twin_observer',
      type: 'twin',
      createdAt: 1000,
    });
    insertMetabot(store.getDatabase(), {
      id: 2,
      name: 'No Identity Bot',
      globalmetaid: null,
      createdAt: 2000,
    });

    const list = metabotStore.getAllMetaBots();
    assert.equal(list.length, 2);
    const twin = list.find((item) => item.id === 1);
    const anonymous = list.find((item) => item.id === 2);
    assert.equal(twin.globalmetaid, 'idq_twin_observer', 'identity bot keeps its globalmetaid');
    assert.equal(anonymous.globalmetaid, null, 'unbound bot stays null, never a fabricated id');
  } finally {
    store.close();
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* OS-swept */ }
  }
});

test('the renderer maps globalmetaid through instead of hardcoding null', () => {
  const settings = readFileSync(new URL('../src/renderer/components/settings/MemorySettings.tsx', import.meta.url), 'utf8');
  // The loadMetabots mapping must pass the field through…
  assert.match(
    settings,
    /globalmetaid: item\.globalmetaid \?\? null/,
    'loadMetabots maps item.globalmetaid through',
  );
  // …and the loadMetabots block must not hardcode the field to null again.
  const mapping = settings.match(/result\.list\.map\(\(item\) => \(\{[\s\S]*?\}\)\)/);
  assert.notEqual(mapping, null, 'loadMetabots mapping block found');
  assert.doesNotMatch(mapping[0], /globalmetaid: null/, 'no hardcoded null globalmetaid in the mapping');
});

test('the getMetaBots renderer type declares globalmetaid', () => {
  const electronTypes = readFileSync(new URL('../src/renderer/types/electron.d.ts', import.meta.url), 'utf8');
  const getMetaBotsLine = electronTypes.match(/getMetaBots: \(\) => Promise<\{[^\n]*\}>;/);
  assert.notEqual(getMetaBotsLine, null, 'getMetaBots typing found');
  assert.match(getMetaBotsLine[0], /globalmetaid: string \| null/, 'payload type includes globalmetaid');
});
