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
  metaletCompressUrlOf,
  metaletFileIdOf,
  NftCardDetailModal,
  resolveNftCardArtwork,
  showpayOriginalUrlOf,
} from '../src/renderer/components/chat/NftCard';
import { nftCardNeedsHeal, resolveNftCardHeal } from '../src/renderer/components/chat/nftCardHeal';
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

test('artwork resolution: compress canonical first; detail view puts the OSS original first (owner-finalized dual image-host spec)', () => {
  const CARD_FILE_ID = ICON.replace('metafile://', '').replace(/\.jpg$/, '');
  const artwork = resolveNftCardArtwork({ format: 'metacontract', ...CARD_PAYLOAD } as never);
  assert.equal(artwork.missing, false);
  // Card size: the no-www no-extension compress link derived from the icon
  // id is THE card thumbnail (owner spec 2026-11-02 23:08); the wire imgUrl
  // rides after it verbatim, then the metafile routes as last resort.
  assert.equal(artwork.sources[0], `https://metalet.space/metafile/compress/${CARD_FILE_ID}`);
  assert.equal(artwork.sources[1], IMG_URL);
  assert.match(artwork.sources[2], /files\/accelerate\/content\//);
  assert.match(artwork.sources[3], /files\/content\//);
  // Detail size (large): the showpay OSS original comes FIRST — sharper
  // than compress (live: 97KB vs 14KB, both 200 image/png) — then compress,
  // then the wire imgUrl.
  const detail = resolveNftCardArtwork({ format: 'metacontract', ...CARD_PAYLOAD } as never, { large: true });
  assert.equal(
    detail.sources[0],
    `https://showpay.oss-cn-beijing.aliyuncs.com/metaFile/original/${CARD_FILE_ID}.png`,
  );
  assert.equal(detail.sources[1], `https://metalet.space/metafile/compress/${CARD_FILE_ID}`);
  assert.equal(detail.sources[2], IMG_URL);
  // Icon-only metacontract fence (the owner's failing case): the compress
  // link is the FIRST renderable source, derived from the icon id.
  const iconOnly = resolveNftCardArtwork({
    format: 'metacontract',
    genesis: GENESIS,
    codehash: CODEHASH,
    tokenIndex: '1',
    icon: 'metafile://47ff4ea08168435ba9a9d271360923bff159c1719fd6420a4bb0e65b735f30e7.png',
  } as never);
  assert.equal(
    iconOnly.sources[0],
    'https://metalet.space/metafile/compress/47ff4ea08168435ba9a9d271360923bff159c1719fd6420a4bb0e65b735f30e7',
  );
  assert.equal(
    iconOnly.sources[0],
    metaletCompressUrlOf('metafile://47ff4ea08168435ba9a9d271360923bff159c1719fd6420a4bb0e65b735f30e7.png'),
  );
  // No artwork at all → placeholder path.
  const bare = resolveNftCardArtwork({ format: 'metacontract', genesis: GENESIS, codehash: CODEHASH, tokenIndex: '1' } as never);
  assert.equal(bare.missing, true);
  assert.deepEqual(bare.sources, []);
  // MRC-721 icons are real MetaID metafiles — the MetaLet detour never
  // applies at either size; the chain stays imgUrl → accelerate → content.
  const mrc = resolveNftCardArtwork({ format: 'mrc721', pinId: MRC721_PIN_ID, icon: `metafile://${MRC721_ICON_PIN}` } as never);
  assert.equal(mrc.missing, false);
  assert.equal(mrc.sources.some((source) => source.includes('metalet.space/metafile/compress/')), false);
  assert.match(mrc.sources[0], /files\/accelerate\/content\//);
  const mrcDetail = resolveNftCardArtwork(
    { format: 'mrc721', pinId: MRC721_PIN_ID, icon: `metafile://${MRC721_ICON_PIN}` } as never,
    { large: true },
  );
  assert.equal(mrcDetail.sources.some((source) => source.includes('showpay')), false);
  assert.match(mrcDetail.sources[0], /files\/accelerate\/content\//);
});

// --- MetaLet compress derivation --------------------------------------------

test('metaletFileIdOf / metaletCompressUrlOf / showpayOriginalUrlOf follow the finalized forms, rejecting everything unsafe', () => {
  const SAMPLE = '47ff4ea08168435ba9a9d271360923bff159c1719fd6420a4bb0e65b735f30e7';
  assert.equal(metaletCompressUrlOf(`metafile://${SAMPLE}.png`), `https://metalet.space/metafile/compress/${SAMPLE}`);
  // No www, no extension — the owner-pinned canonical form (host 301→www
  // which <img> follows; live-verified 200 image/png).
  assert.equal(metaletCompressUrlOf(`metafile://${SAMPLE}.png`)?.includes('www.'), false);
  // Bare image-host id (no scheme) derives the same link; so does an
  // extension-less icon and an uppercase id (normalized).
  assert.equal(metaletCompressUrlOf(`${SAMPLE}.png`), `https://metalet.space/metafile/compress/${SAMPLE}`);
  assert.equal(metaletCompressUrlOf(`metafile://${SAMPLE}`), `https://metalet.space/metafile/compress/${SAMPLE}`);
  assert.equal(
    metaletCompressUrlOf(`metafile://${SAMPLE.toUpperCase()}.png`),
    `https://metalet.space/metafile/compress/${SAMPLE}`,
  );
  // OSS original keeps the .png suffix per the finalized spec.
  assert.equal(
    showpayOriginalUrlOf(`metafile://${SAMPLE}.png`),
    `https://showpay.oss-cn-beijing.aliyuncs.com/metaFile/original/${SAMPLE}.png`,
  );
  // MRC-721-style pins are MetaID metafiles, not MetaLet ids — no derivation.
  assert.equal(metaletFileIdOf(`metafile://${MRC721_ICON_PIN}`), null);
  // Path segments, query strings, whitespace, short ids — never a URL.
  assert.equal(metaletCompressUrlOf('metafile://a/b.png'), null);
  assert.equal(metaletCompressUrlOf('metafile://../etc/passwd'), null);
  assert.equal(metaletCompressUrlOf('id.png?x=1'), null);
  assert.equal(metaletCompressUrlOf('  '), null);
  assert.equal(metaletFileIdOf('metafile://deadbeef.png'), null);
});

// --- heal channel (missing artwork / metacontract issuer) --------------------

test('nftCardNeedsHeal fires only for genuinely missing data', () => {
  // No artwork at all → heal.
  assert.equal(nftCardNeedsHeal({ format: 'metacontract', genesis: GENESIS, codehash: CODEHASH, tokenIndex: '1' }), true);
  // Artwork present, but this metacontract card carries no issuer (the v4
  // wire cannot provide one at emission time) and knows its owner → still
  // heals for the issuer.
  assert.equal(nftCardNeedsHeal({ format: 'metacontract', ...CARD_PAYLOAD }), true);
  // A fence-carried issuer label satisfies the card — no heal.
  assert.equal(
    nftCardNeedsHeal({ format: 'metacontract', ...CARD_PAYLOAD, issuerLabel: 'ShowPayTeam' }),
    false,
  );
  // No owner → the metacontract issuer channel has nothing to scope by → no heal.
  assert.equal(
    nftCardNeedsHeal({ format: 'metacontract', genesis: GENESIS, codehash: CODEHASH, tokenIndex: '1', imgUrl: IMG_URL }),
    false,
  );
  // MRC-721 with artwork → never (issuer is fence-carried on that format).
  assert.equal(nftCardNeedsHeal({ ...MRC721_PAYLOAD }), false);
  // MRC-721 without artwork → heals the artwork only.
  const { icon: mrcIcon, ...mrcBare } = MRC721_PAYLOAD;
  assert.equal(nftCardNeedsHeal(mrcBare), true);
  void mrcIcon;
});

test('resolveNftCardHeal passes the healed imgUrl through verbatim and caches per identity', async () => {
  const HEALED_IMG = 'https://metalet.space/metafile/compress/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png';
  let calls = 0;
  const stub = async () => {
    calls += 1;
    return { success: true, result: { imgUrl: HEALED_IMG, icon: 'not-a-metafile-uri', issuer: 'not-an-address' } };
  };
  globalThis.window = { electron: { idbots: { healNftCard: stub } } } as never;
  try {
    const data = {
      format: 'metacontract' as const,
      genesis: 'cc'.repeat(20),
      codehash: CODEHASH,
      tokenIndex: '9',
      owner: '1AxUdSkVdDyDreYSYVoDRFeyS1pvQdvcJx',
    };
    const first = await resolveNftCardHeal(data as never);
    assert.deepEqual(first, { imgUrl: HEALED_IMG }, 'imgUrl verbatim; icon/issuer sanitization drops junk');
    const second = await resolveNftCardHeal(data as never);
    assert.equal(calls, 1, 'second call is served from the process cache');
    assert.deepEqual(second, { imgUrl: HEALED_IMG });
  } finally {
    delete (globalThis as Record<string, unknown>).window;
  }
});

test('resolveNftCardHeal degrades to null with no bridge and never throws on IPC failure', async () => {
  // No window at all (SSR).
  assert.equal(await resolveNftCardHeal({ format: 'mrc721', pinId: `ff`.repeat(32) + 'i1' } as never), null);
  // Bridge present but failing / answering failure — still null, no throw.
  globalThis.window = {
    electron: { idbots: { healNftCard: async () => { throw new Error('boom'); } } },
  } as never;
  try {
    assert.equal(
      await resolveNftCardHeal({ format: 'mrc721', pinId: `ee`.repeat(32) + 'i2' } as never),
      null,
    );
  } finally {
    delete (globalThis as Record<string, unknown>).window;
  }
});

// --- format tag position: the IMAGE's bottom-right, card and detail ----------

test('the format tag sits inside the artwork wrapper — card and detail modal agree', () => {
  withWindowStub(() => {
    // ASCII name so the placeholder initials are unambiguous ('BO').
    const card = renderToStaticMarkup(
      <NftCard data={{ format: 'metacontract', genesis: GENESIS, codehash: CODEHASH, tokenIndex: '5028', name: 'Boots' }} />,
    );
    // Card: placeholder (no artwork) and format tag share the `relative`
    // wrapper, artwork content first, tag right after it.
    const wrapperOpen = card.indexOf('class="relative"');
    assert.ok(wrapperOpen > -1, 'card renders the relative artwork wrapper');
    const wrapperWindow = card.slice(wrapperOpen, wrapperOpen + 800);
    const initialsAt = wrapperWindow.indexOf('>BO<');
    const tagAt = wrapperWindow.indexOf('data-nft-format="metacontract"');
    assert.ok(
      initialsAt > -1 && tagAt > initialsAt,
      'the placeholder initials precede the format tag inside the artwork wrapper',
    );

    // Detail modal (SSR renders content directly): the wrapper never
    // stretches past the artwork (self-start), the tag hugs the image, and
    // the redundant Format field row is gone (the tag is the single source).
    const detail = renderToStaticMarkup(
      <NftCardDetailModal data={{ format: 'metacontract', ...CARD_PAYLOAD }} onClose={() => {}} />,
    );
    const detailWrapper = detail.indexOf('self-start');
    assert.ok(detailWrapper > -1, 'detail image wrapper is self-start (badge hugs the image, not the container)');
    const detailTag = detail.indexOf('data-nft-format="metacontract"');
    assert.ok(detailTag > detailWrapper, 'detail format tag sits inside the artwork column');
    assert.ok(!/>Format</.test(detail), 'no separate Format detail row — the tag is the single format source');
    assert.ok(!/fields as of the broadcast/.test(detail), 'the noisy note paragraph is deleted from the detail modal');
  });
});

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
    // Fixed four-row contract: price rides Row1 (right-aligned), Owner and
    // Issuer are constant slots — this metacontract fence carries no issuer,
    // so the Issuer slot shows the em-dash placeholder (heal fills it later).
    const seriesRow = markup.indexOf('data-nft-row="series"');
    const ownerRow = markup.indexOf('data-nft-row="owner"');
    const issuerRow = markup.indexOf('data-nft-row="issuer"');
    const priceAt = markup.indexOf('100,000 sats');
    assert.ok(
      seriesRow > -1 && priceAt > seriesRow && ownerRow > priceAt && issuerRow > ownerRow,
      'price rides Row1; Owner and Issuer stay the constant rows below',
    );
    assert.match(markup.slice(issuerRow), />—</, 'un-healed Issuer slot renders the em-dash placeholder');
    // First-paint src is the owner-finalized compress canonical form
    // (no www, no extension), derived from the fence icon.
    assert.match(
      markup,
      new RegExp(`src="https://metalet\\.space/metafile/compress/${ICON.replace('metafile://', '').replace(/\.jpg$/, '')}"`),
    );
    // Not the code-block rendering.
    assert.doesNotMatch(markup, /language-nft-card/);
  });
});

