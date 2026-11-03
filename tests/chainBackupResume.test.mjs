import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');
const { MetabotStore } = require('../dist-electron/main/metabotStore.js');
const { MetaIDKnowledgeStore } = require('../dist-electron/main/metaidKnowledgeStore.js');
const { DreamStore } = require('../dist-electron/main/dreamStore.js');
const { CoworkStore } = require('../dist-electron/main/coworkStore.js');
const { LongTermTaskStore } = require('../dist-electron/main/longTermTaskStore.js');
const { UserIdentityStore } = require('../dist-electron/main/userIdentityStore.js');
const { ensureMetaIDImpressionSchema } = require('../dist-electron/main/metaidImpressionStore.js');
const { ensureTeamCultureSchema } = require('../dist-electron/main/teamCultureStore.js');
const { ensureSkillAssignmentSchema } = require('../dist-electron/main/libs/skillAssignmentStore.js');
const { createMetaBotWallet } = require('../dist-electron/main/services/metabotWalletService.js');
const { decryptBytes, deriveBackupKey } = require('../dist-electron/main/services/chainBackupCrypto.js');
const { extractBackupObjects, readChainBackupState } = require('../dist-electron/main/services/chainBackupData.js');
const {
  CHAIN_BACKUP_MANIFEST_PATH,
  CHAIN_BACKUP_OBJECT_PATH,
  CHAIN_BACKUP_SEGMENT_PLAINTEXT_LIMIT,
  runChainBackup,
} = require('../dist-electron/main/services/chainBackupService.js');
const { runChainBackupRestore } = require('../dist-electron/main/services/chainBackupRestoreService.js');
const { listChainBackupRuns, listChainBackupSegmentUploads } = require('../dist-electron/main/services/chainBackupRunStore.js');
const { isChainBackupNetworkError } = require('../dist-electron/main/services/chainBackupPublication.js');

const USER_MNEMONIC = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const USER_GID = 'idqtestuserglobalmetaid0000000000000001';

async function openStore(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const sqliteStore = await SqliteStore.create(dir);
  const db = sqliteStore.getDatabase();
  const save = sqliteStore.getSaveFunction();
  new MetaIDKnowledgeStore(db, save);
  const dreamStore = new DreamStore(db, save);
  new CoworkStore(db, save, { deferHeavyStartupMaintenance: true });
  new LongTermTaskStore(db, save);
  ensureMetaIDImpressionSchema(db);
  ensureTeamCultureSchema(db);
  ensureSkillAssignmentSchema(db);
  const metabotStore = new MetabotStore(db, save);
  return { sqliteStore, db, metabotStore, dreamStore, dir };
}

async function createBot(store, name = 'resume-bot') {
  const derived = await createMetaBotWallet({});
  const wallet = store.insertMetabotWallet({ mnemonic: derived.mnemonic, path: derived.path });
  const bot = store.createMetabot({
    wallet_id: wallet.id,
    mvc_address: derived.mvc_address,
    btc_address: derived.btc_address,
    doge_address: derived.doge_address,
    public_key: derived.public_key,
    chat_public_key: derived.chat_public_key,
    name,
    enabled: true,
    metaid: derived.metaid,
    globalmetaid: derived.globalmetaid,
    metabot_type: 'worker',
    created_by: '0000',
    role: 'tester',
    soul: 'resume test soul',
  });
  return { bot, derived };
}

function insertUserIdentity(db, save) {
  const store = new UserIdentityStore(db, save);
  store.insert({
    mnemonic: USER_MNEMONIC,
    mvc_address: 'mvc-user',
    btc_address: 'btc-user',
    doge_address: 'doge-user',
    public_key: 'pub-user',
    chat_public_key: 'chat-user',
    metaid: 'metaid-user',
    globalmetaid: USER_GID,
    name: 'tester',
  });
  return store;
}

function seedMemories(source, bot, count, bytesPerMemory) {
  const now = Date.now();
  for (let index = 0; index < count; index += 1) {
    const marker = `memory-${index}-`;
    const text = marker + 'x'.repeat(Math.max(0, bytesPerMemory - marker.length));
    source.db.run(
      `INSERT INTO user_memories
        (id, metabot_id, text, fingerprint, confidence, is_explicit, status, scope_kind, scope_key,
         usage_class, visibility, origin, importance, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0.9, 1, 'created', 'owner', 'owner:self', 'profile_fact', 'local_only', 'conversation', 0.9, ?, ?)`,
      [`memory-${index}`, bot.id, text, `fingerprint-${index}`, now + index, now + index],
    );
  }
}

