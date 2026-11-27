import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AssetBridgeCardView } from '../src/renderer/components/chat/AssetBridgeCard';
import AssetBridgeNoticeCard from '../src/renderer/components/chat/AssetBridgeNoticeCard';
import type { AssetBridgeCardFenceData, AssetBridgeJobView } from '../src/renderer/components/chat/assetBridgeCardSyntax';
import {
  formatAssetBridgeCardFence,
  formatAssetBridgeNoticeFence,
} from '../src/renderer/components/chat/assetBridgeCardSyntax';
import { splitTokenCardMessageSegments } from '../src/renderer/components/chat/tokenCardSyntax';
import TokenSuiteSegmentCard from '../src/renderer/components/chat/TokenSuiteSegmentCard';
import MarkdownContent from '../src/renderer/components/MarkdownContent';

const JOB_ID = 'ab_123e4567-e89b-42d3-a456-426614174000';
const SOURCE_TXID = 'a41c90e2f84be22e6b7792aa441d8543a16f0e72c3f72154bbfe2c57a3de88f2';
const TARGET_TXID = 'c29a54e334fed79e9d014f511f83cf492eeacb034b1e882f2af0a6ff32cc93a1';
const NOW = 1_800_000_000_000;

function fees(overrides: Partial<AssetBridgeJobView['fees']> = {}): AssetBridgeJobView['fees'] {
  return {
    serviceBtcSats: 2292,
    serviceMvcSats: 0,
    bridgeMinerBtcSats: 0,
    bridgeMinerMvcSats: 0,
    walletMinerBtcSats: 1146,
    walletMinerMvcSats: 0,
    totalBtcSats: 3438,
    totalMvcSats: 0,
    btcFeeRate: 2,
    walletMinerMvcEstimated: true,
    ...overrides,
  };
}

function job(overrides: Partial<AssetBridgeJobView> = {}): AssetBridgeJobView {
  return {
    jobId: JOB_ID,
    metabotId: 1,
    metabotName: 'OrangeBot',
    sessionId: 'session_origin',
    scenario: 'mrc20_mint',
    sourceChain: 'btc',
    targetChain: 'mvc',
    sourceStandard: 'mrc20',
    targetStandard: 'mvc-ft',
    symbol: 'METAID',
    targetSymbol: 'METAID',
    amountDisplay: '1,000',
    receiveAmountDisplay: '1,000',
    fromAddress: '1SourceAddress123456789',
    receiveAddress: '1ReceiveAddress123456789',
    btcAddress: '1NxaBc74dEfgH7Qp2',
    mvcAddress: '1MvcAddressK9xe',
    fees: fees(),
    balances: { sourceAssetDisplay: '12,500 METAID', btcSats: 182000, mvcSats: 100000 },
    blockers: [],
    poolCapDisplay: '50,000',
    eta: { blocks: 3, blockChain: 'btc', minutes: 31 },
    quoteExpiresAt: NOW + 9 * 60_000,
    state: 'quote',
    stage: null,
    orderId: null,
    sourceTxid: null,
    targetTxid: null,
    requiredConfirmations: 3,
    confirmations: 0,
    lastConfirmationAt: null,
    broadcastAt: null,
    completedAt: null,
    feesPaid: null,
    error: null,
    notice: null,
    onComplete: null,
    updatedAt: NOW,
    ...overrides,
  };
}

const snapshot: AssetBridgeCardFenceData = {
  v: 1,
  jobId: JOB_ID,
  scenario: 'mrc20_mint',
  symbol: 'METAID',
  targetSymbol: 'METAID',
  amountDisplay: '1,000',
  state: 'quote',
};

function renderCard(j: AssetBridgeJobView, mode: 'live' | 'snapshot-missing-api' | 'snapshot-not-found' = 'live', now = NOW): string {
  return renderToStaticMarkup(
    React.createElement(AssetBridgeCardView, {
      job: j,
      snapshot,
      now,
      mode,
      onConfirm: () => undefined,
      onCancel: () => undefined,
      onRefresh: () => undefined,
    }),
  );
}

