// S3 chat NFT cards — renderer side.
//
// One `nft-card` fenced block renders as an NftCard inside MarkdownContent,
// which is the single rendering path shared by all three chat surfaces
// (CoWork conversation bubbles, A2A private-chat bubbles, group/group-task
// transcripts). These tests pin:
//   1. the fence → NftCard branch (and the graceful code-block fallback for
//      malformed payloads — a hostile fence degrades exactly like any
//      unknown fence tag),
//   2. visual distinguishability anchors: a card carries the framed-card
//      markers (data-nft-card, series/name/owner/price labels) while a plain
//      markdown image stays the bare rounded <img> it has always been,
//   3. the A2A and group transcript message items really route the card
//      through (SSR of the real components),
//   4. the cross-side contract: the fence built by the COMPILED main-side
//      builder (dist-electron, what the wallet tools emit) parses back
//      through the renderer parser.
//
// Harness note: renderer tests are server-rendered (no DOM); the detail
// overlay only mounts on click, so its content is covered by the pure
// helpers plus the interactive evidence capture (tests/harness).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import MarkdownContent from '../src/renderer/components/MarkdownContent';
import A2AMessageItem from '../src/renderer/components/cowork/A2AMessageItem';
import GroupTaskMessageItem from '../src/renderer/components/groupTasks/GroupTaskMessageItem';
import NftCard, {
  formatNftPrice,
  resolveNftCardArtwork,
} from '../src/renderer/components/chat/NftCard';
import {
  isNftCardFenceLanguage,
  parseNftCardFence,
  serializeNftCardFence,
} from '../src/renderer/components/chat/nftCardSyntax';

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const GENESIS = '2b5f8a84150a74a488f6fff1eee9651ee0eb9eee';
const CODEHASH = 'e205939ad9956673ce7da9fbd40514b30f66dc35';
const IMG_URL = 'https://metalet.space/metafile/compress/fa43f1b55ca7cec99750bfec6d9d7f71f5951e367cd53368035d3ecc82721dec.jpg';
const ICON = 'metafile://fa43f1b55ca7cec99750bfec6d9d7f71f5951e367cd53368035d3ecc82721dec.jpg';

const CARD_PAYLOAD = {
  genesis: GENESIS,
  codehash: CODEHASH,
  tokenIndex: '5028',
  name: '小明',
  series: 'Metabot Gen 2',
  imgUrl: IMG_URL,
  icon: ICON,
  owner: '1GrqX7K9jdnUor8hAoAfDx99uFH2tT75Za',
  ownerLabel: 'AI_Sunny',
  priceSats: 100000,
  action: 'listed',
};

const CARD_FENCE = serializeNftCardFence(CARD_PAYLOAD);

const withWindowStub = (fn: () => void): void => {
  globalThis.window = { electron: { platform: 'darwin' } } as never;
  try {
    fn();
  } finally {
    delete (globalThis as Record<string, unknown>).window;
  }
};

// --- syntax layer ----------------------------------------------------------

test('fence language detection accepts the canonical tag and aliases', () => {
  assert.equal(isNftCardFenceLanguage('nft-card'), true);
  assert.equal(isNftCardFenceLanguage('NFT-Card'), true);
  assert.equal(isNftCardFenceLanguage('nftcard'), true);
  assert.equal(isNftCardFenceLanguage('nft'), true);
  assert.equal(isNftCardFenceLanguage('json'), false);
  assert.equal(isNftCardFenceLanguage(''), false);
});

test('parser accepts the full payload and rejects identity-invalid ones', () => {
  const data = parseNftCardFence(JSON.stringify(CARD_PAYLOAD));
  assert.ok(data);
  assert.equal(data.genesis, GENESIS);
  assert.equal(data.tokenIndex, '5028');
  assert.equal(data.name, '小明');
  assert.equal(data.priceSats, 100000);

  // Identity triple is the hard gate.
  assert.equal(parseNftCardFence(JSON.stringify({ ...CARD_PAYLOAD, genesis: 'nothex' })), null);
  assert.equal(parseNftCardFence(JSON.stringify({ ...CARD_PAYLOAD, tokenIndex: 'abc' })), null);
  assert.equal(parseNftCardFence('not json at all'), null);
  assert.equal(parseNftCardFence('[1,2]'), null);
  assert.equal(parseNftCardFence(''), null);
});

