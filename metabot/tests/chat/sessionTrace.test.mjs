import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  buildSessionTrace,
} = require('../../dist/core/chat/sessionTrace.js');
const {
  exportSessionArtifacts,
} = require('../../dist/core/chat/transcriptExport.js');

function createFixtureTrace(homeDir) {
  return buildSessionTrace({
    traceId: 'trace-weather-order-1',
    channel: 'metaweb_order',
    session: {
      id: 'session-weather-1',
      title: 'Weather Order',
      type: 'a2a',
      metabotId: 7,
      peerGlobalMetaId: 'seller-global-metaid',
      peerName: 'Seller Bot',
      externalConversationId: `metaweb_order:buyer:7:seller-global-metaid:${'a'.repeat(16)}`,
    },
    order: {
      id: 'order-weather-1',
      role: 'buyer',
      serviceId: 'service-weather',
      serviceName: 'Weather Oracle',
      paymentTxid: 'a'.repeat(64),
      paymentCurrency: 'SPACE',
      paymentAmount: '0.0001',
    },
    exportRoot: path.join(homeDir, '.metabot', 'exports'),
  });
}

test('exportSessionArtifacts writes transcript markdown under exports/chats', async () => {
  const homeDir = mkdtempSync(path.join(tmpdir(), 'metabot-chat-trace-'));
  const trace = createFixtureTrace(homeDir);

  const artifacts = await exportSessionArtifacts({
    trace,
    transcript: {
      sessionId: 'session-weather-1',
      title: 'Weather Order',
      messages: [
        {
          id: 'm1',
          type: 'user',
          timestamp: 1_744_444_444_000,
          content: '[ORDER] help me check tomorrow',
          metadata: { direction: 'outgoing' },
        },
        {
          id: 'm2',
          type: 'assistant',
          timestamp: 1_744_444_445_000,
          content: 'Tomorrow looks favorable.',
          metadata: { direction: 'incoming' },
        },
      ],
    },
  });

  assert.equal(
    artifacts.transcriptMarkdownPath,
    path.join(homeDir, '.metabot', 'exports', 'chats', 'session-weather-1.md')
  );

  const markdown = readFileSync(artifacts.transcriptMarkdownPath, 'utf8');
  assert.match(markdown, /# Weather Order/);
  assert.match(markdown, /Session ID: session-weather-1/);
  assert.match(markdown, /Peer: Seller Bot \(seller-global-metaid\)/);
  assert.match(markdown, /\[user\] \[ORDER\] help me check tomorrow/);
  assert.match(markdown, /\[assistant\] Tomorrow looks favorable\./);
});

test('exportSessionArtifacts writes linked trace json and markdown with order, session, and transcript paths', async () => {
  const homeDir = mkdtempSync(path.join(tmpdir(), 'metabot-chat-trace-'));
  const trace = createFixtureTrace(homeDir);

  const artifacts = await exportSessionArtifacts({
    trace,
    transcript: {
      sessionId: 'session-weather-1',
      title: 'Weather Order',
      messages: [
        {
          id: 'm1',
          type: 'user',
          timestamp: 1_744_444_444_000,
          content: '[ORDER] help me check tomorrow',
        },
      ],
    },
  });

  assert.equal(
    artifacts.traceJsonPath,
    path.join(homeDir, '.metabot', 'exports', 'traces', 'trace-weather-order-1.json')
  );
  assert.equal(
    artifacts.traceMarkdownPath,
    path.join(homeDir, '.metabot', 'exports', 'traces', 'trace-weather-order-1.md')
  );

  const traceJson = JSON.parse(readFileSync(artifacts.traceJsonPath, 'utf8'));
  assert.equal(traceJson.traceId, 'trace-weather-order-1');
  assert.equal(traceJson.channel, 'metaweb_order');
  assert.equal(traceJson.session.id, 'session-weather-1');
  assert.equal(traceJson.session.externalConversationId, `metaweb_order:buyer:7:seller-global-metaid:${'a'.repeat(16)}`);
  assert.equal(traceJson.order.id, 'order-weather-1');
  assert.equal(traceJson.order.paymentTxid, 'a'.repeat(64));
  assert.equal(traceJson.artifacts.transcriptMarkdownPath, artifacts.transcriptMarkdownPath);
  assert.equal(traceJson.artifacts.traceMarkdownPath, artifacts.traceMarkdownPath);

  const traceMarkdown = readFileSync(artifacts.traceMarkdownPath, 'utf8');
  assert.match(traceMarkdown, /# Trace trace-weather-order-1/);
  assert.match(traceMarkdown, /Order ID: order-weather-1/);
  assert.match(traceMarkdown, /Payment TXID: a{64}/);
  assert.match(traceMarkdown, /Transcript: .*session-weather-1\.md/);
});
