import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import Module from 'node:module';
import { createCoworkStore, createSqliteStore } from './memoryTestUtils.mjs';

const require = Module.createRequire(import.meta.url);
function loadCompiled(modulePath) {
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, ...rest) {
    if (request === 'electron') return { app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => process.cwd() } };
    return originalLoad.call(this, request, ...rest);
  };
  try { return require(modulePath); } finally { Module._load = originalLoad; }
}
const { scanMemoryText, applyMemoryDefense, MemoryDefenseError } = loadCompiled('../dist-electron/main/memory/memoryDefense.js');
const { SqliteStore } = loadCompiled('../dist-electron/main/sqliteStore.js');
const { CoworkStore } = loadCompiled('../dist-electron/main/coworkStore.js');
const OWNER = { scopeKind: 'owner', scopeKey: 'owner:self' };
const MNEMONIC = 'abandon ability able about above absent absorb abstract absurd abuse access accident';

test('detectors: mnemonics and private keys block; tokens and credentials redact', () => {
  const blocked = scanMemoryText(`我的助记词是 ${MNEMONIC} 不要告诉别人`);
  assert.ok(blocked.some((v) => v.detector === 'bip39_mnemonic' && v.severity === 'block'));
  assert.ok(!JSON.stringify(blocked).includes(MNEMONIC.split(' ').slice(0, 6).join(' ')), 'previews never carry the secret');

  assert.ok(scanMemoryText('backup key: 5HueCGU8rMjxEXxiPuD5dkuYxrL9fvAF8qT8oYgYQv8nKJvBTzAB').some((v) => v.detector === 'wif_private_key' && v.severity === 'block'));
  assert.ok(scanMemoryText('xprv9s21ZrQH143K2JF8R2pEoVw6fNr2RyGgPKcNmU6c5RGb5SgbVa').some((v) => v.detector === 'hd_master_key' && v.severity === 'block'));
  assert.ok(scanMemoryText('private_key = ' + '3f2b'.repeat(16)).some((v) => v.detector === 'hex_private_key' && v.severity === 'block'), 'context-marked hex key blocks');
  const cjkLabeled = applyMemoryDefense('钱包私钥: ' + '3f2b'.repeat(16));
  assert.ok(!cjkLabeled.includes('3f2b'), 'a CJK-labeled hex secret is stripped via the credential redaction');

  const pinId = 'b'.repeat(64); // bare 64-hex = chain pin id shape — must NOT trigger
  assert.equal(scanMemoryText(`发布在 pin ${pinId} 上`).length, 0, 'bare 64-hex (pin/tx ids) never fires');

  const redacted = applyMemoryDefense('我的 OpenAI key 是 sk-proj-abcdefgh12345678ABCDEFG, github 是 ghp_' + 'a'.repeat(36));
  assert.ok(redacted.includes('[REDACTED:openai_api_key]'));
  assert.ok(redacted.includes('[REDACTED:github_token]'));
  assert.ok(!redacted.includes('sk-proj-'));
  const cred = applyMemoryDefense('服务器的密码: hunter2secret!');
  assert.ok(cred.includes('[REDACTED:credential_assignment]'));
  assert.equal(applyMemoryDefense('用户喜欢简洁回复'), '用户喜欢简洁回复', 'clean text passes through unchanged');
  assert.throws(() => applyMemoryDefense(`钱包助记词 ${MNEMONIC}`), MemoryDefenseError);
});

