import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { createCoworkStore, createSqliteStore, getColumns } from './memoryTestUtils.mjs';

// Compiled main-side modules (compile:electron output).
const distRoot = fs.existsSync(new URL('../dist-electron/main/libs/tradeBadge.js', import.meta.url))
  ? '../dist-electron/main'
  : '../dist-electron';
const require = (await import('node:module')).createRequire(import.meta.url);
const { scanMessageTradeBadge, mergeTradeBadge } = require(`${distRoot}/libs/tradeBadge.js`);

const listedListed = (overrides = {}) => JSON.stringify({
  format: 'metacontract',
  genesis: '005d69cba8c80e6978157e146f998c21288a9d49',
  codehash: 'e205939ad9956673ce7da9fbd40514b30f66dc35',
  tokenIndex: '9131',
  name: 'MetaBot Avatar - Boots 12',
  action: 'listed',
  ...overrides,
});

const escrowCard = (overrides = {}) => JSON.stringify({
  format: 'metacontract',
  genesis: '2b5f8a84a1b2c3d4e5f60718293a4b5c6d7e8f90',
  codehash: 'e205939ad9956673ce7da9fbd40514b30f66dc35',
  tokenIndex: '6734',
  name: 'MetaBot Avatar - Sun 01',
  action: 'escrow',
  ...overrides,
});

const transferCard = (overrides = {}) => JSON.stringify({
  format: 'mrc721',
  pinId: 'a'.repeat(64) + 'i0',
  action: 'transferred',
  ...overrides,
});

const fence = (body, tag = 'nft-card') => `\`\`\`${tag}\n${body}\n\`\`\``;

test('scanMessageTradeBadge: sale/listing announcement → p2p', () => {
  const text = `已上架！\n\n${fence(listedListed())}`;
  assert.equal(scanMessageTradeBadge(text), 'p2p');
});

test('scanMessageTradeBadge: direct transfer → p2p; aliases nft/nftcard recognized', () => {
  assert.equal(scanMessageTradeBadge(fence(transferCard(), 'nft')), 'p2p');
  assert.equal(scanMessageTradeBadge(fence(transferCard(), 'nftcard')), 'p2p');
  assert.equal(scanMessageTradeBadge(fence(transferCard())), 'p2p');
});

test('scanMessageTradeBadge: escrow announcement → escrow, and outranks p2p in one text', () => {
  assert.equal(scanMessageTradeBadge(fence(escrowCard())), 'escrow');
  const mixed = `${fence(transferCard())}\n\n${fence(escrowCard())}`;
  assert.equal(scanMessageTradeBadge(mixed), 'escrow');
});

test('scanMessageTradeBadge: minted/info/no-action cards are NOT trades', () => {
  assert.equal(scanMessageTradeBadge(fence(listedListed({ action: 'minted' }))), null);
  assert.equal(scanMessageTradeBadge(fence(listedListed({ action: 'info' }))), null);
  assert.equal(scanMessageTradeBadge(fence(listedListed({ action: undefined }))), null);
});

test('scanMessageTradeBadge: analysis quotes with line-number noise never validate', () => {
  // The exact shape a worker's analysis text produces: fence bodies prefixed
  // with line numbers — JSON.parse fails, no badge.
  const quoted = [
    '13:  * ```',
    '13: {"format":"metacontract","genesis":"005d","action":"listed"}',
    '14:  * ```',
  ].join('\n');
  assert.equal(scanMessageTradeBadge(quoted), null);
});

test('scanMessageTradeBadge: invalid identity (bad genesis) is not evidence', () => {
  assert.equal(scanMessageTradeBadge(fence(listedListed({ genesis: 'nothex' }))), null);
  assert.equal(scanMessageTradeBadge(fence(listedListed({ genesis: 'zz'.repeat(20) }))), null);
});

test('scanMessageTradeBadge: nft-card-group array bodies classify with escrow precedence', () => {
  const groupBody = JSON.stringify([JSON.parse(transferCard()), JSON.parse(escrowCard())]);
  assert.equal(scanMessageTradeBadge(fence(groupBody, 'nft-card-group')), 'escrow');
  const p2pGroupBody = JSON.stringify([JSON.parse(listedListed()), JSON.parse(transferCard())]);
  assert.equal(scanMessageTradeBadge(fence(p2pGroupBody, 'nft-card-group')), 'p2p');
});

