import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (...segments) => fs.readFileSync(path.join(projectRoot, ...segments), 'utf8');

const inputSource = readSource('src', 'renderer', 'components', 'cowork', 'CoworkPromptInput.tsx');
const viewSource = readSource('src', 'renderer', 'components', 'cowork', 'CoworkView.tsx');
const detailSource = readSource('src', 'renderer', 'components', 'cowork', 'CoworkSessionDetail.tsx');
const i18nSource = readSource('src', 'renderer', 'services', 'i18n.ts');

test('streaming composer derives the stop/send-steer truth table from text or quoted excerpts', async (t) => {
  assert.doesNotMatch(inputSource, /\|\| isStreaming \|\| disabled\) return/);
  assert.match(inputSource, /const hasTextInput = Boolean\(value\.trim\(\)\)/);
  // Contract change (quoted-selection reply slice): quoted transcript excerpts
  // now count as steer content, so the truth table keys off text-or-excerpts.
  assert.match(inputSource, /const hasSteerContent = hasTextInput \|\| quotedSelectionCount > 0/);
  assert.match(inputSource, /isStreaming && \(!hasSteerContent \|\| steerDisabled\)/);
  assert.match(inputSource, /isStreaming && hasSteerContent && !steerDisabled/);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-steer-ui-'));
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

  assert.deepEqual(
    deriveCoworkPromptInputState({ value: '', isStreaming: true, disabled: false, steerDisabled: false, attachmentCount: 0 }),
    { hasTextInput: false, isSteerSubmit: false, showStopButton: true, canSubmit: false },
  );
  assert.deepEqual(
    deriveCoworkPromptInputState({ value: '  adjust direction  ', isStreaming: true, disabled: false, steerDisabled: false, attachmentCount: 3 }),
    { hasTextInput: true, isSteerSubmit: true, showStopButton: false, canSubmit: true },
  );
  assert.deepEqual(
    deriveCoworkPromptInputState({ value: '', isStreaming: false, disabled: false, steerDisabled: true, attachmentCount: 1 }),
    { hasTextInput: false, isSteerSubmit: false, showStopButton: false, canSubmit: true },
  );
  assert.equal(
    deriveCoworkPromptInputState({ value: 'ignored', isStreaming: true, disabled: true, steerDisabled: false, attachmentCount: 0 }).canSubmit,
    false,
  );
  assert.deepEqual(
    deriveCoworkPromptInputState({ value: 'cannot steer', isStreaming: true, disabled: false, steerDisabled: true, attachmentCount: 0 }),
    { hasTextInput: true, isSteerSubmit: false, showStopButton: true, canSubmit: false },
  );
});