test('AssetBridgeCardView quote renders direction-A summary, badges, fees, wallet, and confirm actions', () => {
  const html = renderCard(job());
  assert.match(html, /data-asset-bridge-card="true"/);
  assert.match(html, /data-state="quote"/);
  assert.match(html, /1,000 METAID/);
  assert.match(html, /BTC · MRC-20/);
  assert.match(html, /MVC · MetaContract/);
  assert.match(html, /You receive/);
  assert.match(html, /3,438 sats BTC/);
  assert.match(html, /3 blocks · about 31 min/);
  assert.match(html, /OrangeBot/);
  assert.match(html, /1NxaBc…7Qp2/);
  assert.match(html, /Confirm bridge/);
  assert.match(html, /Cancel/);
  assert.match(html, /Quote expires in/);
});

test('AssetBridgeCardView quote blockers disable confirm and list blocker copy', () => {
  const html = renderCard(job({
    blockers: [{
      code: 'insufficient_btc_fee',
      messageEn: 'Insufficient BTC for fees: need about 3,438 sats, available 800 sats.',
      messageZh: 'BTC 费用余额不足：需要约 3,438 sats，当前只有 800 sats。',
    }],
  }));
  assert.match(html, /Insufficient BTC for fees/);
  assert.match(html, /disabled=""/);
  assert.match(html, /Top up first \/ Cancel/);
});

test('AssetBridgeCardView snapshot modes are read-only and explain why', () => {
  const missingApi = renderCard(job(), 'snapshot-missing-api');
  assert.match(missingApi, /Confirm and track this bridge in IDBots desktop/);
  assert.doesNotMatch(missingApi, />Confirm bridge</);
  assert.doesNotMatch(missingApi, />Cancel</);

  const notFound = renderCard(job(), 'snapshot-not-found');
  assert.match(notFound, /This bridge record is not on this device/);
  assert.doesNotMatch(notFound, />Confirm bridge</);
});

test('AssetBridgeCardView signing keeps quote content and shows the spinner state without actions', () => {
  const html = renderCard(job({ state: 'signing' }));
  assert.match(html, /Signing and broadcasting…/);
  assert.match(html, /You receive/);
  assert.doesNotMatch(html, />Confirm bridge</);
});

test('AssetBridgeCardView bridging renders progressbar, block stage, elapsed time, and source txid', () => {
  const broadcastAt = NOW - 12 * 60_000;
  const html = renderCard(job({
    state: 'bridging',
    stage: 'confirming',
    broadcastAt,
    lastConfirmationAt: NOW - 2 * 60_000,
    confirmations: 1,
    sourceTxid: SOURCE_TXID,
  }));
  assert.match(html, /role="progressbar"/);
  assert.match(html, /aria-valuenow="34"/);
  assert.match(html, /Waiting for BTC block 2 of 3/);
  assert.match(html, /12 min 0 s/);
  assert.match(html, /a41c90…88f2/);
});

test('AssetBridgeCardView pinned bridging hides minute ETA and shows the slow-block reassurance', () => {
  const broadcastAt = NOW - 11 * 60_000;
  const html = renderCard(job({
    state: 'bridging',
    stage: 'confirming',
    broadcastAt,
    lastConfirmationAt: broadcastAt,
    confirmations: 0,
    sourceTxid: SOURCE_TXID,
  }), 'live', NOW);
  assert.match(html, /waiting for the block/);
  assert.match(html, /slower than average/);
  assert.doesNotMatch(html, /about 31 min/);
});

test('AssetBridgeCardView completed renders amount, both txids, actual fees, duration, and follow-up chips', () => {
  const paid = fees({ totalBtcSats: 3500, serviceBtcSats: 2300, walletMinerBtcSats: 1200 });
  const html = renderCard(job({
    state: 'completed',
    broadcastAt: NOW - 31 * 60_000 - 12_000,
    completedAt: NOW,
    confirmations: 3,
    sourceTxid: SOURCE_TXID,
    targetTxid: TARGET_TXID,
    feesPaid: paid,
  }));
  assert.match(html, /\+1,000 METAID/);
  assert.match(html, /a41c90…88f2/);
  assert.match(html, /c29a54…93a1/);
  assert.match(html, /3,500 sats BTC/);
  assert.match(html, /31 min 12 sec/);
  assert.match(html, /View balance/);
  assert.match(html, /List for sale/);
  assert.match(html, /Bridge again/);
});

