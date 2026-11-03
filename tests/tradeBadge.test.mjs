import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { createCoworkStore, createSqliteStore, getCompiledStores, getColumns, getSqlJs } from './memoryTestUtils.mjs';

// Compiled main-side modules (compile:electron output).
const distRoot = fs.existsSync(new URL('../dist-electron/main/libs/tradeBadge.js', import.meta.url))
  ? '../dist-electron/main'
  : '../dist-electron';
const require = (await import('node:module')).createRequire(import.meta.url);
const { scanMessageTradeBadge, scanMessageTradeBadgeLegacy, mergeTradeBadge, isBareTradeEmit, TRADE_EMIT_ANCHORS } = require(`${distRoot}/libs/tradeBadge.js`);
const { buildNftCardHostStamp, verifyNftCardHostStamp } = require(`${distRoot}/libs/tradeActivityStamp.js`);

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

/** Stamp a card body's source fields into the given "session being written INTO". */
const stampCard = (sessionId, bodyJson, tag = 'nft-card') => {
  const fields = JSON.parse(bodyJson);
  const hostStamp = buildNftCardHostStamp({ sessionId, fields });
  assert.ok(hostStamp, 'fixture stamp builds');
  assert.equal(verifyNftCardHostStamp({ hostStamp, sessionId, fields }), true, 'fixture stamp verifies');
  return fence(JSON.stringify({ ...fields, hostStamp }), tag);
};

/** The card JSON out of a stamped fence (stamp included — the wire row). */
const stampedRow = (sessionId, bodyJson, tag = 'nft-card') => JSON.parse(stampCard(sessionId, bodyJson, tag).split('\n')[1]);

test('scanMessageTradeBadge: SIGNED sale/listing announcement → p2p, bound to the write session', () => {
  const sid = '11111111-1111-1111-1111-111111111111';
  const text = `已上架！\n\n${stampCard(sid, listedListed())}`;
  assert.equal(scanMessageTradeBadge(text, { sessionId: sid }), 'p2p');
});

test('scanMessageTradeBadge: UNSIGNED (relay/report/demo) card fences never mark — the 2b74d76e case', () => {
  const sid = '11111111-1111-1111-1111-111111111111';
  // Legacy unsigned emitting-surface shape: a fence-first relay copy of
  // another session's transfer broadcast ("MRC721回填UTXO修复任务对接"
  // mislabel, message id 2b74d76e…, converted by the twin investigation).
  assert.equal(scanMessageTradeBadge(fence(transferCard()), { sessionId: sid }), null);
  assert.equal(scanMessageTradeBadge(`已上架！\n\n${fence(listedListed())}`, { sessionId: sid }), null);
  // No write context at all: fail closed.
  assert.equal(scanMessageTradeBadge(fence(listedListed())), null);
});

test('scanMessageTradeBadge: a signed card copied into ANOTHER session does not mark (session binding)', () => {
  const emitSid = '22222222-2222-2222-2222-222222222222';
  const otherSid = '33333333-3333-3333-3333-333333333333';
  const text = stampCard(emitSid, listedListed());
  assert.equal(scanMessageTradeBadge(text, { sessionId: emitSid }), 'p2p');
  assert.equal(scanMessageTradeBadge(text, { sessionId: otherSid }), null, 'cross-session relay copy fails binding');
});

test('scanMessageTradeBadge: tampered stamp does not mark', () => {
  const sid = '44444444-4444-4444-4444-444444444444';
  const fields = JSON.parse(listedListed());
  const hostStamp = buildNftCardHostStamp({ sessionId: sid, fields });
  assert.equal(verifyNftCardHostStamp({ hostStamp, sessionId: sid, fields }), true);
  // Two flipped tail nibbles → HMAC mismatch → no mark.
  const tampered = { ...fields, hostStamp: hostStamp.slice(0, -2) + (hostStamp.endsWith('ff') ? 'aa' : 'ff') };
  assert.equal(verifyNftCardHostStamp({ hostStamp: tampered.hostStamp, sessionId: sid, fields: tampered }), false);
  assert.equal(scanMessageTradeBadge(fence(JSON.stringify(tampered)), { sessionId: sid }), null);
  // Identity swap: a stamp built for the listed card onto a transfer card
  // (same session) — bound identity mismatch → no mark.
  assert.equal(
    scanMessageTradeBadge(fence(JSON.stringify({ hostStamp, ...JSON.parse(transferCard()) })), { sessionId: sid }),
    null,
  );
});

