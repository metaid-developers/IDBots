// S3 chat NFT cards — renderer side (dual format: MRC-721 primary,
// MetaContract compatible).
//
// One `nft-card` fenced block renders as an NftCard inside MarkdownContent,
// which is the single rendering path shared by all three chat surfaces
// (CoWork conversation bubbles, A2A private-chat bubbles, group/group-task
// transcripts). These tests pin:
//   1. the fence → NftCard branch for BOTH identity formats (and the graceful
//      code-block fallback for malformed payloads — a hostile fence degrades
//      exactly like any unknown fence tag),
//   2. visual anchors: the format tag (MRC-721 / MetaContract) at the card's
//      bottom-right, the framed-card markers (data-nft-card,
//      series/name/owner/price labels) that a plain markdown image never has,
//   3. multi-card grouping: adjacent fences merge into one horizontal-scroll
//      nft-card-group row; single fences keep the standalone layout,
//   4. identity degradation: owner/issuer chips fall back to the emitter
//      label, then a short address — never a blank card (SSR has no
//      electron.p2p bridge at all),
//   5. the A2A and group transcript message items really route the card
//      through (SSR of the real components), both formats,
//   6. the cross-side contract: fences built by the COMPILED main-side
//      builder (dist-electron, what the wallet/mrc721 tools emit) parse back
//      through the renderer parser, and both serializers agree byte-for-byte.
//
// Harness note: renderer tests are server-rendered (no DOM); the portal
// detail modal only mounts on click, so its content is covered by the pure
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
  groupAdjacentNftCardFences,
  isNftCardFenceLanguage,
  isNftCardGroupFenceLanguage,
  parseNftCardFence,
  parseNftCardGroupFence,
  serializeNftCardFence,
} from '../src/renderer/components/chat/nftCardSyntax';

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const GENESIS = '2b5f8a84150a74a488f6fff1eee9651ee0eb9eee';
const CODEHASH = 'e205939ad9956673ce7da9fbd40514b30f66dc35';
const IMG_URL = 'https://metalet.space/metafile/compress/fa43f1b55ca7cec99750bfec6d9d7f71f5951e367cd53368035d3ecc82721dec.jpg';
const ICON = 'metafile://fa43f1b55ca7cec99750bfec6d9d7f71f5951e367cd53368035d3ecc82721dec.jpg';
const MRC721_PIN_ID = `${'ab'.repeat(32)}i0`;
const MRC721_ICON_PIN = `${'cd'.repeat(32)}i0`;

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

const CARD_FENCE = serializeNftCardFence(parseNftCardFence(JSON.stringify(CARD_PAYLOAD))!);

const MRC721_PAYLOAD = {
  format: 'mrc721',
  pinId: MRC721_PIN_ID,
  number: 3,
  name: 'Pixel Cat',
  series: 'pixel-cats',
  icon: `metafile://${MRC721_ICON_PIN}`,
  owner: '1GrqX7K9jdnUor8hAoAfDx99uFH2tT75Za',
  ownerLabel: 'AI_Sunny',
  issuer: '1AxUdSkVdDyDreYSYVoDRFeyS1pvQdvcJx',
  priceSats: 22000,
  action: 'listed',
};

const MRC721_FENCE = serializeNftCardFence(MRC721_PAYLOAD as never);

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
  assert.equal(isNftCardGroupFenceLanguage('nft-card-group'), true);
  assert.equal(isNftCardGroupFenceLanguage('nft-card'), false);
});

test('parser accepts the full MetaContract payload and rejects identity-invalid ones', () => {
  const data = parseNftCardFence(JSON.stringify(CARD_PAYLOAD));
  assert.ok(data);
  assert.equal(data.format, 'metacontract', 'legacy payloads default to metacontract');
  assert.equal(data.genesis, GENESIS);
  assert.equal(data.tokenIndex, '5028');
  assert.equal(data.name, '小明');
  assert.equal(data.priceSats, 100000);

  // Identity triple is the hard gate for the legacy shape.
  assert.equal(parseNftCardFence(JSON.stringify({ ...CARD_PAYLOAD, genesis: 'nothex' })), null);
  assert.equal(parseNftCardFence(JSON.stringify({ ...CARD_PAYLOAD, tokenIndex: 'abc' })), null);
  assert.equal(parseNftCardFence('not json at all'), null);
  assert.equal(parseNftCardFence('[1,2]'), null);
  assert.equal(parseNftCardFence(''), null);
});

