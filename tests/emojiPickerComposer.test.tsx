// Chat emoji picker — component and wiring tests.
//
// Harness note (same as tests/coworkComposerImageAttachment.test.tsx): this
// repo's renderer tests are server-rendered (no DOM/jsdom), so React event
// handlers cannot be fired by mounting. The picker panel and the bubble
// display mapping are asserted via SSR markup; the composer's caret-insertion
// WIRING is pinned against the real CoworkPromptInput source (the module the
// handlers live in), which is this repo's established convention for
// handler-contract coverage.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import EmojiMenuButton, { rememberRecent, restoreRecentChars } from '../src/renderer/components/chat/EmojiPickerPopover';
import GroupTaskMessageItem from '../src/renderer/components/groupTasks/GroupTaskMessageItem';
import A2AMessageItem from '../src/renderer/components/cowork/A2AMessageItem';
import CoworkSentQuoteBlock from '../src/renderer/components/cowork/CoworkSentQuoteBlock';
import { i18nService } from '../src/renderer/services/i18n';
import type { GroupChatTranscriptMessage } from '../src/renderer/types/groupTask';

const here = path.dirname(fileURLToPath(import.meta.url));
const readSource = (relative: string): string =>
  fs.readFileSync(path.join(here, relative), 'utf-8');

const TXID = 'e'.repeat(64);

const groupMessage = (content: string): GroupChatTranscriptMessage => ({
  id: 1,
  pinId: `${TXID}i0`,
  txId: TXID,
  senderName: 'Worker Bot',
  senderGlobalMetaId: 'idq1worker',
  senderAvatar: 'https://example.com/bot.png',
  content,
  contentType: 'text',
  chainTimestamp: new Date(2026, 9, 29, 9, 5, 0).getTime(),
  msgIndex: 1,
  replyPin: null,
});

test('emoji trigger renders a toolbar button with picker aria wiring', () => {
  const markup = renderToStaticMarkup(
    <EmojiMenuButton open={false} buttonRef={{ current: null }} onToggle={() => {}} onPick={() => {}} />,
  );
  assert.match(markup, /aria-label="[^"]*"/);
  assert.match(markup, /aria-expanded="false"/);
  assert.match(markup, /aria-haspopup="menu"/);
  // Closed state renders no panel.
  assert.doesNotMatch(markup, /role="dialog"/);
});

