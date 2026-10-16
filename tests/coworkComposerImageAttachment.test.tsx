// Composer attachments — two properties, both about NOT losing what the user
// attached.
//
// Part 1 (thumbnail): the composer used to render every attachment as the same
// filename pill, so a pasted screenshot showed up as "image-1730000000000.png"
// instead of as the picture the user just attached. Image paths now render as a
// rounded 64px thumbnail fed by the same readLocalImage IPC the transcript
// preview uses.
//   (a) an image path renders <img src=dataUrl> and never the file name as
//       visible text;
//   (b) a non-image path keeps the paperclip + file-name pill, untouched;
//   (c) a failed read neither throws nor leaves a blank chip — it degrades to
//       the non-empty pill, and a pending read shows a placeholder tile.
//
// Part 2 (steering): while a turn is streaming the composer accepted plain text
// but refused attachments at every door (clipboard paste, file drop, the '+'
// picker), and — worse — the submit branch composed the prompt from the text
// alone and never even snapshotted the attachment field, so an image that did
// get in was silently dropped on send. Attachments now walk through the same
// `steerDisabled` door as text, ride the prompt as the same `label: path`
// manifest, and roll back with the text when the parent refuses.
//
// Harness note: this repo's renderer tests are server-rendered (no DOM/jsdom),
// so React event handlers cannot be fired by mounting. The attachment contract
// the handlers execute lives in coworkComposerAttachments.ts as a pure module —
// these tests drive that REAL module — and reads the composer source to pin the
// wiring of each door (paste / drop / picker) and of the submit path to it.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import CoworkAttachmentPreview from '../src/renderer/components/cowork/CoworkAttachmentPreview';
import { i18nService } from '../src/renderer/services/i18n';
import { loadLocalImagePreview } from '../src/renderer/utils/localImage';
import {
  composeCoworkSubmitPrompt,
  coworkAttachmentAdmission,
  forEachIncomingAttachmentPath,
  submitCoworkComposerDraft,
} from '../src/renderer/components/cowork/coworkComposerAttachments';
import {
  createVersionedComposerField,
  runComposerSubmission,
} from '../src/renderer/components/cowork/coworkPromptSubmission';
import { deriveCoworkPromptInputState } from '../src/renderer/components/cowork/CoworkPromptInput';

type ReadLocalImageOptions = { path: string; maxBytes?: number };
type ReadLocalImageResult = { success: boolean; dataUrl?: string; error?: string };
type ReadLocalImage = (options: ReadLocalImageOptions) => Promise<ReadLocalImageResult>;

const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
// Escaped for RegExp: the pill's truncation class carries a Tailwind bracket.
const PILL_CLASS_MARKER = 'truncate max-w-\\[180px\\]';
const THUMBNAIL_CLASS_MARKER = 'h-16 w-16';

/** Every read the component / helper performs, so tests can assert call counts. */
const readCalls: ReadLocalImageOptions[] = [];

const installReadLocalImage = (impl: ReadLocalImage): void => {
  readCalls.length = 0;
  (globalThis as { window?: unknown }).window = {
    electron: {
      cowork: {
        readLocalImage: (options: ReadLocalImageOptions) => {
          readCalls.push(options);
          return impl(options);
        },
      },
    },
  };
};

/** Visible text only: tags (and therefore their attributes) are dropped. */
const visibleText = (markup: string): string => markup
  .replace(/<[^>]*>/g, ' ')
  .replace(/&quot;/g, '"')
  .replace(/&#x27;/g, "'")
  .replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ')
  .trim();

const renderAttachment = (
  attachment: { path: string; name: string },
  removeDisabled = false,
): string => renderToStaticMarkup(
  <CoworkAttachmentPreview
    attachment={attachment}
    removeDisabled={removeDisabled}
    onRemove={() => {}}
  />,
);

const imgSrcOf = (markup: string): string | null => {
  const match = /<img[^>]*\ssrc="([^"]*)"/.exec(markup);
  return match ? match[1] : null;
};

