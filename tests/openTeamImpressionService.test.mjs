import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import Module from 'node:module';

const require = createRequire(import.meta.url);

// groupTaskService -> groupChatTransport -> metaidCore imports electron; mock it.
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
const { recordMetaIDGroupTaskExperience } = require('../dist-electron/main/services/metaidExperienceRecorder.js');
const groupTaskService = require('../dist-electron/main/services/groupTaskService.js');
const { GroupTaskOrchestrationBridge } = require('../dist-electron/main/services/groupTaskOrchestrationBridge.js');
const impressionService = require('../dist-electron/main/services/openTeamImpressionService.js');

Module._load = originalLoad;

const {
  createGroupTask,
  closeGroupTask,
  kickGroupTaskMember,
  setGroupTaskServiceMetabotStoreGetter,
  setGroupTaskServiceGroupTaskStoreGetter,
  setGroupTaskServiceOrchestrationBridgeGetter,
  setGroupTaskServiceKvStoreGetter,
  setGroupTaskServiceTransport,
  resetGroupTaskServiceTransport,
} = groupTaskService;

const {
  recordTaskCloseImpressions,
  recordKickImpression,
  recordDeliverableVerdictImpression,
  setOpenTeamImpressionServiceDepsGetter,
} = impressionService;

const GROUP_ID = 'aaaaaaaabbbbbbbbccccccccddddddddeeeeeeeeffffffff00000000i0';
const CHAIR = 'idq1chair00000000000000000000000000000000';
const WORKER = 'idq1worker000000000000000000000000000000';
const REMOTE_A = 'idq1remotea00000000000000000000000000000';
const REMOTE_B = 'idq1remoteb00000000000000000000000000000';
const OWNER = 'idq1owner00000000000000000000000000000000';
const NOW = 1_800_000_000_000;

const makeTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-openteam-impression-'));

const insertWallet = (db, id) => {
  db.run(
    `INSERT INTO metabot_wallets (id, mnemonic, path, created_at)
     VALUES (?, ?, ?, ?)`,
    [id, `abandon ability able about above absent absorb abstract absurd abuse access accident ${id}`, "m/44'/10001'/0'/0/0", 1700000000000 + id]
  );
};

