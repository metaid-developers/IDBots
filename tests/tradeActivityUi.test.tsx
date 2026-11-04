import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { detectTradeActivity } from '../src/renderer/components/chat/tradeActivity';
import TradeActivityBadge from '../src/renderer/components/chat/TradeActivityBadge';
import GroupTaskMessageItem from '../src/renderer/components/groupTasks/GroupTaskMessageItem';
import A2AMessageItem from '../src/renderer/components/cowork/A2AMessageItem';
import CoworkSessionItem from '../src/renderer/components/cowork/CoworkSessionItem';
import type { CoworkSessionSummary } from '../src/renderer/types/cowork';
import type { GroupChatTranscriptMessage } from '../src/renderer/types/groupTask';

const listedCard = {
  format: 'metacontract',
  genesis: '005d69cba8c80e6978157e146f998c21288a9d49',
  codehash: 'e205939ad9956673ce7da9fbd40514b30f66dc35',
  tokenIndex: '9131',
  name: 'MetaBot Avatar - Boots 12',
  action: 'listed',
};

const escrowCard = {
  format: 'metacontract',
  genesis: '2b5f8a84a1b2c3d4e5f60718293a4b5c6d7e8f90',
  codehash: 'e205939ad9956673ce7da9fbd40514b30f66dc35',
  tokenIndex: '6734',
  action: 'escrow',
};

const transferCard = {
  format: 'mrc721',
  pinId: `${'a'.repeat(64)}i0`,
  action: 'transferred',
};

const fence = (body: unknown, tag = 'nft-card') =>
  `\`\`\`${tag}\n${typeof body === 'string' ? body : JSON.stringify(body)}\n\`\`\``;

/**
 * Renderer-side port of the hostStamp field: the structural shape the chip
 * detector accepts (v1.<ms>.<boundSession>.<64hex>) — no HMAC secret, HMAC
 * truth stays main-side.
 */
const stamp = (boundSession: string) =>
  `v1.1744444444000.${boundSession}.${'a'.repeat(64)}`;

test('detectTradeActivity: SIGNED/BOUND sale / transfer → p2p; escrow keeps hand-written contract', () => {
  const sid = 'session-emit';
  assert.deepEqual(
    detectTradeActivity(`上架：\n\n${fence({ ...listedCard, hostStamp: stamp(sid) })}`, { sessionId: sid }),
    { kind: 'p2p', actions: ['listed'] },
  );
  assert.deepEqual(
    detectTradeActivity(`转给你：\n\n${fence({ ...transferCard, hostStamp: stamp(sid) })}`, { sessionId: sid }),
    { kind: 'p2p', actions: ['transferred'] },
  );
  assert.deepEqual(detectTradeActivity(`担保放行：\n\n${fence(escrowCard)}`), { kind: 'escrow', actions: ['escrow'] });
  const mixed = `${fence(transferCard)}\n\n${fence(escrowCard)}`;
  assert.deepEqual(detectTradeActivity(mixed), { kind: 'escrow', actions: ['escrow'] });
});

test('detectTradeActivity: unsigned cards and out-of-session stamps leave no p2p chip', () => {
  const sid = 'session-emit';
  // Unsigned relay/report/demo card (the 2b74d76e mislabel case) → null.
  assert.equal(detectTradeActivity(fence(listedCard), { sessionId: sid }), null);
  // A signed card bound to ANOTHER session fails the binding here.
  assert.equal(detectTradeActivity(fence({ ...listedCard, hostStamp: stamp('other-session') }), { sessionId: sid }), null);
  // Malformed stamp shapes fail closed.
  assert.equal(detectTradeActivity(fence({ ...listedCard, hostStamp: 'vX.badsig' }), { sessionId: sid }), null);
});

test('detectTradeActivity: analysis quotes, minted cards and plain text → null', () => {
  assert.equal(detectTradeActivity('普通聊天，没有卡'), null);
  assert.equal(detectTradeActivity(fence({ ...listedCard, action: 'minted' })), null);
  const quoted = ['13:  * ```', '13: {"action":"listed"}', '14:  * ```'].join('\n');
  assert.equal(detectTradeActivity(quoted), null);
  assert.equal(detectTradeActivity('```nft-card\n{"action":"listed"'), null);
});

test('TradeActivityBadge: p2p and escrow render distinct icon pills with tooltips', () => {
  const p2p = renderToStaticMarkup(<TradeActivityBadge kind="p2p" variant="icon" />);
  const escrow = renderToStaticMarkup(<TradeActivityBadge kind="escrow" variant="icon" />);
  assert.match(p2p, /bg-sky-500\/15/);
  assert.match(p2p, /(此会话含 NFT 点对点交易|peer-to-peer trades)/);
  assert.match(escrow, /bg-amber-500\/15/);
  assert.match(escrow, /(此会话含 NFT 担保交易|escrow trades)/);
  assert.notEqual(p2p, escrow, 'the two kinds are visually distinct');

  const chip = renderToStaticMarkup(<TradeActivityBadge kind="escrow" variant="chip" />);
  assert.match(chip, /(NFT 担保交易|>NFT escrow<)/);
  assert.match(chip, /svg/);
});

const gtMessage = (content: string): GroupChatTranscriptMessage => ({
  id: 1,
  pinId: `${'b'.repeat(64)}i0`,
  txId: 'b'.repeat(64),
  senderName: 'Worker Bot',
  senderGlobalMetaId: 'idq1worker',
  senderAvatar: 'https://example.com/bot.png',
  content,
  contentType: 'text',
  chainTimestamp: new Date(2026, 10, 2, 23, 0, 0).getTime(),
  msgIndex: 1,
  replyPin: null,
});