function createHarness() {
  const pins = {};
  const scopedListings = {};
  const calls = [];
  const delays = [];
  let sequence = 0;
  let failure = null;

  const createPinImpl = async (metabotStore, metabotId, metaidData) => {
    const bot = metabotStore.getMetabotById(metabotId);
    const owner = bot.globalmetaid;
    sequence += 1;
    const pinId = `pin-resume-${sequence}`;
    const payload = String(metaidData.payload);
    let segmentKey = null;
    try { segmentKey = JSON.parse(payload).segmentKey ?? null; } catch { /* non-JSON payload */ }
    const call = {
      pinId,
      owner,
      operation: metaidData.operation,
      path: metaidData.path,
      segmentKey,
      accepted: false,
    };
    calls.push(call);
    const shouldFail = failure && failure.predicate(call);
    if (shouldFail && !failure.accept) {
      const error = failure.error;
      failure = null;
      throw error;
    }

    pins[pinId] = payload;
    call.accepted = true;
    if (metaidData.operation === 'modify') {
      const target = metaidData.path.slice(1);
      const candidates = scopedListings[`${owner}|${CHAIN_BACKUP_MANIFEST_PATH}`] ?? [];
      const current = candidates.find((item) => item.modify_history.includes(target));
      if (!current) throw new Error(`modify target not found: ${target}`);
      current.modify_history.push(pinId);
    } else {
      const key = `${owner}|${metaidData.path}`;
      scopedListings[key] = scopedListings[key] ?? [];
      scopedListings[key].unshift({ id: pinId, modify_history: [pinId] });
    }
    if (shouldFail) {
      const error = failure.error;
      failure = null;
      throw error;
    }
    return { pinId, txids: [`tx-resume-${sequence}`], totalCost: 0 };
  };

  const findPublishedSegmentPinImpl = async ({ segmentKey, segmentHash }) => {
    for (const [pinId, payload] of Object.entries(pins)) {
      try {
        const envelope = JSON.parse(payload);
        if (envelope.segmentKey === segmentKey || envelope.segment === segmentHash) return { pinId };
      } catch { /* non-object pin */ }
    }
    return null;
  };
  const fetchManifestStateImpl = async ({ botGlobalMetaId }) => {
    const candidates = scopedListings[`${botGlobalMetaId}|${CHAIN_BACKUP_MANIFEST_PATH}`] ?? [];
    if (!candidates.length) return null;
    const history = candidates[0].modify_history;
    const pinId = history[history.length - 1];
    return { pinId, content: pins[pinId] };
  };

  const runBackup = async (metabotStore, userStore, sqliteStore, options = {}) => runChainBackup({
    db: sqliteStore.getDatabase(),
    metabotStore,
    userStore,
    saveDb: sqliteStore.getSaveFunction(),
    createPinImpl,
    maxNetworkAttempts: options.maxNetworkAttempts ?? 2,
    sleep: async (ms) => { delays.push(ms); },
    findPublishedSegmentPinImpl: options.findPublishedSegmentPinImpl ?? findPublishedSegmentPinImpl,
    fetchManifestStateImpl: options.fetchManifestStateImpl ?? fetchManifestStateImpl,
    syncBotsManifestImpl: async (_users, store) => {
      const bots = store.listMetabots()
        .filter((bot) => bot.metabot_type !== 'welcome' && bot.globalmetaid)
        .map((bot) => ({
          globalMetaId: bot.globalmetaid,
          name: bot.name,
          type: bot.metabot_type,
          enabled: bot.enabled,
          mvcAddress: bot.mvc_address,
        }));
      pins['pin-bots'] = JSON.stringify({ version: 1, bots });
      scopedListings[`${USER_GID}|/info/bots`] = [{ id: 'pin-bots', modify_history: ['pin-bots'] }];
      return { success: true, botCount: bots.length, boundCount: bots.length, newlyBound: 0, skippedUnbound: [], txids: [] };
    },
  });

  return {
    pins,
    scopedListings,
    calls,
    delays,
    runBackup,
    findPublishedSegmentPinImpl,
    fetchManifestStateImpl,
    failNext(predicate, error, accept) {
      failure = { predicate, error, accept };
    },
  };
}

