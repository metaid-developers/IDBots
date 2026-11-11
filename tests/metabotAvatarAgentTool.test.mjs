import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const { buildMetabotManageAgentTools } = await import(
  '../dist-electron/main/libs/metabotManageAgentTools.js'
);

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REAL_PNG = fs.readFileSync(path.join(projectRoot, 'build', 'icons', 'png', '16x16.png'));
const REAL_PNG_DATA_URL = `data:image/png;base64,${REAL_PNG.toString('base64')}`;

function makeHarness() {
  const calls = { create: [], update: [] };
  const control = {
    create: async (input) => {
      calls.create.push(input);
      return {
        success: true,
        metabot: {
          id: 7,
          name: input.name,
          metabot_type: 'worker',
          llm_id: input.llm_id,
          globalmetaid: 'gmid-7',
          mvc_address: 'mvc-addr-7',
        },
      };
    },
    update: async (id, input) => {
      calls.update.push({ id, input });
      return {
        success: true,
        metabot: { id, name: input.name ?? 'Alice' },
        sync: { skipped: false, success: true, txids: ['tx-1'] },
      };
    },
    delete: async () => ({ success: true }),
    list: () => [
      {
        id: 1,
        name: 'Alice',
        type: 'twin',
        enabled: true,
        llm_id: 'deepseek',
        fallback_llm_id: null,
        role: 'Boss',
        bio: null,
        goal: null,
        allow_chat_skills: [],
        a2a_max_incoming_turns: null,
        a2a_bye_cooldown_ms: null,
        a2a_auto_reply_enabled: null,
        globalMetaID: 'gmid-alice',
      },
    ],
    listProviders: () => [{ id: 'deepseek', label: 'Deepseek' }],
    getOwnerGlobalMetaId: () => 'gmid-owner-1',
  };
  const tools = buildMetabotManageAgentTools({
    tool: (name, description, schema, handler) => ({ name, description, schema, handler }),
    control,
  });
  return { calls, byName: Object.fromEntries(tools.map((tool) => [tool.name, tool])) };
}

const textOf = (result) => result.content[0].text;

async function withServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

/** A URL that is deterministically refused (port bound then released). */
async function unreachableUrl() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return `http://127.0.0.1:${port}/avatar.png`;
}

const servePng = (req, res) => {
  res.writeHead(200, { 'content-type': 'image/png' });
  res.end(REAL_PNG);
};

// ---------------------------------------------------------------------------
// tool descriptions must match the implementation (root-cause consistency)
// ---------------------------------------------------------------------------

test('avatar tool descriptions advertise exactly what is implemented', () => {
  const { byName } = makeHarness();
  for (const toolName of ['metabot_create', 'metabot_update']) {
    const description = byName[toolName].schema.avatar.description;
    assert.match(description, /data:image\/png\|jpeg\|webp\|gif;base64/, `${toolName}: data URL`);
    assert.match(description, /http\(s\) image URL/, `${toolName}: http(s) support`);
    assert.match(description, /absolute local image path/, `${toolName}: local path support`);
    assert.match(description, /normalized to a data URL/, `${toolName}: normalization contract`);
  }
  // metabot_update must still document the clear semantics.
  assert.match(byName.metabot_update.schema.avatar.description, /Empty string clears/);
});

// ---------------------------------------------------------------------------
// metabot_create
// ---------------------------------------------------------------------------

test('metabot_create: an http(s) avatar is normalized to a data URL before creation', async () => {
  const { byName, calls } = makeHarness();
  await withServer(servePng, async (base) => {
    const res = await byName.metabot_create.handler({
      name: 'Worker',
      llm_id: 'deepseek',
      avatar: `${base}/avatar.png`,
    });
    assert.equal(res.isError, undefined);
    assert.equal(calls.create.length, 1);
    assert.equal(calls.create[0].avatar, REAL_PNG_DATA_URL);
    assert.doesNotMatch(textOf(res), /avatar was skipped/);
  });
});

test('metabot_create: a local image path is normalized to a data URL', async () => {
  const { byName, calls } = makeHarness();
  const res = await byName.metabot_create.handler({
    name: 'Worker',
    llm_id: 'deepseek',
    avatar: path.join(projectRoot, 'build', 'icons', 'png', '16x16.png'),
  });
  assert.equal(res.isError, undefined);
  assert.equal(calls.create[0].avatar, REAL_PNG_DATA_URL);
});