test('running composer keeps dynamic configuration disabled and composes steers through the shared quoted-prompt path', () => {
  assert.match(inputSource, /disabled=\{disabled \|\| isStreaming\}/);
  assert.match(inputSource, /coworkSteerPlaceholder/);
  // Contract change (quoted-selection reply slice): a steer no longer submits
  // `trimmedValue` alone — it composes through composeSubmittedCoworkPrompt so
  // quoted excerpts ride into the prompt body. The previous assertion here
  // pinned the plain-text branch and was updated deliberately.
  assert.doesNotMatch(inputSource, /isStreaming\s*\?\s*trimmedValue/);
  assert.match(inputSource, /const finalPrompt = composeSubmittedCoworkPrompt\(\{/);
  // A steer needs text or excerpts before anything is composed or consumed.
  assert.match(inputSource, /if \(isStreaming && !trimmedValue && submittedQuotedSelections\.length === 0\) return/);
  assert.match(inputSource, /event\.key === 'Enter'[\s\S]*?handleSubmit\(\)/);
});

test('each pending submission owns an independent versioned draft snapshot', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-steer-concurrency-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const outputFile = path.join(tempDir, 'submission-coordinator.mjs');
  await build({
    absWorkingDir: projectRoot,
    stdin: {
      contents: `export * from './src/renderer/components/cowork/coworkPromptSubmission.ts';`,
      resolveDir: projectRoot,
      sourcefile: 'submission-coordinator-entry.ts',
      loader: 'ts',
    },
    outfile: outputFile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
  });
  const { createVersionedComposerField, runComposerSubmission } = await import(
    `${pathToFileURL(outputFile).href}?test=${Date.now()}`
  );
  const deferred = () => {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
  };
  const visibleValues = [];
  const field = createVersionedComposerField('', () => '', (value) => visibleValues.push(value));
  const calls = [];

  field.set('ordinary A');
  const snapshotA = field.takeAndClear();
  const resultA = deferred();
  const pendingA = runComposerSubmission(field, snapshotA, () => {
    calls.push(snapshotA.value);
    return resultA.promise;
  });
  field.set('steer B');
  const snapshotB = field.takeAndClear();
  const resultB = deferred();
  const pendingB = runComposerSubmission(field, snapshotB, () => {
    calls.push(snapshotB.value);
    return resultB.promise;
  });
  assert.deepEqual(calls, ['ordinary A', 'steer B']);

  field.set('newer draft C');
  resultA.resolve(true);
  await pendingA;
  assert.equal(field.get(), 'newer draft C');
  resultB.resolve(false);
  await pendingB;
  assert.equal(field.get(), 'newer draft C');
  assert.equal(visibleValues.includes('ordinary A', 2), false);

  field.set('sync failure draft');
  const syncFailureSnapshot = field.takeAndClear();
  await assert.rejects(
    runComposerSubmission(field, syncFailureSnapshot, () => {
      throw new Error('sync failure');
    }),
    /sync failure/,
  );
  assert.equal(field.get(), 'sync failure draft');
});

test('a pending steer does not block the next FIFO steer submission', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-steer-fifo-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const outputFile = path.join(tempDir, 'submission-coordinator.mjs');
  await build({
    absWorkingDir: projectRoot,
    stdin: {
      contents: `export * from './src/renderer/components/cowork/coworkPromptSubmission.ts';`,
      resolveDir: projectRoot,
      sourcefile: 'submission-coordinator-entry.ts',
      loader: 'ts',
    },
    outfile: outputFile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
  });
  const { createVersionedComposerField, runComposerSubmission } = await import(
    `${pathToFileURL(outputFile).href}?test=${Date.now()}`
  );
  let resolveFirst;
  const firstResult = new Promise((resolve) => { resolveFirst = resolve; });
  const calls = [];
  const field = createVersionedComposerField('', () => '', () => {});
  field.set('steer A');
  const first = field.takeAndClear();
  const pendingFirst = runComposerSubmission(field, first, () => {
    calls.push(first.value);
    return firstResult;
  });
  field.set('steer B');
  const second = field.takeAndClear();
  const pendingSecond = runComposerSubmission(field, second, () => {
    calls.push(second.value);
    return Promise.resolve(true);
  });
  await pendingSecond;
  assert.deepEqual(calls, ['steer A', 'steer B']);
  resolveFirst(true);
  await pendingFirst;
});

test('invalidating a shared composer scope isolates the next session draft and attachments', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-steer-scope-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const outputFile = path.join(tempDir, 'submission-coordinator.mjs');
  await build({
    absWorkingDir: projectRoot,
    stdin: {
      contents: `export * from './src/renderer/components/cowork/coworkPromptSubmission.ts';`,
      resolveDir: projectRoot,
      sourcefile: 'submission-coordinator-entry.ts',
      loader: 'ts',
    },
    outfile: outputFile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
  });
  const { createVersionedComposerField, runComposerSubmission } = await import(
    `${pathToFileURL(outputFile).href}?test=${Date.now()}`
  );
  let rejectSessionA;
  const sessionAResult = new Promise((_resolve, reject) => { rejectSessionA = reject; });
  const publishedDrafts = [];
  const publishedAttachments = [];
  const draftField = createVersionedComposerField('', () => '', (value) => publishedDrafts.push(value));
  const attachmentField = createVersionedComposerField([], () => [], (value) => publishedAttachments.push(value));

  draftField.set('session A');
  attachmentField.set([{ path: '/a.txt', name: 'a.txt' }]);
  const draftA = draftField.takeAndClear();
  const attachmentsA = attachmentField.takeAndClear();
  const pendingA = runComposerSubmission(draftField, draftA, () => sessionAResult);

  draftField.invalidate();
  attachmentField.invalidate();
  draftField.set('session B');
  attachmentField.set([{ path: '/b.txt', name: 'b.txt' }]);
  const draftPublishCountBeforeFailure = publishedDrafts.length;
  const attachmentPublishCountBeforeFailure = publishedAttachments.length;

  rejectSessionA(new Error('session A failed late'));
  await assert.rejects(pendingA, /failed late/);
  assert.equal(attachmentField.restoreIfUnchanged(attachmentsA), false);
  assert.equal(draftField.get(), 'session B');
  assert.deepEqual(attachmentField.get(), [{ path: '/b.txt', name: 'b.txt' }]);
  assert.equal(publishedDrafts.length, draftPublishCountBeforeFailure);
  assert.equal(publishedAttachments.length, attachmentPublishCountBeforeFailure);

  draftField.dispose();
  draftField.set('ignored after unmount');
  assert.equal(publishedDrafts.length, draftPublishCountBeforeFailure);
});

