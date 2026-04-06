import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');
const BUILD_SCRIPT_URL = pathToFileURL(path.join(REPO_ROOT, 'scripts/build-metabot-skillpacks.mjs')).href;
const execFile = promisify(execFileCallback);

const HOSTS = ['codex', 'claude-code', 'openclaw'];
const EXPECTED_SKILLS = [
  'metabot-chat-privatechat',
  'metabot-post-skillservice',
  'metabot-omni-reader',
  'metabot-bootstrap',
  'metabot-network-directory',
  'metabot-call-remote-service',
  'metabot-trace-inspector',
];
const EXPECTED_CLI_PATH = 'metabot';
const EXPECTED_COMPATIBILITY_MANIFEST = 'metabot/release/compatibility.json';
const EXPECTED_BUNDLED_COMPATIBILITY_COPY = 'runtime/compatibility.json';
const EXPECTED_CONFIRMATION_CONTRACT_LINE =
  'Before any paid remote call, show the provider, service, price, currency, and wait for explicit confirmation.';

async function assertFileExists(filePath) {
  const info = await stat(filePath);
  assert.equal(info.isFile(), true, `${filePath} should exist as a file`);
}

test('buildMetabotSkillpacks renders the shared MetaBot source skills into every host output', async () => {
  const outputRoot = await mkdtemp(path.join(os.tmpdir(), 'metabot-skillpacks-'));
  const { buildMetabotSkillpacks } = await import(BUILD_SCRIPT_URL);

  const result = await buildMetabotSkillpacks({
    repoRoot: REPO_ROOT,
    outputRoot,
  });

  assert.deepEqual([...result.hosts].sort(), [...HOSTS].sort());

  for (const host of HOSTS) {
    const hostRoot = path.join(outputRoot, host);
    await assertFileExists(path.join(hostRoot, 'README.md'));
    await assertFileExists(path.join(hostRoot, 'install.sh'));

    for (const skillName of EXPECTED_SKILLS) {
      await assertFileExists(path.join(hostRoot, 'skills', skillName, 'SKILL.md'));
    }
  }
});

test('buildMetabotSkillpacks embeds one shared CLI path and one shared compatibility manifest across hosts', async () => {
  const outputRoot = await mkdtemp(path.join(os.tmpdir(), 'metabot-skillpacks-'));
  const { buildMetabotSkillpacks } = await import(BUILD_SCRIPT_URL);

  await buildMetabotSkillpacks({
    repoRoot: REPO_ROOT,
    outputRoot,
  });

  for (const host of HOSTS) {
    const readme = await readFile(path.join(outputRoot, host, 'README.md'), 'utf8');
    assert.match(readme, new RegExp(`\\b${EXPECTED_CLI_PATH}\\b`));
    assert.match(readme, new RegExp(EXPECTED_COMPATIBILITY_MANIFEST.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('buildMetabotSkillpacks copies the compatibility manifest into every host runtime bundle', async () => {
  const outputRoot = await mkdtemp(path.join(os.tmpdir(), 'metabot-skillpacks-'));
  const { buildMetabotSkillpacks } = await import(BUILD_SCRIPT_URL);
  const expectedManifest = JSON.parse(await readFile(path.join(REPO_ROOT, 'metabot', 'release', 'compatibility.json'), 'utf8'));

  await buildMetabotSkillpacks({
    repoRoot: REPO_ROOT,
    outputRoot,
  });

  for (const host of HOSTS) {
    const bundledManifest = JSON.parse(await readFile(
      path.join(outputRoot, host, EXPECTED_BUNDLED_COMPATIBILITY_COPY),
      'utf8'
    ));
    assert.deepEqual(bundledManifest, expectedManifest);
  }
});

test('buildMetabotSkillpacks preserves one confirmation contract across all host packs', async () => {
  const outputRoot = await mkdtemp(path.join(os.tmpdir(), 'metabot-skillpacks-'));
  const { buildMetabotSkillpacks } = await import(BUILD_SCRIPT_URL);

  await buildMetabotSkillpacks({
    repoRoot: REPO_ROOT,
    outputRoot,
  });

  const renderedContracts = await Promise.all(
    HOSTS.map((host) => readFile(
      path.join(outputRoot, host, 'skills', 'metabot-call-remote-service', 'SKILL.md'),
      'utf8'
    ))
  );

  for (const content of renderedContracts) {
    assert.match(content, /## Confirmation Contract/);
    assert.match(content, new RegExp(EXPECTED_CONFIRMATION_CONTRACT_LINE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  assert.equal(new Set(renderedContracts).size, HOSTS.length, 'host packs may differ in metadata, but the confirmation contract text must remain intact in every host output');
});

test('buildMetabotSkillpacks publishes the shared remote-call demo transport contract across all host packs', async () => {
  const outputRoot = await mkdtemp(path.join(os.tmpdir(), 'metabot-skillpacks-'));
  const { buildMetabotSkillpacks } = await import(BUILD_SCRIPT_URL);

  await buildMetabotSkillpacks({
    repoRoot: REPO_ROOT,
    outputRoot,
  });

  for (const host of HOSTS) {
    const content = await readFile(
      path.join(outputRoot, host, 'skills', 'metabot-call-remote-service', 'SKILL.md'),
      'utf8'
    );
    assert.match(content, /providerDaemonBaseUrl/);
    assert.match(content, /responseText/);
    assert.match(content, /Demo Transport/);
  }
});

test('install.sh copies skills and installs a runnable metabot shim from the source tree', async () => {
  const outputRoot = await mkdtemp(path.join(os.tmpdir(), 'metabot-skillpacks-'));
  const skillDest = await mkdtemp(path.join(os.tmpdir(), 'metabot-skill-dest-'));
  const binDir = await mkdtemp(path.join(os.tmpdir(), 'metabot-bin-'));
  const { buildMetabotSkillpacks } = await import(BUILD_SCRIPT_URL);

  await buildMetabotSkillpacks({
    repoRoot: REPO_ROOT,
    outputRoot,
  });

  const hostRoot = path.join(outputRoot, 'codex');
  await execFile('bash', [path.join(hostRoot, 'install.sh')], {
    cwd: hostRoot,
    env: {
      ...process.env,
      METABOT_SOURCE_ROOT: REPO_ROOT,
      METABOT_SKILL_DEST: skillDest,
      METABOT_BIN_DIR: binDir,
    },
  });

  await assertFileExists(path.join(skillDest, 'metabot-bootstrap', 'SKILL.md'));
  await assertFileExists(path.join(binDir, 'metabot'));

  let commandFailure = null;
  try {
    await execFile(path.join(binDir, 'metabot'), [], {
      env: {
        ...process.env,
      },
    });
  } catch (error) {
    commandFailure = error;
  }

  assert.ok(commandFailure, 'metabot shim should execute the CLI and return the missing-command envelope');
  assert.equal(commandFailure.code, 1);
  assert.deepEqual(JSON.parse(String(commandFailure.stdout).trim()), {
    ok: false,
    state: 'failed',
    code: 'missing_command',
    message: 'No command provided.',
  });
});