test('an image attachment renders a thumbnail fed by the readLocalImage dataUrl', async () => {
  const path = '/tmp/cowork-composer-thumbnails/pasted-screenshot.png';
  let impl: ReadLocalImageResult = { success: false };
  installReadLocalImage(async () => impl);
  impl = { success: true, dataUrl: PNG_DATA_URL };

  const entry = await loadLocalImagePreview(path);
  assert.equal(entry.status, 'ready');
  assert.equal(readCalls.length, 1);
  assert.equal(readCalls[0].path, path);
  assert.equal(readCalls[0].maxBytes, 10 * 1024 * 1024);

  const markup = renderAttachment({ path, name: 'pasted-screenshot.png' });

  assert.match(markup, /<img/);
  assert.equal(imgSrcOf(markup), PNG_DATA_URL);
  assert.match(markup, /object-cover/);
  assert.match(markup, new RegExp(THUMBNAIL_CLASS_MARKER));
  // The file name is not visible text anymore; the pill shape is gone with it.
  // (The path still rides in the title attribute, which is a tooltip, not text.)
  assert.equal(visibleText(markup).includes('pasted-screenshot.png'), false);
  assert.doesNotMatch(markup, new RegExp(PILL_CLASS_MARKER));
});

test('a non-image attachment keeps the paperclip + filename pill and is never read as an image', () => {
  const path = '/tmp/cowork-composer-thumbnails/meeting-notes.txt';
  installReadLocalImage(async () => ({ success: true, dataUrl: PNG_DATA_URL }));

  const markup = renderAttachment({ path, name: 'meeting-notes.txt' });

  assert.doesNotMatch(markup, /<img/);
  assert.match(markup, new RegExp(PILL_CLASS_MARKER));
  assert.ok(visibleText(markup).includes('meeting-notes.txt'));
  assert.equal(readCalls.length, 0);
});

test('a failed read does not throw and degrades to the non-empty pill', async () => {
  const path = '/tmp/cowork-composer-thumbnails/unreadable.png';
  installReadLocalImage(async () => ({ success: false, error: 'Image file not found' }));

  const entry = await loadLocalImagePreview(path);
  assert.equal(entry.status, 'error');

  const markup = renderAttachment({ path, name: 'unreadable.png' });

  assert.doesNotMatch(markup, /<img/);
  assert.match(markup, new RegExp(PILL_CLASS_MARKER));
  assert.ok(visibleText(markup).includes('unreadable.png'));
});

test('a rejected read is swallowed the same way as a failed one', async () => {
  const path = '/tmp/cowork-composer-thumbnails/rejected.png';
  installReadLocalImage(async () => {
    throw new Error('IPC channel unavailable');
  });

  const entry = await loadLocalImagePreview(path);
  assert.equal(entry.status, 'error');

  const markup = renderAttachment({ path, name: 'rejected.png' });
  assert.equal(visibleText(markup).includes('rejected.png'), true);
});

test('a pending read shows a labelled placeholder tile, not an empty chip', () => {
  const path = '/tmp/cowork-composer-thumbnails/still-loading.png';
  installReadLocalImage(async () => ({ success: true, dataUrl: PNG_DATA_URL }));

  const markup = renderAttachment({ path, name: 'still-loading.png' });

  assert.doesNotMatch(markup, /<img/);
  assert.match(markup, new RegExp(THUMBNAIL_CLASS_MARKER));
  assert.doesNotMatch(markup, new RegExp(PILL_CLASS_MARKER));
  assert.match(markup, new RegExp(`aria-label="${i18nService.t('coworkAttachmentImageLoading')}"`));
  assert.equal(visibleText(markup).includes('still-loading.png'), false);
  assert.equal(readCalls.length, 0);
});

// ---------------------------------------------------------------------------
// Part 2 — steering accepts attachments exactly like text.
// ---------------------------------------------------------------------------

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const composerSource = fs.readFileSync(
  path.join(projectRoot, 'src', 'renderer', 'components', 'cowork', 'CoworkPromptInput.tsx'),
  'utf8',
);

const STEP_IMAGE_PATH = '/tmp/cowork-composer-steer/step-screenshot.png';

