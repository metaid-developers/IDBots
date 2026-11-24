import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  CEREBELLUM_CONVERSATION_RANK_INSTRUCTIONS,
  CEREBELLUM_CONVERSATION_RANK_MIN_POOL,
  buildConversationRankRequest,
  orderConversationHits,
  parseConversationRankAnswers,
  rankConversationsWithCerebellum,
} from '../src/main/cerebellum/conversationSearchRank.ts';

const { CoworkRunner } = await import('../dist-electron/main/libs/coworkRunner.js');

const TEST_CONFIG = {
  provider: 'typesafe-jev',
  apiKey: 'sk-jev-test',
  baseUrl: 'https://jev.example.com',
  model: 'jev-latest',
};

function okFetch(payload, captured = []) {
  return async (url, init) => {
    captured.push({ url, init, body: JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => payload };
  };
}

function noulPayload(chats, scoreOf = () => 0.5) {
  const answers = {};
  chats.forEach((chat, index) => {
    answers[`chat_${index}`] = { noul: scoreOf(chat, index) };
  });
  return { answers };
}

const CHATS = [
  { id: 's-new', text: 'Title: 周报\nHuman: 整理表格\nAssistant: 好的' },
  { id: 's-old', text: 'Title: 链上交付\nHuman: txid 必须附上\nAssistant: 记下了' },
];

test('buildConversationRankRequest keeps the query and one noul per chat', () => {
  const request = buildConversationRankRequest({
    searchQuery: '上次 txid 怎么说的',
    chats: CHATS,
    model: 'jev-fast',
  });
  assert.equal(request.state.search_query, '上次 txid 怎么说的');
  assert.equal(request.model, 'jev-fast');
  assert.deepEqual(Object.keys(request.questions), ['chat_0', 'chat_1']);
  assert.equal(request.questions.chat_1.instructions, CEREBELLUM_CONVERSATION_RANK_INSTRUCTIONS.replaceAll('{{INDEX}}', '1'));
  assert.ok(request.questions.chat_0.instructions.includes('chats[0].text'));
});

test('parseConversationRankAnswers maps chat_<i> and rejects a partial payload shape', () => {
  const scores = parseConversationRankAnswers(
    { answers: { chat_0: { noul: 0.2 }, chat_1: { noul: 0.9 }, chat_2: { noul: 'x' } } },
    CHATS,
  );
  assert.deepEqual([...scores.entries()], [['s-new', 0.2], ['s-old', 0.9]]);
  assert.equal(parseConversationRankAnswers(null, CHATS), null);
  assert.equal(parseConversationRankAnswers({}, CHATS), null);
});

test('orderConversationHits promotes scored ids and leaves a missing map untouched', () => {
  assert.deepEqual(orderConversationHits(CHATS, null), CHATS);
  const ordered = orderConversationHits(CHATS, new Map([['s-old', 0.9], ['s-new', 0.1]]));
  assert.deepEqual(ordered.map((chat) => chat.id), ['s-old', 's-new']);
});

test('rankConversationsWithCerebellum posts one request and discards incomplete coverage', async () => {
  const captured = [];
  const scores = await rankConversationsWithCerebellum({
    config: TEST_CONFIG,
    fetchImpl: okFetch(noulPayload(CHATS, (chat) => (chat.id === 's-old' ? 0.95 : 0.1)), captured),
    searchQuery: 'txid',
    chats: CHATS,
  });
  assert.equal(captured[0].url, 'https://jev.example.com/v1/systemone');
  assert.equal(captured[0].body.state.search_query, 'txid');
  assert.deepEqual([...scores.entries()], [['s-new', 0.1], ['s-old', 0.95]]);

  const five = Array.from({ length: 5 }, (_, index) => ({ id: `s${index}`, text: `chat ${index}` }));
  assert.equal(await rankConversationsWithCerebellum({
    config: TEST_CONFIG,
    fetchImpl: okFetch({ answers: { chat_0: { noul: 0.9 }, chat_1: { noul: 0.2 } } }),
    searchQuery: 'txid',
    chats: five,
  }), null);
});

test('rankConversationsWithCerebellum returns null on blank query, HTTP errors, and timeout', async () => {
  let calls = 0;
  const counting = async () => { calls += 1; return { ok: true, status: 200, json: async () => ({}) }; };
  assert.equal(await rankConversationsWithCerebellum({
    config: TEST_CONFIG, fetchImpl: counting, searchQuery: '  ', chats: CHATS,
  }), null);
  assert.equal(calls, 0);
  assert.equal(await rankConversationsWithCerebellum({
    config: TEST_CONFIG,
    fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({}) }),
    searchQuery: 'txid',
    chats: CHATS,
  }), null);
  let abortSeen = false;
  const hanging = (_url, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => {
      abortSeen = true;
      reject(new Error('aborted'));
    });
  });
  assert.equal(await rankConversationsWithCerebellum({
    config: TEST_CONFIG, fetchImpl: hanging, searchQuery: 'txid', chats: CHATS, timeoutMs: 20,
  }), null);
  assert.equal(abortSeen, true);
});