test('AssetBridgeCardView failed distinguishes untouched funds from moved funds and exposes recovery facts', () => {
  const unmoved = renderCard(job({
    state: 'failed',
    error: { messageEn: 'Interrupted before broadcast.', messageZh: '广播前中断。', fundsMoved: false },
  }));
  assert.match(unmoved, /Interrupted before broadcast/);
  assert.match(unmoved, /No funds were moved/);
  assert.match(unmoved, /Quote again/);

  const moved = renderCard(job({
    state: 'failed',
    orderId: 'order_moved_1',
    sourceTxid: SOURCE_TXID,
    error: { messageEn: 'Octopus payout retry exhausted.', messageZh: 'Octopus 入账重试耗尽。', fundsMoved: true },
  }));
  assert.match(moved, /Source funds were sent/);
  assert.match(moved, /order_moved_1/);
  assert.match(moved, /a41c90…88f2/);
});

test('AssetBridgeCardView expired renders refresh quote and cancelled renders compactly', () => {
  const expired = renderCard(job({ state: 'expired' }));
  assert.match(expired, /Quote expired/);
  assert.match(expired, /Refresh quote/);
  const cancelled = renderCard(job({ state: 'cancelled' }));
  assert.match(cancelled, /Bridge quote cancelled/);
  assert.doesNotMatch(cancelled, /Confirm bridge/);
});

test('AssetBridgeCardView redeem fee details include MVC service and bridge payout miner fees', () => {
  const redeem = job({
    scenario: 'btc_redeem',
    sourceChain: 'mvc',
    targetChain: 'btc',
    sourceStandard: 'mvc-ft',
    targetStandard: 'native',
    symbol: 'WBTC',
    targetSymbol: 'BTC',
    amountDisplay: '0.0005',
    receiveAmountDisplay: '0.0005',
    eta: { blocks: 1, blockChain: 'mvc', minutes: 11 },
    fees: fees({
      serviceBtcSats: 1280,
      serviceMvcSats: 90000,
      bridgeMinerBtcSats: 340,
      bridgeMinerMvcSats: 20000,
      walletMinerBtcSats: 300,
      walletMinerMvcSats: 25000,
      totalBtcSats: 1920,
      totalMvcSats: 135000,
    }),
  });
  const html = renderCard(redeem);
  assert.match(html, /0\.0005 WBTC/);
  assert.match(html, /0\.0005 BTC/);
  assert.match(html, /Bridge payout miner fee/);
  assert.match(html, /0\.00135 SPACE \+ 1,920 sats BTC/);
});

test('asset bridge fences split as standalone segments and render through suite and markdown paths', () => {
  const cardFence = formatAssetBridgeCardFence(snapshot);
  const noticeFence = formatAssetBridgeNoticeFence({
    v: 1,
    jobId: JOB_ID,
    status: 'completed',
    scenario: 'mrc20_mint',
    symbol: 'METAID',
    targetSymbol: 'METAID',
    amountDisplay: '1,000',
    targetChain: 'mvc',
    durationSec: 1872,
    targetTxid: TARGET_TXID,
  });
  const segments = splitTokenCardMessageSegments(`Before\n\n${cardFence}\n\nMiddle\n\n${noticeFence}\n\nAfter`);
  assert.equal(segments[1].kind, 'asset-bridge-card');
  assert.equal(segments[3].kind, 'asset-bridge-notice');

  if (segments[1].kind !== 'markdown') {
    const suiteHtml = renderToStaticMarkup(React.createElement(TokenSuiteSegmentCard, { segment: segments[1] }));
    assert.match(suiteHtml, /data-asset-bridge-card="true"/);
  }
  if (segments[3].kind !== 'markdown') {
    const noticeHtml = renderToStaticMarkup(React.createElement(TokenSuiteSegmentCard, { segment: segments[3] }));
    assert.match(noticeHtml, /data-asset-bridge-notice="true"/);
  }

  const markdownCard = renderToStaticMarkup(React.createElement(MarkdownContent, { content: cardFence }));
  assert.match(markdownCard, /data-asset-bridge-card="true"/);
  const markdownNotice = renderToStaticMarkup(React.createElement(MarkdownContent, { content: noticeFence }));
  assert.match(markdownNotice, /data-asset-bridge-notice="true"/);
});