test('open picker renders one flat panel: search box, no tabs, single emoji grid', () => {
  const markup = renderToStaticMarkup(
    <EmojiMenuButton open buttonRef={{ current: null }} onToggle={() => {}} onPick={() => {}} />,
  );
  assert.match(markup, /role="dialog"/);
  // Search input present with its placeholder copy.
  assert.match(markup, /type="text"[^>]*placeholder="[^"]+"/);
  // Single WeChat-style page: NO tab bar anywhere.
  assert.doesNotMatch(markup, /role="tablist"/);
  assert.doesNotMatch(markup, /role="tab"/);
  // One flat grid of 85 emoji options; every catalog cell renders the
  // bundled Twemoji image (alt = codepoint) instead of a font glyph.
  const optionCount = (markup.match(/role="option"/g) ?? []).length;
  assert.equal(optionCount, 85, `expected 85 grid options, got ${optionCount}`);
  const imgCount = (markup.match(/<img /g) ?? []).length;
  assert.equal(imgCount, 85, `expected 85 Twemoji <img> cells, got ${imgCount}`);
  // Grid starts with the WeChat code-table order (微笑 first)…
  assert.match(markup, /<img[^>]*alt="🙂"/, 'grid starts with 🙂 (微笑) as a Twemoji image');
  // …backed by the embedded data URI asset (bundler-independent; never a CDN).
  assert.match(markup, /src="data:image\/svg\+xml,%3csvg/);
  assert.doesNotMatch(markup, /src="https?:\/\//, 'assets must be bundled, never fetched from a CDN');
  // The button's a11y identity stays the codepoint itself.
  assert.match(markup, /aria-label="🙂"/);
  // Fresh install: no recents yet -> no recent strip, no recents label.
  assert.ok(!markup.includes(i18nService.t('emojiCategoryRecent')), 'recent strip hidden while recents are empty');
});

test('disabled trigger renders disabled', () => {
  const markup = renderToStaticMarkup(
    <EmojiMenuButton open={false} buttonRef={{ current: null }} disabled onToggle={() => {}} onPick={() => {}} />,
  );
  assert.match(markup, /disabled/);
});

test('recents render as a strip embedded ABOVE the main grid (WeChat style, no Recent tab)', () => {
  // Prime module recents exactly like real picks would (SSR tests cannot
  // fire events); the strip must appear inside the single panel, above the
  // 85-entry main grid, and must not reintroduce a tab bar.
  restoreRecentChars(null);
  rememberRecent('🎉');
  rememberRecent('👍');
  try {
    const markup = renderToStaticMarkup(
      <EmojiMenuButton open buttonRef={{ current: null }} onToggle={() => {}} onPick={() => {}} />,
    );
    assert.ok(markup.includes(i18nService.t('emojiCategoryRecent')), 'recent strip label present');
    assert.doesNotMatch(markup, /role="tab"/, 'recents must be a strip, not a tab');
    // Strip (2 recents) + main grid (85) = 87 options; strip markup must
    // come BEFORE the main grid's first catalog emoji 🙂.
    const optionCount = (markup.match(/role="option"/g) ?? []).length;
    assert.equal(optionCount, 87, `expected 2 recent + 85 catalog options, got ${optionCount}`);
    const stripLabelIndex = markup.indexOf(i18nService.t('emojiCategoryRecent'));
    const firstGridEmojiIndex = markup.indexOf('🙂');
    assert.ok(stripLabelIndex >= 0 && stripLabelIndex < firstGridEmojiIndex, 'recent strip sits above the main grid');
    assert.ok(markup.indexOf('🎉') < firstGridEmojiIndex, 'most-recent emoji leads the strip');
    // Recents render as Twemoji images too (alt carries the codepoint).
    assert.match(markup, /<img[^>]*alt="🎉"/, 'recent picks render as bundled Twemoji images');
    assert.match(markup, /<img[^>]*alt="👍"/);
  } finally {
    restoreRecentChars(null);
  }
});

test('composer wires the emoji button next to the + button in both layout branches, inserting at the caret', () => {
  const source = readSource('../src/renderer/components/cowork/CoworkPromptInput.tsx');
  // Two render branches (wide toolbar row + single-line composer) each mount
  // the picker directly after the PlusMenuButton.
  const emojiButtonCount = (source.match(/<EmojiMenuButton/g) ?? []).length;
  assert.equal(emojiButtonCount, 2, 'both composer branches must render the emoji button');
  // Every PlusMenuButton JSX mount is followed by an EmojiMenuButton mount.
  // (The negative lookahead skips the `React.FC<PlusMenuButtonProps>` type
  // reference, whose `<PlusMenuButton` prefix would otherwise match.)
  const plusBlockEnds = [...source.matchAll(/<PlusMenuButton(?![A-Za-z])[\s\S]*?\/>/g)].map((m) => m.index! + m[0].length);
  assert.ok(plusBlockEnds.length === 2, `expected 2 PlusMenuButton mounts, got ${plusBlockEnds.length}`);
  for (const end of plusBlockEnds) {
    const between = source.slice(end, end + 400);
    assert.ok(
      between.includes('<EmojiMenuButton'),
      'an EmojiMenuButton must directly follow each PlusMenuButton mount',
    );
  }
  // Insertion path: read live selection -> applyTextareaChange(start, end, emoji)
  // -> refocus, i.e. the same DOM path paste uses (setRangeText 'end' mode
  // lands the caret after the inserted sequence).
  assert.match(source, /const handlePickEmoji = \(emoji: string\) => \{[\s\S]*?readLiveSelection\(\)[\s\S]*?applyTextareaChange\(start, end, emoji\)[\s\S]*?textarea\.focus\(\)/);
  // The picker follows the textarea's own disabled gate, not the attachment gate.
  assert.match(source, /const emojiPickerDisabled = disabled \|\| \(isStreaming && steerDisabled\)/);
});

test('group-task message bubbles render WeChat bracket codes as Twemoji images (display-only)', () => {
  const markup = renderToStaticMarkup(
    <GroupTaskMessageItem message={groupMessage('收到[强]，马上开始[奋斗]')} senderDisplayName="Worker Bot" />,
  );
  // Mapped codes render as inline Twemoji images; alt carries the codepoint.
  assert.match(markup, /<img[^>]*alt="👍"/, 'bubble should show 👍 (as an image) for [强]');
  assert.match(markup, /<img[^>]*alt="💪"/, 'bubble should show 💪 (as an image) for [奋斗]');
  assert.match(markup, /src="data:image\/svg\+xml,%3csvg/, '👍 renders from the embedded data URI asset');
  assert.ok(!markup.includes('[强]') && !markup.includes('[奋斗]'), 'bracket codes must not leak into the bubble');
  // The raw pin id and txid still render verbatim (chain data untouched).
  assert.match(markup, /txid:/);
});

test('group-task bubbles keep bracket codes verbatim inside code spans', () => {
  const markup = renderToStaticMarkup(
    <GroupTaskMessageItem message={groupMessage('跑 `code [强] here` 然后[微笑]')} senderDisplayName="Worker Bot" />,
  );
  assert.ok(markup.includes('[强]'), 'inline code span must keep the literal bracket code');
  assert.match(markup, /<img[^>]*alt="🙂"/, 'prose outside code still renders as a Twemoji image');
});

test('A2A private-chat bubbles render WeChat bracket codes as Twemoji images', () => {
  const markup = renderToStaticMarkup(
    <A2AMessageItem
      message={{
        id: 'msg-emoji-1',
        type: 'user',
        content: '早上好[微笑]，辛苦了[抱拳]',
        timestamp: 1_744_444_444_000,
        metadata: { direction: 'incoming', senderName: 'Peer', txid: TXID },
      }}
      peerName="Peer"
    />,
  );
  assert.match(markup, /<img[^>]*alt="🙂"/, 'A2A bubble should show 🙂 (as an image) for [微笑]');
  assert.match(markup, /<img[^>]*alt="👊"/, 'A2A bubble should show 👊 (as an image) for [抱拳]');
  assert.ok(!markup.includes('[微笑]') && !markup.includes('[抱拳]'), 'bracket codes must not leak');
});

test('cowork user bubbles route their body through the display mapping', () => {
  // UserMessageBody now lives in the shared attachment module (both the
  // transcript and the Bot Internet panel render through it), so the display
  // mapping is pinned there and the transcript may not keep a copy.
  const source = readSource('../src/renderer/components/cowork/UserAttachmentBody.tsx');
  assert.match(
    source,
    /content=\{mapWechatBracketCodesForDisplay\(body\)\}[\s\S]{0,120}?emojiImages/,
    'UserMessageBody must pass its body through the display-only mapping and opt into Twemoji rendering',
  );
  const detailSource = readSource('../src/renderer/components/cowork/CoworkSessionDetail.tsx');
  assert.ok(
    !detailSource.includes('mapWechatBracketCodesForDisplay'),
    'the transcript must not keep its own copy of the user-body display mapping',
  );
});

test('cowork assistant bubbles join the Twemoji pipeline in BOTH modes', () => {
  // AssistantMessageItem is not exported; pin both render branches in the
  // transcript source. Assistant mode (bubble) and professional mode (bare
  // full-width) are the same logical bubble face — one without the prop would
  // flip emoji back to system glyphs depending on the user's mode setting.
  const source = readSource('../src/renderer/components/cowork/CoworkSessionDetail.tsx');
  const wired = (source.match(/content=\{replyContent\}[\s\S]{0,200}?emojiImages/g) ?? []).length;
  assert.equal(wired, 2, 'both assistant reply branches (bubble + professional) must pass emojiImages');
});

test('cowork sent-quote blocks render Twemoji like the bubble body around them', () => {
  // The quote block renders INSIDE the user bubble, so it must follow the
  // SAME display-only contract as the body beside it: WeChat bracket codes
  // map to emoji AND catalog emoji render as bundled Twemoji images.
  const markup = renderToStaticMarkup(
    <CoworkSentQuoteBlock block={'> 引用上一条消息[微笑]\n\n后续正文'} />,
  );
  assert.match(markup, /<img[^>]*alt="🙂"/, 'quoted excerpt should show 🙂 (mapped from [微笑]) as a Twemoji image');
  assert.ok(!markup.includes('[微笑]'), 'bracket codes must not leak into the rendered quote');
  const rawMarkup = renderToStaticMarkup(
    <CoworkSentQuoteBlock block={'> 直接码点👍也走管线'} />,
  );
  assert.match(rawMarkup, /<img[^>]*alt="👍"/, 'a literal catalog char in the excerpt renders as Twemoji too');
  assert.match(markup, /src="data:image\/svg\+xml,%3csvg/, 'the image must come from the embedded data URI asset');
  assert.doesNotMatch(markup, /src="https?:\/\//, 'assets must be bundled, never fetched from a CDN');
});

test('bot-browser panel bubbles join the Twemoji pipeline (user = shared body, assistant = emojiImages)', () => {
  // PanelMessage renders its user branch through the SAME shared body as the
  // main transcript (UserAttachmentBody): markdown + bracket-code mapping +
  // the emojiImages remark prop. The panel used to be a plain-text TwemojiText
  // face; that changed with the image-attachment port, and a plain-text copy
  // would now silently fork the bubble face from the transcript.
  const source = readSource('../src/renderer/features/botBrowser/BotBrowserCoworkPanel.tsx');
  const bodySource = readSource('../src/renderer/components/cowork/UserAttachmentBody.tsx');
  assert.match(
    source,
    /import \{ UserMessageBody \} from '\.\.\/\.\.\/components\/cowork\/UserAttachmentBody';/,
    'panel must import the shared user-message body',
  );
  assert.match(
    source,
    /<UserMessageBody content=\{displayContent\} resolveLocalFilePath=\{resolveLocalFilePath\} \/>/,
    'bot-browser user bubble must render through the shared body',
  );
  // The panel's user branch renders the sent-quote display pass-through
  // (displayContent falls back to the verbatim message.content when no
  // generated quote block matches), never a forked plain-text face.
  assert.match(
    source,
    /const displayContent = sentQuoteBlock\s*\?\s*\[sentQuoteBlock, sentQuoteRest\]\.filter\(Boolean\)\.join\('\\n\\n'\)\s*:\s*message\.content;/,
    'the shared-body input must fall back to the verbatim message content',
  );
  assert.match(
    bodySource,
    /<MarkdownContent[\s\S]{0,200}?emojiImages/,
    'the shared user body must pass emojiImages (bundled Twemoji, not system glyphs)',
  );
  const wired = (source.match(/<MarkdownContent content=\{message\.content\} compact onOpenBotBrowserUri=\{onOpenUri\} emojiImages \/>/g) ?? []).length;
  assert.equal(wired, 2, 'both bot-browser assistant branches (bubble + bare) must pass emojiImages');
});

test('emoji picker copy resolves in both shipped locales', () => {
  for (const locale of ['zh', 'en'] as const) {
    const title = i18nService.tIn(locale, 'composerEmojiTitle');
    assert.ok(title && title.length > 0, `composerEmojiTitle missing for ${locale}`);
    assert.ok(i18nService.tIn(locale, 'emojiPickerSearchPlaceholder').length > 0);
    assert.ok(i18nService.tIn(locale, 'emojiPickerNoResults').length > 0);
    for (const key of [
      'emojiCategoryRecent',
      'emojiCategorySmileys',
      'emojiCategoryPeople',
      'emojiCategoryAnimals',
      'emojiCategoryFood',
      'emojiCategoryActivities',
      'emojiCategoryTravel',
      'emojiCategoryObjects',
      'emojiCategorySymbols',
      'emojiCategoryFlags',
    ]) {
      assert.ok(i18nService.tIn(locale, key).length > 0, `${key} missing for ${locale}`);
    }
  }
});
