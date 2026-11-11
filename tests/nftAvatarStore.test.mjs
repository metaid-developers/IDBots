import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ITEM_PIN = `${'ef'.repeat(32)}i0`;
const REFERENCE = `nft://mrc721/${ITEM_PIN}?owner=1BoatSLRHtKNngkdXEeobR76b53LETtpyT&metaid=idq1storeexample`;
const IMAGE = 'data:image/png;base64,AAAA';

function context() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-nft-avatar-store-'));
  return { tempDir };
}

function dispose(store, tempDir) {
  try { store.close(); } catch { /* best-effort cleanup */ }
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* OS sweeps leftovers */ }
}

function botInput(walletId, overrides = {}) {
  return {
    wallet_id: walletId,
    mvc_address: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT',
    btc_address: 'btc-bot',
    doge_address: 'doge-bot',
    public_key: 'public-key',
    chat_public_key: 'chat-key',
    name: 'NFT Bot',
    metaid: 'metaid-bot',
    globalmetaid: 'idq1storeexample',
    metabot_type: 'worker',
    created_by: 'test',
    role: '',
    soul: '',
    ...overrides,
  };
}

test('MetabotStore preserves identity-bound NFT references and cover fallback in avatar_blob mode', async () => {
  const { tempDir } = context();
  const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');
  const { MetabotStore } = require('../dist-electron/main/metabotStore.js');
  const store = await SqliteStore.create(tempDir);
  try {
    store.getDatabase().run('ALTER TABLE metabots ADD COLUMN avatar_blob BLOB');
    const metabots = new MetabotStore(store.getDatabase(), () => store.save());
    const wallet = metabots.insertMetabotWallet({ mnemonic: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about' });
    const created = metabots.createMetabot(botInput(wallet.id, {
      avatar: REFERENCE,
      avatar_fallback: IMAGE,
      nft_avatar_pin_id: 'declaration-pin',
      nft_avatar_synced_reference: REFERENCE,
    }));
    assert.equal(created.avatar, REFERENCE);
    const loaded = metabots.getMetabotById(created.id);
    assert.equal(loaded.avatar, REFERENCE);
    assert.equal(loaded.avatar_fallback, IMAGE);
    assert.equal(loaded.nft_avatar_pin_id, 'declaration-pin');
    assert.equal(loaded.nft_avatar_synced_reference, REFERENCE);

    const nextReference = REFERENCE.replace('i0?', 'i1?');
    const updated = metabots.updateMetabot(created.id, {
      avatar: nextReference,
      avatar_fallback: 'data:image/png;base64,BBBB',
    });
    assert.equal(updated.avatar, nextReference);
    assert.equal(updated.avatar_fallback, 'data:image/png;base64,BBBB');
    assert.equal(updated.nft_avatar_synced_reference, REFERENCE, 'old declaration state survives until the new pin lands');

    const plain = metabots.updateMetabot(created.id, { avatar: IMAGE, avatar_fallback: null });
    assert.equal(plain.avatar, IMAGE);
    assert.equal(plain.avatar_fallback, undefined);
    assert.equal(plain.nft_avatar_synced_reference, REFERENCE, 'plain avatar still needs the declaration clear pin');
  } finally {
    dispose(store, tempDir);
  }
});
