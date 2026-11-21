import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  formatPaybuzzCardFence,
  formatPaybuzzUnlockBadges,
  isPaybuzzCardFenceLanguage,
  parsePaybuzzCardFence,
  type PaybuzzCardData,
} from '../src/renderer/utils/paybuzzCardSyntax';
import PaybuzzCard from '../src/renderer/components/chat/PaybuzzCard';
import PaybuzzReaderView from '../src/renderer/components/commerce/PaybuzzReaderView';
import MarkdownContent from '../src/renderer/components/MarkdownContent';

const SAMPLE_PIN_ID = `${'aa'.repeat(32)}i0`;
const SAMPLE_ASSET_KEY = `mrc20:${'4f'.repeat(32)}i0`;
const SAMPLE_COLLECTION_PIN = `${'77'.repeat(32)}i0`;

const sampleCardData: PaybuzzCardData = {
  paybuzzPinId: SAMPLE_PIN_ID,
  title: '2027 AI Agent Micro-Economy Deep Report',
  preview: 'Public preview excerpt explaining how autonomous agents settle micropayments on chain.',
  wordCount: 6800,
  authorMetaId: 'idq1author00000000000000000000000000000000',
  authorName: 'EricResearch',
  unlockRules: {
    tokenPrices: [
      {
        assetKey: SAMPLE_ASSET_KEY,
        chain: 'btc',
        symbol: 'METAID',
        decimals: 8,
        amountBase: '1000000000',
        amountDisplay: '10',
        receiveAddress: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
      },
    ],
    vipMrc721Collections: [
      {
        collectionPinId: SAMPLE_COLLECTION_PIN,
        collectionName: 'Annual Alpha VIP Pass',
      },
    ],
  },
};

test('paybuzzCardSyntax: round-trips paybuzz-card fence, extracts unlock badges, rejects malformed fences', () => {
  assert.equal(isPaybuzzCardFenceLanguage('paybuzz-card'), true);
  assert.equal(isPaybuzzCardFenceLanguage('paybuzz'), true);
  assert.equal(isPaybuzzCardFenceLanguage('json'), false);

  const fence = formatPaybuzzCardFence(sampleCardData);
  const rawBody = fence.replace(/^```paybuzz-card\n|\n```$/g, '');
  const parsed = parsePaybuzzCardFence(rawBody);
  assert.ok(parsed);
  assert.equal(parsed.paybuzzPinId, SAMPLE_PIN_ID);
  assert.equal(parsed.title, sampleCardData.title);
  assert.equal(parsed.wordCount, 6800);
  assert.equal(parsed.unlockRules.tokenPrices.length, 1);
  assert.equal(parsed.unlockRules.vipMrc721Collections.length, 1);

  const badges = formatPaybuzzUnlockBadges(parsed.unlockRules);
  assert.equal(badges.length, 2);
  assert.equal(badges[0].kind, 'token');
  assert.equal(badges[0].label, '10 $METAID');
  assert.match(badges[0].assetBadge || '', /^ID: 4f4f4f…4f4fi0$/);
  assert.equal(badges[1].kind, 'vip');
  assert.match(badges[1].label, /Annual Alpha VIP Pass/);

  assert.equal(parsePaybuzzCardFence('{invalid json'), null);
  assert.equal(parsePaybuzzCardFence(JSON.stringify({ title: 'Missing pin and rules' })), null);
});

test('PaybuzzCard SSR: renders title, preview, word count, unlock badges, and Unlock action button', () => {
  const html = renderToStaticMarkup(
    React.createElement(PaybuzzCard, { data: sampleCardData }),
  );
  assert.match(html, /data-paybuzz-card="true"/);
  assert.match(html, /2027 AI Agent Micro-Economy Deep Report/);
  assert.match(html, /EricResearch/);
  assert.match(html, /6,800/);
  assert.match(html, /10 \$METAID/);
  assert.match(html, /VIP Card Free: Annual Alpha VIP Pass/);
  assert.match(html, /data-paybuzz-action="unlock"/);
});

test('PaybuzzReaderView SSR: renders VIP free-unlock banner, token micropayment banner, and Markdown body', () => {
  const vipHtml = renderToStaticMarkup(
    React.createElement(PaybuzzReaderView, {
      open: true,
      onClose: () => {},
      article: {
        paybuzzPinId: SAMPLE_PIN_ID,
        title: sampleCardData.title,
        authorName: 'EricResearch',
        wordCount: 6800,
        grantedVia: 'vip-nft',
        vipCollectionName: 'Annual Alpha VIP Pass',
        decryptedMarkdown: '## Chapter 1\n\nUnlocked via VIP membership.',
      },
    }),
  );
  assert.match(vipHtml, /data-paybuzz-reader="open"/);
  assert.match(vipHtml, /data-paybuzz-unlock-banner="vip-nft"/);
  assert.match(vipHtml, /Unlocked free with your VIP Member Card \(Annual Alpha VIP Pass\)/);
  assert.match(vipHtml, /<h2>Chapter 1<\/h2>/);

  const tokenHtml = renderToStaticMarkup(
    React.createElement(PaybuzzReaderView, {
      open: true,
      onClose: () => {},
      article: {
        paybuzzPinId: SAMPLE_PIN_ID,
        title: sampleCardData.title,
        grantedVia: 'token',
        decryptedMarkdown: 'Paid full article text.',
      },
    }),
  );
  assert.match(tokenHtml, /data-paybuzz-unlock-banner="token"/);
  assert.match(tokenHtml, /Unlocked via Token Micropayment/);
  assert.match(tokenHtml, /Paid full article text\./);
});

test('MarkdownContent: renders valid paybuzz-card fence as PaybuzzCard and keeps malformed JSON as plain code block', () => {
  const validMd = `Here is the report:\n\n${formatPaybuzzCardFence(sampleCardData)}`;
  const rendered = renderToStaticMarkup(
    React.createElement(MarkdownContent, { content: validMd }),
  );
  assert.match(rendered, /data-paybuzz-card="true"/);
  assert.match(rendered, /2027 AI Agent Micro-Economy Deep Report/);

  const invalidMd = '```paybuzz-card\n{not-valid-json}\n```';
  const fallbackRendered = renderToStaticMarkup(
    React.createElement(MarkdownContent, { content: invalidMd }),
  );
  assert.equal(/data-paybuzz-card="true"/.test(fallbackRendered), false);
  assert.match(fallbackRendered, /\{not-valid-json\}/);
});
