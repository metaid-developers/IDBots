import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = path.join(
  projectRoot,
  'src',
  'renderer',
  'components',
  'cowork',
  'CoworkSessionDetail.tsx'
);

test('CoworkSessionDetail renders an end-conversation button for private A2A sessions', () => {
  const source = fs.readFileSync(sourcePath, 'utf8');

  assert.match(source, /a2aSessionEndConversation/);
  assert.match(source, /handleEndA2APrivateChat/);
  assert.match(source, /coworkService\.endA2APrivateChat\(currentSession\.id\)/);
});

test('manual A2A private-chat bye stores the simplemsg txid on the local bubble', () => {
  const source = fs.readFileSync(
    path.join(projectRoot, 'src', 'main', 'main.ts'),
    'utf8'
  );

  assert.match(source, /const byePin = await createPin/);
  assert.match(source, /attachSimplemsgMetadataToCoworkMessage\(/);
  assert.match(source, /result\.endMessage/);
  assert.match(source, /pinId: byePin\.pinId/);
});

test('CoworkSessionDetail renders ordinary private A2A sessionid with copy action', () => {
  const source = fs.readFileSync(sourcePath, 'utf8');

  assert.match(source, /buildPrivateA2ASessionDisplayId/);
  assert.match(source, /showPrivateA2ASessionId/);
  assert.match(source, /sessionMetabot\?\.globalmetaid/);
  assert.match(source, /currentSession\.peerGlobalMetaId/);
  assert.match(source, /handleCopyHeaderValue\(privateA2ASessionDisplayId\)/);
  assert.match(source, /sessionid:/);
});

test('CoworkSessionDetail hides A2A transport handshake bubbles', () => {
  const source = fs.readFileSync(sourcePath, 'utf8');

  assert.match(source, /isA2ATransportHandshakeMessage/);
  assert.match(source, /sourceChannel === 'metaweb_private'/);
  assert.match(source, /normalizedContent === 'ping'/);
  assert.match(source, /normalizedContent === 'pong'/);
  assert.match(source, /shouldHideControlMessage\(message\)/);
  assert.match(source, /isA2ATransportHandshakeMessage\(message\)/);
});

test('CoworkSessionDetail wires resend digital delivery to order-scoped A2A messages', () => {
  const source = fs.readFileSync(sourcePath, 'utf8');

  assert.match(source, /a2aResendDigitalDelivery/);
  assert.match(source, /handleResendDigitalDelivery/);
  assert.match(source, /onResendDigitalDelivery=\{handleResendDigitalDelivery\}/);
  assert.match(source, /canResendDigitalDelivery=\{canResendDigitalDelivery\}/);
  assert.match(source, /coworkService\.resendA2ADeliveryArtifact\(\{\s*sessionId: currentSession\.id,\s*orderTxid,/s);
  assert.match(source, /serviceOrderSummary\?\.role === 'seller'/);
  assert.match(source, /NON_TEXT_SERVICE_OUTPUT_TYPES\.includes/);
  assert.doesNotMatch(source, /onClick=\{handleResendDigitalDelivery\}/);
  assert.doesNotMatch(source, /outputType !== 'text'/);
});

test('manual A2A delivery resend IPC accepts an order-scoped request', () => {
  const source = fs.readFileSync(
    path.join(projectRoot, 'src', 'main', 'main.ts'),
    'utf8'
  );

  assert.match(source, /normalizeA2ADeliveryArtifactResendInput/);
  assert.match(source, /resolveServiceOrderForSessionAndOrderTxid/);
  assert.match(source, /findOrderByOrderMessageTxid\(\s*'seller'/s);
  assert.match(source, /orderTxid/);
  assert.doesNotMatch(source, /ipcMain\.handle\('cowork:session:resendA2ADeliveryArtifact', async \(_event, sessionId: string\)/);
});

test('manual A2A delivery resend failure sends a refund-flow notice to the buyer', () => {
  const source = fs.readFileSync(
    path.join(projectRoot, 'src', 'main', 'main.ts'),
    'utf8'
  );

  assert.match(source, /manualResendFailureReply/);
  assert.match(source, /上传链上交付失败/);
  assert.match(source, /系统将自动转入退款流程/);
  assert.match(source, /orderDeliveryFailed/);
});