const insertMetabot = (db, { id, walletId, name, type = 'worker', globalmetaid = null, bossGlobalMetaId = OWNER }) => {
  db.run(
    `INSERT INTO metabots (
      id, wallet_id, mvc_address, btc_address, doge_address, public_key, chat_public_key,
      name, enabled, metaid, globalmetaid, metabot_type, created_by, role, soul,
      boss_global_metaid, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, walletId, `mvc-${id}`, `btc-${id}`, `doge-${id}`, `public-${id}`, `chat-public-${id}`,
      name, 1, `metaid-${id}`, globalmetaid, type, '0000', `${name} role`, `${name} soul`,
      bossGlobalMetaId, 1700000000000 + id, 1700000000000 + id,
    ]
  );
};

const insertMessage = (db, { pinId, groupId = GROUP_ID, senderGmid, senderName, content, suspect = 0 }) => {
  db.run(
    `INSERT INTO group_chat_messages (
      pin_id, group_id, sender_metaid, sender_global_metaid, sender_name,
      protocol, content, chain_timestamp, sender_suspect
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [pinId, groupId, `metaid-${senderName}`, senderGmid, senderName,
      '/protocols/simplegroupchat', content, 1700000000, suspect]
  );
};

/** Mimic the daemon recording group messages into the chair's experience ledger. */
const seedChairExperience = (experienceStore, taskId, remoteGmid, messageCount) => {
  for (let i = 1; i <= messageCount; i += 1) {
    recordMetaIDGroupTaskExperience({
      store: experienceStore,
      ownerGlobalMetaID: CHAIR,
      taskId,
      groupId: GROUP_ID,
      message: {
        id: i,
        pinId: `pin-${remoteGmid}-${i}`,
        senderGlobalMetaID: remoteGmid,
        content: `remote message ${i}`,
        occurredAt: 1700000000 + i,
      },
      participants: [
        { globalMetaID: CHAIR, role: 'chair' },
        { globalMetaID: remoteGmid, role: 'worker' },
      ],
    });
  }
};

/**
 * Core harness: real SqliteStore + all stores, chair twin with a GlobalMetaID
 * (unless chairHasGmid=false), one local worker. Deps getter is left unwired —
 * each test wires it explicitly.
 */
const openHarness = async ({ chairHasGmid = true } = {}) => {
  const store = await SqliteStore.create(makeTempDir());
  const db = store.getDatabase();
  const metabotStore = new MetabotStore(db, store.getSaveFunction());
  const groupTaskStore = new GroupTaskStore(db, store.getSaveFunction());
  const experienceStore = new MetaIDExperienceStore(db, store.getSaveFunction());
  const impressionStore = new MetaIDImpressionStore(db, store.getSaveFunction());

  insertWallet(db, 1);
  insertMetabot(db, {
    id: 1, walletId: 1, name: 'Twin Bot', type: 'twin', globalmetaid: chairHasGmid ? CHAIR : null,
  });
  insertMetabot(db, { id: 2, walletId: 1, name: 'Coder Bot', globalmetaid: WORKER });

  const wireDeps = () => setOpenTeamImpressionServiceDepsGetter(() => ({
    groupTaskStore,
    experienceStore,
    impressionStore,
    getMetabotById: (id) => metabotStore.getMetabotById(id),
    now: () => NOW,
  }));

  /** Spy-wrapped appendObservation for "the hook called the recorder" checks. */
  const spyOnAppend = () => {
    const calls = [];
    const original = impressionStore.appendObservation.bind(impressionStore);
    impressionStore.appendObservation = (input) => {
      calls.push(input);
      return original(input);
    };
    return calls;
  };

  const createTask = (title = 'Build MetaApp') => {
    const task = groupTaskStore.createTask({
      groupId: GROUP_ID, title, goal: 'Build and publish the intro MetaApp',
      chairMetabotId: 1, createdBy: 'user',
    });
    groupTaskStore.addMember({ taskId: task.id, metabotId: 1, globalmetaid: chairHasGmid ? CHAIR : null, role: 'chair' });
    groupTaskStore.addMember({ taskId: task.id, metabotId: 2, globalmetaid: WORKER, role: 'worker' });
    return task;
  };

  return {
    store, db, metabotStore, groupTaskStore, experienceStore, impressionStore,
    wireDeps, spyOnAppend, createTask,
    cleanup: () => {
      setOpenTeamImpressionServiceDepsGetter(null);
      store.close();
    },
  };
};

// ---------------------------------------------------------------------------
// recordTaskCloseImpressions
// ---------------------------------------------------------------------------

test('task close (done): one observation per collaborator (local + remote) with pin facts; idempotent', async () => {
  const h = await openHarness();
  try {
    const task = h.createTask();
    h.groupTaskStore.addMember({ taskId: task.id, metabotId: null, globalmetaid: REMOTE_A, role: 'worker', displayName: 'Remote Bot A' });
    h.groupTaskStore.addMember({ taskId: task.id, metabotId: null, globalmetaid: REMOTE_B, role: 'worker', displayName: 'Remote Bot B' });

    // Remote A: 3 messages, one flagged suspect -> only 2 count. Remote B: none.
    insertMessage(h.db, { pinId: 'pin-a1', senderGmid: REMOTE_A, senderName: 'Remote Bot A', content: 'hi 1' });
    insertMessage(h.db, { pinId: 'pin-a2', senderGmid: REMOTE_A, senderName: 'Remote Bot A', content: 'hi 2' });
    insertMessage(h.db, { pinId: 'pin-a3', senderGmid: REMOTE_A, senderName: 'Remote Bot A', content: 'spoofed', suspect: 1 });
    insertMessage(h.db, { pinId: 'pin-w1', senderGmid: WORKER, senderName: 'Coder Bot', content: 'local chatter' });
    // Remote A: 2 deliverables (1 accepted, 1 pending). Local worker: 1 pending.
    h.groupTaskStore.addDeliverable({ taskId: task.id, msgPinId: 'pin-a1', authorGlobalmetaid: REMOTE_A, kind: 'metaapp', uri: 'metaapp://abc' });
    const second = h.groupTaskStore.addDeliverable({ taskId: task.id, msgPinId: 'pin-a2', authorGlobalmetaid: REMOTE_A, kind: 'web', uri: 'https://example.com/r' });
    h.groupTaskStore.addDeliverable({ taskId: task.id, msgPinId: 'pin-w1', authorGlobalmetaid: WORKER, kind: 'text', uri: null });
    h.groupTaskStore.updateDeliverableStatus(second.id, 'accepted');
    // The daemon already recorded A's 2 messages into the chair's ledger.
    seedChairExperience(h.experienceStore, task.id, REMOTE_A, 2);

    h.wireDeps();
    const result = recordTaskCloseImpressions(task.id, 'done');
    assert.deepEqual(result, { recorded: 3, created: 3, skipped: 0 });

    const observationsA = h.impressionStore.listObservations({ observerGlobalMetaID: CHAIR, subjectGlobalMetaID: REMOTE_A });
    assert.equal(observationsA.length, 1);
    const observationA = observationsA[0];
    assert.match(observationA.observationText, /Collaboration record: group task #\d+ "Build MetaApp" closed with outcome "done"/);
    assert.match(observationA.observationText, /joined as a remote teammate/);
    assert.match(
      observationA.observationText,
      /2 group message\(s\) posted; 2 deliverable\(s\) submitted \(1 accepted, 0 rejected, 1 still pending at close\)/,
    );
    assert.equal(observationA.idempotencyKey, `collab:task-close:${task.id}:${REMOTE_A}`);
    assert.equal(observationA.dimensions.subjectKind, 'collaborator');
    assert.equal(observationA.dimensions.cooperationContext, 'openteam_remote_group_task');
    assert.equal(observationA.dimensions.messageCount, 2);
    assert.equal(observationA.dimensions.deliverablesAccepted, 1);
    assert.ok(observationA.dimensions.collaborationFact?.pinIds?.length > 0);
    assert.ok(observationA.episodeId, 'observation anchored to the chair task episode');
    assert.match(observationA.dreamDate, /^\d{4}-\d{2}-\d{2}$/);

    // Evidence: the lifecycle event + A's 2 message evidences from the ledger.
    const evidence = h.impressionStore.getObservationEvidence(observationA.id);
    assert.equal(evidence.length, 3);
    const episodeEvidence = h.experienceStore.listEvidence(observationA.episodeId);
    const lifecycle = episodeEvidence.find((item) => item.sourceKey === `task:${task.id}:close:done:${REMOTE_A}`);
    assert.ok(lifecycle, 'lifecycle evidence recorded');
    assert.equal(lifecycle.evidenceType, 'group_task_event');
    assert.equal(lifecycle.publisherGlobalMetaID, CHAIR);

    const observationsB = h.impressionStore.listObservations({ observerGlobalMetaID: CHAIR, subjectGlobalMetaID: REMOTE_B });
    assert.equal(observationsB.length, 1);
    assert.match(observationsB[0].observationText, /0 group message\(s\) posted; 0 deliverable\(s\) submitted\./);

    const observationsLocal = h.impressionStore.listObservations({ observerGlobalMetaID: CHAIR, subjectGlobalMetaID: WORKER });
    assert.equal(observationsLocal.length, 1);
    assert.equal(observationsLocal[0].dimensions.cooperationContext, 'local_group_task');
    assert.match(observationsLocal[0].observationText, /joined as a local teammate/);

    // Snapshot rebuilt for immediate candidate-screening reads.
    const snapshot = h.impressionStore.getSnapshot(CHAIR, REMOTE_A);
    assert.ok(snapshot, 'snapshot rebuilt after the observation');
    assert.equal(snapshot.latestObservationId, observationA.id);
    assert.ok(Array.isArray(snapshot.collaborationFacts));
    assert.equal(snapshot.relationshipTemperature, null, 'collaborators do not store temperature');

    // Idempotent: a retry/restart confirms the same rows, writes nothing new.
    const again = recordTaskCloseImpressions(task.id, 'done');
    assert.deepEqual(again, { recorded: 3, created: 0, skipped: 0 });
    assert.equal(h.impressionStore.listObservations({ observerGlobalMetaID: CHAIR, subjectGlobalMetaID: REMOTE_A })[0].id, observationA.id);
    assert.equal(h.impressionStore.listObservations({ observerGlobalMetaID: CHAIR, subjectGlobalMetaID: REMOTE_A }).length, 1);
  } finally {
    h.cleanup();
  }
});

// H-79: a member whose deliverables contributed 55 pin ids produced a 4,642-char
// observationText ("Pins: ${pinIds.join(', ')}" had no cap), which the impression
// store rejected (> 4,000 chars) and the per-subject catch swallowed as
// skipped+=1 — the impression was silently dropped. The close pipeline now
// truncates the pin list constructively instead.
test('H-79 regression: 55 deliverable pins truncate the pin list instead of dropping the impression', async () => {
  const h = await openHarness();
  try {
    const hexPin = (n) => `${n.toString(16).padStart(64, '0')}i0`;
    const seedTask = (title, groupIdSuffix) => {
      const task = h.groupTaskStore.createTask({
        groupId: hexPin(0xd0 + groupIdSuffix), title, goal: 'Build and publish the intro MetaApp',
        chairMetabotId: 1, createdBy: 'user',
      });
      h.groupTaskStore.addMember({ taskId: task.id, metabotId: 1, globalmetaid: CHAIR, role: 'chair' });
      h.groupTaskStore.addMember({ taskId: task.id, metabotId: 2, globalmetaid: WORKER, role: 'worker' });
      h.groupTaskStore.addMember({ taskId: task.id, metabotId: null, globalmetaid: REMOTE_A, role: 'worker', displayName: 'Remote Bot A' });
      for (let i = 0; i < 27; i += 1) {
        h.groupTaskStore.addDeliverable({
          taskId: task.id,
          msgPinId: hexPin(0x100 + i),
          authorGlobalmetaid: REMOTE_A,
          kind: 'metaapp',
          uri: `pin://${hexPin(0x180 + i)}`,
        });
      }
      return task;
    };
    // Pad the head so its fixed part is exactly 904 chars — the ledger
    // signature: 904 + 55*66 + 54*2 = 4,642 chars > MAX_OBSERVATION_TEXT.
    // (First task in a fresh store, so task.id === 1.)
    const stats27 = '0 group message(s) posted; 27 deliverable(s) submitted (0 accepted, 0 rejected, 27 still pending at close).';
    const headPrefix = 'Collaboration record: group task #1 "';
    const headSuffix = '" closed with outcome "done". The subject joined as a remote teammate. Host-recorded participation: ' + stats27;
    const titleLen = 904 - headPrefix.length - headSuffix.length;
    assert.ok(titleLen >= 1, `head padding must allow a non-empty title, got ${titleLen}`);

    const task = seedTask('T'.repeat(titleLen), 0);
    h.wireDeps();
    // 55 pins: group anchor + 27 deliverables x 2 pin tokens.
    const result = recordTaskCloseImpressions(task.id, 'done');
    assert.deepEqual(result, { recorded: 2, created: 2, skipped: 0 });

    const observations = h.impressionStore.listObservations({ observerGlobalMetaID: CHAIR, subjectGlobalMetaID: REMOTE_A });
    assert.equal(observations.length, 1, 'the impression must not be silently dropped');
    const observationText = observations[0].observationText;
    assert.ok(
      observationText.length <= 4000,
      `observationText must fit MAX_OBSERVATION_TEXT, got ${observationText.length}`,
    );
    assert.match(observationText, /… 55 pins in total\./, 'truncated pin list carries the count line');
    assert.ok(observationText.includes(hexPin(0x100)), 'keeps leading pins');
    assert.ok(!observationText.includes(hexPin(0x180 + 26)), 'drops trailing pins');
    // dimensions carry the full pin list for programmatic readers regardless.
    assert.equal(observations[0].dimensions.collaborationFact.pinIds.length, 55);

    // Reverse probe: pad so the FULL text lands at 3,999 chars — one under the
    // limit. If the 904-char head math above were off, this would truncate or
    // exceed the limit and fail (guards the fixture itself).
    // PINS_SECTION = 55*66 joined pins + 54*2 separators + ' Pins: ' + '.'
    const PINS_SECTION = 55 * 66 + 54 * 2 + 8;
    const titleLenUnder = titleLen - (904 + PINS_SECTION - 3999);
    const under = seedTask('U'.repeat(titleLenUnder), 1);
    assert.deepEqual(recordTaskCloseImpressions(under.id, 'done'), { recorded: 2, created: 2, skipped: 0 });
    const underText = h.impressionStore.listObservations({ observerGlobalMetaID: CHAIR, subjectGlobalMetaID: REMOTE_A })
      .find((item) => item.idempotencyKey === `collab:task-close:${under.id}:${REMOTE_A}`).observationText;
    assert.equal(underText.length, 3999, 'full text just under the limit is stored whole');
    assert.ok(!underText.includes('pins in total'), 'no truncation marker under the limit');
  } finally {
    h.cleanup();
  }
});

test('H-79 boundary: observationText of exactly 4000 chars stores whole; one char over truncates pins', async () => {
  const h = await openHarness();
  try {
    const hexPin = (n) => `${n.toString(16).padStart(64, '0')}i0`;
    // Fixed minimal pin set: group anchor + msg pin + plain uri label = 3 pins.
    // Each task gets its own groupId (unique constraint on group_tasks.group_id).
    const seed = (title, groupIdSuffix) => {
      const task = h.groupTaskStore.createTask({
        groupId: hexPin(0xd0 + groupIdSuffix), title, goal: 'Build and publish the intro MetaApp',
        chairMetabotId: 1, createdBy: 'user',
      });
      h.groupTaskStore.addMember({ taskId: task.id, metabotId: 1, globalmetaid: CHAIR, role: 'chair' });
      h.groupTaskStore.addMember({ taskId: task.id, metabotId: 2, globalmetaid: WORKER, role: 'worker' });
      h.groupTaskStore.addMember({ taskId: task.id, metabotId: null, globalmetaid: REMOTE_A, role: 'worker', displayName: 'Remote Bot A' });
      h.groupTaskStore.addDeliverable({ taskId: task.id, msgPinId: hexPin(0xc0), authorGlobalmetaid: REMOTE_A, kind: 'text', uri: 'plain-label' });
      return task;
    };
    h.wireDeps();

    // Probe the fixed overhead once, then pad the title so the untruncated
    // text lands exactly on the store limit (4000 = stored, >4000 = rejected).
    const probe = seed('PADTITLE', 0);
    assert.deepEqual(recordTaskCloseImpressions(probe.id, 'done'), { recorded: 2, created: 2, skipped: 0 });
    const probeText = h.impressionStore.listObservations({ observerGlobalMetaID: CHAIR, subjectGlobalMetaID: REMOTE_A })[0].observationText;
    const padLength = 4000 - probeText.length + 'PADTITLE'.length;
    assert.ok(padLength >= 1, `padding budget must be positive, got ${padLength}`);

    const exact = seed('E'.repeat(padLength), 1);
    assert.deepEqual(recordTaskCloseImpressions(exact.id, 'done'), { recorded: 2, created: 2, skipped: 0 });
    const exactText = h.impressionStore.listObservations({ observerGlobalMetaID: CHAIR, subjectGlobalMetaID: REMOTE_A })
      .find((item) => item.idempotencyKey === `collab:task-close:${exact.id}:${REMOTE_A}`).observationText;
    assert.equal(exactText.length, 4000, 'exactly at the limit the text is stored whole');
    assert.ok(!exactText.includes('pins in total'), 'no truncation marker at the boundary');

    const over = seed('F'.repeat(padLength + 1), 2);
    assert.deepEqual(recordTaskCloseImpressions(over.id, 'done'), { recorded: 2, created: 2, skipped: 0 });
    const overText = h.impressionStore.listObservations({ observerGlobalMetaID: CHAIR, subjectGlobalMetaID: REMOTE_A })
      .find((item) => item.idempotencyKey === `collab:task-close:${over.id}:${REMOTE_A}`).observationText;
    assert.ok(overText.length <= 4000, `over-limit close still records within budget, got ${overText.length}`);
    assert.match(overText, /… 3 pins in total\./, 'one char over the boundary truncates the pin list');
  } finally {
    h.cleanup();
  }
});

test('task close (cancelled): reason recorded; member kicked before close is noted', async () => {
  const h = await openHarness();
  try {
    const task = h.createTask('Weekly digest');
    h.groupTaskStore.addMember({ taskId: task.id, metabotId: null, globalmetaid: REMOTE_A, role: 'worker', displayName: 'Remote Bot A' });
    h.groupTaskStore.markMemberRemoved({ taskId: task.id, globalmetaid: REMOTE_A, removePinId: 'pin-remove-a' });

    h.wireDeps();
    const result = recordTaskCloseImpressions(task.id, 'cancelled', 'owner changed priorities');
    assert.deepEqual(result, { recorded: 2, created: 2, skipped: 0 });

    const [observation] = h.impressionStore.listObservations({ observerGlobalMetaID: CHAIR, subjectGlobalMetaID: REMOTE_A });
    assert.match(observation.observationText, /closed with outcome "cancelled" \(recorded reason: "owner changed priorities"\)/);
    assert.match(observation.observationText, /had been removed from the task before it closed/);
    assert.equal(observation.dimensions.outcome, 'cancelled');
    assert.equal(observation.dimensions.removedBeforeClose, true);
    // fix-v2 P2-6: an owner-priority cancel has no host-fault signal — the
    // fact carries no attribution (scoring treats it as member-attributed).
    assert.equal(observation.dimensions.collaborationFact.attribution, undefined);
  } finally {
    h.cleanup();
  }
});

test('fix-v2 P2-6: task close (cancelled) derives host attribution from supervisor fault signals', async () => {
  const h = await openHarness();
  try {
    const task = h.createTask('Host fault digest');
    h.groupTaskStore.addMember({ taskId: task.id, metabotId: null, globalmetaid: REMOTE_A, role: 'worker', displayName: 'Remote Bot A' });
    h.groupTaskStore.addSupervisorSignal({ taskId: task.id, kind: 'flag', note: 'host LLM outage stalled the task', createdBy: 'owner' });
    h.wireDeps();
    const derived = recordTaskCloseImpressions(task.id, 'cancelled', 'host outage');
    assert.ok(derived.recorded >= 1);
    const [obsA] = h.impressionStore.listObservations({ observerGlobalMetaID: CHAIR, subjectGlobalMetaID: REMOTE_A });
    assert.equal(obsA.dimensions.collaborationFact.attribution, 'host', 'supervisor flag derives host attribution');
    // The attribution survives the snapshot rebuild (parse whitelist round-trip).
    const snapshot = h.impressionStore.getSnapshot(CHAIR, REMOTE_A);
    const fact = snapshot.collaborationFacts.find((row) => row.taskId === task.id);
    assert.equal(fact?.attribution, 'host', 'attribution survives collectCollaborationFacts');
  } finally {
    h.cleanup();
  }
});

test('fix-v2 P2-6: task close (cancelled) honors an explicit caller attribution', async () => {
  const h = await openHarness();
  try {
    const task = h.createTask('Explicit host cancel');
    h.groupTaskStore.addMember({ taskId: task.id, metabotId: null, globalmetaid: REMOTE_B, role: 'worker', displayName: 'Remote Bot B' });
    h.wireDeps();
    recordTaskCloseImpressions(task.id, 'cancelled', 'runtime crash', { attribution: 'host' });
    const [obsB] = h.impressionStore.listObservations({ observerGlobalMetaID: CHAIR, subjectGlobalMetaID: REMOTE_B });
    assert.equal(obsB.dimensions.collaborationFact.attribution, 'host', 'explicit attribution recorded');
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// recordKickImpression
// ---------------------------------------------------------------------------

test('kick: remote member gets a negative observation with the reason; idempotent; local member skipped', async () => {
  const h = await openHarness();
  try {
    const task = h.createTask();
    h.groupTaskStore.addMember({ taskId: task.id, metabotId: null, globalmetaid: REMOTE_A, role: 'worker', displayName: 'Remote Bot A' });
    h.groupTaskStore.markMemberRemoved({ taskId: task.id, globalmetaid: REMOTE_A, removePinId: 'pin-remove-a' });

    h.wireDeps();
    const result = recordKickImpression(task.id, REMOTE_A, 'off-topic output');
    assert.deepEqual(result, { recorded: 1, created: 1, skipped: 0 });

    const [observation] = h.impressionStore.listObservations({ observerGlobalMetaID: CHAIR, subjectGlobalMetaID: REMOTE_A });
    assert.equal(
      observation.observationText,
      `OpenTeam moderation record: the subject was removed (kicked) from group task `
      + `#${task.id} "Build MetaApp" by the observer side. Recorded reason: "off-topic output".`,
    );
    assert.equal(observation.dimensions.subjectKind, 'collaborator');
    assert.equal(observation.dimensions.weakSeat, 'unspecified');
    assert.equal(observation.dimensions.relationshipTemperature, undefined);
    assert.equal(observation.dimensions.collaborationFact.outcome, 'kicked');
    assert.equal(observation.idempotencyKey, `openteam:kick:${task.id}:${REMOTE_A}`);

    const again = recordKickImpression(task.id, REMOTE_A, 'off-topic output');
    assert.deepEqual(again, { recorded: 1, created: 0, skipped: 0 });
    assert.equal(h.impressionStore.listObservations({ observerGlobalMetaID: CHAIR, subjectGlobalMetaID: REMOTE_A }).length, 1);

    // Local member: covered by the experience pipeline, no impression written.
    assert.deepEqual(recordKickImpression(task.id, WORKER, 'x'), { recorded: 0, created: 0, skipped: 0 });
    assert.equal(h.impressionStore.listObservations({ observerGlobalMetaID: CHAIR, subjectGlobalMetaID: WORKER }).length, 0);
    // Unknown identity: no member row -> skip.
    assert.deepEqual(recordKickImpression(task.id, 'idq1stranger0000000000000000000000000', 'x'), { recorded: 0, created: 0, skipped: 0 });
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// recordDeliverableVerdictImpression
// ---------------------------------------------------------------------------

test('deliverable verdict: remote author accepted/rejected recorded; local author skipped; idempotent', async () => {
  const h = await openHarness();
  try {
    const task = h.createTask();
    h.groupTaskStore.addMember({ taskId: task.id, metabotId: null, globalmetaid: REMOTE_A, role: 'worker', displayName: 'Remote Bot A' });
    const acceptedDeliverable = h.groupTaskStore.addDeliverable({ taskId: task.id, msgPinId: 'pin-a1', authorGlobalmetaid: REMOTE_A, kind: 'metaapp', uri: 'metaapp://abc' });
    const rejectedDeliverable = h.groupTaskStore.addDeliverable({ taskId: task.id, msgPinId: 'pin-a2', authorGlobalmetaid: REMOTE_A, kind: 'web', uri: 'https://example.com/bad' });
    h.groupTaskStore.updateDeliverableStatus(acceptedDeliverable.id, 'accepted');
    h.groupTaskStore.updateDeliverableStatus(rejectedDeliverable.id, 'rejected');

    h.wireDeps();
    const accepted = recordDeliverableVerdictImpression(task.id, REMOTE_A, 'accepted', 'metaapp://abc');
    assert.deepEqual(accepted, { recorded: 1, created: 1, skipped: 0 });
    const rejected = recordDeliverableVerdictImpression(task.id, REMOTE_A, 'rejected', 'https://example.com/bad');
    assert.deepEqual(rejected, { recorded: 1, created: 1, skipped: 0 });

    const observations = h.impressionStore.listObservations({ observerGlobalMetaID: CHAIR, subjectGlobalMetaID: REMOTE_A });
    assert.equal(observations.length, 2, 'one observation per deliverable verdict');
    const acceptedObservation = observations.find((item) => item.dimensions.verdict === 'accepted');
    const rejectedObservation = observations.find((item) => item.dimensions.verdict === 'rejected');
    assert.ok(acceptedObservation && rejectedObservation);
    assert.equal(
      acceptedObservation.observationText,
      `OpenTeam delivery record: the subject's metaapp deliverable (metaapp://abc) in group task `
      + `#${task.id} "Build MetaApp" was accepted by the observer side.`,
    );
    assert.equal(acceptedObservation.dimensions.subjectKind, 'collaborator');
    assert.equal(acceptedObservation.dimensions.collaborationFact.outcome, 'deliverable_accepted');
    assert.equal(acceptedObservation.dimensions.relationshipTemperature, undefined);
    assert.equal(acceptedObservation.dimensions.deliverableId, acceptedDeliverable.id);
    assert.equal(
      acceptedObservation.idempotencyKey,
      `openteam:deliverable-verdict:${task.id}:deliverable:${acceptedDeliverable.id}:accepted`,
    );
    assert.equal(rejectedObservation.dimensions.weakSeat, 'unspecified');
    assert.equal(rejectedObservation.dimensions.collaborationFact.outcome, 'deliverable_rejected');
    assert.equal(rejectedObservation.dimensions.relationshipTemperature, undefined);
    assert.match(rejectedObservation.observationText, /was rejected by the observer side\./);

    // Idempotent per (deliverable, verdict).
    assert.deepEqual(recordDeliverableVerdictImpression(task.id, REMOTE_A, 'accepted', 'metaapp://abc'), { recorded: 1, created: 0, skipped: 0 });
    assert.equal(h.impressionStore.listObservations({ observerGlobalMetaID: CHAIR, subjectGlobalMetaID: REMOTE_A }).length, 2);

    // Local author: skipped (canonical attempt projection + dream pipeline cover it).
    h.groupTaskStore.addDeliverable({ taskId: task.id, msgPinId: 'pin-w1', authorGlobalmetaid: WORKER, kind: 'text', uri: null });
    assert.deepEqual(recordDeliverableVerdictImpression(task.id, WORKER, 'accepted', null), { recorded: 0, created: 0, skipped: 0 });
    assert.equal(h.impressionStore.listObservations({ observerGlobalMetaID: CHAIR, subjectGlobalMetaID: WORKER }).length, 0);
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Silent-skip guards
// ---------------------------------------------------------------------------

test('observer (twin chair) without a GlobalMetaID: all recorders silently skip', async () => {
  const h = await openHarness({ chairHasGmid: false });
  try {
    const task = h.createTask();
    h.groupTaskStore.addMember({ taskId: task.id, metabotId: null, globalmetaid: REMOTE_A, role: 'worker', displayName: 'Remote Bot A' });
    h.groupTaskStore.addDeliverable({ taskId: task.id, msgPinId: 'pin-a1', authorGlobalmetaid: REMOTE_A, kind: 'metaapp', uri: 'metaapp://abc' });

    h.wireDeps();
    assert.deepEqual(recordTaskCloseImpressions(task.id, 'done'), { recorded: 0, created: 0, skipped: 0 });
    assert.deepEqual(recordKickImpression(task.id, REMOTE_A, 'x'), { recorded: 0, created: 0, skipped: 0 });
    assert.deepEqual(recordDeliverableVerdictImpression(task.id, REMOTE_A, 'accepted', 'metaapp://abc'), { recorded: 0, created: 0, skipped: 0 });
    assert.equal(h.impressionStore.listObservations({ observerGlobalMetaID: REMOTE_A, subjectGlobalMetaID: REMOTE_B }).length, 0);
  } finally {
    h.cleanup();
  }
});

test('deps unwired: recorders no-op without throwing', async () => {
  const h = await openHarness();
  try {
    const task = h.createTask();
    setOpenTeamImpressionServiceDepsGetter(null);
    assert.deepEqual(recordTaskCloseImpressions(task.id, 'done'), { recorded: 0, created: 0, skipped: 0 });
    assert.deepEqual(recordKickImpression(task.id, REMOTE_A, 'x'), { recorded: 0, created: 0, skipped: 0 });
    assert.deepEqual(recordDeliverableVerdictImpression(task.id, REMOTE_A, 'accepted', 'u'), { recorded: 0, created: 0, skipped: 0 });
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Hook points (groupTaskService / orchestration bridge call the recorders)
// ---------------------------------------------------------------------------

/** Service harness with mocked transport (same pattern as groupTaskKickMember tests). */
const createServiceHarness = async () => {
  const h = await openHarness();
  const calls = { remove: [], send: [] };
  setGroupTaskServiceMetabotStoreGetter(() => h.metabotStore);
  setGroupTaskServiceGroupTaskStoreGetter(() => h.groupTaskStore);
  setGroupTaskServiceKvStoreGetter(() => h.store);
  setGroupTaskServiceOrchestrationBridgeGetter(null);
  setGroupTaskServiceTransport({
    createGroupChat: async () => ({ groupId: GROUP_ID, pinId: GROUP_ID }),
    joinGroupChat: async (metabotId) => ({ pinId: `join-pin-${metabotId}` }),
    joinGroupChatAsIdentity: async () => ({ pinId: 'owner-join-pin' }),
    waitForGroupIndexed: async () => true,
    removeGroupChatMember: async (metabotId, groupId, opts) => {
      calls.remove.push({ metabotId, groupId, opts });
      return { pinId: `remove-pin-${calls.remove.length}` };
    },
    sendGroupChatMessage: async () => ({ pinId: 'msg-pin' }),
    getMetaIdDetail: async () => ({ metaId: 'metaid-remote-legacy' }),
    // R2P1-2/P1-2 seams: member-list re-check confirms immediately, no network.
    fetchGroupMembers: async () => [],
    kickConfirmPollIntervalMs: 1,
    kickConfirmMaxAttempts: 2,
  });
  return {
    ...h,
    calls,
    cleanup: () => {
      setGroupTaskServiceOrchestrationBridgeGetter(null);
      resetGroupTaskServiceTransport();
      h.cleanup();
    },
  };
};

test('hook closeGroupTask: close sediments impressions for remote members; recorder failure never blocks the close', async () => {
  const h = await createServiceHarness();
  try {
    const detail = await createGroupTask({
      title: 'Build MetaApp',
      goal: 'Build and publish the intro MetaApp',
      memberMetabotIds: [2],
      createdBy: 'user',
    });
    h.groupTaskStore.addMember({ taskId: detail.id, metabotId: null, globalmetaid: REMOTE_A, role: 'worker', displayName: 'Remote Bot A' });
    h.wireDeps();
    const appendCalls = h.spyOnAppend();

    const closed = await closeGroupTask(detail.id, { status: 'done' });
    assert.equal(closed.status, 'done');
    assert.equal(appendCalls.length, 2, 'close sediments local and remote collaborators');
    const subjects = appendCalls.map((call) => call.subjectGlobalMetaID).sort();
    assert.deepEqual(subjects, [REMOTE_A, WORKER].sort());
    assert.ok(appendCalls.every((call) => call.observerGlobalMetaID === CHAIR));
    assert.ok(appendCalls.some((call) => call.idempotencyKey === `collab:task-close:${detail.id}:${REMOTE_A}`));
    assert.equal(h.impressionStore.listObservations({ observerGlobalMetaID: CHAIR, subjectGlobalMetaID: REMOTE_A }).length, 1);
    assert.equal(h.impressionStore.listObservations({ observerGlobalMetaID: CHAIR, subjectGlobalMetaID: WORKER }).length, 1);

    // Best-effort: a broken deps getter must not block an (idempotent) re-close.
    setOpenTeamImpressionServiceDepsGetter(() => { throw new Error('deps down'); });
    const reclosed = await closeGroupTask(detail.id, { status: 'done' });
    assert.equal(reclosed.status, 'done');
  } finally {
    h.cleanup();
  }
});

test('hook kickGroupTaskMember: kicking a remote member sediments a kick impression; kicking a local member does not', async () => {
  const h = await createServiceHarness();
  try {
    const detail = await createGroupTask({
      title: 'Build MetaApp',
      goal: 'Build and publish the intro MetaApp',
      memberMetabotIds: [2],
      createdBy: 'user',
    });
    h.groupTaskStore.addMember({ taskId: detail.id, metabotId: null, globalmetaid: REMOTE_A, role: 'worker', displayName: 'Remote Bot A' });
    h.wireDeps();
    const appendCalls = h.spyOnAppend();

    await kickGroupTaskMember({ taskId: detail.id, globalmetaid: REMOTE_A, reason: 'no response' });
    assert.equal(appendCalls.length, 1, 'recorder invoked through the kick hook');
    assert.equal(appendCalls[0].subjectGlobalMetaID, REMOTE_A);
    const [observation] = h.impressionStore.listObservations({ observerGlobalMetaID: CHAIR, subjectGlobalMetaID: REMOTE_A });
    assert.match(observation.observationText, /removed \(kicked\)/);
    assert.match(observation.observationText, /Recorded reason: "no response"\./);

    await kickGroupTaskMember({ taskId: detail.id, metabotId: 2 });
    assert.equal(appendCalls.length, 1, 'local kicks never reach the impression ledger');
    assert.equal(h.impressionStore.listObservations({ observerGlobalMetaID: CHAIR, subjectGlobalMetaID: WORKER }).length, 0);
  } finally {
    h.cleanup();
  }
});

test('hook bridge acceptGroupTask: pending deliverables accepted; verdict impressions only for remote authors', async () => {
  const h = await openHarness();
  try {
    const orchestrationStore = new OrchestrationStore(h.db, h.store.getSaveFunction());
    const bridge = new GroupTaskOrchestrationBridge({
      groupTaskStore: h.groupTaskStore,
      orchestrationStore,
      getMetabotById: (id) => h.metabotStore.getMetabotById(id),
    });
    const task = h.createTask();
    h.groupTaskStore.addMember({ taskId: task.id, metabotId: null, globalmetaid: REMOTE_A, role: 'worker', displayName: 'Remote Bot A' });
    const remoteDeliverable = h.groupTaskStore.addDeliverable({ taskId: task.id, msgPinId: 'pin-a1', authorGlobalmetaid: REMOTE_A, kind: 'metaapp', uri: 'metaapp://abc' });
    const localDeliverable = h.groupTaskStore.addDeliverable({ taskId: task.id, msgPinId: 'pin-w1', authorGlobalmetaid: WORKER, kind: 'text', uri: null });
    h.wireDeps();
    const appendCalls = h.spyOnAppend();

    // P0-b (task #149): explicit owner actor — verdict impressions are the
    // OWNER's acceptance record; a no-actor accept no longer flips rows to
    // 'accepted' nor writes impressions.
    const { groupTask } = bridge.acceptGroupTask(task.id, { kind: 'owner' });
    assert.equal(groupTask.status, 'done');
    const deliverables = h.groupTaskStore.listDeliverables(task.id);
    assert.ok(deliverables.every((deliverable) => deliverable.status === 'accepted'), 'all pending deliverables accepted');

    assert.equal(appendCalls.length, 1, 'only the remote author triggers a verdict impression');
    assert.equal(appendCalls[0].subjectGlobalMetaID, REMOTE_A);
    assert.equal(
      appendCalls[0].idempotencyKey,
      `openteam:deliverable-verdict:${task.id}:deliverable:${remoteDeliverable.id}:accepted`,
    );
    const [observation] = h.impressionStore.listObservations({ observerGlobalMetaID: CHAIR, subjectGlobalMetaID: REMOTE_A });
    assert.match(observation.observationText, /was accepted by the observer side\./);
    assert.equal(h.impressionStore.listObservations({ observerGlobalMetaID: CHAIR, subjectGlobalMetaID: WORKER }).length, 0);
    assert.ok(localDeliverable.id !== remoteDeliverable.id);
  } finally {
    h.cleanup();
  }
});

test('deliverable verdict: a kicked remote author earns NO positive impression from a bulk accept', async () => {
  const h = await openHarness();
  try {
    const task = h.createTask();
    h.groupTaskStore.addMember({ taskId: task.id, metabotId: null, globalmetaid: REMOTE_A, role: 'worker', displayName: 'Remote Bot A' });
    const deliverable = h.groupTaskStore.addDeliverable({ taskId: task.id, msgPinId: 'pin-a1', authorGlobalmetaid: REMOTE_A, kind: 'metaapp', uri: 'metaapp://abc' });

    // The author is kicked while the deliverable is still pending.
    h.groupTaskStore.markMemberRemoved({ taskId: task.id, globalmetaid: REMOTE_A, removePinId: 'pin-remove-a' });
    h.groupTaskStore.updateDeliverableStatus(deliverable.id, 'accepted'); // swept up by a bulk accept

    h.wireDeps();
    assert.deepEqual(
      recordDeliverableVerdictImpression(task.id, REMOTE_A, 'accepted', 'metaapp://abc'),
      { recorded: 0, created: 0, skipped: 0 },
      'accepted verdict for a removed author is skipped',
    );
    assert.equal(h.impressionStore.listObservations({ observerGlobalMetaID: CHAIR, subjectGlobalMetaID: REMOTE_A }).length, 0);

    // A rejected verdict on a kicked author's deliverable still records (an
    // explicit negative signal is worth keeping).
    assert.deepEqual(
      recordDeliverableVerdictImpression(task.id, REMOTE_A, 'rejected', 'metaapp://abc'),
      { recorded: 1, created: 1, skipped: 0 },
    );
  } finally {
    h.cleanup();
  }
});

test('hook bridge acceptGroupTask: a kicked remote author\'s swept-up deliverable writes no positive impression', async () => {
  const h = await openHarness();
  try {
    const orchestrationStore = new OrchestrationStore(h.db, h.store.getSaveFunction());
    const bridge = new GroupTaskOrchestrationBridge({
      groupTaskStore: h.groupTaskStore,
      orchestrationStore,
      getMetabotById: (id) => h.metabotStore.getMetabotById(id),
    });
    const task = h.createTask();
    h.groupTaskStore.addMember({ taskId: task.id, metabotId: null, globalmetaid: REMOTE_A, role: 'worker', displayName: 'Remote Bot A' });
    const deliverable = h.groupTaskStore.addDeliverable({ taskId: task.id, msgPinId: 'pin-a1', authorGlobalmetaid: REMOTE_A, kind: 'metaapp', uri: 'metaapp://abc' });
    h.groupTaskStore.markMemberRemoved({ taskId: task.id, globalmetaid: REMOTE_A, removePinId: 'pin-remove-a' });

    h.wireDeps();
    const appendCalls = h.spyOnAppend();
    // P0-b (task #149): explicit owner actor — the bulk-accept sweep below is
    // an owner acceptance; a no-actor accept now lands 'delivered' instead.
    const { groupTask } = bridge.acceptGroupTask(task.id, { kind: 'owner' });
    assert.equal(groupTask.status, 'done');
    assert.equal(
      h.groupTaskStore.listDeliverables(task.id).find((item) => item.id === deliverable.id)?.status,
      'accepted',
      'the pending deliverable is still accepted (status unchanged by the impression gate)',
    );
    assert.equal(appendCalls.length, 0, 'no positive verdict impression for the kicked author');
  } finally {
    h.cleanup();
  }
});