function stubRestoreIndexer(harness) {
  const originalFetch = globalThis.fetch;
  const ownerByAddress = { 'mvc-user': USER_GID };
  const bots = JSON.parse(harness.pins['pin-bots']).bots;
  for (const bot of bots) ownerByAddress[bot.mvcAddress] = bot.globalMetaId;
  globalThis.fetch = async (url) => {
    const href = String(url);
    const respond = (status, body, contentType = 'application/json') => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => typeof body === 'string' ? body : JSON.stringify(body),
      headers: { get: () => contentType },
    });
    const addressScoped = href.match(/\/api\/address\/pin\/list\/([^/?]+)\?/);
    if (addressScoped) {
      const address = decodeURIComponent(addressScoped[1]);
      const owner = ownerByAddress[address];
      const path = new URL(href).searchParams.get('path');
      const list = (harness.scopedListings[`${owner}|${path}`] ?? []).map((item) => ({
        id: item.id,
        timestamp: Math.floor(Date.now() / 1000),
        address,
        globalMetaId: owner,
        modify_history: item.modify_history,
      }));
      return respond(200, { code: 1, data: { list, nextCursor: null } });
    }
    const content = href.match(/\/content\/([^/?]+)/);
    if (content) {
      const pinId = decodeURIComponent(content[1]);
      const body = harness.pins[pinId];
      if (body == null) return respond(404, { code: 0, message: 'not found' });
      return respond(200, body, 'text/plain');
    }
    throw new Error(`unexpected restore fetch: ${href}`);
  };
  return () => { globalThis.fetch = originalFetch; };
}

test('network classification retries abort and server errors, not permanent input or funding errors', () => {
  assert.equal(isChainBackupNetworkError(new Error('This operation was aborted')), true);
  assert.equal(isChainBackupNetworkError(new Error('indexer error 503: unavailable')), true);
  assert.equal(isChainBackupNetworkError(new Error('HTTP 408')), true);
  assert.equal(isChainBackupNetworkError(new Error('insufficient funds')), false);
  assert.equal(isChainBackupNetworkError(new Error('MNEMONIC_INVALID')), false);
});

for (const fraction of [0.1, 0.5, 0.9]) {
  test(`resume at ${Math.round(fraction * 100)}% skips completed segments after a database restart`, async () => {
    const source = await openStore('idbots-resume-fraction-');
    const { bot } = await createBot(source.metabotStore);
    const userStore = insertUserIdentity(source.db, source.sqliteStore.getSaveFunction());
    seedMemories(source, bot, 10, 150 * 1024);
    const harness = createHarness();
    let objectCall = 0;
    harness.failNext(
      () => {
        objectCall += 1;
        return objectCall === Math.max(1, Math.floor(10 * fraction));
      },
      new TypeError('fetch failed'),
      false,
    );

    const first = await harness.runBackup(source.metabotStore, userStore, source.sqliteStore, { maxNetworkAttempts: 1 });
    assert.equal(first.success, false);
    assert.equal(first.resumable, true);
    const acceptedBeforePause = harness.calls.filter((call) => call.accepted && call.path === CHAIN_BACKUP_OBJECT_PATH).length;
    if (fraction === 0.1) {
      assert.equal(acceptedBeforePause, 0, 'the 10% fault is injected before the first segment is accepted');
    } else {
      assert.ok(acceptedBeforePause > 0 && acceptedBeforePause < 10);
    }

    const reopened = await SqliteStore.create(source.dir);
    const reopenedStore = new MetabotStore(reopened.getDatabase(), reopened.getSaveFunction());
    const reopenedUser = new UserIdentityStore(reopened.getDatabase(), reopened.getSaveFunction());
    const second = await harness.runBackup(reopenedStore, reopenedUser, reopened, { maxNetworkAttempts: 1 });
    assert.equal(second.success, true, JSON.stringify(second));
    if (fraction === 0.1) {
      assert.equal(second.bots[0].resumedSegments, 0);
    } else {
      assert.ok(second.bots[0].resumedSegments > 0);
    }

    const acceptedBySegment = new Map();
    for (const call of harness.calls.filter((item) => item.accepted && item.path === CHAIN_BACKUP_OBJECT_PATH)) {
      acceptedBySegment.set(call.segmentKey, (acceptedBySegment.get(call.segmentKey) ?? 0) + 1);
    }
    assert.ok([...acceptedBySegment.values()].every((count) => count === 1), 'no accepted segment is published twice');
    const runs = listChainBackupRuns(reopened.getDatabase(), bot.globalmetaid);
    assert.equal(runs[0].status, 'complete');
    const uploads = listChainBackupSegmentUploads(reopened.getDatabase(), bot.globalmetaid);
    assert.ok(uploads.every((upload) => upload.status === 'published'));
    reopened.close();
  });
}

