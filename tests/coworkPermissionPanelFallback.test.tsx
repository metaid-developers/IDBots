import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import CoworkPermissionPanel, {
  parseQuestions,
  parseSafetyContext,
} from '../src/renderer/components/cowork/CoworkPermissionPanel';
import { i18nService } from '../src/renderer/services/i18n';

/**
 * F-17a component coverage for the permission panel's payload handling:
 * (1) the standard permission card, (2) the structured question wizard (real
 * incident payload shape), (3) the unknown/undecodable fallback card which
 * must keep BOTH Allow and Deny available — never a deny-only dead end.
 * Semantics note: since PR #103 (965d6e50) option-less questions answer
 * through the wizard's free-text input, so the fallback card is reserved for
 * payloads with NO question left at all; gateway-crushed sentinel options
 * are dropped, never rendered as clickable choices.
 */

const requestId = 'req-f17a';

function panel(toolName: string, toolInput: Record<string, unknown>): JSX.Element {
  return (
    <CoworkPermissionPanel
      permission={{ requestId, toolName, toolInput, perQuestionTimeoutMs: null } as never}
      onRespond={() => undefined}
    />
  );
}

test('standard permission payload renders the action card with Allow and Deny', () => {
  const markup = renderToStaticMarkup(panel('Bash', {
    command: 'npm install lodash',
    description: 'Install dependency',
  }));
  assert.ok(markup.includes(i18nService.t('coworkApprovalAllowOnce')), 'allow rendered');
  assert.ok(markup.includes(i18nService.t('coworkDeny')), 'deny rendered');
  assert.ok(markup.includes('npm install lodash'), 'input summary rendered');
});

test('structured question (real 迁轎 incident shape: id + multi_select aliases) keeps the wizard', () => {
  const toolInput = {
    questions: [{
      id: 'confirm_create',
      header: '确认入职',
      question: '这张卡可以照着建吗？',
      multi_select: false,
      detail: '建完他会是一个独立的本地 Worker Bot。',
      options: [
        { label: '就这个（推荐）', description: '按现在的名字、人格、火箭头像创建。' },
        { label: '名字换一个', description: '保留人格和头像。' },
      ],
    }],
  };
  const parsed = parseQuestions({ toolName: 'AskUserQuestion', toolInput } as never);
  assert.equal(parsed.length, 1, 'the incident payload parses to one question');
  assert.equal(parsed[0].multiSelect, false);
  const markup = renderToStaticMarkup(panel('AskUserQuestion', toolInput));
  assert.ok(markup.includes('这张卡可以照着建吗？'), 'question text rendered');
  assert.ok(markup.includes('就这个（推荐）'), 'first option rendered');
  assert.ok(markup.includes('名字换一个'), 'second option rendered');
  assert.ok(markup.includes(i18nService.t('coworkApprovalUnavailableTitle')) === false, 'no malformed fallback');
});

test('string-only option entries still produce a question instead of the malformed card', () => {
  const parsed = parseQuestions({
    toolName: 'AskUserQuestion',
    toolInput: { questions: [{ question: 'Pick a lane?', options: ['Fast path', 'Slow path'] }] },
  } as never);
  assert.equal(parsed.length, 1);
  assert.deepEqual(parsed[0].options.map((option) => option.label), ['Fast path', 'Slow path']);
});

test('crushed sentinel options never render as choices — the question stays answerable via free text', () => {
  // Byte-level outcome of the old gateway depth crush: every option object
  // arrives as the string '[truncated-depth]'. Semantics evolution since the
  // F-17a snapshot: parseQuestions drops sentinel labels (unreadable content,
  // never clickable choices) while the question itself survives — options are
  // per-question optional and PR #103 (965d6e50) routes option-less
  // questions through the wizard's free-text input instead of the malformed
  // fallback card. The protective intent stands: the broken payload is
  // visible as a question, and BOTH answering and denying stay available.
  const crushed = {
    questions: [{
      id: 'confirm_create',
      question: '这张卡可以照着建吗？',
      options: ['[truncated-depth]', '[truncated-depth]', '[truncated-depth]'],
    }],
  };
  const parsed = parseQuestions({ toolName: 'AskUserQuestion', toolInput: crushed } as never);
  assert.equal(parsed.length, 1, 'the question survives the crush');
  assert.deepEqual(parsed[0].options, [], 'sentinel labels are dropped, not offered as choices');
  const markup = renderToStaticMarkup(panel('AskUserQuestion', crushed));
  assert.ok(markup.includes('这张卡可以照着建吗？'), 'question text rendered');
  assert.ok(!markup.includes('[truncated-depth]'), 'crushed sentinel never rendered as a choice');
  assert.ok(markup.includes(i18nService.t('coworkApprovalUnavailableTitle')) === false, 'not the malformed fallback');
  assert.ok(markup.includes(i18nService.t('coworkQuestionWizardOtherPlaceholder')), 'free-text answer path present');
  assert.ok(markup.includes(i18nService.t('coworkQuestionSkipThis')), 'Skip available');
  assert.ok(markup.includes(i18nService.t('coworkDeny')), 'Deny available');
  assert.ok(markup.includes(i18nService.t('coworkQuestionWizardSubmit')), 'Submit available');
});

