import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
const { ensureSkillAssignmentSchema, setMetabotAssignedSkills, listAssignedSkillIds } = require('../dist-electron/main/libs/skillAssignmentStore.js');
const { createMetaBotWallet } = require('../dist-electron/main/services/metabotWalletService.js');
const { deriveBackupKey, encryptJson, objectId } = require('../dist-electron/main/services/chainBackupCrypto.js');
const { extractBackupObjects } = require('../dist-electron/main/services/chainBackupData.js');
const { CHAIN_BACKUP_CIPHER, CHAIN_BACKUP_KDF, CHAIN_BACKUP_MANIFEST_PATH, runChainBackup } = require('../dist-electron/main/services/chainBackupService.js');
const { runChainBackupRestore } = require('../dist-electron/main/services/chainBackupRestoreService.js');

/**
 * Run `pnpm run compile:electron` first. Indexer fixtures mirror production:
 * MetaID-scoped listing is unavailable, address-scoped listing works.
 */

const USER_MNEMONIC = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const USER_GID = 'idqtestuserglobalmetaid0000000000000001';
const BOT_WALLET = await createMetaBotWallet({ mnemonic: USER_MNEMONIC, path: "m/44'/10001'/0'/0/0" });
const BOT2_WALLET = await createMetaBotWallet({ mnemonic: USER_MNEMONIC, path: "m/44'/10001'/0'/0/1" });
const BOT_GID = BOT_WALLET.globalmetaid;
const BOT2_GID = BOT2_WALLET.globalmetaid;

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

async function createBot(metabotStore, name, gid, mnemonic = USER_MNEMONIC, path = "m/44'/10001'/0'/0/0") {
  const derived = await createMetaBotWallet({ mnemonic, path });
  const wallet = metabotStore.insertMetabotWallet({ mnemonic, path });
  return metabotStore.createMetabot({
    wallet_id: wallet.id,
    mvc_address: derived.mvc_address,
    btc_address: derived.btc_address,
    doge_address: derived.doge_address,
    public_key: derived.public_key,
    chat_public_key: derived.chat_public_key,
    name,
    enabled: true,
    metaid: derived.metaid,
    globalmetaid: gid,
    metabot_type: 'worker',
    created_by: '0000',
    role: 'tester',
    soul: 'test soul',
  });
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

/** One encrypted segment pin body for the given slice of backup objects. */
function buildSegmentEnvelope(backupKey, botGid, objects) {
  const plaintext = {
    version: 1,
    bot: botGid,
    createdAt: Math.floor(Date.now() / 1000),
    objects: objects.map((o) => ({ id: o.id, kind: o.kind, data: o.data })),
  };
  return {
    envelopeText: JSON.stringify({
      version: 1,
      bot: botGid,
      segment: objectId(plaintext),
      cipher: CHAIN_BACKUP_CIPHER,
      kdf: CHAIN_BACKUP_KDF,
      payload: encryptJson(backupKey, plaintext).toString('base64'),
    }),
    segmentId: objectId(plaintext),
    ref: (pinId) => ({
      pinId,
      segment: objectId(plaintext),
      bytes: 1024,
      kinds: objects.map((o) => o.kind),
      objectIds: objects.map((o) => o.id),
    }),
  };
}

/**
 * Stub the manapi indexer on globalThis.fetch. `pins` maps pin id → body
 * text (or `null` for HTTP 404). Scoped listings return the newest pin for
 * the requested metaid+path; the platform-global path feed returns an empty
 * page and records that it was touched.
 */
function stubIndexer(pins, scopedListings) {
  const calls = { globalPathList: 0, addressList: 0, metaidList: 0 };
  const originalFetch = globalThis.fetch;
  const ownerByAddress = { 'mvc-user': USER_GID };
  for (const body of Object.values(pins)) {
    if (typeof body !== 'string') continue;
    try {
      const parsed = JSON.parse(body);
      for (const bot of Array.isArray(parsed.bots) ? parsed.bots : []) {
        if (bot.mvcAddress && bot.globalMetaId) ownerByAddress[bot.mvcAddress] = bot.globalMetaId;
      }
    } catch {
      // Non-JSON pin content.
    }
  }
  globalThis.fetch = async (url, init) => {
    const href = String(url);
    const respond = (status, body, contentType = 'application/json') => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
      headers: { get: () => contentType },
    });
    if (href.includes('/api/metaid/pin/list/')) {
      calls.metaidList += 1;
      return respond(200, { code: 404, message: 'Parameter error.' });
    }
    const addressScoped = href.match(/\/api\/address\/pin\/list\/([^/?]+)\?/);
    if (addressScoped) {
      calls.addressList += 1;
      const address = decodeURIComponent(addressScoped[1]);
      const owner = ownerByAddress[address];
      const path = new URL(href).searchParams.get('path');
      const list = (scopedListings[`${owner}|${path}`] ?? []).map((raw) => {
        const item = typeof raw === 'string' ? { id: raw } : raw;
        return {
          id: item.id,
          timestamp: Math.floor(Date.now() / 1000),
          address,
          globalMetaId: owner,
          modify_history: item.modify_history ?? [item.id],
        };
      });
      return respond(200, { code: 1, data: { list, nextCursor: null } });
    }
    if (href.includes('/api/pin/path/list')) {
      calls.globalPathList += 1;
      return respond(200, { code: 1, data: { list: [], nextCursor: null } });
    }
    if (href.includes('/api/v1/users/info/address/')) {
      return respond(200, { code: 1, data: {} });
    }
    if (href.includes('/api/v1/info/address/')) {
      return respond(200, { code: 1, data: { name: 'restored-from-chain' } });
    }
    const content = href.match(/\/content\/([^/?]+)/);
    if (content) {
      const pinId = decodeURIComponent(content[1]);
      const body = pins[pinId];
      if (body == null) return respond(404, { code: 0, message: 'not found' });
      return respond(200, body, 'text/plain');
    }
    throw new Error(`unexpected fetch in test: ${href} ${JSON.stringify(init ?? {})}`);
  };
  return {
    calls,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

async function seedSourceBot(source, gid, name, walletPath = "m/44'/10001'/0'/0/0", extractOptions = {}, mnemonic = USER_MNEMONIC) {
  const bot = await createBot(source.metabotStore, name, gid, mnemonic, walletPath);
  const now = Date.now();
  source.db.run(
    `INSERT INTO user_memories (id, metabot_id, text, fingerprint, confidence, is_explicit, status, scope_kind, scope_key, usage_class, visibility, origin, importance, created_at, updated_at)
     VALUES (?, ?, ?, ?, 0.9, 1, 'created', 'owner', 'owner:self', 'profile_fact', 'local_only', 'conversation', 0.9, ?, ?)`,
    [`mem-${name}`, bot.id, `user fact for ${name}`, `fp-${name}`, now, now],
  );
  const wallet = source.metabotStore.getMetabotWalletByMetabotId(bot.id);
  return { bot, objects: extractBackupObjects(source.db, bot.id, wallet, { bot, ...extractOptions }) };
}

function createBackupHarness() {
  const pins = {};
  const scopedListings = {};
  const modifyTargets = [];
  let sequence = 0;

  const createPinImpl = async (metabotStore, metabotId, metaidData) => {
    const bot = metabotStore.getMetabotById(metabotId);
    const owner = bot.globalmetaid;
    sequence += 1;
    const pinId = `pin-live-${sequence}`;
    pins[pinId] = metaidData.payload;
    if (metaidData.operation === 'modify') {
      const target = metaidData.path.slice(1);
      modifyTargets.push({ owner, target, pinId });
      const candidates = scopedListings[`${owner}|${CHAIN_BACKUP_MANIFEST_PATH}`] ?? [];
      const current = candidates.find((item) => item.modify_history.includes(target));
      if (!current) throw new Error(`modify target not found: ${target}`);
      current.modify_history.push(pinId);
    } else {
      const key = `${owner}|${metaidData.path}`;
      scopedListings[key] = scopedListings[key] ?? [];
      scopedListings[key].unshift({ id: pinId, modify_history: [pinId] });
    }
    return { pinId, txids: [`tx-live-${sequence}`], totalCost: 0 };
  };

  const runBackup = async (metabotStore, userStore, sqliteStore) => runChainBackup({
    db: sqliteStore.getDatabase(),
    metabotStore,
    userStore,
    saveDb: sqliteStore.getSaveFunction(),
    createPinImpl,
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
      pins['pin-bots'] = JSON.stringify({ version: 1, updatedAt: Math.floor(Date.now() / 1000), bots });
      scopedListings[`${USER_GID}|/info/bots`] = [{ id: 'pin-bots', modify_history: ['pin-bots'] }];
      return { success: true, botCount: bots.length, boundCount: bots.length, newlyBound: 0, skippedUnbound: [], txids: [] };
    },
    sleep: async () => undefined,
  });

  return { pins, scopedListings, modifyTargets, runBackup };
}

