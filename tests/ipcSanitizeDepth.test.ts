import test from 'node:test';
import assert from 'node:assert/strict';
import {
  IPC_MAX_DEPTH,
  sanitizeIpcPayload,
} from '../src/main/ipc/sanitize';

/**
 * F-17a regression: the gateway event fan-out re-sanitizes payloads main
 * already sanitized, adding extra wrapper levels. The ask_user_question
 * permission payload is the deepest known family — its options[].label /
 * description must survive BOTH relay shapes. On the previous cap (6) the
 * gateway pass crushed every option object into the string
 * '[truncated-depth]', the mobile panel parsed zero questions and rendered
 * the unanswerable "Request unavailable" card for the 2026-10-28 阿燃 flow.
 */

const askQuestion = {
  id: 'confirm_create',
  header: '确认入职',
  question: '这张卡可以照着建吗？',
  multi_select: false,
  detail: '名字和人格是我按你给的方向定的。',
  options: [
    { label: '就这个（推荐）', description: '按现在的名字、人格、火箭头像创建。' },
    { label: '名字换一个', description: '保留人格和头像。' },
    { label: '头像换一个', description: '再挑一个图。' },
  ],
};

test('gateway permission event keeps option objects under the depth cap', () => {
  const frameArgs = [{
    sessionId: '64c3d955-85fd-4f0f-87bc-f752d34f9f56',
    request: {
      requestId: 'ask-mvro4h1f-1',
      toolName: 'AskUserQuestion',
      toolInput: { questions: [askQuestion] },
      perQuestionTimeoutMs: null,
    },
  }];
  const [arg] = frameArgs.map((entry) => sanitizeIpcPayload(entry)) as [Record<string, unknown>];
  const request = arg.request as { toolInput: { questions: Array<{ options: unknown[] }> } };
  const options = request.toolInput.questions[0].options;
  assert.equal(Array.isArray(options), true, 'options array must survive event fan-out');
  for (const option of options) {
    assert.equal(typeof option, 'object', 'each option must stay an object (label reachable)');
    assert.notEqual(option, '[truncated-depth]');
  }
});

test('main-side broadcast keeps depth headroom for Long-term-board style payloads', () => {
  const request = sanitizeIpcPayload({
    requestId: 'r',
    toolName: 'AskUserQuestion',
    toolInput: { questions: [askQuestion] },
  });
  const options = (request as { toolInput: { questions: Array<{ options: unknown[] }> } })
    .toolInput.questions[0].options;
  assert.equal(typeof options[0], 'object');
});

test('the cap stays a hard bound for runaway nesting', () => {
  let needle: Record<string, unknown> = { leaf: true };
  let node: Record<string, unknown> = needle;
  for (let index = 0; index < IPC_MAX_DEPTH + 30; index += 1) {
    node = { child: {} as Record<string, unknown> };
    node.child = needle;
    needle = node;
  }
  const sanitized = sanitizeIpcPayload(node);
  assert.ok(JSON.stringify(sanitized).includes('[truncated-depth]'), 'cap still truncates deep chains');
});


test('image data URLs survive the mobile gateway while ordinary strings keep the 4000-char cap', () => {
  const image = `data:image/png;base64,${'A'.repeat(6000)}`;
  assert.equal(sanitizeIpcPayload({ image }).image, image);
  const ordinary = 'x'.repeat(6000);
  assert.notEqual(sanitizeIpcPayload({ ordinary }).ordinary, ordinary);
  const oversizedImage = `data:image/png;base64,${'A'.repeat(300_001)}`;
  assert.match(sanitizeIpcPayload({ image: oversizedImage }).image, /truncated in main IPC forwarding/);
});
