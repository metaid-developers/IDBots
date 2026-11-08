import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');
const { LongTermTaskStore } = require('../dist-electron/main/longTermTaskStore.js');
const { buildLongTermTaskAgentTools } = require('../dist-electron/main/libs/longTermTaskAgentTools.js');

/**
 * longterm_delegation_anchor (delegation-context fix): the anchor block must
 * carry ids + goal + criteria + recent events + worker duties, so a worker
 * bot pulls full context from the source instead of relying on the Twin's
 * relay. Runs against compiled output (pnpm run compile:electron first).
 */

async function openWorld(language = 'en') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-lt-anchor-'));
  const sqliteStore = await SqliteStore.create(dir);
  const store = new LongTermTaskStore(sqliteStore.getDatabase(), sqliteStore.getSaveFunction());
  const captured = new Map();
  const toolFactory = (name, description, schema, handler) => {
    captured.set(name, { description, handler });
    return { name };
  };
  const tools = buildLongTermTaskAgentTools({
    tool: toolFactory,
    control: { store: () => store, getAppLanguage: () => language },
  });
  assert.ok(tools.length > 0);
  const anchor = captured.get('longterm_delegation_anchor');
  assert.ok(anchor, 'longterm_delegation_anchor tool missing');
  return { store, captured, anchor };
}

const SPEC = {
  title: 'Game hub',
  goal: 'Ship the on-chain game hub where real bots play real bots.',
  subtasks: [
    {
      title: 'Blueprint match loop',
      description: 'Two local bots play a full match unattended.',
      acceptanceCriteria: ['3 full matches, zero human intervention', 'every move a compliant event message'],
      preferredChannel: 'delegate_bot',
    },
    { title: 'Spectate & replay', dependsOnOrdinals: [1] },
  ],
};

test('anchor block (en): ids, goal, criteria, channel, events, worker duties', async () => {
  const { store, anchor } = await openWorld('en');
  const created = store.createTask(SPEC, 'owner');
  assert.ok(created.ok, JSON.stringify(created));
  const taskId = created.value.id;
  const subtaskId = created.value.subtasks[0].id;
  assert.ok(store.activateTask(taskId, 'owner').ok);
  assert.ok(store.beginSubtask(subtaskId, 'twin', 'delegate_bot').ok);

  const result = await anchor.handler({ taskId, subtaskId });
  const text = result.content[0].text;
  assert.ok(text.includes('<longterm_anchor>'), 'anchor block wrapper missing');
  assert.ok(text.includes(`taskId: ${taskId}`));
  assert.ok(text.includes(`subtaskId: ${subtaskId}`));
  assert.ok(text.includes('Ship the on-chain game hub where real bots play real bots.'), 'goal missing');
  assert.ok(text.includes('3 full matches, zero human intervention'), 'criteria missing');
  assert.ok(text.includes('delegate_bot'), 'channel missing');
  assert.ok(text.includes('Recent journal events:'), 'journal digest missing');
  assert.ok(text.includes('longterm_task_get(taskId)'), 'worker self-read duty missing');
  assert.ok(text.includes('never invent infrastructure'), 'anti-invention rule missing');
  assert.ok(text.includes('longterm_event_note(taskId, subtaskId)'), 'journal-back duty missing');
});

test('anchor block (zh): Chinese labels and duties for zh owners', async () => {
  const { store, anchor } = await openWorld('zh');
  const created = store.createTask(SPEC, 'owner');
  assert.ok(created.ok);
  const taskId = created.value.id;
  const subtaskId = created.value.subtasks[0].id;

  const result = await anchor.handler({ taskId, subtaskId });
  const text = result.content[0].text;
  assert.ok(text.includes('验收标准:'));
  assert.ok(text.includes('工作要求:'));
  assert.ok(text.includes('禁止自行发明基建'));
});

