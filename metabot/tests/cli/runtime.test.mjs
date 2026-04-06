import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { runCli } = require('../../dist/cli/main.js');

function parseLastJson(chunks) {
  return JSON.parse(chunks.join('').trim());
}

async function runCommand(homeDir, args) {
  const stdout = [];
  const stderr = [];
  const env = {
    ...process.env,
    HOME: homeDir,
    METABOT_HOME: homeDir,
  };

  const exitCode = await runCli(args, {
    env,
    cwd: homeDir,
    stdout: { write: (chunk) => { stdout.push(String(chunk)); return true; } },
    stderr: { write: (chunk) => { stderr.push(String(chunk)); return true; } },
  });

  return {
    exitCode,
    stdout,
    stderr,
    payload: parseLastJson(stdout),
  };
}

async function stopDaemon(homeDir) {
  const daemonStatePath = path.join(homeDir, '.metabot', 'hot', 'daemon.json');

  let daemonState;
  try {
    daemonState = JSON.parse(await readFile(daemonStatePath, 'utf8'));
  } catch (error) {
    const code = error?.code;
    if (code === 'ENOENT') {
      return;
    }
    throw error;
  }

  if (Number.isFinite(daemonState.pid)) {
    try {
      process.kill(Number(daemonState.pid), 'SIGTERM');
    } catch (error) {
      const code = error?.code;
      if (code !== 'ESRCH') {
        throw error;
      }
    }
  }

  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await readFile(daemonStatePath, 'utf8');
    } catch (error) {
      const code = error?.code;
      if (code === 'ENOENT') {
        return;
      }
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  await rm(daemonStatePath, { force: true });
}

test('identity create autostarts the local daemon and doctor reports the identity as loaded', async (t) => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'metabot-cli-runtime-'));
  t.after(async () => stopDaemon(homeDir));

  const created = await runCommand(homeDir, ['identity', 'create', '--name', 'Alice']);

  assert.equal(created.exitCode, 0);
  assert.equal(created.payload.ok, true);
  assert.equal(created.payload.data.name, 'Alice');
  assert.match(created.payload.data.globalMetaId, /^id/);

  const doctor = await runCommand(homeDir, ['doctor']);

  assert.equal(doctor.exitCode, 0);
  assert.equal(doctor.payload.ok, true);
  assert.equal(
    doctor.payload.data.checks.some((check) => check.code === 'identity_loaded' && check.ok === true),
    true
  );

  const daemonState = JSON.parse(await readFile(path.join(homeDir, '.metabot', 'hot', 'daemon.json'), 'utf8'));
  assert.match(daemonState.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(Number.isInteger(daemonState.pid), true);
});

test('services publish persists a local directory entry that network services --online can read back', async (t) => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'metabot-cli-runtime-'));
  t.after(async () => stopDaemon(homeDir));

  const created = await runCommand(homeDir, ['identity', 'create', '--name', 'Alice']);
  assert.equal(created.exitCode, 0);

  const payloadFile = path.join(homeDir, 'payload.json');
  await writeFile(payloadFile, JSON.stringify({
    serviceName: 'weather-oracle',
    displayName: 'Weather Oracle',
    description: 'Returns tomorrow weather from the local MetaBot runtime.',
    providerSkill: 'metabot-weather-oracle',
    price: '0.00001',
    currency: 'SPACE',
    outputType: 'text',
    skillDocument: '# Weather Oracle',
  }), 'utf8');

  const published = await runCommand(homeDir, ['services', 'publish', '--payload-file', payloadFile]);

  assert.equal(published.exitCode, 0);
  assert.equal(published.payload.ok, true);
  assert.equal(published.payload.data.displayName, 'Weather Oracle');
  assert.equal(published.payload.data.providerGlobalMetaId, created.payload.data.globalMetaId);
  assert.match(published.payload.data.servicePinId, /^service-/);

  const listed = await runCommand(homeDir, ['network', 'services', '--online']);

  assert.equal(listed.exitCode, 0);
  assert.equal(listed.payload.ok, true);
  assert.equal(Array.isArray(listed.payload.data.services), true);
  assert.equal(listed.payload.data.services.length, 1);
  assert.equal(listed.payload.data.services[0].displayName, 'Weather Oracle');
  assert.equal(listed.payload.data.services[0].online, true);
  assert.equal(listed.payload.data.services[0].providerGlobalMetaId, created.payload.data.globalMetaId);
});
