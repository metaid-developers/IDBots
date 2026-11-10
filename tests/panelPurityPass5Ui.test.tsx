// Bot Internet sidebar panel — office-chat purity pass #5 (merged card,
// delegation 7459ba51 / step b64861e1), as amended by the owner on
// 2026-11-11: ① the pending reply card names the REAL speaker; ② REVERTED —
// the Telegram sent-quote card read as a separate block, so sent quotes
// keep the ORIGINAL inline generated-block style (the revert guard lives in
// panelPurityPass5Wiring.test.mjs); ③④ the timestamp is the twin side's
// group-end line, default visible, sharing the meta row with the 👍chip
// which adapts to the bubble alignment side.
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
  currentReaction?: 'up' | 'down' | null;
  timestampLabel?: string;
} = {}): string => renderToStaticMarkup(
  <PanelMessage
    message={node}
    onOpenUri={() => {}}
    showTimestamp={props.showTimestamp}
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

test('② a sent reply quote renders in the ORIGINAL inline style (card reverted)', () => {
  // Owner ruling 2026-11-11: quote and reply belong in ONE bubble — the
  // generated block flows inline exactly as it did before pass #5 ②.
  const markup = renderPanel(message({ type: 'user', content: sentReplyBody }));

  assert.ok(!markup.includes('data-panel-sent-quote'), 'no card element mounts');
  assert.ok(markup.includes('助手消息'), 'the generated label renders inline as stored');
  assert.ok(markup.includes('来看一下这个方案，特别是第二段。'), 'the quoted lines render inline');
  assert.ok(markup.includes('请帮我分析这段话'), 'the owner instruction renders in the same bubble');
});

test('② a plain user body renders exactly as before', () => {
  const markup = renderPanel(message({ type: 'user', content: '你好\n> 手写引用不算' }));
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

test('④ a user row never carries a stamp and renders no meta row without a chip', () => {
  const markup = renderPanel(
    message({ type: 'user', content: '问题' }),
    { showTimestamp: false, timestampLabel: '21:52' },
  );
  assert.ok(!markup.includes('panel-message-meta'), 'no meta row mounts at all');
  assert.ok(!markup.includes('21:52'), 'no timestamp anywhere on a user row');
});

test('④ user rows with a reaction chip carry the chip alone, right-aligned', () => {
  const markup = renderPanel(
    message({ type: 'user', content: '问题' }),
    { showTimestamp: false, timestampLabel: '21:52', currentReaction: 'up' },
  );
  assert.ok(markup.includes('data-panel-reaction-chip="up"'), 'the chip mounts');
  assert.ok(!markup.includes('data-panel-message-timestamp'), 'no stamp beside the user chip');
  assert.ok(!markup.includes('21:52'));
  assert.ok(markup.includes('justify-end'), 'the row aligns with the right-side bubble');
});

test('④ assistant rows read [👍chip][time] on one left-aligned row', () => {
  const markup = renderPanel(
    message({ type: 'assistant', content: '回答内容' }),
    { showTimestamp: true, timestampLabel: '21:52', currentReaction: 'up' },
  );
  const chipIndex = markup.indexOf('data-panel-reaction-chip="up"');
  const stampIndex = markup.indexOf('data-panel-message-timestamp');
  assert.ok(chipIndex !== -1 && stampIndex !== -1, 'chip and stamp both mount');
  assert.ok(chipIndex < stampIndex, 'the chip precedes the stamp');
  assert.ok(!markup.includes('invisible'), 'both are visible by default');
  assert.ok(markup.includes('justify-start'), 'the row aligns with the left-side bubble');
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