test('questions with no usable options drop into the fallback, empty questions never break the card', () => {
  const zero = parseQuestions({ toolName: 'AskUserQuestion', toolInput: { questions: [] } } as never);
  assert.deepEqual(zero, []);
  const markup = renderToStaticMarkup(panel('AskUserQuestion', { questions: [] }));
  assert.ok(markup.includes(i18nService.t('coworkApprovalUnavailableTitle')));
  assert.ok(markup.includes(i18nService.t('coworkApprovalAllowOnce')));
});

/**
 * 2026-11-13 aaee4df7 incident regression: the chain-upload gate's question
 * ("…是否允许本次上传？") never reached the screen — every safety approval
 * rendered the hardcoded title "此操作将删除文件" with a red "允许删除" allow
 * button, so the owner read a plain upload as a deletion request and declined
 * it. Safety approvals must render the HOST'S question, and the destructive
 * red chrome is reserved for host-stamped delete-class gates.
 */
const uploadGatePayload = {
  questions: [
    {
      header: '安全确认',
      question: 'Agent 将把工作区之外的以下文件上传上链公开发布（不可撤销）：\n- /tmp/video.mp4\n是否允许本次上传？',
      options: [
        { label: '允许本次操作', description: '仅允许当前这一次操作继续执行。' },
        { label: '拒绝本次操作', description: '拒绝当前操作。' },
      ],
    },
  ],
  answers: {},
  context: {
    requestedToolName: 'upload_file',
    requestedToolInput: { files: ['/tmp/video.mp4'] },
    destructive: false,
  },
};

const deleteGatePayload = {
  questions: [
    {
      header: '安全确认',
      question: '工具 "bash" 将执行删除操作。根据安全策略，删除必须人工确认。是否允许本次操作？',
      options: [
        { label: '允许本次操作', description: '仅允许当前这一次操作继续执行。' },
        { label: '拒绝本次操作', description: '拒绝当前操作。' },
      ],
    },
  ],
  answers: {},
  context: {
    requestedToolName: 'bash',
    requestedToolInput: { command: 'rm -rf ./dist' },
    destructive: true,
  },
};

test('non-destructive safety approval renders the real gate question with the plain allow-once button', () => {
  const markup = renderToStaticMarkup(panel('AskUserQuestion', uploadGatePayload));
  assert.ok(markup.includes('是否允许本次上传'), 'the host question is the visible title');
  assert.ok(!markup.includes('此操作将删除文件'), 'no hardcoded delete title on an upload approval');
  assert.ok(markup.includes(i18nService.t('coworkApprovalAllowOnce')), 'allow-once label for a non-destructive gate');
  assert.ok(!markup.includes(i18nService.t('coworkApprovalAllowDelete')), 'no allow-delete label on an upload approval');
  assert.ok(!markup.includes('bg-red-600'), 'no destructive red allow button on an upload approval');
  assert.ok(markup.includes('upload_file'), 'requested tool name still disclosed');
});

test('delete-class safety approval keeps the destructive allow-delete chrome', () => {
  const markup = renderToStaticMarkup(panel('AskUserQuestion', deleteGatePayload));
  assert.ok(markup.includes('是否允许本次操作'), 'the host question is the visible title');
  assert.ok(markup.includes(i18nService.t('coworkApprovalAllowDelete')), 'allow-delete label for a delete-class gate');
  assert.ok(markup.includes('bg-red-600'), 'destructive red allow button for a delete-class gate');
});

test('parseSafetyContext surfaces the host destructive classification', () => {
  const upload = parseSafetyContext({ toolName: 'AskUserQuestion', toolInput: uploadGatePayload } as never);
  assert.equal(upload?.destructive, false, 'upload gate classified non-destructive');
  const del = parseSafetyContext({ toolName: 'AskUserQuestion', toolInput: deleteGatePayload } as never);
  assert.equal(del?.destructive, true, 'bash rm classified destructive');
  const legacy = parseSafetyContext({
    toolName: 'AskUserQuestion',
    toolInput: { questions: [{ question: 'q?', options: [{ label: 'a' }] }], answers: {}, context: { requestedToolName: 'x', requestedToolInput: {} } },
  } as never);
  assert.equal(legacy?.destructive, false, 'payloads without the stamp degrade to non-destructive');
});
