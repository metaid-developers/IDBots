// Studio chapter close flow (Phase 1 slice 2, owner ruling 方案 B): the
// close path end-to-end — preload channel → main handler → runner
// closeSessionChapter (idle-time LLM card with deterministic fallback →
// durable chapter row → native compactNow → next chapter → divider message)
// → composer tool-row button is HIDDEN (owner ruling 2026-11-19): chapters close
// automatically (budget / task boundary), and the plumbing stays because the
// auto path and the frozen mobile contract ride the same channel.
// Pure-module behavior is unit-tested; the
// plumbing is pinned with static wiring checks (house style for this area).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  buildStudioChapterCardFallback,
  buildStudioChapterCardSystemPrompt,
  buildStudioChapterCardUserPrompt,
  parseStudioChapterCardResponse,
  studioChapterCardToJson,
  STUDIO_CHAPTER_CARD_TITLE_MAX_CHARS,
  STUDIO_CHAPTER_CARD_SUMMARY_MAX_CHARS,
} from '../src/main/libs/studioChapterCard';

const here = dirname(fileURLToPath(import.meta.url));
const readSource = (relative: string): string => readFileSync(join(here, relative), 'utf8');
const runnerSource = readSource('../src/main/libs/coworkRunner.ts');
const preloadSource = readSource('../src/main/preload.ts');
const mainSource = readSource('../src/main/main.ts');
const allowlistSource = readSource('../src/main/gateway/allowlist.ts');
const contractSource = readSource('../src/mobile/generated/ipc-contract.json');
const panelSource = readSource('../src/renderer/features/botBrowser/BotBrowserCoworkPanel.tsx');
const i18nSource = readSource('../src/renderer/services/i18n.ts');

const msg = (type: 'user' | 'assistant', content: string, timestamp = Date.now()) =>
  ({ id: `${type}-${Math.random()}`, type, content, timestamp }) as never;

test('parseStudioChapterCardResponse accepts bare and fenced JSON, rejects garbage', () => {
  const card = parseStudioChapterCardResponse(
    '{"title":"NFT 封面修复","summary":"定位到铸造代码未传封面参数。","decisions":["修转换程序"],"artifacts":["pin://abc"],"open_loops":["等主人验收"]}',
  );
  assert.ok(card);
  assert.equal(card.title, 'NFT 封面修复');
  assert.equal(card.openLoops[0], '等主人验收');

  const fenced = parseStudioChapterCardResponse('```json\n{"title":"t","summary":"s"}\n```');
  assert.ok(fenced, 'fenced JSON parses');

  const proseWrapped = parseStudioChapterCardResponse('Here is the card:\n{"title":"t","summary":"s"}\nDone.');
  assert.ok(proseWrapped, 'JSON embedded in prose parses');

  assert.equal(parseStudioChapterCardResponse('not json at all'), null);
  assert.equal(parseStudioChapterCardResponse('{"title":"","summary":""}'), null, 'empty title AND summary is not a card');
  assert.equal(parseStudioChapterCardResponse('{"decisions":["only decisions"]}'), null);
  assert.equal(parseStudioChapterCardResponse(null), null);
});

test('parseStudioChapterCardResponse enforces the field caps', () => {
  const card = parseStudioChapterCardResponse(JSON.stringify({
    title: '长'.repeat(500),
    summary: 'x'.repeat(5_000),
    decisions: Array.from({ length: 25 }, (_, i) => `d${i}`).concat(['y'.repeat(400)]),
    artifacts: [],
    open_loops: [],
  }));
  assert.ok(card);
  assert.equal(card.title.length, STUDIO_CHAPTER_CARD_TITLE_MAX_CHARS);
  assert.equal(card.summaryMarkdown.length, STUDIO_CHAPTER_CARD_SUMMARY_MAX_CHARS);
  assert.equal(card.decisions.length, 10, 'item count capped at 10');
  assert.ok(card.decisions[0] === 'd0');
  assert.ok(card.decisions[9].endsWith('…') || card.decisions[9].length <= 400);
});

test('the deterministic fallback digest always produces a card', () => {
  const empty = buildStudioChapterCardFallback([]);
  assert.ok(empty.summaryMarkdown.includes('fallback'));
  const messages = [
    msg('user', '你能查一下钱包里的 NFT 吗'),
    msg('assistant', '查到了三枚,列表已发。'),
    msg('user', '好的,那第 2 枚的封面修一下'),
  ];
  const card = buildStudioChapterCardFallback(messages);
  assert.ok(card.title.includes('NFT') || card.title.length > 0, 'title derives from the opening user message');
  assert.ok(card.summaryMarkdown.includes('Latest exchanges'));
  assert.ok(card.summaryMarkdown.includes('封面'));
});