test('write chokepoints: turn writes count refusals, dream writes drop, UI edits throw', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const store = createCoworkStore(db);
    assert.throws(() => store.createUserMemory({ metabotId: 1, text: `助记词备份 ${MNEMONIC}`, ...OWNER }), MemoryDefenseError);
    const redacted = store.createUserMemory({ metabotId: 1, text: '我的 api key: supersecret123456 挂在服务上', ...OWNER });
    assert.ok(redacted.text.includes('[REDACTED:credential_assignment]'), 'redaction persists in the stored row');
    assert.equal(store.createDreamUserMemory({
      metabotId: 1, text: `梦境里出现了 ${MNEMONIC}`, ...OWNER,
      usageClass: 'profile_fact', origin: 'dream', isExplicit: true,
      source: { sourceType: 'dream', sourceChannel: 'dream', dreamDate: '2026-10-24' },
    }), null, 'blocking dream write drops to null, never throws');

    // End-to-end turn path with the extraction runner stubbed to a leaking fact.
    const { setTurnMemoryExtractionRunner } = loadCompiled('../dist-electron/main/libs/coworkMemoryJudge.js');
    const app = await SqliteStore.create(fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-defense-')));
    try {
      const d2 = app.getDatabase();
      d2.run('INSERT INTO metabot_wallets (id, mnemonic, path, created_at) VALUES (1, ?, ?, 1)', [MNEMONIC, "m/44'/10001'/0'/0/0"]);
      d2.run(`INSERT INTO metabots (id, wallet_id, mvc_address, btc_address, doge_address, public_key, chat_public_key, name, enabled, metaid, globalmetaid, metabot_type, created_by, role, soul, boss_global_metaid, llm_id, allow_chat_skills, bio, goal, created_at, updated_at) VALUES (1, 1, 'm','b','d','p','c','Twin',1,'mi','gm','twin','0','r','s','o',NULL,'[]',NULL,NULL,1,1)`);
      const cs = new CoworkStore(d2, () => {});
      const session = cs.createSession('Defense test', os.tmpdir(), '', 'local', [], 1);
      setTurnMemoryExtractionRunner(async () => [
        { action: 'add', text: `用户的恢复短语是 ${MNEMONIC}`, isExplicit: true },
        { action: 'add', text: '用户的部署密码: deploy-pass-9917', isExplicit: false },
      ]);
      const result = await cs.applyTurnMemoryUpdates({
        sessionId: session.id,
        userText: '请记住我的恢复短语和部署密码。',
        assistantText: '好的。',
        implicitEnabled: true,
        memoryLlmJudgeEnabled: true,
        guardLevel: 'relaxed',
      });
      setTurnMemoryExtractionRunner(null);
      assert.equal(result.defenseRejected, 1, 'the mnemonic candidate is refused and counted');
      const memories = cs.listUserMemories({ metabotId: 1, ...OWNER, status: 'created' });
      // Two survivors: the redacted credential fact + the regex-explicit
      // instruction line itself (it names no secret value, so it is clean).
      assert.equal(memories.length, 2);
      const defended = memories.find((entry) => entry.text.includes('[REDACTED:credential_assignment]'));
      assert.ok(defended, 'the redacted credential write survives');
      assert.ok(!memories.some((entry) => entry.text.includes('deploy-pass-9917')), 'the raw secret never lands');
      assert.ok(!memories.some((entry) => entry.text.includes('abandon ability')), 'the mnemonic never lands');
    } finally {
      setTurnMemoryExtractionRunner(null);
      app.close();
    }
  } finally {
    cleanup();
  }
});

import path from 'node:path';