test('anchor refuses unknown task / subtask', async () => {
  const { anchor } = await openWorld('en');
  const missingTask = await anchor.handler({ taskId: 'ltt_nope', subtaskId: 'lts_nope' });
  assert.equal(missingTask.isError, true);
  const { store, anchor: anchor2 } = await openWorld('en');
  const created = store.createTask(SPEC, 'owner');
  assert.ok(created.ok);
  const missingSub = await anchor2.handler({ taskId: created.value.id, subtaskId: 'lts_nope' });
  assert.equal(missingSub.isError, true);
  void store;
});

test('longterm_task_complete tool: delegate gate + goal-level closure through the twin channel', async () => {
  const { store, captured } = await openWorld('en');
  const complete = captured.get('longterm_task_complete');
  assert.ok(complete, 'longterm_task_complete tool missing');
  assert.match(complete.description, /GOAL met/i, 'description must frame this as a goal-level verdict');
  const created = store.createTask(SPEC, 'owner');
  assert.ok(created.ok);
  const taskId = created.value.id;
  assert.ok(store.activateTask(taskId, 'owner').ok);
  // The delegate switch defaults ON at creation (2026-10-22); the refusal
  // path is exercised against an owner-opted-out task.
  assert.ok(store.updateTask({ taskId, acceptanceDelegate: false }, 'owner').ok);

  const refused = await complete.handler({
    taskId,
    summary: 'hub shipped and live',
    evidence: [{ kind: 'url', uri: 'https://x.example/hub' }],
  });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /FORBIDDEN/);

  assert.ok(store.updateTask({ taskId, acceptanceDelegate: true }, 'owner').ok);
  const closed = await complete.handler({
    taskId,
    summary: 'hub shipped and live; spectate deferred',
    evidence: [{ kind: 'url', uri: 'https://x.example/hub', note: 'live hub' }],
  });
  assert.equal(closed.isError, undefined);
  const after = store.getTask(taskId);
  assert.equal(after.stage, 'done');
  assert.ok(after.subtasks.every((sub) => sub.status === 'skipped'));
});

test('longterm_subtask_skip tool: plan verdict with reason; last-open skip keeps the delegate gate', async () => {
  const { store, captured } = await openWorld('en');
  const skip = captured.get('longterm_subtask_skip');
  assert.ok(skip, 'longterm_subtask_skip tool missing');
  const created = store.createTask(SPEC, 'owner');
  assert.ok(created.ok);
  const taskId = created.value.id;
  assert.ok(store.activateTask(taskId, 'owner').ok);
  // The delegate switch defaults ON at creation (2026-10-22); opt out first.
  assert.ok(store.updateTask({ taskId, acceptanceDelegate: false }, 'owner').ok);
  const [first, second] = store.getTask(taskId).subtasks;

  const skipped = await skip.handler({ subtaskId: second.id, reason: 'spectate covered by the replay page' });
  assert.equal(skipped.isError, undefined);
  assert.equal(store.getSubtask(second.id).status, 'skipped');
  assert.match(store.getTask(taskId).events[0].detail, /replay page/);

  // Skipping the now-last open sub-project completes the task — acceptance
  // authority, so the twin channel is refused without the delegate switch.
  const closing = await skip.handler({ subtaskId: first.id, reason: 'goal met' });
  assert.equal(closing.isError, true);
  assert.match(closing.content[0].text, /FORBIDDEN/);
  assert.equal(store.getTask(taskId).stage, 'active');

  assert.ok(store.updateTask({ taskId, acceptanceDelegate: true }, 'owner').ok);
  const closingOk = await skip.handler({ subtaskId: first.id, reason: 'goal met' });
  assert.equal(closingOk.isError, undefined);
  assert.equal(store.getTask(taskId).stage, 'done');
});

/**
 * Agent-channel projection (bug report 2026-10-20, SEC-1 / BUG-1 root cause):
 * the store resolves participants WITH their avatar (a base64 data URL, ~75K
 * chars per bot) for the board's chips, and every create / activate / get /
 * list echo shipped it to the model — 87% of the result budget, which is what
 * pushed the runtime shaper into tearing the identity fields. The Twin's tools
 * must drop the avatar on every task-shaped echo while the store (the owner
 * channel) keeps it.
 */