test('metabot_create: an unreachable avatar URL never blocks creation (degraded + reported)', async () => {
  const { byName, calls } = makeHarness();
  const url = await unreachableUrl();
  const res = await byName.metabot_create.handler({ name: 'Worker', llm_id: 'deepseek', avatar: url });
  assert.equal(res.isError, undefined, 'creation must not fail because the avatar could not be fetched');
  assert.equal(calls.create.length, 1);
  assert.equal(calls.create[0].avatar, undefined);
  assert.match(textOf(res), /avatar was skipped \(fetch-failed/);
  assert.match(textOf(res), /MetaBot created: Worker/);
});

test('metabot_create: omitting the avatar still works unchanged', async () => {
  const { byName, calls } = makeHarness();
  const res = await byName.metabot_create.handler({ name: 'Worker', llm_id: 'deepseek' });
  assert.equal(res.isError, undefined);
  assert.equal(calls.create[0].avatar, undefined);
  assert.doesNotMatch(textOf(res), /avatar was skipped/);
});

// ---------------------------------------------------------------------------
// metabot_update
// ---------------------------------------------------------------------------

test('metabot_update: an http(s) avatar is normalized to a data URL before the update', async () => {
  const { byName, calls } = makeHarness();
  await withServer(servePng, async (base) => {
    const res = await byName.metabot_update.handler({
      metabot_id: 1,
      avatar: `${base}/avatar.png`,
    });
    assert.equal(res.isError, undefined);
    assert.equal(calls.update.length, 1);
    assert.equal(calls.update[0].input.avatar, REAL_PNG_DATA_URL);
    assert.doesNotMatch(textOf(res), /avatar was NOT changed/);
  });
});

test('metabot_update: a valid data URL passes through unchanged', async () => {
  const { byName, calls } = makeHarness();
  const res = await byName.metabot_update.handler({ metabot_id: 1, avatar: REAL_PNG_DATA_URL });
  assert.equal(res.isError, undefined);
  assert.equal(calls.update[0].input.avatar, REAL_PNG_DATA_URL);
});

test('metabot_update: an empty avatar string still clears the avatar', async () => {
  const { byName, calls } = makeHarness();
  const res = await byName.metabot_update.handler({ metabot_id: 1, avatar: '' });
  assert.equal(res.isError, undefined);
  assert.equal(calls.update[0].input.avatar, '');
});

test('metabot_update: a failed avatar normalization leaves it unchanged but applies other fields', async () => {
  const { byName, calls } = makeHarness();
  const url = await unreachableUrl();
  const res = await byName.metabot_update.handler({ metabot_id: 1, name: 'Renamed', avatar: url });
  assert.equal(res.isError, undefined, 'the rest of the update must not be blocked by a bad avatar');
  assert.equal(calls.update.length, 1);
  assert.equal(calls.update[0].input.name, 'Renamed');
  assert.equal('avatar' in calls.update[0].input, false, 'avatar must be left untouched');
  assert.match(textOf(res), /avatar was NOT changed \(fetch-failed/);
});

test('metabot_update: a bad avatar as the only field reports the reason and is an error', async () => {
  const { byName, calls } = makeHarness();
  const url = await unreachableUrl();
  const res = await byName.metabot_update.handler({ metabot_id: 1, avatar: url });
  assert.equal(res.isError, true);
  assert.equal(calls.update.length, 0);
  assert.match(textOf(res), /applied nothing/);
  assert.match(textOf(res), /avatar was NOT changed \(fetch-failed/);
});

test('metabot_update: a malformed data URL is rejected before the sync validator can throw', async () => {
  const { byName, calls } = makeHarness();
  const res = await byName.metabot_update.handler({
    metabot_id: 1,
    name: 'Renamed',
    avatar: 'data:text/plain;base64,aGVsbG8=',
  });
  assert.equal(res.isError, undefined);
  assert.equal(calls.update[0].input.name, 'Renamed');
  assert.equal('avatar' in calls.update[0].input, false);
  assert.match(textOf(res), /avatar was NOT changed \(invalid-data-url/);
});

test('metabot_update: a non-string avatar value is never treated as an explicit clear', async () => {
  const { byName, calls } = makeHarness();
  const res = await byName.metabot_update.handler({ metabot_id: 1, name: 'Renamed', avatar: 123 });
  assert.equal(res.isError, undefined);
  assert.equal(calls.update[0].input.name, 'Renamed');
  assert.equal('avatar' in calls.update[0].input, false);
  assert.match(textOf(res), /avatar was NOT changed \(unsupported value/);
});


test('metabot_update forwards an NFT reference to the ownership-checked core without image normalization', async () => {
  const { byName, calls } = makeHarness();
  const reference = `nft://mrc721/${'aa'.repeat(32)}i0`;
  const result = await byName.metabot_update.handler({ metabot_id: 1, avatar: reference });
  assert.equal(result.isError, undefined);
  assert.equal(calls.update.length, 1);
  assert.equal(calls.update[0].input.avatar, reference);
});