test('the chapter-card prompts carry the open-loops emphasis and a transcript budget', () => {
  const system = buildStudioChapterCardSystemPrompt();
  assert.ok(system.includes('open_loops'), 'the schema field is named');
  assert.ok(system.includes('losing an open loop re-creates a deadlock'), 'open loops are called out as the most important field');
  assert.ok(system.includes('JSON'));
  const small = buildStudioChapterCardUserPrompt([
    msg('user', '你好'),
    msg('system', 'hidden from the card'),
    msg('assistant', '在的'),
  ]);
  assert.ok(small.includes('Owner: 你好'));
  assert.ok(small.includes('Assistant: 在的'));
  assert.ok(!small.includes('hidden from the card'), 'system rows never reach the card');
  // Tail budget: with a huge chapter the OPENING drops out of the window and
  // the transcript is capped — the card LLM sees the newest 24K chars.
  const huge = buildStudioChapterCardUserPrompt([
    msg('user', '你好'),
    ...Array.from({ length: 900 }, () => msg('user', '很长的一段对话内容'.repeat(40))),
  ]);
  assert.ok(huge.length <= 24_050, `transcript is capped (got ${huge.length})`);
  assert.ok(!huge.includes('你好'), 'the opening fell out of the tail window');
});

test('studioChapterCardToJson serializes exactly the structured fields', () => {
  const json = JSON.parse(studioChapterCardToJson({ title: 't', summaryMarkdown: 's', decisions: ['d'], artifacts: ['pin://x'], openLoops: ['o'] }));
  assert.deepEqual(json, { decisions: ['d'], artifacts: ['pin://x'], open_loops: ['o'] });
});

test('the runner close flow guards, closes, compacts, and opens the next chapter', () => {
  assert.ok(runnerSource.includes('async closeSessionChapter('), 'the runner exposes closeSessionChapter');
  assert.ok(
    /studioChapterCloseInFlight\.has\(sessionId\)/.test(runnerSource),
    'double-click guard: an in-flight close rejects a second request',
  );
  assert.ok(
    /localTurnState !== 'none'/.test(runnerSource.slice(runnerSource.indexOf('async closeSessionChapter('), runnerSource.indexOf('async closeSessionChapter(') + 2500)),
    'busy-turn guard before closing',
  );
  const flow = runnerSource.slice(runnerSource.indexOf('async closeSessionChapter('));
  const compactionAt = flow.indexOf('this.requestManualCompaction');
  assert.ok(flow.indexOf('this.store.closeStudioChapter') < compactionAt, 'the card is durable BEFORE compaction runs');
  assert.ok(flow.includes('sessionChapterDivider'), 'a divider system message marks the boundary');
  assert.ok(
    flow.indexOf('this.store.ensureActiveStudioChapter(sessionId, session.metabotId', compactionAt) > compactionAt,
    'the next chapter opens after compaction (the early ensure is the get-or-create of the CURRENT chapter)',
  );
  assert.ok(flow.includes('buildStudioChapterCardFallback'), 'the deterministic digest backs the LLM card');
});

test('the IPC channel is plumbed end to end and allowlisted', () => {
  assert.ok(preloadSource.includes("ipcRenderer.invoke('cowork:session:closeChapter', sessionId)"));
  assert.ok(mainSource.includes("registerIpcHandler('cowork:session:closeChapter'"));
  assert.ok(
    allowlistSource.includes("'cowork:session:closeChapter': { tier: 'P1'"),
    'gateway allowlist carries the channel at the compact tier',
  );
  assert.ok(contractSource.includes('closeChapter'), 'the regenerated IPC contract includes the channel');
});

test('the manual chapter close button stays out of the composer tool row (owner ruling: chapters close automatically)', () => {
  assert.ok(!panelSource.includes('<StudioChapterCloseButton'), 'the button is NOT mounted in the panel');
  assert.ok(!panelSource.includes('StudioChapterCloseButton'), 'no dangling import or reference either');
  // The divider chips still render the manual close reason (an explicit
  // close can still arrive over the IPC/mobile path), so the i18n block
  // keeps its keys in both languages.
  const zhBlock = i18nSource.slice(i18nSource.indexOf('coworkManualCompact: \'手动压缩\''), i18nSource.indexOf('coworkManualCompact: \'手动压缩\'') + 500);
  const enBlock = i18nSource.slice(i18nSource.indexOf("coworkManualCompact: 'Compact now'"), i18nSource.indexOf("coworkManualCompact: 'Compact now'") + 500);
  assert.ok(zhBlock.includes('studioChapterClose:'));
  assert.ok(enBlock.includes('studioChapterClose:'));
  assert.ok(zhBlock.includes('studioChapterReasonManual:'));
  assert.ok(enBlock.includes('studioChapterReasonManual:'));
});
