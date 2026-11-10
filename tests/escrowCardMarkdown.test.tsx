/**
 * S3 escrow trade card — renderer side (skeleton slice).
 *
 * One `escrow-card` fenced block renders as an EscrowCard inside
 * MarkdownContent — the single markdown path shared by all three chat
 * surfaces (CoWork conversation, A2A private chat, group/group-task
 * transcripts). These tests pin:
 *   1. the fence → EscrowCard branch (state label / next actor / remaining
 *      time / amount / custody proof all present),
 *   2. graceful degradation: broken JSON, unknown state, missing parties —
 *      all fall back to the plain code block, never a half-rendered card,
 *   3. the skeleton has NO funds controls (zero-funds-flow red line): the
 *      only control is the 申诉/复核 entry, which expands to the appeal rules
 *      and a copyable dispute_open template — it instructs, never moves money,
 *   4. marker/style isolation: data-escrow-card only, never data-nft-card or
 *      the (unmerged) pay-card markers — fence tags stay disjoint,
 *   5. source wiring: MarkdownContent keeps the escrow branch, and the A2A /
 *      group transcript components keep routing content through it.
 *
 * Harness note: renderer tests are server-rendered (no DOM), same as the
 * nft-card suite. UI copy goes through i18nService; these assertions pin the
 * default 'en' locale deck (2026-11-10 release review: the card previously
 * hardcoded Chinese copy, violating the English-default UI rule).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import MarkdownContent from '../src/renderer/components/MarkdownContent';
import EscrowCard from '../src/renderer/components/chat/EscrowCard';
import {
  buildEscrowAppealTemplate,
  ESCROW_CARD_FENCE_TAG,
  ESCROW_CARD_TERMINAL_STATES,
  escrowCardStateLabel,
  escrowRemainingTimeText,
  formatEscrowYuan,
  isEscrowCardFenceLanguage,
  parseEscrowCardFence,
  serializeEscrowCardFence,
  type EscrowCardData,
} from '../src/renderer/components/chat/escrowCardSyntax';

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

// Relative to the real clock: T1 renders via MarkdownContent, which passes
// no `now` to EscrowCard, so the card reads Date.now() at render time. The
// fixture previously used a literal timestamp and went red on 2026-11-04
// when the wall clock walked past its 24h deadline — same mechanism, now
// anchored to the process clock so the deadline always stays 23h ahead.
const STATE_ENTERED_AT = Date.now() - 60 * 60 * 1000;

const PAYLOAD: EscrowCardData = {
  orderId: 'esc-42',
  title: '星球系列 #3',
  kind: 'mrc721',
  amountCents: 9900,
  state: 'ITEM_ESCROWED',
  stateEnteredAt: STATE_ENTERED_AT,
  timerHours: 24,
  next: { actor: '买方', text: '请点对点付款并上传凭证' },
  parties: { seller: '卖家甲', buyer: '买家乙', agent: '担保bot' },
  custodyProof: '3f2a1b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708i0',
  disputeOpen: false,
};

const FENCE = serializeEscrowCardFence(PAYLOAD);
const NOW = STATE_ENTERED_AT + 60 * 60 * 1000; // 1h after state entry

// ---------------------------------------------------------------------------
// 1. Fence → card
// ---------------------------------------------------------------------------

test('escrow-card fence renders an EscrowCard with state / next actor / remaining time / amount', () => {
  const markup = renderToStaticMarkup(
    React.createElement(MarkdownContent, { content: `担保交易已开单：\n\n${FENCE}` }),
  );
  assert.match(markup, /data-escrow-card="true"/);
  assert.match(markup, /data-escrow-state="ITEM_ESCROWED"/);
  assert.match(markup, /data-escrow-order="esc-42"/);
  assert.match(markup, /Escrow trade/);
  assert.match(markup, /Item escrowed/); // state label
  assert.match(markup, /星球系列 #3/);
  assert.match(markup, /￥99\.00/);
  assert.match(markup, /Next</);
  assert.match(markup, /买方/); // data.next.actor is bot-authored content, not UI chrome
  assert.match(markup, /请点对点付款并上传凭证/);
  assert.match(markup, /\d+ h \d+ min left/); // Date.now()-relative, generous window
  assert.match(markup, /in custody/);
  assert.match(markup, /T2/); // current-state timer badge
});

test('EscrowCard with a fixed now is deterministic (remaining time + terminal states)', () => {
  const live = renderToStaticMarkup(React.createElement(EscrowCard, { data: PAYLOAD, now: NOW }));
  assert.match(live, /23 h 0 min left/);

  const released: EscrowCardData = { ...PAYLOAD, state: 'RELEASED', next: undefined, timerHours: 0 };
  const done = renderToStaticMarkup(React.createElement(EscrowCard, { data: released, now: NOW }));
  assert.match(done, /Completed/);
  assert.doesNotMatch(done, /Next</);
  assert.doesNotMatch(done, /left</);

  const disputed: EscrowCardData = { ...PAYLOAD, state: 'DISPUTED', timerHours: 0, next: { actor: '担保人', text: '请调证并裁决' } };
  const inDispute = renderToStaticMarkup(React.createElement(EscrowCard, { data: disputed, now: NOW }));
  assert.match(inDispute, /In dispute/);
  assert.match(inDispute, /adjudicates with evidence/);
});

// ---------------------------------------------------------------------------
// 2. Graceful degradation
// ---------------------------------------------------------------------------

test('malformed escrow fences degrade to the plain code block (no half card)', () => {
  const badJson = '```escrow-card\n{"orderId":"esc-1", …truncated\n```';
  const unknownState = `\`\`\`escrow-card\n${JSON.stringify({ ...PAYLOAD, state: 'MAGIC_STATE' })}\n\`\`\``;
  const missingParties = `\`\`\`escrow-card\n${JSON.stringify({ ...PAYLOAD, parties: { seller: '卖家甲' } })}\n\`\`\``;
  const negativeAmount = `\`\`\`escrow-card\n${JSON.stringify({ ...PAYLOAD, amountCents: -1 })}\n\`\`\``;

  for (const content of [badJson, unknownState, missingParties, negativeAmount]) {
    const markup = renderToStaticMarkup(React.createElement(MarkdownContent, { content }));
    assert.doesNotMatch(markup, /data-escrow-card="true"/, 'must not render a card');
  }
  // The fence degrades to the normal code-block chrome instead of vanishing.
  const fallback = renderToStaticMarkup(React.createElement(MarkdownContent, { content: badJson }));
  assert.match(fallback, /escrow-card/);
});

// ---------------------------------------------------------------------------
// 3. No funds controls（零资金流红线）
// ---------------------------------------------------------------------------

test('the card has no funds buttons — the only control is the appeal entry', () => {
  const markup = renderToStaticMarkup(React.createElement(EscrowCard, { data: PAYLOAD, now: NOW }));
  const buttons = markup.match(/<button/g) ?? [];
  assert.equal(buttons.length, 1);
  assert.match(markup, /data-escrow-appeal="toggle"/);
  assert.doesNotMatch(markup, /disabled/);
  assert.match(markup, /Appeal \/ Review/);
  // No release/refund/pay affordances exist in the card at all.
  assert.doesNotMatch(markup, /放款|立即退款|去付款|确认收货/);
});

test('the appeal template embeds the order id and the dispute_open action, and the panel stays collapsed by default', () => {
  assert.equal(
    buildEscrowAppealTemplate('esc-42'),
    'escrow_order_act order_id=esc-42 action=dispute_open basis=<你的申诉理由>',
  );
  const markup = renderToStaticMarkup(React.createElement(EscrowCard, { data: PAYLOAD, now: NOW }));
  assert.doesNotMatch(markup, /data-escrow-appeal-panel/);
});

test('terminal escrow cards carry no appeal entry', () => {
  for (const state of ESCROW_CARD_TERMINAL_STATES) {
    const markup = renderToStaticMarkup(
      React.createElement(EscrowCard, { data: { ...PAYLOAD, state, timerHours: 0, next: undefined }, now: NOW }),
    );
    assert.doesNotMatch(markup, /data-escrow-appeal/, `state ${state} must not offer an appeal entry`);
  }
});

// ---------------------------------------------------------------------------
// 4. Marker isolation vs nft-card / pay-card
// ---------------------------------------------------------------------------

test('fence tags and data markers stay disjoint from nft-card and pay-card', () => {
  assert.equal(ESCROW_CARD_FENCE_TAG, 'escrow-card');
  assert.equal(isEscrowCardFenceLanguage('escrow-card'), true);
  assert.equal(isEscrowCardFenceLanguage('ESCROW-CARD'), true);
  assert.equal(isEscrowCardFenceLanguage('nft-card'), false);
  assert.equal(isEscrowCardFenceLanguage('pay-card'), false);

  const markup = renderToStaticMarkup(React.createElement(MarkdownContent, { content: FENCE }));
  assert.match(markup, /data-escrow-card/);
  assert.doesNotMatch(markup, /data-nft-card/);
  assert.doesNotMatch(markup, /data-pay-card/);
});

// ---------------------------------------------------------------------------
// 5. Syntax helpers
// ---------------------------------------------------------------------------

test('formatEscrowYuan is exact to the cent', () => {
  assert.equal(formatEscrowYuan(0), '￥0.00');
  assert.equal(formatEscrowYuan(1), '￥0.01');
  assert.equal(formatEscrowYuan(99), '￥0.99');
  assert.equal(formatEscrowYuan(9900), '￥99.00');
  assert.equal(formatEscrowYuan(123456), '￥1234.56');
});

test('remaining time text covers >48h, hours+minutes, minutes-only, and never-negative', () => {
  const base: EscrowCardData = { ...PAYLOAD, timerHours: 72 };
  assert.equal(escrowRemainingTimeText(base, base.stateEnteredAt + 1000), '2 d left');
  assert.equal(escrowRemainingTimeText(base, base.stateEnteredAt + 47 * 3_600_000), '25 h 0 min left');
  assert.equal(escrowRemainingTimeText({ ...base, timerHours: 1 }, base.stateEnteredAt + 59 * 60_000), '1 min left');
  assert.equal(escrowRemainingTimeText(base, base.stateEnteredAt + 73 * 3_600_000), null);
  assert.equal(escrowRemainingTimeText({ ...base, timerHours: 0 }, base.stateEnteredAt), null);
});

test('parse / serialize round-trip is semantic-stable, and hostile payloads are refused', () => {
  const back = parseEscrowCardFence(serializeEscrowCardFence(PAYLOAD).split('\n')[1]);
  assert.deepEqual(back, PAYLOAD);

  const caseVariants = [
    { ...PAYLOAD, orderId: 'esc 42' }, // spaces allowed in ids
    { ...PAYLOAD, amountCents: 9900.5 }, // float cents refused
    { ...PAYLOAD, state: 'DONE' },
    { ...PAYLOAD, timerHours: -1 },
    { ...PAYLOAD, parties: { seller: '', buyer: '买家乙', agent: '担保bot' } },
  ];
  for (const variant of caseVariants) {
    const parsed = parseEscrowCardFence(JSON.stringify(variant));
    if (variant.orderId === 'esc 42' && variant.amountCents === 9900) {
      assert.ok(parsed, 'space-separated order ids are legal');
    } else {
      assert.equal(parsed, null, JSON.stringify(variant).slice(0, 80));
    }
  }
  // state labels mirror the design doc's state set
  assert.equal(escrowCardStateLabel('PAID_EVIDENCE_UPLOADED'), 'Awaiting seller confirmation');
  assert.equal(escrowCardStateLabel('REFUND_ROLLED_BACK'), 'Rolled back');
});

// ---------------------------------------------------------------------------
// 6. Source wiring
// ---------------------------------------------------------------------------

test('MarkdownContent keeps the escrow branch and transcript surfaces keep routing through it', () => {
  const markdown = fs.readFileSync(path.join(projectRoot, '..', 'src', 'renderer', 'components', 'MarkdownContent.tsx'), 'utf8');
  assert.match(markdown, /isEscrowCardFenceLanguage/);
  assert.match(markdown, /<EscrowCard data=\{escrowData\}/);
  assert.match(markdown, /parseEscrowCardFence/);

  for (const relative of [
    ['src', 'renderer', 'components', 'cowork', 'A2AMessageItem.tsx'],
    ['src', 'renderer', 'components', 'groupTasks', 'GroupTaskMessageItem.tsx'],
    ['src', 'renderer', 'components', 'cowork', 'CoworkSessionDetail.tsx'],
  ]) {
    const source = fs.readFileSync(path.join(projectRoot, '..', ...relative), 'utf8');
    assert.ok(source.includes('<MarkdownContent'), `${relative.join('/')} must route content through MarkdownContent`);
  }
});