test('scanMessageTradeBadge: plain chat text and unterminated fences → null', () => {
  assert.equal(scanMessageTradeBadge('今天天气不错，聊聊天'), null);
  assert.equal(scanMessageTradeBadge('```nft-card\n{"action":"listed"', ), null);
  assert.equal(scanMessageTradeBadge(''), null);
  assert.equal(scanMessageTradeBadge(null), null);
});

test('mergeTradeBadge: escrow > p2p > null, upgrade-only', () => {
  assert.equal(mergeTradeBadge(null, 'p2p'), 'p2p');
  assert.equal(mergeTradeBadge('p2p', 'escrow'), 'escrow');
  assert.equal(mergeTradeBadge('escrow', 'p2p'), 'escrow', 'never downgrades');
  assert.equal(mergeTradeBadge('p2p', null), 'p2p');
  assert.equal(mergeTradeBadge(null, null), null);
});

test('S4 store integration: addMessage upgrades the session badge; listSessions surfaces it', async () => {
  const { cleanup, db, store: sqlite } = await createSqliteStore();
    const store = createCoworkStore(db);
  try {
    const session = store.createSession('交易会话', '/tmp/x', '', 'local', [], 5);
    const summaryBefore = store.listSessions().find((s) => s.id === session.id);
    assert.equal(summaryBefore.tradeBadge, null, 'fresh session has no trade badge');

    // A plain chat message: no badge.
    store.addMessage(session.id, { type: 'user', content: '帮我看看这个 NFT' });
    assert.equal(store.listSessions().find((s) => s.id === session.id).tradeBadge, null);

    // A listing announcement: p2p.
    store.addMessage(session.id, { type: 'assistant', content: `上架了：\n\n${fence(listedListed())}` });
    assert.equal(store.listSessions().find((s) => s.id === session.id).tradeBadge, 'p2p');

    // Later plain messages never downgrade.
    store.addMessage(session.id, { type: 'user', content: '好的收到' });
    assert.equal(store.listSessions().find((s) => s.id === session.id).tradeBadge, 'p2p');

    // An escrow announcement upgrades p2p → escrow.
    store.addMessage(session.id, { type: 'assistant', content: `担保交易已由担保人放行：\n\n${fence(escrowCard())}` });
    assert.equal(store.listSessions().find((s) => s.id === session.id).tradeBadge, 'escrow');
  } finally {
    cleanup();
  }
});

test('S4 store integration: a trade in a second session does not leak across sessions', async () => {
  const { cleanup, db, store: sqlite } = await createSqliteStore();
    const store = createCoworkStore(db);
  try {
    const tradeSession = store.createSession('交易', '/tmp/a', '', 'local', [], 5);
    const chatSession = store.createSession('纯聊天', '/tmp/b', '', 'local', [], 5);
    store.addMessage(tradeSession.id, { type: 'assistant', content: `成交：\n\n${fence(escrowCard())}` });
    store.addMessage(chatSession.id, { type: 'assistant', content: '今天不聊 NFT' });
    const byId = Object.fromEntries(store.listSessions().map((s) => [s.id, s.tradeBadge]));
    assert.equal(byId[tradeSession.id], 'escrow');
    assert.equal(byId[chatSession.id], null);
  } finally {
    cleanup();
  }
});

test('S4 migration: trade_badge column is additive and present exactly once', async () => {
  const { cleanup, db, store: sqlite } = await createSqliteStore();
    const store = createCoworkStore(db);
  try {
    const columns = getColumns(db, 'cowork_sessions');
    assert.equal(
      columns.filter((c) => c === 'trade_badge').length,
      1,
      'column exists exactly once after migration',
    );
    // A session row writes and reads back through the new column.
    const session = store.createSession('迁移冒烟', '/tmp/m', '', 'local', [], 5);
    db.run("UPDATE cowork_sessions SET trade_badge = 'p2p' WHERE id = ?", [session.id]);
    assert.equal(store.listSessions().find((s) => s.id === session.id).tradeBadge, 'p2p');
  } finally {
    cleanup();
  }
});
