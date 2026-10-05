import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isQuestionLikeMemoryText,
  questionLikeMemoryReason,
} from '../src/main/libs/coworkMemoryExtractor.ts';

test('unambiguous questions are still rejected', () => {
  assert.equal(isQuestionLikeMemoryText('这张卡核过吗'), true);
  assert.equal(isQuestionLikeMemoryText('这个会话是哪一个?'), true);
  assert.equal(isQuestionLikeMemoryText('他到底会不会来'), true);
  assert.equal(isQuestionLikeMemoryText('这个方案是不是可行'), true);
  assert.equal(questionLikeMemoryReason('这个方案是不是可行'), 'final clause contains an A-not-A question form');
});

test('short texts opening with an interrogative are still rejected', () => {
  assert.equal(isQuestionLikeMemoryText('如何部署到生产环境'), true);
  assert.equal(isQuestionLikeMemoryText('哪个标签才是枷锁'), true);
  assert.equal(isQuestionLikeMemoryText('why did the build fail'), true);
});

test('long declarative statements containing interrogative words are accepted (2026-10-06 false-positive batch)', () => {
  // Topic framing: opens with 如何 but is an assignment/lesson, not a question.
  assert.equal(
    isQuestionLikeMemoryText('知识整合与综述写作：如何把多方输入收束成完整、承重、不失真的整体——统合不等于平均，冲突按类别处理而不被削平。'),
    false,
  );
  // Mid-sentence A-not-A inside a declarative discipline statement.
  assert.equal(
    isQuestionLikeMemoryText('核对结论前先确认取证范围覆盖最小全集：列出父目录与全部层级后再判断文件有没有缺失。'),
    false,
  );
  // Mid-sentence A-not-A inside a self-check rule.
  assert.equal(
    isQuestionLikeMemoryText('一件事需要回应而两次没有回应就是欠账：先还账，再看月亮。判断依据是对方能不能等到回复。'),
    false,
  );
  // Long判据 containing quoted A-not-A inside a multi-clause statement.
  assert.equal(
    isQuestionLikeMemoryText('说明书撰稿纪律：七份三节（天性、来历、该防的）；先出样板再铺开；来历节回源起源文档；写最强形式也写失效条件，防止把人格写成星座书。'),
    false,
  );
});

test('final-clause A-not-A still flags when the pattern carries question force', () => {
  assert.equal(isQuestionLikeMemoryText('先核账，再确认这份记录有没有过期'), true);
});

test('questionLikeMemoryReason returns specific triggers for diagnostics', () => {
  assert.equal(questionLikeMemoryReason('这张卡核过吗'), 'ends with an interrogative particle');
  assert.equal(questionLikeMemoryReason('这张卡核过吗？'), 'ends with a question mark');
  assert.equal(questionLikeMemoryReason('如何部署'), 'starts with an interrogative phrase (short text)');
  assert.equal(questionLikeMemoryReason('纯陈述。'), null);
});
