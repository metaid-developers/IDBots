import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = Module.createRequire(import.meta.url);
const { createStudioGenesisStageService } = require('../dist-electron/main/services/studioGenesisStageService.js');
const { createStudioLiveStageService } = require('../dist-electron/main/services/studioLiveStageService.js');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const message = (id, type, extra = {}) => ({ id, type, content: '', timestamp: 1, metadata: {}, ...extra });

function fixture(t, options = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-genesis-'));
  t.after(() => {
    service.dispose();
    try { fs.rmSync(cwd, { recursive: true, force: true }); } catch { /* OS sweeps temp dirs */ }
  });
  const session = { cwd, sessionType: 'browser', assistantMode: true, metabotId: 7, metabotName: 'Pixel', metabotAvatar: 'data:image/png;base64,AA==', ...options.session };
  const projected = [], patches = [], submissions = [], drainQueue = [];
  let projectFailures = options.projectFailures ?? 0;
  const settings = { enabled: options.enabled ?? true, directorEnabled: false };
  const service = createStudioGenesisStageService({
    getSession: () => session,
    getMetabotById: () => ({ name: 'Pixel', globalmetaid: 'idq1genesis' }),
    getSettings: () => settings,
    getLanguage: () => 'en',
    project: async (input) => {
      if (projectFailures > 0) { projectFailures -= 1; throw new Error('browser not mounted'); }
      projected.push(input);
      return { uri: `preview-metaapp://localhost${input.localPath}`, tabId: 11, announced: true };
    },
    runScript: async ({ script }) => {
      const patch = script.match(/applyPatch\((\{[\s\S]*\})\);\n  return \{ ok: true \}/);
      if (patch) { patches.push(JSON.parse(patch[1])); return { ok: true }; }
      if (script.includes('drainActions')) return { ok: true, items: drainQueue.splice(0, drainQueue.length) };
      return null;
    },
    submitTurn: async (input) => { submissions.push(input); return options.submitOk ?? true; },
    assets: { genesisRoot: path.resolve('public/genesis-stage'), orbRoot: path.resolve('public/live-stage'), fallbackAvatarDataUri: 'data:image/png;base64,AA==' },
    fallbackAvatarDataUri: 'data:image/png;base64,AA==',
    timing: { patchMs: 5, pollMs: 5, retryMs: 5, retryLimit: 5, outroMs: 30 },
  });
  const last = () => patches[patches.length - 1];
  return { service, session, projected, patches, submissions, drainQueue, last, settings };
}

test('claimGreeting projects one Genesis page for Studio sessions only', async (t) => {
  const f = fixture(t);
  assert.equal(f.service.claimGreeting('s1'), true);
  assert.equal(f.service.claimGreeting('s1'), true);
  await wait(20);
  assert.equal(f.projected.length, 1);
  assert.match(f.projected[0].localPath, /reports\/genesis-s1\.html$/);
  assert.equal(f.projected[0].title, 'Pixel · Genesis');
  const html = fs.readFileSync(f.projected[0].localPath, 'utf8');
  assert.match(html, /"protocol":"idbots\.genesis-stage\.v1"/);
  assert.match(html, /"globalMetaId":"idq1genesis"/);
  assert.equal(f.service.isClaimed('s1'), true);

  const standard = fixture(t, { session: { sessionType: 'standard' } });
  assert.equal(standard.service.claimGreeting('s2'), false);
  const disabled = fixture(t, { enabled: false });
  assert.equal(disabled.service.claimGreeting('s3'), false);
});

test('projection retries while the Studio browser is still mounting', async (t) => {
  const f = fixture(t, { projectFailures: 2 });
  f.service.claimGreeting('s1');
  await wait(60);
  assert.equal(f.projected.length, 1);
});

