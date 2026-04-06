import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');
const LOCAL_DEMO_URL = pathToFileURL(path.join(REPO_ROOT, 'metabot/e2e/run-local-cross-host-demo.mjs')).href;

test('local cross-host demo harness creates two local runtimes and produces a discoverable remote call plan', async () => {
  const { runLocalCrossHostDemo } = await import(LOCAL_DEMO_URL);
  const result = await runLocalCrossHostDemo({
    callerHost: 'codex',
    providerHost: 'claude-code',
    task: 'Tell me tomorrow weather.',
    taskContext: 'User wants a one-shot weather prediction for tomorrow.',
  });

  assert.equal(result.caller.host, 'codex');
  assert.equal(result.provider.host, 'claude-code');
  assert.match(result.caller.identity.globalMetaId, /^id/);
  assert.match(result.provider.identity.globalMetaId, /^id/);
  assert.equal(result.transport.mode, 'daemon_http');
  assert.equal(result.directory.availableServices.length, 1);
  assert.equal(result.directory.availableServices[0].displayName, 'Weather Oracle');
  assert.equal(result.call.state, 'ready');
  assert.equal(result.trace.order.serviceName, 'Weather Oracle');
  assert.equal(result.trace.channel, 'codex->claude-code');
  assert.equal(result.trace.session.externalConversationId, result.call.session.externalConversationId);
  assert.equal(result.remoteExecution.traceId, result.call.traceId);
  assert.equal(result.remoteExecution.externalConversationId, result.call.session.externalConversationId);
  assert.match(result.remoteExecution.responseText, /tomorrow/i);
  assert.equal(result.provider.trace.traceId, result.call.traceId);
  assert.equal(result.provider.trace.order.role, 'seller');
  assert.equal(result.provider.trace.order.serviceName, 'Weather Oracle');
  assert.equal(result.provider.trace.session.peerGlobalMetaId, result.caller.identity.globalMetaId);
  assert.match(result.artifacts.traceJsonPath, /\/\.metabot\/exports\/traces\/.*\.json$/);
  assert.match(result.remoteExecution.traceJsonPath, /\/\.metabot\/exports\/traces\/.*\.json$/);
});
