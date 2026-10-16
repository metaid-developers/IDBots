// Quoted transcript selections ("reply to this specific part").
//
// The owner selects text inside the transcript, a one-item action bar floats
// next to the selection, and adding it puts a removable fragment in the
// composer. The fragment has to end up in the prompt BODY — the bot re-reads
// the conversation as plain text on every turn, so a visual highlight alone
// would reach it with nothing attached.
//
// The repository's react test stack is SSR-only (react-dom/server, no jsdom),
// so the evidence is layered: real behaviour of the pure module the submit and
// render paths call, real markup from the two presentational components, and
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
  buildQuotedSelectionsBlock,
  composeCoworkPromptBody,
  composeSubmittedCoworkPrompt,
  createPendingQuotedSelection,
  createQuotedSelection,
  nextQuotedSelectionId,
  normalizeQuotedSelectionText,
  removeQuotedSelection,
  resolveQuoteActionBarAnchorRect,
  resolveQuotedSelectionRole,
  summarizeQuotedSelectionText,
} from '../src/renderer/components/cowork/coworkQuotedSelections';
import {
  createVersionedComposerField,
  runComposerSubmission,
} from '../src/renderer/components/cowork/coworkPromptSubmission';
import CoworkQuotedSelectionTiles from '../src/renderer/components/cowork/CoworkQuotedSelectionTiles';
import CoworkQuoteActionBar from '../src/renderer/components/cowork/CoworkQuoteActionBar';
import { i18nService } from '../src/renderer/services/i18n';
import reducer, { setSessionDraft } from '../src/renderer/store/slices/coworkSlice';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (...segments) => fs.readFileSync(path.join(projectRoot, ...segments), 'utf8');

const inputSource = readSource('src', 'renderer', 'components', 'cowork', 'CoworkPromptInput.tsx');
const detailSource = readSource('src', 'renderer', 'components', 'cowork', 'CoworkSessionDetail.tsx');
const actionBarSource = readSource('src', 'renderer', 'components', 'cowork', 'CoworkQuoteActionBar.tsx');
const tilesSource = readSource('src', 'renderer', 'components', 'cowork', 'CoworkQuotedSelectionTiles.tsx');
const i18nSource = readSource('src', 'renderer', 'services', 'i18n.ts');

// Labels as the running app supplies them (never hardcoded in the components).
const labels = {
  header: i18nService.t('coworkQuoteBlockHeader'),
  item: i18nService.t('coworkQuoteBlockItem'),
  sourceLabel: {
    user: i18nService.t('coworkQuoteSourceUser'),
    assistant: i18nService.t('coworkQuoteSourceAssistant'),
    other: i18nService.t('coworkQuoteSourceOther'),
  },
};

const QUOTE_TEXT = 'Point two is where the answer drifted away from my question.';

const selection = (text, role, id) => createQuotedSelection(text, role, id);

