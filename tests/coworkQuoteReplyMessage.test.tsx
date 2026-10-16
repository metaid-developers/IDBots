// Per-message quote reply ("reply to one whole message").
//
// The owner clicks 回复 on any message's hover action bar; the message is
// quoted — snapshotted — into the composer's single quote slot, and the next
// message carries a blockquote naming the message's role and position. This
// file pins the acceptance cells of the per-message reply slice: textless
// messages, the preview bar and its summary, cancel, the submitted body
// (short and long), the running steer path, restore/clear on submit, the
// still-generating mark, and the bilingual copy.
//
// The repository's react test stack is SSR-only (react-dom/server, no jsdom),
// so the evidence is layered: real behaviour of the pure modules the render
// and submit paths call, real markup from the presentational components, and
// source-level assertions that the components are actually wired to them.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { build } from 'esbuild';

import {
  QUOTED_SELECTION_MAX_CHARS,
  QUOTED_SELECTION_SUMMARY_CHARS,
  buildQuotedSelectionsBlock,
  buildTranscriptMessagePositions,
  composeSubmittedCoworkPrompt,
  createMessageQuotedSelection,
  hasQuotableText,
  removeQuotedSelection,
  summarizeQuotedSelectionText,
} from '../src/renderer/components/cowork/coworkQuotedSelections';
import {
  createVersionedComposerField,
  runComposerSubmission,
} from '../src/renderer/components/cowork/coworkPromptSubmission';
import CoworkMessageReplyAction from '../src/renderer/components/cowork/CoworkMessageReplyAction';
import CoworkQuotedSelectionTiles from '../src/renderer/components/cowork/CoworkQuotedSelectionTiles';
import { i18nService } from '../src/renderer/services/i18n';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (...segments) => fs.readFileSync(path.join(projectRoot, ...segments), 'utf8');

const inputSource = readSource('src', 'renderer', 'components', 'cowork', 'CoworkPromptInput.tsx');
const detailSource = readSource('src', 'renderer', 'components', 'cowork', 'CoworkSessionDetail.tsx');
const tilesSource = readSource('src', 'renderer', 'components', 'cowork', 'CoworkQuotedSelectionTiles.tsx');
const replyActionSource = readSource('src', 'renderer', 'components', 'cowork', 'CoworkMessageReplyAction.tsx');
const i18nSource = readSource('src', 'renderer', 'services', 'i18n.ts');

// Labels as the running app supplies them (never hardcoded in the components).
const labels = () => ({
  header: i18nService.t('coworkQuoteBlockHeader'),
  item: i18nService.t('coworkQuoteBlockItem'),
  sourceLabel: {
    user: i18nService.t('coworkQuoteSourceUser'),
    assistant: i18nService.t('coworkQuoteSourceAssistant'),
    other: i18nService.t('coworkQuoteSourceOther'),
  },
  replyBlockHeader: i18nService.t('coworkQuoteReplyBlockHeader'),
  replyBlockItem: i18nService.t('coworkQuoteReplyBlockItem'),
  replyStreamingMark: i18nService.t('coworkQuoteReplyStreamingMark'),
  replySourceLabel: {
    user: i18nService.t('coworkQuoteReplySourceUser'),
    assistant: i18nService.t('coworkQuoteReplySourceAssistant'),
    other: i18nService.t('coworkQuoteReplySourceOther'),
  },
  truncatedNote: i18nService.t('coworkQuoteTruncatedNote'),
});

const withLanguage = (language, fn) => {
  const original = i18nService.getLanguage();
  i18nService.setLanguage(language, { persist: false });
  try {
    return fn();
  } finally {
    i18nService.setLanguage(original, { persist: false });
  }
};

const REPLY_TEXT = '我们先把靶心写成一句委托人能看懂的话，再开始扣扳机。';

const reply = (content, ordinal, streaming, id) => createMessageQuotedSelection({
  content,
  role: 'assistant',
  ordinal,
  streaming,
}, id);

