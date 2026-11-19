import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const require = Module.createRequire(import.meta.url);
const { buildOmniCasterAgentTools, formatCastResult } = require('../dist-electron/main/libs/omniCasterAgentTools.js');

const SESSION_ID = 'sess-cast-1';
const METABOT_ID = 42;

const SAMPLE_PIN_RESULT = { txids: ['tx-cast-1'], pinId: 'tx-cast-1i0', totalCost: 777 };

function makeFixtureFile(name, contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-cast-test-'));
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, contents);
  return filePath;
}

function makeHarness(overrides = {}) {
  const calls = { createPin: [], encrypt: [], resolve: [] };
  const createPin = async (metabotId, metaidData, options) => {
    calls.createPin.push({ metabotId, metaidData, options });
    if (overrides.createPinError) throw overrides.createPinError;
    return overrides.pinResult ?? SAMPLE_PIN_RESULT;
  };
  const encryptGroupMessage = (message, groupId) => {
    calls.encrypt.push({ message, groupId });
    return `enc:${message}`;
  };
  const resolveMetabotId = (sessionId) => {
    calls.resolve.push(sessionId);
    // Honor an explicit `metabotId` override (including undefined/null); only
    // fall back to the default when the harness did not specify one.
    return 'metabotId' in overrides ? overrides.metabotId : METABOT_ID;
  };
  const tools = buildOmniCasterAgentTools({
    tool: (name, description, schema, handler) => ({ name, description, handler }),
    createPin,
    encryptGroupMessage,
    sessionId: SESSION_ID,
    resolveMetabotId,
    gateLocalFile: overrides.gateLocalFile,
  });
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  return { calls, byName };
}

test('payload_file outside the workspace is blocked when the gate denies it', async () => {
  const secret = makeFixtureFile('id_rsa', 'secret');
  const { calls, byName } = makeHarness({
    gateLocalFile: async (filePath) => (filePath === secret
      ? `Owner declined to upload a file outside the session workspace: ${filePath}`
      : null),
  });
  const result = await byName.omni_cast.handler({ path: '/file', payload_file: secret });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Owner declined to upload a file outside the session workspace/);
  assert.equal(calls.createPin.length, 0);
});

test('builds a single omni_cast tool', () => {
  const { byName } = makeHarness();
  assert.ok(byName.omni_cast);
  assert.equal(Object.keys(byName).length, 1);
});

test('casts a JSON payload pin with the default 7-tuple', async () => {
  const { calls, byName } = makeHarness();
  const result = await byName.omni_cast.handler({
    path: '/protocols/paylike',
    payload: '{ "isLike": 1, "likeTo": "pinXYZi0" }',
  });
  assert.deepEqual(calls.resolve, [SESSION_ID]);
  assert.equal(calls.createPin.length, 1);
  const call = calls.createPin[0];
  assert.equal(call.metabotId, METABOT_ID);
  assert.deepEqual(call.metaidData, {
    operation: 'create',
    path: '/protocols/paylike',
    encryption: '0',
    version: '1.0',
    contentType: 'application/json',
    payload: JSON.stringify({ isLike: 1, likeTo: 'pinXYZi0' }),
  });
  assert.deepEqual(call.options, { network: 'mvc', origin: `tool:omni_cast#s=${SESSION_ID}` });
  const text = result.content[0].text;
  assert.equal(result.isError, undefined);
  assert.match(text, /txid: tx-cast-1/);
  assert.match(text, /pinId: tx-cast-1i0/);
  assert.match(text, /cost: 777 sats/);
  assert.match(text, /view link: \[pin:\/\/tx-cast-1i0\]\(pin:\/\/tx-cast-1i0\)/);
  assert.doesNotMatch(text, /openagentinternet|metaid\.io/);
});

test('forwards operation and network overrides', async () => {
  const { calls, byName } = makeHarness();
  await byName.omni_cast.handler({
    path: '/protocols/paycomment',
    payload: '{"content":"ok"}',
    operation: 'revoke',
    network: 'btc',
  });
  assert.equal(calls.createPin[0].metaidData.operation, 'revoke');
  assert.deepEqual(calls.createPin[0].options, { network: 'btc', origin: `tool:omni_cast#s=${SESSION_ID}` });
});

test('rejects payload and payload_file together, and neither', async () => {
  const { calls, byName } = makeHarness();
  const both = await byName.omni_cast.handler({
    path: '/protocols/simplenote',
    payload: '{}',
    payload_file: '/abs/file.bin',
  });
  assert.equal(both.isError, true);
  assert.match(both.content[0].text, /not both/);

  const neither = await byName.omni_cast.handler({ path: '/protocols/simplenote' });
  assert.equal(neither.isError, true);
  assert.match(neither.content[0].text, /exactly one of `payload` or `payload_file`/);
  assert.equal(calls.createPin.length, 0);
});

