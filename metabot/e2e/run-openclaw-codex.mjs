import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runHostFixtureHarness } from './run-codex-claude.mjs';

const THIS_FILE = fileURLToPath(import.meta.url);
const E2E_ROOT = path.dirname(THIS_FILE);

export async function runOpenClawCodexFixtureHarness({
  providerFixturePath = path.join(E2E_ROOT, 'fixtures/provider-service.json'),
  callerFixturePath = path.join(E2E_ROOT, 'fixtures/caller-request.json'),
} = {}) {
  return runHostFixtureHarness({
    providerFixturePath,
    callerFixturePath,
    callerHost: 'openclaw',
    providerHost: 'codex',
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const result = await runOpenClawCodexFixtureHarness();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