test('eval script builds the request through the module', () => {
  const source = readFileSync(new URL('../scripts/cerebellum-conversation-rank-eval.mjs', import.meta.url), 'utf8');
  assert.match(source, /buildConversationRankRequest/);
  assert.match(source, /orderConversationHits/);
});

function chat(index) {
  return {
    sessionId: `s${index}`,
    title: `title-${index}`,
    updatedAt: 1000 - index,
    url: `https://claude.ai/chat/s${index}`,
    human: `human ${index}`,
    assistant: `assistant ${index}`,
  };
}

function createHarness({ chats, ranker }) {
  const rankerCalls = [];
  const store = {
    getMemoryBackend() {
      return { resolveMetabotIdForMemory() { return 7; } };
    },
    // isA2ASession (A2A isolation hardening, 437368322) reads the session row
    // to gate conversation search; null keeps these fixtures on the local
    // (non-A2A) path the rank tests exercise.
    getSession() {
      return null;
    },
    conversationSearch() {
      return chats;
    },
  };
  const runner = new CoworkRunner(store, {
    cerebellumConversationRanker: ranker
      ? async (input) => {
          rankerCalls.push(input);
          return ranker(input);
        }
      : undefined,
  });
  return { runner, rankerCalls };
}

test('runner: a score map puts the relevant chat first', async () => {
  const chats = [chat(0), chat(1), chat(2)];
  const { runner, rankerCalls } = createHarness({
    chats,
    ranker: () => new Map([['s2', 0.99], ['s0', 0.1], ['s1', 0.1]]),
  });
  const text = await runner.runConversationSearchTool({ query: '上次的 txid' }, 'session-1');
  assert.equal(rankerCalls.length, 1);
  assert.equal(rankerCalls[0].searchQuery, '上次的 txid');
  assert.equal(rankerCalls[0].chats.length, 3);
  assert.ok(text.indexOf('title-2') < text.indexOf('title-0'));
});

test('runner: null and throw keep the keyword order byte-for-byte', async () => {
  const chats = [chat(0), chat(1)];
  const baseline = await createHarness({ chats, ranker: null }).runner.runConversationSearchTool({ query: '周报' }, 'session-1');
  const nulled = await createHarness({ chats, ranker: () => null }).runner.runConversationSearchTool({ query: '周报' }, 'session-1');
  const thrown = await createHarness({
    chats,
    ranker: () => { throw new Error('down'); },
  }).runner.runConversationSearchTool({ query: '周报' }, 'session-1');
  assert.equal(nulled, baseline);
  assert.equal(thrown, baseline);
  assert.ok(baseline.indexOf('title-0') < baseline.indexOf('title-1'));
});

test('runner: a single hit skips the ranker', async () => {
  const { runner, rankerCalls } = createHarness({
    chats: [chat(0)],
    ranker: () => new Map([['s0', 0.9]]),
  });
  assert.ok(1 < CEREBELLUM_CONVERSATION_RANK_MIN_POOL);
  const text = await runner.runConversationSearchTool({ query: '周报' }, 'session-1');
  assert.equal(rankerCalls.length, 0);
  assert.match(text, /title-0/);
});
