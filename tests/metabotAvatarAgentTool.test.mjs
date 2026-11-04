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
    assert.match(description, /metafile:\/\/<pinId>/, `${toolName}: metafile reference support`);
    assert.match(description, /bare pinId/, `${toolName}: bare pin id support`);
    assert.match(description, /thumbnail variant is fetched first/, `${toolName}: thumbnail-first contract`);
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

test('metabot_update: an oversized metafile cover degrades with a note and never aborts the update', async () => {
  const originalFetch = globalThis.fetch;
  const pinId = '6c45ca74504db05b0a2cf0378f76126c8ce7819c4bec0f60c593f772d600b542i0';
  globalThis.fetch = async () => {
    // A gateway that ignores `process=thumbnail` and serves the ~0.9 MB cover.
    const buffer = Buffer.alloc(877_125);
    buffer[0] = 0xff;
    buffer[1] = 0xd8;
    buffer[2] = 0xff;
    return new Response(buffer, { status: 200, headers: { 'content-type': 'image/jpeg' } });
  };
  try {
    const { byName, calls } = makeHarness();
    const res = await byName.metabot_update.handler({
      metabot_id: 1,
      name: 'Renamed',
      avatar: `metafile://${pinId}.jpg`,
    });
    assert.equal(res.isError, undefined, 'the rest of the update must not be blocked by an oversized cover');
    assert.equal(calls.update.length, 1);
    assert.equal(calls.update[0].input.name, 'Renamed');
    assert.equal('avatar' in calls.update[0].input, false, 'avatar must be left unchanged');
    assert.match(textOf(res), /avatar was NOT changed \(too-large/);
    assert.match(textOf(res), /877125 bytes/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('metabot_create/update: a metafile:// NFT cover resolves through the thumbnail route', async () => {
  // The metafile branch builds fixed public-gateway URLs, so the only seam the
  // tool path exposes is the global fetch. Swap it for the duration of the test
  // (restored in finally) — this keeps the agent-tool seam hermetic.
  const originalFetch = globalThis.fetch;
  const pinId = '14158a127fa1d7b66d821413abad64bc833cf145e7abd2b40838fde703609b45i0';
  const requests = [];
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    if (!String(url).includes('process=thumbnail')) {
      return new Response('missing', { status: 404 });
    }
    const buffer = Buffer.alloc(13_250);
    buffer[0] = 0xff;
    buffer[1] = 0xd8;
    buffer[2] = 0xff;
    return new Response(buffer, { status: 200, headers: { 'content-type': 'image/jpeg' } });
  };
  try {
    const { byName, calls } = makeHarness();
    const update = await byName.metabot_update.handler({ metabot_id: 1, avatar: `metafile://${pinId}.jpg` });
    assert.equal(update.isError, undefined);
    assert.equal(calls.update.length, 1);
    assert.match(calls.update[0].input.avatar, /^data:image\/jpeg;base64,/);
    assert.equal(
      Buffer.from(calls.update[0].input.avatar.split(',')[1], 'base64').length,
      13_250,
      'the stored snapshot is the thumbnail rendering, not the 877 KB original',
    );
    assert.match(requests[0], /process=thumbnail/);

    const create = await byName.metabot_create.handler({ name: 'Worker', llm_id: 'deepseek', avatar: pinId });
    assert.equal(create.isError, undefined);
    assert.equal(calls.create.length, 1);
    assert.match(calls.create[0].avatar, /^data:image\/jpeg;base64,/);
    assert.doesNotMatch(textOf(create), /avatar was skipped/);
  } finally {
    globalThis.fetch = originalFetch;
  }
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