test('messages without text offer no reply entry, and both sides of the conversation mount it', () => {
  // The component's own text gate: empty and whitespace-only messages render
  // nothing at all, so tool blocks, placeholders and empty blocks have no entry.
  assert.equal(hasQuotableText(''), false);
  assert.equal(hasQuotableText('   \n\t '), false);
  assert.equal(hasQuotableText('\r\n'), false);
  assert.equal(hasQuotableText(REPLY_TEXT), true);

  const render = (text) => renderToStaticMarkup(
    <CoworkMessageReplyAction text={text} visible onReply={() => {}} />,
  );
  withLanguage('zh', () => {
    assert.equal(render(''), '');
    assert.equal(render('  \n '), '');
    const markup = render('hello');
    assert.ok(markup.includes('data-cowork-quote-reply-action="true"'), 'a text message gets the entry');
    assert.ok(markup.includes(i18nService.t('coworkQuoteReplyAction')), 'the entry carries its localized label');
  });

  // Both the user action row and the assistant action strips (assistant-mode
  // toolbar + professional row) mount it.
  assert.equal((detailSource.match(/<CoworkMessageReplyAction/g) ?? []).length, 3);
  assert.match(detailSource, /text=\{message\.content\}/);
  assert.match(detailSource, /text=\{replyContent\}/);
  // The gate is the message text itself, never the message type.
  assert.match(replyActionSource, /hasQuotableText\(text\)/);
});