test('rejects an empty path before resolving the metabotId', async () => {
  const { calls, byName } = makeHarness();
  const result = await byName.omni_cast.handler({ path: '  ', payload: '{}' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /requires `path`/);
  assert.equal(calls.resolve.length, 0);
});

test('errors when no MetaBot owns the session', async () => {
  const { calls, byName } = makeHarness({ metabotId: undefined });
  const result = await byName.omni_cast.handler({ path: '/protocols/paylike', payload: '{}' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /which MetaBot owns this session/);
  assert.equal(calls.createPin.length, 0);
});

test('reads payload_file as base64 and infers the content type from the extension', async () => {
  const fixture = makeFixtureFile('pixel.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const { calls, byName } = makeHarness();
  const result = await byName.omni_cast.handler({ path: '/file', payload_file: fixture });
  assert.equal(result.isError, undefined);
  const data = calls.createPin[0].metaidData;
  assert.equal(data.payload, Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'));
  assert.equal(data.encoding, 'base64');
  assert.equal(data.contentType, 'image/png');
});

test('falls back to application/octet-stream for unknown payload_file extensions', async () => {
  const fixture = makeFixtureFile('data.bin', 'raw-bytes');
  const { calls, byName } = makeHarness();
  await byName.omni_cast.handler({ path: '/file', payload_file: fixture });
  assert.equal(calls.createPin[0].metaidData.contentType, 'application/octet-stream');
  assert.equal(calls.createPin[0].metaidData.encoding, 'base64');
});

test('honors an explicit content_type for payload_file', async () => {
  const fixture = makeFixtureFile('pixel.png', 'x');
  const { calls, byName } = makeHarness();
  await byName.omni_cast.handler({ path: '/file', payload_file: fixture, content_type: 'image/custom' });
  assert.equal(calls.createPin[0].metaidData.contentType, 'image/custom');
});

test('rejects relative and missing payload_file paths', async () => {
  const { calls, byName } = makeHarness();
  const relative = await byName.omni_cast.handler({ path: '/file', payload_file: 'rel/pic.png' });
  assert.equal(relative.isError, true);
  assert.match(relative.content[0].text, /ABSOLUTE local path/);

  const missing = await byName.omni_cast.handler({ path: '/file', payload_file: '/abs/nope.png' });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /payload file not found: \/abs\/nope\.png/);
  assert.equal(calls.createPin.length, 0);
});

test('rejects invalid JSON when the content type contains json', async () => {
  const { calls, byName } = makeHarness();
  const result = await byName.omni_cast.handler({ path: '/protocols/paylike', payload: '{not json' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /not valid JSON/);
  assert.equal(calls.createPin.length, 0);
});

test('passes non-JSON payloads through and auto-detects base64 for binary content types', async () => {
  const { calls, byName } = makeHarness();
  await byName.omni_cast.handler({ path: '/file', payload: 'aGVsbG8=', content_type: 'image/png' });
  assert.equal(calls.createPin[0].metaidData.encoding, 'base64');
  assert.equal(calls.createPin[0].metaidData.payload, 'aGVsbG8=');

  await byName.omni_cast.handler({ path: '/protocols/simplenote', payload: 'plain note', content_type: 'text/plain' });
  assert.equal(calls.createPin[1].metaidData.encoding, undefined);
  assert.equal(calls.createPin[1].metaidData.payload, 'plain note');
});

test('an explicit encoding override wins over auto-detection', async () => {
  const { calls, byName } = makeHarness();
  await byName.omni_cast.handler({
    path: '/file',
    payload: 'raw-text',
    content_type: 'application/octet-stream',
    encoding: 'utf-8',
  });
  assert.equal(calls.createPin[0].metaidData.encoding, undefined);
});

test('simplegroupchat requires a non-empty groupId and a string content', async () => {
  const { calls, byName } = makeHarness();
  const noGroup = await byName.omni_cast.handler({
    path: '/protocols/simplegroupchat',
    payload: '{"content":"hi"}',
  });
  assert.equal(noGroup.isError, true);
  assert.match(noGroup.content[0].text, /non-empty groupId/);

  const noContent = await byName.omni_cast.handler({
    path: '/protocols/simplegroupchat',
    payload: '{"groupId":"group-1"}',
  });
  assert.equal(noContent.isError, true);
  assert.match(noContent.content[0].text, /string content field/);
  assert.equal(calls.createPin.length, 0);
});

test('simplegroupchat encrypts content and marks the payload aes', async () => {
  const { calls, byName } = makeHarness();
  const result = await byName.omni_cast.handler({
    path: '/protocols/simplegroupchat',
    payload: '{"groupId":"group-1","content":"hello group"}',
  });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls.encrypt, [{ message: 'hello group', groupId: 'group-1' }]);
  const sent = JSON.parse(calls.createPin[0].metaidData.payload);
  assert.equal(sent.content, 'enc:hello group');
  assert.equal(sent.encryption, 'aes');
  assert.equal(sent.groupId, 'group-1');
});

test('surfaces createPin failures as an error result without throwing', async () => {
  const { byName } = makeHarness({ createPinError: new Error('broadcast rejected') });
  const result = await byName.omni_cast.handler({ path: '/protocols/paylike', payload: '{}' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /omni_cast failed: broadcast rejected/);
});

test('formatCastResult lists txid, pinId, cost, and the view link', () => {
  const text = formatCastResult({ pinId: 'abci0', txids: ['tx-1'], totalCost: 42 });
  assert.match(text, /txid: tx-1/);
  assert.match(text, /pinId: abci0/);
  assert.match(text, /cost: 42 sats/);
  assert.match(text, /view link: \[pin:\/\/abci0\]\(pin:\/\/abci0\)/);

  const minimal = formatCastResult({ pinId: '', txids: [], totalCost: 0 });
  assert.equal(minimal, 'Pin cast on-chain.\n- cost: 0 sats');
});