test('AssetBridgeNoticeCard renders completion pill and failure reason', () => {
  const completed = renderToStaticMarkup(
    React.createElement(AssetBridgeNoticeCard, {
      data: {
        v: 1,
        jobId: JOB_ID,
        status: 'completed',
        scenario: 'mrc20_mint',
        symbol: 'METAID',
        targetSymbol: 'METAID',
        amountDisplay: '1,000',
        targetChain: 'mvc',
        durationSec: 1872,
        targetTxid: TARGET_TXID,
      },
    }),
  );
  assert.match(completed, /\+1,000 METAID/);
  assert.match(completed, /31m 12s/);
  assert.match(completed, /c29a54…93a1/);

  const failed = renderToStaticMarkup(
    React.createElement(AssetBridgeNoticeCard, {
      data: {
        v: 1,
        jobId: JOB_ID,
        status: 'failed',
        scenario: 'mrc20_mint',
        symbol: 'METAID',
        targetSymbol: 'METAID',
        amountDisplay: '1,000',
        targetChain: 'mvc',
        durationSec: 0,
        reasonEn: 'Bridge payout retry exhausted.',
        reasonZh: '桥节点入账重试耗尽。',
      },
    }),
  );
  assert.match(failed, /Bridge failed/);
  assert.match(failed, /Bridge payout retry exhausted/);
});

test('AssetBridgeCardView direction-aware rendering covers all four bridge scenarios', () => {
  const scenarios: Array<{
    scenario: AssetBridgeJobView['scenario'];
    sourceChain: AssetBridgeJobView['sourceChain'];
    targetChain: AssetBridgeJobView['targetChain'];
    sourceStandard: AssetBridgeJobView['sourceStandard'];
    targetStandard: AssetBridgeJobView['targetStandard'];
    sourceBadge: string;
    targetBadge: string;
  }> = [
    {
      scenario: 'btc_mint',
      sourceChain: 'btc',
      targetChain: 'mvc',
      sourceStandard: 'native',
      targetStandard: 'mvc-ft',
      sourceBadge: 'BTC · Native',
      targetBadge: 'MVC · MetaContract',
    },
    {
      scenario: 'mrc20_mint',
      sourceChain: 'btc',
      targetChain: 'mvc',
      sourceStandard: 'mrc20',
      targetStandard: 'mvc-ft',
      sourceBadge: 'BTC · MRC-20',
      targetBadge: 'MVC · MetaContract',
    },
    {
      scenario: 'btc_redeem',
      sourceChain: 'mvc',
      targetChain: 'btc',
      sourceStandard: 'mvc-ft',
      targetStandard: 'native',
      sourceBadge: 'MVC · MetaContract',
      targetBadge: 'BTC · Native',
    },
    {
      scenario: 'mrc20_redeem',
      sourceChain: 'mvc',
      targetChain: 'btc',
      sourceStandard: 'mvc-ft',
      targetStandard: 'mrc20',
      sourceBadge: 'MVC · MetaContract',
      targetBadge: 'BTC · MRC-20',
    },
  ];

  for (const item of scenarios) {
    const html = renderCard(job({
      scenario: item.scenario,
      sourceChain: item.sourceChain,
      targetChain: item.targetChain,
      sourceStandard: item.sourceStandard,
      targetStandard: item.targetStandard,
    }));
    assert.match(html, new RegExp(item.sourceBadge.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(html, new RegExp(item.targetBadge.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.equal(html.indexOf(`>${item.sourceChain === 'btc' ? 'BTC' : 'MVC'}<span`) < html.indexOf(`>${item.targetChain === 'btc' ? 'BTC' : 'MVC'}<span`), true);
  }
});