test('defense: CJK prose survives credential redaction; Chinese mnemonics block', () => {
  const { wordlists } = require('bip39');

  // The old value class ([^\s"']{8,}) swallowed the whole CJK clause after a
  // label — these must pass through untouched.
  const prose = [
    '助记词:千万不能泄露给任何人，这是底线',
    '密钥:2026年10月到期后需要重新生成',
    '他的 secret: curiosity drives everything',
  ];
  for (const text of prose) {
    assert.equal(scanMemoryText(text).length, 0, `no violation: ${text}`);
    assert.equal(applyMemoryDefense(text), text);
  }
  // Real ASCII-shaped secrets still redact.
  assert.ok(applyMemoryDefense('密码: MyS3cr3tPassw0rd').includes('[REDACTED:credential_assignment]'));
  assert.ok(applyMemoryDefense('api_key=abc123def456').includes('[REDACTED:credential_assignment]'));
  assert.ok(applyMemoryDefense('部署密码: hunter2secret!').includes('[REDACTED:credential_assignment]'));

  // Chinese mnemonics block — simplified and traditional lists.
  const zhSimplified = wordlists.chinese_simplified.slice(0, 12).join(' ');
  assert.ok(scanMemoryText(`备份: ${zhSimplified}`).some((v) => v.detector === 'bip39_mnemonic' && v.severity === 'block'));
  assert.throws(() => applyMemoryDefense(zhSimplified), MemoryDefenseError);
  const zhTraditional = wordlists.chinese_traditional.slice(0, 12).join(' ');
  assert.ok(scanMemoryText(zhTraditional).some((v) => v.detector === 'bip39_mnemonic' && v.severity === 'block'));

  // Unspaced CJK prose glues into tokens no single-character list contains,
  // and short spaced runs stay under the >= 12 threshold.
  assert.equal(scanMemoryText('我今天在这里学习了很多新的东西，感觉很好').length, 0);
  assert.equal(scanMemoryText('谢 谢 你 的 帮 助 和 陪 伴').length, 0);

  // Long Chinese + English technical prose, Chinese enumeration idioms, and code
  // snippets must NOT false-positive as generic BIP-39 mnemonics.
  const benignLongSamples = [
    '用户正在设计 Agent 核心架构，采用本地 Model 与 Memory 模块配合链上 Token 激励，让 Asset 通过 Bridge 进入 Market 自动生成 Order 并按实时 Price 完成 Trade，整个 Online 的 System 已在生产环境稳定运行。',
    '常见人生十二态枚举：衣、食、住、行、生、老、病、死、喜、怒、哀、乐，均属于日常汉语并列顿号修辞而非助记词。',
    '1月120万，2月135万，3月158万，4月180万，5月205万，6月230万，7月260万，8月295万，9月320万，10月355万，11月390万，12月450万。',
    'function check(input) { if (!input.size) return { success: false, error: true }; return { success: true, result: input.value }; }',
  ];
  for (const sample of benignLongSamples) {
    assert.equal(scanMemoryText(sample).length, 0, `unexpected memory false positive: ${sample}`);
    assert.equal(applyMemoryDefense(sample), sample);
  }

  // Numbered, multiline, and JSON-escaped mnemonics still block at memory write time.
  const numberedEn = MNEMONIC.split(' ').map((w, idx) => `${idx + 1}. ${w}`).join('\n');
  assert.ok(scanMemoryText(numberedEn).some((v) => v.detector === 'bip39_mnemonic' && v.severity === 'block'));
  assert.ok(
    scanMemoryText(JSON.stringify({ note: MNEMONIC.split(' ').join('\r\n') })).some(
      (v) => v.detector === 'bip39_mnemonic' && v.severity === 'block',
    ),
  );
});

test('defense: evidence quotes are screened and evolution rewrites are re-screened', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const store = createCoworkStore(db);
    const redactedQuote = store.createUserMemory({
      metabotId: 1, text: '保持每周轮换 api key 的习惯', ...OWNER,
      source: { sourceType: 'session_turn', quote: '我的 api key: supersecret123456 记在这里' },
    });
    const blockedQuote = store.createUserMemory({
      metabotId: 1, text: '钱包助记词有十二个英文单词', ...OWNER,
      source: { sourceType: 'session_turn', quote: `助记词备份 ${MNEMONIC}` },
    });
    const evidence = store.listUserMemoryEvidence([redactedQuote.id, blockedQuote.id]);
    const redactedQuotes = evidence.get(redactedQuote.id)?.quotes ?? [];
    assert.equal(redactedQuotes.length, 1, 'a redact-level quote is stored redacted');
    assert.ok(redactedQuotes[0].includes('[REDACTED:credential_assignment]'));
    assert.ok(!redactedQuotes[0].includes('supersecret123456'));
    assert.equal((evidence.get(blockedQuote.id)?.quotes ?? []).length, 0, 'a blocking quote is dropped, not stored');

    // Evolution rewrite: a redaction applies in place; a blocking hit keeps
    // the stored text and refuses the rewrite.
    const rewritten = store.rewriteUserMemoryText({
      id: redactedQuote.id, metabotId: 1,
      text: '现在改成: password: abc123def456 每两周', reason: 'evolution_rewrite',
    });
    assert.equal(rewritten, true, 'the rewrite lands with the redaction applied');
    const after = store.listUserMemories({ metabotId: 1, ...OWNER, status: 'created' });
    const row = after.find((entry) => entry.id === redactedQuote.id);
    assert.ok(row?.text.includes('[REDACTED:credential_assignment]'));
    assert.ok(!row?.text.includes('abc123def456'));

    const skipped = store.rewriteUserMemoryText({
      id: redactedQuote.id, metabotId: 1,
      text: `换成了这套短语 ${MNEMONIC}`, reason: 'evolution_rewrite',
    });
    assert.equal(skipped, false, 'a blocking rewrite is refused and the stored text kept');
  } finally {
    cleanup();
  }
});