test('parser sanitizes hostile display fields', () => {
  const data = parseNftCardFence(JSON.stringify({
    ...CARD_PAYLOAD,
    name: 'a'.repeat(500),
    imgUrl: 'http://insecure.example/x.png',
    icon: 'javascript:alert(1)',
    owner: 'not an address!!',
    ownerLabel: 'line\nbreak attempt',
    priceSats: -5,
    action: 'x'.repeat(99),
  }));
  assert.ok(data);
  assert.equal(data.name!.length, 64);
  assert.equal(data.imgUrl, undefined, 'non-https artwork is dropped');
  assert.equal(data.icon, undefined, 'non-metafile icon is dropped');
  assert.equal(data.owner, undefined, 'malformed owner is dropped');
  assert.equal(data.ownerLabel, 'line break attempt', 'newlines collapse');
  assert.equal(data.priceSats, undefined, 'negative price is dropped');
  assert.equal(data.action!.length <= 16, true);
});

test('serialize keeps the pinned key order and round-trips through the parser', () => {
  const fence = serializeNftCardFence(CARD_PAYLOAD);
  assert.equal(
    fence,
    '```nft-card\n' + JSON.stringify(CARD_PAYLOAD) + '\n```',
  );
  const parsed = parseNftCardFence(fence.split('\n').slice(1, -1).join(''));
  assert.deepEqual(parsed, CARD_PAYLOAD);
});

// --- pure card helpers -----------------------------------------------------

test('formatNftPrice renders sats and a tidy SPACE amount', () => {
  assert.equal(formatNftPrice(100000), '100,000 sats · 0.001 SPACE');
  assert.equal(formatNftPrice(0), '0 sats');
  assert.equal(formatNftPrice(undefined), null);
});

