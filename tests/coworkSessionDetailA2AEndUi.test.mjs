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
  // The handshake detector moved into coworkConversationProjection (mobile
  // projection refactor); the component wires it next to the A2A internal
  // filter. Assert the split shape — asserting only the component went stale.
  const source = fs.readFileSync(sourcePath, 'utf8');
  const projectionSource = fs.readFileSync(
    path.join(projectRoot, 'src', 'renderer', 'services', 'coworkConversationProjection.ts'),
    'utf8'
  );

  assert.match(projectionSource, /isA2ATransportHandshakeMessage/);
  assert.match(projectionSource, /sourceChannel === 'metaweb_private'/);
  assert.match(projectionSource, /normalizedContent === 'ping'/);
  assert.match(projectionSource, /normalizedContent === 'pong'/);
  assert.match(projectionSource, /shouldHideControlMessage/);
  assert.match(source, /shouldHideControlMessage/);
  assert.match(source, /shouldHideControlMessage\(message\)/);
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

test('A2A Bot avatar browser-open handler is wired from App into message items', () => {
  const appSource = fs.readFileSync(
    path.join(projectRoot, 'src', 'renderer', 'App.tsx'),
    'utf8'
  );
  const coworkViewSource = fs.readFileSync(
    path.join(projectRoot, 'src', 'renderer', 'components', 'cowork', 'CoworkView.tsx'),
    'utf8'
  );
  const source = fs.readFileSync(sourcePath, 'utf8');

  assert.match(appSource, /onOpenBotInBrowser=\{botBrowserShell\.openRemoteBot\}/);
  assert.match(coworkViewSource, /onOpenBotInBrowser\?:/);
  assert.match(coworkViewSource, /onOpenBotInBrowser=\{onOpenBotInBrowser\}/);
  assert.match(source, /localGlobalMetaId=\{sessionMetabot\?\.globalmetaid/);
  assert.match(source, /peerGlobalMetaId=\{a2aPeerGlobalMetaId\}/);
  assert.match(source, /onOpenBotInBrowser=\{onOpenBotInBrowser\}/);
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

test('manual A2A delivery resend preserves service order pin identity for free orders', () => {
  const source = fs.readFileSync(
    path.join(projectRoot, 'src', 'main', 'main.ts'),
    'utf8'
  );

  assert.match(
    source,
    /const deliveryText = buildDeliveryMessage\(\{\s*paymentTxid: order\.paymentTxid,\s*\.\.\.\(order\.orderPinId\s*\?\s*\{\s*serviceOrderPinId: order\.orderPinId,\s*orderPinId: order\.orderPinId,\s*\}\s*:\s*\{\}\),/s
  );
  assert.match(
    source,
    /markSellerOrderDelivered\(\{\s*localMetabotId: metabotId,\s*counterpartyGlobalMetaId: peerGlobalMetaId,\s*orderPinId: order\.orderPinId,\s*paymentTxid: order\.paymentTxid,/s
  );
});

test('A2A guidance IPC queues active sessions and restarts ended private chats', () => {
  const mainSource = fs.readFileSync(
    path.join(projectRoot, 'src', 'main', 'main.ts'),
    'utf8'
  );
  const daemonSource = fs.readFileSync(
    path.join(projectRoot, 'src', 'main', 'services', 'privateChatDaemon.ts'),
    'utf8'
  );
  const preloadSource = fs.readFileSync(
    path.join(projectRoot, 'src', 'main', 'preload.ts'),
    'utf8'
  );
  const electronTypes = fs.readFileSync(
    path.join(projectRoot, 'src', 'renderer', 'types', 'electron.d.ts'),
    'utf8'
  );
  const coworkTypes = fs.readFileSync(
    path.join(projectRoot, 'src', 'renderer', 'types', 'cowork.ts'),
    'utf8'
  );

  // IPC handlers migrated to the registerIpcHandler gateway wrapper; the raw
  // ipcMain.handle spelling is gone.
  assert.match(mainSource, /registerIpcHandler\('cowork:session:queueA2AGuidance'/);
  assert.match(mainSource, /Only MetaWeb private-chat A2A sessions support guided dialogue/);
  assert.match(
    mainSource,
    /sourceContext\.sourceChannel !== 'metaweb_private' \|\| !sourceContext\.externalConversationId[\s\S]*a2aGuidanceQueue\.queue/
  );
  assert.match(mainSource, /a2aGuidanceQueue\.queue/);
  assert.match(mainSource, /a2aGuidanceQueue\.clear/);
  assert.match(mainSource, /startPrivateChatDaemon\([\s\S]*a2aGuidanceQueue\.consume/);
  assert.match(mainSource, /performChatCompletionForOrchestrator/);
  assert.match(mainSource, /sendEncryptedSimplemsg/);
  assert.match(mainSource, /a2aConversationRestarted/);
  assert.match(mainSource, /byeSent:\s*false/);

  assert.match(preloadSource, /queueA2AGuidance/);
  assert.match(preloadSource, /cowork:session:queueA2AGuidance/);
  assert.match(preloadSource, /CoworkA2AGuidanceRequest/);
  assert.match(electronTypes, /queueA2AGuidance/);
  assert.match(electronTypes, /CoworkA2AGuidanceRequest/);
  assert.match(electronTypes, /CoworkA2AGuidanceResult/);
  assert.match(coworkTypes, /interface CoworkA2AGuidanceRequest/);
  assert.match(coworkTypes, /interface CoworkA2AGuidanceResult/);
  assert.match(coworkTypes, /restart_started/);

  const orderPromptIndex = daemonSource.indexOf('const prompts = buildOrderPrompts({');
  const orderConversationIndex = daemonSource.indexOf('const externalConversationId', orderPromptIndex);
  assert.notEqual(orderPromptIndex, -1);
  assert.notEqual(orderConversationIndex, -1);
  assert.doesNotMatch(daemonSource.slice(orderPromptIndex, orderConversationIndex), /operatorGuidance/);
});

test('CoworkSessionDetail replaces observer notice with guided dialogue controls', () => {
  const source = fs.readFileSync(sourcePath, 'utf8');
  const serviceSource = fs.readFileSync(
    path.join(projectRoot, 'src', 'renderer', 'services', 'cowork.ts'),
    'utf8'
  );
  const i18nSource = fs.readFileSync(
    path.join(projectRoot, 'src', 'renderer', 'services', 'i18n.ts'),
    'utf8'
  );

  assert.doesNotMatch(source, /a2aSessionObserverNotice/);
  assert.match(source, /a2aGuidanceOpen/);
  assert.match(source, /handleSubmitA2AGuidance/);
  assert.match(source, /sessionIdRef/);
  assert.match(source, /sessionIdRef\.current !== requestSessionId/);
  assert.match(source, /coworkService\.queueA2AGuidance/);
  // Long-standing 1/13 red, root-caused 2026-11-08: this assertion used to pin
  // the bare `isPrivateA2ASession && (` adjacency. Commit b7a7d30af
  // ("generalize private chat owner approvals") interleaved an approval gate —
  // the guidance composer and the owner-approval bar share one composer slot,
  // and while an owner approval is pending the bar takes the slot. The product
  // behaviour this test is named for (observer notice replaced by guided
  // dialogue controls) is unchanged, so the assertion pins the composed
  // condition — with tolerant whitespace, so reformatting cannot re-break it.
  assert.match(
    source,
    /isPrivateA2ASession\s*&&\s*a2aApprovalPermissions\.length === 0\s*&&\s*\(\s*<A2AGuidanceControls/
  );
  // …and the other half of that shared slot: the gate is only coherent because
  // the approval bar renders in the same place while an approval is pending.
  assert.match(source, /a2aApprovalPermissions\[0\]\s*&&\s*\(\s*<A2AApprovalBar/);
  assert.match(source, /a2aGuidancePlaceholder/);
  assert.match(source, /aria-label=\{i18nService\.t\('a2aGuidancePlaceholder'\)\}/);
  assert.match(source, /a2aConversationRestarted/);
  assert.match(source, /PaperAirplaneIcon/);

  assert.match(serviceSource, /queueA2AGuidance/);
  assert.match(serviceSource, /store\.getState\(\)\.cowork\.currentSessionId === request\.sessionId/);
  assert.match(serviceSource, /loadSession\(request\.sessionId, \{ onlyIfCurrent: true \}\)/);
  assert.match(
    serviceSource,
    /options\.onlyIfCurrent && store\.getState\(\)\.cowork\.currentSessionId !== sessionId/
  );
  assert.match(i18nSource, /a2aGuidance:\s*'引导对话'/);
  assert.match(i18nSource, /a2aGuidanceQueued/);
  assert.match(i18nSource, /a2aGuidanceRestartStarted/);
});

test('CoworkSessionDetail keeps guided dialogue input state out of the heavy detail component', () => {
  const source = fs.readFileSync(sourcePath, 'utf8');

  assert.match(source, /const A2AGuidanceControls = React\.memo/);
  assert.match(source, /const \[guidanceText, setGuidanceText\] = useState\(''\)/);
  assert.match(source, /onChange=\{\(event\) => setGuidanceText\(event\.target\.value\)\}/);
  assert.doesNotMatch(source, /const \[a2aGuidanceText, setA2AGuidanceText\]/);
  assert.doesNotMatch(source, /setA2AGuidanceText\(event\.target\.value\)/);
});

test('A2A guidance queueing interrupts a current silent local bot turn', () => {
  const mainSource = fs.readFileSync(
    path.join(projectRoot, 'src', 'main', 'main.ts'),
    'utf8'
  );
  const runnerSource = fs.readFileSync(
    path.join(projectRoot, 'src', 'main', 'libs', 'coworkRunner.ts'),
    'utf8'
  );
  const bridgeSource = fs.readFileSync(
    path.join(projectRoot, 'src', 'main', 'services', 'orchestratorCoworkBridge.ts'),
    'utf8'
  );

  assert.match(mainSource, /interruptPrivateChatA2AGuidanceTurnBeforeOutput/);
  assert.match(mainSource, /getCoworkRunner\(\)\.interruptActiveTurnBeforeAssistantOutput\(sessionId\)/);
  assert.match(runnerSource, /interruptActiveTurnBeforeAssistantOutput\(sessionId: string\): boolean/);
  assert.match(runnerSource, /!activeSession\.hasAssistantTextOutput/);
  assert.match(runnerSource, /this\.stopSession\(sessionId, \{ reason: 'interrupted before assistant output \(queued guidance\)' \}\)/);
  assert.match(runnerSource, /this\.emit\('stopped', sessionId, reason\)/);
  assert.match(bridgeSource, /runner\.on\('stopped', onStopped\)/);
  assert.match(bridgeSource, /runner\.off\('stopped', onStopped\)/);
});
