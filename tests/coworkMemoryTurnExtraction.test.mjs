import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');
const { CoworkStore } = require('../dist-electron/main/coworkStore.js');
const {
  setTurnMemoryExtractionRunner,
  parseTurnMemoryExtractionPayload,
} = require('../dist-electron/main/libs/coworkMemoryJudge.js');
const { isSubstantiveMemoryText } = require('../dist-electron/main/libs/coworkMemoryExtractor.js');
const { evaluateConversationMemoryQuality } = require('../dist-electron/main/libs/coworkMemoryQuality.js');

const makeTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-memory-turn-extract-'));

async function createHarness() {
  const store = await SqliteStore.create(makeTempDir());
  const db = store.getDatabase();
  // user_memories.metabot_id has a foreign key into metabots (wallet required).
  db.run(
    'INSERT INTO metabot_wallets (id, mnemonic, path, created_at) VALUES (?, ?, ?, ?)',
    [1, 'abandon ability able about above absent absorb abstract absurd abuse access accident', "m/44'/10001'/0'/0/0", 1700000000000],
  );
  db.run(
    `INSERT INTO metabots (
      id, wallet_id, mvc_address, btc_address, doge_address, public_key, chat_public_key,
      name, enabled, metaid, globalmetaid, metabot_type, created_by, role, soul,
      boss_global_metaid, llm_id, allow_chat_skills, bio, goal, created_at, updated_at
    ) VALUES (1, 1, 'mvc-1', 'btc-1', 'doge-1', 'pk-1', 'cpk-1',
      'Twin Bot', 1, 'metaid-1', 'gmid-twin', 'twin', '0000', 'role', 'soul',
      'gmid-owner', NULL, '[]', NULL, NULL, 1700000000000, 1700000000000)`,
  );
  const coworkStore = new CoworkStore(store.getDatabase(), () => {});
  const session = coworkStore.createSession('Memory test', os.tmpdir(), '', 'local', [], 1);
  return {
    store,
    coworkStore,
    sessionId: session.id,
    cleanup: () => {
      setTurnMemoryExtractionRunner(null);
      store.close();
    },
  };
}

const applyTurn = (h, overrides = {}) => h.coworkStore.applyTurnMemoryUpdates({
  sessionId: h.sessionId,
  userText: '',
  assistantText: '',
  implicitEnabled: true,
  memoryLlmJudgeEnabled: true,
  guardLevel: 'standard',
  ...overrides,
});

test('parseTurnMemoryExtractionPayload: caps, sanitize, and junk handling', () => {
  const valid = parseTurnMemoryExtractionPayload(
    '{"changes":[{"action":"add","text":"Me llamo Carlos","is_explicit":true},{"action":"add","text":"prefiere respuestas cortas"},{"action":"delete","text":"olvida lo del perro","is_explicit":true}]}',
  );
  assert.deepEqual(valid, [
    { action: 'add', text: 'Me llamo Carlos', isExplicit: true },
    { action: 'add', text: 'prefiere respuestas cortas', isExplicit: false },
    { action: 'delete', text: 'olvida lo del perro', isExplicit: true },
  ]);

  // Cap: at most 2 implicit adds / 2 explicit adds / 2 deletes survive.
  const capped = parseTurnMemoryExtractionPayload(
    '{"changes":[' + [
      ...Array.from({ length: 4 }, (_, i) => `{\"action\":\"add\",\"text\":\"implicit fact number ${i}\"}`),
      ...Array.from({ length: 4 }, (_, i) => `{\"action\":\"add\",\"text\":\"explicit fact ${i}\",\"is_explicit\":true}`),
      ...Array.from({ length: 4 }, (_, i) => `{\"action\":\"delete\",\"text\":\"delete target ${i}\"}`),
    ].join(',') + ']}',
  );
  assert.equal(capped.filter((c) => c.action === 'add' && !c.isExplicit).length, 2);
  assert.equal(capped.filter((c) => c.action === 'add' && c.isExplicit).length, 2);
  assert.equal(capped.filter((c) => c.action === 'delete').length, 2);

  assert.equal(parseTurnMemoryExtractionPayload('not json at all'), null);
  assert.equal(parseTurnMemoryExtractionPayload('{"nope": 1}'), null);
  assert.deepEqual(parseTurnMemoryExtractionPayload('{"changes":[]}'), []);
  // Too-short texts are dropped.
  assert.deepEqual(
    parseTurnMemoryExtractionPayload('{"changes":[{"action":"add","text":"x"}]}'),
    [],
  );
});