test('discovery rides the address-scoped listing; a dead segment degrades to a partial restore', async () => {
  const source = await openStore('idbots-restore-src-');
  const { objects: botObjects } = await seedSourceBot(source, BOT_GID, 'alpha');

  const backupKey = deriveBackupKey(USER_MNEMONIC, USER_GID);
  // Segment 1: key envelope + memory (everything needed to rebuild the bot).
  const seg1Objects = botObjects.filter((o) => o.kind === 'key_envelope' || o.kind === 'memory');
  // Segment 2: would carry nothing here — model it as a dead pin the
  // manifest still advertises (the manifest only ever grows).
  const seg1 = buildSegmentEnvelope(backupKey, BOT_GID, seg1Objects);
  const deadPinId = 'pin-seg-alpha-dead';
  const manifest = {
    bot: BOT_GID,
    botName: 'alpha',
    updatedAt: Math.floor(Date.now() / 1000),
    segments: [seg1.ref('pin-seg-alpha-1'), {
      pinId: deadPinId,
      segment: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
      bytes: 512,
      kinds: ['knowledge'],
      objectIds: ['kn-dead'],
    }],
  };

  const stub = stubIndexer(
    {
      'pin-bots': JSON.stringify({ bots: [{ globalMetaId: BOT_GID, name: 'alpha', type: 'worker', mvcAddress: 'mvc-alpha' }] }),
      'pin-manifest-alpha': JSON.stringify(manifest),
      'pin-seg-alpha-1': seg1.envelopeText,
    },
    {
      [`${USER_GID}|/info/bots`]: ['pin-bots'],
      [`${BOT_GID}|${CHAIN_BACKUP_MANIFEST_PATH}`]: ['pin-manifest-alpha'],
    },
  );

  try {
    const target = await openStore('idbots-restore-dst-');
    const userStore = insertUserIdentity(target.db, target.sqliteStore.getSaveFunction());
    const result = await runChainBackupRestore({
      db: target.db,
      metabotStore: target.metabotStore,
      userStore,
      baseUrl: 'http://stub.test',
    });

    assert.equal(stub.calls.globalPathList, 0, 'address-scoped discovery avoids the global path feed');
    assert.equal(stub.calls.metaidList, 0, 'the unavailable MetaID endpoint is never called');
    assert.ok(stub.calls.addressList > 0, 'discovery uses the production address-scoped endpoint');
    assert.equal(result.success, true);
    assert.equal(result.bots.length, 1);
    const bot = result.bots[0];
    assert.equal(bot.restored, true, 'skeleton is rebuilt from the live segment');
    assert.equal(bot.imported, 1, 'the live segment memory imports');
    assert.equal(bot.skipped, 1, 'the key envelope is counted as skipped');
    assert.ok((bot.warnings?.length ?? 0) === 1 && bot.warnings[0].includes(deadPinId),
      'the dead segment is reported as a warning');
    assert.equal(bot.error, undefined);

    // A partial restore must NOT adopt the on-chain manifest as the local
    // journal baseline — the next full backup re-publishes a complete set.
    const journal = target.db.exec(
      'SELECT bot_globalmetaid FROM chain_backup_state WHERE bot_globalmetaid = ?',
      [BOT_GID],
    );
    assert.equal(journal[0].values.length, 0, 'no journal baseline for a partial restore');

    // The restored bot exists with its memory row.
    const memories = target.db.exec(
      `SELECT text FROM user_memories WHERE fingerprint = ?`,
      ['fp-alpha'],
    );
    assert.equal(memories[0].values.length, 1);
  } finally {
    stub.restore();
  }
});