test('both formats render the same fixed four-row slots and tightened spacing (row-count equality)', () => {
  withWindowStub(() => {
    // MetaContract with full identity rows, MRC-721 with a fence-carried
    // issuer, and a bare metacontract card with neither owner nor issuer —
    // all three must expose exactly the rows series → owner → issuer, the
    // em-dash placeholders included, so grouped heights can never differ.
    const bare = parseNftCardFence(
      JSON.stringify({ format: 'metacontract', genesis: GENESIS, codehash: CODEHASH, tokenIndex: '7', name: 'X' }),
    )!;
    const markups = {
      metacontract: renderToStaticMarkup(<NftCard data={parseNftCardFence(JSON.stringify(CARD_PAYLOAD))!} />),
      mrc721: renderToStaticMarkup(<NftCard data={parseNftCardFence(JSON.stringify(MRC721_PAYLOAD))!} />),
      bare: renderToStaticMarkup(<NftCard data={bare} />),
    };
    const expected = ['data-nft-row="series"', 'data-nft-row="owner"', 'data-nft-row="issuer"'];
    for (const [format, markup] of Object.entries(markups)) {
      assert.deepEqual(
        markup.match(/data-nft-row="(series|owner|issuer)"/g),
        expected,
        `${format} renders the constant three-marker slot structure`,
      );
      assert.match(markup, /gap-\[3px\]/, 'text block uses the tightened 3px row gap');
      assert.match(markup, /px-2\.5 pt-1\.5 pb-2/, 'text block uses the tightened padding');
      assert.match(markup, /h-4/, 'identity rows pin h-4');
      if (format !== 'bare') {
        assert.match(markup, /h-3\.5 w-3\.5/, 'identity avatars pin h-3.5 w-3.5 when a chip renders');
      }
      assert.ok(!/pt-0/.test(markup), 'the old standalone price row wrapper is gone');
    }
    // Row1 carries the price right-aligned on the metacontract card; the
    // MRC-721 card shows it too (22000 sats).
    assert.match(markups.metacontract, /100,000 sats/);
    assert.match(markups.mrc721, /22,000 sats/);
    // Bare card: owner and issuer placeholders, never a chip.
    const bareIssuer = markups.bare.indexOf('data-nft-row="issuer"');
    assert.match(markups.bare.slice(bareIssuer), />—</);
    const bareOwner = markups.bare.indexOf('data-nft-row="owner"');
    assert.match(markups.bare.slice(bareOwner, bareIssuer), />—</);
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
    // Equal-height contract: the group stretches members (items-start gone)
    // and each card button fills the stretched row with h-full.
    assert.match(group, /items-stretch/);
    assert.doesNotMatch(group, /items-start/);
    assert.match(group, /h-full/);
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

// -------------------------------------------------------------------------
// Collection card (album-level) — `nft-collection-card` fence
// -------------------------------------------------------------------------

import {
  isNftCardFenceLanguage,
  isNftCollectionCardFenceLanguage,
  parseNftCollectionCardFence,
} from '../src/renderer/components/chat/nftCardSyntax';
import NftCollectionCard from '../src/renderer/components/chat/NftCollectionCard';

const COLLECTION_PIN_ID = `${'ab'.repeat(32)}i0`;

test('nft-collection-card: compiled main-side builder round-trips through the renderer parser', async () => {
  const builderPath = require.resolve('../dist-electron/main/libs/nftCardMarkdown.js');
  const { buildNftCollectionCardFence, buildMrc721CollectionCardFields } = require(builderPath) as {
    buildNftCollectionCardFence: (fields: Record<string, unknown>) => string;
    buildMrc721CollectionCardFields: (input: Record<string, unknown>) => Record<string, unknown>;
  };

  const fields = buildMrc721CollectionCardFields({
    collectionName: 'pixel-cats',
    pinId: COLLECTION_PIN_ID,
    name: 'Pixel Cats',
    desc: 'a series of pixel cats',
    cover: MRC721_ICON_PIN,
    totalSupply: 100,
    minted: 3,
    royaltyRate: 0,
    issuerAddress: '1IssuerAddress1234',
    action: 'issued',
  });
  assert.equal(fields.collectionId, COLLECTION_PIN_ID);
  assert.equal(fields.icon, `metafile://${MRC721_ICON_PIN}`);

  const fence = buildNftCollectionCardFence(fields);
  assert.ok(fence.startsWith('```nft-collection-card\n'), 'fence uses the collection tag');
  const parsed = parseNftCollectionCardFence(fence.split('\n').slice(1, -1).join(''));
  assert.equal(parsed?.collectionId, COLLECTION_PIN_ID);
  assert.equal(parsed?.collectionName, 'pixel-cats');
  assert.equal(parsed?.name, 'Pixel Cats');
  assert.equal(parsed?.totalSupply, 100);
  assert.equal(parsed?.minted, 3);
  assert.equal(parsed?.action, 'issued');

  // Tag isolation: the collection tag is never an item-card tag and vice versa.
  assert.equal(isNftCollectionCardFenceLanguage('nft-collection-card'), true);
  assert.equal(isNftCardFenceLanguage('nft-collection-card'), false);
});

test('nft-collection-card: parser requires a collectionid and degrades malformed payloads', () => {
  assert.equal(parseNftCollectionCardFence('not json'), null);
  assert.equal(parseNftCollectionCardFence(JSON.stringify({ name: 'no identity' })), null);
  assert.equal(parseNftCollectionCardFence(JSON.stringify({ collectionId: 'nothex' })), null);
  const parsed = parseNftCollectionCardFence(JSON.stringify({ collectionId: COLLECTION_PIN_ID, totalSupply: -1 }));
  assert.equal(parsed?.totalSupply, -1, 'totalSupply -1 (unlimited) survives parsing');
});

test('nft-collection-card: MarkdownContent renders the album card; malformed payload keeps the code block', () => {
  const goodFence = `\`\`\`nft-collection-card\n${JSON.stringify({
    collectionId: COLLECTION_PIN_ID,
    collectionName: 'pixel-cats',
    name: 'Pixel Cats',
    totalSupply: 100,
    minted: 3,
    action: 'issued',
  })}\n\`\`\``;
  const goodMarkup = renderToStaticMarkup(<MarkdownContent content={`Issued.\n\n${goodFence}`} />);
  assert.match(goodMarkup, /data-nft-collection-card="true"/);
  assert.match(goodMarkup, /Pixel Cats/);
  assert.match(goodMarkup, /3 \/ 100/);
  assert.match(goodMarkup, /\/pixel-cats/);

  const badMarkup = renderToStaticMarkup(
    <MarkdownContent content={'```nft-collection-card\nnot json\n```'} />,
  );
  assert.doesNotMatch(badMarkup, /data-nft-collection-card/);
  assert.match(badMarkup, /not json/);
});

test('nft-collection-card: component SSR anchors — unlimited supply label and coverless floor', () => {
  const html = renderToStaticMarkup(
    <NftCollectionCard data={{ collectionId: COLLECTION_PIN_ID, name: 'Open Series', totalSupply: -1, minted: 7 }} />,
  );
  assert.match(html, /data-nft-collection-card="true"/);
  assert.match(html, /7 minted · unlimited/);
  assert.match(html, /Open Series/);
});
