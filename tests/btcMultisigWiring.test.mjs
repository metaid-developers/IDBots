import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const runner = readFileSync(new URL('../src/main/libs/coworkRunner.ts', import.meta.url), 'utf8');
const main = readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8');
const relay = readFileSync(new URL('../src/main/services/orchestratorPermissionRelay.ts', import.meta.url), 'utf8');

test('CoworkRunner assigns and registers the multisig tools with a closed timeout', () => {
  assert.match(runner, /this\.btcMultisigTools = options\?\.btcMultisigTools;/);
  assert.match(runner, /buildBtcMultisigAgentTools\(/);
  assert.match(runner, /confirmBtcMultisigAction\(sessionId, question, 'wallet_btc_sign_psbt'\)/);
  assert.match(runner, /confirmBtcMultisigAction\(sessionId, question, 'wallet_btc_broadcast'\)/);
  const method = runner.slice(runner.indexOf('private async confirmBtcMultisigAction'));
  assert.match(method.slice(0, 1200), /'deny'/);
  // Owner-only: the orchestrator text relay inside a delegated worker session
  // must never be able to answer this gate with the delegating bot's message.
  assert.match(method.slice(0, 1200), /\{ ownerOnly: true \}/);
  assert.match(runner, /isPermissionOwnerOnly\(requestId: string\): boolean/);
  assert.match(relay, /isPermissionOwnerOnly\?\.\(request\.requestId\)\) return;/);
});

test('main wires multisig signing through the local wallet and does not bundle the skill', () => {
  assert.match(main, /btcMultisigTools:\s*\{/);
  assert.match(main, /signBtcPsbtPartial\(wallet, input\)/);
  assert.match(main, /broadcastBtcTx\(rawTx\)/);
  assert.equal(existsSync(new URL('../SKILLs/metabot-multisign/SKILL.md', import.meta.url)), false);
});