test('streamed greeting text reaches the page as stable segments, then the invite', async (t) => {
  const f = fixture(t);
  f.service.claimGreeting('s1');
  await wait(15);
  f.service.observeMessage('s1', message('a1', 'assistant', { content: 'Hi there, welcome to the AI Internet! I am' }));
  f.service.observeMessageUpdate('s1', 'a1', 'Hi there, welcome to the AI Internet! I am your Twin Bot, your on-chain companion. Give me');
  await wait(30);
  assert.deepEqual(f.last().turn.segments.map((segment) => segment.text), [
    'Hi there, welcome to the AI Internet!',
    'I am your Twin Bot, your on-chain companion.',
  ]);
  assert.equal(f.last().invite, null);

  f.service.observeMessageUpdate('s1', 'a1', 'Hi there, welcome to the AI Internet! I am your Twin Bot, your on-chain companion. Give me a name!');
  f.service.observeComplete('s1');
  await wait(30);
  const state = f.last();
  assert.equal(state.turn.complete, true);
  assert.equal(state.turn.segments.length, 3);
  assert.equal(state.phase, 'invite');
  assert.match(state.invite.token, /^[0-9a-f]{24}$/);
  const snapshot = fs.readFileSync(path.join(f.session.cwd, 'reports', 'genesis-s1.html'), 'utf8');
  assert.match(snapshot, /"intro":"skip"/);
  assert.match(snapshot, /"invite":null/);
});

test('a tour click submits one visible turn whose reply becomes the four scenes', async (t) => {
  const f = fixture(t);
  f.service.claimGreeting('s1');
  await wait(15);
  f.service.observeMessage('s1', message('a1', 'assistant', { content: 'Welcome!' }));
  f.service.observeComplete('s1');
  await wait(20);
  const token = f.last().invite.token;
  f.drainQueue.push({ token: 'forged', choice: 'tour' }, { token, choice: 'tour' }, { token, choice: 'tour' });
  await wait(40);
  assert.equal(f.submissions.length, 1);
  assert.equal(f.submissions[0].text, 'Sure — show me what IDBots and the AI Internet are about!');
  assert.match(f.submissions[0].submissionId, /^[0-9a-f-]{36}$/);
  assert.equal(f.last().phase, 'tour');
  assert.equal(f.last().invite, null);

  const tourId = f.submissions[0].submissionId;
  f.service.observeMessage('s1', message(tourId, 'user', { content: 'Sure', metadata: { submissionId: tourId } }));
  await wait(15);
  assert.equal(f.last().listening, true);
  f.service.observeMessage('s1', message('a2', 'assistant', { content: '**Identity**: yours forever.\n\n**Create**: publish.\n\n**Together**: collaborate.\n\n**Evolve**: learn.' }));
  f.service.observeComplete('s1');
  await wait(30);
  const state = f.last();
  assert.equal(state.turn.kind, 'tour');
  assert.deepEqual(state.turn.tour.parts.map((part) => part.title), ['Identity', 'Create', 'Together', 'Evolve']);
  assert.equal(state.phase, 'settled');
  assert.equal(f.service.isClaimed('s1'), true, 'the settled welcome keeps the stage until the next turn');

  f.service.observeMessage('s1', message('u3', 'user', { content: 'Search the news' }));
  assert.equal(f.service.isClaimed('s1'), false);
  await wait(10);
  assert.equal(f.last().phase, 'handoff');
});

test('Later concludes the welcome and the next owner message hands off', async (t) => {
  const f = fixture(t);
  f.service.claimGreeting('s1');
  await wait(15);
  f.service.observeMessage('s1', message('a1', 'assistant', { content: 'Welcome!' }));
  f.service.observeComplete('s1');
  await wait(20);
  f.drainQueue.push({ token: f.last().invite.token, choice: 'later' });
  await wait(30);
  assert.equal(f.last().phase, 'settled');
  assert.equal(f.submissions.length, 0);
  f.service.observeMessage('s1', message('u2', 'user', { content: 'hello' }));
  const handoff = f.service.beforeLiveStageProjection('s1');
  assert.ok(handoff instanceof Promise);
  const started = Date.now();
  await handoff;
  assert.ok(Date.now() - started >= 25, 'the outro plays before the Live Stage projects');
  assert.equal(f.last().phase, 'handoff');
});

