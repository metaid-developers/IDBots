// Regression coverage for the 2026-10 production incident: the
// ask_user_question host tool schema declares `options` OPTIONAL per
// question, but the panel's parseQuestions dropped every question whose
// options list was empty (`if (options.length === 0) return null;`). An ask
// whose questions ALL lacked options degraded the whole panel to the
// malformed state ("请求内容无法显示", coworkApprovalUnavailableTitle) with only
// a reject button — the user never saw the question — while the tool receipt
// fabricated {selected:[], custom:'The user declined to answer.'} as if the
// user had refused to answer.
//
// The fix keeps option-less questions in parseQuestions; the wizard's
// always-rendered free-text input ("other") becomes their primary answer
// path, and coworkRunner's wireAnswersFromModal already routes
// non-option-label text into `custom`. The wire format and coworkRunner are
// deliberately NOT changed by the fix — this file pins that too.
//
// Source-assertion style (fs.readFileSync + node:test + assert.match /
// doesNotMatch) matching tests/coworkAskQuestionHang.test.mjs: the panel is
// a TSX React component, so static assertions keep this test runnable by
// plain `node --test` with no build step.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (...segments) => fs.readFileSync(path.join(projectRoot, ...segments), 'utf8');

const panelSource = readSource('src', 'renderer', 'components', 'cowork', 'CoworkPermissionPanel.tsx');
const runnerSource = readSource('src', 'main', 'libs', 'coworkRunner.ts');
const pickRecommendedSource = readSource('src', 'main', 'shared', 'pickRecommendedOption.ts');

// The DSH ask bridge normalizes absent per-question options to `options: []`
// on its way into the modal — this is how option-less questions reach the
// panel in production.
const onAskRequestBody = (() => {
  const start = runnerSource.indexOf('onAskRequest: (ask) => {');
  assert.notEqual(start, -1, 'coworkRunner must register onAskRequest');
  const end = runnerSource.indexOf('onAskCancelled:', start);
  assert.notEqual(end, -1);
  return runnerSource.slice(start, end);
})();

const wireAnswersBody = (() => {
  // The arrow's parameters wrapped onto their own line (formatting drift);
  // match the declaration, not the first parameter (2026-11-13: this needle
  // went stale on main and the suite was red before any of this branch's
  // edits — absorbed here so the permission-semantics suites run green).
  const start = runnerSource.indexOf('const wireAnswersFromModal = (');
  assert.notEqual(start, -1, 'coworkRunner must define wireAnswersFromModal');
  const end = runnerSource.indexOf('// Full-trust parity', start);
  assert.notEqual(end, -1);
  return runnerSource.slice(start, end);
})();

