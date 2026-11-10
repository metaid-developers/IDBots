import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  TURN_ACK_REPLY_MAX_CHARS,
  buildDeterministicTurnAckOpening,
  buildOwnerWaitUpdateMessages,
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
  assert.ok(withTitle[0].content.includes('FIRST response'));
  assert.ok(withTitle[1].content.includes('Session title: 定时任务排查'));
  assert.ok(withTitle[1].content.includes('帮我看下定时任务'));

  const withoutTitle = buildTurnAckReplyMessages({ userText: 'hello', sessionTitle: null });
  assert.ok(!withoutTitle[1].content.includes('Session title:'));
  assert.ok(withoutTitle[1].content.includes('hello'));

  // Long input is truncated to the bounded slice, not forwarded wholesale.
  const long = buildTurnAckReplyMessages({ userText: 'x'.repeat(5000) });
  assert.ok(long[1].content.length < 1500, 'user text slice stays bounded');
});

// 2026-11-03 owner decision (session 2c70849f: "好的，这就处理。" three times
// in eight minutes): a rotating canned line is worse than no line. The
// deterministic opening is reserved for worker delivery notices — text that
// carries real information (WHO delivered, what happens next) and cannot be
// mistaken for the bot making conversation. Everything else returns '' and
// waits for the LLM first sentence.
test('buildDeterministicTurnAckOpening: empty for generic turns — no canned lines, ever', () => {
  assert.equal(buildDeterministicTurnAckOpening('依然不能一键购买，点‘一键购买’报错：“购买未完成。请重试。”'), '');
  assert.equal(buildDeterministicTurnAckOpening('帮我把这个修一下'), '');
  assert.equal(buildDeterministicTurnAckOpening('Fix the purchase flow'), '');
  assert.equal(buildDeterministicTurnAckOpening(''), '');
  assert.equal(buildDeterministicTurnAckOpening(`Fix ${'x'.repeat(500)}`), '');
});

test('buildDeterministicTurnAckOpening: search_local also waits for the LLM', () => {
  const prompt = '这个文件好像之前申请过的，你要不搜一下本机看有没有？如果不是一个 APP 一个独立文件，而是跟账号走的，我猜大概率本机上已经有了。';
  assert.equal(resolveTurnAckActivity(prompt), 'search_local');
  assert.equal(buildDeterministicTurnAckOpening(prompt), '',
    'the old search template was the same canned line every time — gone with the pool');
});

test('buildDeterministicTurnAckOpening: names the worker delivery without leaking cross-session markup or ids', () => {
  const prompt = '来自af3365c8-dfb6-4348-b350-0a0db4edbcc4 的信息：<cross_session_message trust="untrusted">[ORCH-NOTIFY] worker Builder阿码 已完成 task 46828477-0719-4984-8391-3148bec1a3fc → review，请验收；验收后向 owner 交付完整成果</cross_session_message>';
  assert.equal(resolveTurnAckActivity(prompt), 'verify_delivery');
  const opening = buildDeterministicTurnAckOpening(prompt);
  assert.match(opening, /^Builder阿码已交付一个子任务/);
  assert.match(opening, /验收结果/);
  assert.ok(!opening.includes('cross_session'));
  assert.ok(!opening.includes('46828477'));
});