test('the attachment door admits while a turn streams, and only steerDisabled closes it', () => {
  // The whole gate is this one predicate; the three doors read its verdict.
  assert.equal(
    coworkAttachmentAdmission({ disabled: false, isStreaming: true, steerDisabled: false }),
    true,
    'a running turn that still allows text steering must admit an image too',
  );
  assert.equal(
    coworkAttachmentAdmission({ disabled: false, isStreaming: true, steerDisabled: true }),
    false,
    'steerDisabled still refuses attachments mid-run',
  );
  assert.equal(
    coworkAttachmentAdmission({ disabled: false, isStreaming: false, steerDisabled: true }),
    true,
    'an idle composer is untouched by steerDisabled',
  );
  assert.equal(coworkAttachmentAdmission({ disabled: false, isStreaming: false, steerDisabled: false }), true);
  assert.equal(
    coworkAttachmentAdmission({ disabled: true, isStreaming: false, steerDisabled: false }),
    false,
    'a disabled composer takes nothing',
  );
  assert.equal(coworkAttachmentAdmission({ disabled: true, isStreaming: true, steerDisabled: false }), false);
});

test('a pasted/dropped image resolves to its attachment path while a turn streams', async () => {
  const staged: string[] = [];
  const handlers = {
    getNativeFilePath: (file: File) => {
      const nativePath = (file as File & { path?: string }).path;
      return typeof nativePath === 'string' && nativePath.trim() ? nativePath : null;
    },
    saveInlineFile: async (file: File) => {
      staged.push(file.name);
      return '/tmp/cowork-composer-steer/staged.png';
    },
  };

  // The Finder/clipboard file that already carries a real path (paste of a
  // screenshot copied from a file manager): used as-is, never re-staged.
  const withPath = { path: STEP_IMAGE_PATH, name: 'step-screenshot.png' } as unknown as File;
  const admittedPaths: string[] = [];
  await forEachIncomingAttachmentPath([withPath], {
    ...handlers,
    onAttachment: (attachmentPath) => admittedPaths.push(attachmentPath),
  });
  assert.deepEqual(admittedPaths, [STEP_IMAGE_PATH], 'the pasted image lands in the attachment list');
  assert.deepEqual(staged, [], 'a File carrying a native path is not re-staged through the main process');

  // A clipboard file that has bytes only goes through the staging IPC.
  const clipboardOnly = { name: 'clip-image.png', type: 'image/png' } as unknown as File;
  const stagedPaths: string[] = [];
  await forEachIncomingAttachmentPath([clipboardOnly], {
    ...handlers,
    onAttachment: (attachmentPath) => stagedPaths.push(attachmentPath),
  });
  assert.deepEqual(stagedPaths, ['/tmp/cowork-composer-steer/staged.png']);
  assert.deepEqual(staged, ['clip-image.png'], 'only the path-less file is staged');

  // A file that resolves to nothing adds nothing (never a blank chip).
  await forEachIncomingAttachmentPath([{ name: 'unreadable.png' } as unknown as File], {
    getNativeFilePath: () => null,
    saveInlineFile: async () => null,
    onAttachment: (attachmentPath) => stagedPaths.push(attachmentPath),
  });
  assert.equal(stagedPaths.length, 1, 'an unresolvable file leaves the attachment list alone');
});