test('a response-lost segment is adopted by segmentKey without a duplicate pin', async () => {
  const source = await openStore('idbots-resume-response-loss-');
  const { bot } = await createBot(source.metabotStore);
  const userStore = insertUserIdentity(source.db, source.sqliteStore.getSaveFunction());
  seedMemories(source, bot, 2, 80 * 1024);
  const harness = createHarness();
  harness.failNext((call) => call.path === CHAIN_BACKUP_OBJECT_PATH, new TypeError('fetch failed'), true);

  const first = await harness.runBackup(source.metabotStore, userStore, source.sqliteStore, { maxNetworkAttempts: 1 });
  assert.equal(first.resumable, true);
  const failedSegmentKey = harness.calls.find((call) => call.path === CHAIN_BACKUP_OBJECT_PATH).segmentKey;
  const second = await harness.runBackup(source.metabotStore, userStore, source.sqliteStore, { maxNetworkAttempts: 1 });
  assert.equal(second.success, true, JSON.stringify(second));
  assert.ok(second.bots[0].resumedSegments > 0);
  assert.equal(
    harness.calls.filter((call) => call.segmentKey === failedSegmentKey && call.path === CHAIN_BACKUP_OBJECT_PATH).length,
    1,
    'the accepted segment is not attempted again',
  );
});

test('indexer lag gets a second reconciliation before a segment is republished', async () => {
  const source = await openStore('idbots-resume-indexer-lag-');
  const { bot } = await createBot(source.metabotStore);
  const userStore = insertUserIdentity(source.db, source.sqliteStore.getSaveFunction());
  seedMemories(source, bot, 1, 1024);
  const harness = createHarness();
  harness.failNext((call) => call.path === CHAIN_BACKUP_OBJECT_PATH, new TypeError('fetch failed'), true);
  await harness.runBackup(source.metabotStore, userStore, source.sqliteStore, { maxNetworkAttempts: 1 });

  let lookups = 0;
  const second = await harness.runBackup(source.metabotStore, userStore, source.sqliteStore, {
    maxNetworkAttempts: 1,
    findPublishedSegmentPinImpl: async (input) => {
      lookups += 1;
      if (lookups === 1) return null;
      return harness.findPublishedSegmentPinImpl(input);
    },
  });
  assert.equal(second.success, true, JSON.stringify(second));
  assert.equal(lookups, 2);
  assert.equal(harness.calls.filter((call) => call.path === CHAIN_BACKUP_OBJECT_PATH).length, 1);
});

test('a response-lost manifest is adopted without forking or another chain write', async () => {
  const source = await openStore('idbots-resume-manifest-loss-');
  const { bot } = await createBot(source.metabotStore);
  const userStore = insertUserIdentity(source.db, source.sqliteStore.getSaveFunction());
  seedMemories(source, bot, 1, 1024);
  const harness = createHarness();
  harness.failNext((call) => call.path === CHAIN_BACKUP_MANIFEST_PATH, new TypeError('fetch failed'), true);

  const first = await harness.runBackup(source.metabotStore, userStore, source.sqliteStore, { maxNetworkAttempts: 1 });
  assert.equal(first.resumable, true);
  const manifestCallsBeforeResume = harness.calls.filter((call) => call.path === CHAIN_BACKUP_MANIFEST_PATH).length;
  const second = await harness.runBackup(source.metabotStore, userStore, source.sqliteStore, { maxNetworkAttempts: 1 });
  assert.equal(second.success, true, JSON.stringify(second));
  const manifestCalls = harness.calls.filter((call) => call.path === CHAIN_BACKUP_MANIFEST_PATH);
  assert.equal(manifestCalls.length, manifestCallsBeforeResume, 'the existing manifest head is adopted');
  const journal = source.db.exec('SELECT manifest_pinid FROM chain_backup_state WHERE bot_globalmetaid = ?', [bot.globalmetaid]);
  assert.equal(journal[0].values[0][0], second.bots[0].manifestPinId);
  const runs = listChainBackupRuns(source.db, bot.globalmetaid);
  assert.equal(runs[0].status, 'complete');
});