test('a fully verified restore rebuilds the journal baseline', async () => {
  const source = await openStore('idbots-restore-src2-');
  const { objects: botObjects } = await seedSourceBot(source, BOT2_GID, 'beta', "m/44'/10001'/0'/0/1");

  const backupKey = deriveBackupKey(USER_MNEMONIC, USER_GID);
  const seg = buildSegmentEnvelope(backupKey, BOT2_GID, botObjects);
  const manifest = {
    bot: BOT2_GID,
    botName: 'beta',
    updatedAt: Math.floor(Date.now() / 1000),
    segments: [seg.ref('pin-seg-beta-1')],
  };

  const stub = stubIndexer(
    {
      'pin-bots': JSON.stringify({ bots: [{ globalMetaId: BOT2_GID, name: 'beta', type: 'worker', mvcAddress: 'mvc-beta' }] }),
      'pin-manifest-beta': JSON.stringify(manifest),
      'pin-seg-beta-1': seg.envelopeText,
    },
    {
      [`${USER_GID}|/info/bots`]: ['pin-bots'],
      [`${BOT2_GID}|${CHAIN_BACKUP_MANIFEST_PATH}`]: ['pin-manifest-beta'],
    },
  );

  try {
    const target = await openStore('idbots-restore-dst2-');
    const userStore = insertUserIdentity(target.db, target.sqliteStore.getSaveFunction());
    const result = await runChainBackupRestore({
      db: target.db,
      metabotStore: target.metabotStore,
      userStore,
      baseUrl: 'http://stub.test',
    });

    assert.equal(result.success, true);
    const bot = result.bots[0];
    assert.equal(bot.restored, true);
    assert.equal(bot.warnings, undefined);
    const journal = target.db.exec(
      'SELECT manifest_pinid FROM chain_backup_state WHERE bot_globalmetaid = ?',
      [BOT2_GID],
    );
    assert.equal(journal[0].values[0][0], 'pin-manifest-beta');
  } finally {
    stub.restore();
  }
});

