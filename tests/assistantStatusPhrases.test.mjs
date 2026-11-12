import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ASSISTANT_CONTINUE_POOLS,
  ASSISTANT_COORDINATE_POOLS,
  ASSISTANT_DIGEST_POOLS,
  ASSISTANT_PROJECTED_POOLS,
  ASSISTANT_RESUME_POOLS,
  ASSISTANT_RETRY_LEAD_POOLS,
  ASSISTANT_THINKING_POOLS,
  ASSISTANT_WORK_POOLS,
  ASSISTANT_WRITING_POOLS,
  buildRetryStatusLine,
  describeToolUseStatus,
  drawAssistantStatusPhrase,
  formatWaitSuffix,
  findCurrentTurnProjection,
  isResumeSpliceContent,
  resetAssistantStatusDrawing,
} from '../src/renderer/components/cowork/assistantStatusPhrases.ts';

const LANGS = ['zh', 'en'];

// ---------------------------------------------------------------------------
// Pools — sizes and hygiene. Owner ruling 2026-11-11 (session b817372f): NO
// timer rotation, so pools are small and STABLE per phase instance; every
// state carries only words that state can honestly say.
// ---------------------------------------------------------------------------

const NEUTRAL_POOLS = {
  thinking: ASSISTANT_THINKING_POOLS,
  writing: ASSISTANT_WRITING_POOLS,
  retryLead: ASSISTANT_RETRY_LEAD_POOLS,
  work: ASSISTANT_WORK_POOLS,
  coordinate: ASSISTANT_COORDINATE_POOLS,
  projected: ASSISTANT_PROJECTED_POOLS,
  digest: ASSISTANT_DIGEST_POOLS,
  resume: ASSISTANT_RESUME_POOLS,
  continue: ASSISTANT_CONTINUE_POOLS,
};

test('status pools: both languages, 2-8 phrases, no duplicates, no blanks', () => {
  for (const [name, pool] of Object.entries(NEUTRAL_POOLS)) {
    for (const lang of LANGS) {
      const phrases = pool[lang];
      assert.ok(phrases.length >= 2 && phrases.length <= 8, `${name}/${lang} has 2-8 phrases, got ${phrases.length}`);
      assert.equal(new Set(phrases).size, phrases.length, `${name}/${lang} has no duplicate phrases`);
      for (const phrase of phrases) {
        assert.ok(phrase.trim().length > 0, `${name}/${lang} phrases are non-blank`);
      }
    }
  }
});

// THE regression guard for the mechanical-rotation complaint: completion /
// warm-up wording may ONLY live in the writing pool (visible text actually
// streaming). Session b817372f showed "马上就好/热身/蓄力" looping mid-work.
test('completion and warm-up words are banned outside the writing pool', () => {
  const banned = ['马上就好', '就好', '一小会儿', '热身', '蓄力', 'almost there', 'just a little longer', 'warming up', 'gearing up'];
  for (const [name, pool] of Object.entries(NEUTRAL_POOLS)) {
    if (name === 'writing') continue;
    for (const lang of LANGS) {
      for (const phrase of pool[lang]) {
        const lower = phrase.toLowerCase();
        for (const word of banned) {
          assert.ok(!lower.includes(word), `${name}/${lang} must not carry "${word}" (found in: ${phrase})`);
        }
      }
    }
  }
  // And the writing pool DOES own the wrap-up wording.
  assert.ok(ASSISTANT_WRITING_POOLS.zh.some((p) => p.includes('收尾')));
});

// ---------------------------------------------------------------------------
// drawAssistantStatusPhrase — stability + no back-to-back repeats
// ---------------------------------------------------------------------------

test('drawAssistantStatusPhrase: one stable phrase per key across re-renders', () => {
  resetAssistantStatusDrawing(undefined, true);
  const first = drawAssistantStatusPhrase({ key: 'k1', bagScope: 's', pool: ASSISTANT_THINKING_POOLS.zh, language: 'zh' });
  for (let i = 0; i < 20; i++) {
    assert.equal(drawAssistantStatusPhrase({ key: 'k1', bagScope: 's', pool: ASSISTANT_THINKING_POOLS.zh, language: 'zh' }), first);
  }
  // A different phase instance re-rolls.
  const other = drawAssistantStatusPhrase({ key: 'k2', bagScope: 's', pool: ASSISTANT_THINKING_POOLS.zh, language: 'zh' });
  assert.equal(typeof other, 'string');
  resetAssistantStatusDrawing(undefined, true);
});

test('drawAssistantStatusPhrase: a shared bag of N draws N distinct phrases before any repeat', () => {
  resetAssistantStatusDrawing(undefined, true);
  const pool = ASSISTANT_PROJECTED_POOLS.zh;
  const seen = new Set();
  for (let i = 0; i < pool.length; i++) {
    seen.add(drawAssistantStatusPhrase({ key: `bag-${i}`, bagScope: 'bagtest', pool, language: 'zh' }));
  }
  assert.equal(seen.size, pool.length, 'one full bag cycle never repeats');
  resetAssistantStatusDrawing(undefined, true);
});