test('indexer lag gets a second reconciliation before a manifest is republished', async () => {
  const source = await openStore('idbots-resume-manifest-indexer-lag-');
  const { bot } = await createBot(source.metabotStore);
  const userStore = insertUserIdentity(source.db, source.sqliteStore.getSaveFunction());
  seedMemories(source, bot, 1, 1024);
  const harness = createHarness();
  harness.failNext((call) => call.path === CHAIN_BACKUP_MANIFEST_PATH, new TypeError('fetch failed'), true);
  await harness.runBackup(source.metabotStore, userStore, source.sqliteStore, { maxNetworkAttempts: 1 });

  let lookups = 0;
  const second = await harness.runBackup(source.metabotStore, userStore, source.sqliteStore, {
    maxNetworkAttempts: 1,
    fetchManifestStateImpl: async (input) => {
      lookups += 1;
      if (lookups === 1) return null;
      return harness.fetchManifestStateImpl(input);
    },
  });
  assert.equal(second.success, true, JSON.stringify(second));
  assert.equal(lookups, 2);
  assert.equal(harness.calls.filter((call) => call.path === CHAIN_BACKUP_MANIFEST_PATH).length, 1);
});

test('a response-lost manifest modification is adopted at the same history head', async () => {
  const source = await openStore('idbots-resume-manifest-modify-loss-');
  const { bot } = await createBot(source.metabotStore);
  const userStore = insertUserIdentity(source.db, source.sqliteStore.getSaveFunction());
  seedMemories(source, bot, 1, 1024);
  const harness = createHarness();
  const first = await harness.runBackup(source.metabotStore, userStore, source.sqliteStore);
  assert.equal(first.success, true, JSON.stringify(first));

  harness.failNext((call) => call.operation === 'modify', new TypeError('fetch failed'), true);
  const interrupted = await harness.runBackup(source.metabotStore, userStore, source.sqliteStore, { maxNetworkAttempts: 1 });
  assert.equal(interrupted.resumable, true);
  const callsBeforeResume = harness.calls.length;
  const resumed = await harness.runBackup(source.metabotStore, userStore, source.sqliteStore, { maxNetworkAttempts: 1 });
  assert.equal(resumed.success, true, JSON.stringify(resumed));
  assert.equal(harness.calls.length, callsBeforeResume, 'no additional pin is needed after the lost modify response');
  const manifestPins = harness.scopedListings[`${bot.globalmetaid}|${CHAIN_BACKUP_MANIFEST_PATH}`];
  assert.equal(manifestPins[0].modify_history.length, 2);
});

test('transient failures retry automatically, permanent failures do not retry', async () => {
  const transientSource = await openStore('idbots-resume-auto-retry-');
  const { bot: transientBot } = await createBot(transientSource.metabotStore);
  const transientUser = insertUserIdentity(transientSource.db, transientSource.sqliteStore.getSaveFunction());
  seedMemories(transientSource, transientBot, 1, 1024);
  const transientHarness = createHarness();
  transientHarness.failNext((call) => call.path === CHAIN_BACKUP_OBJECT_PATH, new TypeError('fetch failed'), false);
  const transientResult = await transientHarness.runBackup(transientSource.metabotStore, transientUser, transientSource.sqliteStore, { maxNetworkAttempts: 3 });
  assert.equal(transientResult.success, true, JSON.stringify(transientResult));
  assert.equal(transientResult.bots[0].networkRetries, 1);
  assert.ok(transientHarness.delays.some((delay) => delay >= 800));

  const permanentSource = await openStore('idbots-resume-permanent-');
  const { bot: permanentBot } = await createBot(permanentSource.metabotStore);
  const permanentUser = insertUserIdentity(permanentSource.db, permanentSource.sqliteStore.getSaveFunction());
  seedMemories(permanentSource, permanentBot, 1, 1024);
  const permanentHarness = createHarness();
  permanentHarness.failNext((call) => call.path === CHAIN_BACKUP_OBJECT_PATH, new Error('insufficient funds'), false);
  const permanentResult = await permanentHarness.runBackup(permanentSource.metabotStore, permanentUser, permanentSource.sqliteStore, { maxNetworkAttempts: 3 });
  assert.equal(permanentResult.success, false);
  assert.notEqual(permanentResult.resumable, true);
  assert.equal(permanentHarness.calls.filter((call) => call.path === CHAIN_BACKUP_OBJECT_PATH).length, 1);
});