test('strict-mode cleanup invalidates old snapshots without disabling the reused field', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-steer-strict-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const outputFile = path.join(tempDir, 'submission-coordinator.mjs');
  await build({
    absWorkingDir: projectRoot,
    stdin: {
      contents: `export * from './src/renderer/components/cowork/coworkPromptSubmission.ts';`,
      resolveDir: projectRoot,
      sourcefile: 'submission-coordinator-entry.ts',
      loader: 'ts',
    },
    outfile: outputFile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
  });
  const { createVersionedComposerField, runComposerSubmission } = await import(
    `${pathToFileURL(outputFile).href}?test=${Date.now()}`
  );
  const deferred = () => {
    let resolve;
    let reject;
    const promise = new Promise((done, fail) => {
      resolve = done;
      reject = fail;
    });
    return { promise, resolve, reject };
  };
  const published = [];
  const field = createVersionedComposerField('', () => '', (value) => published.push(value));

  field.set('session A');
  const snapshotA = field.takeAndClear();
  const resultA = deferred();
  const pendingA = runComposerSubmission(field, snapshotA, () => resultA.promise);

  // React StrictMode's simulated cleanup must invalidate, not permanently dispose, the ref.
  field.invalidate();
  field.set('session B');
  assert.equal(field.get(), 'session B');
  assert.equal(published.at(-1), 'session B');
  const publishCountBeforeAReject = published.length;
  resultA.reject(new Error('old A rejected'));
  await assert.rejects(pendingA, /old A rejected/);
  assert.equal(field.get(), 'session B');
  assert.equal(published.length, publishCountBeforeAReject);

  const snapshotB = field.takeAndClear();
  const acceptedB = await runComposerSubmission(field, snapshotB, () => Promise.resolve(false));
  assert.equal(acceptedB, false);
  assert.equal(field.get(), 'session B');
  assert.equal(published.at(-1), 'session B');

  field.set('unmount pending');
  const unmountSnapshot = field.takeAndClear();
  const unmountResult = deferred();
  const pendingUnmount = runComposerSubmission(field, unmountSnapshot, () => unmountResult.promise);
  field.invalidate();
  const publishCountAfterUnmount = published.length;
  unmountResult.resolve(false);
  await pendingUnmount;
  assert.equal(published.length, publishCountAfterUnmount);
});