test('restore applies the newest segment version and never resurrects deleted rows', async () => {
  // Two backup runs, two segments: run 1 published memory v1 + a knowledge
  // entry; run 2 re-published the memory after an in-place edit (same row id)
  // and tombstoned the knowledge entry (hard delete). The manifest carries
  // both segments oldest-first.
  const source = await openStore('idbots-restore-src3-');
  const { bot, objects: botObjects } = await seedSourceBot(source, BOT_GID, 'gamma');
  const envelopeObj = botObjects.find((o) => o.kind === 'key_envelope');
  const memoryV1 = botObjects.find((o) => o.kind === 'memory');
  const memoryV2 = {
    id: 'obj-gamma-mem-v2',
    kind: 'memory',
    data: { ...memoryV1.data, text: 'user fact for gamma (edited)', updated_at: Date.now() + 1000 },
  };
  const knowledgeV1 = {
    id: 'obj-gamma-kn-v1',
    kind: 'knowledge',
    data: {
      id: 'kn-gamma', metabot_id: bot.id, topic: 'stale topic', summary: 'later deleted',
      kind: 'know_how', confidence: 0.5, status: 'active', origin: 'dream', version: 1,
      created_at: Date.now(), updated_at: Date.now(), revisions: [],
    },
  };
  const knowledgeTombstone = {
    id: 'obj-gamma-kn-tomb',
    kind: 'knowledge_tombstone',
    data: { ref: 'kn-gamma', deleted_at: Date.now() + 2000 },
  };
  const memoryTombstone = {
    id: 'obj-gamma-mem-tomb',
    kind: 'memory_tombstone',
    data: { ref: 'mem-gone', deleted_at: Date.now() + 2000 },
  };
  const memoryGoneV1 = {
    id: 'obj-gamma-gone-v1',
    kind: 'memory',
    data: {
      id: 'mem-gone', metabot_id: bot.id, text: 'deleted after backup', fingerprint: 'fp-gone',
      confidence: 0.5, is_explicit: 0, status: 'created', scope_kind: 'owner', scope_key: 'owner:self',
      usage_class: 'profile_fact', visibility: 'local_only', origin: 'conversation', importance: 0.5,
      created_at: Date.now(), updated_at: Date.now(), sources: [],
    },
  };
  for (const obj of [memoryV2, knowledgeV1, knowledgeTombstone, memoryTombstone, memoryGoneV1]) {
    obj.id = objectId({ kind: obj.kind, data: obj.data });
  }

  const backupKey = deriveBackupKey(USER_MNEMONIC, USER_GID);
  const seg1 = buildSegmentEnvelope(backupKey, BOT_GID, [envelopeObj, memoryV1, knowledgeV1, memoryGoneV1]);
  const seg2 = buildSegmentEnvelope(backupKey, BOT_GID, [memoryV2, knowledgeTombstone, memoryTombstone]);
  const manifest = {
    bot: BOT_GID,
    botName: 'gamma',
    updatedAt: Math.floor(Date.now() / 1000),
    segments: [seg1.ref('pin-seg-gamma-1'), seg2.ref('pin-seg-gamma-2')],
  };

  const stub = stubIndexer(
    {
      'pin-bots': JSON.stringify({ bots: [{ globalMetaId: BOT_GID, name: 'gamma', type: 'worker', mvcAddress: 'mvc-gamma' }] }),
      'pin-manifest-gamma': JSON.stringify(manifest),
      'pin-seg-gamma-1': seg1.envelopeText,
      'pin-seg-gamma-2': seg2.envelopeText,
    },
    {
      [`${USER_GID}|/info/bots`]: ['pin-bots'],
      [`${BOT_GID}|${CHAIN_BACKUP_MANIFEST_PATH}`]: ['pin-manifest-gamma'],
    },
  );

  try {
    const target = await openStore('idbots-restore-dst3-');
    const userStore = insertUserIdentity(target.db, target.sqliteStore.getSaveFunction());
    const result = await runChainBackupRestore({
      db: target.db,
      metabotStore: target.metabotStore,
      userStore,
      baseUrl: 'http://stub.test',
    });

    assert.equal(result.success, true);
    assert.equal(result.bots[0].error, undefined);

    // The edited memory restores at its NEWEST version, not the first segment's.
    const memory = target.db.exec(`SELECT text FROM user_memories WHERE fingerprint = ?`, ['fp-gamma']);
    assert.equal(memory[0].values.length, 1);
    assert.equal(memory[0].values[0][0], 'user fact for gamma (edited)');

    // The tombstoned memory never comes back.
    const gone = target.db.exec(`SELECT COUNT(*) FROM user_memories WHERE fingerprint = ?`, ['fp-gone']);
    assert.equal(gone[0].values[0][0], 0);

    // The hard-deleted knowledge entry stays deleted.
    const knowledge = target.db.exec(`SELECT COUNT(*) FROM metaid_knowledge_entries WHERE id = ?`, ['kn-gamma']);
    assert.equal(knowledge[0].values[0][0], 0);
  } finally {
    stub.restore();
  }
});

function scalar(db, sql, params = []) {
  return db.exec(sql, params)[0]?.values?.[0]?.[0];
}