test('parser accepts MRC-721 dual identity: explicit format, lenient inference, strict pinId shape', () => {
  const data = parseNftCardFence(JSON.stringify(MRC721_PAYLOAD));
  assert.ok(data);
  assert.equal(data.format, 'mrc721');
  assert.equal(data.pinId, MRC721_PIN_ID);
  assert.equal(data.number, 3);
  assert.equal(data.series, 'pixel-cats');
  assert.equal(data.issuer, '1AxUdSkVdDyDreYSYVoDRFeyS1pvQdvcJx');
  assert.equal(data.ownerLabel, 'AI_Sunny');

  // Lenient: no format field + pinId only → mrc721.
  const inferred = parseNftCardFence(JSON.stringify({ pinId: MRC721_PIN_ID, name: 'X' }));
  assert.ok(inferred);
  assert.equal(inferred.format, 'mrc721');

  // Explicit mrc721 without a pinId → degrade to code block.
  assert.equal(parseNftCardFence(JSON.stringify({ format: 'mrc721', name: 'X' })), null);
  // Malformed pinId → degrade.
  assert.equal(parseNftCardFence(JSON.stringify({ format: 'mrc721', pinId: 'not-a-pin' })), null);
  assert.equal(parseNftCardFence(JSON.stringify({ format: 'mrc721', pinId: `${'zz'.repeat(32)}i0` })), null);
  // metafile://-wrapped pinId normalizes; uppercase hex lowercases.
  const wrapped = parseNftCardFence(JSON.stringify({ format: 'mrc721', pinId: `metafile://${'AB'.repeat(32)}i2` }));
  assert.ok(wrapped);
  assert.equal(wrapped.pinId, `${'ab'.repeat(32)}i2`);
  // Unknown explicit format → degrade (forward compatibility stays explicit).
  assert.equal(parseNftCardFence(JSON.stringify({ ...CARD_PAYLOAD, format: 'mrc404' })), null);
  // Neither identity → degrade.
  assert.equal(parseNftCardFence(JSON.stringify({ name: 'nothing identifiable' })), null);
  // Bare pinId icon (how MRC-721 covers arrive) normalizes to metafile://.
  const bareIcon = parseNftCardFence(JSON.stringify({ ...MRC721_PAYLOAD, icon: MRC721_ICON_PIN }));
  assert.ok(bareIcon);
  assert.equal(bareIcon.icon, `metafile://${MRC721_ICON_PIN}`);
});

test('parser sanitizes hostile display fields', () => {
  const data = parseNftCardFence(JSON.stringify({
    ...CARD_PAYLOAD,
    name: 'a'.repeat(500),
    imgUrl: 'http://insecure.example/x.png',
    icon: 'javascript:alert(1)',
    owner: 'not an address!!',
    ownerLabel: 'line\nbreak attempt',
    issuer: 'also not!! an address',
    priceSats: -5,
    number: -7,
    action: 'x'.repeat(99),
  }));
  assert.ok(data);
  assert.equal(data.name!.length, 64);
  assert.equal(data.imgUrl, undefined, 'non-https artwork is dropped');
  assert.equal(data.icon, undefined, 'non-metafile icon is dropped');
  assert.equal(data.owner, undefined, 'malformed owner is dropped');
  assert.equal(data.ownerLabel, 'line break attempt', 'newlines collapse');
  assert.equal(data.issuer, undefined, 'malformed issuer is dropped');
  assert.equal(data.priceSats, undefined, 'negative price is dropped');
  assert.equal(data.number, undefined, 'negative serial is dropped');
  assert.equal(data.action!.length <= 16, true);
});