test('CoworkView submits one UUID and ignores settlement from a stale session scope', () => {
  assert.match(viewSource, /submissionId:\s*crypto\.randomUUID\(\)/);
  assert.match(viewSource, /coworkService\.submitInput/);
  assert.match(viewSource, /const sessionSkillIds = isStreaming \? \[\] : \[\.\.\.activeSkillIds\]/);
  // Source now only forwards a fresh system prompt when skills are picked for
  // the turn; ordinary turns reuse the session's persisted prompt (catalog
  // drift guard, commit 5219ad49).
  assert.match(viewSource, /const systemPrompt = isStreaming \|\| sessionSkillIds\.length === 0\s*\? undefined\s*: await buildCombinedSystemPrompt\(skillPrompt\)/);
  assert.doesNotMatch(viewSource, /dispatch\(setDraftPrompt\(prompt\)\)/);
  assert.match(viewSource, /activeSessionIdRef\.current = currentSession\?\.id \?\? null/);
  assert.match(viewSource, /const submittedSessionId = currentSession\.id/);
  assert.match(viewSource, /activeSessionIdRef\.current !== submittedSessionId/);
  assert.match(viewSource, /sessionId:\s*submittedSessionId/);
  assert.match(viewSource, /setSubmitError\(null\)/);
  assert.match(viewSource, /submitErrorSessionIdRef\.current === currentSession\.id \? submitError : null/);
  assert.doesNotMatch(viewSource, /dispatch\(addMessage/);
});

test('a Stop-cancelled steer is treated as handled without restoring the draft or showing failure', () => {
  assert.match(
    viewSource,
    /if \(result\.success === false\) \{[\s\S]*?if \(result\.code === 'cancelled'\) \{[\s\S]*?submitErrorSessionIdRef\.current = null;[\s\S]*?setSubmitError\(null\);[\s\S]*?return true;/,
  );
});

test('session detail gives each composer a keyed scope and invalidates cleanup safely', () => {
  assert.match(detailSource, /<CoworkPromptInput[\s\S]*?key=\{currentSession\.id\}[\s\S]*?scopeKey=\{currentSession\.id\}/);
  assert.match(inputSource, /scopeKey\?: string/);
  assert.match(inputSource, /React\.useLayoutEffect/);
  assert.match(inputSource, /React\.useLayoutEffect\(\(\) => \(\) => \{[\s\S]*?draftFieldRef\.current\?\.invalidate\(\)[\s\S]*?attachmentFieldRef\.current\?\.invalidate\(\)/);
  assert.doesNotMatch(inputSource, /React\.useLayoutEffect\(\(\) => \(\) => \{[\s\S]*?\.dispose\(\)/);
});

test('running sandbox disables steer text and send while keeping Stop active', () => {
  assert.match(inputSource, /steerDisabled\?: boolean/);
  assert.match(inputSource, /disabled=\{disabled \|\| \(isStreaming && steerDisabled\)\}/);
  assert.doesNotMatch(inputSource, /onClick=\{handleStopClick\}[\s\S]{0,120}disabled=/);
  assert.match(detailSource, /window\.electron(?:\?|)\.cowork\?\.getSession\?\.\(currentSession\.id\)/);
  assert.match(detailSource, /if \(!isStreaming \|\| !currentSession\?\.id\) \{[\s\S]*?setLiveExecutionMode\(null\)/);
  assert.match(detailSource, /resolvedExecutionMode !== 'local'/);
  // The streaming hint row below the input was removed entirely (layout
  // space); sandbox/Local-only messaging lives in the input placeholder and
  // the typed submit-error codes instead.
  assert.doesNotMatch(detailSource, /coworkSteerSandboxUnavailableHint/);
  assert.doesNotMatch(i18nSource, /coworkSteerSandboxUnavailableHint/);
  assert.match(i18nSource, /coworkSteerSandboxUnavailablePlaceholder/);
});

test('timeline labels every honest steer state and explains the local-only boundary', () => {
  assert.match(detailSource, /interactionKind.*steer/s);
  for (const key of [
    'coworkSteerStatusQueued',
    'coworkSteerStatusDelivered',
    'coworkSteerStatusSettled',
    'coworkSteerStatusFailed',
    'coworkSteerStatusCancelled',
  ]) {
    assert.match(i18nSource, new RegExp(key));
  }
  assert.doesNotMatch(i18nSource, /MetaBot 已遵循|MetaBot followed|direction completed/i);
});

test('submission errors are localized for every typed IPC failure code', () => {
  for (const code of [
    'invalid_input',
    'session_not_found',
    'unsupported_session',
    'unsupported_execution',
    'cancelled',
    'delivery_failed',
  ]) {
    assert.match(i18nSource, new RegExp(`coworkSubmitError\\.${code}`));
  }
  assert.match(detailSource, /role="alert"/);
});

test('composer textarea has a localized right-click menu for cut/copy/paste/select-all', () => {
  // Both the large (new task) and compact (session steer) composers get the menu.
  assert.equal(inputSource.split('onContextMenu={handleTextareaContextMenu}').length - 1, 2);
  assert.match(inputSource, /role="menu"/);
  assert.match(inputSource, /runContextMenuCut/);
  assert.match(inputSource, /runContextMenuCopy/);
  assert.match(inputSource, /runContextMenuPaste/);
  assert.match(inputSource, /runContextMenuSelectAll/);
  assert.match(inputSource, /onMouseDown=\{\(event\) => event\.preventDefault\(\)\}/);
  for (const [key, zh, en] of [
    ['contextMenuCut', '剪切', 'Cut'],
    ['contextMenuCopy', '复制', 'Copy'],
    ['contextMenuPaste', '粘贴', 'Paste'],
    ['contextMenuSelectAll', '全选', 'Select All'],
  ]) {
    assert.match(i18nSource, new RegExp(`${key}: '${zh}'`));
    assert.match(i18nSource, new RegExp(`${key}: '${en}'`));
  }
});

test('composer context menu derives item availability and splices paste text', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-context-menu-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const outputFile = path.join(tempDir, 'context-menu.mjs');
  await build({
    absWorkingDir: projectRoot,
    stdin: {
      contents: `export { deriveCoworkContextMenuState } from './src/renderer/components/cowork/CoworkPromptInput.tsx';`,
      resolveDir: projectRoot,
      sourcefile: 'context-menu-entry.ts',
      loader: 'ts',
    },
    outfile: outputFile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
  });
  const { deriveCoworkContextMenuState } = await import(
    `${pathToFileURL(outputFile).href}?test=${Date.now()}`
  );

  assert.deepEqual(
    deriveCoworkContextMenuState({ valueLength: 12, selectionStart: 3, selectionEnd: 7, disabled: false }),
    { canCut: true, canCopy: true, canSelectAll: true },
  );
  assert.deepEqual(
    deriveCoworkContextMenuState({ valueLength: 12, selectionStart: 4, selectionEnd: 4, disabled: false }),
    { canCut: false, canCopy: false, canSelectAll: true },
  );
  assert.deepEqual(
    deriveCoworkContextMenuState({ valueLength: 0, selectionStart: 0, selectionEnd: 0, disabled: false }),
    { canCut: false, canCopy: false, canSelectAll: false },
  );
  assert.deepEqual(
    deriveCoworkContextMenuState({ valueLength: 12, selectionStart: 0, selectionEnd: 12, disabled: true }),
    { canCut: false, canCopy: true, canSelectAll: false },
  );

});