test('a mid-run send hands the attachment path line to onSubmit', () => {
  const label = i18nService.t('coworkInputFileLabel');
  const attachment = { path: STEP_IMAGE_PATH, name: 'step-screenshot.png' };

  const steer = composeCoworkSubmitPrompt({
    submittedValue: '  先看这张截图,别再读日志了  ',
    attachments: [attachment],
    inputFileLabel: label,
  });
  assert.equal(steer.trimmedValue, '先看这张截图,别再读日志了');
  assert.equal(
    steer.finalPrompt,
    `先看这张截图,别再读日志了\n\n${label}: ${STEP_IMAGE_PATH}`,
    'the steering prompt carries the same attachment manifest an idle send does',
  );
  assert.ok(steer.finalPrompt.includes(`${label}: ${STEP_IMAGE_PATH}`), 'the image path line reaches onSubmit');

  // Multiple attachments keep one line each, in the order they were attached.
  const multi = composeCoworkSubmitPrompt({
    submittedValue: 'two files',
    attachments: [attachment, { path: '/tmp/cowork-composer-steer/second.txt', name: 'second.txt' }],
    inputFileLabel: label,
  });
  assert.equal(
    multi.attachmentLines,
    `${label}: ${STEP_IMAGE_PATH}\n${label}: /tmp/cowork-composer-steer/second.txt`,
  );

  // Idle rules are unchanged: text alone stays untouched, attachments alone are
  // the whole prompt.
  assert.equal(
    composeCoworkSubmitPrompt({ submittedValue: ' just text ', attachments: [], inputFileLabel: label }).finalPrompt,
    'just text',
  );
  assert.equal(
    composeCoworkSubmitPrompt({ submittedValue: '', attachments: [attachment], inputFileLabel: label }).finalPrompt,
    `${label}: ${STEP_IMAGE_PATH}`,
  );
});

test('a refused mid-run submit restores the attachment together with the text', async () => {
  const attachment = { path: STEP_IMAGE_PATH, name: 'step-screenshot.png' };
  const makeFields = () => ({
    draftField: createVersionedComposerField('steer text', () => '', () => {}),
    attachmentField: createVersionedComposerField([attachment], () => [], () => {}),
  });

  // 1. The parent accepts: the composer stays cleared.
  const acceptedRun = makeFields();
  const accepted = await submitCoworkComposerDraft({
    ...acceptedRun,
    onSubmit: () => true,
  });
  assert.equal(accepted, true);
  assert.equal(acceptedRun.draftField.get(), '');
  assert.deepEqual(acceptedRun.attachmentField.get(), [], 'a taken attachment is not restored on success');

  // 2. The parent refuses (onSubmit returned false) mid-run: text AND
  //    attachment come back — this is the silent-loss case.
  const refusedRun = makeFields();
  const refused = await submitCoworkComposerDraft({
    ...refusedRun,
    onSubmit: () => false,
  });
  assert.equal(refused, false);
  assert.equal(refusedRun.draftField.get(), 'steer text');
  assert.deepEqual(refusedRun.attachmentField.get(), [attachment], 'the image survives a refused steer');

  // 3. The parent throws: same rollback, and the error still surfaces.
  const throwingRun = makeFields();
  await assert.rejects(
    submitCoworkComposerDraft({
      ...throwingRun,
      onSubmit: () => {
        throw new Error('steer channel closed');
      },
    }),
    /steer channel closed/,
  );
  assert.equal(throwingRun.draftField.get(), 'steer text');
  assert.deepEqual(throwingRun.attachmentField.get(), [attachment]);

  // 4. The rollback never clobbers text the user typed after submitting.
  const retypedRun = makeFields();
  await submitCoworkComposerDraft({
    ...retypedRun,
    onSubmit: async () => {
      retypedRun.draftField.set('typed while awaiting');
      return false;
    },
  });
  assert.equal(retypedRun.draftField.get(), 'typed while awaiting');
  assert.deepEqual(
    retypedRun.attachmentField.get(),
    [attachment],
    'the attachment field was untouched after the submit, so it still rolls back',
  );

  // Sanity: the same coordinator keeps the draft-only rollback behaviour the
  // composer relied on before this change.
  const draftField = createVersionedComposerField('draft', () => '', () => {});
  const snapshot = draftField.takeAndClear();
  assert.equal(draftField.get(), '');
  await runComposerSubmission(draftField, snapshot, () => false);
  assert.equal(draftField.get(), 'draft');
});