async function openWorldWithAvatar() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-lt-avatar-'));
  const sqliteStore = await SqliteStore.create(dir);
  const db = sqliteStore.getDatabase();
  const definitionSessionId = 'sess_definition_1';
  const now = Date.now();
  db.run(
    'INSERT INTO cowork_sessions (id, title, cwd, metabot_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    [definitionSessionId, 'definition', '/tmp', 7, now, now],
  );
  const avatar = 'data:image/png;base64,' + 'A'.repeat(75800);
  const store = new LongTermTaskStore(db, sqliteStore.getSaveFunction(), {
    resolveParticipants: (ids) => ids.map((id) => ({ id, name: `bot-${id}`, avatar })),
  });
  const captured = new Map();
  buildLongTermTaskAgentTools({
    tool: (name, description, schema, handler) => {
      captured.set(name, { description, handler });
      return { name };
    },
    control: { store: () => store, getAppLanguage: () => 'en' },
  });
  return { store, captured, avatar, definitionSessionId };
}

const BASE64_RUN = /[A-Za-z0-9+/=]{512,}/;

test('agent echoes carry participants without the avatar; the store (owner channel) keeps it', async () => {
  const { store, captured, avatar, definitionSessionId } = await openWorldWithAvatar();
  const create = captured.get('longterm_task_create');
  const created = await create.handler({ ...SPEC, definitionSessionId });
  assert.equal(created.isError, undefined, created.content[0].text);
  const createdJson = JSON.parse(created.content[0].text);
  const taskId = createdJson.id;

  // The store still resolves the full row — the board's chips depend on it.
  const ownerView = store.getTask(taskId);
  assert.equal(ownerView.participants.length, 1);
  assert.equal(ownerView.participants[0].id, 7);
  assert.equal(ownerView.participants[0].avatar, avatar);

  // The agent echo keeps the participant identity and drops the bytes.
  assert.deepEqual(createdJson.participants, [{ id: 7, name: 'bot-7' }]);
  assert.equal('avatar' in createdJson.participants[0], false);
  assert.doesNotMatch(created.content[0].text, BASE64_RUN, 'create echo carries a base64 run');
  // Identity fields come back whole (the shaper only tore them because the
  // avatar blew the budget; without it the echo is well under any budget).
  assert.equal(createdJson.title, SPEC.title);
  assert.equal(createdJson.goal, SPEC.goal);
  assert.equal(createdJson.subtasks.length, 2);

  const taskEchoes = [
    ['longterm_task_activate', { taskId }],
    ['longterm_task_get', { taskId }],
    ['longterm_task_update', { taskId, title: 'Game hub v2' }],
    ['longterm_task_update', { taskId, action: 'pause', note: 'hold' }],
    ['longterm_task_update', { taskId, action: 'resume' }],
  ];
  for (const [name, args] of taskEchoes) {
    const result = await captured.get(name).handler(args);
    assert.equal(result.isError, undefined, `${name}: ${result.content[0].text}`);
    const text = result.content[0].text;
    assert.doesNotMatch(text, BASE64_RUN, `${name} echo carries a base64 run`);
    const json = JSON.parse(text);
    assert.deepEqual(json.participants, [{ id: 7, name: 'bot-7' }], `${name} participants`);
  }

  const board = await captured.get('longterm_task_list').handler({});
  assert.doesNotMatch(board.content[0].text, BASE64_RUN, 'list echo carries a base64 run');
  const boardJson = JSON.parse(board.content[0].text);
  assert.equal(boardJson.cards.length, 1);
  assert.deepEqual(boardJson.cards[0].participants, [{ id: 7, name: 'bot-7' }]);

  // completeTask returns the closed task through the same projection. The
  // delegate switch defaults ON at creation, so no toggle is needed here.
  const closed = await captured.get('longterm_task_complete').handler({
    taskId,
    summary: 'hub shipped',
    evidence: [{ kind: 'url', uri: 'https://x.example/hub' }],
  });
  assert.equal(closed.isError, undefined, closed.content[0].text);
  assert.doesNotMatch(closed.content[0].text, BASE64_RUN, 'complete echo carries a base64 run');
  assert.deepEqual(JSON.parse(closed.content[0].text).participants, [{ id: 7, name: 'bot-7' }]);
});