test('projection status belongs to the current owner turn and requires success', () => {
  const projection = (id) => ({ type: 'tool_use', metadata: { toolName: 'bot_browser_preview_local', toolUseId: id } });
  const result = (id, isError = false) => ({ type: 'tool_result', metadata: { toolUseId: id, isError } });
  const user = (origin = 'user') => ({ type: 'user', metadata: { origin } });
  assert.equal(findCurrentTurnProjection([projection('old'), result('old'), user()]), null, 'a previous turn never describes the current Live Stage');
  assert.equal(findCurrentTurnProjection([projection('failed'), result('failed', true)]), null, 'a failed projection is not on screen');
  assert.equal(findCurrentTurnProjection([projection('pending')]), null, 'an unanswered call is still projecting, not projected');
  assert.equal(findCurrentTurnProjection([user(), projection('current'), result('current')]), 'current');
  assert.equal(findCurrentTurnProjection([
    projection('current'), result('current'),
    { type: 'user', metadata: { origin: 'cross_session' } },
  ]), 'current', 'worker receipts do not reset the owner turn');
});

// ---------------------------------------------------------------------------
// describeToolUseStatus — event-derived specific lines per tool category
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

test('describeToolUseStatus: coordination tools get delegation wording, not generic tool copy', () => {
  // Session b817372f 01:46: local_worker_delegate + twin_task_status fell to
  // the generic pool before the category existed.
  assert.equal(describeToolUseStatus('local_worker_delegate', { workerMetabotId: 15 }, 'zh'), '正在委派 Bot 协作…');
  assert.equal(describeToolUseStatus('twin_task_create', {}, 'zh'), '正在委派 Bot 协作…');
  assert.equal(describeToolUseStatus('twin_task_status', { taskId: 'e0d953e2' }, 'zh'), '正在跟进协作进度…');
  assert.equal(describeToolUseStatus('local_worker_delegate', {}, 'en'), 'Delegating to a partner bot…');
  assert.equal(describeToolUseStatus('task', {}, 'zh'), '正在派遣分身协作…');
});

test('describeToolUseStatus: projection and browser tools get screen wording', () => {
  assert.equal(describeToolUseStatus('bot_browser_preview_local', { path: '/tmp/report.html' }, 'zh'), '正在投屏到大屏…');
  assert.match(describeToolUseStatus('bot_browser_screenshot', { tabId: 1 }, 'zh'), /截屏核对/);
  assert.match(describeToolUseStatus('mcp__playwright-mcp__browser_navigate', { url: 'https://x.dev' }, 'zh'), /正在操作浏览器/);
  assert.equal(describeToolUseStatus('bot_browser_preview_local', {}, 'en'), 'Projecting to the big screen…');
});

test('describeToolUseStatus: session/web/memory/todo/onchain surfaces', () => {
  assert.match(describeToolUseStatus('conversation_search', { query: '10 月版 BP' }, 'zh'), /正在翻找会话：10 月版 BP/);
  assert.match(describeToolUseStatus('idbots_session_read_latest', { sessionId: 'abc' }, 'zh'), /正在翻找会话/);
  assert.match(describeToolUseStatus('web_search', { query: 'glm-5.3 effort' }, 'zh'), /正在网上查：glm-5\.3 effort/);
  assert.equal(describeToolUseStatus('todo_write', {}, 'zh'), '正在更新任务清单');
  assert.match(describeToolUseStatus('memory_search', {}, 'zh'), /记忆和知识库/);
  assert.match(describeToolUseStatus('omni_read', { action: 'indexer_stats' }, 'zh'), /链上数据/);
  assert.match(describeToolUseStatus('owner_update', {}, 'zh'), /汇报进展/);
});

test('describeToolUseStatus: unknown tools fall back to the object, then null', () => {
  assert.equal(describeToolUseStatus('exotic_tool', { target: 'some-object' }, 'zh'), '正在处理：some-object');
  assert.equal(describeToolUseStatus('exotic_tool', {}, 'zh'), null);
  assert.equal(describeToolUseStatus('', {}, 'zh'), null);
});

// ---------------------------------------------------------------------------
// isResumeSpliceContent — the runner's auto-resume frame, not a human reply
// ---------------------------------------------------------------------------

test('isResumeSpliceContent: matches the interruption splice, not ordinary replies', () => {
  assert.ok(isResumeSpliceContent('The previous turn was interrupted by a transient network or provider failure. Continue the task from where you left off.'));
  assert.ok(isResumeSpliceContent('Provider hiccup — continue the task from where you left off.'));
  assert.equal(isResumeSpliceContent('好的，继续做 11 月版本'), false);
  assert.equal(isResumeSpliceContent(''), false);
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
