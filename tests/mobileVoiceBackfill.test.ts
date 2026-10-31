// Voice streaming backfill unit tests (voice P0, subtask #10).
//
// Covers the pure merge rules in src/mobile/app/voice/backfill.ts: CJK vs
// latin glue, partial→final replacement, abort semantics (keep finals, drop
// the trailing partial), full-clear, and caret-preserving draft composition.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  composeDraft,
  composeVoiceText,
  createBackfill,
  glueBetween,
  splitDraftAtCaret,
  voiceTextCaret,
} from '../src/mobile/app/voice/backfill.ts';

test('glueBetween: CJK boundaries take no space, latin runs take one space', () => {
  assert.equal(glueBetween('你好', '世界'), '', 'CJK+CJK');
  assert.equal(glueBetween('hello', 'world'), ' ', 'latin+latin');
  assert.equal(glueBetween('今天天气', 'nice'), '', 'CJK→latin attaches');
  assert.equal(glueBetween('say', '你好'), '', 'latin→CJK attaches');
  assert.equal(glueBetween('', 'anything'), '', 'empty left');
  assert.equal(glueBetween('anything', ''), '', 'empty right');
});

test('glueBetween: opening punctuation never takes a leading space', () => {
  assert.equal(glueBetween('done', '（注意）'), '');
  assert.equal(glueBetween('done', '"quoted"'), '');
});

test('glueBetween: trailing whitespace on the left does not double up', () => {
  assert.equal(glueBetween('word ', 'next'), ' ');
});

test('composeVoiceText joins segments and the live partial with glue rules', () => {
  assert.equal(composeVoiceText(['今天天气', '不错'], '出来走走'), '今天天气不错出来走走');
  assert.equal(composeVoiceText(['say hello', 'to the world'], ''), 'say hello to the world');
  assert.equal(composeVoiceText([], ''), '');
  assert.equal(composeVoiceText([], '正在识别'), '正在识别');
});

test('createBackfill: partial replace, final commit replaces the trailing partial', () => {
  const bf = createBackfill();
  bf.setPartial('今天天');
  assert.equal(bf.voiceText, '今天天');
  bf.setPartial('今天天气');
  assert.equal(bf.voiceText, '今天天气', 'hypothesis grows by replacement');
  bf.commitFinal('今天天气怎么样');
  assert.equal(bf.voiceText, '今天天气怎么样', 'final replaces the partial');
  assert.equal(bf.hasText, true);
});

test('createBackfill: multiple finals join; empty final does not add a segment', () => {
  const bf = createBackfill();
  bf.commitFinal('第一句');
  bf.commitFinal(''); // silence segment
  bf.commitFinal('第二句');
  assert.equal(bf.voiceText, '第一句第二句');
});

test('createBackfill: dropPartial keeps settled finals (abort path)', () => {
  const bf = createBackfill();
  bf.commitFinal('已定稿');
  bf.setPartial('写到一半');
  bf.dropPartial();
  assert.equal(bf.voiceText, '已定稿');
  assert.equal(bf.hasText, true);
});

test('createBackfill: clearAll wipes everything (cancel-all path)', () => {
  const bf = createBackfill();
  bf.commitFinal('内容');
  bf.setPartial('更多');
  bf.clearAll();
  assert.equal(bf.voiceText, '');
  assert.equal(bf.hasText, false);
});

test('createBackfill: finals are trimmed of edge whitespace', () => {
  const bf = createBackfill();
  bf.commitFinal('  spaced  ');
  assert.equal(bf.voiceText, 'spaced');
});

// ---------------------------------------------------------------------------
// splitDraftAtCaret / composeDraft / voiceTextCaret
// ---------------------------------------------------------------------------

test('splitDraftAtCaret: null/overflow carets clamp to the end', () => {
  assert.deepEqual(splitDraftAtCaret('abc', null), { before: 'abc', after: '' });
  assert.deepEqual(splitDraftAtCaret('abc', 99), { before: 'abc', after: '' });
  assert.deepEqual(splitDraftAtCaret('abc', -1), { before: 'abc', after: '' });
  assert.deepEqual(splitDraftAtCaret('abc', 1), { before: 'a', after: 'bc' });
});

test('composeDraft: empty base → just the voice text', () => {
  assert.equal(composeDraft({ before: '', after: '' }, '语音文字'), '语音文字');
});

test('composeDraft: voice text lands at the caret, base preserved around it', () => {
  assert.equal(composeDraft({ before: '前面', after: '后面' }, '插入'), '前面插入后面');
  assert.equal(composeDraft({ before: 'reply: ', after: '' }, 'okay'), 'reply: okay');
  assert.equal(composeDraft({ before: '', after: '？' }, '说点啥'), '说点啥？');
});

test('composeDraft: latin base gets one space before the voice text', () => {
  assert.equal(composeDraft({ before: 'note', after: '' }, 'appended'), 'note appended');
});

test('voiceTextCaret points right after the merged voice text', () => {
  assert.equal(voiceTextCaret({ before: '前面', after: '后面' }, '插入'), '前面插入'.length);
  assert.equal(voiceTextCaret({ before: '', after: '' }, 'abc'), 3);
});