test('longterm_task_update pause/resume/cancel follow the shared result contract (bare value or Refused error)', async () => {
  const { store, captured } = await openWorldWithAvatar();
  const update = captured.get('longterm_task_update');
  const created = store.createTask(SPEC, 'owner');
  assert.ok(created.ok);
  const taskId = created.value.id;

  // pause from a draft is refused by the store — the tool surfaces it as an error result.
  const badPause = await update.handler({ taskId, action: 'pause' });
  assert.equal(badPause.isError, true);
  assert.match(badPause.content[0].text, /Refused \(VALIDATION\)/);

  assert.ok(store.activateTask(taskId, 'owner').ok);
  const paused = await update.handler({ taskId, action: 'pause', note: 'hold' });
  assert.equal(paused.isError, undefined);
  const pausedJson = JSON.parse(paused.content[0].text);
  assert.equal(pausedJson.id, taskId, 'pause returns the task itself, not a {ok,value} wrapper');
  assert.equal(pausedJson.stage, 'paused');
  assert.equal('ok' in pausedJson, false);

  const cancelled = await update.handler({ taskId, action: 'cancel', note: 'moot' });
  assert.equal(cancelled.isError, undefined);
  assert.equal(cancelled.content[0].text, 'Cancelled.');
  assert.equal(store.getTask(taskId).stage, 'cancelled');

  const cancelAgain = await update.handler({ taskId, action: 'cancel' });
  assert.equal(cancelAgain.isError, true);
  assert.match(cancelAgain.content[0].text, /Refused \(VALIDATION\)/);
});

/**
 * BUG-2 (bug report 2026-10-20): activation is the owner's sign-off, not the
 * start of work, so every sub-project is still `pending` afterwards — correct,
 * but it read as "activated and nothing moved". The activate / resume echoes
 * now state the next step instead of leaving it to be inferred.
 */
test('longterm_task_activate echo names the first beginnable sub-project as nextAction', async () => {
  const { store, captured } = await openWorld('en');
  const activate = captured.get('longterm_task_activate');
  assert.match(activate.description, /does NOT begin work/, 'description must say activation is not begin');
  const created = store.createTask(SPEC, 'owner');
  assert.ok(created.ok);
  const taskId = created.value.id;
  const [first, second] = created.value.subtasks;

  const activated = await activate.handler({ taskId });
  assert.equal(activated.isError, undefined, activated.content[0].text);
  const json = JSON.parse(activated.content[0].text);
  assert.equal(json.stage, 'active');
  // The derived focus is already populated (deriveCurrentSubtask); the DB pin stays null until begin.
  assert.equal(json.currentSubtaskId, first.id);
  assert.equal(json.currentSubtaskTitle, first.title);
  assert.equal(json.currentSubtaskStatus, 'pending');
  assert.equal(typeof json.nextAction, 'string');
  assert.match(json.nextAction, /longterm_subtask_begin/);
  assert.ok(json.nextAction.includes(first.id), `nextAction must name the first sub-project id: ${json.nextAction}`);
  assert.ok(json.nextAction.includes(first.title), `nextAction must name the first sub-project title: ${json.nextAction}`);
  assert.ok(!json.nextAction.includes(second.id), 'the dependency-blocked second sub-project is not the one to begin');

  // Once work is in flight, resume carries no nextAction — nothing to begin.
  assert.ok(store.beginSubtask(first.id, 'twin', 'delegate_bot').ok);
  const update = captured.get('longterm_task_update');
  const paused = await update.handler({ taskId, action: 'pause', note: 'hold' });
  assert.equal(paused.isError, undefined);
  assert.equal('nextAction' in JSON.parse(paused.content[0].text), false, 'pause never carries nextAction');
  const resumed = await update.handler({ taskId, action: 'resume' });
  assert.equal(resumed.isError, undefined);
  const resumedJson = JSON.parse(resumed.content[0].text);
  assert.equal(resumedJson.stage, 'active');
  assert.equal(resumedJson.currentSubtaskStatus, 'in_progress');
  assert.equal('nextAction' in resumedJson, false, 'resume with a sub-project in flight carries no nextAction');

  // Resume with everything still pending (paused before any begin) states the step again.
  const fresh = store.createTask(SPEC, 'owner');
  assert.ok(fresh.ok);
  assert.ok(store.activateTask(fresh.value.id, 'owner').ok);
  assert.ok(store.pauseTask(fresh.value.id, 'owner').ok);
  const resumedFresh = await update.handler({ taskId: fresh.value.id, action: 'resume' });
  assert.equal(resumedFresh.isError, undefined);
  assert.match(JSON.parse(resumedFresh.content[0].text).nextAction, /longterm_subtask_begin/);
});