test('every attachment door and the submit path are wired to the one gate', () => {
  // One expression, evaluated once per render…
  assert.match(
    composerSource,
    /const attachmentAdmitted = coworkAttachmentAdmission\(\{ disabled, isStreaming, steerDisabled \}\);/,
  );
  // …and no door keeps a private `isStreaming` early return.
  assert.doesNotMatch(
    composerSource,
    /if \(disabled \|\| isStreaming\) return;/,
    'no attachment door may short-circuit on isStreaming alone',
  );
  for (const door of ['handlePaste', 'handleIncomingFiles', 'handleAddFile']) {
    assert.match(
      composerSource,
      new RegExp(`const ${door} = useCallback\\([\\s\\S]*?if \\(!attachmentAdmitted\\) return;`),
      `${door} must read the shared admission verdict`,
    );
  }
  assert.match(
    composerSource,
    /const handleDrop = \(event: React\.DragEvent<HTMLDivElement>\) => \{[\s\S]*?if \(!attachmentAdmitted\) return;\s*void handleIncomingFiles\(event\.dataTransfer\.files\);/,
    'the drop door must admit on the same verdict',
  );
  // The drag affordances agree with the drop itself.
  assert.match(composerSource, /event\.dataTransfer\.dropEffect = attachmentAdmitted \? 'copy' : 'none';/);
  assert.match(composerSource, /if \(attachmentAdmitted\) \{\s*setIsDraggingFiles\(true\);/);
  // The '+' trigger is reachable in both layouts on the same verdict, and an
  // attachment can be taken back while the run continues.
  const plusTriggers = composerSource.match(/disabled=\{!attachmentAdmitted\}/g) ?? [];
  assert.ok(plusTriggers.length >= 2, 'both composer layouts gate the + menu on the shared verdict');
  assert.match(composerSource, /removeDisabled=\{!attachmentAdmitted\}/);

  // Submit side: one composition, no text-only steering branch, and the
  // attachment snapshot is taken unconditionally.
  assert.match(composerSource, /const \{ trimmedValue, finalPrompt \} = composeCoworkSubmitPrompt\(\{/);
  assert.match(composerSource, /await submitCoworkComposerDraft\(\{/);
  assert.doesNotMatch(
    composerSource,
    /isStreaming\s*\?\s*trimmedValue/,
    'the steering branch must not compose from the text alone',
  );
  assert.doesNotMatch(
    composerSource,
    /if \(!isStreaming\) \{\s*attachmentSnapshot/,
    'the attachment field must be snapshotted for a steering submit too',
  );
});

// ---------------------------------------------------------------------------
// Part 3 — a submission needs text OR attachments, streaming as well as idle.
//
// The attachment doors opening (Part 2) was only half of "an image can steer a
// running turn": `handleSubmit` still had a text-only guard — `if (isStreaming
// && !trimmedValue) return;` — so the chip got in and send then did nothing.
// The guard is now the idle rule, and these cases pin both halves of it.
// ---------------------------------------------------------------------------

/**
 * This harness has no DOM (see the header note), so the composer's inline
 * submit guard cannot be fired by mounting. Rather than retype the rule here —
 * a copy would keep passing while the component drifted back — pull the SHIPPED
 * expression out of the component source and evaluate it. The extraction is
 * itself asserted, so a reshaped guard fails loudly instead of silently
 * weakening the test.
 */
const streamingSubmitGuardVerdict = (state: {
  isStreaming: boolean;
  trimmedValue: string;
  attachmentCount: number;
}): boolean => {
  const guard = /if \((isStreaming && !trimmedValue && submittedAttachments\.length === 0)\) return;/
    .exec(composerSource);
  assert.ok(
    guard,
    'the streaming guard must stay one expression: `if (isStreaming && !trimmedValue && submittedAttachments.length === 0) return;`',
  );
  const evaluate = new Function(
    'isStreaming',
    'trimmedValue',
    'submittedAttachments',
    `return (${guard[1]});`,
  ) as (isStreaming: boolean, trimmedValue: string, submittedAttachments: unknown[]) => boolean;
  return evaluate(state.isStreaming, state.trimmedValue, new Array(state.attachmentCount).fill(null));
};

const composerSourceIndexOf = (needle: string): number => {
  const index = composerSource.indexOf(needle);
  assert.notEqual(index, -1, `the composer source must contain: ${needle}`);
  return index;
};

test('a mid-run submission with an image but no text is admitted and reaches onSubmit', async () => {
  const label = i18nService.t('coworkInputFileLabel');
  const attachment = { path: STEP_IMAGE_PATH, name: 'step-screenshot.png' };

  // The composer body, in order: snapshot both fields → compose → guard → submit.
  const submission = composeCoworkSubmitPrompt({
    submittedValue: '',
    attachments: [attachment],
    inputFileLabel: label,
  });
  assert.equal(submission.trimmedValue, '', 'the steer carries no text at all');
  assert.equal(
    submission.finalPrompt,
    `${label}: ${STEP_IMAGE_PATH}`,
    'with no text the composed prompt IS the attachment manifest line',
  );

  assert.equal(
    streamingSubmitGuardVerdict({ isStreaming: true, trimmedValue: submission.trimmedValue, attachmentCount: 1 }),
    false,
    'an image-only steer must not be early-returned while the turn streams',
  );

  // Admitted, so it goes out: the same coordinator the composer calls.
  const run = {
    draftField: createVersionedComposerField('', () => '', () => {}),
    attachmentField: createVersionedComposerField([attachment], () => [], () => {}),
  };
  const delivered: string[] = [];
  const accepted = await submitCoworkComposerDraft({
    ...run,
    onSubmit: () => {
      delivered.push(submission.finalPrompt);
      return true;
    },
  });
  assert.equal(accepted, true);
  assert.deepEqual(
    delivered,
    [`${label}: ${STEP_IMAGE_PATH}`],
    'onSubmit receives the attachment manifest line, and nothing else',
  );
  assert.equal(run.draftField.get(), '');
  assert.deepEqual(run.attachmentField.get(), [], 'a taken attachment is cleared with the text');
});

test('a mid-run submission with neither text nor attachment is still refused', () => {
  const label = i18nService.t('coworkInputFileLabel');
  const submission = composeCoworkSubmitPrompt({
    submittedValue: '   ',
    attachments: [],
    inputFileLabel: label,
  });
  assert.equal(submission.finalPrompt, '', 'an empty steer has nothing to send');

  assert.equal(
    streamingSubmitGuardVerdict({ isStreaming: true, trimmedValue: submission.trimmedValue, attachmentCount: 0 }),
    true,
    'the empty case is still early-returned, exactly like the idle composer',
  );

  // …and the early return sits between the composition and the handover, so with
  // that verdict onSubmit is never reached and both fields stay put.
  assert.ok(
    composerSourceIndexOf('const { trimmedValue, finalPrompt } = composeCoworkSubmitPrompt({')
      < composerSourceIndexOf('if (isStreaming && !trimmedValue && submittedAttachments.length === 0) return;')
    && composerSourceIndexOf('if (isStreaming && !trimmedValue && submittedAttachments.length === 0) return;')
      < composerSourceIndexOf('await submitCoworkComposerDraft({'),
    'the guard reads the composed draft and returns before the submission is handed over',
  );
});

test('the idle branch keeps its own guard and the streaming one never decides for it', () => {
  assert.match(
    composerSource,
    /if \(!isStreaming && !trimmedValue && submittedAttachments\.length === 0\) return;/,
    'the idle guard is unchanged',
  );
  assert.equal(
    streamingSubmitGuardVerdict({ isStreaming: false, trimmedValue: '', attachmentCount: 0 }),
    false,
    'an idle submit never hits the streaming guard, attachment or not',
  );
});

// Part 3 fixed the *guard* so an image-only steer is admitted; the send/stop
// *affordance* still keyed off text alone, so the same composer rendered a Stop
// button — reaching for Send while the turn streamed actually cancelled it. The
// derived state now counts attachments as submit content on the streaming
// branch too, so the button is Send.
test('a running turn with an image but no text offers Send, not Stop', () => {
  const state = deriveCoworkPromptInputState({
    value: '',
    isStreaming: true,
    disabled: false,
    steerDisabled: false,
    attachmentCount: 1,
  });
  assert.equal(state.canSubmit, true, 'an image-only steer is clickable while the turn streams');
  assert.equal(state.showStopButton, false, 'the button is Send, not Stop — clicking it must not cancel the run');
  assert.equal(state.isSteerSubmit, true);
});