test('turnAckReply: no phrase pool survives anywhere in the module', () => {
  const source = read('src/main/libs/turnAckReply.ts');
  assert.ok(!source.includes('INSTANT_OPENING_POOL'), 'the canned pools are deleted');
  assert.ok(!source.includes('pickFromPool'), 'no pool picker remains');
  // The LLM prompt now owns the human tone.
  assert.ok(source.includes('never a canned service template'),
    'the LLM ack prompt pins the human, non-boilerplate voice');
  assert.ok(source.includes('a greeting gets a greeting back'),
    'greetings are answered like a person would');
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

test('runner: the deterministic opening is same-tick and information-only; the LLM first sentence kicks fire-and-forget', () => {
  const source = read('src/main/libs/coworkRunner.ts');

  const templateAck = source.indexOf('this.emitTurnAck(sessionId, earlyAckTier, prompt)');
  const deterministicBuild = source.indexOf('const deterministicOpening = buildDeterministicTurnAckOpening(prompt);');
  const openingEmit = source.indexOf('this.emitTurnAckOpeningBubble(');
  const llmCall = source.indexOf('void this.emitTurnAckReplyBubble(sessionId, prompt,');
  const envSyncSite = source.indexOf('await this.syncDshSkillSessionEnv(');
  assert.ok(templateAck > 0, 'the template ack still fires first (instant indicator cover)');
  assert.ok(deterministicBuild > templateAck, 'the deterministic text is built after the template ack');
  assert.ok(openingEmit > deterministicBuild, 'the opening bubble emission follows the build');
  assert.ok(source.includes('if (deterministicOpening) {'),
    'generic turns emit NO deterministic bubble — only information-bearing ones');
  assert.ok(llmCall > openingEmit, 'the LLM first-sentence call kicks after the deterministic branch');
  assert.ok(envSyncSite > llmCall, 'the whole ack block precedes every pre-flight await on the turn path');
  // 2026-11-03 (session acb5961b): the old 250ms setTimeout lost to a 22s
  // eventloop:lag stall — the opening must be same-tick, timer-free.
  assert.ok(!source.includes('TURN_ACK_OPENING_FALLBACK_MS'), 'the fallback-timer constant is gone');
  assert.ok(!source.includes('armTurnAckOpeningFallback'), 'no opening fallback timer is armed anywhere');
  const gateWindow = source.slice(templateAck - 800, openingEmit + 200);
  assert.ok(gateWindow.includes("ackSourceChannel === 'cowork_ui'"),
    'external-facing surfaces keep their established posture (cowork_ui only)');
  assert.ok(gateWindow.includes('assistantOwnerChatForTurn'),
    'the first-sentence bubble is assistant-mode only (owner requirement 2026-11-03)');
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
  assert.ok(source.includes('assistantOwnerChatForTurn = this.isAssistantModeOwnerChatSession(sessionId)'),
    'the first-sentence experience is decided by the session gate alone');
  // Owner ruling 2026-11-07: Bot Internet projector sessions carry the
  // per-session marker and keep the first-sentence promise even when the
  // global toggle says professional — an outer global-mode check next to the
  // gate would silently strip it (the gate itself already encodes the global
  // assistant requirement for the regular owner-chat path).
  assert.ok(
    !/assistantOwnerChatForTurn = getPersistedChatExperienceMode\(\) === 'assistant'\s*\n?\s*&&\s*this\.isAssistantModeOwnerChatSession/.test(source),
    'the ack must not re-check the global mode next to the gate (marker sessions are mode-independent)',
  );
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

test('runner: the LLM first sentence CREATES the bubble once, gated on identity/serial/visible-text', () => {
  const source = read('src/main/libs/coworkRunner.ts');

  const emitter = source.indexOf('private emitTurnAckOpeningBubble(');
  assert.ok(emitter > 0, 'the deterministic opening emitter exists');
  const llm = source.indexOf('private async emitTurnAckReplyBubble(');
  assert.ok(llm > emitter, 'the LLM creator follows the deterministic emitter');
  const body = source.slice(llm, source.indexOf('private emitSdkRuntimeStatus(', llm));
  assert.ok(body.includes('this.activeSessions.get(sessionId) !== turn'),
    'a first sentence whose turn object is no longer the registry current is dropped (identity)');
  assert.ok(body.includes('turn.dshTurnAckSerial !== turnSerial'),
    'a stale first sentence superseded by a re-kick on the same object is dropped');
  assert.ok(body.includes('turn.dshTurnAckVisibleTextSeen'),
    'a first sentence landing after real visible text (model, owner_update or an earlier opening) is dropped');
  assert.ok(body.includes('turn.dshTurnAckOpeningEmitted'),
    'at most one opening bubble per turn');
  assert.ok(body.includes('generateTurnAckReply(userPrompt, sessionTitle)'),
    'the first sentence rides the one-shot cognitive path with session-title context');
  assert.ok(body.includes("metadata: { turnAckReply: true, isFinal: true }"),
    'the bubble is a final assistant message tagged turnAckReply');
  assert.ok(body.includes("this.store.addMessage(sessionId, {"),
    'the LLM first sentence CREATES the bubble — no placeholder to refine');
  assert.ok(!body.includes('updateMessageMerged') && !body.includes("emit('messageUpdate'"),
    'no in-place refine machinery remains in the ack path (2026-11-03 second pass)');
  assert.ok(body.includes('turn.assistantOwnerUpdateCount = Math.max(1,'),
    'the host opening and model updates share one per-turn budget');
  assert.ok(!body.includes('activeSession.dshTurnAckSerial !== turnSerial'),
    'the gate must not re-read the registry object for the serial');
  assert.ok(!source.includes('dshTurnAckOpeningMessageId')
    && !source.includes('dshTurnAckOpeningRefined')
    && !source.includes('dshTurnAckModelTextSeen'),
    'the refine-era ActiveSession fields are gone');

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

// 2026-11-03 live test (session fd23405b turn 2): the owner's follow-up went
// through continueSession with skipUserMessage: true (the submission persists
// the text first); with the ActiveSession torn down after the previous turn,
// the startSession fallback carried no acknowledgeOwner and the whole
// first-sentence pipeline was skipped — turn 2+ had no bubble at all.
test('runner: owner follow-ups keep the first-sentence promise across continueSession', () => {
  const source = read('src/main/libs/coworkRunner.ts');
  const submission = read('src/main/services/coworkTurnSubmission.ts');
  assert.ok(submission.includes('acknowledgeOwner: true,'),
    'the owner submission marks its turns owner-initiated');
  assert.ok(source.includes('activeSession.acknowledgeOwner = options.acknowledgeOwner === true;'),
    'the same-object continue resets the per-turn owner flag (machine flows stay ack-free)');
  assert.ok(source.includes('...(options.acknowledgeOwner ? { acknowledgeOwner: true } : {})'),
    'the startSession fallback carries the owner flag');
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
  assert.ok(body.includes('        signal,'), 'the utility retains caller-controlled cancellation for other call sites');
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

// ---------------------------------------------------------------------------
// 2026-11-03 third pass (session 3ecd2a2f): content-free acks + cerebellum gate
// ---------------------------------------------------------------------------

// The ack call sees only the user text and the session title — no local time,
// no memory. The old "for a simple question, respond naturally" line invited
// it to answer "你知道明天是几月几号吗" with "我没法确定今天的日期", while the
// main answer (riding the local-time prompt) named the date — two bubbles in
// open contradiction. The ack now acknowledges only; only pure greetings get
// content (a greeting back carries nothing to contradict).
test('buildTurnAckReplyMessages: the ack never answers content; greetings stay natural', () => {
  const messages = buildTurnAckReplyMessages({ userText: '你知道明天是几月几号吗？' });
  const system = messages[0].content;
  assert.ok(system.includes("NEVER answer the user's question"),
    'the no-answering rule is part of the system prompt');
  assert.ok(system.includes('can contradict the real reply'),
    'the rule carries its rationale (the contradiction incident)');
  assert.ok(system.includes('a greeting gets a greeting back'),
    'pure greetings still get a natural greeting — that IS the ack');
  assert.ok(!system.includes('For a simple question or a greeting, respond naturally'),
    'the old answer-simple-questions line is gone');
});

test('runner: the cerebellum ack gate races the ack call; a direct-reply verdict defers instead of cancelling', () => {
  const source = read('src/main/libs/coworkRunner.ts');
  const start = source.indexOf('private async emitTurnAckReplyBubble(');
  const body = source.slice(start, source.indexOf('private emitSdkRuntimeStatus(', start));
  const gateKick = body.indexOf('this.cerebellumTurnAckGate({ currentUserText: userPrompt })');
  const ackCall = body.indexOf('generateTurnAckReply(userPrompt, sessionTitle)');
  assert.ok(gateKick > 0, 'the gate is consulted inside the ack path');
  assert.ok(ackCall > 0, 'the ack generation still starts immediately');
  assert.ok(gateKick < ackCall, 'the gate is KICKED before the ack call — both run in parallel');
  // 2026-11-03 session e2f359d7: the serial wiring stacked the gate budget
  // ahead of every ack emit and nearly doubled the wait under a main-process
  // stall — the gate must not be awaited before generation starts.
  const gateAwait = body.indexOf('const needsAck = await gatePromise');
  assert.ok(gateAwait > ackCall, 'the verdict is awaited only at emission time, after generation');
  assert.ok(!body.includes('ackAbort.abort()'),
    'a direct-reply verdict no longer cancels the ack that may be needed as the rescue');
  assert.ok(body.includes('if (needsAck === false)'),
    'only an explicit false verdict defers; true and null both emit immediately (fail-open)');
  assert.ok(body.includes('TURN_ACK_DIRECT_REPLY_GRACE_MS'),
    'the direct-reply grace window is bounded');
  assert.ok(body.includes('deferredForDirectReply'),
    'the emitted-bubble log records whether the grace path released it');
  assert.ok(body.includes('.catch(() => null)'),
    'a throwing gate callback degrades to null, never breaks the ack path');
});

test('runner + main.ts: the ack gate is a runner option wired to the cerebellum factory', () => {
  const source = read('src/main/libs/coworkRunner.ts');
  const mainSource = read('src/main/main.ts');
  assert.ok(source.includes("cerebellumTurnAckGate?: (input: {"),
    'CoworkRunnerOptions declares the gate callback');
  assert.ok(source.includes("this.cerebellumTurnAckGate = options?.cerebellumTurnAckGate;"),
    'the constructor stores it');
  assert.ok(mainSource.includes("import { classifyTurnAckNeedWithCerebellum } from './cerebellum/ackGate';"),
    'main.ts imports the gate classifier');
  assert.ok(mainSource.includes('cerebellumTurnAckGate: createCerebellumTurnAckGate(),'),
    'the runner option rides the lazy cerebellum-context factory');
  const factory = mainSource.indexOf('const createCerebellumTurnAckGate =');
  const factoryBody = mainSource.slice(factory, factory + 1200);
  assert.ok(factoryBody.includes('resolveCerebellumCallContext()'),
    'the factory resolves the cerebellum context lazily per call');
  const logCall = factoryBody.slice(factoryBody.indexOf("coworkLog('INFO', 'turn:ackGate'"));
  assert.ok(!logCall.includes('currentUserText'),
    'the gate log never carries user text');
});

test('main.ts: the JEV relay credential warm rides the idle startup tier', () => {
  const source = read('src/main/main.ts');
  assert.ok(source.includes("{ label: 'jev relay credential warm', run: warmJevRelayCredentials }"),
    'the warm is an idle-tier step (runs after service registration, off the startup path)');
  const warm = source.indexOf('const warmJevRelayCredentials =');
  assert.ok(warm > 0 && source.slice(warm, warm + 400).includes('resolveJevRelayCredentials()'),
    'the warm resolves the relay credentials (persisted hit is a pure local read)');
  assert.ok(source.slice(warm, warm + 500).includes('} catch {'),
    'the warm is fail-silent — a failed warm leaves the on-demand bootstrap as the fallback');
});

// ---------------------------------------------------------------------------
// 2026-11-03 session 32a29372: stall-killed ack, bounced opening narration
// ---------------------------------------------------------------------------

test('runner: owner_update opening suppression keys on a real delivered opening, not any visible text', () => {
  const source = read('src/main/libs/coworkRunner.ts');
  assert.ok(source.includes("if (kind === 'opening' && activeSession.dshTurnAckOpeningEmitted)"),
    'only a delivered opening bubble suppresses another opening (session 32a29372)');
  assert.ok(!source.includes("if (kind === 'opening' && activeSession.dshTurnAckVisibleTextSeen)"),
    'the broad visible-text flag no longer suppresses openings');
  assert.ok(source.includes("if (kind === 'opening') activeSession.dshTurnAckOpeningEmitted = true"),
    'a delivered owner_update opening marks the slot (second opening still rejected)');
});

test('runner: an empty first ack attempt gets exactly one retry, gates re-applied across the wait', () => {
  const source = read('src/main/libs/coworkRunner.ts');
  const start = source.indexOf('private async emitTurnAckReplyBubble(');
  const body = source.slice(start, source.indexOf('private emitSdkRuntimeStatus(', start));
  // A stall kills both attempts in one tick (their 4s timeout timers fire late
  // together); one retry on the recovered loop completes the fail-open posture.
  assert.ok(body.includes('if (!generatedReply) {'), 'the retry branch keys on an empty first attempt');
  assert.ok(body.includes("coworkLog('INFO', 'turn:ack', 'retrying first sentence after an empty first attempt'"),
    'the retry logs itself');
  assert.ok(body.includes('setTimeout(resolve, 1500)'), 'the retry waits 1.5s for the loop to recover');
  assert.ok(body.includes('generatedReply = await generateTurnAckReply(userPrompt, sessionTitle)'),
    'the retry is a fresh call without the gate abort signal');
  assert.equal(body.split('generateTurnAckReply(userPrompt').length - 1, 2,
    'at most two ack calls per turn (first attempt + one retry)');
  // A direct-reply verdict can still need this retry when its held generation
  // came back empty; the grace wait does not bypass the empty-output rescue.
  const graceIdx = body.indexOf('direct reply expected; first sentence held for the visible-reply grace window');
  const retryIdx = body.indexOf('retrying first sentence after an empty first attempt');
  assert.ok(graceIdx > 0 && graceIdx < retryIdx, 'the direct-reply grace path precedes the retry branch');
});

test('runner: the owner wait heartbeat logs due-but-suppressed outcomes', () => {
  const source = read('src/main/libs/coworkRunner.ts');
  assert.ok(source.includes("'owner wait heartbeat suppressed'"), 'a suppressed heartbeat is logged with its reason');
  assert.ok(source.includes("'owner wait heartbeat deferred: permission prompt pending'"), 'permission deferrals are logged');
  assert.ok(source.includes("'owner wait heartbeat dropped: turn no longer active'"), 'stale-turn drops are logged');
  assert.ok(source.includes("'owner wait heartbeat not armed for this turn'"),
    'an entry-arm early-exit is logged (the session-32a29372 silent-stretch diagnostic)');
  // Every non-shown exit of emitOwnerWaitHeartbeat (empty generation,
  // suppressed bubble, thrown error) re-arms the timer — one suppression must
  // not kill the heartbeat for the rest of a long silent turn.
  const emitterStart = source.indexOf('private async emitOwnerWaitHeartbeat(');
  const emitterEnd = source.indexOf('  private emitAssistantOwnerUpdate(', emitterStart);
  const emitterBody = source.slice(emitterStart, emitterEnd);
  const rearmCount = (emitterBody.match(/this\.armAssistantOwnerWaitTimer\(sessionId, activeSession\)/g) ?? []).length;
  assert.ok(rearmCount >= 3, `empty, suppressed and failed exits all re-arm the next window (found ${rearmCount})`);
});

// ---------------------------------------------------------------------------
// 2026-11-04 owner decision: no canned text in ANY bubble — the wait heartbeat
// ---------------------------------------------------------------------------

test('buildOwnerWaitUpdateMessages: system+user roles, wait context carried, anti-template rule pinned', () => {
  const messages = buildOwnerWaitUpdateMessages({
    userText: '帮我把这个 bug 修一下',
    sessionTitle: '修复构建',
    waitedMs: 5 * 60_000,
    waitingForTool: true,
    priorCount: 0,
  });
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, 'system');
  assert.ok(messages[0].content.includes('waiting about 5 minute(s)'), 'wait duration carried');
  assert.ok(messages[0].content.includes('never a canned status template'), 'the no-canned rule is in the prompt');
  assert.ok(messages[0].content.includes('Same language as the user message'), 'language rule pinned');
  assert.ok(messages[0].content.includes("never mention what language it is in"), 'no-meta rule pinned');
  assert.ok(!messages[0].content.includes('say something NEW'), 'first fire carries no repeat warning');
  assert.ok(messages[1].content.includes('Session title: 修复构建'));
  assert.ok(messages[1].content.includes('an execution step (a tool/command) is still running'), 'tool-waiting context');
  assert.ok(messages[1].content.includes('帮我把这个 bug 修一下'), 'user text carried');

  const again = buildOwnerWaitUpdateMessages({ userText: 'hello', waitedMs: 11 * 60_000, waitingForTool: false, priorCount: 2 });
  assert.ok(again[0].content.includes('waiting about 11 minute(s)'));
  assert.ok(again[1].content.includes('say something NEW'), 'repeat fires demand fresh wording');
  assert.ok(again[1].content.includes('2 such note(s)'), 'the prior count is carried');
  assert.ok(again[1].content.includes('still thinking, organizing, or checking results'), 'non-tool context');

  const long = buildOwnerWaitUpdateMessages({ userText: 'x'.repeat(5000), waitedMs: 60_000, waitingForTool: false, priorCount: 0 });
  assert.ok(long[1].content.length < 1600, 'user text slice stays bounded');
});

test('runner: the wait heartbeat text is LLM-generated per fire — no canned strings remain', () => {
  const source = read('src/main/libs/coworkRunner.ts');
  assert.ok(!source.includes('有一个执行步骤还在运行'), 'the fixed tool-waiting string is deleted');
  assert.ok(!source.includes('这一轮仍在处理和核对中'), 'the fixed generic-waiting string is deleted');
  assert.ok(!source.includes('One execution step is still running'), 'the English fixed string is deleted too');
  assert.ok(!source.includes('still being processed and checked'), 'the English generic string is deleted too');
  const emitter = source.indexOf('private async emitOwnerWaitHeartbeat(');
  assert.ok(emitter > 0, 'the heartbeat emitter exists');
  const body = source.slice(emitter, emitter + 2400);
  assert.ok(body.includes('this.ownerWaitUpdateGenerator ?? generateOwnerWaitUpdate'),
    'the seam defaults to the coworkUtil LLM generator');
  assert.ok(body.includes("reason: 'generator returned empty'"),
    'an empty generation emits NO bubble and backs off (no canned fallback)');
  assert.ok(body.includes("kind: 'waiting'"), 'the bubble keeps the waiting kind for the renderer');
  assert.ok(source.includes('activeSession.assistantOwnerTurnUserText = prompt;'),
    'the turn user text is captured at entry for heartbeat language/topic context');
});

test('coworkUtil: generateOwnerWaitUpdate mirrors the ack call class', () => {
  const source = read('src/main/libs/coworkUtil.ts');
  const start = source.indexOf('export async function generateOwnerWaitUpdate(');
  assert.ok(start > 0, 'generateOwnerWaitUpdate exists');
  const body = source.slice(start, source.indexOf('\n}', start) + 2);
  assert.ok(body.includes('buildOwnerWaitUpdateMessages(input)'), 'rides the pure prompt builder');
  assert.ok(body.includes("thinking: 'disabled'") && body.includes("effort: 'off'"), 'no reasoning wait');
  assert.ok(body.includes('attemptTimeoutMs: 4_000'), 'bounded per-attempt latency');
  assert.ok(body.includes('fallbackLlmId'), 'fallback brain wired like titles/ack');
  assert.ok(body.includes('sanitizeTurnAckReplyForInput(result.content'), 'shared input-aware sanitize');
});