test('longterm_task_activate nextAction reports a fully dependency-blocked plan instead of naming a sub-project', async () => {
  const { store, captured } = await openWorld('en');
  // createTask only validates ordinal range / self-reference; a 1 <-> 2 cycle
  // is accepted at creation and leaves nothing beginnable.
  const created = store.createTask(
    {
      title: 'Cyclic',
      goal: 'Two sub-projects that wait on each other.',
      subtasks: [
        { title: 'A', dependsOnOrdinals: [2] },
        { title: 'B', dependsOnOrdinals: [1] },
      ],
    },
    'owner',
  );
  assert.ok(created.ok, JSON.stringify(created));
  const activated = await captured.get('longterm_task_activate').handler({ taskId: created.value.id });
  assert.equal(activated.isError, undefined, activated.content[0].text);
  const json = JSON.parse(activated.content[0].text);
  assert.match(json.nextAction, /blocked by an unmet dependency/);
  assert.match(json.nextAction, /longterm_subtask_update/);
  assert.doesNotMatch(json.nextAction, /longterm_subtask_begin/);
});

/**
 * Lean agent echo (commit 4 of the 2026-10-20 bug-report branch). The runtime
 * spill-policy caps a tool result at 2048 ESTIMATED tokens — dsh-token-meter's
 * fixed density, ceil(chars / 4) + 4 per text block, CJK-blind — and tears
 * anything larger into head + "[...]" + tail text. The raw detail of a
 * 9-sub-project task was ~10K chars fresh (sub-projects 4–6 unreadable inline)
 * and ~19K at 40 events (4–9 unreadable). The echo must keep the whole roster
 * inline at every realistic journal length, while the store (owner channel)
 * keeps the full rows.
 */
const SPILL_CAP_ESTIMATED_TOKENS = 2048;
const estimateTextTokens = (text) => Math.ceil(text.length / 4) + 4;

const NINE_SUBPROJECT_SPEC = {
  title: 'IDBots 四周能力提升与长期任务板打磨计划',
  goal: '四周内（2026-10-19 至 2026-11-15）让 IDBots 的长期任务板在真实使用中稳定可靠：每个子项目都有可验证的验收标准，任务推进全程留痕。'.repeat(3),
  subtasks: Array.from({ length: 9 }, (_, i) => ({
    title: `子项目 ${i + 1}：完成第 ${i + 1} 阶段的交付物并通过验收`,
    description: `这一子项目的含义与边界说明，第 ${i + 1} 阶段的内容与验收方式。`.repeat(4),
    acceptanceCriteria: ['交付物已上链并可被第三方读取', '验收人确认无阻塞问题', '相关文档已更新'],
    ...(i > 0 ? { dependsOnOrdinals: [i] } : {}),
    preferredChannel: 'delegate_bot',
    expectedMinutes: 240,
  })),
};