test('ten bots survive backup, modified-manifest restore, reopen, and the next incremental backup', async () => {
  const source = await openStore('idbots-full-source-');
  const sourceUser = insertUserIdentity(source.db, source.sqliteStore.getSaveFunction());
  const now = Date.now();
  const bots = [];
  const a2aLimits = [20, 30, 50, 80, 100, 150, 200];

  for (let i = 0; i < 10; i += 1) {
    const walletPath = `m/44'/10001'/0'/0/${i}`;
    const derived = await createMetaBotWallet({ path: walletPath });
    const seeded = await seedSourceBot(source, derived.globalmetaid, `bot-${i}`, walletPath, {}, derived.mnemonic);
    bots.push(seeded.bot);
  }
  bots[4] = source.metabotStore.updateMetabot(bots[4].id, { metabot_type: 'twin' });

  for (let i = 0; i < bots.length; i += 1) {
    const bot = bots[i];
    bots[i] = source.metabotStore.updateMetabot(bot.id, {
      enabled: i !== 9,
      role: `role-${i}`,
      soul: `soul-${i}`,
      goal: `goal-${i}`,
      bio: `bio-${i}`,
      boss_id: i === 0 ? null : bots[0].id,
      boss_global_metaid: i === 0 ? null : bots[0].globalmetaid,
      owner_binding_pinid: `owner-binding-${i}`,
      llm_id: `model-${i}`,
      llm_provider: 'test-provider',
      llm_effort: 'high',
      fallback_llm_id: `fallback-${i}`,
      fallback_llm_provider: 'fallback-provider',
      fallback_llm_effort: 'low',
      tools: [`tool-${i}`],
      skills: [`bundled-skill-${i}`],
      allow_chat_skills: [`external-skill-${i}`],
      a2a_max_incoming_turns: a2aLimits[i % a2aLimits.length],
      a2a_bye_cooldown_ms: [60_000, 300_000, 600_000, 1_800_000, 3_600_000][i % 5],
      a2a_auto_reply_enabled: i % 2 === 0,
      homepage: `metaapp://home-${i}`,
    });
    source.metabotStore.setMetabotSetting(bot.id, 'dailyReport.hour', String(8 + i));
    setMetabotAssignedSkills(source.db, source.sqliteStore.getSaveFunction(), bot.id, [`external-skill-${i}`], 'migration');
    source.db.run(
      `INSERT INTO metabot_memory_policies (metabot_id, memory_user_memories_max_items, dream_enabled, updated_at)
       VALUES (?, ?, 1, ?)`,
      [bot.id, 20 + i, now],
    );
    source.dreamStore.upsertDailySummary({
      metabotId: bot.id,
      summaryDate: '2026-10-25',
      summaryText: `dream-${i}`,
      sections: { identity: `identity-${i}` },
      stats: { memories: 1 },
      llmId: `model-${i}`,
    });
    source.db.run(
      `INSERT INTO metaid_knowledge_entries
        (id, metabot_id, topic, topic_fingerprint, summary, kind, confidence, status, origin, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'know_how', 0.8, 'active', 'dream', 1, ?, ?)`,
      [`knowledge-${i}`, bot.id, `topic-${i}`, `topic-fp-${i}`, `knowledge-summary-${i}`, now, now],
    );
    source.db.run(
      `INSERT INTO scheduled_tasks (id, name, schedule_json, prompt, metabot_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [`schedule-${i}`, `schedule-name-${i}`, JSON.stringify({ type: 'interval', minutes: 30 }), `schedule-prompt-${i}`, bot.id, new Date(now).toISOString(), new Date(now).toISOString()],
    );
    source.db.run(
      `INSERT INTO cowork_sessions (id, title, status, cwd, metabot_id, created_at, updated_at)
       VALUES (?, ?, 'idle', '/tmp', ?, ?, ?)`,
      [`session-${i}`, `session-title-${i}`, bot.id, now, now],
    );
    source.db.run(
      `INSERT INTO cowork_messages (id, session_id, type, content, created_at, sequence)
       VALUES (?, ?, 'user', ?, ?, 1)`,
      [`message-${i}`, `session-${i}`, `conversation-${i}`, now],
    );
    source.db.run(
      `INSERT INTO cowork_conversation_mappings
        (channel, external_conversation_id, metabot_id, cowork_session_id, created_at, last_active_at)
       VALUES ('cowork_ui', ?, ?, ?, ?, ?)`,
      [`session-${i}`, bot.id, `session-${i}`, now, now],
    );
  }

  const twin = bots[4];
  const subject = bots[0].globalmetaid;
  const experienceTimestamp = now - 61 * 24 * 60 * 60 * 1000;
  source.db.run(
    `INSERT INTO metaid_experience_episodes
      (id, owner_globalmetaid, episode_type, source_channel, source_key, status, started_at, created_at, updated_at)
     VALUES ('episode-twin', ?, 'direct_interaction', 'cowork_ui', 'session-4', 'open', ?, ?, ?)`,
    [twin.globalmetaid, experienceTimestamp, experienceTimestamp, experienceTimestamp],
  );
  source.db.run(
    `INSERT INTO metaid_experience_participants
      (episode_id, participant_key, globalmetaid, identity_state, role, source, created_at)
     VALUES ('episode-twin', 'owner', ?, 'known', 'owner', 'test', ?)`,
    [twin.globalmetaid, now],
  );
  source.db.run(
    `INSERT INTO metaid_experience_evidence
      (id, episode_id, evidence_type, source_key, occurred_at, created_at)
     VALUES ('evidence-twin', 'episode-twin', 'message', 'message-4', ?, ?)`,
    [experienceTimestamp, experienceTimestamp],
  );
  source.db.run(
    `INSERT INTO metaid_impression_observations
      (id, observer_globalmetaid, subject_globalmetaid, episode_id, observation_text, interpretation_text,
       dimensions_json, confidence_json, dream_date, dream_version, source_hash, idempotency_key, status, created_at)
     VALUES ('observation-twin', ?, ?, 'episode-twin', 'observation', 'interpretation', '{}', '{}',
             '2026-10-25', 1, 'source-hash', 'idempotency-twin', 'active', ?)`,
    [twin.globalmetaid, subject, experienceTimestamp],
  );
  source.db.run(
    `INSERT INTO metaid_impression_observation_evidence (observation_id, evidence_id, relevance, created_at)
     VALUES ('observation-twin', 'evidence-twin', 'direct', ?)`,
    [experienceTimestamp],
  );
  source.db.run(
    `INSERT INTO metaid_impression_snapshots
      (observer_globalmetaid, subject_globalmetaid, first_seen_at, last_seen_at, interaction_count,
       direct_interaction_count, summary_text, latest_observation_id, snapshot_version, source_hash, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, 1, 'snapshot-summary', 'observation-twin', 1, 'source-hash', ?, ?)`,
    [twin.globalmetaid, subject, experienceTimestamp, experienceTimestamp, experienceTimestamp, experienceTimestamp],
  );
  source.db.run(
    `INSERT INTO team_culture_entries
      (id, kind, topic, topic_fingerprint, text, status, version, origin, pending_approval, times_injected, created_at, updated_at)
     VALUES ('culture-twin', 'team_lesson', 'culture-topic', 'culture-fp', 'culture-text', 'active', 1, 'owner', 0, 0, ?, ?)`,
    [now, now],
  );
  source.db.run(
    `INSERT INTO team_culture_revisions (id, entry_id, version, kind, topic, text, origin, created_at)
     VALUES ('culture-revision-twin', 'culture-twin', 1, 'team_lesson', 'culture-topic', 'culture-text', 'owner', ?)`,
    [now],
  );
  source.db.run(
    `INSERT INTO long_term_tasks (id, title, goal, stage, created_at, updated_at)
     VALUES ('longterm-twin', 'longterm-title', 'longterm-goal', 'active', ?, ?)`,
    [new Date(now).toISOString(), new Date(now).toISOString()],
  );
  source.db.run(
    `INSERT INTO long_term_subtasks (id, task_id, ordinal, title, created_at, updated_at)
     VALUES ('longterm-subtask-twin', 'longterm-twin', 1, 'subtask-title', ?, ?)`,
    [new Date(now).toISOString(), new Date(now).toISOString()],
  );
  source.db.run(
    `INSERT INTO long_term_events (id, task_id, subtask_id, kind, actor, detail, created_at)
     VALUES (1, 'longterm-twin', 'longterm-subtask-twin', 'note', 'owner', 'event-detail', ?)`,
    [new Date(now).toISOString()],
  );
  source.db.run(
    `INSERT INTO orchestration_tasks
      (id, owner_intent, twin_metabot_id, owner_global_meta_id, status, created_at, updated_at)
     VALUES ('orchestration-twin', 'orchestration-intent', ?, ?, 'running', ?, ?)`,
    [twin.id, USER_GID, new Date(now).toISOString(), new Date(now).toISOString()],
  );
  source.db.run(
    `INSERT INTO orchestration_steps
      (id, task_id, ordinal, title, objective, assignee_metabot_id, status, created_at, updated_at)
     VALUES ('orchestration-step-twin', 'orchestration-twin', 1, 'step-title', 'step-objective', ?, 'ready', ?, ?)`,
    [bots[1].id, new Date(now).toISOString(), new Date(now).toISOString()],
  );
  source.db.run(
    `INSERT INTO orchestration_attempts
      (id, step_id, idempotency_key, worker_metabot_id, status, prompt, queued_at)
     VALUES ('orchestration-attempt-twin', 'orchestration-step-twin', 'attempt-key-twin', ?, 'queued', 'attempt-prompt', ?)`,
    [bots[1].id, new Date(now).toISOString()],
  );
  source.db.run(
    `INSERT INTO cowork_config (key, value, updated_at) VALUES ('memoryHygiene', ?, ?)`,
    [JSON.stringify({ enabled: true, retentionDays: 60 }), now],
  );
  source.sqliteStore.set('skills_scope', { 'shared-external-skill': 'global' });

  const harness = createBackupHarness();
  const firstBackup = await harness.runBackup(source.metabotStore, sourceUser, source.sqliteStore);
  assert.equal(firstBackup.success, true, JSON.stringify(firstBackup));
  assert.equal(firstBackup.bots.length, 10);
  const secondBackup = await harness.runBackup(source.metabotStore, sourceUser, source.sqliteStore);
  assert.equal(secondBackup.success, true, JSON.stringify(secondBackup));
  assert.ok(secondBackup.bots.every((bot) => bot.uploadedObjects === 0), 'unchanged backup is fully incremental');
  const manifestHeads = new Map(secondBackup.bots.map((bot) => [bot.globalMetaId, bot.manifestPinId]));
  const secondModifyCount = harness.modifyTargets.length;

  const stub = stubIndexer(harness.pins, harness.scopedListings);
  let target;
  try {
    target = await openStore('idbots-full-target-');
    const targetUser = insertUserIdentity(target.db, target.sqliteStore.getSaveFunction());
    const restored = await runChainBackupRestore({
      db: target.db,
      metabotStore: target.metabotStore,
      userStore: targetUser,
      saveDb: target.sqliteStore.getSaveFunction(),
      applyAssignedSkills: (metabotId, skills) => {
        setMetabotAssignedSkills(target.db, target.sqliteStore.getSaveFunction(), metabotId, skills, 'migration');
      },
      baseUrl: 'http://stub.test',
    });
    assert.equal(restored.success, true, JSON.stringify(restored));
    assert.equal(restored.bots.length, 10);
    assert.ok(restored.bots.every((bot) => bot.restored));
    const restoredBots = target.metabotStore.listMetabots();
    assert.equal(restoredBots.length, 10);
    assert.equal(restoredBots.filter((bot) => bot.metabot_type === 'twin').length, 1);
    assert.equal(restoredBots.find((bot) => bot.metabot_type === 'twin').name, 'bot-4');
    assert.equal(scalar(target.db, 'SELECT COUNT(*) FROM user_memories'), 10);
    assert.equal(scalar(target.db, 'SELECT COUNT(*) FROM metabot_daily_summaries'), 10);
    assert.equal(scalar(target.db, 'SELECT COUNT(*) FROM metaid_knowledge_entries'), 10);
    assert.equal(scalar(target.db, 'SELECT COUNT(*) FROM scheduled_tasks'), 10);
    assert.equal(scalar(target.db, 'SELECT COUNT(*) FROM cowork_sessions'), 10);
    assert.equal(scalar(target.db, 'SELECT COUNT(*) FROM cowork_messages'), 10);
    assert.equal(scalar(target.db, 'SELECT COUNT(*) FROM metaid_experience_episodes'), 1);
    assert.equal(scalar(target.db, 'SELECT COUNT(*) FROM metaid_impression_observations'), 1);
    assert.equal(scalar(target.db, 'SELECT COUNT(*) FROM metaid_impression_snapshots'), 1);
    assert.equal(scalar(target.db, 'SELECT COUNT(*) FROM team_culture_entries'), 1);
    assert.equal(scalar(target.db, 'SELECT COUNT(*) FROM team_culture_revisions'), 1);
    assert.equal(scalar(target.db, 'SELECT COUNT(*) FROM long_term_tasks'), 1);
    assert.equal(scalar(target.db, 'SELECT COUNT(*) FROM long_term_subtasks'), 1);
    assert.equal(scalar(target.db, 'SELECT COUNT(*) FROM orchestration_tasks'), 1);
    assert.equal(scalar(target.db, 'SELECT COUNT(*) FROM orchestration_attempts'), 1);
    assert.equal(scalar(target.db, 'SELECT value FROM cowork_config WHERE key = ?', ['memoryHygiene']), JSON.stringify({ enabled: true, retentionDays: 60 }));

    for (let i = 0; i < bots.length; i += 1) {
      const sourceBot = bots[i];
      const restoredBot = restoredBots.find((bot) => bot.globalmetaid === sourceBot.globalmetaid);
      assert.ok(restoredBot, `missing bot-${i}`);
      assert.equal(restoredBot.enabled, i !== 9);
      assert.equal(restoredBot.role, `role-${i}`);
      assert.equal(restoredBot.soul, `soul-${i}`);
      assert.equal(restoredBot.fallback_llm_id, `fallback-${i}`);
      assert.equal(restoredBot.a2a_max_incoming_turns, a2aLimits[i % a2aLimits.length]);
      assert.equal(restoredBot.homepage, `metaapp://home-${i}`);
      assert.equal(restoredBot.boss_global_metaid, sourceBot.boss_global_metaid);
      assert.equal(restoredBot.boss_id, i === 0 ? null : restoredBots.find((bot) => bot.globalmetaid === bots[0].globalmetaid).id);
      assert.equal(target.metabotStore.getMetabotSetting(restoredBot.id, 'dailyReport.hour'), String(8 + i));
      assert.deepEqual(listAssignedSkillIds(target.db, restoredBot.id), [`external-skill-${i}`]);
      assert.equal(scalar(target.db, 'SELECT memory_user_memories_max_items FROM metabot_memory_policies WHERE metabot_id = ?', [restoredBot.id]), 20 + i);
    }
    const mappedAttempt = target.db.exec('SELECT worker_metabot_id FROM orchestration_attempts WHERE id = ?', ['orchestration-attempt-twin']);
    const expectedWorker = restoredBots.find((bot) => bot.globalmetaid === bots[1].globalmetaid).id;
    assert.equal(mappedAttempt[0].values[0][0], expectedWorker);

    const targetDir = target.dir;
    target.sqliteStore.close();
    const reopened = await SqliteStore.create(targetDir);
    const reopenedDb = reopened.getDatabase();
    const reopenedMetabotStore = new MetabotStore(reopenedDb, reopened.getSaveFunction());
    const reopenedUser = new UserIdentityStore(reopenedDb, reopened.getSaveFunction());
    assert.equal(reopenedMetabotStore.listMetabots().length, 10, 'bot fleet survives a real database reopen');
    assert.equal(scalar(reopenedDb, 'SELECT COUNT(*) FROM user_memories'), 10, 'memories are durable');
    assert.equal(scalar(reopenedDb, 'SELECT COUNT(*) FROM cowork_messages'), 10, 'conversations are durable');
    assert.equal(scalar(reopenedDb, 'SELECT COUNT(*) FROM chain_backup_state'), 10, 'backup journals are durable');

    const restoredAgain = await runChainBackupRestore({
      db: reopenedDb,
      metabotStore: reopenedMetabotStore,
      userStore: reopenedUser,
      saveDb: reopened.getSaveFunction(),
      applyAssignedSkills: (metabotId, skills) => {
        setMetabotAssignedSkills(reopenedDb, reopened.getSaveFunction(), metabotId, skills, 'migration');
      },
      baseUrl: 'http://stub.test',
    });
    assert.equal(restoredAgain.success, true, JSON.stringify(restoredAgain));
    assert.equal(reopenedMetabotStore.listMetabots().length, 10, 'repeat restore is idempotent');
    assert.equal(scalar(reopenedDb, 'SELECT COUNT(*) FROM user_memories'), 10);
    assert.equal(scalar(reopenedDb, 'SELECT COUNT(*) FROM cowork_messages'), 10);

    const thirdBackup = await harness.runBackup(reopenedMetabotStore, reopenedUser, reopened);
    assert.equal(thirdBackup.success, true, JSON.stringify(thirdBackup));
    assert.ok(
      thirdBackup.bots.every((bot) => bot.uploadedObjects === 0),
      `restored device does not republish unchanged data: ${JSON.stringify(thirdBackup.bots.map((bot) => ({ name: bot.name, uploaded: bot.uploadedObjects, segments: bot.segments })))}`,
    );
    const newModifyCalls = harness.modifyTargets.slice(secondModifyCount);
    assert.equal(newModifyCalls.length, 10);
    for (const call of newModifyCalls) {
      assert.equal(call.target, manifestHeads.get(call.owner), 'next backup modifies the restored manifest head');
    }
    reopened.close();
  } finally {
    stub.restore();
  }
});