test('scanMessageTradeBadge: direct transfer with signature; aliases nft/nftcard recognized', () => {
  const sid = '11111111-1111-1111-1111-111111111111';
  assert.equal(scanMessageTradeBadge(stampCard(sid, transferCard(), 'nft'), { sessionId: sid }), 'p2p');
  assert.equal(scanMessageTradeBadge(stampCard(sid, transferCard(), 'nftcard'), { sessionId: sid }), 'p2p');
  assert.equal(scanMessageTradeBadge(stampCard(sid, transferCard()), { sessionId: sid }), 'p2p');
});

test('scanMessageTradeBadge: escrow announcement → escrow, and outranks p2p in one text', () => {
  assert.equal(scanMessageTradeBadge(fence(escrowCard())), 'escrow');
  // Escrow keeps the reserved hand-written contract here; an UNSIGNED p2p
  // card beside it contributes nothing while the escrow reading still wins.
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
  const sid = '11111111-1111-1111-1111-111111111111';
  const groupBody = JSON.stringify([stampedRow(sid, transferCard()), JSON.parse(escrowCard())]);
  assert.equal(scanMessageTradeBadge(fence(groupBody, 'nft-card-group'), { sessionId: sid }), 'escrow');
  const p2pGroupBody = JSON.stringify([
    stampedRow(sid, listedListed()),
    stampedRow(sid, transferCard()),
    JSON.parse(fence(listedListed()).split('\n')[1]), // unsigned row — contributes nothing
  ]);
  assert.equal(scanMessageTradeBadge(fence(p2pGroupBody, 'nft-card-group'), { sessionId: sid }), 'p2p');
});

test('scanMessageTradeBadge: plain chat text and unterminated fences → null', () => {
  assert.equal(scanMessageTradeBadge('今天天气不错，聊聊天'), null);
  assert.equal(scanMessageTradeBadge('```nft-card\n{"action":"listed"', ), null);
  assert.equal(scanMessageTradeBadge(''), null);
  assert.equal(scanMessageTradeBadge(null), null);
});

test('legacy re-judge: bare host emits keep badges without stamps; prose demos and relays unmark', () => {
  const sid = '11111111-1111-1111-1111-111111111111';
  // A real host emit IS the tool output: anchor first line, card attached,
  // no stamp (the message predated the stamp mechanism). The corrective
  // sweep keeps exactly this class.
  const bareEmit = `NFT transfer broadcast on-chain.\n- txid: ${'b'.repeat(64)}\n\n${fence(transferCard())}`;
  assert.equal(isBareTradeEmit(bareEmit), true);
  assert.equal(TRADE_EMIT_ANCHORS.length, 7);
  assert.equal(scanMessageTradeBadgeLegacy(bareEmit, sid), 'p2p');

  // Design prose with a demo card, and a fence-first cross-session mirror
  // copy (the orchestrator relay shape) fail the anchors and unmark.
  const prose = `设计讨论中演示一张卡：\n\n${fence(listedListed())}`;
  const relay = `\`\`\`nft-card\n${transferCard()}\n\`\`\``;
  assert.equal(isBareTradeEmit(prose), false);
  assert.equal(isBareTradeEmit(relay), false);
  assert.equal(scanMessageTradeBadgeLegacy(prose, sid), null);
  assert.equal(scanMessageTradeBadgeLegacy(relay, sid), null);

  // Escrow keeps the hand-written contract under the legacy sweep too.
  assert.equal(scanMessageTradeBadgeLegacy(fence(escrowCard()), sid), 'escrow');
});

test('mergeTradeBadge: escrow > p2p > null, upgrade-only', () => {
  assert.equal(mergeTradeBadge(null, 'p2p'), 'p2p');
  assert.equal(mergeTradeBadge('p2p', 'escrow'), 'escrow');
  assert.equal(mergeTradeBadge('escrow', 'p2p'), 'escrow', 'never downgrades');
  assert.equal(mergeTradeBadge('p2p', null), 'p2p');
  assert.equal(mergeTradeBadge(null, null), null);
});