test('serialize keeps the pinned key order and round-trips through the parser (both formats)', () => {
  const metacontract = parseNftCardFence(JSON.stringify(CARD_PAYLOAD))!;
  const fence = serializeNftCardFence(metacontract);
  assert.equal(
    fence,
    '```nft-card\n' + JSON.stringify({ format: 'metacontract', ...CARD_PAYLOAD }) + '\n```',
  );
  const parsed = parseNftCardFence(fence.split('\n').slice(1, -1).join(''));
  assert.deepEqual(parsed, { format: 'metacontract', ...CARD_PAYLOAD });

  const mrc721Fence = serializeNftCardFence(MRC721_PAYLOAD as never);
  assert.equal(
    mrc721Fence,
    '```nft-card\n' + JSON.stringify(MRC721_PAYLOAD) + '\n```',
  );
  const mrc721Parsed = parseNftCardFence(mrc721Fence.split('\n').slice(1, -1).join(''));
  assert.deepEqual(mrc721Parsed, MRC721_PAYLOAD);
});

// --- multi-card grouping ---------------------------------------------------

test('groupAdjacentNftCardFences merges adjacent runs and leaves everything else verbatim', () => {
  const fenceA = CARD_FENCE;
  const fenceB = MRC721_FENCE;
  const fenceC = serializeNftCardFence(parseNftCardFence(JSON.stringify({ ...CARD_PAYLOAD, tokenIndex: '5029' }))!);

  // Adjacent (blank lines only) → one group fence with a JSON array body.
  const merged = groupAdjacentNftCardFences(`Header\n\n${fenceA}\n\n${fenceB}\n\nTrailer`);
  assert.match(merged, /```nft-card-group\n\[\{.*\},\{.*\}\]\n```/s);
  assert.match(merged, /Header/);
  assert.match(merged, /Trailer/);
  const groupBody = merged.split('```nft-card-group\n')[1]!.split('\n```')[0];
  const groupCards = parseNftCardGroupFence(groupBody);
  assert.ok(groupCards);
  assert.equal(groupCards.length, 2);
  assert.equal(groupCards[0].format, 'metacontract');
  assert.equal(groupCards[1].format, 'mrc721');

  // Text between fences breaks the run: no group fence appears.
  const separated = groupAdjacentNftCardFences(`${fenceA}\n\nBetween text.\n\n${fenceB}`);
  assert.equal(separated, `${fenceA}\n\nBetween text.\n\n${fenceB}`);
  assert.doesNotMatch(separated, /nft-card-group/);

  // A single fence is never grouped.
  assert.equal(groupAdjacentNftCardFences(`Only one\n\n${fenceC}`), `Only one\n\n${fenceC}`);

  // Non-card fences pass through untouched.
  const codeFence = '```json\n{"a":1}\n```';
  assert.equal(groupAdjacentNftCardFences(`${codeFence}\n\n${codeFence}`), `${codeFence}\n\n${codeFence}`);

  // A malformed card body never merges (the whole run stays verbatim).
  const badFence = '```nft-card\n{"genesis":"oops"\n```';
  assert.equal(groupAdjacentNftCardFences(`${fenceA}\n\n${badFence}`), `${fenceA}\n\n${badFence}`);
});

test('parseNftCardGroupFence validates every entry and degrades to null when none survive', () => {
  const entries = JSON.stringify([CARD_PAYLOAD, MRC721_PAYLOAD, { genesis: 'nope' }]);
  const cards = parseNftCardGroupFence(entries);
  assert.ok(cards);
  assert.equal(cards.length, 2, 'the invalid entry is skipped, valid ones survive');
  assert.equal(cards[0].format, 'metacontract');
  assert.equal(cards[1].format, 'mrc721');
  // A single object body is tolerated (defensive wrap).
  assert.equal(parseNftCardGroupFence(JSON.stringify(CARD_PAYLOAD))!.length, 1);
  assert.equal(parseNftCardGroupFence('[{"genesis":"nope"}]'), null);
  assert.equal(parseNftCardGroupFence('not json'), null);
});

// --- pure card helpers -----------------------------------------------------

test('formatNftPrice renders sats and a tidy SPACE amount', () => {
  assert.equal(formatNftPrice(100000), '100,000 sats · 0.001 SPACE');
  assert.equal(formatNftPrice(0), '0 sats');
  assert.equal(formatNftPrice(undefined), null);
});

