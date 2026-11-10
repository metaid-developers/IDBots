import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ASSISTANT_IDLE_POOLS,
  ASSISTANT_RETRY_LEAD_POOLS,
  ASSISTANT_THINKING_POOLS,
  ASSISTANT_WORK_POOLS,
  ASSISTANT_WRITING_POOLS,
  buildRetryStatusLine,
  describeToolUseStatus,
  drawAssistantStatusPhrase,
  formatWaitSuffix,
  resetAssistantStatusDrawing,
} from '../src/renderer/components/cowork/assistantStatusPhrases.ts';

const LANGS = ['zh', 'en'];

// ---------------------------------------------------------------------------
// Pools — sizes and hygiene (owner ask: 6-10 phrases per state, no dupes)
// ---------------------------------------------------------------------------

const POOLS = {
  thinking: ASSISTANT_THINKING_POOLS,
  writing: ASSISTANT_WRITING_POOLS,
  retryLead: ASSISTANT_RETRY_LEAD_POOLS,
  work: ASSISTANT_WORK_POOLS,
  idle: ASSISTANT_IDLE_POOLS,
};

test('status pools: both languages, 6-10 phrases, no duplicates, no blank entries', () => {
  for (const [name, pool] of Object.entries(POOLS)) {
    for (const lang of LANGS) {
      const phrases = pool[lang];
      assert.ok(phrases.length >= 6 && phrases.length <= 10, `${name}/${lang} has 6-10 phrases, got ${phrases.length}`);
      assert.equal(new Set(phrases).size, phrases.length, `${name}/${lang} has no duplicate phrases`);
      for (const phrase of phrases) {
        assert.ok(phrase.trim().length > 0, `${name}/${lang} phrases are non-blank`);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// drawAssistantStatusPhrase — stability + no back-to-back repeats
// ---------------------------------------------------------------------------

test('drawAssistantStatusPhrase: one stable phrase per key across re-renders', () => {
  resetAssistantStatusDrawing(undefined, true);
  const first = drawAssistantStatusPhrase({ key: 'k1', bagScope: 's', pool: POOLS.thinking.zh, language: 'zh' });
  for (let i = 0; i < 20; i++) {
    assert.equal(drawAssistantStatusPhrase({ key: 'k1', bagScope: 's', pool: POOLS.thinking.zh, language: 'zh' }), first);
  }
  // A different phase instance re-rolls.
  const other = drawAssistantStatusPhrase({ key: 'k2', bagScope: 's', pool: POOLS.thinking.zh, language: 'zh' });
  assert.equal(typeof other, 'string');
  resetAssistantStatusDrawing(undefined, true);
});

test('drawAssistantStatusPhrase: a shared bag of 8 draws 8 distinct phrases before any repeat', () => {
  resetAssistantStatusDrawing(undefined, true);
  const pool = POOLS.thinking.zh;
  const seen = new Set();
  for (let i = 0; i < pool.length; i++) {
    seen.add(drawAssistantStatusPhrase({ key: `bag-${i}`, bagScope: 'bagtest', pool, language: 'zh' }));
  }
  assert.equal(seen.size, pool.length, 'one full bag cycle never repeats');
  resetAssistantStatusDrawing(undefined, true);
});

// ---------------------------------------------------------------------------
// describeToolUseStatus — event-derived specific lines
// ---------------------------------------------------------------------------

test('describeToolUseStatus: shell commands carry the command head', () => {
  const line = describeToolUseStatus('bash', { command: 'pdftoppm -png sheet.pdf out' }, 'zh');
  assert.match(line, /正在执行：pdftoppm -png sheet\.pdf out/);
  const long = describeToolUseStatus('bash', { command: 'x'.repeat(80) }, 'zh');
  assert.ok(long.length <= '正在执行：'.length + 32, 'command head is clipped');
  assert.match(describeToolUseStatus('pwsh', {}, 'zh'), /正在执行命令/);
});

test('describeToolUseStatus: file tools name the basename', () => {
  assert.equal(describeToolUseStatus('read', { file_path: '/a/b/c/bp-2026-11.html' }, 'zh'), '正在查看 bp-2026-11.html');
  assert.equal(describeToolUseStatus('write', { file_path: 'C:\\dir\\report.md' }, 'zh'), '正在修改 report.md');
  assert.equal(describeToolUseStatus('str_replace_editor', {}, 'zh'), '正在改写文件…');
  assert.equal(describeToolUseStatus('read', { file_path: '/a/b/kimi.png' }, 'en'), 'Reading kimi.png');
});

test('describeToolUseStatus: session/web/memory/todo/onchain/delegation surfaces', () => {
  assert.match(describeToolUseStatus('conversation_search', { query: '10 月版 BP' }, 'zh'), /正在翻找会话：10 月版 BP/);
  assert.match(describeToolUseStatus('web_search', { query: 'glm-5.3 effort' }, 'zh'), /正在网上查：glm-5\.3 effort/);
  assert.match(describeToolUseStatus('webfetch', { url: 'https://example.com/a' }, 'zh'), /正在打开网页/);
  assert.equal(describeToolUseStatus('todo_write', {}, 'zh'), '正在更新任务清单');
  assert.match(describeToolUseStatus('memory_search', {}, 'zh'), /记忆和知识库/);
  assert.match(describeToolUseStatus('omni_read', { action: 'indexer_stats' }, 'zh'), /链上数据/);
  assert.match(describeToolUseStatus('task', {}, 'zh'), /分身协作/);
  assert.match(describeToolUseStatus('owner_update', {}, 'zh'), /汇报进展/);
});

test('describeToolUseStatus: unknown tools fall back to the object, then null', () => {
  assert.equal(describeToolUseStatus('exotic_tool', { target: 'some-object' }, 'zh'), '正在处理：some-object');
  assert.equal(describeToolUseStatus('exotic_tool', {}, 'zh'), null);
  assert.equal(describeToolUseStatus('', {}, 'zh'), null);
});

// ---------------------------------------------------------------------------
// buildRetryStatusLine — the counter is the whole point
// ---------------------------------------------------------------------------

test('buildRetryStatusLine: attempt/max both render, nulls degrade gracefully', () => {
  resetAssistantStatusDrawing(undefined, true);
  const full = buildRetryStatusLine({ attempt: 3, max: 8, language: 'zh', bagKey: 'b1' });
  assert.match(full, /第 3\/8 次/);
  const attemptOnly = buildRetryStatusLine({ attempt: 5, max: null, language: 'zh', bagKey: 'b2' });
  assert.match(attemptOnly, /第 5 次/);
  assert.doesNotMatch(attemptOnly, /\/ /);
  const bare = buildRetryStatusLine({ attempt: null, max: null, language: 'zh', bagKey: 'b3' });
  assert.match(bare, /正在重试…/);
  const en = buildRetryStatusLine({ attempt: 3, max: 8, language: 'en', bagKey: 'b4' });
  assert.match(en, /attempt 3\/8/);
  resetAssistantStatusDrawing(undefined, true);
});

// ---------------------------------------------------------------------------
// formatWaitSuffix — silent under 8s, human units after
// ---------------------------------------------------------------------------

test('formatWaitSuffix: quiet for short waits, seconds then minutes', () => {
  assert.equal(formatWaitSuffix(7_999, 'zh'), '');
  assert.equal(formatWaitSuffix(8_000, 'zh'), ' · 已 8 秒');
  assert.equal(formatWaitSuffix(45_000, 'zh'), ' · 已 45 秒');
  assert.equal(formatWaitSuffix(125_000, 'zh'), ' · 已 2 分 5 秒');
  assert.equal(formatWaitSuffix(180_000, 'zh'), ' · 已 3 分钟');
  assert.equal(formatWaitSuffix(8_000, 'en'), ' · 8s');
  assert.equal(formatWaitSuffix(125_000, 'en'), ' · 2m5s');
});