test('S4 store integration: SIGNED emit announcements upgrade the session badge via addMessage', async () => {
  const { cleanup, db, store: sqlite } = await createSqliteStore();
  const store = createCoworkStore(db);
  try {
    const session = store.createSession('交易会话', '/tmp/x', '', 'local', [], 5);
    const summaryBefore = store.listSessions().find((s) => s.id === session.id);
    assert.equal(summaryBefore.tradeBadge, null, 'fresh session has no trade badge');

    // A plain chat message: no badge.
    store.addMessage(session.id, { type: 'user', content: '帮我看看这个 NFT' });
    assert.equal(store.listSessions().find((s) => s.id === session.id).tradeBadge, null);

    // An UNSIGNED listing announcement (report/relay/demo shape): no badge.
    store.addMessage(session.id, { type: 'assistant', content: `上架了：\n\n${fence(listedListed())}` });
    assert.equal(store.listSessions().find((s) => s.id === session.id).tradeBadge, null, 'unsigned card never marks');

    // A SIGNED listing announcement bound to this session: p2p.
    store.addMessage(session.id, { type: 'assistant', content: `上架了：\n\n${stampCard(session.id, listedListed())}` });
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

test('S4 correction sweep: pre-signing marks re-judged — unsigned relays/prose clear, bare emits keep', async () => {
  const { cleanup, db, store: sqlite, userDataPath } = await createSqliteStore();
  try {
    // createSqliteStore already ran the migration once (fresh column seeded
    // before any history existed, one-shot flag persisted). Create the
    // pre-signing history over the FULL schema now, seed the marks the old
    // unsigned scanner planted, then re-run initializeTables after clearing
    // the one-shot flag — the source-signing sweep re-judges everything.
    const relaySession = '77777777-7777-7777-7777-777777777777';
    const emitSession = '88888888-8888-8888-8888-888888888888';
    const proseSession = '99999999-9999-9999-9999-999999999999';
    const anchorSession = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    for (const [side, sid, title] of [
      [1, relaySession, '转述收到的转移卡'],
      [2, emitSession, 'MRC721 验收转移实测'],
      [3, proseSession, '设计文档引用演示卡'],
      [4, anchorSession, '早于卡附带的转移实测会话'],
    ]) {
      db.run(
        'INSERT INTO cowork_sessions (id, title, cwd, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
        [sid, title, `/tmp/sweep-${side}`, 1, 1],
      );
      db.run("UPDATE cowork_sessions SET trade_badge = 'p2p' WHERE id = ?", [sid]);
    }
    // The mislabel case (mirrors message 2b74d76e): a fence-first relay copy
    // of another session's real transfer.
    db.run("INSERT INTO cowork_messages (id, session_id, type, content, created_at, sequence) VALUES (?, ?, 'tool_result', ?, ?, 1)", [
      'm-relay', relaySession, `\`\`\`nft-card\n${transferCard()}\n\`\`\``, 2,
    ]);
    // A genuinely-executed bare emit (tool output IS the message).
    db.run("INSERT INTO cowork_messages (id, session_id, type, content, created_at, sequence) VALUES (?, ?, 'tool_result', ?, ?, 2)", [
      'm-emit', emitSession, `NFT purchase broadcast on-chain.\n- purchase txid: ${'c'.repeat(64)}\n- check txid: ${'d'.repeat(64)}\n\n${fence(listedListed({ action: 'bought' }))}`, 3,
    ]);
    // Design prose carrying a demo card (assistant narration, unsigned).
    db.run("INSERT INTO cowork_messages (id, session_id, type, content, created_at, sequence) VALUES (?, ?, 'assistant', ?, ?, 3)", [
      'm-prose', proseSession, `交付说明里演示一张卡：\n\n${fence(listedListed())}`, 4,
    ]);
    // An ANCHOR-ONLY host emit: the broadcast text but no card at all
    // (streamed pre-card-attach, mirrors live messages 03bebacd/306a6cd8).
    db.run("INSERT INTO cowork_messages (id, session_id, type, content, created_at, sequence) VALUES (?, ?, 'tool_result', ?, ?, 4)", [
      'm-anchor', anchorSession, `NFT transfer broadcast on-chain.\n- txid: ${'e'.repeat(64)}\n- token: #5028 (genesis 005d69cba8c80e6978157e146f998c21288a9d49)\n- Verify with wallet_nft_balance after the tx confirms.`, 5,
    ]);

    try {
      db.run("DELETE FROM cowork_config WHERE key = 'tradeBadgeSourceSignSwept'");
    } catch {
      // A store built before the flag existed: absence is fine.
    }
    sqlite.initializeTables(userDataPath);

    const badgeFor = (sid) => {
      const row = db.exec('SELECT trade_badge FROM cowork_sessions WHERE id = ?', [sid]);
      return row[0]?.values?.[0]?.[0] ?? null;
    };
    assert.equal(badgeFor(relaySession), null, 'relay copy unmarks');
    assert.equal(badgeFor(proseSession), null, 'prose demo unmarks');
    assert.equal(badgeFor(emitSession), 'p2p', 'genuinely-executed bare emit keeps its badge');
    assert.equal(badgeFor(anchorSession), 'p2p', 'anchor-only host emit (pre-card-attach streaming) keeps its badge');
    const flag = db.exec("SELECT key FROM cowork_config WHERE key = 'tradeBadgeSourceSignSwept'");
    assert.equal(flag[0]?.values?.length, 1, 'one-shot sweep flag persisted');
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
