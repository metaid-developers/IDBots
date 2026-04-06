import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');
const PROVIDER_FIXTURE_PATH = path.join(REPO_ROOT, 'metabot/e2e/fixtures/provider-service.json');
const CALLER_FIXTURE_PATH = path.join(REPO_ROOT, 'metabot/e2e/fixtures/caller-request.json');
const CODEX_CLAUDE_URL = pathToFileURL(path.join(REPO_ROOT, 'metabot/e2e/run-codex-claude.mjs')).href;
const OPENCLAW_CODEX_URL = pathToFileURL(path.join(REPO_ROOT, 'metabot/e2e/run-openclaw-codex.mjs')).href;

test('Codex -> Claude Code fixture harness loads provider identity and preserves the canonical globalMetaId', async () => {
  const { runCodexClaudeFixtureHarness } = await import(CODEX_CLAUDE_URL);
  const result = await runCodexClaudeFixtureHarness({
    providerFixturePath: PROVIDER_FIXTURE_PATH,
    callerFixturePath: CALLER_FIXTURE_PATH,
  });

  assert.equal(result.provider.identity.globalMetaId, 'idq1970463ym8fqmgawe4lylktne97ahhw4kqehkch');
  assert.equal(result.provider.identity.mvcAddress, '15Lofqw6Kpa6P8WnTYXKvmPyw3UZvvQWrB');
});

test('OpenClaw -> Codex fixture harness marks the provider service as discoverable and online', async () => {
  const { runOpenClawCodexFixtureHarness } = await import(OPENCLAW_CODEX_URL);
  const result = await runOpenClawCodexFixtureHarness({
    providerFixturePath: PROVIDER_FIXTURE_PATH,
    callerFixturePath: CALLER_FIXTURE_PATH,
  });

  assert.equal(result.directory.availableServices.length, 1);
  assert.equal(result.directory.availableServices[0].servicePinId, 'service-weather-001');
  assert.equal(result.directory.onlineBots['idq1970463ym8fqmgawe4lylktne97ahhw4kqehkch'], 1_744_444_444);
});

test('fixture harness generates a trace record after the remote call plan succeeds', async () => {
  const { runCodexClaudeFixtureHarness } = await import(CODEX_CLAUDE_URL);
  const result = await runCodexClaudeFixtureHarness({
    providerFixturePath: PROVIDER_FIXTURE_PATH,
    callerFixturePath: CALLER_FIXTURE_PATH,
  });

  assert.equal(result.call.state, 'ready');
  assert.equal(result.trace.traceId, 'trace-idq1970463ym8fqm-service-weather-');
  assert.equal(result.trace.artifacts.traceJsonPath.endsWith('/traces/trace-idq1970463ym8fqm-service-weather-.json'), true);
});
