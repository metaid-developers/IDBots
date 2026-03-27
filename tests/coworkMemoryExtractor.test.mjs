import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  extractTurnMemoryChanges,
  isQuestionLikeMemoryText,
} = require('../dist-electron/libs/coworkMemoryExtractor.js');

test('isQuestionLikeMemoryText identifies common question forms', () => {
  assert.equal(isQuestionLikeMemoryText('你是谁？'), true);
  assert.equal(isQuestionLikeMemoryText('Can you help me?'), true);
  assert.equal(isQuestionLikeMemoryText('我叫 Sunny'), false);
});

test('extractTurnMemoryChanges supports explicit add/delete commands', () => {
  const changes = extractTurnMemoryChanges({
    userText: '请记住：我叫 Sunny。\n请删除记忆：我住在上海浦东新区',
    assistantText: '收到，我会更新记忆。',
    guardLevel: 'strict',
  });

  const add = changes.find((item) => item.action === 'add' && item.text.includes('我叫 Sunny'));
  const del = changes.find((item) => item.action === 'delete' && item.text.includes('我住在上海浦东新区'));

  assert.ok(add, 'should extract explicit add');
  assert.ok(del, 'should extract explicit delete');
  assert.equal(add.isExplicit, true);
  assert.equal(del.isExplicit, true);
});

test('extractTurnMemoryChanges extracts implicit durable profile memory', () => {
  const changes = extractTurnMemoryChanges({
    userText: '我是后端工程师。我喜欢 TypeScript。',
    assistantText: '了解，我会按你的偏好协助。',
    guardLevel: 'strict',
    maxImplicitAdds: 2,
  });

  assert.ok(
    changes.some((item) => item.action === 'add' && item.text.includes('我是后端工程师') && !item.isExplicit),
    'should extract implicit personal profile memory'
  );
  assert.ok(
    changes.some((item) => item.action === 'add' && item.text.includes('我喜欢 TypeScript') && !item.isExplicit),
    'should extract implicit preference memory'
  );
});

test('extractTurnMemoryChanges respects maxImplicitAdds', () => {
  const changes = extractTurnMemoryChanges({
    userText: '我是开发者。我住在深圳。我喜欢简洁回复。',
    assistantText: '好的，我记住了。',
    guardLevel: 'relaxed',
    maxImplicitAdds: 1,
  });

  const implicitAdds = changes.filter((item) => item.action === 'add' && !item.isExplicit);
  assert.equal(implicitAdds.length, 1);
});
