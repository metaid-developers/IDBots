import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  isBotPrimaryBrainOnFreeRelay,
  summarizeFreeRelayUsage,
} from '../src/renderer/components/metabots/freeBrainBulkSwitch';
import {
  extractBurnSourceLabel,
  normalizeBurnLine,
  summarizeMeBurnBreakdown,
} from '../src/renderer/components/me/meBurnBreakdown';
import MeUsageAndCredits from '../src/renderer/components/me/MeUsageAndCredits';
import type { AppConfig } from '../src/renderer/config';

const sampleConfig = {
  model: {
    defaultModel: 'glm-5.3-flash',
    defaultProvider: 'idbots',
  },
  providers: {
    idbots: {
      enabled: true,
      apiKey: 'idbots-token',
      name: 'ID.Bots',
      models: [{ id: 'glm-5.3-flash', name: 'GLM 5.3 Flash' }],
    },
    deepseek: {
      enabled: true,
      apiKey: 'sk-ds-123',
      name: 'DeepSeek',
      models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }],
    },
    disabledOne: {
      enabled: false,
      apiKey: 'sk-disabled',
      name: 'Disabled',
      models: [{ id: 'm1', name: 'M1' }],
    },
  },
} as unknown as AppConfig;

test('freeBrainBulkSwitch identifies bots riding idbots/metaid-free and lists usable paid providers', () => {
  assert.equal(isBotPrimaryBrainOnFreeRelay({ llm_id: 'glm-5.3-flash', llm_provider: 'idbots' }, sampleConfig), true);
  assert.equal(isBotPrimaryBrainOnFreeRelay({ llm_id: 'glm-5.3-flash', llm_provider: 'metaid-free' }, sampleConfig), true);
  assert.equal(isBotPrimaryBrainOnFreeRelay({ llm_id: 'glm-5.3-flash', llm_provider: '' }, sampleConfig), true);
  assert.equal(isBotPrimaryBrainOnFreeRelay({ llm_id: 'deepseek-chat', llm_provider: 'deepseek' }, sampleConfig), false);
  assert.equal(isBotPrimaryBrainOnFreeRelay({ llm_id: '', llm_provider: '' }, sampleConfig), false);

  const summary = summarizeFreeRelayUsage([
    { id: 1, llm_id: 'glm-5.3-flash', llm_provider: 'idbots' },
    { id: 2, llm_id: 'glm-5.3-flash', llm_provider: null },
    { id: 3, llm_id: 'deepseek-chat', llm_provider: 'deepseek' },
    { id: 4, llm_id: null, llm_provider: null },
  ], sampleConfig);

  assert.deepEqual(summary.freeBrainBotIds, [1, 2]);
  assert.equal(summary.freeBrainBotCount, 2);
  assert.equal(summary.defaultRidesFree, true);
  assert.deepEqual(summary.paidProviders.map((p) => p.id), ['deepseek']);
});

test('meBurnBreakdown aggregates burn entries by metering line and source/model', () => {
  assert.equal(normalizeBurnLine('metering:llm'), 'llm');
  assert.equal(normalizeBurnLine('agent'), 'agent');
  assert.equal(normalizeBurnLine('metering:traffic'), 'traffic');
  assert.equal(normalizeBurnLine('unknown-ref'), 'other');

  assert.equal(
    extractBurnSourceLabel({ refType: 'metering:llm', reason: 'metering llm glm-5.3-flash qty=1200 mult=1' }, 'llm'),
    'glm-5.3-flash',
  );
  assert.equal(
    extractBurnSourceLabel({ refType: 'metering:traffic', reason: 'freeze capture ord-1 bot=1BuyerBot33333333333333333333333 txSize=420' }, 'traffic'),
    'bot 1Buyer…3333',
  );

  const summary = summarizeMeBurnBreakdown([
    { id: '1', type: 'topup', amountMilli: 50_000, reason: 'topup' },
    { id: '2', type: 'burn', amountMilli: -6_000, refType: 'metering:llm', reason: 'metering llm glm-5.3-flash qty=6000 mult=1' },
    { id: '3', type: 'burn', amountMilli: -2_000, refType: 'metering:llm', reason: 'metering llm glm-5.3-flash qty=2000 mult=1' },
    { id: '4', type: 'burn', amountMilli: -1_500, refType: 'metering:agent', reason: 'metering agent jev_task qty=1 mult=1.5' },
    { id: '5', type: 'burn', amountMilli: -500, refType: 'metering:traffic', reason: 'freeze capture ord-1 bot=1BuyerBot33333333333333333333333 txSize=250' },
  ]);

  assert.equal(summary.totalMilli, 10_000);
  assert.equal(summary.entryCount, 4);
  assert.deepEqual(
    summary.byLine.map((b) => ({ line: b.line, amountMilli: b.amountMilli, count: b.count })),
    [
      { line: 'llm', amountMilli: 8_000, count: 2 },
      { line: 'agent', amountMilli: 1_500, count: 1 },
      { line: 'traffic', amountMilli: 500, count: 1 },
    ],
  );
  assert.deepEqual(
    summary.bySource.map((s) => ({ label: s.label, line: s.line, amountMilli: s.amountMilli, count: s.count })),
    [
      { label: 'glm-5.3-flash', line: 'llm', amountMilli: 8_000, count: 2 },
      { label: 'jev_task', line: 'agent', amountMilli: 1_500, count: 1 },
      { label: 'bot 1Buyer…3333', line: 'traffic', amountMilli: 500, count: 1 },
    ],
  );
});

test('MeUsageAndCredits SSR render succeeds', () => {
  const html = renderToStaticMarkup(React.createElement(MeUsageAndCredits));
  assert.ok(html.includes('me-usage-buy-credits'));
});