test('artwork resolution orders https first, then the icon metafile routes', () => {
  const artwork = resolveNftCardArtwork(CARD_PAYLOAD as never);
  assert.equal(artwork.missing, false);
  assert.equal(artwork.sources[0], IMG_URL);
  assert.match(artwork.sources[1], /files\/accelerate\/content\//);
  assert.match(artwork.sources[2], /files\/content\//);
  // No artwork at all → placeholder path.
  const bare = resolveNftCardArtwork({ genesis: GENESIS, codehash: CODEHASH, tokenIndex: '1' } as never);
  assert.equal(bare.missing, true);
  assert.deepEqual(bare.sources, []);
});

// --- MarkdownContent branch ------------------------------------------------

test('an nft-card fence renders the card, not a code block', () => {
  withWindowStub(() => {
    const markup = renderToStaticMarkup(
      <MarkdownContent content={`Listing done.\n\n${CARD_FENCE}`} />,
    );
    assert.match(markup, /data-nft-card="true"/);
    assert.match(markup, /Metabot Gen 2/);
    assert.match(markup, /小明/);
    assert.match(markup, /#5028/);
    assert.match(markup, /AI_Sunny/);
    assert.match(markup, /100,000 sats/);
    assert.match(markup, /LISTED/);
    assert.match(markup, new RegExp(`src="${IMG_URL.replace(/\./g, '\\.')}"`));
    // Not the code-block rendering.
    assert.doesNotMatch(markup, /language-nft-card/);
  });
});

test('a malformed nft-card fence degrades to the plain code block', () => {
  withWindowStub(() => {
    const markup = renderToStaticMarkup(
      <MarkdownContent content={'```nft-card\n{"genesis":"oops"\n```'} />,
    );
    assert.doesNotMatch(markup, /data-nft-card/);
    // Falls into the standard "code block with language" rendering: fence
    // tag in the header, raw payload verbatim in the body.
    assert.match(markup, /<span>nft-card<\/span>/);
    assert.match(markup, /&quot;genesis&quot;/);
  });
});

test('a card without artwork renders the placeholder, never a broken image', () => {
  withWindowStub(() => {
    const fence = serializeNftCardFence({ genesis: GENESIS, codehash: CODEHASH, tokenIndex: '7' });
    const markup = renderToStaticMarkup(<MarkdownContent content={fence} />);
    assert.match(markup, /data-nft-card="true"/);
    assert.doesNotMatch(markup, /<img /);
    assert.match(markup, /NFT/);
  });
});

test('plain markdown images stay bare rounded imgs, visually distinct from cards', () => {
  withWindowStub(() => {
    const markup = renderToStaticMarkup(
      <MarkdownContent content={`![photo](${IMG_URL})`} />,
    );
    assert.match(markup, /<img[^>]+class="[^"]*rounded-xl[^"]*"/);
    assert.doesNotMatch(markup, /data-nft-card/);
    assert.doesNotMatch(markup, /LISTED|Owner|Series/);
    // And the card carries the framed markers the bare image never has.
    const cardMarkup = renderToStaticMarkup(<MarkdownContent content={CARD_FENCE} />);
    assert.match(cardMarkup, /data-nft-card="true"/);
    assert.match(cardMarkup, /Owner/);
    assert.match(cardMarkup, /border/);
  });
});

test('an NftCard renders directly with the detail copy hooks absent (overlay is click-only)', () => {
  withWindowStub(() => {
    const markup = renderToStaticMarkup(<NftCard data={parseNftCardFence(JSON.stringify(CARD_PAYLOAD))!} />);
    assert.match(markup, /data-nft-card="true"/);
    assert.match(markup, /aria-label="View NFT details: /);
    assert.doesNotMatch(markup, /data-nft-card-detail/);
  });
});

// --- the three real surfaces (SSR of the actual message components) --------

test('A2A private-chat bubble renders the card through its markdown path', () => {
  withWindowStub(() => {
    const markup = renderToStaticMarkup(
      <A2AMessageItem
        message={{
          id: 'msg-nft',
          type: 'assistant',
          content: `Escrow received.\n\n${CARD_FENCE}`,
          timestamp: 1_798_000_000_000,
          metadata: { direction: 'outgoing', txid: '1'.repeat(64) },
        }}
        metabotName="Local Bot"
      />,
    );
    assert.match(markup, /data-nft-card="true"/);
    assert.match(markup, /Metabot Gen 2/);
  });
});

test('group-task transcript bubble renders the card through its markdown path', () => {
  withWindowStub(() => {
    const markup = renderToStaticMarkup(
      <GroupTaskMessageItem
        message={{
          id: 'g-nft',
          content: `NFT_LISTED 播报：\n\n${CARD_FENCE}`,
          senderName: 'AI_Sunny',
          senderGlobalMetaId: 'idq1sender',
          chainTimestamp: 1_798_000_000_000,
        } as never}
        isChairSender={false}
        isOwnerSender={false}
      />,
    );
    assert.match(markup, /data-nft-card="true"/);
    assert.match(markup, /100,000 sats/);
  });
});

test('CoWork conversation surfaces render message content through MarkdownContent (source wiring)', () => {
  const source = fs.readFileSync(
    path.join(projectRoot, 'src', 'renderer', 'components', 'cowork', 'CoworkSessionDetail.tsx'),
    'utf8',
  );
  // Both the assistant narration bubble and the user bubble route through
  // MarkdownContent — the same component the card branch lives in.
  const assistantBubble = source.indexOf('assistant-bubble rounded-[22px]');
  const assistantMarkdown = source.indexOf('<MarkdownContent', assistantBubble);
  assert.ok(assistantBubble > -1 && assistantMarkdown > assistantBubble);
  assert.ok(source.includes("import MarkdownContent from '../MarkdownContent';"));
});

// --- cross-side contract: main-built fences parse in the renderer ----------

test('the compiled main-side builder emits fences the renderer parser accepts', () => {
  const builderPath = require.resolve('../dist-electron/main/libs/nftCardMarkdown.js');
  delete require.cache[builderPath];
  const { buildNftCardFence, appendNftCardBlock } = require(builderPath) as {
    buildNftCardFence: (fields: Record<string, unknown>) => string;
    appendNftCardBlock: (text: string, fields: Record<string, unknown>) => string;
  };
  const fields = { ...CARD_PAYLOAD };
  const fenceBody = buildNftCardFence(fields).split('\n').slice(1, -1).join('');
  const parsed = parseNftCardFence(fenceBody);
  assert.ok(parsed, 'renderer parser must accept exactly what the tools emit');
  assert.deepEqual(parsed, CARD_PAYLOAD);

  const appended = appendNftCardBlock('NFT listed for sale on-chain.', fields);
  assert.match(appended, /include this fenced block verbatim/i);
  assert.ok(appended.endsWith(buildNftCardFence(fields)));
});