test('isSubstantiveMemoryText is a language-neutral cost guard', () => {
  assert.equal(isSubstantiveMemoryText('recuerda que me llamo Carlos'), true);
  assert.equal(isSubstantiveMemoryText('ok'), false);
  assert.equal(isSubstantiveMemoryText('```\ncode only\n```'), false);
  assert.equal(isSubstantiveMemoryText('   '), false);
});

test('a Spanish explicit memory command reaches storage via the turn extraction (global audit)', async () => {
  const h = await createHarness();
  try {
    setTurnMemoryExtractionRunner(async () => ([
      { action: 'add', text: 'Me llamo Carlos', isExplicit: true },
    ]));
    const result = await applyTurn(h, { userText: 'Recuerda que me llamo Carlos' });
    assert.equal(result.created, 1);
    assert.equal(result.llmReviewed, 1);
    const memories = h.coworkStore.listUserMemories({ metabotId: 1 });
    assert.equal(memories.length, 1);
    assert.equal(memories[0].isExplicit, true);
    assert.match(memories[0].text, /Me llamo Carlos/);
  } finally {
    h.cleanup();
  }
});

test('a Spanish implicit personal fact is stored with the turn_llm provenance', async () => {
  const h = await createHarness();
  try {
    setTurnMemoryExtractionRunner(async () => ([
      { action: 'add', text: 'Tengo un perro que se llama Rocco', isExplicit: false },
    ]));
    const result = await applyTurn(h, { userText: 'Tengo un perro que se llama Rocco y vive conmigo' });
    assert.equal(result.created, 1);
    const memories = h.coworkStore.listUserMemories({ metabotId: 1 });
    assert.equal(memories.length, 1);
    assert.equal(memories[0].isExplicit, false);
  } finally {
    h.cleanup();
  }
});

test('implicit-off sessions only take explicit extraction entries', async () => {
  const h = await createHarness();
  try {
    setTurnMemoryExtractionRunner(async () => ([
      { action: 'add', text: 'dato implícito en español', isExplicit: false },
      { action: 'add', text: 'Recuerda: uso Neovim', isExplicit: true },
    ]));
    const result = await applyTurn(h, {
      userText: 'por cierto, dato implícito. Recuerda: uso Neovim',
      implicitEnabled: false,
    });
    assert.equal(result.created, 1);
    assert.equal(result.skipped, 1);
    const memories = h.coworkStore.listUserMemories({ metabotId: 1 });
    assert.equal(memories.length, 1);
    assert.match(memories[0].text, /Neovim/);
    assert.equal(memories[0].isExplicit, true);
  } finally {
    h.cleanup();
  }
});

test('extraction failure degrades to the regex-only path without throwing', async () => {
  const h = await createHarness();
  try {
    setTurnMemoryExtractionRunner(async () => null);
    const result = await applyTurn(h, { userText: 'Recuerda que me llamo Carlos' });
    assert.equal(result.created, 0);
    // zh/en regex candidates still work when present (unchanged fast path).
    const zh = await applyTurn(h, { userText: '记住：我叫小明，我是设计师' });
    assert.equal(zh.created, 1);
    assert.match(h.coworkStore.listUserMemories({ metabotId: 1 })[0].text, /我叫小明/);
  } finally {
    h.cleanup();
  }
});

test('an extraction entry duplicating a regex candidate is dropped, not double-written', async () => {
  const h = await createHarness();
  try {
    setTurnMemoryExtractionRunner(async () => ([
      { action: 'add', text: '我叫小明，是设计师', isExplicit: false },
    ]));
    await applyTurn(h, { userText: '记住：我叫小明，是设计师' });
    const rows = h.store.getDatabase().exec(
      `SELECT COUNT(*) FROM user_memory_sources WHERE source_type = 'turn_llm'`,
    )[0].values[0][0];
    assert.equal(rows, 0, 'the duplicated LLM entry never reached storage');
    // The regex path's own (pre-existing) explicit + implicit rows stand.
    const memories = h.coworkStore.listUserMemories({ metabotId: 1 });
    assert.equal(memories.length, 2);
    assert.ok(memories.some((entry) => entry.text === '我叫小明，是设计师'));
    assert.ok(memories.some((entry) => entry.text === '记住：我叫小明，是设计师'));
  } finally {
    h.cleanup();
  }
});

