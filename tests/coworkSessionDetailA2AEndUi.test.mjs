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

test('CoworkSessionDetail renders a resend digital delivery button for seller A2A service orders', () => {
  const source = fs.readFileSync(sourcePath, 'utf8');

  assert.match(source, /a2aResendDigitalDelivery/);
  assert.match(source, /handleResendDigitalDelivery/);
  assert.match(source, /coworkService\.resendA2ADeliveryArtifact\(currentSession\.id\)/);
  assert.match(source, /serviceOrderSummary\?\.role === 'seller'/);
  assert.match(source, /NON_TEXT_SERVICE_OUTPUT_TYPES\.includes/);
  assert.doesNotMatch(source, /outputType !== 'text'/);
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