test('replying to a message fills the single composer slot with a frozen snapshot', () => {
  // The fragment captures role, position and the generating state together
  // with the text.
  const fragment = createMessageQuotedSelection({
    content: `  ${REPLY_TEXT}  `,
    role: 'assistant',
    ordinal: 3,
    streaming: true,
  }, 'q-reply');
  assert.equal(fragment.id, 'q-reply');
  assert.equal(fragment.text, REPLY_TEXT, 'the excerpt is the message text, normalized');
  assert.equal(fragment.role, 'assistant');
  assert.deepEqual(fragment.messageRef, { ordinal: 3, streaming: true });
  assert.equal(fragment.truncated, false);

  // Snapshot semantics: whatever the live message does after the click must
  // not change the quoted excerpt.
  const target = { content: 'partial line', role: 'assistant', ordinal: 1, streaming: true };
  const frozen = createMessageQuotedSelection(target, 'q-frozen');
  target.content = 'partial line plus later tokens';
  assert.equal(frozen.text, 'partial line');
  assert.equal(frozen.messageRef.streaming, true);

  // A textless message never produces a fragment.
  assert.equal(createMessageQuotedSelection({ content: '   ', role: 'assistant', ordinal: 2, streaming: false }), null);

  // The transcript handler sends the fragment through the composer's shared
  // slot — the same call the selection path makes.
  assert.match(detailSource, /const handleQuoteReplyMessage = useCallback\(\(message: CoworkMessage, text: string\)/);
  assert.match(detailSource, /createMessageQuotedSelection\(\{/);
  assert.match(detailSource, /streaming: message\.metadata\?\.isStreaming === true/);
  assert.match(detailSource, /promptInputRef\.current\?\.addQuotedSelection\(fragment\)/);
  assert.equal(
    (detailSource.match(/addQuotedSelection\(fragment\)/g) ?? []).length,
    2,
    'both entries write the same slot — no second parallel state',
  );
  assert.equal((inputSource.match(/useState<CoworkQuotedSelection\[\]>/g) ?? []).length, 1);
  // ...and the slot is single-target: a new quote replaces the previous one.
  assert.match(inputSource, /field\.set\(\[selection\]\)/);
});

test('the reply preview bar shows the one-line summary, and cancel clears the slot', () => {
  const fragment = reply(REPLY_TEXT, 3, false, 'q-bar');

  // A single quote renders as the compact reply bar: icon + summary + cancel.
  withLanguage('zh', () => {
    const markup = renderToStaticMarkup(
      <CoworkQuotedSelectionTiles selections={[fragment]} onRemove={() => {}} />,
    );
    assert.ok(markup.includes('data-cowork-quote-reply-bar="true"'), 'one quote renders as the bar');
    assert.doesNotMatch(markup, /data-cowork-quote-tile=/, 'no per-fragment tile row in the single-target slot');
    assert.ok(markup.includes('<svg'), 'the bar carries the quote icon');
    assert.ok(markup.includes(i18nService.t('coworkQuoteReplyPreviewLabel')), 'the bar is labelled');
    assert.ok(markup.includes(i18nService.t('coworkQuoteReplyCancel')), 'the cancel control is offered');
    assert.ok(markup.includes(summarizeQuotedSelectionText(fragment.text)), 'the summary comes from the excerpt');
  });

  // Summary cell: one line, flattened and capped at 96 characters.
  const multiLine = 'first line of the message\nsecond line follows';
  const summary = summarizeQuotedSelectionText(multiLine);
  assert.equal(summary, 'first line of the message second line follows');
  assert.ok(!summary.includes('\n'), 'the summary is a single line');
  assert.equal(summarizeQuotedSelectionText(REPLY_TEXT), REPLY_TEXT);

  // Cancel removes the fragment: the bar disappears and the body has no quote.
  const remaining = removeQuotedSelection([fragment], fragment.id);
  assert.deepEqual(remaining, []);
  assert.equal(
    renderToStaticMarkup(<CoworkQuotedSelectionTiles selections={remaining} onRemove={() => {}} />),
    '',
  );
  const body = composeSubmittedCoworkPrompt({ value: 'hi there', quotedSelections: remaining, labels: labels() });
  assert.equal(body, 'hi there');
  assert.ok(!body.includes(REPLY_TEXT));
  // The bar's cancel button runs the composer's removal path.
  assert.match(tilesSource, /onClick=\{\(\) => onRemove\(selection\.id\)\}/);
  assert.match(inputSource, /selections=\{quotedSelections\}/);
  assert.match(inputSource, /onRemove=\{handleRemoveQuotedSelection\}/);
});

test('the composer placeholder switches to the reply copy while the slot holds a quote', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-reply-placeholder-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const outputFile = path.join(tempDir, 'composer-placeholder.mjs');
  await build({
    absWorkingDir: projectRoot,
    stdin: {
      contents: `export { deriveCoworkComposerPlaceholder } from './src/renderer/components/cowork/CoworkPromptInput.tsx';\nexport { i18nService } from './src/renderer/services/i18n.ts';`,
      resolveDir: projectRoot,
      sourcefile: 'composer-placeholder-entry.ts',
      loader: 'ts',
    },
    outfile: outputFile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
  });
  const { deriveCoworkComposerPlaceholder, i18nService: bundledI18n } = await import(
    `${pathToFileURL(outputFile).href}?test=${Date.now()}`
  );

  const original = bundledI18n.getLanguage();
  try {
    bundledI18n.setLanguage('zh', { persist: false });
    const replyPlaceholder = bundledI18n.t('coworkQuoteReplyPlaceholder');
    assert.equal(replyPlaceholder, '回复…');
    assert.equal(
      deriveCoworkComposerPlaceholder({ isStreaming: false, steerDisabled: false, hasQuotedSelections: false, idlePlaceholder: 'idle hint' }),
      'idle hint',
      'an empty slot keeps the idle copy',
    );
    assert.equal(
      deriveCoworkComposerPlaceholder({ isStreaming: false, steerDisabled: false, hasQuotedSelections: true, idlePlaceholder: 'idle hint' }),
      replyPlaceholder,
      'a filled slot switches to the reply copy',
    );
    // While a turn streams, an empty slot keeps the steer copy...
    assert.equal(
      deriveCoworkComposerPlaceholder({ isStreaming: true, steerDisabled: false, hasQuotedSelections: false, idlePlaceholder: 'idle hint' }),
      bundledI18n.t('coworkSteerPlaceholder'),
    );
    // ...but a filled slot is a reply, so it wins even mid-stream.
    assert.equal(
      deriveCoworkComposerPlaceholder({ isStreaming: true, steerDisabled: false, hasQuotedSelections: true, idlePlaceholder: 'idle hint' }),
      replyPlaceholder,
    );
    bundledI18n.setLanguage('en', { persist: false });
    assert.equal(bundledI18n.t('coworkQuoteReplyPlaceholder'), 'Reply…');
    assert.equal(
      deriveCoworkComposerPlaceholder({ isStreaming: false, steerDisabled: false, hasQuotedSelections: true, idlePlaceholder: 'idle hint' }),
      'Reply…',
    );
  } finally {
    bundledI18n.setLanguage(original, { persist: false });
  }

  // The component derives the placeholder through this helper with the live
  // slot state.
  assert.match(inputSource, /deriveCoworkComposerPlaceholder\(\{/);
  assert.match(inputSource, /hasQuotedSelections: quotedSelections\.length > 0/);
});

test('submitting a short message reply carries the full text with role and position', () => {
  const fragment = reply(REPLY_TEXT, 3, false, 'q-full');
  withLanguage('zh', () => {
    const prompt = composeSubmittedCoworkPrompt({
      value: 'Please answer only about that part.',
      quotedSelections: [fragment],
      attachmentLines: 'Attachment path: /tmp/brief.md',
      labels: labels(),
    });
    // The block leads with the message's role + position, then the original.
    assert.ok(prompt.startsWith('> 回复 助手消息（第 3 条）：\n> '), prompt);
    assert.ok(prompt.includes(REPLY_TEXT), 'the whole message rides in the body');
    assert.ok(
      prompt.indexOf(REPLY_TEXT) < prompt.indexOf('Please answer only about that part.'),
      'the excerpt reads before the instruction',
    );
    assert.ok(
      prompt.indexOf('Please answer only about that part.') < prompt.indexOf('Attachment path:'),
      'attachments still trail the instruction',
    );
    // A single reply block has no separate passage heading above it.
    assert.ok(!prompt.includes(i18nService.t('coworkQuoteBlockHeader')));
  });

  // The steer path composes through the same single call, and the resulting
  // body is what onSubmit receives.
  assert.match(inputSource, /const finalPrompt = composeSubmittedCoworkPrompt\(\{/);
  assert.equal((inputSource.match(/composeSubmittedCoworkPrompt\(\{/g) ?? []).length, 1, 'one composition path for idle and steer');
  assert.match(inputSource, /onSubmit\(finalPrompt/);
  assert.doesNotMatch(inputSource, /isStreaming\s*\?\s*trimmedValue/);
});

test('a long message reply is capped at the excerpt limit with an explicit in-body note', () => {
  const long = `${'y'.repeat(QUOTED_SELECTION_MAX_CHARS + 500)}DROPPED-TAIL`;
  const fragment = reply(long, 7, false, 'q-long');
  assert.equal(fragment.text.length, QUOTED_SELECTION_MAX_CHARS);
  assert.equal(fragment.truncated, true);

  withLanguage('zh', () => {
    const prompt = composeSubmittedCoworkPrompt({
      value: 'summarize this',
      quotedSelections: [fragment],
      labels: labels(),
    });
    const note = i18nService.t('coworkQuoteTruncatedNote').replace('{max}', String(QUOTED_SELECTION_MAX_CHARS));
    assert.ok(prompt.includes(fragment.text), 'the capped excerpt rides in full');
    assert.ok(!prompt.includes('DROPPED-TAIL'), 'the dropped tail never reaches the body');
    assert.ok(prompt.includes(note), 'the cut is stated explicitly in the body');
    assert.ok(
      prompt.indexOf(note) > prompt.indexOf(fragment.text.slice(0, 40)),
      'the note sits at the excerpt tail',
    );
  });
});

test('the preview summary and the transmitted excerpt are budgeted independently', () => {
  // 200 characters: the visible summary is cut at the 96-character budget,
  // while the body still carries every character (well under the 4000 cap).
  const medium = 'z'.repeat(200);
  const mediumFragment = reply(medium, 2, false, 'q-medium');
  const summary = summarizeQuotedSelectionText(mediumFragment.text);
  assert.equal(summary.length, QUOTED_SELECTION_SUMMARY_CHARS + 1, 'summary = 96 characters + ellipsis');
  assert.ok(summary.endsWith('…'));
  assert.equal(mediumFragment.truncated, false, 'the fragment is not truncated');
  const mediumPrompt = composeSubmittedCoworkPrompt({ value: 'x', quotedSelections: [mediumFragment], labels: labels() });
  assert.ok(mediumPrompt.includes(medium), 'the body keeps the full 200 characters');
  assert.ok(
    !mediumPrompt.includes(i18nService.t('coworkQuoteTruncatedNote').replace('{max}', String(QUOTED_SELECTION_MAX_CHARS))),
    'no truncation note under the cap',
  );

  // 4500 characters: the same summary budget, the body capped at 4000 with
  // the note — the two budgets never share a number.
  const longFragment = reply('w'.repeat(QUOTED_SELECTION_MAX_CHARS + 500), 2, false, 'q-over');
  assert.equal(summarizeQuotedSelectionText(longFragment.text).length, QUOTED_SELECTION_SUMMARY_CHARS + 1);
  assert.equal(longFragment.truncated, true);
});

test('a still-generating target is marked in the body, and the excerpt stays frozen', () => {
  // The live message keeps streaming after the reply was taken from it.
  const message = { content: 'First sentence so far.', role: 'assistant', ordinal: 3, streaming: true };
  const frozen = createMessageQuotedSelection(message, 'q-stream');
  withLanguage('zh', () => {
    const before = composeSubmittedCoworkPrompt({
      value: 'keep going from here',
      quotedSelections: [frozen],
      labels: labels(),
    });
    assert.ok(before.includes('回复 助手消息（第 3 条 · 该条仍在生成中）：'), 'the block marks the generating target');
    assert.ok(before.includes('First sentence so far.'));

    // The stream appends tokens to the live message; the quoted excerpt — and
    // therefore the composed body — must not move.
    message.content = 'First sentence so far. Second sentence. Third.';
    const after = composeSubmittedCoworkPrompt({
      value: 'keep going from here',
      quotedSelections: [frozen],
      labels: labels(),
    });
    assert.equal(after, before, 'the snapshot never changes under the owner');
    assert.ok(!after.includes('Second sentence.'));

    // A settled message carries no mark.
    const settled = reply('Done already.', 4, false, 'q-done');
    const settledPrompt = composeSubmittedCoworkPrompt({ value: 'x', quotedSelections: [settled], labels: labels() });
    assert.ok(!settledPrompt.includes(i18nService.t('coworkQuoteReplyStreamingMark')));
    assert.ok(settledPrompt.includes('回复 助手消息（第 4 条）：'));
  });
});

test('the new entry reaches the submit truth table in every cell, idle and running', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-reply-truth-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const outputFile = path.join(tempDir, 'prompt-state.mjs');
  await build({
    absWorkingDir: projectRoot,
    stdin: {
      contents: `export { deriveCoworkPromptInputState } from './src/renderer/components/cowork/CoworkPromptInput.tsx';`,
      resolveDir: projectRoot,
      sourcefile: 'prompt-state-entry.ts',
      loader: 'ts',
    },
    outfile: outputFile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
  });
  const { deriveCoworkPromptInputState } = await import(`${pathToFileURL(outputFile).href}?test=${Date.now()}`);

  // Idle × quote-only: the reply fragment alone is submit content.
  assert.deepEqual(
    deriveCoworkPromptInputState({ value: '', isStreaming: false, disabled: false, steerDisabled: false, attachmentCount: 0, quotedSelectionCount: 1 }),
    { hasTextInput: false, isSteerSubmit: false, showStopButton: false, canSubmit: true },
  );
  // Idle × text only: unchanged plain send.
  assert.deepEqual(
    deriveCoworkPromptInputState({ value: 'typed', isStreaming: false, disabled: false, steerDisabled: false, attachmentCount: 0, quotedSelectionCount: 0 }),
    { hasTextInput: true, isSteerSubmit: false, showStopButton: false, canSubmit: true },
  );
  // Running × quote-only: 发送 (steer), never 停止 — the first-slice defect
  // this entry must not repeat.
  assert.deepEqual(
    deriveCoworkPromptInputState({ value: '', isStreaming: true, disabled: false, steerDisabled: false, attachmentCount: 0, quotedSelectionCount: 1 }),
    { hasTextInput: false, isSteerSubmit: true, showStopButton: false, canSubmit: true },
  );
  // Running × nothing: stop stays.
  assert.deepEqual(
    deriveCoworkPromptInputState({ value: '', isStreaming: true, disabled: false, steerDisabled: false, attachmentCount: 0, quotedSelectionCount: 0 }),
    { hasTextInput: false, isSteerSubmit: false, showStopButton: true, canSubmit: false },
  );
  // Running × quote-only with steer disabled: stop stays, nothing submits.
  assert.deepEqual(
    deriveCoworkPromptInputState({ value: '', isStreaming: true, disabled: false, steerDisabled: true, attachmentCount: 0, quotedSelectionCount: 1 }),
    { hasTextInput: false, isSteerSubmit: false, showStopButton: true, canSubmit: false },
  );

  // ...and the quote-only steer body carries the whole quoted message.
  const fragment = reply(REPLY_TEXT, 3, false, 'q-steer');
  withLanguage('zh', () => {
    const steerBody = composeSubmittedCoworkPrompt({ value: '', quotedSelections: [fragment], labels: labels() });
    assert.notEqual(steerBody, '', 'a quote-only steer must not compose an empty prompt');
    assert.ok(steerBody.includes(REPLY_TEXT), 'the quoted original rides in the steer body');
    assert.ok(steerBody.includes('回复 助手消息（第 3 条）：'), 'the steer body uses the same reply block');
  });

  // Both branches consume the same single slot; only an empty steer returns
  // early, before anything is composed or consumed.
  assert.match(inputSource, /if \(isStreaming && !trimmedValue && submittedQuotedSelections\.length === 0\) return;/);
  assert.match(inputSource, /const quotedSelectionSnapshot = quotedSelectionField\.takeAndClear\(\);/);
});

test('a rejected submission restores the reply quote; an accepted one clears it', async () => {
  const fragment = reply(REPLY_TEXT, 3, false, 'q-restore');
  const runSubmit = async (outcome) => {
    const quotedField = createVersionedComposerField([fragment], () => [], () => {});
    const draftField = createVersionedComposerField('', () => '', () => {});
    const quotedSnapshot = quotedField.takeAndClear();
    const draftSnapshot = draftField.takeAndClear();
    assert.deepEqual(quotedField.get(), [], 'consumed at submit time');
    const result = await runComposerSubmission(draftField, draftSnapshot, () => outcome);
    if (result === false) {
      quotedField.restoreIfUnchanged(quotedSnapshot);
    }
    return quotedField;
  };

  assert.deepEqual(
    (await runSubmit(false)).get().map((entry) => entry.text),
    [REPLY_TEXT],
    'a rejected submit restores the reply quote',
  );
  assert.deepEqual((await runSubmit(true)).get(), [], 'an accepted submit leaves the slot cleared');

  // A quote added while the submit was in flight is newer state: the stale
  // restore is refused.
  const quotedField = createVersionedComposerField([fragment], () => [], () => {});
  const snapshot = quotedField.takeAndClear();
  quotedField.set([reply('newer quote', 5, false, 'q-newer')]);
  assert.equal(quotedField.restoreIfUnchanged(snapshot), false);
  assert.deepEqual(quotedField.get().map((entry) => entry.messageRef.ordinal), [5]);

  // Both rejection arms (accepted===false / thrown) restore the slot.
  assert.equal(
    (inputSource.match(/quotedSelectionField\.restoreIfUnchanged\(quotedSelectionSnapshot\)/g) ?? []).length,
    2,
  );
});

test('the transcript position numbering counts rendered messages for the reply label', () => {
  const turns = [
    {
      userMessage: { id: 'u1' },
      assistantItems: [
        { type: 'assistant', message: { id: 'a1' } },
        { type: 'tool_group', group: { toolUse: { id: 't1' } } },
        { type: 'tool_result', message: { id: 'tr1' } },
      ],
    },
    {
      userMessage: { id: 'u2' },
      assistantItems: [
        { type: 'system', message: { id: 's1' } },
        { type: 'assistant', message: { id: 'a2' } },
      ],
    },
    {
      userMessage: null,
      assistantItems: [{ type: 'assistant', message: { id: 'a3' } }],
    },
  ];
  const positions = buildTranscriptMessagePositions(turns);
  assert.equal(positions.get('u1'), 1);
  assert.equal(positions.get('a1'), 2);
  assert.equal(positions.get('u2'), 3);
  assert.equal(positions.get('a2'), 4);
  assert.equal(positions.get('a3'), 5);
  assert.equal(positions.get('t1'), undefined, 'tool chrome is not numbered');
  assert.equal(positions.get('tr1'), undefined);
  assert.equal(positions.get('s1'), undefined, 'system notices are not numbered');

  // The click path reads this map at capture time and freezes the number into
  // the fragment.
  assert.match(detailSource, /buildTranscriptMessagePositions\(turns\)/);
  assert.match(detailSource, /transcriptMessagePositionsRef\.current\.get\(message\.id\)/);
});

test('a reply block that quotes several messages opens with the reply header', () => {
  // The composer slot is single-target today; the block builder keeps the
  // model's N support, where a shared header keeps every item line a
  // per-message label.
  const first = reply('first quoted message', 1, false, 'q1');
  const second = reply('second quoted message', 2, true, 'q2');
  withLanguage('zh', () => {
    const block = buildQuotedSelectionsBlock([first, second], labels());
    assert.ok(
      block.startsWith(`> ${i18nService.t('coworkQuoteReplyBlockHeader')}\n>\n`),
      block,
    );
    assert.ok(block.includes('回复 助手消息（第 1 条）：'));
    assert.ok(block.includes('回复 助手消息（第 2 条 · 该条仍在生成中）：'));
    assert.ok(block.includes('> first quoted message') && block.includes('> second quoted message'));
  });
});

test('reply copy lives in both i18n dictionaries and follows the language switch', () => {
  const keys = [
    'coworkQuoteReplyAction',
    'coworkQuoteReplyPreviewLabel',
    'coworkQuoteReplyCancel',
    'coworkQuoteReplyPlaceholder',
    'coworkQuoteReplyBlockHeader',
    'coworkQuoteReplyBlockItem',
    'coworkQuoteReplyStreamingMark',
    'coworkQuoteReplySourceUser',
    'coworkQuoteReplySourceAssistant',
    'coworkQuoteReplySourceOther',
    'coworkQuoteTruncatedNote',
  ];
  for (const key of keys) {
    assert.equal(
      (i18nSource.match(new RegExp(`${key}:`, 'g')) ?? []).length,
      2,
      `${key} must exist in both the zh and en dictionaries`,
    );
  }
  assert.match(i18nSource, /coworkQuoteReplyAction: '回复'/);
  assert.match(i18nSource, /coworkQuoteReplyAction: 'Reply'/);
  assert.match(i18nSource, /coworkQuoteReplyCancel: '取消回复'/);
  assert.match(i18nSource, /coworkQuoteReplyCancel: 'Cancel reply'/);
  assert.match(i18nSource, /coworkQuoteReplyPlaceholder: '回复…'/);
  assert.match(i18nSource, /coworkQuoteReplyPlaceholder: 'Reply…'/);
  assert.match(i18nSource, /coworkQuoteReplyStreamingMark: '该条仍在生成中'/);
  assert.match(i18nSource, /coworkQuoteReplyBlockItem: '回复 \{source\}（第 \{ordinal\} 条\{streaming\}）：'/);

  // Rendered labels follow the language.
  const fragment = reply(REPLY_TEXT, 3, false, 'q-i18n');
  const renderButton = () => renderToStaticMarkup(
    <CoworkMessageReplyAction text={REPLY_TEXT} onReply={() => {}} />,
  );
  const renderBar = () => renderToStaticMarkup(
    <CoworkQuotedSelectionTiles selections={[fragment]} onRemove={() => {}} />,
  );
  withLanguage('zh', () => {
    assert.ok(renderButton().includes('回复'), 'the zh dictionary drives the entry label');
    const bar = renderBar();
    assert.ok(bar.includes('取消回复') && bar.includes('引用消息预览'), 'the zh dictionary drives the bar');
  });
  withLanguage('en', () => {
    assert.ok(renderButton().includes('Reply'), 'the en dictionary drives the entry label');
    const bar = renderBar();
    assert.ok(bar.includes('Cancel reply') && bar.includes('Quoted message'), 'the en dictionary drives the bar');
  });

  // ...and no component hardcodes that copy.
  for (const source of [inputSource, detailSource, tilesSource, replyActionSource]) {
    assert.doesNotMatch(source, /取消回复|引用消息预览|回复…/);
    assert.doesNotMatch(source, /Cancel reply|Quoted message|Reply…/);
  }
  assert.match(replyActionSource, /i18nService\.t\('coworkQuoteReplyAction'\)/);
  assert.match(tilesSource, /i18nService\.t\('coworkQuoteReplyCancel'\)/);
  assert.match(tilesSource, /i18nService\.t\('coworkQuoteReplyPreviewLabel'\)/);
});