test('oversized objects are chunked within budget, restored byte-for-byte, and skipped next time', async () => {
  const source = await openStore('idbots-resume-oversize-source-');
  const { bot } = await createBot(source.metabotStore);
  source.metabotStore.updateMetabot(bot.id, { metabot_type: 'twin' });
  const userStore = insertUserIdentity(source.db, source.sqliteStore.getSaveFunction());
  const originalText = 'oversized-memory-'.repeat(40_000);
  const now = Date.now();
  source.db.run(
    `INSERT INTO user_memories
      (id, metabot_id, text, fingerprint, confidence, is_explicit, status, scope_kind, scope_key,
       usage_class, visibility, origin, importance, created_at, updated_at)
     VALUES ('oversized-memory', ?, ?, 'oversized-fingerprint', 0.9, 1, 'created', 'owner', 'owner:self',
             'profile_fact', 'local_only', 'conversation', 0.9, ?, ?)`,
    [bot.id, originalText, now, now],
  );
  const harness = createHarness();
  const backup = await harness.runBackup(source.metabotStore, userStore, source.sqliteStore);
  assert.equal(backup.success, true, JSON.stringify(backup));

  const backupKey = deriveBackupKey(USER_MNEMONIC, USER_GID);
  let chunkCount = 0;
  for (const [pinId, payload] of Object.entries(harness.pins)) {
    if (pinId === 'pin-bots' || pinId.includes('manifest')) continue;
    try {
      const envelope = JSON.parse(payload);
      if (!envelope.payload) continue;
      const decrypted = decryptBytes(backupKey, Buffer.from(envelope.payload, 'base64'));
      const plaintext = JSON.parse(
        (envelope.encoding === 'gzip' ? zlib.gunzipSync(decrypted) : decrypted).toString('utf8'),
      );
      assert.ok(Buffer.byteLength(JSON.stringify(plaintext), 'utf8') <= CHAIN_BACKUP_SEGMENT_PLAINTEXT_LIMIT);
      chunkCount += plaintext.objects.filter((obj) => obj.kind === 'object_chunk').length;
    } catch { /* public manifest */ }
  }
  assert.ok(chunkCount > 1, 'the oversized memory is split into multiple chunks');

  const target = await openStore('idbots-resume-oversize-target-');
  const targetUser = insertUserIdentity(target.db, target.sqliteStore.getSaveFunction());
  const restoreFetch = stubRestoreIndexer(harness);
  try {
    const restored = await runChainBackupRestore({
      db: target.db,
      metabotStore: target.metabotStore,
      userStore: targetUser,
      saveDb: target.sqliteStore.getSaveFunction(),
      baseUrl: 'http://stub.test',
    });
    assert.equal(restored.success, true, JSON.stringify(restored));
    const memory = target.db.exec('SELECT text FROM user_memories WHERE id = ?', ['oversized-memory']);
    assert.equal(memory[0].values[0][0], originalText);
    const restoredBot = target.metabotStore.listMetabots()[0];
    const restoredWallet = target.metabotStore.getMetabotWalletByMetabotId(restoredBot.id);
    const restoredObjects = extractBackupObjects(target.db, restoredBot.id, restoredWallet, {
      bot: restoredBot,
      includeShared: restoredBot.metabot_type === 'twin',
    });
    const journal = readChainBackupState(target.db, restoredBot.globalmetaid);
    const uploadedIds = new Set(JSON.parse(journal.uploaded_object_ids_json));
    const changedObjects = restoredObjects.filter((obj) => !uploadedIds.has(obj.id));
    const second = await harness.runBackup(target.metabotStore, targetUser, target.sqliteStore);
    assert.equal(second.success, true, JSON.stringify(second));
    assert.equal(changedObjects.length, 0, `changed objects: ${JSON.stringify(changedObjects.map((obj) => ({ kind: obj.kind, data: obj.data })))}`);
    assert.equal(second.bots[0].uploadedObjects, 0);
  } finally {
    restoreFetch();
  }
});
