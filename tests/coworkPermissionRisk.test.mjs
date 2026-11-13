import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (...segments) => fs.readFileSync(path.join(projectRoot, ...segments), 'utf8');

const runnerSource = readSource('src', 'main', 'libs', 'coworkRunner.ts');

test('coworkRunner wires low-risk auto-approval under full trust only', () => {
  const onAskStart = runnerSource.indexOf('onAskRequest: (ask) => {');
  assert.notEqual(onAskStart, -1, 'coworkRunner must register onAskRequest');
  const onAskBody = runnerSource.slice(onAskStart, runnerSource.indexOf('onAskCancelled:', onAskStart));
  assert.match(onAskBody, /permissionMode === 'bypassPermissions'/);
  assert.match(onAskBody, /tryAutoAnswerLowRiskQuestion\(\{ questions: modalQuestions \}\)/);
  assert.match(onAskBody, /hub\.respondAsk\(ask\.id, wireAnswersFromModal\(autoAnswers\)\)/);
  // Unmarked questions fall through to the interactive modal below.
  assert.ok(onAskBody.indexOf('tryAutoAnswerLowRiskQuestion') < onAskBody.indexOf("toolName: 'AskUserQuestion'"));
});

test('safety prompt tells agents about the auto-confirm marker under full trust', () => {
  assert.match(runnerSource, /Under bypassPermissions only, low-risk confirmations/);
  assert.match(runnerSource, /header "auto-confirm" to auto-approve/);
  assert.match(runnerSource, /keep high-risk confirmations unmarked/);
  // The unanswered-question semantics must be announced so models never treat
  // a timed-out (pending) ask as consent.
  assert.match(runnerSource, /pending is never approval and never an auto-picked option/);
  assert.match(runnerSource, /mark one option "\(Recommended\)" and put it first/);
});

test('low-risk marked questions auto-answer with their first option', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-risk-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const outputFile = path.join(tempDir, 'permission-risk.mjs');
  await build({
    absWorkingDir: projectRoot,
    stdin: {
      contents: `export { tryAutoAnswerLowRiskQuestion, LOW_RISK_QUESTION_HEADER } from './src/main/libs/coworkPermissionRisk.ts';`,
      resolveDir: projectRoot,
      sourcefile: 'permission-risk-entry.ts',
      loader: 'ts',
    },
    outfile: outputFile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
  });
  const { tryAutoAnswerLowRiskQuestion, LOW_RISK_QUESTION_HEADER } = await import(
    `${pathToFileURL(outputFile).href}?test=${Date.now()}`
  );

  assert.equal(LOW_RISK_QUESTION_HEADER, 'auto-confirm');

  // Single low-risk question -> auto-answer with the first option.
  assert.deepEqual(
    tryAutoAnswerLowRiskQuestion({
      questions: [{
        question: 'Delete merged branch feat/x?',
        header: 'auto-confirm',
        options: [
          { label: '删除（推荐）', description: '已合并，安全' },
          { label: '保留', description: '先不删' },
        ],
      }],
    }),
    { 'Delete merged branch feat/x?': '删除（推荐）' },
  );

  // Multiple low-risk questions -> one auto-answer per question.
  assert.deepEqual(
    tryAutoAnswerLowRiskQuestion({
      questions: [
        { question: 'Q1', header: 'auto-confirm', options: [{ label: 'A1' }, { label: 'B1' }] },
        { question: 'Q2', header: 'auto-confirm', options: [{ label: 'A2' }] },
      ],
    }),
    { Q1: 'A1', Q2: 'A2' },
  );

  // Unmarked question (normal high-risk confirmation) -> no auto-answer.
  assert.equal(
    tryAutoAnswerLowRiskQuestion({
      questions: [{
        question: 'rm -rf /tmp/x?',
        header: '安全确认',
        options: [{ label: '允许' }, { label: '拒绝' }],
      }],
    }),
    null,
  );

  // Mixed marking -> entire payload rejected (all-or-nothing).
  assert.equal(
    tryAutoAnswerLowRiskQuestion({
      questions: [
        { question: 'Q1', header: 'auto-confirm', options: [{ label: 'A1' }] },
        { question: 'Q2', header: '安全确认', options: [{ label: 'A2' }] },
      ],
    }),
    null,
  );

  // Multi-select cannot be faithfully auto-answered -> rejected.
  assert.equal(
    tryAutoAnswerLowRiskQuestion({
      questions: [{
        question: 'Which to delete?',
        header: 'auto-confirm',
        multiSelect: true,
        options: [{ label: 'a' }, { label: 'b' }],
      }],
    }),
    null,
  );

  // Empty options / missing question text -> rejected.
  assert.equal(
    tryAutoAnswerLowRiskQuestion({ questions: [{ header: 'auto-confirm', options: [] }] }),
    null,
  );
  assert.equal(
    tryAutoAnswerLowRiskQuestion({ questions: [{ question: '', header: 'auto-confirm', options: [{ label: 'x' }] }] }),
    null,
  );
  assert.equal(tryAutoAnswerLowRiskQuestion({}), null);
  assert.equal(tryAutoAnswerLowRiskQuestion(null), null);
  assert.equal(tryAutoAnswerLowRiskQuestion('nope'), null);
});

