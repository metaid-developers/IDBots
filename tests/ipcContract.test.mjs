// REQ-A-23 / REQ-A-17 (data half) — IPC contract generator + allowlist gates.
//
// 1. Staleness: the generated contract must match a fresh in-memory
//    regeneration (AC-A-7: the test fails when the preload changes without
//    regenerating, and passes on main).
// 2. Tier coverage: every invoke/send/on channel the preload contract
//    exposes must resolve to an exact or prefix allowlist rule — the
//    default-deny fallback means the channel was never given a tier in
//    docs/cloud-mobile/02-ipc-allowlist-v1.md and must fail (完工判据 2).
// 3. Spot assertions transcribed from `02` (tiers, restrictions, timeouts).
// 4. Every channel named in `02`'s tables — at least the "New Channels Added
//    by WS-A" set plus a broad P1 spot-check — exists in the allowlist data.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const generatedPath = path.join(repoRoot, 'src', 'mobile', 'generated', 'ipc-contract.json');
const generatorPath = path.join(repoRoot, 'scripts', 'generate-ipc-contract.mjs');

const allowlist = require('../dist-electron/main/gateway/allowlist.js');
const contract = JSON.parse(fs.readFileSync(generatedPath, 'utf8'));

test('generated IPC contract is fresh (generate-ipc-contract.mjs --check)', () => {
  const result = spawnSync(process.execPath, [generatorPath, '--check'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  assert.equal(
    result.status,
    0,
    `scripts/generate-ipc-contract.mjs --check failed (exit ${result.status}):\n${result.stdout}\n${result.stderr}`,
  );
});

test('contract shape: versions, sorted unique method paths', () => {
  assert.equal(contract.contractVersion, '1.0.0');
  assert.equal(contract.allowlistVersion, allowlist.ALLOWLIST_VERSION);
  assert.equal(allowlist.ALLOWLIST_VERSION, '1.0.1');
  assert.equal(contract.source, 'src/main/preload.ts');
  assert.ok(Array.isArray(contract.methods) && contract.methods.length > 0);

  const paths = contract.methods.map((method) => method.path);
  assert.equal(new Set(paths).size, paths.length, 'method paths must be unique');
  const sorted = [...paths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  assert.deepEqual(paths, sorted, 'methods must be sorted by path for deterministic output');

  for (const method of contract.methods) {
    assert.ok(['invoke', 'on', 'send', 'value'].includes(method.kind), `${method.path}: unexpected kind ${method.kind}`);
    if (method.kind === 'invoke' || method.kind === 'on' || method.kind === 'send') {
      assert.equal(typeof method.channel, 'string', `${method.path}: ${method.kind} methods must carry a channel`);
    }
    if (method.kind === 'invoke' || method.kind === 'send') {
      assert.ok(Array.isArray(method.args), `${method.path}: ${method.kind} methods must list forwarded arg names`);
    }
  }
  assert.equal(contract.methods.some((method) => method.kind === 'custom'), false, 'no custom method may survive overrides');
});

test('tier coverage: every contract channel resolves to an exact or prefix allowlist rule (完工判据 2)', () => {
  const seen = new Set();
  for (const method of contract.methods) {
    const key = `${method.kind}:${method.channel ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (method.kind === 'invoke') {
      const { matched } = allowlist.lookupInvokeChannelWithSource(method.channel);
      assert.notEqual(
        matched,
        'default',
        `invoke channel "${method.channel}" (${method.path}) has no tier in docs/cloud-mobile/02-ipc-allowlist-v1.md`,
      );
    } else if (method.kind === 'on') {
      const { matched } = allowlist.lookupEventChannelWithSource(method.channel);
      assert.notEqual(
        matched,
        'default',
        `event channel "${method.channel}" (${method.path}) has no tier in docs/cloud-mobile/02-ipc-allowlist-v1.md`,
      );
    } else if (method.kind === 'send') {
      assert.ok(
        allowlist.SEND_CHANNELS.includes(method.channel),
        `send channel "${method.channel}" (${method.path}) is missing from SEND_CHANNELS`,
      );
    }
  }
});

test('send channels: exactly the eight `02` names, all renderer-to-main sends', () => {
  assert.deepEqual(
    [...allowlist.SEND_CHANNELS].sort(),
    [
      'botBrowser:capture-request:response',
      'botBrowser:tab-command:response',
      'network:status-change',
      'window-close',
      'window-maximize',
      'window-minimize',
      'window:move-by',
      'window:showSystemMenu',
    ],
    '`02` lists exactly 8 renderer-to-main send channels, all tier N',
  );
  const contractSendChannels = new Set(
    contract.methods.filter((method) => method.kind === 'send').map((method) => method.channel),
  );
  assert.deepEqual([...contractSendChannels].sort(), [...allowlist.SEND_CHANNELS].sort(), 'contract send channels must match SEND_CHANNELS');
});

test('spot checks from `02`: tiers, restrictions, timeouts', () => {
  const invoke = (channel) => allowlist.lookupInvokeChannel(channel);
  const event = (channel) => allowlist.lookupEventChannel(channel);

  // P1 with restrictions.
  assert.deepEqual(invoke('cowork:session:start'), { tier: 'P1', restrictions: ['R-cwd'], note: invoke('cowork:session:start').note });
  assert.deepEqual(invoke('cowork:config:set').restrictions, ['R-cfg']);
  assert.deepEqual(invoke('store:get').restrictions, ['R-store']);
  assert.deepEqual(invoke('store:set').restrictions, ['R-store']);
  assert.deepEqual(invoke('store:remove').restrictions, ['R-store']);
  assert.deepEqual(invoke('fs:readTextFile').restrictions, ['R-path']);
  assert.deepEqual(invoke('cowork:session:readLocalImage').restrictions, ['R-path']);
  assert.deepEqual(invoke('gateway:file:sign').restrictions, ['R-path']);
  assert.deepEqual(invoke('knowledgeBase:importFiles'), { tier: 'P2', restrictions: ['R-upload'], note: invoke('knowledgeBase:importFiles').note });
  assert.deepEqual(invoke('scheduledTask:create').restrictions, ['R-cwd', 'R-exec']);
  assert.deepEqual(invoke('scheduledTask:update').restrictions, ['R-cwd', 'R-exec']);
  assert.deepEqual(invoke('idbots:uploadMetabotHomepageFile'), { tier: 'P2', restrictions: ['R-size'], note: invoke('idbots:uploadMetabotHomepageFile').note });

  // Sensitive, shim, and never-tier channels.
  assert.equal(invoke('userIdentity:revealMnemonic').tier, 'H');
  assert.equal(invoke('idbots:getMetaBotMnemonic').tier, 'H');
  assert.equal(invoke('cowork:session:exportTranscript').tier, 'N');
  assert.equal(invoke('window:isMaximized').tier, 'S');
  assert.equal(invoke('startup:rendererInitialized').tier, 'S');
  assert.equal(invoke('dialog:selectFile').tier, 'S');
  assert.equal(invoke('shell:openExternal').tier, 'S');

  // Timeouts from `02` and C2 Limits.
  assert.equal(allowlist.DEFAULT_INVOKE_TIMEOUT_MS, 120_000);
  assert.equal(invoke('idbots:createMetaBotOnChain').timeoutMs, 300_000);
  assert.equal(invoke('idbots:createMetaBotOnChain').tier, 'P1');
  assert.equal(invoke('chainBackup:backup').timeoutMs, 900_000);
  assert.equal(invoke('chainBackup:backup').tier, 'P2');
  assert.equal(invoke('gigSquare:sendOrder').timeoutMs, 300_000);
  assert.equal(invoke('gigSquare:sendOrder').tier, 'P2');
  assert.equal(invoke('cowork:session:start').timeoutMs, undefined, 'only the three long-running channels carry a timeout override');

  // Staging-only note.
  assert.equal(invoke('traffic:mockConfirmRechargeOrder').tier, 'P1');
  assert.match(invoke('traffic:mockConfirmRechargeOrder').note, /staging/i);

  // Events.
  assert.equal(event('store:changed').tier, 'P1');
  assert.deepEqual(event('store:changed').restrictions, ['R-store']);
  assert.equal(event('chainBackup:restoreProgress').tier, 'N');
  assert.equal(event('agentGame:consentRequired').tier, 'N');
  assert.equal(event('window:state-changed').tier, 'N');
  assert.equal(event('cowork:stream:message').tier, 'P1');
  assert.equal(event('groupTask:statusChanged').tier, 'P2');
});

test('`02` invoke channels exist in the data: WS-A new channels + broad P1 spot-check', () => {
  const p1Channels = [
    // "New Channels Added by WS-A" (REQ-A-24 contract rows).
    'gateway:file:sign',
    'mobile:permission:listPending',
    'mobile:bootstrap:status',
    'bundle:getPlans',
    'bundle:createOrder',
    'bundle:getOrder',
    'bundle:getMeters',
    // Cowork P1.
    'cowork:session:start',
    'cowork:session:submitInput',
    'cowork:session:list',
    'cowork:session:getMessagesPage',
    'cowork:stream:liveContent',
    'cowork:permission:respond',
    'cowork:plan-mode:get',
    'cowork:plan-mode:set',
    'cowork:config:get',
    // MetaBots and identity P1.
    'metabot:list',
    'metabot:create',
    'metabot:setEnabled',
    'idbots:getMetaBots',
    'idbots:createMetaBotOnChain',
    'idbots:installOfficialSkill',
    'userIdentity:get',
    'userIdentity:retrySubsidy',
    'metaid:getUserInfo',
    // Skills, tasks, billing P1.
    'skills:list',
    'skills:setConfig',
    'scheduledTask:list',
    'scheduledTask:runManually',
    'traffic:getBalance',
    'traffic:createRechargeOrder',
    'llmRelay:getQuota',
    'feeRates:getTiers',
    // App, config, utilities P1.
    'app:getVersion',
    'app:getSystemLocale',
    'store:get',
    'get-api-config',
    'check-api-config',
    'generate-session-title',
    'fs:readTextFile',
  ];
  for (const channel of p1Channels) {
    const { entry, matched } = allowlist.lookupInvokeChannelWithSource(channel);
    assert.notEqual(matched, 'default', `${channel} must be tiered in the allowlist data`);
    assert.equal(entry.tier, 'P1', `${channel} must be P1 per \`02\``);
  }

  // Prefix groups from `02`.
  const prefixExpectations = [
    ['longtermTask:board', 'P1'],
    ['longtermTask:subtaskAdd', 'P1'],
    ['groupTask:create', 'P2'],
    ['groupTask:sendUserMessage', 'P2'],
    ['gigSquare:fetchServices', 'P2'],
    ['gigSquare:publishService', 'P2'],
    ['git:getBranch', 'N'],
    ['mcp:list', 'N'],
    ['projects:list', 'N'],
    ['metaapps:list', 'N'],
    ['metaappOwner:list', 'N'],
    ['agentGame:session', 'N'],
    ['teamCulture:list', 'N'],
    ['powerGuard:status', 'N'],
    ['permissions:checkCalendar', 'N'],
    ['appUpdate:download', 'N'],
    ['log:getPath', 'N'],
    ['botBrowser:capturePage', 'N'],
  ];
  for (const [channel, tier] of prefixExpectations) {
    const { entry, matched } = allowlist.lookupInvokeChannelWithSource(channel);
    assert.equal(matched, 'prefix', `${channel} must resolve through a \`02\` group row`);
    assert.equal(entry.tier, tier, `${channel} must be ${tier} per \`02\``);
  }

  // Named N invoke channels from `02`.
  for (const channel of [
    'api:fetch',
    'api:stream',
    'api:stream:cancel',
    'skills:download',
    'deepseek:getBalance',
    'save-api-config',
    'traffic:setSettings',
    'llmRelay:bootstrap',
    'llmRelay:setApiBase',
    'cowork:metafile:download',
    'cowork:sandbox:install',
    'cowork:sandbox:status',
    'cowork:session:exportResultImage',
    'cowork:session:saveResultImage',
    'idbots:executeTransfer',
    'idbots:executeTokenTransfer',
    'idbots:restoreMetaBotFromMnemonic',
    'userIdentity:create',
    'userIdentity:import',
    'userIdentity:logout',
    'knowledgeBase:openDir',
    'chainBackup:restore',
    'app:getAutoLaunch',
    'app:setAutoLaunch',
    'app:getExperimentalAutomation',
    'app:setExperimentalAutomation',
  ]) {
    assert.equal(allowlist.lookupInvokeChannel(channel).tier, 'N', `${channel} must be N per \`02\``);
  }
});

test('unknown channels default-deny to N without an explicit rule', () => {
  assert.deepEqual(allowlist.lookupInvokeChannelWithSource('totally:unknown'), { entry: { tier: 'N' }, matched: 'default' });
  assert.deepEqual(allowlist.lookupEventChannelWithSource('totally:unknown'), { entry: { tier: 'N' }, matched: 'default' });
  // Exact entries win over prefixes.
  assert.equal(allowlist.lookupInvokeChannelWithSource('gigSquare:sendOrder').matched, 'exact');
  assert.equal(allowlist.lookupEventChannelWithSource('agentGame:consentRequired').matched, 'exact');
  assert.equal(allowlist.lookupEventChannelWithSource('botBrowser:openUri').matched, 'prefix');
});
