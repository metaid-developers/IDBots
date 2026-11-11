// Bot Internet sidebar panel — office-chat purity pass #5 (merged card,
// delegation 7459ba51 / step b64861e1), as amended by the owner on
// 2026-11-11: ① the pending reply card names the REAL speaker; ② REVERTED —
// the Telegram sent-quote card read as a separate block, so sent quotes
// keep the ORIGINAL inline generated-block style (the revert guard lives in
// panelPurityPass5Wiring.test.mjs); ③④ the timestamp is the twin side's
// group-end line, default visible, sharing the meta row with the 👍chip
// which adapts to the bubble alignment side.
//
// SUPERSEDED (chat-window four-item fix ②, delegation 3e22c1c3 /
// step 07807b1a, owner ruling 2026-11-11): the stamp moved INSIDE the
// bubble's bottom-right corner; the external meta line is gone and the meta
// row now carries the 👍chip alone, mounting only while that chip exists.
//
// SUPERSEDED AGAIN (owner ruling 2026-11-11 14:07, rework step dc6c6292):
// fix ②'s "unified across user and assistant rows" scope is narrowed — only
// the LAST bubble of a consecutive assistant group carries the stamp; user
// bubbles never do. The who-decision lives at the PARENT (the
// assistant&&group-end expression pre-gates timestampLabel, pinned by
// PurityWiring ①); these component-level tests therefore pin only the
// mechanical contract — the component renders whatever pre-gated label it
// is handed, on any row type, and adds no second gate of its own.
//
// SUPERSEDED A THIRD TIME (sixth item, owner ruling 2026-11-11 14:45): the
// 👍chip moved INSIDE the bubble too — one in-bubble footer row, chip LEFT
// of the stamp, flush with the bubble's bottom-right corner; the external
// chip row is gone. The chip's own interactions (click toggle, hover fade,
// toggle params) are unchanged; these tests pin the new footer geometry.
//
// Harness note: server-rendered (no DOM/jsdom), same as
// botBrowserPanelImageAttachment.test.tsx — effects never run, so only the
// render output is asserted. i18nService resolves to its default language
// ('en') under node, and the expected copy is read through the same t()
// calls the components make, so the wiring is pinned without pinning a
// locale.

import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { PanelMessage } from '../src/renderer/features/botBrowser/BotBrowserCoworkPanel';
import CoworkQuotedSelectionTiles from '../src/renderer/components/cowork/CoworkQuotedSelectionTiles';
import { i18nService } from '../src/renderer/services/i18n';
import type { CoworkMessage, CoworkQuotedSelection } from '../src/renderer/types/cowork';

const message = (overrides: Partial<CoworkMessage>): CoworkMessage => ({
  id: 'm-1',
  type: 'user',
  content: 'body',
  timestamp: 1,
  ...overrides,
});

const renderPanel = (node: CoworkMessage, props: {
  showTimestamp?: boolean;
  botName?: string | null;
  currentReaction?: 'up' | 'down' | null;
  timestampLabel?: string;
} = {}): string => renderToStaticMarkup(
  <PanelMessage
    message={node}
    onOpenUri={() => {}}
    showTimestamp={props.showTimestamp}
    botName={props.botName}
    currentReaction={props.currentReaction ?? null}
    onToggleReaction={props.currentReaction ? () => {} : undefined}
    timestampLabel={props.timestampLabel}
  />,
);

// A sent body in the exact generated reply form (the composer writes this
// into the prompt body; the display side must not need anything wider).
const sentReplyBody = [
  '> #3 助手消息：',
  '> 来看一下这个方案，特别是第二段。',
  '> （已截断：仅保留前 160 字）',
  '',
  '请帮我分析这段话',
].join('\n');

test('② a sent reply quote renders INLINE with the real speaker, no card', () => {
  // Owner rulings synthesized: ONE bubble, original inline flow, but the
  // label names the session bot (main-transcript mapping) — not #152.
  const markup = renderPanel(message({ type: 'user', content: sentReplyBody }), { botName: 'Monday' });

  assert.ok(!markup.includes('data-panel-sent-quote'), 'no card element mounts');
  assert.ok(markup.includes('Monday'), 'the label names the real bot');
  assert.ok(!markup.includes('助手消息'), 'the machine label never leaks');
  assert.ok(markup.includes('来看一下这个方案，特别是第二段。'), 'the quoted lines render inline');
  assert.ok(markup.includes('请帮我分析这段话'), 'the owner instruction renders in the same bubble');
});

test('② a plain user body renders exactly as before', () => {
  const markup = renderPanel(message({ type: 'user', content: '你好\n> 手写引用不算' }), { botName: 'Monday' });
  assert.ok(markup.includes('你好'));
});

test('③ the assistant group-end stamp is default-visible, with no hover machinery', () => {
  const markup = renderPanel(
    message({ type: 'assistant', content: '回答内容' }),
    { showTimestamp: true, timestampLabel: '21:52' },
  );
  assert.ok(markup.includes('data-panel-message-timestamp'), 'the stamp renders');
  assert.ok(markup.includes('21:52'));
  assert.ok(!markup.includes('group-hover'), 'no hover gating survives from pass #3');
  assert.ok(!markup.includes('invisible'), 'the stamp is visible by default, not reveal-gated');
});

