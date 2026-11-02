import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  TURN_ACK_REPLY_MAX_CHARS,
  buildInstantTurnAckOpening,
  buildTurnAckReplyMessages,
  containsCjk,
  resolveTurnAckActivity,
  sanitizeTurnAckReply,
  sanitizeTurnAckReplyForInput,
} from '../src/main/libs/turnAckReply.ts';

const repoRoot = path.resolve(import.meta.dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

// ---------------------------------------------------------------------------
// Pure helpers (prompt build + sanitize)
// ---------------------------------------------------------------------------

test('buildTurnAckReplyMessages: system+user roles, title line optional, user text carried', () => {
  const withTitle = buildTurnAckReplyMessages({ userText: '帮我看下定时任务', sessionTitle: '定时任务排查' });
  assert.equal(withTitle.length, 2);
  assert.equal(withTitle[0].role, 'system');
  assert.equal(withTitle[1].role, 'user');
  assert.ok(withTitle[0].content.includes('acknowledgment'));
  assert.ok(withTitle[1].content.includes('Session title: 定时任务排查'));
  assert.ok(withTitle[1].content.includes('帮我看下定时任务'));

  const withoutTitle = buildTurnAckReplyMessages({ userText: 'hello', sessionTitle: null });
  assert.ok(!withoutTitle[1].content.includes('Session title:'));
  assert.ok(withoutTitle[1].content.includes('hello'));

  // Long input is truncated to the bounded slice, not forwarded wholesale.
  const long = buildTurnAckReplyMessages({ userText: 'x'.repeat(5000) });
  assert.ok(long[1].content.length < 1500, 'user text slice stays bounded');
});

// 2026-11-03 incident (session acb5961b): the old default template
// interpolated the user's text into an incident-report formula — "收到，我先
// 核对「你好，晚上好」的原因和处理路径" — absurd on a greeting. The instant
// opening is deliberately content-free: natural line, user language, and
// NEVER a quote or paraphrase of the user's message.
test('buildInstantTurnAckOpening: a natural content-free line in the user language, never echoing the message', () => {
  const zh = buildInstantTurnAckOpening('依然不能一键购买，点‘一键购买’报错：“购买未完成。请重试。”', 's1:1');
  assert.ok(zh.length > 0, 'always returns an opening');
  assert.ok(containsCjk(zh), 'CJK input gets a CJK line');
  assert.ok(!zh.includes('一键购买'), 'the user message is never quoted or paraphrased');
  assert.ok(!zh.includes('核对'), 'no incident-report boilerplate');
  assert.ok(zh.length <= TURN_ACK_REPLY_MAX_CHARS);

  const en = buildInstantTurnAckOpening('Fix the purchase flow', 's1:1');
  assert.ok(en.length > 0);
  assert.ok(!containsCjk(en), 'Latin input gets a Latin line');
  assert.ok(!en.includes('purchase'), 'the user message is never echoed');
});

test('buildInstantTurnAckOpening: variety across turns via the seed, stable per seed', () => {
  const seeds = ['s1:1', 's1:2', 's1:3', 's1:4', 's1:5', 's1:6'];
  const openings = new Set(seeds.map((seed) => buildInstantTurnAckOpening('帮我把这个修一下', seed)));
  assert.ok(openings.size >= 2, 'the pool actually varies across turns');
  assert.equal(
    buildInstantTurnAckOpening('帮我把这个修一下', 's1:1'),
    buildInstantTurnAckOpening('帮我把这个修一下', 's1:1'),
    'the same seed is stable (a re-emit cannot change the text)',
  );
  assert.ok(buildInstantTurnAckOpening('', 'x').length > 0, 'empty input still opens');
  const long = buildInstantTurnAckOpening(`Fix ${'x'.repeat(500)}`, 's1:1');
  assert.ok(long.length <= TURN_ACK_REPLY_MAX_CHARS + 1, 'long input never leaks into the line');
});

test('instant opening uses a local-search intent instead of a generic status', () => {
  const prompt = '这个文件好像之前申请过的，你要不搜一下本机看有没有？如果不是一个 APP 一个独立文件，而是跟账号走的，我猜大概率本机上已经有了。';
  assert.equal(resolveTurnAckActivity(prompt), 'search_local');
  assert.equal(
    buildInstantTurnAckOpening(prompt, 's1:1'),
    '我先在本机查找相关文件和信息，确认能否直接复用；找到后我会直接告诉你结果。',
  );
});

test('instant opening names the worker delivery without leaking cross-session markup or ids', () => {
  const prompt = '来自af3365c8-dfb6-4348-b350-0a0db4edbcc4 的信息：<cross_session_message trust="untrusted">[ORCH-NOTIFY] worker Builder阿码 已完成 task 46828477-0719-4984-8391-3148bec1a3fc → review，请验收；验收后向 owner 交付完整成果</cross_session_message>';
  assert.equal(resolveTurnAckActivity(prompt), 'verify_delivery');
  const opening = buildInstantTurnAckOpening(prompt, 's1:1');
  assert.match(opening, /^Builder阿码已交付一个子任务/);
  assert.match(opening, /验收结果/);
  assert.ok(!opening.includes('cross_session'));
  assert.ok(!opening.includes('46828477'));
});

test('sanitizeTurnAckReply: passes clean text through, strips wrapping noise', () => {
  assert.equal(sanitizeTurnAckReply('收到，我这就去查一下这些定时任务的来源。'), '收到，我这就去查一下这些定时任务的来源。');
  assert.equal(sanitizeTurnAckReply('"On it right away."'), 'On it right away.');
  assert.equal(sanitizeTurnAckReply('「好的，马上处理。」'), '好的，马上处理。');
  assert.equal(sanitizeTurnAckReply('```\nGot it, checking now.\n```'), 'Got it, checking now.');
  assert.equal(sanitizeTurnAckReply('line one\n   line two\t\ttabbed'), 'line one line two tabbed');
  assert.equal(sanitizeTurnAckReply('   '), '');
  assert.equal(sanitizeTurnAckReply('``````'), '');
});

test('sanitizeTurnAckReply: caps oversized output, preferring a sentence boundary', () => {
  // First sentence ends well inside the cap; trailing filler pushes past it.
  const longText = `${'word '.repeat(20)}stop here. ${'more '.repeat(60)}end.`;
  const capped = sanitizeTurnAckReply(longText);
  assert.ok(capped.length <= TURN_ACK_REPLY_MAX_CHARS + 1);
  assert.ok(capped.endsWith('.'), 'keeps the last full sentence when one fits');

  // No sentence boundary in reach: hard cap without breaking the budget.
  const boundaryless = 'a'.repeat(400);
  const hard = sanitizeTurnAckReply(boundaryless);
  assert.ok(hard.length <= TURN_ACK_REPLY_MAX_CHARS);
});

test('containsCjk: detects ideographs and kana, ignores Latin and CJK punctuation', () => {
  assert.equal(containsCjk('帮我看下定时任务'), true);
  assert.equal(containsCjk('カタカナ'), true);
  assert.equal(containsCjk('ひらがな'), true);
  assert.equal(containsCjk('hello world'), false);
  // CJK punctuation alone is not script evidence.
  assert.equal(containsCjk('。！？'), false);
  assert.equal(containsCjk(''), false);
});

test('sanitizeTurnAckReplyForInput: language guard — CJK input demands a CJK ack', () => {
  // The 2026-10-23 leak shape: CJK user text, English analysis fragment.
  assert.equal(sanitizeTurnAckReplyForInput('The user is asking about scheduled tasks.', '帮我看看定时任务'), '');
  // CJK input + Latin-only ack -> reject (template phrase takes over).
  assert.equal(sanitizeTurnAckReplyForInput('On it right away.', '帮我看看定时任务'), '');
  // CJK input + Chinese ack -> kept.
  assert.equal(
    sanitizeTurnAckReplyForInput('收到，我这就去查这些定时任务的来源。', '帮我看看定时任务'),
    '收到，我这就去查这些定时任务的来源。'
  );
  // English input + English ack -> kept (the guard must not over-fire).
  assert.equal(
    sanitizeTurnAckReplyForInput('Got it, checking the scheduled tasks now.', 'check my scheduled tasks'),
    'Got it, checking the scheduled tasks now.'
  );
});

test('sanitizeTurnAckReplyForInput: genre guard — meta-analysis markers are rejected', () => {
  // Starts with "The user" (leading wrapping quotes must not dodge it).
  assert.equal(sanitizeTurnAckReplyForInput('"The user is asking about tasks."', 'fix the bug'), '');
  assert.equal(sanitizeTurnAckReplyForInput('“The user’s message is a question.”', 'fix the bug'), '');
  // Marker phrases anywhere in the ack.
  assert.equal(sanitizeTurnAckReplyForInput("It echoes the user's message back.", 'fix the bug'), '');
  assert.equal(sanitizeTurnAckReplyForInput('This is acknowledging something in the request.', 'fix the bug'), '');
  assert.equal(sanitizeTurnAckReplyForInput('It translates as a task request.', 'fix the bug'), '');
  assert.equal(sanitizeTurnAckReplyForInput('This confirms the task, which means work starts now.', 'fix the bug'), '');
  // Plain acks with no meta-analysis still pass.
  assert.equal(sanitizeTurnAckReplyForInput('On it — checking now.', 'fix the bug'), 'On it — checking now.');
});

test('buildTurnAckReplyMessages: prompt forbids describing/analyzing/quoting the message', () => {
  const messages = buildTurnAckReplyMessages({ userText: '帮我看看定时任务' });
  assert.ok(
    messages[0].content.includes(
      "Never describe, analyze, translate, or quote the user's message; never mention what language it is in."
    ),
    'the no-meta-analysis rule is part of the system prompt'
  );
});

// ---------------------------------------------------------------------------
// Source contracts (emission wiring + gates)
// ---------------------------------------------------------------------------

test('runner: the opening bubble is emitted synchronously at the early-ack site and refined fire-and-forget', () => {
  const source = read('src/main/libs/coworkRunner.ts');

  const templateAck = source.indexOf('this.emitTurnAck(sessionId, earlyAckTier, prompt)');
  const openingEmit = source.indexOf('this.emitTurnAckOpeningBubble(');
  const refineCall = source.indexOf('void this.emitTurnAckReplyBubble(sessionId, prompt,');
  const envSyncSite = source.indexOf('await this.syncDshSkillSessionEnv(');
  assert.ok(templateAck > 0, 'the template ack still fires first (instant indicator cover)');
  assert.ok(openingEmit > templateAck, 'the opening bubble is emitted right after the template ack');
  assert.ok(refineCall > openingEmit, 'the LLM refine kicks after the opening bubble');
  assert.ok(envSyncSite > refineCall, 'the whole ack block precedes every pre-flight await on the turn path');
  // 2026-11-03 (session acb5961b): the old 250ms setTimeout lost to a 22s
  // eventloop:lag stall — the opening must be same-tick, timer-free.
  assert.ok(!source.includes('TURN_ACK_OPENING_FALLBACK_MS'), 'the fallback-timer constant is gone');
  assert.ok(!source.includes('armTurnAckOpeningFallback'), 'no opening fallback timer is armed anywhere');
  const gateWindow = source.slice(templateAck - 800, openingEmit + 200);
  assert.ok(gateWindow.includes("ackSourceChannel === 'cowork_ui'"),
    'external-facing surfaces keep their established posture (cowork_ui only)');
  assert.ok(gateWindow.includes('assistantOwnerChatForTurn'),
    'the first-sentence bubble is assistant-mode only (owner requirement 2026-11-03)');
  assert.ok(gateWindow.includes('buildInstantTurnAckOpening(prompt'),
    'the instant opening is built from the prompt at the site');
});

// 2026-10-23 first-run greeting incident (session a6194072): the greeting turn
// is host-initiated (skipInitialUserMessage — no user message in the
// transcript), yet the ack fired. Its rules ("acknowledge only, never greet,
// never answer") contradict the greeting instruction, and the free-relay
// flash model resolved the conflict by emitting its English deliberation as
// the ack bubble — the first sentence a fresh user ever saw. A turn with no
// user message has nothing to acknowledge: both the template phrase and the
// LLM bubble must be gated off.
test('runner: pure host turns stay ack-free while UI starts and persisted deliveries get an opening', () => {
  const source = read('src/main/libs/coworkRunner.ts');
  const mainSource = read('src/main/main.ts');

  const gate = source.indexOf("ackSourceChannel === 'cowork_ui' && assistantOwnerChatForTurn");
  assert.ok(gate > 0, 'the ack gate keeps pure host prompts off and admits owner-initiated starts and cross-session deliveries');
  assert.ok(source.includes('const crossSessionDelivery = /<cross_session_message\\b|\\[ORCH-NOTIFY\\]/i.test(prompt);'),
    'only an already-persisted cross-session delivery overrides skipInitialUserMessage');
  assert.ok(source.includes('assistantOwnerChatForTurn = getPersistedChatExperienceMode() === \'assistant\''),
    'the first-sentence experience is gated on the assistant chat-experience mode');
  assert.ok(source.includes('acknowledgeOwner: options.acknowledgeOwner === true'),
    'the runner carries the explicit owner-initiated flag independently of message persistence');
  assert.ok(mainSource.includes('skipInitialUserMessage: true,\n        acknowledgeOwner: true,'),
    'the UI start path marks the already-persisted human turn as owner-initiated');
  const templateAck = source.indexOf('this.emitTurnAck(sessionId, earlyAckTier, prompt)');
  const refineCall = source.indexOf('void this.emitTurnAckReplyBubble(sessionId, prompt,');
  assert.ok(gate < templateAck && gate < refineCall,
    'the gate condition wraps both the template ack and the refine call');
  assert.ok(
    source.includes('skipInitialUserMessage: Boolean(options.skipInitialUserMessage)'),
    'the ActiveSession still carries the per-turn skipInitialUserMessage flag',
  );
});

test('runner: the opening bubble is identity/serial gated, and the LLM refine updates it in place exactly once', () => {
  const source = read('src/main/libs/coworkRunner.ts');

  const emitter = source.indexOf('private emitTurnAckOpeningBubble(');
  assert.ok(emitter > 0, 'the opening emitter exists');
  const body = source.slice(emitter, source.indexOf('private emitSdkRuntimeStatus(', emitter));
  assert.ok(body.includes('this.activeSessions.get(sessionId) !== turn'),
    'an opening whose turn object is no longer the registry current is dropped (identity)');
  assert.ok(body.includes('turn.dshTurnAckSerial !== turnSerial'),
    'a stale opening superseded by a re-kick on the same object is dropped');
  assert.ok(body.includes('turn.dshTurnAckVisibleTextSeen'),
    'an opening landing after real visible text is dropped');
  assert.ok(body.includes('turn.dshTurnAckOpeningEmitted'),
    'an opening can only be emitted once');
  assert.ok(body.includes("metadata: { turnAckReply: true, isFinal: true }"),
    'the bubble is a final assistant message tagged turnAckReply');
  assert.ok(body.includes('turn.dshTurnAckOpeningMessageId = message.id'),
    'the bubble id is kept for the in-place refine');
  assert.ok(body.includes('turn.assistantOwnerUpdateCount = Math.max(1,'),
    'the host opening and model updates share one per-turn budget');
  assert.ok(!body.includes('activeSession.dshTurnAckSerial !== turnSerial'),
    'the gate must not re-read the registry object for the serial');

  const refine = source.indexOf('private async emitTurnAckReplyBubble(');
  assert.ok(refine > emitter, 'the refine follows the emitter');
  const refineBody = source.slice(refine, source.indexOf('private emitSdkRuntimeStatus(', refine));
  assert.ok(refineBody.includes('generateTurnAckReply(userPrompt, sessionTitle)'),
    'the refine rides the one-shot cognitive path with session-title context');
  assert.ok(refineBody.includes('turn.dshTurnAckModelTextSeen'),
    'a refine after the model produced visible text is dropped');
  assert.ok(refineBody.includes('turn.dshTurnAckOpeningRefined'),
    'the refine runs at most once per turn');
  assert.ok(refineBody.includes("this.emit('messageUpdate', sessionId, turn.dshTurnAckOpeningMessageId, generatedReply)"),
    'the refine REPLACES the bubble content in place — never a second bubble');

  const kick = source.indexOf('void this.emitTurnAckReplyBubble(sessionId, prompt, activeSession, turnAckSerial)');
  assert.ok(kick > 0, 'the kick passes the turn object and the kick-time serial');
  assert.ok(source.includes('activeSession.dshTurnAckOpeningEmitted = false;'),
    'a reused ActiveSession gets a fresh opening budget for each new submission');

  const onMessageSite = source.indexOf('activeSession.dshTurnAckVisibleTextSeen = true');
  assert.ok(onMessageSite > 0, 'the onMessage callback arms the visible-text gate');
  const gateSnippet = source.slice(onMessageSite - 700, onMessageSite + 100);
  assert.ok(gateSnippet.includes("type === 'assistant'"));
  assert.ok(gateSnippet.includes('isThinking'));
  assert.ok(gateSnippet.includes('messageMeta?.isStreaming !== true'),
    'a speculative streaming placeholder cannot suppress the opening');
});

test('runner: the opening text is injected into the turn prompt so the model never repeats it', () => {
  const source = read('src/main/libs/coworkRunner.ts');
  assert.ok(source.includes('<instant_ack>'), 'the anti-echo block exists');
  assert.ok(source.includes('activeSession.dshTurnAckOpeningText'),
    'the block carries the exact text the owner already received');
  assert.ok(source.includes('assistantOwnerChatForTurn && activeSession.dshTurnAckOpeningText'),
    'the injection rides the same assistant-mode gate as the bubble');
  assert.ok(source.includes('Do not repeat, rephrase, or open your reply with another acknowledgment'),
    'the block bans repeating the acknowledgment');
});

test('runner: a fresh ActiveSession restarts the ack serial at 1, so identity — not serial equality — is the cross-turn gate', () => {
  const source = read('src/main/libs/coworkRunner.ts');

  // The per-turn object is a fresh literal that does NOT initialize the serial
  // (the kick's `?? 0` then lands on 1 every turn). This pins WHY the identity
  // check above exists: turn N's in-flight ack (≤4s budget) would otherwise
  // pass turn N+1's gate after turn N settled quickly — an ack about the
  // wrong message, then a second ack from turn N+1 itself.
  const activeSessionLiteral = source.indexOf('const activeSession: ActiveSession = {');
  assert.ok(activeSessionLiteral > 0, 'the per-turn ActiveSession literal exists');
  const literalEnd = source.indexOf('};', activeSessionLiteral);
  const literal = source.slice(activeSessionLiteral, literalEnd);
  assert.ok(!literal.includes('dshTurnAckSerial'),
    'the fresh object leaves dshTurnAckSerial unset (the kick restarts it at 1)');
  assert.ok(source.includes('(activeSession.dshTurnAckSerial ?? 0) + 1'),
    'the kick bumps from undefined, i.e. every turn serial starts at 1');
});

test('coworkUtil: generateTurnAckReply is a title-class call — no thinking, no web search, tight budget, fallback brain', () => {
  const source = read('src/main/libs/coworkUtil.ts');
  const start = source.indexOf('export async function generateTurnAckReply(');
  const body = source.slice(start, source.indexOf('\n}', start) + 2);
  assert.ok(start > 0, 'generateTurnAckReply exists');
  assert.ok(body.includes("thinking: 'disabled'"), 'thinking off');
  assert.ok(body.includes("effort: 'off'"), 'effort off — an ack never waits on reasoning');
  assert.ok(body.includes('webSearch: false'), 'no server-side web_search detour');
  assert.ok(body.includes('attemptTimeoutMs: 4_000'), 'per-attempt timeout bounds the ack latency');
  assert.ok(body.includes('sanitizeTurnAckReplyForInput(result.content'), 'output goes through the input-aware sanitizer');
  // 2026-11-03 (session acb5961b): the primary relay hung and the ack died
  // with it — the refine must get the same primary+fallback pair as titles.
  assert.ok(body.includes('fallbackLlmId'), 'the fallback brain is wired like generateSessionTitle');
  assert.ok(body.includes('fallbackLlmProvider'), 'the fallback provider rides along');
});

test('coworkUtil: generateTurnAckReply drops reasoning-promoted / length-truncated acks and sizes the budget by thinking mode', () => {
  const source = read('src/main/libs/coworkUtil.ts');
  const start = source.indexOf('export async function generateTurnAckReply(');
  const body = source.slice(start, source.indexOf('\n}', start) + 2);
  assert.ok(start > 0, 'generateTurnAckReply exists');
  // F1: content promoted from reasoning_content and length-truncated
  // completions are rejected (2026-10-23 thinking-leak fix).
  assert.ok(
    body.includes("contentBlockTypes?.includes('reasoning')"),
    'reasoning-promoted content is rejected via responseMetadata'
  );
  assert.ok(body.includes("stopReason === 'length'"), 'length-truncated completions are rejected');
  // F2: thinking-aware budget — always-thinking models (glm-5.3 etc.) get
  // reasoning headroom, thinking-off models keep the tight 96.
  assert.ok(body.includes('modelAlwaysThinks('), 'the budget consults modelAlwaysThinks');
  assert.ok(body.includes('? 2048 : 96'), 'always-thinking ceiling 2048 vs thinking-off 96');
  // F3 wiring: the sanitizer runs with the user text so the language guard fires.
  assert.ok(
    body.includes('sanitizeTurnAckReplyForInput(result.content'),
    'output goes through the input-aware sanitizer'
  );
});

test('main.ts: the ack brain is wired to the Twin system brain beside the title brain', () => {
  const source = read('src/main/main.ts');
  const titleSite = source.indexOf('setSessionTitleBrainProvider(() => resolveSystemBrainOptions(');
  const ackSite = source.indexOf('setTurnAckReplyBrainProvider(() => resolveSystemBrainOptions(');
  assert.ok(titleSite > 0 && ackSite > 0, 'both brain providers are wired');
  assert.ok(Math.abs(ackSite - titleSite) < 400, 'they are wired together at startup');
});

test('renderer: the turnAckReply origin tag is part of the message metadata contract', () => {
  const types = read('src/renderer/types/cowork.ts');
  assert.ok(types.includes('turnAckReply?: boolean'),
    'the metadata type documents the host-side ack bubble');
});