test('talk-only turns stay on the Genesis Stage and a rename plays the naming ceremony', async (t) => {
  const f = fixture(t);
  f.service.claimGreeting('s1');
  await wait(15);
  f.service.observeMessage('s1', message('u1', 'user', { content: 'Call yourself Nova' }));
  f.service.observeMessage('s1', message('t1', 'tool_use', { metadata: { toolName: 'mcp__idbots__metabot_list', toolUseId: 't1' } }));
  f.service.observeMessage('s1', message('t2', 'tool_use', { metadata: { toolName: 'metabot_update', toolUseId: 't2', toolInput: { metabot_id: 7, name: 'Nova' } } }));
  f.service.observeMessage('s1', message('t2r', 'tool_result', { metadata: { toolUseId: 't2', isError: false } }));
  await wait(20);
  assert.equal(f.service.isClaimed('s1'), true);
  assert.deepEqual(f.last().naming, { name: 'Nova', eventId: 't2' });
  assert.equal(f.last().botName, 'Nova');

  f.service.observeMessage('s1', message('t3', 'tool_use', { metadata: { toolName: 'metabot_update', toolUseId: 't3', toolInput: { metabot_id: 9, name: 'Other' } } }));
  f.service.observeMessage('s1', message('t3r', 'tool_result', { metadata: { toolUseId: 't3' } }));
  await wait(15);
  assert.equal(f.last().botName, 'Nova', 'renaming another bot is not a naming ceremony');
});

test('a work tool releases the session mid-turn', async (t) => {
  const f = fixture(t);
  f.service.claimGreeting('s1');
  await wait(15);
  f.service.observeMessage('s1', message('u1', 'user', { content: 'Find me today\'s news' }));
  f.service.observeMessage('s1', message('t1', 'tool_use', { metadata: { toolName: 'web_search', toolUseId: 't1' } }));
  assert.equal(f.service.isClaimed('s1'), false);
  await f.service.beforeLiveStageProjection('s1');
  assert.equal(f.last().phase, 'handoff');
  const patchesBefore = f.patches.length;
  f.service.observeMessage('s1', message('a1', 'assistant', { content: 'Here are the headlines.' }));
  await wait(20);
  assert.equal(f.patches.length, patchesBefore, 'a released session no longer patches the Genesis page');
});

test('a failed tour submission settles the welcome instead of waiting forever', async (t) => {
  const f = fixture(t, { submitOk: false });
  f.service.claimGreeting('s1');
  await wait(15);
  f.service.observeComplete('s1');
  await wait(20);
  f.drainQueue.push({ token: f.last().invite.token, choice: 'tour' });
  await wait(40);
  assert.equal(f.last().phase, 'settled');
});