test('parseQuestions keeps option-less questions instead of dropping them', () => {
  // The defect line is gone — no options-based drop may return (in any
  // spelling of the old guard).
  assert.doesNotMatch(panelSource, /options\.length === 0/);
  assert.doesNotMatch(panelSource, /if \(options\.length === 0\) return null;/);
  // Positive shape: the options ternary ends with `: [];` and the question
  // item is returned unconditionally right after (only comments in between).
  assert.match(
    panelSource,
    /\.filter\(Boolean\) as QuestionOption\[\]\s*: \[\];[\s\S]{0,400}?return \{\s*question: record\.question,/,
  );
  // The DSH bridge really does forward `options: []` for option-less asks,
  // so the panel MUST tolerate them (the 2026-10 incident payload).
  assert.match(onAskRequestBody, /Array\.isArray\(q\.options\) \? \{ options: q\.options \} : \{ options: \[\] \}/);
});

test('entries without question text are still dropped and the malformed fallback survives', () => {
  // A question with no text at all is still dropped…
  assert.match(
    panelSource,
    /if \(!record \|\| typeof record\.question !== 'string' \|\| !record\.question\.trim\(\)\) return null;/,
  );
  // …and so are non-array question payloads.
  assert.match(panelSource, /if \(!Array\.isArray\(rawQuestions\)\) return \[\];/);
  // The genuine fallback (no usable questions at all) stays: degraded
  // deny-only card instead of a null render wedging the permission queue.
  assert.match(
    panelSource,
    /const isMalformedQuestion = isAskRequest && !isSafetyApproval && questions\.length === 0;/,
  );
  assert.match(panelSource, /coworkApprovalUnavailableTitle/);
  assert.match(panelSource, /onClick=\{handleDeny\}/);
});

test('the wizard renders option-less questions with the free-text input as the answer path', () => {
  // An option-less ask is a question request (wizard), not a malformed one.
  assert.match(
    panelSource,
    /const isQuestionRequest = isAskRequest && !isSafetyApproval && questions\.length > 0;/,
  );
  // Nothing in the wizard may gate on the presence of options — the input,
  // completion and submit paths must all work with zero options.
  assert.doesNotMatch(panelSource, /currentQuestion\.options\.length/);
  // The free-text input binds unconditionally inside the wizard branch…
  assert.match(panelSource, /value=\{otherInputs\[currentStep\] \?\? ''\}/);
  // …and counts as an answer for both the current step and the whole set.
  assert.match(panelSource, /otherInputs\[currentStep\]\?\.trim\(\)/);
  assert.match(panelSource, /otherInputs\[index\]\?\.trim\(\)/);
  // Submit merges free text into finalAnswers for single-select…
  assert.match(panelSource, /finalAnswers\[question\.question\] = customValue\.trim\(\);/);
  // …and multiSelect (zero options ⇒ the custom value is the whole answer,
  // joined exactly like any other segment).
  assert.match(panelSource, /finalAnswers\[question\.question\] = \[\.\.\.selected, customValue\.trim\(\)\]\.join\('\|\|\|'\);/);
});

test('option-less questions with safety context take the wizard, never the safety branch', () => {
  // parseQuestions now emits option-less questions, and handleApprove's
  // safety branch dereferences questions[0].options[0].label — a safety
  // approval therefore requires a usable allow option (host-built safety
  // asks always carry both fixed options). A crafted context plus
  // option-less questions must fall through to the answerable wizard.
  assert.match(
    panelSource,
    /const isSafetyApproval = safetyContext !== null\s*&& questions\.length > 0\s*&& questions\[0\]\.options\.length > 0;/,
  );
  assert.match(panelSource, /const allowOption = safetyQuestion\.options\[0\];/);
});

test('the wire format in coworkRunner is unchanged — declined-to-answer only on real rejection paths', () => {
  // Free-form (non-option-label) text routes into custom — already the
  // documented behavior the plan-mode review loop relies on; option-less
  // answers ride the same path.
  assert.match(wireAnswersBody, /if \(labels\.has\(segment\)\) selected\.push\(segment\);/);
  assert.match(wireAnswersBody, /else customParts\.push\(segment\);/);
  // "Declined to answer" is fabricated ONLY when the modal answer for a
  // question is absent/empty (explicit skip)…
  assert.match(
    wireAnswersBody,
    /if \(typeof raw !== 'string' \|\| raw\.trim\(\)\.length === 0\) \{[\s\S]{0,400}?custom: 'The user declined to answer\.',/,
  );
  // …or when the whole ask was denied (behavior !== 'allow').
  assert.match(
    runnerSource,
    /if \(result\.behavior !== 'allow'\) \{[\s\S]{0,400}?custom: 'The user declined to answer\.',/,
  );
  // Exactly those two fabrication sites exist in the wire path — no new
  // fabrication site may appear.
  const declinedCount = runnerSource.split("custom: 'The user declined to answer.'").length - 1;
  assert.equal(
    declinedCount,
    2,
    `wire path must fabricate 'declined to answer' in exactly 2 places (empty answer + deny), found ${declinedCount}`,
  );
});

test('a timed option-less question is skipped honestly, never auto-answered', () => {
  // pickRecommendedOptionLabel returns null when no usable option exists,
  // so the per-question timeout marks the question skipped (which wires as
  // an explicit declined answer) instead of fabricating a selection.
  assert.match(pickRecommendedSource, /if \(labels\.length === 0\) \{\s*return null;\s*\}/);
  assert.match(pickRecommendedSource, /the caller must treat that question as unanswered/);
});