test('task echoes keep a 9-sub-project roster inline under the spill cap, fresh and at the 200-event journal cap', async () => {
  const { store, captured } = await openWorld('en');
  const echo = async (name, args) => {
    const result = await captured.get(name).handler(args);
    assert.equal(result.isError, undefined, `${name}: ${result.content[0].text}`);
    const text = result.content[0].text;
    return { text, json: JSON.parse(text), tokens: estimateTextTokens(text) };
  };

  // Fresh task: create echo carries all nine sub-projects, well under the cap.
  const created = await echo('longterm_task_create', NINE_SUBPROJECT_SPEC);
  const taskId = created.json.id;
  const stored = store.getTask(taskId);
  assert.ok(created.tokens <= SPILL_CAP_ESTIMATED_TOKENS, `create echo ${created.text.length} chars ≈ ${created.tokens} tokens`);
  assert.equal(created.json.subtasks.length, 9);
  for (const [index, row] of created.json.subtasks.entries()) {
    assert.equal(row.id, stored.subtasks[index].id);
    assert.equal(row.title, stored.subtasks[index].title);
    assert.equal(row.ordinal, index + 1);
    assert.equal(row.status, 'pending');
    assert.deepEqual(row.acceptanceCriteria, stored.subtasks[index].acceptanceCriteria);
    assert.equal(row.description, stored.subtasks[index].description);
  }
  assert.equal(created.json.title, NINE_SUBPROJECT_SPEC.title);
  assert.equal(created.json.goal, NINE_SUBPROJECT_SPEC.goal);
  // Compact serialization: no indentation newlines.
  assert.equal(created.text.includes('\n  "'), false, 'echo is serialized compact');

  // Lean shape: empty members and nested redundancy are gone; values stay.
  const [first, second] = created.json.subtasks;
  assert.equal('taskId' in first, false, 'sub-project rows omit the parent id');
  assert.equal('createdAt' in first, false, 'sub-project rows omit row timestamps');
  assert.equal('evidence' in first, false, 'empty evidence is omitted');
  assert.equal('sessionHistory' in first, false);
  assert.equal('waitNote' in first, false);
  assert.equal('acceptedBy' in first, false);
  assert.equal('dependsOn' in first, false, 'no dependencies → key absent');
  assert.deepEqual(second.dependsOn, [first.id], 'real dependencies stay');
  assert.equal(first.expectedMinutes, 240);
  assert.equal('decisionSessionIds' in created.json, false, 'empty root lists are omitted');
  assert.equal(created.json.acceptanceDelegate, true, 'true is a value, not empty — the delegate switch defaults ON at creation');
  assert.equal(created.json.counts.accepted, 0, '0 is a value, not empty');
  assert.equal(created.json.progress.total, 9);
  assert.equal(typeof created.json.createdAt, 'string', 'the root keeps its timestamps');
  assert.equal(created.json.events.length, 1);
  assert.equal('taskId' in created.json.events[0], false, 'event rows omit the parent id');
  assert.equal(typeof created.json.events[0].createdAt, 'string', 'event rows keep their time');
  assert.equal('eventsOmitted' in created.json, false, 'nothing omitted on a one-event journal');
  // The store (owner channel) still carries the full rows.
  assert.deepEqual(stored.subtasks[0].evidence, []);
  assert.equal(stored.subtasks[0].taskId, taskId);

  const activated = await echo('longterm_task_activate', { taskId });
  assert.ok(activated.tokens <= SPILL_CAP_ESTIMATED_TOKENS, `activate echo ${activated.text.length} chars ≈ ${activated.tokens} tokens`);
  assert.equal(activated.json.subtasks.length, 9);
  assert.match(activated.json.nextAction, /longterm_subtask_begin/);

  // Standalone sub-project echo keeps the link back to its task, drops empties.
  const begun = await echo('longterm_subtask_begin', { subtaskId: first.id, channel: 'delegate_bot' });
  assert.equal(begun.json.taskId, taskId);
  assert.equal(begun.json.status, 'in_progress');
  assert.equal('evidence' in begun.json, false);

  // Journal past the detail's 200-event cap: the echo keeps the root and the
  // whole roster, fills the remaining budget with the newest rows, and says how
  // many more the detail held.
  for (let i = 0; i < 230; i += 1) {
    assert.ok(store.addNote(taskId, null, `journal entry ${i}: aligned the interface and acceptance wording with the worker, nothing blocking.`, 'twin').ok);
  }
  assert.equal(store.getTask(taskId).events.length, 200, 'owner-channel detail keeps the 200-event projection');
  const got = await echo('longterm_task_get', { taskId });
  assert.ok(got.tokens <= SPILL_CAP_ESTIMATED_TOKENS, `get echo at the journal cap: ${got.text.length} chars ≈ ${got.tokens} tokens`);
  assert.equal(got.json.subtasks.length, 9, 'the roster never yields to the journal');
  assert.equal(got.json.subtasks[0].status, 'in_progress');
  assert.equal(got.json.subtasks[8].id, stored.subtasks[8].id);
  assert.ok(got.json.events.length >= 10, `a ~100-char journal line leaves room for a real digest (got ${got.json.events.length})`);
  assert.equal(got.json.events.length + got.json.eventsOmitted, 200, 'shown + omitted = what the detail held');
  assert.match(got.json.events[0].detail, /journal entry 229/, 'newest first');
  assert.match(got.json.events.at(-1).detail, new RegExp(`journal entry ${230 - got.json.events.length}:`), 'a contiguous newest prefix — no gaps');
  assert.equal(got.json.events[0].actor, 'twin');
  assert.equal('taskId' in got.json.events[0], false);
  assert.equal('subtaskId' in got.json.events[0], false, 'a task-level event omits its null subtaskId');

  // Parked decision briefs land in the journal at up to 2,000 chars each; the
  // echo keeps each detail's head and still fits — the roster is never traded
  // for three briefs.
  for (let i = 0; i < 3; i += 1) {
    assert.ok(store.addNote(taskId, first.id, `brief ${i}: ${'背景与已完成进展：'.repeat(250)}`, 'twin').ok);
  }
  const briefed = await echo('longterm_task_get', { taskId });
  assert.ok(briefed.tokens <= SPILL_CAP_ESTIMATED_TOKENS, `get echo with 2K-char briefs: ${briefed.text.length} chars ≈ ${briefed.tokens} tokens`);
  assert.equal(briefed.json.subtasks.length, 9);
  assert.match(briefed.json.events[0].detail, /^brief 2: /);
  assert.match(briefed.json.events[0].detail, /… \(\+\d+ chars\)$/, 'a long detail is cut with a visible marker');
  assert.ok(briefed.json.events[0].detail.length < 300, `cut detail stays short (${briefed.json.events[0].detail.length})`);
  assert.equal(briefed.json.events[0].subtaskId, first.id, 'a sub-project-level event keeps its subtaskId');
  assert.ok(briefed.json.events.length >= 4, `briefs do not starve the digest (got ${briefed.json.events.length})`);
  assert.equal(store.getTask(taskId).events[0].detail.length, 2000, 'the journal itself keeps the full (store-capped) brief');

  // Board echo: one lean card, under the cap, no avatar, goal intact.
  const board = await echo('longterm_task_list', {});
  assert.ok(board.tokens <= SPILL_CAP_ESTIMATED_TOKENS, `list echo ${board.text.length} chars`);
  assert.equal(board.json.cards.length, 1);
  assert.equal(board.json.cards[0].id, taskId);
  assert.equal(board.json.cards[0].goal, NINE_SUBPROJECT_SPEC.goal);
  assert.equal('subtasks' in board.json.cards[0], false, 'cards are summaries');
  assert.equal('decisionSessionIds' in board.json.cards[0], false);
});