test('a reused tab id that shows another session is re-resolved, and its clicks are left alone', async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-genesis-tabs-'));
  const session = { cwd, sessionType: 'browser', assistantMode: true, metabotId: 7, metabotName: 'Pixel' };
  // Tab 11 still shows an older session's Genesis page; tab 12 is ours.
  const pages = { 11: { session: 'older', queue: [{ token: 'older-token', choice: 'tour' }], patches: [] }, 12: { session: 's1', queue: [], patches: [] } };
  const service = createStudioGenesisStageService({
    getSession: () => session,
    getMetabotById: () => ({ name: 'Pixel' }),
    getSettings: () => ({ enabled: true, directorEnabled: false }),
    getLanguage: () => 'en',
    project: async (input) => ({ uri: `preview-metaapp://localhost${input.localPath}`, tabId: 11, announced: true }),
    getStageTab: async () => 12,
    runScript: async ({ tabId, script }) => {
      const page = pages[tabId];
      const expected = JSON.parse(script.match(/getState\(\)\.sessionId !== ("[^"]*")/)[1]);
      if (page.session !== expected) return { ok: false, reason: 'session-mismatch', items: [] };
      const patch = script.match(/applyPatch\((\{[\s\S]*\})\);\n  return \{ ok: true \}/);
      if (patch) { page.patches.push(JSON.parse(patch[1])); return { ok: true }; }
      return { ok: true, items: page.queue.splice(0, page.queue.length) };
    },
    submitTurn: async () => true,
    assets: { genesisRoot: path.resolve('public/genesis-stage'), orbRoot: path.resolve('public/live-stage'), fallbackAvatarDataUri: 'data:image/png;base64,AA==' },
    fallbackAvatarDataUri: 'data:image/png;base64,AA==',
    timing: { patchMs: 5, pollMs: 5, retryMs: 5, retryLimit: 5, outroMs: 10 },
  });
  t.after(() => {
    service.dispose();
    try { fs.rmSync(cwd, { recursive: true, force: true }); } catch { /* OS sweeps temp dirs */ }
  });
  service.claimGreeting('s1');
  await wait(20);
  service.observeMessage('s1', message('a1', 'assistant', { content: 'Welcome aboard!' }));
  service.observeComplete('s1');
  await wait(60);
  assert.equal(pages[11].patches.length, 0, 'never patches the other session page');
  assert.ok(pages[12].patches.length > 0, 'patches land on the re-resolved tab');
  assert.equal(pages[12].patches.at(-1).phase, 'invite');
  assert.deepEqual(pages[11].queue, [{ token: 'older-token', choice: 'tour' }], 'the other page keeps its clicks');
});

test('the Live Stage skips claimed sessions and waits for the Genesis outro', async (t) => {
  const g = fixture(t);
  const stageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-genesis-liveroot-'));
  const projected = [];
  const live = createStudioLiveStageService({
    getSession: () => g.session,
    getMetabotById: () => ({ name: 'Pixel' }),
    getSettings: () => ({ enabled: true, directorEnabled: false }),
    getLanguage: () => 'en',
    project: async (input) => { projected.push({ input, at: Date.now() }); return { uri: 'x', tabId: 11, announced: true }; },
    getStageTab: async () => ({ id: 11, uri: null }),
    applyPatch: async () => {},
    stageRoot,
    assetRoot: path.resolve('public/live-stage'),
    fallbackAvatarDataUri: 'data:image/png;base64,AA==',
    isSessionClaimed: (sessionId) => g.service.isClaimed(sessionId),
    beforeProjection: (sessionId) => g.service.beforeLiveStageProjection(sessionId),
  });
  t.after(() => {
    live.dispose();
    try { fs.rmSync(stageRoot, { recursive: true, force: true }); } catch { /* OS sweeps temp dirs */ }
  });
  g.service.claimGreeting('s1');
  await wait(15);
  live.prepareSession('s1');
  live.observeMessage('s1', message('u1', 'user', { content: 'hi' }));
  await wait(15);
  assert.equal(projected.length, 0, 'claimed: the Genesis Stage owns the projector');

  const releasedAt = Date.now();
  const toolUse = message('t1', 'tool_use', { metadata: { toolName: 'web_search', toolUseId: 't1' } });
  g.service.observeMessage('s1', toolUse);
  live.observeMessage('s1', toolUse);
  await wait(80);
  assert.equal(projected.length, 1);
  assert.ok(projected[0].at - releasedAt >= 25, 'the Live Stage projects after the outro');
  assert.match(projected[0].input.localPath, /-[0-9a-f]{12}[\\/]stage\.html$/, 'the Live Stage projects the persistent entry, not a per-turn file');
  assert.equal(projected[0].input.role, 'stage', 'stage projections bind the stage role');
});
