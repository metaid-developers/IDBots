import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');
const { MetabotStore } = require('../dist-electron/main/metabotStore.js');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-metabot-settings-test-'));
}

async function openStores(tempDir) {
  const store = await SqliteStore.create(tempDir);
  const metabotStore = new MetabotStore(store.getDatabase(), store.getSaveFunction());
  return { store, metabotStore, db: store.getDatabase() };
}

test('getMetabotSetting defaults to null and setMetabotSetting persists per metabot', async () => {
  const tempDir = makeTempDir();
  const { store, metabotStore, db } = await openStores(tempDir);
  try {
    db.run(
      `INSERT INTO metabot_wallets (id, mnemonic, path, created_at)
       VALUES (?, ?, ?, ?)`,
      [1, 'abandon ability able about above absent absorb abstract absurd abuse access accident 1', "m/44'/10001'/0'/0/0", Date.now()],
    );
    db.run(
      `INSERT INTO metabots (
        id, wallet_id, mvc_address, btc_address, doge_address, public_key, chat_public_key,
        name, enabled, metaid, metabot_type, created_by, role, soul,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        1, 1, 'mvc-1', 'btc-1', 'doge-1', 'public-1', 'chat-public-1',
        'test-bot', 1, 'metaid-1', 'worker', '0000', 'role', 'soul',
        Date.now(), Date.now(),
      ],
    );

    assert.equal(metabotStore.getMetabotSetting(1, 'chain.defaultWriteNetwork'), null);
    assert.equal(
      metabotStore.setMetabotSetting(1, 'chain.defaultWriteNetwork', 'opcat'),
      'opcat',
    );
    assert.equal(metabotStore.getMetabotSetting(1, 'chain.defaultWriteNetwork'), 'opcat');
    assert.equal(metabotStore.getMetabotSetting(1, 'chain.mvcSponsorUploadEnabled'), null);

    metabotStore.setMetabotSetting(1, 'chain.mvcSponsorUploadEnabled', 'false');
    assert.equal(metabotStore.getMetabotSetting(1, 'chain.mvcSponsorUploadEnabled'), 'false');

    assert.throws(() => metabotStore.getMetabotSetting(0, 'chain.defaultWriteNetwork'), /positive integer/);
    assert.throws(() => metabotStore.getMetabotSetting(1, ''), /key is required/);
  } finally {
    store.close();
  }
});

// --- Surf-before-dream twin-only default (owner decision 2026-10-26) ---------

const SURF_KEY = 'surf_before_dream_enabled';

async function insertBot(db, id, type) {
  db.run(
    `INSERT INTO metabot_wallets (id, mnemonic, path, created_at)
     VALUES (?, ?, ?, ?)`,
    [id, 'abandon ability able about above absent absorb abstract absurd abuse access accident ' + id, "m/44'/10001'/0'/0/" + id, Date.now()],
  );
  db.run(
    `INSERT INTO metabots (
      id, wallet_id, mvc_address, btc_address, doge_address, public_key, chat_public_key,
      name, enabled, metaid, metabot_type, created_by, role, soul,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, id, 'mvc-' + id, 'btc-' + id, 'doge-' + id, 'public-' + id, 'chat-' + id,
      'bot-' + id, 1, 'metaid-' + id, type, '0000', 'role', 'soul',
      Date.now(), Date.now(),
    ],
  );
}

test('surf legacy-pin migration pins pre-flip bots to 1; post-flip bots ride the twin-only default', async () => {
  const tempDir = makeTempDir();
  const store = await SqliteStore.create(tempDir);
  const db = store.getDatabase();
  try {
    // Two bots existed BEFORE the default flip (one Twin, one worker).
    await insertBot(db, 1, 'worker');
    await insertBot(db, 2, 'twin');

    // Constructing the store runs the one-time legacy-pin migration.
    const metabotStore = new MetabotStore(db, store.getSaveFunction());
    assert.equal(metabotStore.getMetabotSetting(1, SURF_KEY), '1', 'pre-flip worker pinned ON');
    assert.equal(metabotStore.getMetabotSetting(2, SURF_KEY), '1', 'pre-flip Twin pinned ON');
    // A user opt-out predating the flip is never overwritten.
    metabotStore.setMetabotSetting(1, SURF_KEY, '0');

    // Bots created AFTER the flip carry no row → the twin-only read default.
    await insertBot(db, 3, 'worker');
    assert.equal(metabotStore.getMetabotSetting(3, SURF_KEY), null, 'post-flip worker has no pinned row');

    const { isSurfBeforeDreamEnabled } = require('../dist-electron/main/services/surfSettings.js');
    assert.equal(isSurfBeforeDreamEnabled(metabotStore, 1), false, 'explicit 0 stays off');
    assert.equal(isSurfBeforeDreamEnabled(metabotStore, 2), true, 'pinned Twin stays on');
    assert.equal(isSurfBeforeDreamEnabled(metabotStore, 3), false, 'unset worker defaults OFF');
    assert.equal(metabotStore.isTwinMetabot(2), true);
    assert.equal(metabotStore.isTwinMetabot(1), false);
    assert.equal(metabotStore.isTwinMetabot(3), false);
    assert.equal(metabotStore.isTwinMetabot(999), false, 'unknown bot is not the Twin');

    // Idempotency: a second construction (app restart) must not pin the
    // post-flip bot — the marker row short-circuits the migration.
    await insertBot(db, 4, 'worker');
    const again = new MetabotStore(db, store.getSaveFunction());
    assert.equal(again.getMetabotSetting(3, SURF_KEY), null, 'restart does not pin post-flip bots');
    assert.equal(again.getMetabotSetting(4, SURF_KEY), null, 'restart does not pin post-flip bots');
  } finally {
    store.close();
  }
});

// --- Cowork automation opt-in default (owner decision 2026-11-12) -----------

const BROWSER_AUTOMATION_KEY = 'cowork.browserAutomation';
const COMPUTER_USE_KEY = 'cowork.computerUse';

test('cowork automation legacy-pin migration pins pre-flip bots to 1; post-flip bots default OFF', async () => {
  const tempDir = makeTempDir();
  const store = await SqliteStore.create(tempDir);
  const db = store.getDatabase();
  try {
    // Two bots existed BEFORE the default flip; one of them had explicitly
    // opted OUT of desktop computer use.
    await insertBot(db, 1, 'worker');
    await insertBot(db, 2, 'twin');
    db.run(`
      CREATE TABLE IF NOT EXISTS metabot_settings (
        metabot_id INTEGER NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (metabot_id, key)
      );
    `);
    db.run(
      'INSERT INTO metabot_settings (metabot_id, key, value, updated_at) VALUES (?, ?, ?, ?)',
      [2, COMPUTER_USE_KEY, '0', Date.now()],
    );

    // Constructing the store runs the one-time legacy-pin migration.
    const metabotStore = new MetabotStore(db, store.getSaveFunction());
    assert.equal(metabotStore.getMetabotSetting(1, BROWSER_AUTOMATION_KEY), '1', 'pre-flip bot pinned ON');
    assert.equal(metabotStore.getMetabotSetting(1, COMPUTER_USE_KEY), '1', 'pre-flip bot pinned ON');
    assert.equal(metabotStore.getMetabotSetting(2, BROWSER_AUTOMATION_KEY), '1', 'pre-flip Twin pinned ON');
    assert.equal(metabotStore.getMetabotSetting(2, COMPUTER_USE_KEY), '0', 'a pre-flip opt-out is never overwritten');

    // Bots created AFTER the flip carry no row → the new default-OFF read.
    await insertBot(db, 3, 'worker');
    assert.equal(metabotStore.getMetabotSetting(3, BROWSER_AUTOMATION_KEY), null, 'post-flip bot has no pinned row');
    assert.equal(metabotStore.getMetabotSetting(3, COMPUTER_USE_KEY), null, 'post-flip bot has no pinned row');

    const {
      isCoworkBrowserAutomationEnabled,
      isCoworkComputerUseEnabled,
    } = require('../dist-electron/main/services/coworkAutomationPreference.js');
    assert.equal(isCoworkBrowserAutomationEnabled(metabotStore, 1), true, 'pinned bot stays on');
    assert.equal(isCoworkComputerUseEnabled(metabotStore, 1), true, 'pinned bot stays on');
    assert.equal(isCoworkBrowserAutomationEnabled(metabotStore, 2), true, 'pinned Twin stays on');
    assert.equal(isCoworkComputerUseEnabled(metabotStore, 2), false, 'explicit 0 stays off');
    assert.equal(isCoworkBrowserAutomationEnabled(metabotStore, 3), false, 'unset bot defaults OFF');
    assert.equal(isCoworkComputerUseEnabled(metabotStore, 3), false, 'unset bot defaults OFF');

    // Idempotency: a second construction (app restart) must not pin the
    // post-flip bot — the marker row short-circuits the migration.
    await insertBot(db, 4, 'worker');
    const again = new MetabotStore(db, store.getSaveFunction());
    assert.equal(again.getMetabotSetting(3, BROWSER_AUTOMATION_KEY), null, 'restart does not pin post-flip bots');
    assert.equal(again.getMetabotSetting(4, COMPUTER_USE_KEY), null, 'restart does not pin post-flip bots');
  } finally {
    store.close();
  }
});