test('non-destructive safety gates default an unanswered prompt to allow (owner ruling 2026-11-13)', () => {
  // 2026-11-13 session aaee4df7: the chain-upload gate rendered with the
  // delete-class chrome ("此操作将删除文件" / red "允许删除") and its countdown
  // defaulted to deny, so the owner declined a plain upload. Ruling: every
  // non-delete safety gate (upload / transfer / install / location) stamps
  // timeoutDefault 'allow'; only delete-class keeps fail-closed deny.
  // The deadline stamp and the watchdog follow the same per-call default…
  assert.match(runnerSource, /stampPermissionDeadline\(request, timeoutDefault\)/);
  assert.match(runnerSource, /timeoutBehavior: timeoutDefault/);
  // …a bare allow (watchdog auto-allow, text relay) counts as approved…
  assert.match(runnerSource, /if \(result\.behavior === 'allow'\) \{[\s\S]{0,80}?return 'approved';/);
  // …and the host stamps the destructive classification for the renderer.
  assert.match(runnerSource, /destructive: this\.isDeleteOperation\(requestedToolName, requestedToolInput\)/);
  // Every non-delete gate passes 'allow' to requestSafetyApproval.
  for (const toolName of ['upload_file', 'wallet_transfer', 'skill_tool', 'get_host_location']) {
    const callStart = runnerSource.indexOf(`'${toolName}',`);
    assert.notEqual(callStart, -1, `requestSafetyApproval call for ${toolName} must exist`);
    assert.match(
      runnerSource.slice(callStart, callStart + 500),
      /'allow'/,
      `${toolName} gate must stamp timeoutDefault allow`,
    );
  }
  // The delete-class gate keeps the deny default — no 'allow' argument.
  const deleteCallStart = runnerSource.indexOf('deleteQuestion,');
  assert.notEqual(deleteCallStart, -1, 'delete gate call must exist');
  const deleteCallBody = runnerSource.slice(deleteCallStart, runnerSource.indexOf(');', deleteCallStart));
  assert.doesNotMatch(deleteCallBody, /'allow'/, 'delete gate must keep the fail-closed deny default');
});

test('pickRecommendedOptionLabel prefers the explicit marker, then the first option', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-risk-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const outputFile = path.join(tempDir, 'permission-risk.mjs');
  await build({
    absWorkingDir: projectRoot,
    stdin: {
      contents: `export { pickRecommendedOptionLabel } from './src/main/libs/coworkPermissionRisk.ts';`,
      resolveDir: projectRoot,
      sourcefile: 'permission-risk-entry.ts',
      loader: 'ts',
    },
    outfile: outputFile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
  });
  const { pickRecommendedOptionLabel } = await import(
    `${pathToFileURL(outputFile).href}?test=${Date.now()}`
  );

  // Explicit "(Recommended)" marker wins over first position.
  assert.equal(
    pickRecommendedOptionLabel([{ label: '手动完整安装到工作区' }, { label: '先装核心版 (Recommended)' }]),
    '先装核心版 (Recommended)',
  );
  // Full-width parens and the Chinese marker count too.
  assert.equal(
    pickRecommendedOptionLabel([{ label: '保留' }, { label: '删除（推荐）' }]),
    '删除（推荐）',
  );
  // No marker -> the schema-mandated first option is the default.
  assert.equal(
    pickRecommendedOptionLabel([{ label: '第一种' }, { label: '第二种' }]),
    '第一种',
  );
  // Entries without a non-empty string label are skipped.
  assert.equal(
    pickRecommendedOptionLabel([{ description: 'no label' }, null, { label: '回退项' }]),
    '回退项',
  );
  // Nothing usable -> null (caller treats the question as unanswered).
  assert.equal(pickRecommendedOptionLabel([]), null);
  assert.equal(pickRecommendedOptionLabel([{ description: 'x' }]), null);
  assert.equal(pickRecommendedOptionLabel(undefined), null);
  assert.equal(pickRecommendedOptionLabel('nope'), null);
});