test('a bot without a backup manifest fails the overall restore', async () => {
  const stub = stubIndexer(
    {
      'pin-bots': JSON.stringify({
        bots: [{ globalMetaId: BOT_GID, name: 'missing', type: 'worker', mvcAddress: BOT_WALLET.mvc_address }],
      }),
    },
    { [`${USER_GID}|/info/bots`]: ['pin-bots'] },
  );
  try {
    const target = await openStore('idbots-missing-manifest-');
    const userStore = insertUserIdentity(target.db, target.sqliteStore.getSaveFunction());
    const result = await runChainBackupRestore({
      db: target.db,
      metabotStore: target.metabotStore,
      userStore,
      baseUrl: 'http://stub.test',
    });
    assert.equal(result.success, false);
    assert.equal(result.bots[0].error, 'NO_BACKUP_MANIFEST');
    assert.equal(target.metabotStore.listMetabots().length, 0);
  } finally {
    stub.restore();
  }
});

test('restore onto a device that already ran the welcome flow: the backup Twin wins and name collisions rename the local placeholder', async () => {
  const source = await openStore('idbots-twin-src-');
  const sourceUser = insertUserIdentity(source.db, source.sqliteStore.getSaveFunction());

  // Two backup bots: a Twin whose name collides with the fresh device's
  // welcome-flow placeholder, and an ordinary worker.
  const twinWallet = await createMetaBotWallet({ path: "m/44'/10001'/0'/0/21" });
  const workerWallet = await createMetaBotWallet({ path: "m/44'/10001'/0'/0/22" });
  const twinSeed = await seedSourceBot(source, twinWallet.globalmetaid, 'Pixel', "m/44'/10001'/0'/0/21", {}, twinWallet.mnemonic);
  await seedSourceBot(source, workerWallet.globalmetaid, 'worker-a', "m/44'/10001'/0'/0/22", {}, workerWallet.mnemonic);
  source.metabotStore.updateMetabot(twinSeed.bot.id, { metabot_type: 'twin' });

  const harness = createBackupHarness();
  const backup = await harness.runBackup(source.metabotStore, sourceUser, source.sqliteStore);
  assert.equal(backup.success, true, JSON.stringify(backup));

  const stub = stubIndexer(harness.pins, harness.scopedListings);
  try {
    const target = await openStore('idbots-twin-target-');
    const targetUser = insertUserIdentity(target.db, target.sqliteStore.getSaveFunction());
    // The welcome flow always leaves a Twin (random pool name) before the user
    // can import a mnemonic. Here it happens to draw the same name as the
    // backup's Twin.
    const placeholder = await createBot(
      target.metabotStore,
      'Pixel',
      'gid-local-placeholder',
      (await createMetaBotWallet({ path: "m/44'/10001'/0'/0/23" })).mnemonic,
      "m/44'/10001'/0'/0/23",
    );
    target.metabotStore.updateMetabot(placeholder.id, { metabot_type: 'twin' });

    const restored = await runChainBackupRestore({
      db: target.db,
      metabotStore: target.metabotStore,
      userStore: targetUser,
      saveDb: target.sqliteStore.getSaveFunction(),
      baseUrl: 'http://stub.test',
    });
    assert.equal(restored.success, true, JSON.stringify(restored));

    const targetBots = target.metabotStore.listMetabots();
    assert.equal(targetBots.length, 3, 'placeholder + two restored bots');
    const twins = targetBots.filter((bot) => bot.metabot_type === 'twin');
    assert.equal(twins.length, 1, 'exactly one Twin after restore');
    assert.equal(twins[0].globalmetaid, twinWallet.globalmetaid, 'the backup Twin holds the role');
    assert.equal(twins[0].name, 'Pixel', 'the backup Twin keeps its name');

    const localPlaceholder = targetBots.find((bot) => bot.globalmetaid === 'gid-local-placeholder');
    assert.ok(localPlaceholder, 'placeholder bot survives');
    assert.equal(localPlaceholder.metabot_type, 'worker', 'local placeholder Twin is demoted, not deleted');
    assert.equal(localPlaceholder.name, 'Pixel (local)', 'the local placeholder is renamed out of the way');

    // The Twin's soul data was imported onto the restored Twin row.
    const twinMemories = scalar(target.db, `SELECT COUNT(*) FROM user_memories WHERE metabot_id = ${twins[0].id}`);
    assert.equal(twinMemories, 1, 'backup Twin memories land on the promoted Twin');
  } finally {
    stub.restore();
  }
});