test('artwork resolution orders https first, then the icon metafile routes', () => {
  const artwork = resolveNftCardArtwork({ format: 'metacontract', ...CARD_PAYLOAD } as never);
  assert.equal(artwork.missing, false);
  assert.equal(artwork.sources[0], IMG_URL);
  assert.match(artwork.sources[1], /files\/accelerate\/content\//);
  assert.match(artwork.sources[2], /files\/content\//);
  // No artwork at all → placeholder path.
  const bare = resolveNftCardArtwork({ format: 'metacontract', genesis: GENESIS, codehash: CODEHASH, tokenIndex: '1' } as never);
  assert.equal(bare.missing, true);
  assert.deepEqual(bare.sources, []);
  // MRC-721 bare-pin icon resolves through the same chain.
  const mrc = resolveNftCardArtwork({ format: 'mrc721', pinId: MRC721_PIN_ID, icon: `metafile://${MRC721_ICON_PIN}` } as never);
  assert.equal(mrc.missing, false);
  assert.match(mrc.sources[0], /files\/accelerate\/content\//);
});

// --- MarkdownContent branch ------------------------------------------------

test('an nft-card fence renders the card with the format tag, not a code block', () => {
  withWindowStub(() => {
    const markup = renderToStaticMarkup(
      <MarkdownContent content={`Listing done.\n\n${CARD_FENCE}`} />,
    );
    assert.match(markup, /data-nft-card="true"/);
    assert.match(markup, /data-nft-format="metacontract"/);
    assert.match(markup, />MetaContract</);
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

test('an MRC-721 nft-card fence renders collection/number/owner/issuer with its own tag', () => {
  withWindowStub(() => {
    const markup = renderToStaticMarkup(
      <MarkdownContent content={`Minted.\n\n${MRC721_FENCE}`} />,
    );
    assert.match(markup, /data-nft-card="true"/);
    assert.match(markup, /data-nft-format="mrc721"/);
    assert.match(markup, />MRC-721</);
    assert.match(markup, /pixel-cats/);
    assert.match(markup, /Pixel Cat/);
    assert.match(markup, /#3/);
    assert.match(markup, /data-nft-pin-id=/);
    // Identity degradation without a bridge: emitter labels win.
    assert.match(markup, /AI_Sunny/);
    // Issuer chip renders (label absent → short-address fallback is live).
    assert.match(markup, /Issuer/);
    assert.doesNotMatch(markup, /language-nft-card/);
  });
});

test('identity chips degrade to labels and short addresses — never blank (no bridge)', () => {
  withWindowStub(() => {
    const fence = serializeNftCardFence({
      format: 'mrc721',
      pinId: MRC721_PIN_ID,
      series: 'pixel-cats',
      owner: '1GrqX7K9jdnUor8hAoAfDx99uFH2tT75Za',
      issuer: '1AxUdSkVdDyDreYSYVoDRFeyS1pvQdvcJx',
      action: 'info',
    } as never);
    const markup = renderToStaticMarkup(<MarkdownContent content={fence} />);
    assert.match(markup, /data-nft-card="true"/);
    // Owner/issuer without labels → short-address fallback chips. Card intact.
    assert.match(markup, /data-nft-identity="1GrqX7K9jdnUor8hAoAfDx99uFH2tT75Za"/);
    assert.match(markup, /data-nft-identity="1AxUdSkVdDyDreYSYVoDRFeyS1pvQdvcJx"/);
    assert.match(markup, /1GrqX7K9…/);
    assert.match(markup, /1AxUdSkV…/);
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
    const fence = serializeNftCardFence({ format: 'metacontract', genesis: GENESIS, codehash: CODEHASH, tokenIndex: '7' } as never);
    const markup = renderToStaticMarkup(<MarkdownContent content={fence} />);
    assert.match(markup, /data-nft-card="true"/);
    assert.doesNotMatch(markup, /<img /);
    assert.match(markup, /NFT/);
    // The format tag survives on the placeholder card.
    assert.match(markup, /data-nft-format="metacontract"/);
  });
});

test('adjacent fences render one horizontal-scroll group; a single fence stays standalone', () => {
  withWindowStub(() => {
    const group = renderToStaticMarkup(
      <MarkdownContent content={`Two cards:\n\n${CARD_FENCE}\n\n${MRC721_FENCE}`} />,
    );
    assert.match(group, /data-nft-card-group="true"/);
    assert.match(group, /overflow-x-auto/);
    assert.equal((group.match(/data-nft-card="true"/g) ?? []).length, 2);
    assert.match(group, /data-nft-format="metacontract"/);
    assert.match(group, /data-nft-format="mrc721"/);
    // Both cards sit inside the one group container.
    const containerStart = group.indexOf('data-nft-card-group');
    const firstCard = group.indexOf('data-nft-card="true"');
    assert.ok(containerStart > -1 && firstCard > containerStart);

    // Single fence: no group container, card directly under the message.
    const single = renderToStaticMarkup(
      <MarkdownContent content={`One card:\n\n${CARD_FENCE}`} />,
    );
    assert.doesNotMatch(single, /data-nft-card-group/);
    assert.match(single, /data-nft-card="true"/);

    // Text between fences: two standalone cards, still no group.
    const separated = renderToStaticMarkup(
      <MarkdownContent content={`${CARD_FENCE}\n\nText between.\n\n${MRC721_FENCE}`} />,
    );
    assert.doesNotMatch(separated, /data-nft-card-group/);
    assert.equal((separated.match(/data-nft-card="true"/g) ?? []).length, 2);
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

test('an NftCard renders directly with the detail modal absent (portal is click-only)', () => {
  withWindowStub(() => {
    const markup = renderToStaticMarkup(<NftCard data={parseNftCardFence(JSON.stringify(CARD_PAYLOAD))!} />);
    assert.match(markup, /data-nft-card="true"/);
    assert.match(markup, /aria-label="View NFT details: /);
    assert.doesNotMatch(markup, /data-nft-card-detail/);
    // The MRC-721 flavor renders with its own tag; modal likewise click-only.
    const mrcMarkup = renderToStaticMarkup(<NftCard data={parseNftCardFence(JSON.stringify(MRC721_PAYLOAD))!} />);
    assert.match(mrcMarkup, /data-nft-format="mrc721"/);
    assert.doesNotMatch(mrcMarkup, /data-nft-card-detail/);
  });
});

// --- the three real surfaces (SSR of the actual message components) --------

test('A2A private-chat bubble renders both card formats through its markdown path', () => {
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
    assert.match(markup, /data-nft-format="metacontract"/);

    const mrcMarkup = renderToStaticMarkup(
      <A2AMessageItem
        message={{
          id: 'msg-nft-2',
          type: 'assistant',
          content: `MRC-721 escrow received.\n\n${MRC721_FENCE}`,
          timestamp: 1_798_000_000_000,
          metadata: { direction: 'outgoing', txid: '2'.repeat(64) },
        }}
        metabotName="Local Bot"
      />,
    );
    assert.match(mrcMarkup, /data-nft-format="mrc721"/);
    assert.match(mrcMarkup, /pixel-cats/);
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
    assert.match(markup, />MetaContract</);
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

test('the compiled main-side builder emits fences the renderer parser accepts (both formats, byte-identical serializers)', () => {
  const builderPath = require.resolve('../dist-electron/main/libs/nftCardMarkdown.js');
  delete require.cache[builderPath];
  const { buildNftCardFence, appendNftCardBlock } = require(builderPath) as {
    buildNftCardFence: (fields: Record<string, unknown>) => string;
    appendNftCardBlock: (text: string, fields: Record<string, unknown>) => string;
  };
  const fields = { ...CARD_PAYLOAD, format: 'metacontract' };
  const fenceBody = buildNftCardFence(fields).split('\n').slice(1, -1).join('');
  const parsed = parseNftCardFence(fenceBody);
  assert.ok(parsed, 'renderer parser must accept exactly what the tools emit');
  assert.deepEqual(parsed, fields);
  // Renderer serializer and main builder agree byte-for-byte on the same input.
  assert.equal(serializeNftCardFence(parsed), buildNftCardFence(fields));

  const mrcFields = { ...MRC721_PAYLOAD };
  const mrcBody = buildNftCardFence(mrcFields).split('\n').slice(1, -1).join('');
  const mrcParsed = parseNftCardFence(mrcBody);
  assert.ok(mrcParsed, 'renderer parser must accept the mrc721 fence the tools emit');
  assert.deepEqual(mrcParsed, mrcFields);
  assert.equal(serializeNftCardFence(mrcParsed), buildNftCardFence(mrcFields));

  const appended = appendNftCardBlock('NFT listed for sale on-chain.', fields);
  assert.match(appended, /include this fenced block verbatim/i);
  assert.ok(appended.endsWith(buildNftCardFence(fields)));
});