test('an empty selection produces nothing at all', () => {
  assert.equal(normalizeQuotedSelectionText('   \n\t '), '', 'whitespace normalizes to nothing');
  assert.equal(normalizeQuotedSelectionText(''), '');
  assert.equal(createPendingQuotedSelection('   ', 'assistant-block'), null, 'no pending selection for whitespace');
  assert.equal(createPendingQuotedSelection('\n\n', null), null);
  assert.equal(selection('   ', 'assistant', 'q-empty'), null, 'no fragment for whitespace');
  assert.equal(buildQuotedSelectionsBlock([], labels), '', 'no excerpt block for zero fragments');
  assert.equal(
    composeSubmittedCoworkPrompt({ value: '', quotedSelections: [], labels }),
    '',
    'nothing selected and nothing typed still submits nothing',
  );

  // No selection => neither the action bar nor any tile renders.
  assert.equal(
    renderToStaticMarkup(<CoworkQuotedSelectionTiles selections={[]} onRemove={() => {}} />),
    '',
  );
  // The transcript only floats the bar while a pending selection exists.
  assert.match(detailSource, /\{pendingQuoteSelection && quoteActionPlacement && \(/);
});

test('a selection floats an action item that offers the targeted reply', () => {
  const markup = renderToStaticMarkup(
    <CoworkQuoteActionBar placement={{ top: 120, left: 40, width: 176 }} onAdd={() => {}} />,
  );

  assert.ok(markup.includes('data-cowork-quote-action="true"'), 'action bar rendered');
  assert.ok(
    markup.includes(i18nService.t('coworkQuoteAddToConversation')),
    'the add-to-conversation item is offered',
  );
  assert.ok(markup.includes('position:fixed'), 'bar is position:fixed (escapes ancestor overflow)');
  assert.ok(markup.includes('top:120px') && markup.includes('left:40px'), 'placement is applied verbatim');

  // The transcript side: selection captured on mouseup / shift+arrow, placed
  // through the repository's shared anchored-popover helpers.
  assert.match(detailSource, /onMouseUp=\{handleTranscriptSelectionEnd\}/);
  assert.match(detailSource, /onKeyUp=\{handleTranscriptSelectionKeyUp\}/);
  assert.match(detailSource, /placePopoverAbove\(/);
  assert.match(detailSource, /useAnchorMoveWatcher\(quoteAnchorRef/);
  assert.match(detailSource, /createPendingQuotedSelection\(/);
  assert.match(detailSource, /promptInputRef\.current\?\.addQuotedSelection\(fragment\)/);
});

test('the action item follows the app language', () => {
  const renderBar = () => renderToStaticMarkup(
    <CoworkQuoteActionBar placement={{ top: 10, left: 10, width: 176 }} onAdd={() => {}} />,
  );
  const original = i18nService.getLanguage();
  try {
    i18nService.setLanguage('zh', { persist: false });
    assert.ok(renderBar().includes('添加到对话'), 'the zh dictionary drives the rendered label');
    i18nService.setLanguage('en', { persist: false });
    assert.ok(renderBar().includes('Add to conversation'), 'the en dictionary drives the rendered label');
  } finally {
    // Shared singleton: leave the language as the rest of the suite found it.
    i18nService.setLanguage(original, { persist: false });
  }
  assert.equal(i18nService.getLanguage(), original);
});

test('the selected passage is only quotable when the selection resolves to text', () => {
  assert.deepEqual(createPendingQuotedSelection('  quote me  ', 'assistant-block'), {
    text: 'quote me',
    role: 'assistant',
  });
  assert.equal(createPendingQuotedSelection('quote me', 'user-message').role, 'user');
  assert.equal(createPendingQuotedSelection('quote me', null).role, 'other');
  assert.equal(resolveQuotedSelectionRole('assistant-message'), 'assistant');
  assert.equal(resolveQuotedSelectionRole(undefined), 'other');

  // Placement prefers the live selection rect and falls back to the block rect
  // once the range has collapsed.
  const live = { width: 120, height: 18 };
  const block = { width: 640, height: 300 };
  assert.equal(resolveQuoteActionBarAnchorRect(live, block), live);
  assert.equal(resolveQuoteActionBarAnchorRect(null, block), block);
  assert.equal(resolveQuoteActionBarAnchorRect({ width: 0, height: 0 }, block), block);
  assert.equal(resolveQuoteActionBarAnchorRect(null, null), null);
});

test('added fragments render as tiles with their source and summary, and can be removed one by one', () => {
  const first = selection(`${QUOTE_TEXT} ${'x'.repeat(QUOTED_SELECTION_MAX_CHARS)}`, 'assistant', 'q-1');
  const second = selection('And this is my own earlier message.', 'user', 'q-2');
  const markup = renderToStaticMarkup(
    <CoworkQuotedSelectionTiles selections={[first, second]} onRemove={() => {}} />,
  );

  assert.equal((markup.match(/data-cowork-quote-tile="/g) ?? []).length, 2, 'one tile per fragment');
  assert.ok(markup.includes(i18nService.t('coworkQuoteSourceAssistant')), 'assistant source named');
  assert.ok(markup.includes(i18nService.t('coworkQuoteSourceUser')), 'user source named');
  assert.ok(markup.includes(i18nService.t('coworkQuoteSelectionsLabel')), 'fragment list labelled');
  assert.ok(
    markup.includes(summarizeQuotedSelectionText(first.text)),
    'the tile shows the fragment summary',
  );
  assert.ok(markup.includes(QUOTE_TEXT), 'the summary is taken from the quoted text itself');
  assert.ok(first.truncated && markup.includes(i18nService.t('coworkQuoteTruncated')), 'truncation is surfaced');
  assert.notEqual(
    summarizeQuotedSelectionText(first.text),
    first.text,
    'the visible line is a bounded summary, not the whole excerpt',
  );
  assert.ok(markup.includes(first.text), 'the full excerpt stays available on hover (title attribute)');
  assert.equal(
    (markup.match(new RegExp(`aria-label="${i18nService.t('coworkQuoteRemove')}`, 'g')) ?? []).length,
    2,
    'every tile carries its own remove control',
  );
});

test('summaries stay one short line while the excerpt keeps its own text', () => {
  const long = selection(`${'line one\nline two   '.repeat(20)}end`, 'assistant', 'q-long');
  const summary = summarizeQuotedSelectionText(long.text);
  assert.ok(summary.length <= 97, 'summary is bounded');
  assert.ok(summary.endsWith('…'), 'a cut summary is marked as cut');
  assert.ok(!summary.includes('\n'), 'summary is a single line');
  assert.ok(long.text.includes('line two'), 'the fragment itself keeps its text');
  assert.equal(long.truncated, false, 'a few hundred characters are not truncated');

  const huge = selection('y'.repeat(QUOTED_SELECTION_MAX_CHARS + 500), 'assistant', 'q-huge');
  assert.equal(huge.text.length, QUOTED_SELECTION_MAX_CHARS, 'excerpts are capped');
  assert.equal(huge.truncated, true);
});

test('sending puts the quoted original into the prompt body, next to the instruction', () => {
  const first = selection(QUOTE_TEXT, 'assistant', 'q-1');
  const second = selection('An earlier message of mine.', 'user', 'q-2');
  const prompt = composeSubmittedCoworkPrompt({
    value: '  Please answer only about that part.  ',
    quotedSelections: [first, second],
    attachmentLines: 'Attachment path: /tmp/brief.md',
    labels,
  });

  assert.ok(prompt.includes(QUOTE_TEXT), 'the quoted original is in the prompt body');
  assert.ok(prompt.includes('An earlier message of mine.'), 'every fragment is in the prompt body');
  assert.ok(prompt.includes('Please answer only about that part.'), 'the instruction is in the prompt body');
  assert.ok(prompt.includes('Attachment path: /tmp/brief.md'), 'attachment lines still ride along');
  assert.ok(
    prompt.indexOf(labels.header) < prompt.indexOf('Please answer only about that part.'),
    'the excerpt block reads before the instruction',
  );
  assert.ok(
    prompt.indexOf('Please answer only about that part.') < prompt.indexOf('Attachment path:'),
    'the instruction reads before the attachment lines',
  );
  assert.ok(
    prompt.includes(i18nService.t('coworkQuoteSourceAssistant'))
    && prompt.includes(i18nService.t('coworkQuoteSourceUser')),
    'each excerpt names its source',
  );

  // Removing a fragment drops exactly that excerpt from the next prompt.
  const remaining = removeQuotedSelection([first, second], 'q-1');
  assert.equal(remaining.length, 1);
  const afterRemoval = composeSubmittedCoworkPrompt({
    value: 'Please answer only about that part.',
    quotedSelections: remaining,
    labels,
  });
  assert.ok(!afterRemoval.includes(QUOTE_TEXT), 'the removed excerpt is gone from the prompt');
  assert.ok(afterRemoval.includes('An earlier message of mine.'), 'the kept excerpt stays');
  assert.ok(
    !composeSubmittedCoworkPrompt({ value: 'plain', quotedSelections: [], labels }).includes(labels.header),
    'no excerpt block when nothing is quoted',
  );
});

test('prompt composition without quotes is byte-identical to the previous logic', () => {
  assert.equal(composeCoworkPromptBody({ instruction: 'hi' }), 'hi');
  assert.equal(composeCoworkPromptBody({ instruction: 'hi', attachmentLines: 'Attachment path: /a' }), 'hi\n\nAttachment path: /a');
  assert.equal(composeCoworkPromptBody({ instruction: '', attachmentLines: 'Attachment path: /a' }), 'Attachment path: /a');
  assert.equal(composeCoworkPromptBody({ instruction: '  hi  ' }), 'hi');
  assert.equal(composeCoworkPromptBody({}), '');
  assert.equal(
    composeSubmittedCoworkPrompt({ value: 'hi', quotedSelections: [], attachmentLines: 'Attachment path: /a', labels }),
    'hi\n\nAttachment path: /a',
  );
});

test('fragment ids are unique so removing one never touches its siblings', () => {
  assert.notEqual(nextQuotedSelectionId(), nextQuotedSelectionId());
  const a = selection('first', 'user');
  const b = selection('second', 'assistant');
  const removed = removeQuotedSelection([a, b], b.id);
  assert.deepEqual(removed.map((entry) => entry.text), ['first']);
  assert.deepEqual(removeQuotedSelection([a, b], 'not-there').map((entry) => entry.text), ['first', 'second']);
});

test('quoted fragments are a separate composer state from file attachments', () => {
  // Distinct versioned fields / state, distinct ref method, distinct action.
  assert.match(inputSource, /const quotedSelectionFieldRef = useRef<VersionedComposerField<CoworkQuotedSelection\[\]>/);
  assert.match(inputSource, /const \[quotedSelections, setQuotedSelections\] = useState<CoworkQuotedSelection\[\]>/);
  assert.match(inputSource, /addQuotedSelection: \(selection: CoworkQuotedSelection\)/);
  assert.doesNotMatch(
    inputSource,
    /addQuotedSelection[\s\S]{0,400}attachmentFieldRef\.current\?\.set/,
    'adding a quote must not write the attachment list',
  );
  // The tiles are their own component, not the attachment chip loop.
  assert.match(inputSource, /<CoworkQuotedSelectionTiles/);
  assert.match(tilesSource, /data-cowork-quote-tile=/);
  assert.match(inputSource, /data-cowork-quote-tiles|handleRemoveQuotedSelection/);

  // Store level: one draft entry holds both lists independently.
  const state = reducer(undefined, setSessionDraft({
    sessionId: 'sess-1',
    value: 'typed text',
    attachments: [{ path: '/tmp/a.md', name: 'a.md' }],
    quotedSelections: [selection('quoted passage', 'assistant', 'q-1')],
  }));
  const draft = state.sessionDrafts['sess-1'];
  assert.equal(draft.value, 'typed text');
  assert.deepEqual(draft.attachments.map((entry) => entry.path), ['/tmp/a.md']);
  assert.deepEqual(draft.quotedSelections.map((entry) => entry.text), ['quoted passage']);
  assert.notEqual(draft.attachments, draft.quotedSelections, 'the two lists are never the same array');

  // Removing the last fragment still keeps the rest of the draft.
  const afterDrop = reducer(state, setSessionDraft({
    sessionId: 'sess-1',
    value: 'typed text',
    attachments: [{ path: '/tmp/a.md', name: 'a.md' }],
    quotedSelections: [],
  }));
  assert.equal(afterDrop.sessionDrafts['sess-1'].quotedSelections, undefined);
  assert.equal(afterDrop.sessionDrafts['sess-1'].value, 'typed text');

  // A draft that never quoted anything keeps its previous shape.
  const plain = reducer(undefined, setSessionDraft({ sessionId: 'sess-2', value: 'abc', attachments: [] }));
  assert.deepEqual(plain.sessionDrafts['sess-2'], { value: 'abc', attachments: [] });
});

test('the composer writes quoted fragments through the real submit path and rolls back on rejection', () => {
  assert.match(inputSource, /composeSubmittedCoworkPrompt\(\{/);
  assert.match(inputSource, /quotedSelections: submittedQuotedSelections/);
  assert.match(inputSource, /quotedSelectionSnapshot = quotedSelectionField\.takeAndClear\(\)/);
  assert.match(inputSource, /quotedSelectionField\.restoreIfUnchanged\(quotedSelectionSnapshot\)/);
  assert.match(
    inputSource,
    /!trimmedValue && submittedAttachments\.length === 0 && submittedQuotedSelections\.length === 0/,
    'a fragment can be sent on its own',
  );

  // Negative guard: the composed-prompt helper of an unmerged branch must not
  // be referenced on this baseline (this baseline has no such symbol).
  assert.doesNotMatch(inputSource, new RegExp(['compose', 'Cowork', 'SubmitPrompt'].join('')));
});

test('a steer that carries only quoted excerpts offers send, not stop, and stays sendable', async (t) => {
  // Real behaviour of the composer's derived state, loaded through the
  // repository's esbuild bundle trick (the component itself is SSR-only, so
  // events cannot be mounted here).
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-quote-steer-'));
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

  // Quote-only steer (the defect): send, enabled — not stop.
  assert.deepEqual(
    deriveCoworkPromptInputState({ value: '', isStreaming: true, disabled: false, steerDisabled: false, attachmentCount: 0, quotedSelectionCount: 1 }),
    { hasTextInput: false, isSteerSubmit: true, showStopButton: false, canSubmit: true },
  );
  // Typed text still steers exactly as before.
  assert.deepEqual(
    deriveCoworkPromptInputState({ value: 'focus on point two', isStreaming: true, disabled: false, steerDisabled: false, attachmentCount: 0, quotedSelectionCount: 1 }),
    { hasTextInput: true, isSteerSubmit: true, showStopButton: false, canSubmit: true },
  );
  // steerDisabled keeps its meaning: stop stays, nothing submits.
  assert.deepEqual(
    deriveCoworkPromptInputState({ value: '', isStreaming: true, disabled: false, steerDisabled: true, attachmentCount: 0, quotedSelectionCount: 1 }),
    { hasTextInput: false, isSteerSubmit: false, showStopButton: true, canSubmit: false },
  );
  // Attachments are a disabled semantic while a turn streams: they never make
  // a steer sendable.
  assert.deepEqual(
    deriveCoworkPromptInputState({ value: '', isStreaming: true, disabled: false, steerDisabled: false, attachmentCount: 2, quotedSelectionCount: 0 }),
    { hasTextInput: false, isSteerSubmit: false, showStopButton: true, canSubmit: false },
  );
  // Idle quote-only composers stay sendable too (unchanged).
  assert.deepEqual(
    deriveCoworkPromptInputState({ value: '', isStreaming: false, disabled: false, steerDisabled: false, attachmentCount: 0, quotedSelectionCount: 1 }),
    { hasTextInput: false, isSteerSubmit: false, showStopButton: false, canSubmit: true },
  );
});

test('a steer composed from quoted excerpts alone carries the excerpt and is never empty', () => {
  const fragment = selection(QUOTE_TEXT, 'assistant', 'q-steer');
  const quoteOnlySteer = composeSubmittedCoworkPrompt({ value: '', quotedSelections: [fragment], labels });
  assert.notEqual(quoteOnlySteer, '', 'a quote-only steer must not compose an empty prompt');
  assert.ok(quoteOnlySteer.includes(QUOTE_TEXT), 'the quoted original rides in the steer prompt body');
  assert.ok(quoteOnlySteer.includes(labels.header), 'the same blockquote header as an idle submit');

  const steerWithText = composeSubmittedCoworkPrompt({
    value: 'answer only about that part',
    quotedSelections: [fragment],
    labels,
  });
  assert.ok(steerWithText.includes(QUOTE_TEXT) && steerWithText.includes('answer only about that part'));
  assert.ok(
    steerWithText.indexOf(labels.header) < steerWithText.indexOf('answer only about that part'),
    'the excerpt still reads before the instruction',
  );
  // Nothing quoted and nothing typed composes to an empty string; the submit
  // guard (asserted below at source level) is what keeps it from being sent.
  assert.equal(composeSubmittedCoworkPrompt({ value: '', quotedSelections: [], labels }), '');
});

test('the steer branch composes, consumes and restores quoted fragments through the shared submit path', () => {
  // The defect: a steer composed `trimmedValue` alone, dropping the excerpts.
  assert.doesNotMatch(inputSource, /isStreaming\s*\?\s*trimmedValue/);
  assert.match(inputSource, /const finalPrompt = composeSubmittedCoworkPrompt\(\{/);
  assert.match(inputSource, /quotedSelections: submittedQuotedSelections/);
  // Attachments stay idle-only: a disabled semantic while a turn streams.
  assert.match(inputSource, /attachmentLines: isStreaming \? undefined : attachmentLines/);

  // A steer needs text or excerpts; only an empty steer returns early, and it
  // does so before anything is composed or consumed — so click and Enter can
  // never submit an empty steer prompt.
  assert.match(inputSource, /if \(isStreaming && !trimmedValue && submittedQuotedSelections\.length === 0\) return;/);
  assert.match(inputSource, /event\.key === 'Enter' && !event\.shiftKey && !isComposing && !disabled/);

  // Excerpts are consumed on every submit path, not only when idle...
  assert.match(inputSource, /const quotedSelectionSnapshot = quotedSelectionField\.takeAndClear\(\);/);
  assert.doesNotMatch(inputSource, /if \(!isStreaming\) \{[^}]*quotedSelectionField\.takeAndClear/);
  // ...and both rejection arms (accepted===false / thrown) roll them back.
  assert.equal(
    (inputSource.match(/quotedSelectionField\.restoreIfUnchanged\(quotedSelectionSnapshot\)/g) ?? []).length,
    2,
    'both the accepted===false arm and the catch arm restore the fragments',
  );
});

test('a steer submit consumes quoted fragments and restores them only when it is rejected', async () => {
  // Mirrors the steer branch's sequence (source-asserted above) with the same
  // primitives it calls: takeAndClear at submit time, restoreIfUnchanged on
  // rejection, nothing on acceptance.
  const fragment = selection(QUOTE_TEXT, 'assistant', 'q-steer');
  const runSteer = async (outcome) => {
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
    (await runSteer(false)).get().map((entry) => entry.text),
    [QUOTE_TEXT],
    'a rejected steer restores the fragments',
  );
  assert.deepEqual(
    (await runSteer(true)).get(),
    [],
    'an accepted steer leaves the fragments cleared',
  );

  // Thrown submission: the catch arm restores too.
  const quotedField = createVersionedComposerField([fragment], () => [], () => {});
  const draftField = createVersionedComposerField('', () => '', () => {});
  const quotedSnapshot = quotedField.takeAndClear();
  const draftSnapshot = draftField.takeAndClear();
  await assert.rejects(
    runComposerSubmission(draftField, draftSnapshot, () => { throw new Error('steer failed'); }),
    /steer failed/,
  );
  quotedField.restoreIfUnchanged(quotedSnapshot);
  assert.deepEqual(quotedField.get().map((entry) => entry.text), [QUOTE_TEXT], 'a thrown steer restores the fragments');

  // A fragment added while the steer was in flight is newer state: the stale
  // snapshot restore is refused, so a rejected submit never clobbers it.
  const inFlightField = createVersionedComposerField([fragment], () => [], () => {});
  const inFlightSnapshot = inFlightField.takeAndClear();
  inFlightField.set([selection('newer excerpt', 'user', 'q-later')]);
  assert.equal(inFlightField.restoreIfUnchanged(inFlightSnapshot), false);
  assert.deepEqual(inFlightField.get().map((entry) => entry.text), ['newer excerpt']);
});

test('quoted-selection copy lives in both i18n dictionaries', () => {
  const keys = [
    'coworkQuoteAddToConversation',
    'coworkQuoteActionLabel',
    'coworkQuoteSelectionsLabel',
    'coworkQuoteRemove',
    'coworkQuoteTruncated',
    'coworkQuoteSourceUser',
    'coworkQuoteSourceAssistant',
    'coworkQuoteSourceOther',
    'coworkQuoteBlockHeader',
    'coworkQuoteBlockItem',
  ];
  for (const key of keys) {
    assert.equal(
      (i18nSource.match(new RegExp(`${key}:`, 'g')) ?? []).length,
      2,
      `${key} must exist in both the zh and en dictionaries`,
    );
  }
  assert.match(i18nSource, /coworkQuoteAddToConversation: '添加到对话'/);
  assert.match(i18nSource, /coworkQuoteAddToConversation: 'Add to conversation'/);

  // ...and no component hardcodes that copy.
  for (const source of [inputSource, detailSource, actionBarSource, tilesSource]) {
    assert.doesNotMatch(source, /添加到对话/);
    assert.doesNotMatch(source, /Add to conversation/);
    assert.doesNotMatch(source, /已选文本片段/);
    assert.doesNotMatch(source, /Quoted excerpts from the conversation/);
  }
  assert.match(actionBarSource, /i18nService\.t\('coworkQuoteAddToConversation'\)/);
  assert.match(tilesSource, /QUOTED_SELECTION_SOURCE_KEYS/);
});