test('group-task transcript: a trade announcement message carries the trade chip', () => {
  const withCard = renderToStaticMarkup(
    <GroupTaskMessageItem
      message={gtMessage(`担保交易完成：\n\n${fence(escrowCard)}`)}
      senderDisplayName="Worker Bot"
      isChairSender={false}
      isOwnerSender={false}
    />,
  );
  assert.match(withCard, /(NFT 担保交易|>NFT escrow<)/);
  assert.match(withCard, /bg-amber-500\/15/);

  const plain = renderToStaticMarkup(
    <GroupTaskMessageItem
      message={gtMessage('普通群聊消息')}
      senderDisplayName="Worker Bot"
      isChairSender={false}
      isOwnerSender={false}
    />,
  );
  assert.doesNotMatch(plain, /(NFT 担保交易|>NFT escrow<)/);
  assert.doesNotMatch(plain, /bg-amber-500\/15/);

  // Chain-side group transcripts carry no cowork session id: the chip gate
  // is the v1 stamp shape (bound-session equality is main-side truth there).
  const p2pSigned = renderToStaticMarkup(
    <GroupTaskMessageItem
      message={gtMessage(`已上架：\n\n${fence({ ...listedCard, hostStamp: stamp('some-emit-session') })}`)}
      senderDisplayName="Worker Bot"
      isChairSender={false}
      isOwnerSender={false}
    />,
  );
  assert.match(p2pSigned, /(NFT 交易|>NFT trade<)/);
  assert.match(p2pSigned, /bg-sky-500\/15/);

  const p2pUnsigned = renderToStaticMarkup(
    <GroupTaskMessageItem
      message={gtMessage(`已上架（转引）：\n\n${fence(listedCard)}`)}
      senderDisplayName="Worker Bot"
      isChairSender={false}
      isOwnerSender={false}
    />,
  );
  assert.doesNotMatch(p2pUnsigned, /(NFT 交易|>NFT trade<)/);
});

test('A2A private chat: a SIGNED+BOUND sale announcement message carries the trade chip in the meta row', () => {
  const markup = renderToStaticMarkup(
    <A2AMessageItem
      message={{
        id: 'msg-trade',
        type: 'assistant',
        content: `已上架：\n\n${fence({ ...listedCard, hostStamp: stamp('a2a-session') })}`,
        timestamp: 1_744_444_444_000,
        metadata: { direction: 'outgoing', txid: 'c'.repeat(64) },
      }}
      metabotName="Local Bot"
      sessionId="a2a-session"
    />,
  );
  assert.match(markup, /(NFT 交易|>NFT trade<)/);
  assert.match(markup, /bg-sky-500\/15/);
  assert.match(markup, /txid:/, 'the chain-message bubble branch renders');

  // An unsigned (hand-written/relay) p2p card no longer produces the chip.
  const unsigned = renderToStaticMarkup(
    <A2AMessageItem
      message={{
        id: 'msg-unsigned',
        type: 'assistant',
        content: `已上架（转引自他会话）：\n\n${fence(listedCard)}`,
        timestamp: 1_744_444_444_000,
        metadata: { direction: 'outgoing', txid: 'c'.repeat(64) },
      }}
      metabotName="Local Bot"
      sessionId="a2a-session"
    />,
  );
  assert.doesNotMatch(unsigned, /(NFT 交易|>NFT trade<)/);

  const plain = renderToStaticMarkup(
    <A2AMessageItem
      message={{
        id: 'msg-plain',
        type: 'assistant',
        content: '你好',
        timestamp: 1_744_444_444_000,
        metadata: { direction: 'outgoing', txid: 'c'.repeat(64) },
      }}
      metabotName="Local Bot"
    />,
  );
  assert.doesNotMatch(plain, /(NFT 交易|>NFT trade<)/);
});

const makeSession = (overrides: Partial<CoworkSessionSummary> = {}): CoworkSessionSummary => ({
  id: 'session-1',
  title: '交易会话',
  status: 'completed',
  pinned: false,
  createdAt: 1000,
  updatedAt: 1000,
  sessionType: 'standard',
  ...overrides,
});

test('session list row: tradeBadge renders the icon pill, plain rows stay clean', () => {
  const p2pRow = renderToStaticMarkup(
    <CoworkSessionItem
      session={makeSession({ tradeBadge: 'p2p' })}
      hasUnread={false}
      isActive={false}
      onSelect={() => {}}
      onDelete={() => {}}
      onTogglePin={() => {}}
      onRename={() => {}}
      nowMs={1_744_444_444_000}
    />,
  );
  assert.match(p2pRow, /bg-sky-500\/15/);
  assert.match(p2pRow, /(此会话含 NFT 点对点交易|peer-to-peer trades)/);

  const escrowRow = renderToStaticMarkup(
    <CoworkSessionItem
      session={makeSession({ tradeBadge: 'escrow' })}
      hasUnread={false}
      isActive={false}
      onSelect={() => {}}
      onDelete={() => {}}
      onTogglePin={() => {}}
      onRename={() => {}}
      nowMs={1_744_444_444_000}
    />,
  );
  assert.match(escrowRow, /bg-amber-500\/15/);
  assert.match(escrowRow, /(此会话含 NFT 担保交易|escrow trades)/);

  const plainRow = renderToStaticMarkup(
    <CoworkSessionItem
      session={makeSession()}
      hasUnread={false}
      isActive={false}
      onSelect={() => {}}
      onDelete={() => {}}
      onTogglePin={() => {}}
      onRename={() => {}}
      nowMs={1_744_444_444_000}
    />,
  );
  assert.doesNotMatch(plainRow, /bg-sky-500\/15/);
  assert.doesNotMatch(plainRow, /bg-amber-500\/15/);
});
