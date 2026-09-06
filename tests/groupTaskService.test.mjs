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
const { OpenTeamMembershipStore } = require('../dist-electron/main/openTeamMembershipStore.js');
const groupTaskService = require('../dist-electron/main/services/groupTaskService.js');

Module._load = originalLoad;

const {
  createGroupTask,
  proposeGroupTaskStaffing,
  listGroupTasks,
  listGroupTaskSummaries,
  getGroupTask,
  postGroupTaskMessage,
  postGroupTaskMessageAsOwner,
  joinGroupTaskMember,
  closeGroupTask,
  ensureOwnerJoinedGroup,
  setGroupTaskServiceMetabotStoreGetter,
  setGroupTaskServiceGroupTaskStoreGetter,
  setGroupTaskServiceOpenTeamMembershipStoreGetter,
  setGroupTaskServiceOrchestrationBridgeGetter,
  setGroupTaskServiceKvStoreGetter,
  setGroupTaskServiceStaffingSessionMessagesLoader,
  setGroupTaskServiceStaffingIntentJudge,
  setGroupTaskAcceptanceNotifier,
  setGroupTaskServiceTransport,
  resetGroupTaskServiceTransport,
  deriveGroupTaskMemberInviteStatus,
  computeGroupTaskMemberWorkStatus,
} = groupTaskService;
const { GroupTaskStaffingError } = require('../dist-electron/main/services/groupTaskStaffing.js');

const GROUP_ID = 'aaaaaaaabbbbbbbbccccccccddddddddeeeeeeeeffffffff00000000i0';
const CREATE_PIN_ID = GROUP_ID;

const makeTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-group-task-svc-'));

const insertWallet = (db, id) => {
  db.run(
    `INSERT INTO metabot_wallets (id, mnemonic, path, created_at)
     VALUES (?, ?, ?, ?)`,
    [id, `abandon ability able about above absent absorb abstract absurd abuse access accident ${id}`, "m/44'/10001'/0'/0/0", 1700000000000 + id]
  );
};