test('longterm_task_create echoes the plan page URI; a missing artifact gets an explicit reminder, not a refusal', async () => {
  const { store, captured } = await openWorld();
  const create = captured.get('longterm_task_create');

  // With the plan page: the URI rides the echo and lands on the store.
  const withPage = await create.handler({ ...SPEC, planArtifactUri: '/tmp/approved-plan.html' });
  assert.equal(withPage.isError, undefined, withPage.content[0].text);
  const withPageJson = JSON.parse(withPage.content[0].text);
  assert.equal(withPageJson.planArtifactUri, '/tmp/approved-plan.html');
  assert.equal('planArtifactReminder' in withPageJson, false);
  assert.equal(store.getTask(withPageJson.id).planArtifactUri, '/tmp/approved-plan.html');

  // Without it: the create still succeeds (the owner may order a skip), but
  // the echo says so out loud — silence must not pass as consent.
  const withoutPage = await create.handler({ ...SPEC });
  assert.equal(withoutPage.isError, undefined, withoutPage.content[0].text);
  const withoutPageJson = JSON.parse(withoutPage.content[0].text);
  assert.equal(withoutPageJson.planArtifactUri, undefined, 'an absent plan artifact is dropped from the echo');
  assert.match(withoutPageJson.planArtifactReminder, /plan page/i);
  assert.match(withoutPageJson.planArtifactReminder, /longterm_task_update/);

  // The URI is backfillable after the fact via longterm_task_update.
  const updated = await captured.get('longterm_task_update').handler({ taskId: withoutPageJson.id, planArtifactUri: '/tmp/late-plan.html' });
  assert.equal(updated.isError, undefined, updated.content[0].text);
  assert.equal(JSON.parse(updated.content[0].text).planArtifactUri, '/tmp/late-plan.html');
});

