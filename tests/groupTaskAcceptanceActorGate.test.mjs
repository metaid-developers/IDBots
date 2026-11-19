/**
 * P0-b (task #149) — acceptance semantics gate on acceptGroupTask:
 * acceptance (deliverable.status='accepted' + the owner verdict impression)
 * is the OWNER's act. A chair close (the bearer RPC path) or any other
 * non-owner done close flips pending rows to 'delivered' instead — the rows
 * stay visible in the acceptance summary and member readouts (both filter
 * delivered||accepted) and the chair's closure note carries the "closed on
 * behalf, owner acceptance pending" semantics.
 *
 * Covered here:
 *   1. chair close: pending -> delivered, no 'accepted' row, chair close-out
 *      announcement (never the "accepted by the owner" wording);
 *   2. owner close: pending -> accepted, owner announcement wording;
 *   3. no-actor accept (syncStatus/heal shape): pending -> delivered;
 *   4. verdict impression: owner close records it for the remote author, a
 *      chair close records none;
 *   5. reopen (chair and owner actors): no deliverable write at all;
 *   6. no-bridge fallback close: deliverables untouched (stay 'pending');
 *   7. heal sweep: the system catch-up lands 'delivered' (system is not the
 *      owner).
 *
 * Harness mirrors groupTaskReopenAndStatus.test.mjs (electron mock + real
 * stores) and the impression wiring of openTeamImpressionService.test.mjs.
 * No on-chain calls; the transport is a capturing stub.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import Module from 'node:module';

const require = createRequire(import.meta.url);

const originalLoad = Module._load;
Module._load = function patchedLoad(request, ...rest) {
  if (request === 'electron') {
    return {
      app: {
        isPackaged: false,
        getAppPath: () => process.cwd(),
        getPath: () => process.cwd(),
      },
    };
  }
  return originalLoad.call(this, request, ...rest);
};

const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');
const { MetabotStore } = require('../dist-electron/main/metabotStore.js');
const { GroupTaskStore } = require('../dist-electron/main/groupTaskStore.js');
const { OrchestrationStore } = require('../dist-electron/main/orchestrationStore.js');
const { MetaIDExperienceStore } = require('../dist-electron/main/metaidExperienceStore.js');
const { MetaIDImpressionStore } = require('../dist-electron/main/metaidImpressionStore.js');
const { CoworkStore } = require('../dist-electron/main/coworkStore.js');
const { GroupTaskOrchestrationBridge } = require('../dist-electron/main/services/groupTaskOrchestrationBridge.js');
const groupTaskService = require('../dist-electron/main/services/groupTaskService.js');
const impressionService = require('../dist-electron/main/services/openTeamImpressionService.js');

Module._load = originalLoad;

const {
  closeGroupTask,
  reopenGroupTask,
  setGroupTaskServiceMetabotStoreGetter,
  setGroupTaskServiceGroupTaskStoreGetter,
  setGroupTaskServiceOrchestrationBridgeGetter,
  setGroupTaskServiceKvStoreGetter,
  setGroupTaskServiceCoworkStoreGetter,
  setGroupTaskServiceTransport,
  resetGroupTaskServiceTransport,
} = groupTaskService;

const { setOpenTeamImpressionServiceDepsGetter } = impressionService;

const GROUP_ID = 'aaaaaaaabbbbbbbbccccccccddddddddeeeeeeeeffffffff00000000i0';
// Valid GlobalMetaID format (the impression store validates the shape; the
// task-side ids above are free-form). Same constants as
// openTeamImpressionService.test.mjs.
const CHAIR = 'idq1chair00000000000000000000000000000000';
const WORKER = 'idq1worker000000000000000000000000000000';
const REMOTE_A = 'idq1remotea00000000000000000000000000000';

const makeTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-p0b-accept-gate-'));

const insertWallet = (db, id) => {
  db.run(
    `INSERT INTO metabot_wallets (id, mnemonic, path, created_at)
     VALUES (?, ?, ?, ?)`,
    [id, `abandon ability able about above absent absorb abstract absurd abuse access accident ${id}`, "m/44'/10001'/0'/0/0", 1700000000000 + id],
  );
};

const insertMetabot = (db, { id, walletId, name, type = 'worker', globalmetaid = null, bossGmid = null }) => {
  db.run(
    `INSERT INTO metabots (
      id, wallet_id, mvc_address, btc_address, doge_address, public_key, chat_public_key,
      name, enabled, metaid, globalmetaid, metabot_type, created_by, role, soul,
      boss_global_metaid, allow_chat_skills, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, walletId, `mvc-${id}`, `btc-${id}`, `doge-${id}`, `public-${id}`, `chat-public-${id}`,
      name, 1, `metaid-${id}`, globalmetaid, type, '0000', `${name} role`, `${name} soul`,
      bossGmid, null, 1700000000000 + id, 1700000000000 + id,
    ],
  );
};

const createHarness = async ({ withBridge = true } = {}) => {
  const tempDir = makeTempDir();
  const store = await SqliteStore.create(tempDir);
  const db = store.getDatabase();
  const metabotStore = new MetabotStore(db, store.getSaveFunction());
  const groupTaskStore = new GroupTaskStore(db, store.getSaveFunction());
  const orchestrationStore = new OrchestrationStore(db, store.getSaveFunction());
  const experienceStore = new MetaIDExperienceStore(db, store.getSaveFunction());
  const impressionStore = new MetaIDImpressionStore(db, store.getSaveFunction());
  const coworkStore = new CoworkStore(db, () => {});

  insertWallet(db, 1);
  // bossGmid binds the owner GlobalMetaID — ensureCanonicalTask derives the
  // canonical card's owner from the chair twin's boss binding.
  insertMetabot(db, { id: 1, walletId: 1, name: 'Twin Bot', type: 'twin', globalmetaid: CHAIR, bossGmid: 'gmid-boss' });
  insertMetabot(db, { id: 2, walletId: 1, name: 'Coder Bot', globalmetaid: WORKER });

  const bridge = new GroupTaskOrchestrationBridge({
    groupTaskStore,
    orchestrationStore,
    getMetabotById: (id) => metabotStore.getMetabotById(id),
  });

  const sends = [];
  setGroupTaskServiceMetabotStoreGetter(() => metabotStore);
  setGroupTaskServiceGroupTaskStoreGetter(() => groupTaskStore);
  setGroupTaskServiceOrchestrationBridgeGetter(withBridge ? () => bridge : null);
  setGroupTaskServiceKvStoreGetter(() => store);
  setGroupTaskServiceCoworkStoreGetter(() => coworkStore);
  setGroupTaskServiceTransport({
    createGroupChat: async () => ({ groupId: GROUP_ID, pinId: GROUP_ID }),
    joinGroupChat: async (metabotId) => ({ pinId: `join-pin-${metabotId}` }),
    joinGroupChatAsIdentity: async () => ({ pinId: 'owner-join-pin' }),
    sendGroupChatMessage: async (metabotId, groupId, opts) => {
      sends.push({ metabotId, groupId, content: opts?.content ?? '' });
      return { pinId: `send-pin-${sends.length}` };
    },
    sendGroupChatMessageAsIdentity: async () => ({ pinId: 'identity-send-pin' }),
    waitForGroupIndexed: async () => true,
  });

  const wireImpressionDeps = () => setOpenTeamImpressionServiceDepsGetter(() => ({
    groupTaskStore,
    experienceStore,
    impressionStore,
    getMetabotById: (id) => metabotStore.getMetabotById(id),
    now: () => 1_800_000_000_000,
  }));

  // group_tasks.group_id is UNIQUE — every task in one harness needs its own
  // group id (same shape: 64 hex chars + 'i0').
  const createTask = (status = 'review', groupId = GROUP_ID) => {
    const task = groupTaskStore.createTask({
      groupId, title: 'Build MetaApp', goal: 'Ship the intro MetaApp',
      chairMetabotId: 1, createdBy: 'user',
    });
    groupTaskStore.addMember({ taskId: task.id, metabotId: 1, globalmetaid: CHAIR, role: 'chair' });
    groupTaskStore.addMember({ taskId: task.id, metabotId: 2, globalmetaid: WORKER, role: 'worker' });
    if (status !== 'planning') {
      groupTaskStore.updateTaskStatus(task.id, 'executing', { actor: { kind: 'chair' } });
      if (status !== 'executing') {
        groupTaskStore.updateTaskStatus(task.id, status, { actor: { kind: 'chair' } });
      }
    }
    return task;
  };

  const addRemoteWorker = (taskId) => {
    groupTaskStore.addMember({ taskId, metabotId: null, globalmetaid: REMOTE_A, role: 'worker', displayName: 'Remote Bot A' });
  };

  const pendingDeliverable = (taskId, authorGlobalmetaid = WORKER, uri = 'metaapp://p0b-gate') =>
    groupTaskStore.addDeliverable({ taskId, msgPinId: null, authorGlobalmetaid, kind: 'metaapp', uri });

  const verdictObservations = (subject) =>
    impressionStore.listObservations({ observerGlobalMetaID: CHAIR, subjectGlobalMetaID: subject })
      .filter((observation) => observation.idempotencyKey?.startsWith('openteam:deliverable-verdict:'));

  const closeAnnouncements = () => sends.filter((send) => /^\[STATUS:/.test(send.content));

  return {
    store, db, metabotStore, groupTaskStore, orchestrationStore, experienceStore, impressionStore,
    bridge, sends, createTask, addRemoteWorker, pendingDeliverable, wireImpressionDeps,
    verdictObservations, closeAnnouncements,
    cleanup: () => {
      setOpenTeamImpressionServiceDepsGetter(null);
      setGroupTaskServiceOrchestrationBridgeGetter(null);
      resetGroupTaskServiceTransport();
      store.close();
    },
  };
};

// ---------------------------------------------------------------------------
// 1+2: chair close lands 'delivered'; owner close lands 'accepted'
// ---------------------------------------------------------------------------

test('P0-b: chair close flips pending deliverables to delivered (never accepted) and announces the chair wording', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask('review');
    const first = h.pendingDeliverable(task.id);
    const second = h.pendingDeliverable(task.id, WORKER, 'metaapp://p0b-gate-2');

    const closed = await closeGroupTask(task.id, {
      status: 'done',
      actor: { kind: 'chair' },
      closureNote: 'chair closed on behalf of the owner; owner acceptance pending',
    });
    assert.equal(closed.status, 'done');

    const rows = h.groupTaskStore.listDeliverables(task.id);
    assert.ok(rows.length >= 2);
    for (const row of [first, second]) {
      const fresh = rows.find((item) => item.id === row.id);
      assert.equal(fresh.status, 'delivered', 'chair close lands delivered');
      assert.notEqual(fresh.status, 'accepted', 'chair close never writes accepted');
    }

    const announcements = h.closeAnnouncements();
    assert.equal(announcements.length, 1, 'exactly one close-out announcement');
    assert.ok(
      announcements[0].content.includes('closed by the chair on behalf of the owner; owner acceptance pending'),
      'chair close-out carries the on-behalf wording',
    );
    assert.ok(
      !announcements[0].content.includes('accepted by the owner'),
      'chair close-out never claims owner acceptance',
    );

    // delivered rows keep the member readout honest: the author settles to
    // done (the delivered||accepted filter in getGroupTask).
    const coder = closed.members.find((member) => member.metabotId === 2);
    assert.equal(coder.status, 'done', 'delivered rows still settle the author member');
  } finally {
    h.cleanup();
  }
});

test('P0-b: owner close keeps flipping pending deliverables to accepted (owner wording announcement)', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask('review');
    const deliverable = h.pendingDeliverable(task.id);

    const closed = await closeGroupTask(task.id, { status: 'done', actor: { kind: 'owner' } });
    assert.equal(closed.status, 'done');
    const fresh = h.groupTaskStore.listDeliverables(task.id).find((item) => item.id === deliverable.id);
    assert.equal(fresh.status, 'accepted', 'owner close lands accepted');

    const announcements = h.closeAnnouncements();
    assert.equal(announcements.length, 1);
    assert.ok(
      announcements[0].content.includes('accepted by the owner'),
      'owner close keeps the acceptance wording',
    );
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 3: no-actor accept (syncStatus done-branch / heal shape) lands delivered
// ---------------------------------------------------------------------------

test('P0-b: a no-actor accept (system-mediated sync/heal shape) lands delivered, not accepted', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask('review');
    const deliverable = h.pendingDeliverable(task.id);

    const accepted = h.bridge.acceptGroupTask(task.id);
    assert.equal(accepted.groupTask.status, 'done');
    const fresh = h.groupTaskStore.listDeliverables(task.id).find((item) => item.id === deliverable.id);
    assert.equal(fresh.status, 'delivered', 'no actor means no owner verdict on the ledger');
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 4: the acceptance verdict impression is owner-only
// ---------------------------------------------------------------------------

test('P0-b: verdict impression — owner close records it for the remote author, chair close records none', async () => {
  const h = await createHarness();
  try {
    // Chair close on task 1: delivered rows, NO acceptance verdict impression.
    const chairTask = h.createTask('review');
    h.addRemoteWorker(chairTask.id);
    const chairRow = h.pendingDeliverable(chairTask.id, REMOTE_A, 'metaapp://p0b-remote-chair');
    h.wireImpressionDeps();
    await closeGroupTask(chairTask.id, { status: 'done', actor: { kind: 'chair' } });
    assert.equal(
      h.verdictObservations(REMOTE_A).length, 0,
      'chair close writes no acceptance verdict impression',
    );
    const chairFresh = h.groupTaskStore.listDeliverables(chairTask.id).find((item) => item.id === chairRow.id);
    assert.equal(chairFresh.status, 'delivered');

    // Owner close on task 2 (own group id — group_id is UNIQUE): accepted row
    // + exactly one verdict impression.
    const ownerTask = h.createTask('review', 'd'.repeat(64) + 'i0');
    h.addRemoteWorker(ownerTask.id);
    const ownerRow = h.pendingDeliverable(ownerTask.id, REMOTE_A, 'metaapp://p0b-remote-owner');
    await closeGroupTask(ownerTask.id, { status: 'done', actor: { kind: 'owner' } });
    const verdicts = h.verdictObservations(REMOTE_A);
    assert.equal(verdicts.length, 1, 'owner acceptance records the remote-author verdict impression');
    assert.equal(
      verdicts[0].idempotencyKey,
      `openteam:deliverable-verdict:${ownerTask.id}:deliverable:${ownerRow.id}:accepted`,
    );
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 5: reopen (either actor) never writes deliverable statuses
// ---------------------------------------------------------------------------

test('P0-b: reopen (chair and owner actors) leaves deliverable rows untouched — no accepted write anywhere', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask('review');
    const deliverable = h.pendingDeliverable(task.id);
    h.groupTaskStore.updateDeliverableStatus(deliverable.id, 'delivered');

    const reopened = await reopenGroupTask(task.id, { actor: { kind: 'chair' } });
    assert.equal(reopened.status, 'executing');
    assert.equal(reopened.statusEvents[0].actorKind, 'chair');
    let fresh = h.groupTaskStore.listDeliverables(task.id).find((item) => item.id === deliverable.id);
    assert.equal(fresh.status, 'delivered', 'chair reopen leaves the row delivered');

    h.groupTaskStore.updateTaskStatus(task.id, 'review', { actor: { kind: 'chair' } });
    await reopenGroupTask(task.id, { actor: { kind: 'owner' } });
    fresh = h.groupTaskStore.listDeliverables(task.id).find((item) => item.id === deliverable.id);
    assert.equal(fresh.status, 'delivered', 'owner reopen leaves the row delivered');
    assert.ok(
      h.groupTaskStore.listDeliverables(task.id).every((row) => row.status !== 'accepted'),
      'reopen never lands accepted',
    );
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 6: no-bridge fallback close never touches deliverables
// ---------------------------------------------------------------------------

test('P0-b: the no-bridge fallback close leaves deliverables pending (no flip at all)', async () => {
  const h = await createHarness({ withBridge: false });
  try {
    const task = h.createTask('review');
    const deliverable = h.pendingDeliverable(task.id);

    const closed = await closeGroupTask(task.id, { status: 'done', actor: { kind: 'chair' } });
    assert.equal(closed.status, 'done');
    const fresh = h.groupTaskStore.listDeliverables(task.id).find((item) => item.id === deliverable.id);
    assert.equal(fresh.status, 'pending', 'the fallback path never flips deliverable statuses');
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 7: heal sweep is a system catch-up — lands delivered
// ---------------------------------------------------------------------------

test('P0-b: healAcceptedGroupTaskCards (system catch-up) lands deliverables delivered, not accepted', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask('review');
    const deliverable = h.pendingDeliverable(task.id);
    const canonical = h.bridge.ensureCanonicalTask(task.id);
    // The owner closed the canonical card (acceptance happened there); the
    // group task lagged behind in review.
    h.orchestrationStore.recordClosure(canonical.id, { conclusion: null, by: 'owner' });

    const report = h.bridge.healAcceptedGroupTaskCards();
    assert.deepEqual(report.healed, [{ groupTaskId: task.id, canonicalTaskId: canonical.id }]);
    assert.equal(h.groupTaskStore.getTaskById(task.id).status, 'done');
    const fresh = h.groupTaskStore.listDeliverables(task.id).find((item) => item.id === deliverable.id);
    assert.equal(fresh.status, 'delivered', 'the system heal is not an owner verdict');
  } finally {
    h.cleanup();
  }
});