test('an LLM delete instruction removes the best-matching memory', async () => {
  const h = await createHarness();
  try {
    setTurnMemoryExtractionRunner(async () => ([
      { action: 'add', text: 'Tengo dos gatos', isExplicit: false },
    ]));
    await applyTurn(h, { userText: 'por cierto, tengo dos gatos en casa' });
    assert.equal(h.coworkStore.listUserMemories({ metabotId: 1 }).length, 1);

    setTurnMemoryExtractionRunner(async () => ([
      { action: 'delete', text: 'Tengo dos gatos', isExplicit: true },
    ]));
    const result = await applyTurn(h, { userText: 'Olvida lo de los gatos' });
    assert.equal(result.deleted, 1);
    assert.equal(h.coworkStore.listUserMemories({ metabotId: 1 }).length, 0);
  } finally {
    h.cleanup();
  }
});

test('the extraction never runs when the LLM judge is disabled (cost guard)', async () => {
  const h = await createHarness();
  try {
    let called = 0;
    setTurnMemoryExtractionRunner(async () => {
      called += 1;
      return [{ action: 'add', text: 'x'.repeat(20), isExplicit: true }];
    });
    await applyTurn(h, { userText: 'Recuerda que me llamo Carlos', memoryLlmJudgeEnabled: false });
    assert.equal(called, 0, 'extraction skipped when the session judge is off');
    // Substantive-text guard also skips the runner.
    await applyTurn(h, { userText: 'ok', memoryLlmJudgeEnabled: true });
    assert.equal(called, 0, 'extraction skipped for non-substantive text');
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Conversation-memory quality gate (memory/persona audit P1): deterministic
// rejection of raw verbatim copies and chitchat/self-intro candidates before
// persistence. Explicit remember-commands are never gated.
// ---------------------------------------------------------------------------

test('quality gate unit: the production garbage shapes are rejected with the right reasons', () => {
  const evaluate = (text, sourceText, isExplicit = false) =>
    evaluateConversationMemoryQuality({ text, sourceText: sourceText ?? text, isExplicit });

  // A2A peer self-intro (zh, indefinite-article role descriptor).
  assert.equal(
    evaluate('我是 dnaai-scout,一个独立 Agent,正在寻找能帮助 Agent 建立可验证声誉的平台').reason,
    'chitchat-or-intro',
  );
  // Pure pleasantry (en).
  assert.equal(
    evaluate('Understood. If you ever want to talk calibration about your reputation, my door is always open.').reason,
    'chitchat-or-intro',
  );
  // Quote-block raw copy (zh, org-role intro under a '>' excerpt marker).
  assert.equal(
    evaluate('> 我是小峰,5F-Studio 的 chair,今天来对接需求').reason,
    'chitchat-or-intro',
  );
  // Non-chitchat raw copy of the source sentence, no durable predicate.
  const descriptive = '这个平台能帮助 Agent 建立可验证声誉和校准记录';
  assert.equal(evaluate(descriptive, `我们做了个平台。${descriptive}。欢迎体验`).reason, 'verbatim-copy');
  // Durable facts pass even as verbatim slices (the exemption).
  assert.equal(evaluate('我住在杭州').accepted, true);
  assert.equal(evaluate('我偏好 TypeScript').accepted, true);
  assert.equal(evaluate('I prefer TypeScript over JavaScript').accepted, true);
  // Explicit remember-commands are never gated.
  assert.equal(
    evaluate('Understood. If you ever want to talk calibration about your reputation, my door is always open.', undefined, true).reason,
    'explicit-command',
  );
});

test('quality gate rejects a peer self-intro copied from the message (regex implicit path)', async () => {
  const h = await createHarness();
  try {
    const result = await applyTurn(h, {
      userText: '我是 dnaai-scout,一个独立 Agent,正在寻找能帮助 Agent 建立可验证声誉的平台。',
    });
    assert.equal(result.created, 0, 'the raw self-intro never lands in memory');
    assert.equal(result.judgeRejected, 1, 'the gate rejected the extracted candidate before the judge');
    const memories = h.coworkStore.listUserMemories({ metabotId: 1, scopeKind: 'owner', scopeKey: 'owner:self', status: 'all' });
    assert.equal(memories.length, 0);
  } finally {
    h.cleanup();
  }
});

test('quality gate rejects a pure-pleasantry candidate from the turn extraction (LLM path)', async () => {
  const h = await createHarness();
  try {
    setTurnMemoryExtractionRunner(async () => [
      { action: 'add', text: 'Understood. If you ever want to talk calibration about your reputation, my door is always open.', isExplicit: false },
    ]);
    const result = await applyTurn(h, {
      userText: 'We should definitely continue this conversation about calibration and reputation some time.',
    });
    assert.equal(result.created, 0);
    assert.equal(result.skipped, 1);
    assert.equal(result.llmReviewed, 0, 'gated before the reviewed counter');
    const memories = h.coworkStore.listUserMemories({ metabotId: 1, scopeKind: 'owner', scopeKey: 'owner:self', status: 'all' });
    assert.equal(memories.length, 0);
  } finally {
    h.cleanup();
  }
});

test('quality gate rejects a quote-block raw copy (regex implicit path)', async () => {
  const h = await createHarness();
  try {
    const result = await applyTurn(h, {
      userText: '> 我是小峰,5F-Studio 的 chair,今天来对接需求。',
    });
    assert.equal(result.created, 0);
    const memories = h.coworkStore.listUserMemories({ metabotId: 1, scopeKind: 'owner', scopeKey: 'owner:self', status: 'all' });
    assert.equal(memories.length, 0);
  } finally {
    h.cleanup();
  }
});

test('quality gate lets durable profile/preference facts through (zh + en)', async () => {
  const h = await createHarness();
  try {
    const zh = await applyTurn(h, { userText: '我住在杭州,我偏好 TypeScript。' });
    assert.equal(zh.created, 1, 'zh durable fact stored');
    const en = await applyTurn(h, { userText: 'I live in Hangzhou and I prefer TypeScript over JavaScript.' });
    assert.equal(en.created, 1, 'en durable fact stored');
    const texts = h.coworkStore
      .listUserMemories({ metabotId: 1, scopeKind: 'owner', scopeKey: 'owner:self', status: 'all' })
      .map((entry) => entry.text);
    assert.ok(texts.some((text) => text.includes('我住在杭州')), 'zh profile fact present');
    assert.ok(texts.some((text) => text.includes('I live in Hangzhou')), 'en profile fact present');
  } finally {
    h.cleanup();
  }
});

test('explicit remember-commands bypass the quality gate entirely', async () => {
  const h = await createHarness();
  try {
    const direct = await applyTurn(h, { userText: '记住:我住在杭州' });
    assert.equal(direct.created, 1, 'regex explicit channel writes as before');

    // The turn-extraction channel with is_explicit=true: even a
    // pleasantry-shaped text lands, because the human explicitly asked.
    setTurnMemoryExtractionRunner(async () => [
      { action: 'add', text: 'Understood. If you ever want to talk calibration about your reputation, my door is always open.', isExplicit: true },
    ]);
    const viaExtraction = await applyTurn(h, {
      userText: 'Remember this: we can talk calibration about reputation whenever you want.',
    });
    assert.equal(viaExtraction.created, 1, 'explicit extraction-channel write is never gated');
    const memories = h.coworkStore.listUserMemories({ metabotId: 1, scopeKind: 'owner', scopeKey: 'owner:self', status: 'all' });
    assert.equal(memories.length, 2);
  } finally {
    h.cleanup();
  }
});

test('a partial rewrite with new information passes the verbatim bar', async () => {
  const h = await createHarness();
  try {
    setTurnMemoryExtractionRunner(async () => [
      { action: 'add', text: '平台即将上线 Agent 声誉校准功能,支持链上凭证、校准对话与公开审计', isExplicit: false },
    ]);
    const result = await applyTurn(h, {
      userText: '我们平台下周要上线 Agent 声誉校准功能,目前支持 MVC 链上凭证。',
    });
    assert.equal(result.created, 1, 'partial rewrite + new info is not treated as a verbatim copy');
  } finally {
    h.cleanup();
  }
});