test('④ the component renders the handed label on a user row too; the parent gate decides who gets one (14:07 rework supersession)', () => {
  const markup = renderPanel(
    message({ type: 'user', content: '问题' }),
    // Mechanical component contract (supersedes the "user rows carry the
    // stamp too" owner semantics of the 11:19 ruling): PanelMessage renders
    // whatever PRE-GATED label the parent hands down, on any row type.
    // Since the 14:07 ruling the parent never hands a label to user rows
    // (assistant&&group-end pre-gate, pinned by PurityWiring ①) — so in the
    // live panel a user row carries no stamp; this test pins only that the
    // component itself adds no second gate of its own.
    { showTimestamp: false, timestampLabel: '21:52' },
  );
  assert.ok(markup.includes('data-panel-message-timestamp'), 'the handed label renders in-bubble, no second component gate');
  assert.ok(markup.includes('21:52'));
  assert.ok(!markup.includes('panel-message-meta'), 'no meta row mounts without a chip');
});

test('④ user chip: the chip rides the in-bubble footer LEFT of the stamp (sixth item supersession)', () => {
  const markup = renderPanel(
    message({ type: 'user', content: '问题' }),
    { showTimestamp: false, timestampLabel: '21:52', currentReaction: 'up' },
  );
  assert.ok(markup.includes('data-panel-reaction-chip="up"'), 'the chip mounts');
  assert.ok(markup.includes('data-panel-message-timestamp'), 'the stamp renders in-bubble');
  assert.ok(!markup.includes('panel-message-meta'), 'the external chip row never mounts');
  // One in-bubble footer row carries BOTH the chip and the stamp, chip
  // left of the stamp, flush with the bubble's bottom-right corner.
  const footer = markup.match(/<div data-slot="panel-bubble-footer"[\s\S]*?<\/div>/)?.[0] ?? '';
  assert.ok(footer, 'the in-bubble footer mounts');
  assert.ok(footer.includes('data-panel-reaction-chip="up"'), 'the chip rides the footer');
  assert.ok(footer.includes('data-panel-message-timestamp'), 'the stamp rides the same footer');
  assert.ok(
    footer.indexOf('data-panel-reaction-chip="up"') < footer.indexOf('data-panel-message-timestamp'),
    'chip LEFT of the stamp',
  );
  assert.ok(footer.includes('justify-end'), 'the pair hugs the bubble bottom-right corner');
});

test('④ assistant rows: the chip sits LEFT of the stamp on the shared in-bubble footer (sixth item supersession)', () => {
  const markup = renderPanel(
    message({ type: 'assistant', content: '回答内容' }),
    { showTimestamp: true, timestampLabel: '21:52', currentReaction: 'up' },
  );
  const chipIndex = markup.indexOf('data-panel-reaction-chip="up"');
  const stampIndex = markup.indexOf('data-panel-message-timestamp');
  assert.ok(chipIndex !== -1 && stampIndex !== -1, 'chip and stamp both mount');
  assert.ok(chipIndex < stampIndex, 'the chip sits LEFT of the stamp on the shared footer row');
  const footer = markup.match(/<div data-slot="panel-bubble-footer"[\s\S]*?<\/div>/)?.[0] ?? '';
  assert.ok(footer, 'the in-bubble footer mounts');
  assert.ok(!markup.includes('panel-message-meta'), 'the external chip row never mounts');
  assert.ok(!markup.includes('invisible'), 'both are visible by default');
  assert.ok(footer.includes('justify-end'), 'the pair hugs the bubble bottom-right corner');
});

// ── ① the pending reply card names the real speaker ─────────────────────────

const selection = (role: CoworkQuotedSelection['role'], text: string): CoworkQuotedSelection => ({
  id: 'q-1',
  role,
  text,
  truncated: false,
  messageRef: { messageId: 'm-1', ordinal: 3, streaming: false },
});

test('① an assistant-side pending reply names the session bot, not 「Bot」', () => {
  const replyTemplate = i18nService.t('coworkQuoteReplyCardReplyingTo');
  const markup = renderToStaticMarkup(
    <CoworkQuotedSelectionTiles
      selections={[selection('assistant', '片段内容')]}
      onRemove={() => {}}
      botName="Monday"
    />,
  );
  const expected = replyTemplate.replace('{speaker}', 'Monday');
  assert.ok(markup.includes(expected), `the header reads 「${expected}」`);
  assert.ok(!markup.includes(replyTemplate.replace('{speaker}', 'Bot')), 'no 「Bot」 fallback while a name is known');
});

test('① a user-side pending reply keeps naming the owner, and no name falls back to Bot', () => {
  const userSpeaker = i18nService.t('coworkQuoteReplyCardSpeakerUser');
  const replyTemplate = i18nService.t('coworkQuoteReplyCardReplyingTo');
  const ownerMarkup = renderToStaticMarkup(
    <CoworkQuotedSelectionTiles
      selections={[selection('user', '片段内容')]}
      onRemove={() => {}}
      botName="Monday"
    />,
  );
  assert.ok(ownerMarkup.includes(replyTemplate.replace('{speaker}', userSpeaker)), 'the owner side is unchanged');
  const fallbackMarkup = renderToStaticMarkup(
    <CoworkQuotedSelectionTiles
      selections={[selection('assistant', '片段内容')]}
      onRemove={() => {}}
      botName={null}
    />,
  );
  assert.ok(fallbackMarkup.includes(replyTemplate.replace('{speaker}', i18nService.t('coworkQuoteSentReplySourceAssistantFallback'))), 'no name degrades to the i18n fallback');
});