const insertMetabot = (db, { id, walletId, name, type = 'worker', globalmetaid = null }) => {
  db.run(
    `INSERT INTO metabots (
      id, wallet_id, mvc_address, btc_address, doge_address, public_key, chat_public_key,
      name, enabled, metaid, globalmetaid, metabot_type, created_by, role, soul,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, walletId, `mvc-${id}`, `btc-${id}`, `doge-${id}`, `public-${id}`, `chat-public-${id}`,
      name, 1, `metaid-${id}`, globalmetaid, type, '0000', `${name} role`, `${name} soul`,
      1700000000000 + id, 1700000000000 + id,
    ]
  );
};

/**
 * Harness: real SqliteStore + MetabotStore + GroupTaskStore, mocked transport.
 * state.joinFailures: Set of metabot ids whose joinGroupChat should reject.
 * state.indexed: what waitForGroupIndexed returns.
 */
const createHarness = async (overrides = {}) => {
  const tempDir = makeTempDir();
  const store = await SqliteStore.create(tempDir);
  const db = store.getDatabase();
  const metabotStore = new MetabotStore(db, store.getSaveFunction());
  const groupTaskStore = new GroupTaskStore(db, store.getSaveFunction());

  insertWallet(db, 1);
  if (overrides.withTwin !== false) {
    insertMetabot(db, { id: 1, walletId: 1, name: 'Twin Bot', type: 'twin', globalmetaid: 'gmid-twin' });
  }
  insertMetabot(db, { id: 2, walletId: 1, name: 'Coder Bot', type: 'worker', globalmetaid: 'gmid-coder' });
  insertMetabot(db, { id: 3, walletId: 1, name: 'Designer Bot', type: 'worker', globalmetaid: 'gmid-designer' });

  const calls = { create: [], join: [], send: [], wait: [], joinIdentity: [], sendIdentity: [] };
  const state = {
    joinFailures: new Set(overrides.joinFailures ?? []),
    indexed: overrides.indexed ?? true,
    ownerJoinFails: overrides.ownerJoinFails ?? false,
    nextGroupSeq: 0,
    createHold: null,
  };

  setGroupTaskServiceMetabotStoreGetter(() => metabotStore);
  setGroupTaskServiceGroupTaskStoreGetter(() => groupTaskStore);
  setGroupTaskServiceKvStoreGetter(() => store);
  setGroupTaskServiceOrchestrationBridgeGetter(null);
  setGroupTaskServiceTransport({
    createGroupChat: async (metabotId, opts) => {
      calls.create.push({ metabotId, opts });
      if (state.createHold) await state.createHold;
      const suffix = String(state.nextGroupSeq).padStart(2, '0');
      state.nextGroupSeq += 1;
      const groupId = state.nextGroupSeq === 1
        ? GROUP_ID
        : GROUP_ID.replace(/00i0$/, `${suffix}i0`);
      return { groupId, pinId: groupId };
    },
    joinGroupChat: async (metabotId, groupId) => {
      calls.join.push({ metabotId, groupId });
      if (state.joinFailures.has(metabotId)) {
        throw new Error(`join failed for ${metabotId}`);
      }
      return { pinId: `join-pin-${metabotId}` };
    },
    joinGroupChatAsIdentity: async (groupId) => {
      if (state.ownerJoinFails) {
        throw new Error('owner identity join failed');
      }
      calls.joinIdentity.push(groupId);
      return { pinId: 'owner-join-pin' };
    },
    sendGroupChatMessage: async (metabotId, groupId, opts) => {
      calls.send.push({ metabotId, groupId, opts });
      return { pinId: `msg-pin-${calls.send.length}` };
    },
    sendGroupChatMessageAsIdentity: async (groupId, opts) => {
      calls.sendIdentity.push({ groupId, opts });
      return { pinId: `identity-send-pin-${calls.sendIdentity.length}` };
    },
    waitForGroupIndexed: async (groupId) => {
      calls.wait.push({ groupId });
      return state.indexed;
    },
  });

  return {
    store, db, metabotStore, groupTaskStore, calls, state,
    cleanup: () => {
      setGroupTaskServiceOrchestrationBridgeGetter(null);
      setGroupTaskServiceStaffingSessionMessagesLoader(null);
      setGroupTaskServiceStaffingIntentJudge(null);
      resetGroupTaskServiceTransport();
      store.close();
    },
  };
};

test('createGroupTask happy path: twin chair, joins per member, kickoff, rows persisted', async () => {
  const h = await createHarness();
  try {
    const detail = await createGroupTask({
      title: 'Build MetaApp',
      goal: 'Build and publish the intro MetaApp',
      acceptanceCriteria: 'Preview URL works',
      memberMetabotIds: [2, 3],
      createdBy: 'user',
    });

    // chair = twin resolved automatically; group created by the chair
    assert.equal(h.calls.create.length, 1);
    assert.equal(h.calls.create[0].metabotId, 1);
    assert.equal(h.calls.create[0].opts.groupName, 'Build MetaApp');
    assert.equal(h.calls.wait.length, 1);
    assert.equal(h.calls.wait[0].groupId, GROUP_ID);

    // task row persisted
    assert.equal(detail.groupId, GROUP_ID);
    assert.equal(detail.status, 'planning');
    assert.equal(detail.chairMetabotId, 1);
    assert.equal(detail.createdBy, 'user');
    assert.equal(detail.createPinId, CREATE_PIN_ID);

    // members: chair + 2 workers, all joined on-chain
    assert.equal(detail.members.length, 3);
    const chair = detail.members.find((m) => m.role === 'chair');
    assert.equal(chair?.metabotId, 1);
    assert.equal(chair?.joinedPinId, CREATE_PIN_ID);
    assert.equal(chair?.globalmetaid, 'gmid-twin');
    for (const workerId of [2, 3]) {
      const worker = detail.members.find((m) => m.metabotId === workerId);
      assert.equal(worker?.role, 'worker');
      assert.equal(worker?.joinedPinId, `join-pin-${workerId}`);
    }
    assert.deepEqual(h.calls.join.map((c) => c.metabotId).sort(), [2, 3]);

    // kickoff message posted by the chair with goal + roster
    assert.equal(h.calls.send.length, 1);
    const kickoff = h.calls.send[0];
    assert.equal(kickoff.metabotId, 1);
    assert.equal(kickoff.groupId, GROUP_ID);
    assert.match(kickoff.opts.content, /\[GROUP TASK\] Build MetaApp/);
    assert.match(kickoff.opts.content, /Goal: Build and publish the intro MetaApp/);
    assert.match(kickoff.opts.content, /Acceptance: Preview URL works/);
    assert.match(kickoff.opts.content, /Chair: Twin Bot/);
    // P0-3: the roster line must NOT carry @ prefixes (an @ roster triggers every
    // member to respond; the chair assigns work with @ in later messages).
    assert.match(kickoff.opts.content, /Members: Coder Bot, Designer Bot/);
    assert.doesNotMatch(kickoff.opts.content, /@Coder Bot|@Designer Bot/);
    // P1-1: no assignment list on create → no mention array either; members
    // are woken by the chair planning turn's dispatch mention instead.
    assert.equal(kickoff.opts.mention, undefined);
    assert.equal(kickoff.opts.nickName, 'Twin Bot');

    // listed too
    assert.equal((await listGroupTasks()).length, 1);
    const shown = await getGroupTask(detail.id);
    assert.equal(shown.members.length, 3);
    assert.deepEqual(shown.deliverables, []);
    // P2-6: show surfaces the group transcript (mock transport writes no rows,
    // so only the array shape is asserted here).
    assert.ok(Array.isArray(shown.messages), 'getGroupTask returns the message flow');
  } finally {
    h.cleanup();
  }
});

test('createGroupTask with activeMemberNames: kickoff carries a mention array for the assigned workers (P1-1)', async () => {
  const h = await createHarness();
  try {
    await createGroupTask({
      title: 'Build MetaApp',
      goal: 'Build with an explicit first assignee',
      memberMetabotIds: [2, 3],
      activeMemberNames: ['Coder Bot'],
      createdBy: 'user',
    });
    const kickoff = h.calls.send[0];
    // The roster text stays @-free (P0-3)…
    assert.doesNotMatch(kickoff.opts.content, /@Coder Bot|@Designer Bot/);
    // …but the assigned worker's globalMetaId rides the mention array so the
    // daemon wake-up gate fires without a manual @ from the chair.
    assert.deepEqual(kickoff.opts.mention, ['gmid-coder']);
  } finally {
    h.cleanup();
  }
});

test('createGroupTask joins only the named workers (no auto-select of the local roster)', async () => {
  const h = await createHarness();
  try {
    const empty = await createGroupTask({
      title: 'Chair only',
      goal: 'Do not pull in every local worker',
      createdBy: 'user',
    });
    assert.deepEqual(empty.members.map((member) => member.metabotId).sort(), [1]);
    assert.equal(h.calls.join.length, 0);

    const named = await createGroupTask({
      title: 'One specialist',
      goal: 'Join the named coder only',
      memberMetabotIds: [2],
      createdBy: 'user',
    });
    assert.deepEqual(named.members.map((member) => member.metabotId).sort(), [1, 2]);
    assert.deepEqual(h.calls.join.map((call) => call.metabotId), [2]);
    assert.match(h.calls.send[1].opts.content, /Members: Coder Bot/);
    assert.doesNotMatch(h.calls.send[1].opts.content, /Designer Bot/);
  } finally {
    h.cleanup();
  }
});

test('create and close route through the canonical orchestration bridge when configured', async () => {
  const h = await createHarness();
  try {
    const calls = { ensure: [], accept: [] };
    setGroupTaskServiceOrchestrationBridgeGetter(() => ({
      ensureCanonicalTask: (task) => {
        calls.ensure.push(task.id);
        return { id: `canonical-${task.id}` };
      },
      acceptGroupTask: (taskId) => {
        calls.accept.push(taskId);
        return {
          groupTask: h.groupTaskStore.updateTaskStatus(taskId, 'done'),
          canonicalTask: { id: `canonical-${taskId}`, status: 'completed' },
        };
      },
      cancelGroupTask: (taskId) => {
        return {
          groupTask: h.groupTaskStore.updateTaskStatus(taskId, 'cancelled'),
          canonicalTask: { id: `canonical-${taskId}`, status: 'cancelled' },
        };
      },
    }));

    const accepted = await createGroupTask({ title: 'Accept', goal: 'G', createdBy: 'user' });
    assert.deepEqual(calls.ensure, [accepted.id]);
    assert.equal((await closeGroupTask(accepted.id, { status: 'done' })).status, 'done');
    assert.deepEqual(calls.accept, [accepted.id]);
  } finally {
    h.cleanup();
  }
});

test('createGroupTask degrades on member join failure: task created, joined_pin_id NULL', async () => {
  const h = await createHarness({ joinFailures: [3] });
  try {
    const detail = await createGroupTask({
      title: 'T', goal: 'G', memberMetabotIds: [2, 3], createdBy: 'user',
    });
    assert.ok(detail.id > 0);
    const okWorker = detail.members.find((m) => m.metabotId === 2);
    const failedWorker = detail.members.find((m) => m.metabotId === 3);
    assert.equal(okWorker?.joinedPinId, 'join-pin-2');
    assert.equal(failedWorker?.joinedPinId, null);
    // kickoff still attempted
    assert.equal(h.calls.send.length, 1);
  } finally {
    h.cleanup();
  }
});

test('createGroupTask persists the task when waitForGroupIndexed times out', async () => {
  const h = await createHarness({ indexed: false });
  try {
    const detail = await createGroupTask({ title: 'T', goal: 'G', createdBy: 'user' });
    assert.ok(detail.id > 0);
    assert.equal(detail.groupId, GROUP_ID);
    assert.equal(detail.status, 'planning');
    // chair-only task: no worker joins; kickoff still attempted
    assert.equal(h.calls.join.length, 0);
    assert.equal(h.calls.send.length, 1);
    assert.match(h.calls.send[0].opts.content, /Members: \(chair only\)/);
  } finally {
    h.cleanup();
  }
});

test('createGroupTask rejects when no twin exists', async () => {
  const h = await createHarness({ withTwin: false });
  try {
    await assert.rejects(
      createGroupTask({ title: 'T', goal: 'G', createdBy: 'user' }),
      /[Tt]win/,
    );
    assert.equal(h.calls.create.length, 0);
  } finally {
    h.cleanup();
  }
});

test('createGroupTask validates title/goal and skips unknown/duplicate member ids', async () => {
  const h = await createHarness();
  try {
    await assert.rejects(createGroupTask({ title: '', goal: 'G', createdBy: 'user' }), /title/);
    await assert.rejects(createGroupTask({ title: 'T', goal: ' ', createdBy: 'user' }), /goal/);

    // duplicates + chair id are deduped/excluded; unknown id is skipped with a warning
    const detail = await createGroupTask({
      title: 'T', goal: 'G', memberMetabotIds: [1, 2, 2, 99], createdBy: 'user',
    });
    assert.deepEqual(detail.members.map((m) => m.metabotId).sort(), [1, 2]);
    assert.deepEqual(h.calls.join.map((c) => c.metabotId), [2]);
  } finally {
    h.cleanup();
  }
});

test('postGroupTaskMessage: membership + terminal validation, nickName default', async () => {
  const h = await createHarness();
  try {
    const detail = await createGroupTask({
      title: 'T', goal: 'G', memberMetabotIds: [2], createdBy: 'user',
    });
    h.calls.send.length = 0;

    // non-member rejected
    await assert.rejects(
      postGroupTaskMessage(detail.id, 3, 'hello'),
      /not a member/,
    );
    // empty content rejected
    await assert.rejects(
      postGroupTaskMessage(detail.id, 2, '  '),
      /content/,
    );
    // member can post; nickName defaults to the bot display name
    const result = await postGroupTaskMessage(detail.id, 2, 'work done @Twin Bot', { replyPin: 'pin-x' });
    assert.equal(result.pinId, 'msg-pin-1');
    assert.equal(h.calls.send.length, 1);
    assert.equal(h.calls.send[0].metabotId, 2);
    assert.equal(h.calls.send[0].opts.nickName, 'Coder Bot');
    assert.equal(h.calls.send[0].opts.replyPin, 'pin-x');

    // terminal task rejects further messages
    await closeGroupTask(detail.id, { status: 'cancelled' });
    await assert.rejects(
      postGroupTaskMessage(detail.id, 2, 'still here'),
      /cancelled/,
    );
  } finally {
    h.cleanup();
  }
});

test('joinGroupTaskMember: on-chain join + member row; idempotent; surfaces chain failure', async () => {
  const h = await createHarness();
  try {
    const detail = await createGroupTask({ title: 'T', goal: 'G', createdBy: 'user' });
    assert.equal(detail.members.length, 1);

    const member = await joinGroupTaskMember(detail.id, 2);
    assert.equal(member.role, 'worker');
    assert.equal(member.joinedPinId, 'join-pin-2');
    assert.equal(h.calls.join.at(-1).metabotId, 2);
    // referrer is the chair's metaid
    assert.equal(h.calls.join.length, 1);

    // inviting again is a no-op
    const again = await joinGroupTaskMember(detail.id, 2);
    assert.equal(again.metabotId, 2);
    assert.equal(h.calls.join.length, 1);

    // unknown metabot -> error
    await assert.rejects(joinGroupTaskMember(detail.id, 99), /not found/);

    // chain failure surfaces (unlike create-flow degradation)
    h.state.joinFailures.add(3);
    await assert.rejects(joinGroupTaskMember(detail.id, 3), /join failed/);
  } finally {
    h.cleanup();
  }
});

test('joinGroupTaskMember: re-join after a kick revives the removed member row (M3)', async () => {
  const h = await createHarness();
  try {
    const detail = await createGroupTask({ title: 'T', goal: 'G', createdBy: 'user' });
    const member = await joinGroupTaskMember(detail.id, 2);
    assert.equal(member.joinedPinId, 'join-pin-2');
    assert.equal(h.calls.join.length, 1);

    // Kick the local worker (row kept, marked removed), then invite it back.
    h.groupTaskStore.markMemberRemoved({ taskId: detail.id, metabotId: 2, removePinId: 'pin-remove-2' });
    assert.ok(!h.groupTaskStore.isMember(detail.id, 2));

    const rejoined = await joinGroupTaskMember(detail.id, 2);
    assert.equal(h.calls.join.length, 2, 'a fresh on-chain join pin is signed');
    assert.equal(rejoined.id, member.id, 'UNIQUE(task_id, metabot_id): the removed row is revived in place');
    assert.equal(rejoined.removedAt, null);
    assert.equal(rejoined.removePinId, null);
    assert.equal(rejoined.joinedPinId, 'join-pin-2', 'joined_pin_id refreshed with the new join pin');
    assert.ok(h.groupTaskStore.isMember(detail.id, 2));
    assert.equal(
      h.groupTaskStore.listMembers(detail.id, { includeRemoved: true }).length,
      2,
      'chair + revived worker, no duplicate row',
    );
  } finally {
    h.cleanup();
  }
});

test('closeGroupTask: state machine transitions and terminal lock', async () => {
  const h = await createHarness();
  try {
    const detail = await createGroupTask({ title: 'T', goal: 'G', createdBy: 'user' });

    // owner accept-close shortcut: planning -> done is legal by design
    const done = await closeGroupTask(detail.id, { status: 'done', reason: 'goal met' });
    assert.equal(done.status, 'done');
    assert.ok(done.closedAt);
    assert.ok(Array.isArray(done.members), 'close returns full detail (members) so Accept & Close cannot white-screen');
    assert.ok(Array.isArray(done.deliverables), 'close returns full detail (deliverables)');

    // same-status close is a no-op by design (updateTaskStatus early-returns)
    const noop = await closeGroupTask(detail.id, { status: 'done' });
    assert.equal(noop.status, 'done');

    // already terminal: transitioning anywhere else throws
    await assert.rejects(closeGroupTask(detail.id, { status: 'cancelled' }), /Illegal/);
    await assert.rejects(closeGroupTask(9999, { status: 'done' }), /not found/);
    await assert.rejects(closeGroupTask(detail.id, { status: 'executing' }), /done.*cancelled/);
  } finally {
    h.cleanup();
  }
});

test('P1-4: closing with external deliveries records chair-attributed ledger rows (task #39)', async () => {
  const h = await createHarness();
  try {
    const detail = await createGroupTask({ title: 'T', goal: 'G', memberMetabotIds: [2], createdBy: 'user' });
    const closed = await closeGroupTask(detail.id, {
      status: 'done',
      reason: 'finished via Twin direct delegation',
      closureNote: 'Results delivered via Twin direct delegation after the group stalled.',
      externalDeliveries: [
        { uri: 'pin://abcd0000000000000000000000000000000000000000000000000000000000i0', kind: 'final-video', note: 'EP1 final cut' },
        { uri: '', kind: 'skipped-empty-uri' },
        { uri: 'pin://ffff0000000000000000000000000000000000000000000000000000000000i0' },
      ],
    });
    assert.equal(closed.status, 'done');
    const external = closed.deliverables.filter((d) => (d.kind ?? '').startsWith('external:'));
    assert.equal(external.length, 2, 'empty-uri entry skipped, two recorded');
    assert.ok(external.every((d) => d.authorGlobalmetaid === 'gmid-twin'), 'attributed to the chair');
    assert.equal(external[0].kind, 'external:final-video');
    assert.match(external[0].verification ?? '', /chair-attested.*EP1 final cut/);
    assert.match(external[1].verification ?? '', /produced outside the group session/);

    // A repeat (no-op) close of the terminal task must not stack duplicates.
    await closeGroupTask(detail.id, {
      status: 'done',
      externalDeliveries: [{ uri: 'pin://abcd0000000000000000000000000000000000000000000000000000000000i0' }],
    });
    const after = await getGroupTask(detail.id);
    assert.equal(after.deliverables.filter((d) => (d.kind ?? '').startsWith('external:')).length, 2);
  } finally {
    h.cleanup();
  }
});

test('P1-4: the closure note rides the close-out notice to the source session', async () => {
  const h = await createHarness();
  try {
    const detail = await createGroupTask({
      title: 'T', goal: 'G', memberMetabotIds: [2], createdBy: 'user', sourceSessionId: 'session-close-note',
    });
    const notices = [];
    setGroupTaskAcceptanceNotifier(({ message }) => {
      notices.push(message);
      return { ok: true };
    });
    await closeGroupTask(detail.id, {
      status: 'done',
      closureNote: 'Results delivered via Twin direct delegation.',
    });
    assert.equal(notices.length, 1);
    assert.match(notices[0], /Results delivered via Twin direct delegation\./);
  } finally {
    setGroupTaskAcceptanceNotifier(null);
    h.cleanup();
  }
});

test('createGroupTask: owner identity join attempted and recorded in kv', async () => {
  const h = await createHarness();
  try {
    const detail = await createGroupTask({ title: 'T', goal: 'G', memberMetabotIds: [2], createdBy: 'user' });
    assert.ok(detail.id > 0);
    assert.deepEqual(h.calls.joinIdentity, [GROUP_ID], 'owner joined the new group');

    // kv flag set by the create flow: a later guard call joins no more
    const again = await ensureOwnerJoinedGroup(GROUP_ID);
    assert.equal(again, false);
    assert.equal(h.calls.joinIdentity.length, 1);
  } finally {
    h.cleanup();
  }
});

test('createGroupTask tolerates owner identity join failure', async () => {
  const h = await createHarness({ ownerJoinFails: true });
  try {
    const detail = await createGroupTask({ title: 'T', goal: 'G', memberMetabotIds: [2], createdBy: 'user' });
    assert.ok(detail.id > 0, 'task still created');
    assert.equal(h.calls.send.length, 1, 'kickoff still sent');
  } finally {
    h.cleanup();
  }
});

test('ensureOwnerJoinedGroup: joins once, skips when kv flag present', async () => {
  const h = await createHarness();
  try {
    const gid = 'ccccccccddddddddeeeeeeeeffffffff00000000111111112222222233333333i0';
    assert.equal(await ensureOwnerJoinedGroup(gid), true, 'first call joins');
    assert.equal(await ensureOwnerJoinedGroup(gid), false, 'kv flag skips the re-join');
    assert.deepEqual(h.calls.joinIdentity, [gid], 'exactly one join pin');
  } finally {
    h.cleanup();
  }
});

test('postGroupTaskMessageAsOwner: re-join guard then identity send; validation', async () => {
  const h = await createHarness();
  try {
    // Pre-existing task created directly via the store: kv flag NOT set.
    const task = h.groupTaskStore.createTask({
      groupId: GROUP_ID, title: 'T', goal: 'G', chairMetabotId: 1, createdBy: 'user',
    });

    const result = await postGroupTaskMessageAsOwner(task.id, 'owner says hi');
    assert.equal(result.pinId, 'identity-send-pin-1');
    assert.deepEqual(h.calls.joinIdentity, [GROUP_ID], 'owner joined first (kv was missing)');
    assert.equal(h.calls.sendIdentity.length, 1);
    assert.equal(h.calls.sendIdentity[0].groupId, GROUP_ID);
    assert.equal(h.calls.sendIdentity[0].opts.content, 'owner says hi');

    // second send: guard skips the re-join
    await postGroupTaskMessageAsOwner(task.id, 'again');
    assert.equal(h.calls.joinIdentity.length, 1);
    assert.equal(h.calls.sendIdentity.length, 2);

    await assert.rejects(postGroupTaskMessageAsOwner(task.id, '  '), /content/);
    await assert.rejects(postGroupTaskMessageAsOwner(9999, 'hi'), /not found/);

    h.groupTaskStore.updateTaskStatus(task.id, 'cancelled');
    await assert.rejects(postGroupTaskMessageAsOwner(task.id, 'still?'), /cancelled/);
  } finally {
    h.cleanup();
  }
});

test('listGroupTaskSummaries enriches with member count and chair/member names', async () => {
  const h = await createHarness();
  try {
    await createGroupTask({ title: 'T', goal: 'G', memberMetabotIds: [2, 3], createdBy: 'user' });
    const summaries = await listGroupTaskSummaries();
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0].memberCount, 3);
    assert.equal(summaries[0].chairName, 'Twin Bot');
    assert.deepEqual(summaries[0].memberNames.slice().sort(), ['Coder Bot', 'Designer Bot', 'Twin Bot']);
    assert.equal(summaries[0].members.length, 3);
    assert.ok(summaries[0].members.some((member) => member.role === 'chair' && member.name === 'Twin Bot'));
    assert.ok(summaries[0].members.every((member) => 'avatar' in member));
    assert.equal((await listGroupTaskSummaries({ status: 'executing' })).length, 0);
  } finally {
    h.cleanup();
  }
});

test('round-4: computeGroupTaskStall — non-terminal + stale drive → stall, fresh → no stall, terminal → no stall', async () => {
  const { computeGroupTaskStall } = require('../dist-electron/main/services/groupTaskService.js');
  const nowMs = 1_000_000_000_000;
  const base = {
    id: 1, orchestrationTaskId: null, groupId: 'g-i0', title: 'T', goal: 'G',
    acceptanceCriteria: null, status: 'executing', chairMetabotId: 1, createdBy: 'user',
    lastProcessedMsgId: 10, lastDrivenAt: null, createPinId: null,
    createdAt: null, updatedAt: null, closedAt: null,
  };

  // stale lastDrivenAt (older than 30 min) → stalled
  assert.equal(computeGroupTaskStall(
    { ...base, lastDrivenAt: Math.floor(nowMs / 1000) - 60 * 60 }, nowMs,
  ).stall, true, '60min-old drive → stall');

  // fresh lastDrivenAt → not stalled
  assert.equal(computeGroupTaskStall(
    { ...base, lastDrivenAt: Math.floor(nowMs / 1000) - 10 }, nowMs,
  ).stall, false, '10s-old drive → no stall');

  // no lastDrivenAt → updatedAt fallback (UTC sqlite string), stale → stall
  assert.equal(computeGroupTaskStall(
    { ...base, lastDrivenAt: null, updatedAt: '2001-01-01 00:00:00' }, nowMs,
  ).stall, true, 'stale updatedAt fallback → stall');

  // no timestamps at all → unknown, never claims a stall
  assert.equal(computeGroupTaskStall(base, nowMs).stall, false, 'unknown activity → no stall');

  // terminal tasks never stall
  assert.equal(computeGroupTaskStall(
    { ...base, status: 'done', lastDrivenAt: Math.floor(nowMs / 1000) - 60 * 60 }, nowMs,
  ).stall, false, 'terminal → no stall');
  assert.equal(computeGroupTaskStall(
    { ...base, status: 'cancelled', lastDrivenAt: null, updatedAt: '2026-01-01 00:00:00' }, nowMs,
  ).stall, false, 'cancelled → no stall');

  assert.equal(computeGroupTaskStall(base, nowMs).stallAfterMinutes, 30);
});

test('round-4: getGroupTask detail carries lastDrivenAt + stall fields', async () => {
  const h = await createHarness();
  try {
    const task = await createGroupTask({ title: 'T', goal: 'G', memberMetabotIds: [2], createdBy: 'user' });
    const detail = await getGroupTask(task.id);
    assert.equal(typeof detail.stall, 'boolean');
    assert.equal(detail.stallAfterMinutes, 30);
    assert.ok('lastDrivenAt' in detail, 'lastDrivenAt surfaced on the detail');
  } finally {
    h.cleanup();
  }
});

test('round-4: show view=summary is compact (5 messages, members with lastSpeakAt) vs view=full', async () => {
  const h = await createHarness();
  try {
    const task = await createGroupTask({ title: 'T', goal: 'G', memberMetabotIds: [2], createdBy: 'user' });
    // insert 7 transcript rows directly (chair + worker alternation)
    for (let i = 1; i <= 7; i += 1) {
      const isChair = i % 2 === 1;
      h.db.run(
        `INSERT INTO group_chat_messages (
          pin_id, tx_id, group_id, channel_id, sender_metaid, sender_global_metaid, sender_address,
          sender_name, sender_avatar, sender_chat_pubkey, protocol, content, content_type, encryption,
          reply_pin, mention, chain_timestamp, chain, raw_data, is_processed, msg_index
        ) VALUES (?, ?, ?, NULL, ?, ?, NULL, ?, '', '', '/protocols/simplegroupchat', ?, 'text/plain', NULL,
          '', '[]', ?, 'mvc', '{}', 0, NULL)`,
        [
          `show-msg-${i}-i0`, `show-tx-${i}`, task.groupId,
          isChair ? 'metaid-1' : 'metaid-2', isChair ? 'gmid-twin' : 'gmid-coder',
          isChair ? 'Twin Bot' : 'Coder Bot', `msg ${i}`, 1_700_000_000 + i,
        ],
      );
    }

    const summary = await getGroupTask(task.id, { view: 'summary' });
    assert.equal(summary.messages.length, 5, 'summary keeps only the last 5 messages');
    assert.equal(summary.messages[4].content, 'msg 7', 'latest message present in summary');
    const workerMember = summary.members.find((m) => m.role === 'worker');
    assert.ok(workerMember, 'worker member present');
    assert.equal(workerMember.lastSpeakAt, 1_700_000_006, 'worker lastSpeakAt = max chain timestamp');
    const chairMember = summary.members.find((m) => m.role === 'chair');
    assert.equal(chairMember.lastSpeakAt, 1_700_000_007, 'chair lastSpeakAt');
    assert.equal(summary.deliverables.length, 0);

    const full = await getGroupTask(task.id, { view: 'full' });
    assert.equal(full.messages.length, 7, 'full returns all messages (up to 50)');
    assert.equal(full.messages[0].content, 'msg 1', 'full includes the oldest message');

    // default (no opts) keeps the IPC/UI behavior: full page
    const def = await getGroupTask(task.id);
    assert.equal(def.messages.length, 7, 'default view stays full for the IPC surface');
  } finally {
    h.cleanup();
  }
});

test('fix-v2 P1-4: summary view honors messageLimit and beforeId paging (with messagesTotal)', async () => {
  const h = await createHarness();
  try {
    const task = await createGroupTask({ title: 'T', goal: 'G', memberMetabotIds: [2], createdBy: 'user' });
    // 12 transcript rows — beyond both the summary default (5) and a custom
    // page size, so the limit/paging behavior is distinguishable.
    for (let i = 1; i <= 12; i += 1) {
      h.db.run(
        `INSERT INTO group_chat_messages (
          pin_id, tx_id, group_id, channel_id, sender_metaid, sender_global_metaid, sender_address,
          sender_name, sender_avatar, sender_chat_pubkey, protocol, content, content_type, encryption,
          reply_pin, mention, chain_timestamp, chain, raw_data, is_processed, msg_index
        ) VALUES (?, ?, ?, NULL, ?, ?, NULL, ?, '', '', '/protocols/simplegroupchat', ?, 'text/plain', NULL,
          '', '[]', ?, 'mvc', '{}', 0, NULL)`,
        [
          `p14-msg-${i}-i0`, `p14-tx-${i}`, task.groupId,
          'metaid-1', 'gmid-twin', 'Twin Bot', `msg ${i}`, 1_700_000_000 + i,
        ],
      );
    }

    // The v2 defect: summary ignored the limit and always returned 5.
    const limited = await getGroupTask(task.id, { view: 'summary', messageLimit: 20 });
    assert.equal(limited.messages.length, 12, 'summary view respects messageLimit=20 (returns all 12)');
    assert.equal(limited.messages[0].content, 'msg 1', 'the page starts at the oldest message');
    assert.equal(limited.messagesTotal, 12, 'messagesTotal lets the caller page');

    const page = await getGroupTask(task.id, { view: 'summary', messageLimit: 5 });
    assert.equal(page.messages.length, 5, 'an explicit small limit wins over the 5-default too');
    assert.equal(page.messages[4].content, 'msg 12', 'latest page ends at the newest message');

    // Keyset paging: before_id pages backwards, consistent with view=full.
    const oldestOnPage = page.messages[0];
    const older = await getGroupTask(task.id, { view: 'summary', messageLimit: 5, beforeId: oldestOnPage.id });
    assert.equal(older.messages.length, 5, 'the previous page is full too');
    assert.equal(older.messages[4].content, 'msg 7', 'before_id pages strictly backwards');
    assert.equal(older.messagesTotal, 12, 'messagesTotal is page-independent');
  } finally {
    h.cleanup();
  }
});

test('C-2: getGroupTaskChairMetabotId resolves the task chair; throws for unknown task', async () => {
  const harness = await createHarness();
  const task = await createGroupTask({
    title: 'C-2 chair resolution',
    goal: 'verify chair default',
    memberMetabotIds: [2],
    createdBy: 'user',
  });
  assert.equal(groupTaskService.getGroupTaskChairMetabotId(task.id), 1);
  assert.throws(() => groupTaskService.getGroupTaskChairMetabotId(9999), /not found/);
});

test('P0-1: postGroupTaskMessage returns field-level deliverable validation without blocking', async () => {
  const h = await createHarness();
  try {
    const detail = await createGroupTask({
      title: 'P0-1 validation', goal: 'verify warn-and-deliver', memberMetabotIds: [2], createdBy: 'user',
    });
    h.calls.send.length = 0;
    const result = await postGroupTaskMessage(
      detail.id,
      2,
      '**[DELIVERABLE] buzz: metaapp://5345dcdcd40ca628113de5ed18087df16667021d5246437d4f927e4c17c72525i0**',
    );
    // chain write succeeded (warn-and-deliver)
    assert.equal(result.pinId, 'msg-pin-1');
    assert.ok(result.deliverableValidation);
    assert.equal(result.deliverableValidation.errors.length, 0);
    assert.ok(result.deliverableValidation.warnings.length >= 1);
  } finally {
    h.cleanup();
  }
});

test('P0-2: setGroupTaskMemberStatus — self-set, chair-set, unauthorized rejected, invalid status rejected', async () => {
  const h = await createHarness();
  try {
    const detail = await createGroupTask({
      title: 'P0-2 status', goal: 'member state machine', memberMetabotIds: [2], createdBy: 'user',
    });
    const members = detail.members;
    const worker = members.find((m) => m.metabotId === 2);
    assert.equal(worker.status, 'assigned');

    // self-set
    const selfSet = await groupTaskService.setGroupTaskMemberStatus(detail.id, 2, 'working');
    assert.equal(selfSet.status, 'working');

    // chair-set (actor 1 = twin)
    const chairSet = await groupTaskService.setGroupTaskMemberStatus(detail.id, 2, 'unreachable', { actorMetabotId: 1 });
    assert.equal(chairSet.status, 'unreachable');

    // unauthorized actor (worker 3 tries to set worker 2)
    await assert.rejects(
      groupTaskService.setGroupTaskMemberStatus(detail.id, 2, 'working', { actorMetabotId: 3 }),
      /Only the member itself or the task chair/,
    );

    // invalid status
    await assert.rejects(
      groupTaskService.setGroupTaskMemberStatus(detail.id, 2, 'bogus'),
      /must be one of/,
    );
  } finally {
    h.cleanup();
  }
});

test('P0-5: reworkGroupTask moves review→executing with transition log; guards status + actor', async () => {
  const h = await createHarness();
  try {
    const detail = await createGroupTask({
      title: 'P0-5 rework', goal: 'rework hatch', memberMetabotIds: [2], createdBy: 'user',
    });
    // not in review yet
    await assert.rejects(
      groupTaskService.reworkGroupTask(detail.id, { actorMetabotId: 1, reason: 'early' }),
      /rework is only available from review/,
    );
    // move to executing then review (simulate chair STATUS tags through the store with log)
    h.groupTaskStore.updateTaskStatusWithLog(detail.id, 'executing', { actor: 'Twin Bot', reason: '[STATUS:EXECUTING] tag' });
    h.groupTaskStore.updateTaskStatusWithLog(detail.id, 'review', { actor: 'Twin Bot', reason: '[STATUS:REVIEW] tag' });

    // non-chair rejected
    await assert.rejects(
      groupTaskService.reworkGroupTask(detail.id, { actorMetabotId: 2, reason: 'hijack' }),
      /Only the task chair/,
    );

    // chair rework succeeds + logs
    const updated = await groupTaskService.reworkGroupTask(detail.id, { actorMetabotId: 1, reason: 'owner asked for fixes' });
    assert.equal(updated.status, 'executing');
    const transitions = h.groupTaskStore.listTaskTransitions(detail.id);
    const rework = transitions.find((t) => t.fromStatus === 'review' && t.toStatus === 'executing');
    assert.ok(rework, 'review→executing transition logged');
    assert.equal(rework.reason, 'owner asked for fixes');

    // show carries the transition log
    const shown = await getGroupTask(detail.id, { view: 'summary' });
    assert.ok(shown.transitions.length >= 2);
  } finally {
    h.cleanup();
  }
});

test('P0-6: kickoff includes observer expectations when activeMemberNames is smaller than the roster', async () => {
  const h = await createHarness();
  try {
    const detail = await createGroupTask({
      title: 'P0-6 observers',
      goal: 'observer role notes',
      memberMetabotIds: [2, 3],
      activeMemberNames: ['Coder Bot'],
      observerRoles: { 'Designer Bot': '静默观察，待命接手' },
      createdBy: 'user',
    });
    const kickoff = h.calls.send.find((call) => call.opts?.content?.includes('[GROUP TASK]'))?.opts?.content ?? '';
    assert.match(kickoff, /未派活成员预期/);
    assert.match(kickoff, /Designer Bot：静默观察，待命接手/);
    assert.doesNotMatch(kickoff, /Coder Bot：静默观察/);
  } finally {
    h.cleanup();
  }
});

test('P0-6: no observer fields → kickoff unchanged (no regression)', async () => {
  const h = await createHarness();
  try {
    const detail = await createGroupTask({
      title: 'P0-6 plain', goal: 'no observers', memberMetabotIds: [2, 3], createdBy: 'user',
    });
    const kickoff = h.calls.send.find((call) => call.opts?.content?.includes('[GROUP TASK]'))?.opts?.content ?? '';
    assert.doesNotMatch(kickoff, /未派活成员预期/);
    assert.match(kickoff, /Members: Coder Bot, Designer Bot/);
  } finally {
    h.cleanup();
  }
});

test('P0-7: exportGroupTask returns full message bodies + daily summaries', async () => {
  const h = await createHarness();
  try {
    const detail = await createGroupTask({
      title: 'P0-7 export', goal: 'archive', memberMetabotIds: [2], createdBy: 'user',
    });
    h.db.run(
      `INSERT INTO group_chat_messages (
        pin_id, tx_id, group_id, channel_id, sender_metaid, sender_global_metaid, sender_address,
        sender_name, sender_avatar, sender_chat_pubkey, protocol, content, content_type, encryption,
        reply_pin, mention, chain_timestamp, chain, raw_data, is_processed, msg_index
      ) VALUES (?, ?, ?, NULL, ?, ?, NULL, ?, '', '', '/protocols/simplegroupchat', ?, 'text/plain', NULL, NULL, '[]', ?, 'mvc', '{}', 0, NULL)`,
      ['pin-exp-1', 'tx-exp-1', detail.groupId, 'metaid-2', 'gmid-w2', 'Coder Bot', 'deliverable body here', 1700000000],
    );
    const exported = await groupTaskService.exportGroupTask(detail.id);
    assert.equal(exported.fullMessages.length, 1);
    assert.equal(exported.fullMessages[0].content, 'deliverable body here');
    assert.ok(exported.dailySummaries.length >= 1);
    assert.equal(exported.dailySummaries[0].count, 1);
    assert.ok(exported.exportedAt);
  } finally {
    h.cleanup();
  }
});

test('P0-8: recordGroupTaskIntegrityEvent persists + show returns integrityEvents', async () => {
  const h = await createHarness();
  try {
    const detail = await createGroupTask({
      title: 'P0-8 integrity', goal: 'record honesty', memberMetabotIds: [2], createdBy: 'user',
    });
    const event = await groupTaskService.recordGroupTaskIntegrityEvent(detail.id, {
      msgPinId: 'pin-honest-1',
      authorGlobalmetaid: 'gmid-coder',
      eventType: 'correction',
      detail: '更正：此前交付的 pinid 无效，正确如下',
    });
    assert.equal(event.eventType, 'correction');
    // dedupe by pin
    const dup = await groupTaskService.recordGroupTaskIntegrityEvent(detail.id, {
      msgPinId: 'pin-honest-1',
      authorGlobalmetaid: 'gmid-coder',
      eventType: 'correction',
      detail: 'duplicate',
    });
    assert.equal(dup.id, event.id);
    const shown = await getGroupTask(detail.id, { view: 'summary' });
    assert.equal(shown.integrityEvents.length, 1);
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// P1-1: member inviteStatus readout (distinguishable invite states)
// ---------------------------------------------------------------------------

test('P1-1: deriveGroupTaskMemberInviteStatus covers every state', () => {
  const derive = (overrides) => deriveGroupTaskMemberInviteStatus({
    metabotId: null,
    memberJoinedPinId: null,
    inviteStatus: null,
    inviteJoinedPinId: null,
    ...overrides,
  });
  assert.equal(derive({}), 'none', 'no invite row / unknown');
  assert.equal(derive({ metabotId: 7 }), 'none', 'local member never has invites');
  assert.equal(derive({ inviteStatus: 'pending' }), 'invite_pending');
  assert.equal(derive({ inviteStatus: 'accepted' }), 'invite_accepted');
  assert.equal(derive({ inviteStatus: 'declined' }), 'invite_declined');
  assert.equal(derive({ inviteStatus: 'expired' }), 'invite_expired');
  assert.equal(derive({ memberJoinedPinId: 'pin-x' }), 'joined', 'member row join pin wins');
  assert.equal(derive({ inviteJoinedPinId: 'pin-y' }), 'joined', 'invite-row join pin is the fallback');
});

test('P1-1: getGroupTask exposes inviteStatus per remote member', async () => {
  const h = await createHarness();
  try {
    const membershipStore = new OpenTeamMembershipStore(h.db, h.store.getSaveFunction());
    setGroupTaskServiceOpenTeamMembershipStoreGetter(() => membershipStore);
    const created = await createGroupTask({
      title: 'Invite status task',
      goal: 'Check the invite status readout',
      memberMetabotIds: [2],
      createdBy: 'user',
    });
    const taskId = created.id;

    // A remote placeholder member with a LIVE pending invite.
    h.groupTaskStore.addMember({
      taskId,
      metabotId: null,
      globalmetaid: 'gmid-remote-fortune',
      displayName: 'Fortune Bot',
      role: 'worker',
    });
    membershipStore.createInvite({
      taskId,
      groupId: GROUP_ID,
      inviteeGlobalmetaid: 'gmid-remote-fortune',
      inviteeName: 'Fortune Bot',
      invitePinId: 'pending-pin-1',
    });

    let detail = await getGroupTask(taskId);
    const fortune = detail.members.find((m) => m.globalmetaid === 'gmid-remote-fortune');
    assert.equal(fortune.inviteStatus, 'invite_pending');
    const local = detail.members.find((m) => m.globalmetaid === 'gmid-coder');
    assert.equal(local.inviteStatus, 'none', 'local members always none');

    // ACCEPT lands -> invite_accepted; join pin on the member row -> joined.
    membershipStore.updateInviteStatus({ invitePinId: 'pending-pin-1' }, 'accepted');
    detail = await getGroupTask(taskId);
    assert.equal(
      detail.members.find((m) => m.globalmetaid === 'gmid-remote-fortune').inviteStatus,
      'invite_accepted',
    );
    h.groupTaskStore.addMember({
      taskId,
      metabotId: null,
      globalmetaid: 'gmid-remote-fortune',
      displayName: 'Fortune Bot',
      role: 'worker',
      joinedPinId: 'joined-pin-1',
    });
    detail = await getGroupTask(taskId);
    assert.equal(
      detail.members.find((m) => m.globalmetaid === 'gmid-remote-fortune').inviteStatus,
      'joined',
      'member-row join pin flips the readout to joined',
    );
  } finally {
    setGroupTaskServiceOpenTeamMembershipStoreGetter(null);
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// P1-4: member workStatus — a failed-attempt residual must degrade when a
// newer success record exists (the panel must not keep reporting 'error'
// after the member visibly recovered)
// ---------------------------------------------------------------------------

test('P1-4: computeGroupTaskMemberWorkStatus error-degrade priority', () => {
  const NOW = 1_800_000_000_000;
  const MIN = 60_000;
  const status = (overrides) => computeGroupTaskMemberWorkStatus({
    metabotId: null,
    lastSpeakAt: null,
    lastWorkingAt: null,
    attemptStatus: null,
    attemptAtMs: null,
    nowMs: NOW,
    ...overrides,
  });

  // Priority 1: running attempt => working.
  assert.equal(status({ attemptStatus: 'running' }), 'working');

  // Priority 2: fresh [WORKING] tag inside the working window => working.
  assert.equal(status({ lastWorkingAt: NOW - 5 * MIN }), 'working');

  // Priority 4: failed inside the error window WITHOUT newer records => error
  // (last speech predates the failed attempt).
  assert.equal(
    status({ attemptStatus: 'failed', attemptAtMs: NOW - 10 * MIN, lastSpeakAt: NOW - 40 * MIN }),
    'error',
    'failure residual without newer success record stays error',
  );

  // Priority 3: failed + speech strictly AFTER the failure => degraded to idle.
  assert.equal(
    status({ attemptStatus: 'failed', attemptAtMs: NOW - 10 * MIN, lastSpeakAt: NOW - 8 * MIN }),
    'idle',
    'speech strictly after the failed attempt downgrades off error',
  );

  // Priority 3: failed + newer speech already outside the working window
  // (failure 50min ago, speech 40min ago) => still idle, never error.
  assert.equal(
    status({ attemptStatus: 'failed', attemptAtMs: NOW - 50 * MIN, lastSpeakAt: NOW - 40 * MIN }),
    'idle',
    'older post-failure speech still degrades off error (idle)',
  );

  // Priority 3 fallback: failed + working record after the failure inside the
  // working window => working.
  assert.equal(
    status({ attemptStatus: 'failed', attemptAtMs: NOW - 10 * MIN, lastWorkingAt: NOW - 5 * MIN }),
    'working',
    'working record after the failure inside the working window => working',
  );

  // Priority 3 fallback: failed + working record after the failure but stale
  // (30min ago) => idle, not error.
  assert.equal(
    status({ attemptStatus: 'failed', attemptAtMs: NOW - 50 * MIN, lastWorkingAt: NOW - 30 * MIN }),
    'idle',
    'stale working record after the failure, no fresh work => idle',
  );

  // Boundary: lastSpeakAt EXACTLY equals attemptAtMs is NOT a newer record —
  // a record coinciding with the failed attempt is not post-failure recovery
  // evidence, so the failure residual stays error (self-consistent semantics).
  assert.equal(
    status({ attemptStatus: 'failed', attemptAtMs: NOW - 10 * MIN, lastSpeakAt: NOW - 10 * MIN }),
    'error',
    'speech exactly at the failed attempt does not degrade error',
  );

  // Priority 4 window: failure outside the error window => residual gone,
  // no speech => unknown.
  assert.equal(
    status({ attemptStatus: 'failed', attemptAtMs: NOW - 70 * MIN }),
    'unknown',
    'failed attempt outside the error window is not error',
  );

  // Regression: no failure, speech => idle; nothing at all => unknown.
  assert.equal(status({ lastSpeakAt: NOW - 30 * MIN }), 'idle');
  assert.equal(status({}), 'unknown');

  // Production call site passes lastSpeakAt in epoch seconds (chain_timestamp)
  // and attemptAtMs in milliseconds. Seconds must still count as a newer
  // success record — otherwise the error residual never degrades in the UI.
  assert.equal(
    status({
      attemptStatus: 'failed',
      attemptAtMs: NOW - 10 * MIN,
      lastSpeakAt: Math.floor((NOW - 8 * MIN) / 1000),
    }),
    'idle',
    'epoch-second lastSpeakAt still degrades a failed attempt',
  );

  // A state-machine `working` member with a failed attempt is mid-retry, not
  // crashed — the panel must not stack "出错" on top of "working".
  assert.equal(
    status({ attemptStatus: 'failed', attemptAtMs: NOW - 10 * MIN, memberStatus: 'working' }),
    'working',
    'working member with a failed attempt reads working, not error',
  );
  assert.equal(
    status({
      attemptStatus: 'failed',
      attemptAtMs: NOW - 10 * MIN,
      memberStatus: 'working',
      lastWorkingAt: NOW - 30 * MIN,
    }),
    'timeout',
    'working member + failed attempt + stale [WORKING] reads timeout, not error',
  );
  assert.equal(
    status({ attemptStatus: 'failed', attemptAtMs: NOW - 10 * MIN, memberStatus: 'assigned' }),
    'error',
    'assigned member (not yet working) still reads error on a failed attempt',
  );

  // fix/group-member-status: cowork-session activity strictly AFTER the failed
  // attempt is also a newer success record — a local bot that kept working its
  // tools after a failed group-reply attempt is recovering, not crashed.
  assert.equal(
    status({ attemptStatus: 'failed', attemptAtMs: NOW - 10 * MIN, lastSessionActivityAt: NOW - 8 * MIN }),
    'idle',
    'session activity strictly after the failed attempt downgrades off error',
  );
  assert.equal(
    status({ attemptStatus: 'failed', attemptAtMs: NOW - 10 * MIN, lastSessionActivityAt: NOW - 10 * MIN }),
    'error',
    'session activity exactly at the failed attempt does not degrade error',
  );
  assert.equal(
    status({ attemptStatus: 'failed', attemptAtMs: NOW - 10 * MIN, lastSessionActivityAt: NOW - 30 * MIN }),
    'error',
    'session activity predating the failed attempt is not recovery evidence',
  );
});

// ---------------------------------------------------------------------------
// Task #52: the member rail while the task SITS IN REVIEW. Entering acceptance
// ends the work phase for the whole crew, so the liveness-derived
// working/timeout readouts (stale [WORKING] signals) describe a state that no
// longer exists. getGroupTask projects: delivered members -> done; the rest ->
// idle, with a stale 'working' state-machine stamp projected to 'standby'.
// ---------------------------------------------------------------------------

test('task #52: review-phase member readout settles to done/idle instead of working/timeout', async () => {
  const h = await createHarness();
  try {
    const task = h.groupTaskStore.createTask({
      groupId: GROUP_ID, title: 'mono-color skill', goal: 'Ship the skill intro MetaApp',
      acceptanceCriteria: 'Deliverables on chain', chairMetabotId: 1, createdBy: 'user', createPinId: 'pin-c',
    });
    h.groupTaskStore.addMember({ taskId: task.id, metabotId: 1, globalmetaid: 'gmid-twin', role: 'chair', joinedPinId: 'pin-c' });
    h.groupTaskStore.addMember({ taskId: task.id, metabotId: 2, globalmetaid: 'gmid-coder', role: 'worker', joinedPinId: 'pin-c' });
    h.groupTaskStore.addMember({ taskId: task.id, metabotId: 3, globalmetaid: 'gmid-designer', role: 'worker', joinedPinId: 'pin-c' });
    // The stuck shape from #52: task in review (verdict landed) but every
    // member still carries the 'working' stamp with stale signals.
    h.groupTaskStore.updateTaskStatus(task.id, 'executing');
    h.groupTaskStore.updateTaskStatus(task.id, 'review');
    h.groupTaskStore.setMemberStatus(task.id, 1, 'working', 'gmid-twin');
    h.groupTaskStore.setMemberStatus(task.id, 2, 'working', 'gmid-coder');
    h.groupTaskStore.setMemberStatus(task.id, 3, 'working', 'gmid-designer');
    // Coder delivered; designer and the chair have no ledger rows.
    const deliverable = h.groupTaskStore.addDeliverable({
      taskId: task.id, msgPinId: 'pin-deliv', authorGlobalmetaid: 'gmid-coder', kind: 'pinid', uri: 'pin-deliv',
    });
    h.groupTaskStore.updateDeliverableStatus(deliverable.id, 'delivered');

    const shown = await getGroupTask(task.id);
    const chair = shown.members.find((m) => m.metabotId === 1);
    const coder = shown.members.find((m) => m.metabotId === 2);
    const designer = shown.members.find((m) => m.metabotId === 3);

    assert.equal(coder.status, 'done', 'delivered member settles to done (state machine)');
    assert.equal(coder.workStatus, 'done', 'delivered member reads Delivered');
    assert.equal(chair.status, 'standby', "chair's stale working stamp projects to standby during review");
    assert.equal(chair.workStatus, 'idle', 'chair reads Idle while awaiting acceptance');
    assert.equal(designer.status, 'standby', "worker's stale working stamp projects to standby during review");
    assert.equal(designer.workStatus, 'idle', 'non-delivered worker reads Idle, never working/timeout');

    // Read-path only: the stored stamps survive untouched, so a rework hatch
    // (review -> executing) drops the projection and executing semantics resume.
    h.groupTaskStore.updateTaskStatus(task.id, 'executing');
    const reopened = await getGroupTask(task.id);
    const reopenedDesigner = reopened.members.find((m) => m.metabotId === 3);
    assert.equal(reopenedDesigner.status, 'working', 'stored working stamp resumes after rework');
    assert.notEqual(reopenedDesigner.workStatus, 'idle');
  } finally {
    h.cleanup();
  }
});

// --- Local-only UI state: display name, pin, archive/unarchive ---

const insertTaskRow = (h, overrides = {}) => h.groupTaskStore.createTask({
  groupId: overrides.groupId ?? `task-group-${Math.random().toString(36).slice(2, 10)}i0`,
  title: overrides.title ?? 'Chain Title',
  goal: overrides.goal ?? 'G',
  chairMetabotId: 1,
  createdBy: 'user',
  createPinId: null,
});

test('local state: rename sets display_name, leaves the chain title untouched, empty clears it', async () => {
  const h = await createHarness();
  try {
    const created = insertTaskRow(h);
    assert.equal(created.displayName, null);

    h.groupTaskStore.renameTask(created.id, 'My Display Name');
    const renamed = h.groupTaskStore.getTaskById(created.id);
    assert.equal(renamed.displayName, 'My Display Name');
    assert.equal(renamed.title, 'Chain Title');

    // empty/whitespace clears the override back to the chain title
    h.groupTaskStore.renameTask(created.id, '   ');
    assert.equal(h.groupTaskStore.getTaskById(created.id).displayName, null);
  } finally {
    h.cleanup();
  }
});

test('local state: pinned tasks sort first in the UI list', async () => {
  const h = await createHarness();
  try {
    const older = insertTaskRow(h);
    const newer = insertTaskRow(h);
    h.groupTaskStore.setTaskPinned(older.id, true);

    const tasks = h.groupTaskStore.listTasks({ includeArchived: false });
    assert.equal(tasks.length, 2);
    assert.equal(tasks[0].id, older.id, 'pinned task sorts first');
    assert.equal(tasks[0].pinned, true);
    assert.equal(tasks[1].pinned, false);

    h.groupTaskStore.setTaskPinned(older.id, false);
    const afterUnpin = h.groupTaskStore.listTasks({ includeArchived: false });
    assert.equal(afterUnpin[0].pinned, false);
  } finally {
    h.cleanup();
  }
});

test('local state: archive hides from the UI list but not from internal callers; restore brings it back', async () => {
  const h = await createHarness();
  try {
    const task = insertTaskRow(h);
    assert.equal(h.groupTaskStore.listTasks({ includeArchived: false }).length, 1);
    assert.equal(h.groupTaskStore.listTasks().length, 1);

    h.groupTaskStore.archiveTask(task.id);
    assert.equal(h.groupTaskStore.listTasks({ includeArchived: false }).length, 0, 'UI list hides archived');
    assert.equal(h.groupTaskStore.listTasks().length, 1, 'internal callers still see the task');
    assert.equal(h.groupTaskStore.countArchivedTasks(), 1);

    const archived = h.groupTaskStore.listArchivedTasks();
    assert.equal(archived.length, 1);
    assert.equal(archived[0].id, task.id);
    assert.ok(archived[0].archivedAt > 0, 'archive timestamp recorded');
    assert.ok(archived[0].archivedAt <= Date.now());

    h.groupTaskStore.unarchiveTask(task.id);
    assert.equal(h.groupTaskStore.listTasks({ includeArchived: false }).length, 1);
    assert.equal(h.groupTaskStore.countArchivedTasks(), 0);
    assert.equal(h.groupTaskStore.getTaskById(task.id).archivedAt, null);
  } finally {
    h.cleanup();
  }
});

test('local state: listGroupTaskSummaries (IPC surface) excludes archived tasks', async () => {
  const h = await createHarness();
  try {
    const a = insertTaskRow(h, { title: 'A' });
    insertTaskRow(h, { title: 'B' });
    h.groupTaskStore.archiveTask(a.id);

    const summaries = await listGroupTaskSummaries();
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0].id, a.id + 1);
    assert.equal(summaries[0].title, 'B');
    assert.equal(summaries[0].archivedAt, null);
  } finally {
    h.cleanup();
  }
});

const contentPlan = () => ({
  stages: [{ id: 'copy', title: 'Write the intro', seatRole: 'content', dependsOn: [] }],
  seats: [{
    role: 'content',
    candidateName: 'Coder Bot',
    metabotId: 2,
    source: 'local',
    reason: 'writes the intro',
  }],
});

/**
 * Slate that always requires owner confirmation: one remote seat disables the
 * all-local small-team auto-start (see the auto-start tests further down).
 */
const confirmRequiredPlan = () => ({
  stages: [{ id: 'copy', title: 'Write the intro', seatRole: 'content', dependsOn: [] }],
  seats: [
    ...contentPlan().seats,
    {
      role: 'design',
      candidateName: 'Remote Artist',
      candidateGlobalMetaId: 'idq1remotea00000000000000000000000000000',
      source: 'remote',
      reason: 'online designer',
    },
  ],
});

test('Twin create without a staffing proposal is rejected', async () => {
  const h = await createHarness();
  try {
    await assert.rejects(
      () => createGroupTask({ title: 'T', goal: 'G', memberMetabotIds: [2], createdBy: 'twinbot' }),
      (error) => error instanceof GroupTaskStaffingError && error.code === 'OWNER_CONFIRM_REQUIRED',
    );
    assert.equal(h.calls.create.length, 0);
  } finally {
    h.cleanup();
  }
});

test('Twin create is rejected until the owner confirms the proposed slate', async () => {
  const h = await createHarness();
  try {
    const messages = [
      { type: 'user', content: '帮我开个群任务做技能介绍', timestamp: 1_000 },
    ];
    setGroupTaskServiceStaffingSessionMessagesLoader(() => messages);
    const proposed = proposeGroupTaskStaffing({
      title: '技能介绍',
      goal: '写出介绍并发布',
      plan: confirmRequiredPlan(),
      sourceSessionId: 'session-confirm',
    });
    assert.equal(proposed.ownerConfirmRequired, true);
    assert.match(proposed.slateText, /直接回复确认/);

    await assert.rejects(
      () => createGroupTask({
        title: proposed.proposal.title,
        goal: proposed.proposal.goal,
        createdBy: 'twinbot',
        proposalId: proposed.proposal.id,
        sourceSessionId: 'session-confirm',
      }),
      (error) => error instanceof GroupTaskStaffingError && error.code === 'OWNER_CONFIRM_REQUIRED',
    );

    messages.push({ type: 'user', content: '换人，用设计师', timestamp: proposed.proposal.createdAt + 10 });
    await assert.rejects(
      () => createGroupTask({
        title: proposed.proposal.title,
        goal: proposed.proposal.goal,
        createdBy: 'twinbot',
        proposalId: proposed.proposal.id,
        sourceSessionId: 'session-confirm',
      }),
      (error) => error instanceof GroupTaskStaffingError && error.code === 'OWNER_REVISE_REQUIRED',
    );

    messages[1] = { type: 'user', content: '确认人选', timestamp: proposed.proposal.createdAt + 20 };
    // Plain confirmation is LLM-judged (task #38): inject the host judge.
    setGroupTaskServiceStaffingIntentJudge(async ({ replies }) => ({
      intents: replies.map((reply) => (/确认/.test(reply) ? 'confirm' : 'other')),
      wishSkip: false,
    }));
    const detail = await createGroupTask({
      title: proposed.proposal.title,
      goal: proposed.proposal.goal,
      createdBy: 'twinbot',
      proposalId: proposed.proposal.id,
      sourceSessionId: 'session-confirm',
    });
    assert.equal(detail.createdBy, 'twinbot');
    assert.deepEqual(detail.members.map((member) => member.metabotId).sort(), [1, 2]);
    assert.equal(detail.staffingProposalId, proposed.proposal.id);
    assert.equal(h.groupTaskStore.getStaffingProposalById(proposed.proposal.id).status, 'consumed');
  } finally {
    h.cleanup();
  }
});

test('wish that said to start without confirming skip-authorizes Twin create', async () => {
  const h = await createHarness();
  try {
    setGroupTaskServiceStaffingSessionMessagesLoader(() => [
      { type: 'user', content: '开个群任务做技能介绍，不用确认直接开', timestamp: 1_000 },
    ]);
    const proposed = proposeGroupTaskStaffing({
      title: '技能介绍',
      goal: '写出介绍并发布',
      plan: confirmRequiredPlan(),
      sourceSessionId: 'session-skip',
    });
    assert.equal(proposed.ownerConfirmRequired, false);
    assert.equal(proposed.proposal.status, 'skip_authorized');

    const detail = await createGroupTask({
      title: proposed.proposal.title,
      goal: proposed.proposal.goal,
      createdBy: 'twinbot',
      proposalId: proposed.proposal.id,
      sourceSessionId: 'session-skip',
    });
    assert.deepEqual(detail.members.map((member) => member.metabotId).sort(), [1, 2]);
    assert.equal(detail.pendingRemoteSeats.length, 1);
    assert.equal(detail.pendingRemoteSeats[0].candidateName, 'Remote Artist');
  } finally {
    h.cleanup();
  }
});

test('an all-local small slate auto-starts without owner confirmation', async () => {
  const h = await createHarness();
  try {
    setGroupTaskServiceStaffingSessionMessagesLoader(() => [
      { type: 'user', content: '帮我开个群任务做技能介绍', timestamp: 1_000 },
    ]);
    const proposed = proposeGroupTaskStaffing({
      title: '技能介绍',
      goal: '写出介绍并发布',
      plan: contentPlan(),
      sourceSessionId: 'session-local-auto',
    });
    assert.equal(proposed.ownerConfirmRequired, false);
    assert.equal(proposed.proposal.status, 'pending');
    assert.match(proposed.slateText, /无需确认/);
    assert.match(proposed.slateText, /本机/);

    const detail = await createGroupTask({
      title: proposed.proposal.title,
      goal: proposed.proposal.goal,
      createdBy: 'twinbot',
      proposalId: proposed.proposal.id,
      sourceSessionId: 'session-local-auto',
    });
    assert.deepEqual(detail.members.map((member) => member.metabotId).sort(), [1, 2]);
    assert.equal(detail.pendingRemoteSeats.length, 0);
    assert.equal(
      h.groupTaskStore.getStaffingProposalById(proposed.proposal.id).ownerDecision,
      'local_auto_start',
    );
  } finally {
    h.cleanup();
  }
});

test('five all-local seats still require owner confirmation', async () => {
  const h = await createHarness();
  try {
    setGroupTaskServiceStaffingSessionMessagesLoader(() => [
      { type: 'user', content: '帮我开个群任务做技能介绍', timestamp: 1_000 },
    ]);
    const proposed = proposeGroupTaskStaffing({
      title: '技能介绍',
      goal: '写出介绍并发布',
      plan: {
        stages: [],
        seats: [
          { role: 'content', candidateName: 'Coder Bot', metabotId: 2, source: 'local', reason: 'local' },
          { role: 'design', candidateName: 'Designer Bot', metabotId: 3, source: 'local', reason: 'local' },
          { role: 'engineering', candidateName: 'Coder Bot', metabotId: 2, source: 'local', reason: 'local' },
          { role: 'promotion', candidateName: 'Designer Bot', metabotId: 3, source: 'local', reason: 'local' },
          { role: 'domain', domainLabel: 'legal', candidateName: 'Coder Bot', metabotId: 2, source: 'local', reason: 'local' },
        ],
      },
      sourceSessionId: 'session-five-local',
    });
    assert.equal(proposed.ownerConfirmRequired, true);
    assert.equal(proposed.proposal.status, 'pending');
  } finally {
    h.cleanup();
  }
});

test('an owner revise reply blocks the all-local auto-start', async () => {
  const h = await createHarness();
  try {
    const messages = [
      { type: 'user', content: '帮我开个群任务做技能介绍', timestamp: 1_000 },
    ];
    setGroupTaskServiceStaffingSessionMessagesLoader(() => messages);
    const proposed = proposeGroupTaskStaffing({
      title: '技能介绍',
      goal: '写出介绍并发布',
      plan: contentPlan(),
      sourceSessionId: 'session-local-revise',
    });
    assert.equal(proposed.ownerConfirmRequired, false);
    messages.push({
      type: 'user',
      content: '换人，用设计师',
      timestamp: proposed.proposal.createdAt + 10,
    });
    await assert.rejects(
      () => createGroupTask({
        title: proposed.proposal.title,
        goal: proposed.proposal.goal,
        createdBy: 'twinbot',
        proposalId: proposed.proposal.id,
        sourceSessionId: 'session-local-revise',
      }),
      (error) => error instanceof GroupTaskStaffingError && error.code === 'OWNER_REVISE_REQUIRED',
    );
    assert.equal(h.calls.create.length, 0);
  } finally {
    h.cleanup();
  }
});

test('an owner cancel reply blocks the all-local auto-start', async () => {
  const h = await createHarness();
  try {
    const messages = [
      { type: 'user', content: '帮我开个群任务做技能介绍', timestamp: 1_000 },
    ];
    setGroupTaskServiceStaffingSessionMessagesLoader(() => messages);
    const proposed = proposeGroupTaskStaffing({
      title: '技能介绍',
      goal: '写出介绍并发布',
      plan: contentPlan(),
      sourceSessionId: 'session-local-cancel',
    });
    assert.equal(proposed.ownerConfirmRequired, false);
    messages.push({
      type: 'user',
      content: '算了，不开了',
      timestamp: proposed.proposal.createdAt + 10,
    });
    await assert.rejects(
      () => createGroupTask({
        title: proposed.proposal.title,
        goal: proposed.proposal.goal,
        createdBy: 'twinbot',
        proposalId: proposed.proposal.id,
        sourceSessionId: 'session-local-cancel',
      }),
      (error) => error instanceof GroupTaskStaffingError && error.code === 'OWNER_CANCEL_REQUIRED',
    );
    assert.equal(h.calls.create.length, 0);
  } finally {
    h.cleanup();
  }
});

test('Twin create joins local seats only and returns pending remote seats', async () => {
  const h = await createHarness();
  try {
    setGroupTaskServiceStaffingSessionMessagesLoader(() => [
      { type: 'user', content: 'just start without confirmation', timestamp: 1_000 },
    ]);
    const proposed = proposeGroupTaskStaffing({
      title: '技能介绍',
      goal: '写出介绍并发布',
      language: 'en',
      plan: {
        stages: [
          { id: 'copy', title: 'Copy', seatRole: 'content', dependsOn: [] },
          { id: 'visuals', title: 'Visuals', seatRole: 'design', dependsOn: ['copy'] },
        ],
        seats: [
          ...contentPlan().seats,
          {
            role: 'design',
            candidateName: 'Remote Artist',
            candidateGlobalMetaId: 'idq1remotea00000000000000000000000000000',
            source: 'remote',
            reason: 'online designer',
          },
        ],
      },
      sourceSessionId: 'session-remote',
    });
    const detail = await createGroupTask({
      title: proposed.proposal.title,
      goal: proposed.proposal.goal,
      createdBy: 'twinbot',
      proposalId: proposed.proposal.id,
    });
    assert.deepEqual(detail.members.map((member) => member.metabotId).sort(), [1, 2]);
    assert.equal(detail.pendingRemoteSeats.length, 1);
    assert.equal(detail.pendingRemoteSeats[0].candidateName, 'Remote Artist');
    assert.equal(h.calls.join.length, 1);
  } finally {
    h.cleanup();
  }
});

test('createGroupTask rejects a roster above the hard team cap', async () => {
  const h = await createHarness();
  try {
    await assert.rejects(
      () => createGroupTask({
        title: 'Too many',
        goal: 'Cap the roster',
        memberMetabotIds: [2, 3, 4, 5, 6, 7, 8, 9],
        createdBy: 'user',
      }),
      (error) => error instanceof GroupTaskStaffingError && error.code === 'ROSTER_CAP_EXCEEDED',
    );
  } finally {
    h.cleanup();
  }
});

test('「能直接开发吗？」does not skip owner confirm', async () => {
  const h = await createHarness();
  try {
    setGroupTaskServiceStaffingSessionMessagesLoader(() => [
      { type: 'user', content: '能直接开发吗？', timestamp: 1_000 },
    ]);
    const proposed = proposeGroupTaskStaffing({
      title: '技能介绍',
      goal: '写出介绍并发布',
      plan: confirmRequiredPlan(),
      sourceSessionId: 'session-dev-question',
    });
    assert.equal(proposed.ownerConfirmRequired, true);
    assert.equal(proposed.proposal.status, 'pending');
  } finally {
    h.cleanup();
  }
});

test('a historical skip phrase does not authorize a later propose', async () => {
  const h = await createHarness();
  try {
    setGroupTaskServiceStaffingSessionMessagesLoader(() => [
      { type: 'user', content: '上次那个不用确认直接开', timestamp: 1_000 },
      { type: 'user', content: '这次开个群任务做技能介绍', timestamp: 2_000 },
    ]);
    const proposed = proposeGroupTaskStaffing({
      title: '技能介绍',
      goal: '写出介绍并发布',
      plan: confirmRequiredPlan(),
      sourceSessionId: 'session-old-skip',
    });
    assert.equal(proposed.ownerConfirmRequired, true);
    assert.equal(proposed.proposal.status, 'pending');
  } finally {
    h.cleanup();
  }
});

test('owner skip phrase after a pending propose authorizes Twin create', async () => {
  const h = await createHarness();
  try {
    const messages = [
      { type: 'user', content: '帮我开个群任务做技能介绍', timestamp: 1_000 },
    ];
    setGroupTaskServiceStaffingSessionMessagesLoader(() => messages);
    const proposed = proposeGroupTaskStaffing({
      title: '技能介绍',
      goal: '写出介绍并发布',
      plan: confirmRequiredPlan(),
      sourceSessionId: 'session-skip-after',
    });
    assert.equal(proposed.proposal.status, 'pending');
    messages.push({
      type: 'user',
      content: '不用确认直接开',
      timestamp: proposed.proposal.createdAt + 10,
    });
    const detail = await createGroupTask({
      title: proposed.proposal.title,
      goal: proposed.proposal.goal,
      createdBy: 'twinbot',
      proposalId: proposed.proposal.id,
      sourceSessionId: 'session-skip-after',
    });
    assert.deepEqual(detail.members.map((member) => member.metabotId).sort(), [1, 2]);
    assert.equal(h.groupTaskStore.getStaffingProposalById(proposed.proposal.id).status, 'consumed');
  } finally {
    h.cleanup();
  }
});

test('换人 after a skip-authorized wish still requires a new propose', async () => {
  const h = await createHarness();
  try {
    const messages = [
      { type: 'user', content: '开个群任务做技能介绍，不用确认直接开', timestamp: 1_000 },
    ];
    setGroupTaskServiceStaffingSessionMessagesLoader(() => messages);
    const proposed = proposeGroupTaskStaffing({
      title: '技能介绍',
      goal: '写出介绍并发布',
      plan: contentPlan(),
      sourceSessionId: 'session-skip-then-revise',
    });
    assert.equal(proposed.proposal.status, 'skip_authorized');
    messages.push({ type: 'user', content: '换人', timestamp: proposed.proposal.createdAt + 10 });
    await assert.rejects(
      () => createGroupTask({
        title: proposed.proposal.title,
        goal: proposed.proposal.goal,
        createdBy: 'twinbot',
        proposalId: proposed.proposal.id,
        sourceSessionId: 'session-skip-then-revise',
      }),
      (error) => error instanceof GroupTaskStaffingError && error.code === 'OWNER_REVISE_REQUIRED',
    );
    assert.equal(h.calls.create.length, 0);
    assert.equal(h.groupTaskStore.getStaffingProposalById(proposed.proposal.id).status, 'skip_authorized');
  } finally {
    h.cleanup();
  }
});

test('「好的，不换人」confirms the roster instead of revising it', async () => {
  const h = await createHarness();
  try {
    const messages = [
      { type: 'user', content: '帮我开个群任务做技能介绍', timestamp: 1_000 },
    ];
    setGroupTaskServiceStaffingSessionMessagesLoader(() => messages);
    const proposed = proposeGroupTaskStaffing({
      title: '技能介绍',
      goal: '写出介绍并发布',
      plan: contentPlan(),
      sourceSessionId: 'session-keep-roster',
    });
    messages.push({ type: 'user', content: '好的，不换人', timestamp: proposed.proposal.createdAt + 10 });
    const detail = await createGroupTask({
      title: proposed.proposal.title,
      goal: proposed.proposal.goal,
      createdBy: 'twinbot',
      proposalId: proposed.proposal.id,
      sourceSessionId: 'session-keep-roster',
    });
    assert.deepEqual(detail.members.map((member) => member.metabotId).sort(), [1, 2]);
    assert.equal(h.groupTaskStore.getStaffingProposalById(proposed.proposal.id).status, 'consumed');
  } finally {
    h.cleanup();
  }
});

test('a new propose cancels the previous open slate for the same session', async () => {
  const h = await createHarness();
  try {
    setGroupTaskServiceStaffingSessionMessagesLoader(() => [
      { type: 'user', content: '帮我开个群任务做技能介绍', timestamp: 1_000 },
    ]);
    const first = proposeGroupTaskStaffing({
      title: '技能介绍',
      goal: '写出介绍并发布',
      plan: contentPlan(),
      sourceSessionId: 'session-replace',
    });
    const second = proposeGroupTaskStaffing({
      title: '技能介绍 v2',
      goal: '写出介绍并发布',
      plan: contentPlan(),
      sourceSessionId: 'session-replace',
    });
    assert.equal(h.groupTaskStore.getStaffingProposalById(first.proposal.id).status, 'cancelled');
    assert.equal(second.proposal.status, 'pending');
  } finally {
    h.cleanup();
  }
});

test('an identical re-propose reuses the open proposal instead of stacking a new one', async () => {
  const h = await createHarness();
  try {
    setGroupTaskServiceStaffingSessionMessagesLoader(() => [
      { type: 'user', content: '帮我开个群任务做技能介绍', timestamp: 1_000 },
    ]);
    const first = proposeGroupTaskStaffing({
      title: '技能介绍',
      goal: '写出介绍并发布',
      plan: confirmRequiredPlan(),
      sourceSessionId: 'session-idem',
    });
    assert.equal(first.reusedExistingProposal, undefined);
    // Same payload, chair simply re-ran propose (e.g. it lost the id).
    const second = proposeGroupTaskStaffing({
      title: '技能介绍',
      goal: '写出介绍并发布',
      plan: confirmRequiredPlan(),
      sourceSessionId: 'session-idem',
    });
    assert.equal(second.proposal.id, first.proposal.id);
    assert.equal(second.reusedExistingProposal, true);
    assert.equal(second.proposal.createdAt, first.proposal.createdAt);
    assert.equal(h.groupTaskStore.getStaffingProposalById(first.proposal.id).status, 'pending');
    // A trimmed acceptance-criteria difference is still "identical" (normalize).
    const third = proposeGroupTaskStaffing({
      title: '技能介绍',
      goal: '写出介绍并发布',
      acceptanceCriteria: '   ',
      plan: confirmRequiredPlan(),
      sourceSessionId: 'session-idem',
    });
    assert.equal(third.proposal.id, first.proposal.id);
  } finally {
    h.cleanup();
  }
});

test('an owner confirmation given before an identical re-propose still authorizes create (task #38)', async () => {
  const h = await createHarness();
  try {
    const messages = [
      { type: 'user', content: '帮我开个群任务做技能介绍', timestamp: 1_000 },
    ];
    setGroupTaskServiceStaffingSessionMessagesLoader(() => messages);
    const proposed = proposeGroupTaskStaffing({
      title: '技能介绍',
      goal: '写出介绍并发布',
      plan: confirmRequiredPlan(),
      sourceSessionId: 'session-idem-confirm',
    });
    // Owner confirms with a bare natural reply BEFORE the chair re-proposes.
    messages.push({ type: 'user', content: '确认', timestamp: proposed.proposal.createdAt + 10 });
    // Plain confirmation is LLM-judged (task #38): inject the host judge.
    setGroupTaskServiceStaffingIntentJudge(async ({ replies }) => ({
      intents: replies.map((reply) => (/确认/.test(reply) ? 'confirm' : 'other')),
      wishSkip: false,
    }));
    // The chair re-runs propose with the identical payload (task #38: it lost
    // the proposal id in CLI output parsing). The re-propose must NOT reset
    // the confirmation window past the owner's reply.
    const reproposed = proposeGroupTaskStaffing({
      title: '技能介绍',
      goal: '写出介绍并发布',
      plan: confirmRequiredPlan(),
      sourceSessionId: 'session-idem-confirm',
    });
    assert.equal(reproposed.proposal.id, proposed.proposal.id);
    assert.equal(reproposed.reusedExistingProposal, true);

    const detail = await createGroupTask({
      title: proposed.proposal.title,
      goal: proposed.proposal.goal,
      createdBy: 'twinbot',
      proposalId: reproposed.proposal.id,
      sourceSessionId: 'session-idem-confirm',
    });
    assert.equal(detail.staffingProposalId, proposed.proposal.id);
    assert.equal(h.groupTaskStore.getStaffingProposalById(proposed.proposal.id).status, 'consumed');
  } finally {
    h.cleanup();
  }
});

test('an identical re-propose does not reuse an expired open proposal', async () => {
  const h = await createHarness();
  try {
    setGroupTaskServiceStaffingSessionMessagesLoader(() => [
      { type: 'user', content: '帮我开个群任务做技能介绍', timestamp: 1_000 },
    ]);
    const first = proposeGroupTaskStaffing({
      title: '技能介绍',
      goal: '写出介绍并发布',
      plan: confirmRequiredPlan(),
      sourceSessionId: 'session-idem-expired',
    });
    h.db.run(
      'UPDATE group_task_staffing_proposals SET created_at = ? WHERE id = ?',
      [Date.now() - (25 * 60 * 60 * 1000), first.proposal.id],
    );
    h.store.getSaveFunction()();
    const second = proposeGroupTaskStaffing({
      title: '技能介绍',
      goal: '写出介绍并发布',
      plan: confirmRequiredPlan(),
      sourceSessionId: 'session-idem-expired',
    });
    assert.notEqual(second.proposal.id, first.proposal.id);
    assert.equal(second.reusedExistingProposal, undefined);
    assert.equal(h.groupTaskStore.getStaffingProposalById(first.proposal.id).status, 'cancelled');
  } finally {
    h.cleanup();
  }
});

test('any clear owner approval passes the confirm gate via the LLM judge (task #38 acceptance)', async () => {
  const h = await createHarness();
  try {
    for (const approval of ['确认', '可以', '行', 'OK', '就这样吧']) {
      const messages = [
        { type: 'user', content: '帮我开个群任务做技能介绍', timestamp: 1_000 },
      ];
      setGroupTaskServiceStaffingSessionMessagesLoader(() => messages);
      const proposed = proposeGroupTaskStaffing({
        title: '技能介绍',
        goal: '写出介绍并发布',
        plan: confirmRequiredPlan(),
        sourceSessionId: `session-llm-${approval}`,
      });
      messages.push({ type: 'user', content: approval, timestamp: proposed.proposal.createdAt + 10 });
      setGroupTaskServiceStaffingIntentJudge(async ({ replies }) => ({
        intents: replies.map((reply) => (reply === approval ? 'confirm' : 'other')),
        wishSkip: false,
      }));
      const detail = await createGroupTask({
        title: proposed.proposal.title,
        goal: proposed.proposal.goal,
        createdBy: 'twinbot',
        proposalId: proposed.proposal.id,
        sourceSessionId: `session-llm-${approval}`,
      });
      assert.equal(detail.staffingProposalId, proposed.proposal.id, `create passes for ${approval}`);
    }
  } finally {
    h.cleanup();
  }
});

test('a non-confirming owner reply judged -1 keeps the gate closed', async () => {
  const h = await createHarness();
  try {
    const messages = [
      { type: 'user', content: '帮我开个群任务做技能介绍', timestamp: 1_000 },
    ];
    setGroupTaskServiceStaffingSessionMessagesLoader(() => messages);
    const proposed = proposeGroupTaskStaffing({
      title: '技能介绍',
      goal: '写出介绍并发布',
      plan: confirmRequiredPlan(),
      sourceSessionId: 'session-llm-question',
    });
    messages.push({ type: 'user', content: '这样就可以了吗？', timestamp: proposed.proposal.createdAt + 10 });
    setGroupTaskServiceStaffingIntentJudge(async () => ({ intents: ['other'], wishSkip: false }));
    await assert.rejects(
      () => createGroupTask({
        title: proposed.proposal.title,
        goal: proposed.proposal.goal,
        createdBy: 'twinbot',
        proposalId: proposed.proposal.id,
        sourceSessionId: 'session-llm-question',
      }),
      (error) => error instanceof GroupTaskStaffingError && error.code === 'OWNER_CONFIRM_REQUIRED',
    );
  } finally {
    h.cleanup();
  }
});

test('without a judge wired, plain approvals no longer authorize create (vocabulary is gone)', async () => {
  const h = await createHarness();
  try {
    const messages = [
      { type: 'user', content: '帮我开个群任务做技能介绍', timestamp: 1_000 },
    ];
    setGroupTaskServiceStaffingSessionMessagesLoader(() => messages);
    const proposed = proposeGroupTaskStaffing({
      title: '技能介绍',
      goal: '写出介绍并发布',
      plan: confirmRequiredPlan(),
      sourceSessionId: 'session-no-judge',
    });
    messages.push({ type: 'user', content: '确认人选', timestamp: proposed.proposal.createdAt + 10 });
    await assert.rejects(
      () => createGroupTask({
        title: proposed.proposal.title,
        goal: proposed.proposal.goal,
        createdBy: 'twinbot',
        proposalId: proposed.proposal.id,
        sourceSessionId: 'session-no-judge',
      }),
      (error) => error instanceof GroupTaskStaffingError
        && error.code === 'OWNER_CONFIRM_REQUIRED'
        && /could not be evaluated/.test(error.message),
    );
  } finally {
    h.cleanup();
  }
});

test('a judge failure rejects create with the judge error surfaced', async () => {
  const h = await createHarness();
  try {
    const messages = [
      { type: 'user', content: '帮我开个群任务做技能介绍', timestamp: 1_000 },
    ];
    setGroupTaskServiceStaffingSessionMessagesLoader(() => messages);
    const proposed = proposeGroupTaskStaffing({
      title: '技能介绍',
      goal: '写出介绍并发布',
      plan: confirmRequiredPlan(),
      sourceSessionId: 'session-judge-error',
    });
    messages.push({ type: 'user', content: '确认', timestamp: proposed.proposal.createdAt + 10 });
    setGroupTaskServiceStaffingIntentJudge(async () => {
      throw new Error('llm unavailable');
    });
    await assert.rejects(
      () => createGroupTask({
        title: proposed.proposal.title,
        goal: proposed.proposal.goal,
        createdBy: 'twinbot',
        proposalId: proposed.proposal.id,
        sourceSessionId: 'session-judge-error',
      }),
      (error) => error instanceof GroupTaskStaffingError
        && error.code === 'OWNER_CONFIRM_REQUIRED'
        && /llm unavailable/.test(error.message),
    );
  } finally {
    h.cleanup();
  }
});

test('a non-Chinese/English cancel blocks create even under an active waiver (global audit)', async () => {
  const h = await createHarness();
  try {
    const messages = [
      // Multilingual skip wish: the regex never matches this — the judge does.
      { type: 'user', content: 'crée une tâche de groupe, commence sans confirmation', timestamp: 1_000 },
    ];
    setGroupTaskServiceStaffingSessionMessagesLoader(() => messages);
    const proposed = proposeGroupTaskStaffing({
      title: '技能介绍',
      goal: '写出介绍并发布',
      plan: confirmRequiredPlan(),
      sourceSessionId: 'session-i18n-cancel',
    });
    // The owner calls the whole thing off in French AFTER the propose.
    messages.push({ type: 'user', content: 'Annule tout, on ne le fait pas', timestamp: proposed.proposal.createdAt + 10 });
    setGroupTaskServiceStaffingIntentJudge(async ({ replies }) => ({
      intents: replies.map((reply) => (/Annule/i.test(reply) ? 'cancel' : 'other')),
      wishSkip: true,
    }));
    // wishSkip alone would authorize (skip_authorized); the LATER explicit
    // cancel must win — this is exactly the safety hole a zh/en regex
    // vocabulary left open for every other language.
    await assert.rejects(
      () => createGroupTask({
        title: proposed.proposal.title,
        goal: proposed.proposal.goal,
        createdBy: 'twinbot',
        proposalId: proposed.proposal.id,
        sourceSessionId: 'session-i18n-cancel',
      }),
      (error) => error instanceof GroupTaskStaffingError && error.code === 'OWNER_CANCEL_REQUIRED',
    );
    // Same shape, revise instead of cancel: the change request is honored.
    messages[1] = { type: 'user', content: 'Remplace le designer par Lucas', timestamp: proposed.proposal.createdAt + 10 };
    setGroupTaskServiceStaffingIntentJudge(async ({ replies }) => ({
      intents: replies.map((reply) => (/Remplace/i.test(reply) ? 'revise' : 'other')),
      wishSkip: true,
    }));
    await assert.rejects(
      () => createGroupTask({
        title: proposed.proposal.title,
        goal: proposed.proposal.goal,
        createdBy: 'twinbot',
        proposalId: proposed.proposal.id,
        sourceSessionId: 'session-i18n-cancel',
      }),
      (error) => error instanceof GroupTaskStaffingError && error.code === 'OWNER_REVISE_REQUIRED',
    );
  } finally {
    h.cleanup();
  }
});

test('a multilingual skip wish authorizes create without any reply', async () => {
  const h = await createHarness();
  try {
    const messages = [
      { type: 'user', content: 'crea una tarea de grupo y empieza sin confirmar nada', timestamp: 1_000 },
    ];
    setGroupTaskServiceStaffingSessionMessagesLoader(() => messages);
    const proposed = proposeGroupTaskStaffing({
      title: '技能介绍',
      goal: '写出介绍并发布',
      plan: confirmRequiredPlan(),
      sourceSessionId: 'session-i18n-wish',
    });
    setGroupTaskServiceStaffingIntentJudge(async () => ({ intents: [], wishSkip: true }));
    const detail = await createGroupTask({
      title: proposed.proposal.title,
      goal: proposed.proposal.goal,
      createdBy: 'twinbot',
      proposalId: proposed.proposal.id,
      sourceSessionId: 'session-i18n-wish',
    });
    assert.equal(detail.staffingProposalId, proposed.proposal.id);
    assert.equal(h.groupTaskStore.getStaffingProposalById(proposed.proposal.id).ownerDecision, 'skip_authorized');
  } finally {
    h.cleanup();
  }
});

test('a mislabeling judge cannot turn a regex revise into a confirm (overlay safety)', async () => {
  const h = await createHarness();
  try {
    const messages = [
      { type: 'user', content: '帮我开个群任务做技能介绍', timestamp: 1_000 },
    ];
    setGroupTaskServiceStaffingSessionMessagesLoader(() => messages);
    const proposed = proposeGroupTaskStaffing({
      title: '技能介绍',
      goal: '写出介绍并发布',
      plan: confirmRequiredPlan(),
      sourceSessionId: 'session-overlay-safety',
    });
    messages.push({ type: 'user', content: '换人，用设计师', timestamp: proposed.proposal.createdAt + 10 });
    // Judge mislabels the revise as a confirm: the regex overlay must win.
    setGroupTaskServiceStaffingIntentJudge(async () => ({ intents: ['confirm'], wishSkip: false }));
    await assert.rejects(
      () => createGroupTask({
        title: proposed.proposal.title,
        goal: proposed.proposal.goal,
        createdBy: 'twinbot',
        proposalId: proposed.proposal.id,
        sourceSessionId: 'session-overlay-safety',
      }),
      (error) => error instanceof GroupTaskStaffingError && error.code === 'OWNER_REVISE_REQUIRED',
    );
  } finally {
    h.cleanup();
  }
});

test('an expired pending proposal cannot be used to create', async () => {
  const h = await createHarness();
  try {
    setGroupTaskServiceStaffingSessionMessagesLoader(() => [
      { type: 'user', content: '帮我开个群任务做技能介绍', timestamp: 1_000 },
    ]);
    const proposed = proposeGroupTaskStaffing({
      title: '技能介绍',
      goal: '写出介绍并发布',
      plan: contentPlan(),
      sourceSessionId: 'session-expired',
    });
    h.db.run(
      'UPDATE group_task_staffing_proposals SET created_at = ? WHERE id = ?',
      [Date.now() - (25 * 60 * 60 * 1000), proposed.proposal.id],
    );
    h.store.getSaveFunction()();
    await assert.rejects(
      () => createGroupTask({
        title: proposed.proposal.title,
        goal: proposed.proposal.goal,
        createdBy: 'twinbot',
        proposalId: proposed.proposal.id,
        sourceSessionId: 'session-expired',
      }),
      (error) => error instanceof GroupTaskStaffingError && error.code === 'PROPOSAL_NOT_USABLE',
    );
    assert.equal(h.groupTaskStore.getStaffingProposalById(proposed.proposal.id).status, 'cancelled');
    assert.equal(h.calls.create.length, 0);
  } finally {
    h.cleanup();
  }
});

test('unknown local seat names fail create without consuming the proposal', async () => {
  const h = await createHarness();
  try {
    setGroupTaskServiceStaffingSessionMessagesLoader(() => [
      { type: 'user', content: '开个群任务做技能介绍，不用确认直接开', timestamp: 1_000 },
    ]);
    const proposed = proposeGroupTaskStaffing({
      title: '技能介绍',
      goal: '写出介绍并发布',
      plan: {
        stages: contentPlan().stages,
        seats: [{
          role: 'content',
          candidateName: 'Ghost Bot',
          source: 'local',
          reason: 'does not exist',
        }],
      },
      sourceSessionId: 'session-ghost',
    });
    await assert.rejects(
      () => createGroupTask({
        title: proposed.proposal.title,
        goal: proposed.proposal.goal,
        createdBy: 'twinbot',
        proposalId: proposed.proposal.id,
        sourceSessionId: 'session-ghost',
      }),
      (error) => error instanceof GroupTaskStaffingError && error.code === 'STAFFING_PLAN_INVALID',
    );
    assert.equal(h.calls.create.length, 0);
    assert.equal(h.groupTaskStore.getStaffingProposalById(proposed.proposal.id).status, 'skip_authorized');
  } finally {
    h.cleanup();
  }
});

test('Twin create claims the proposal before the on-chain group so a concurrent create cannot double-open', async () => {
  const h = await createHarness();
  try {
    setGroupTaskServiceStaffingSessionMessagesLoader(() => [
      { type: 'user', content: '开个群任务做技能介绍，不用确认直接开', timestamp: 1_000 },
    ]);
    const proposed = proposeGroupTaskStaffing({
      title: '技能介绍',
      goal: '写出介绍并发布',
      plan: contentPlan(),
      sourceSessionId: 'session-cas',
    });
    let releaseCreate;
    h.state.createHold = new Promise((resolve) => { releaseCreate = resolve; });
    const first = createGroupTask({
      title: proposed.proposal.title,
      goal: proposed.proposal.goal,
      createdBy: 'twinbot',
      proposalId: proposed.proposal.id,
      sourceSessionId: 'session-cas',
    });
    const started = Date.now();
    while (h.calls.create.length === 0 && Date.now() - started < 2_000) {
      await new Promise((resolve) => { setTimeout(resolve, 10); });
    }
    assert.equal(h.calls.create.length, 1, 'first create reached the chain');
    await assert.rejects(
      () => createGroupTask({
        title: proposed.proposal.title,
        goal: proposed.proposal.goal,
        createdBy: 'twinbot',
        proposalId: proposed.proposal.id,
        sourceSessionId: 'session-cas',
      }),
      (error) => error instanceof GroupTaskStaffingError && error.code === 'PROPOSAL_NOT_USABLE',
    );
    releaseCreate();
    const detail = await first;
    assert.deepEqual(detail.members.map((member) => member.metabotId).sort(), [1, 2]);
    assert.equal(h.calls.create.length, 1);
    assert.equal(h.groupTaskStore.getStaffingProposalById(proposed.proposal.id).status, 'consumed');
  } finally {
    h.cleanup();
  }
});

test('create releases a claimed proposal when the on-chain group fails before a task row exists', async () => {
  const h = await createHarness();
  try {
    setGroupTaskServiceStaffingSessionMessagesLoader(() => [
      { type: 'user', content: '开个群任务做技能介绍，不用确认直接开', timestamp: 1_000 },
    ]);
    const proposed = proposeGroupTaskStaffing({
      title: '技能介绍',
      goal: '写出介绍并发布',
      plan: contentPlan(),
      sourceSessionId: 'session-release',
    });
    h.state.createHold = Promise.reject(new Error('chain down'));
    await assert.rejects(
      () => createGroupTask({
        title: proposed.proposal.title,
        goal: proposed.proposal.goal,
        createdBy: 'twinbot',
        proposalId: proposed.proposal.id,
        sourceSessionId: 'session-release',
      }),
      (error) => error instanceof Error && error.message === 'chain down',
    );
    assert.equal(h.groupTaskStore.getStaffingProposalById(proposed.proposal.id).status, 'skip_authorized');
    assert.equal(h.groupTaskStore.getStaffingProposalById(proposed.proposal.id).createdTaskId, null);
  } finally {
    h.cleanup();
  }
});

test('done tasks show delivered members as done, not unreachable/standby', async () => {
  const h = await createHarness();
  try {
    const detail = await createGroupTask({
      title: 'Daily skill',
      goal: 'Ship one skill episode',
      acceptanceCriteria: 'Deliverable delivered and accepted',
      memberMetabotIds: [2, 3],
      createdBy: 'user',
    });
    // Worker 2 delivered; worker 3 never did. Simulate the #33/#34 stamps:
    // the delivered author stuck 'unreachable' (watchdog), the other 'standby'.
    const deliverable = h.groupTaskStore.addDeliverable({
      taskId: detail.id,
      msgPinId: 'deliver-pin-1',
      authorGlobalmetaid: 'gmid-coder',
      kind: 'metaapp',
      uri: 'metafile://deliver-pin-1',
    });
    h.groupTaskStore.updateDeliverableStatus(deliverable.id, 'delivered');
    h.groupTaskStore.setMemberStatus(detail.id, 2, 'unreachable', 'gmid-coder');
    h.groupTaskStore.setMemberStatus(detail.id, 3, 'standby', 'gmid-designer');

    // While the task is still running, liveness-derived statuses are unchanged.
    const executing = await getGroupTask(detail.id);
    const coderPre = executing.members.find((m) => m.metabotId === 2);
    assert.equal(coderPre.status, 'unreachable');
    assert.equal(coderPre.workStatus, 'unknown');

    const closed = await closeGroupTask(detail.id, { status: 'done', reason: 'owner 5/5' });
    assert.equal(closed.status, 'done');
    const coder = closed.members.find((m) => m.metabotId === 2);
    assert.equal(coder.status, 'done');
    assert.equal(coder.workStatus, 'done');
    // A member without a deliverable keeps its state-machine value and the
    // derived workStatus (never 'done').
    const designer = closed.members.find((m) => m.metabotId === 3);
    assert.equal(designer.status, 'standby');
    assert.notEqual(designer.workStatus, 'done');

    // Read-path projection also repairs pre-fix historical rows: force the
    // stale 'unreachable' back (as closed tasks from before the fix have it)
    // and the detail view still settles the delivered member on 'done'.
    h.groupTaskStore.setMemberStatus(detail.id, 2, 'unreachable', 'gmid-coder');
    const reshow = await getGroupTask(detail.id);
    const stale = reshow.members.find((m) => m.metabotId === 2);
    assert.equal(stale.status, 'done');
    assert.equal(stale.workStatus, 'done');
  } finally {
    h.cleanup();
  }
});

test('closeGroupTask: the chair posts exactly one [STATUS:DONE]/[STATUS:CANCELLED] close-out announcement', async () => {
  const h = await createHarness();
  try {
    const detail = await createGroupTask({ title: 'T', goal: 'G', createdBy: 'user' });
    const done = await closeGroupTask(detail.id, { status: 'done', reason: 'goal met' });
    assert.equal(done.status, 'done');

    const announcements = h.calls.send.filter((call) => /^\[STATUS:/.test(call.opts.content));
    assert.equal(announcements.length, 1, 'exactly one close-out announcement');
    assert.equal(announcements[0].metabotId, 1, 'posted as the chair');
    assert.equal(announcements[0].groupId, GROUP_ID);
    assert.equal(
      announcements[0].opts.content,
      '[STATUS:DONE] Task closed: accepted by the owner. Reason: goal met',
    );

    // A repeat (no-op) close of the terminal task must NOT re-announce.
    await closeGroupTask(detail.id, { status: 'done' });
    assert.equal(
      h.calls.send.filter((call) => /^\[STATUS:/.test(call.opts.content)).length,
      1,
      'repeat close stays silent',
    );

    const second = await createGroupTask({ title: 'T2', goal: 'G2', createdBy: 'user' });
    await closeGroupTask(second.id, { status: 'cancelled', reason: 'obsolete' });
    const cancelAnnouncement = h.calls.send.find((call) => call.opts.content.startsWith('[STATUS:CANCELLED]'));
    assert.ok(cancelAnnouncement, 'cancellation is announced too');
    assert.equal(
      cancelAnnouncement.opts.content,
      '[STATUS:CANCELLED] Task closed: cancelled by the owner. Reason: obsolete',
    );
  } finally {
    h.cleanup();
  }
});

test('closeGroupTask: a failing close-out announcement never fails the close', async () => {
  const h = await createHarness();
  try {
    const detail = await createGroupTask({ title: 'T', goal: 'G', createdBy: 'user' });
    setGroupTaskServiceTransport({
      sendGroupChatMessage: async () => { throw new Error('chain offline'); },
    });
    const closed = await closeGroupTask(detail.id, { status: 'done' });
    assert.equal(closed.status, 'done');
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// G-04: supervisor intervention channel
// ---------------------------------------------------------------------------

test('superviseGroupTask: nudge records the signal with NO group post (single-commander); pause/resume gate dispatch with owner confirm', async () => {
  const h = await createHarness();
  try {
    const detail = await groupTaskService.createGroupTask({
      title: 'Supervised build',
      goal: 'Build it',
      acceptanceCriteria: 'shipped',
      memberMetabotIds: [2],
      createdBy: 'user',
    });
    const sendsBefore = h.calls.send.length;

    // nudge → signal row only; NOTHING posts into the group under the chair's
    // identity anymore (task #65 acceptance: the last impersonation is gone).
    const nudge = await groupTaskService.superviseGroupTask({
      taskId: detail.id,
      action: 'nudge',
      note: 'double-check the archive dedupe',
      target: 'Coder Bot',
    });
    assert.equal(nudge.signal.kind, 'nudge');
    assert.equal(nudge.signal.processedAt, null, 'nudge waits for the chair response turn');
    assert.equal(
      h.calls.send.length,
      sendsBefore,
      'no supervisor notice posted into the group',
    );
    assert.equal(nudge.signal.noticePinId ?? null, null, 'no notice pin recorded');

    // pause → local gate + pre-processed row
    const paused = await groupTaskService.superviseGroupTask({
      taskId: detail.id,
      action: 'pause',
      note: 'owner wants to check the draft first',
    });
    assert.equal(typeof paused.dispatchPausedAt, 'number');
    assert.ok(paused.signal.processedAt, 'pause is host-applied (already processed)');
    assert.notEqual(
      h.groupTaskStore.getTaskById(detail.id).dispatchPausedAt,
      null,
      'the pause gate is persisted',
    );

    // resume without owner confirmation is refused
    await assert.rejects(
      () => groupTaskService.superviseGroupTask({
        taskId: detail.id,
        action: 'resume',
        note: 'resume please',
      }),
      /requires explicit owner confirmation/,
    );
    assert.notEqual(h.groupTaskStore.getTaskById(detail.id).dispatchPausedAt, null, 'still paused');

    // owner-confirmed resume lifts the gate and records the trail
    const resumed = await groupTaskService.superviseGroupTask({
      taskId: detail.id,
      action: 'resume',
      note: 'owner confirmed in chat',
      confirmOwner: true,
    });
    assert.equal(resumed.dispatchPausedAt, null);
    assert.equal(h.groupTaskStore.getTaskById(detail.id).dispatchPausedAt, null);

    // the whole trail is exposed on the detail (review record source)
    const shown = await groupTaskService.getGroupTask(detail.id);
    assert.deepEqual(
      shown.supervisorSignals.map((signal) => signal.kind),
      ['nudge', 'pause', 'resume'],
    );
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// group-task speedup REQ v1.1, R-04: sender display names follow the
// GlobalMetaID identity, never the chain-resolved historical nickname.
// ---------------------------------------------------------------------------

test('speedup R-04: getGroupTask renders roster names over chain sender_name', async () => {
  const h = await createHarness();
  try {
    const detail = await createGroupTask({
      title: 'Naming',
      goal: 'g',
      memberMetabotIds: [2],
      createdBy: 'user',
    });
    const insertMsg = (pinId, gmid, senderName) => {
      h.db.run(
        `INSERT INTO group_chat_messages (
          pin_id, tx_id, group_id, channel_id, sender_metaid, sender_global_metaid, sender_address,
          sender_name, sender_avatar, sender_chat_pubkey, protocol, content, content_type, encryption,
          reply_pin, mention, chain_timestamp, chain, raw_data, is_processed, msg_index
        ) VALUES (?, ?, ?, NULL, ?, ?, NULL, ?, '', '', '/protocols/simplegroupchat', 'hello', 'text/plain', NULL, '', '[]', NULL, 'mvc', '{}', 0, NULL)`,
        [pinId, pinId, GROUP_ID, `metaid-${pinId}`, gmid, senderName],
      );
    };
    // The EP28 bug shape: a member's message indexed under a stale chain name.
    insertMsg('wrong-name-pin', 'gmid-coder', 'claude bot');
    // A non-member sender keeps whatever name the chain carried.
    insertMsg('stranger-pin', 'gmid-stranger', 'Stranger Chain Name');

    const view = await getGroupTask(detail.id, { view: 'full' });
    const memberMsg = view.messages.find((m) => m.pinId === 'wrong-name-pin');
    assert.equal(memberMsg?.senderName, 'Coder Bot', 'roster name wins over the chain nickname');
    const strangerMsg = view.messages.find((m) => m.pinId === 'stranger-pin');
    assert.equal(strangerMsg?.senderName, 'Stranger Chain Name', 'non-member senders keep the chain name');
  } finally {
    h.cleanup();
  }
});

test('speedup R-04: ingest-time sender name resolver prefers the local MetaBot registry', async () => {
  const { setLocalSenderNameResolver, resolveGroupChatSenderName } =
    require('../dist-electron/main/services/metaWebListenerService.js');
  try {
    setLocalSenderNameResolver((gmid) => (gmid === 'gmid-coder' ? 'Coder Bot' : null));
    assert.equal(
      resolveGroupChatSenderName('gmid-coder', 'claude bot', ''),
      'Coder Bot',
      'local registered name wins over the chain userInfo.name',
    );
    assert.equal(
      resolveGroupChatSenderName('gmid-other', 'Chain Name', 'nick'),
      'Chain Name',
      'unknown sender falls back to the chain name',
    );
    assert.equal(
      resolveGroupChatSenderName('gmid-other', '', 'nick'),
      'nick',
      'empty chain name falls back to the pin nickName',
    );
    assert.equal(resolveGroupChatSenderName(null, null, null), '', 'all-empty stays empty');
  } finally {
    setLocalSenderNameResolver(null);
  }
});