test('longterm_task_create defaults definitionSessionId to the mounted session (2026-11-08 fork incident)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-lt-defsession-'));
  const sqliteStore = await SqliteStore.create(dir);
  const store = new LongTermTaskStore(sqliteStore.getDatabase(), sqliteStore.getSaveFunction());
  const captured = new Map();
  const toolFactory = (name, description, schema, handler) => {
    captured.set(name, { description, handler });
    return { name };
  };
  buildLongTermTaskAgentTools({
    tool: toolFactory,
    control: { store: () => store, getAppLanguage: () => 'en' },
    sessionId: 'sess-owner-chat',
  });
  const create = captured.get('longterm_task_create');

  // The model omits definitionSessionId → the birth session is recorded
  // anyway. This is the load-bearing case: without it the task's birth
  // conversation is invisible to the heartbeat venue rules and every
  // escalation forks a fresh session away from the owner's chat.
  const omitted = await create.handler({ ...SPEC });
  assert.equal(omitted.isError, undefined, omitted.content[0].text);
  const omittedJson = JSON.parse(omitted.content[0].text);
  assert.equal(store.getTask(omittedJson.id).definitionSessionId, 'sess-owner-chat');

  // An explicit id still wins (plan discussed in a different session).
  const explicit = await create.handler({ ...SPEC, definitionSessionId: 'sess-elsewhere' });
  assert.equal(explicit.isError, undefined, explicit.content[0].text);
  const explicitJson = JSON.parse(explicit.content[0].text);
  assert.equal(store.getTask(explicitJson.id).definitionSessionId, 'sess-elsewhere');

  // A blank-string arg must not shadow the mounted session either.
  const blank = await create.handler({ ...SPEC, definitionSessionId: '   ' });
  assert.equal(blank.isError, undefined, blank.content[0].text);
  const blankJson = JSON.parse(blank.content[0].text);
  assert.equal(store.getTask(blankJson.id).definitionSessionId, 'sess-owner-chat');
});
