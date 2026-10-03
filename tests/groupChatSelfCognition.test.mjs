/**
 * Memory/persona audit P1: the group-chat DIRECT reply paths (plain completion
 * and the in-orchestrator Read/Bash tool loop) must carry the minimal
 * self-cognition pack — the dream-written self-identity plus the recent dream
 * summaries — so the bot's persona stays aligned with its dream-distilled
 * "who am I" outside cowork turns too.
 *
 * These tests exercise the REAL compiled orchestrator
 * (dist-electron/main/services/cognitiveOrchestrator.js) against an in-memory
 * sql.js database, with the narrow memory/dream seams injected via
 * OrchestratorOptions (the same seams main.ts wires to the cowork memory
 * backend and the dream store).
 *
 * Covered facts:
 *   1. plain direct path: system prompt contains <metabot_self_identity> and
 *      <recent_daily_summaries> (plus the shared persona block);
 *   2. per-bot memoryEnabled=false gates the pack off;
 *   3. unwired seams keep the legacy prompt (no pack);
 *   4. the cowork skill path is NOT double-injected (coworkRunner injects the
 *      full experience block into the turn tail itself);
 *   5. the in-orchestrator tool loop (skill routing hit, no cowork bridge)
 *      uses the direct system prompt and therefore carries the pack.
 *
 * Run: npm run compile:electron && node --test tests/groupChatSelfCognition.test.mjs
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const initSqlJs = require('sql.js');
const { runTickOnce } = require('../dist-electron/main/services/cognitiveOrchestrator.js');

const GROUP_ID = 'group-self-cognition';
const BOT_NAME = 'TestBot';
const TRIGGER_TEXT = `${BOT_NAME}, what is on your mind today?`;
const REPLY_TEXT = 'A dreamy reply (mock).';
const ACK_PIN = `${'cd'.repeat(32)}i0`; // 64 hex chars + i0

const SELF_IDENTITY = '我是一个专注群聊陪伴的 MetaBot,说话温和但有自己的边界';
const DREAM_SUMMARY = '昨天在群里帮 Alice 总结了设计周会的讨论要点';

async function makeFixture() {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run(`
    CREATE TABLE group_chat_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id TEXT NOT NULL,
      metabot_id INTEGER NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      reply_on_mention INTEGER NOT NULL DEFAULT 1,
      random_reply_probability REAL NOT NULL DEFAULT 0.1,
      cooldown_seconds INTEGER NOT NULL DEFAULT 15,
      context_message_count INTEGER NOT NULL DEFAULT 30,
      discussion_background TEXT,
      participation_goal TEXT,
      supervisor_metaid TEXT,
      supervisor_globalmetaid TEXT,
      allowed_skills TEXT,
      original_prompt TEXT,
      start_time TEXT,
      last_replied_at TEXT,
      last_processed_msg_id INTEGER NOT NULL DEFAULT 0
    );
  `);
  db.run(`
    CREATE TABLE group_chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pin_id TEXT UNIQUE NOT NULL,
      group_id TEXT NOT NULL,
      channel_id TEXT,
      sender_metaid TEXT,
      sender_global_metaid TEXT,
      sender_address TEXT,
      sender_name TEXT,
      content TEXT,
      content_type TEXT,
      encryption TEXT,
      reply_pin TEXT,
      mention TEXT,
      chain_timestamp INTEGER,
      chain TEXT,
      raw_data TEXT,
      is_processed INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
  db.run(
    `INSERT INTO group_chat_tasks
       (group_id, metabot_id, is_active, reply_on_mention, random_reply_probability,
        cooldown_seconds, context_message_count, last_processed_msg_id)
     VALUES (?, 7, 1, 1, 0, 0, 30, 0)`,
    [GROUP_ID]
  );
  db.run(
    `INSERT INTO group_chat_messages (pin_id, group_id, sender_name, content, is_processed)
     VALUES ('msg-pin-1', ?, 'Alice', ?, 0)`,
    [GROUP_ID, TRIGGER_TEXT]
  );
  return db;
}

function makeDeps(db, options = {}) {
  const llmCalls = [];
  const broadcasts = [];
  const coworkCalls = [];
  const toolLoopCalls = [];
  const getMetabotById = (id) => ({
    id,
    name: BOT_NAME,
    role: 'companion',
    soul: 'gentle',
    llm_id: null,
    globalmetaid: `bot-global-${id}`,
    metaid: `bot-meta-${id}`,
    boss_global_metaid: null,
    allow_chat_skills: [],
  });
  const performChatCompletion = async (systemPrompt, userMessage) => {
    llmCalls.push({ systemPrompt, userMessage });
    return REPLY_TEXT;
  };
  const broadcastGroupChat = async (metabotId, groupId, nickName, content) => {
    broadcasts.push({ metabotId, groupId, nickName, content });
    return { pinId: ACK_PIN };
  };
  const memorySeams = options.withoutMemorySeams
    ? {}
    : {
        listUserMemories: (metabotId, input) =>
          input.usageClass === 'self_identity' ? [{ text: SELF_IDENTITY }] : [],
        listDailySummaries: () => [{ summaryDate: '2026-10-02', summaryText: DREAM_SUMMARY }],
        getEffectiveMemoryPolicy: () => ({ memoryEnabled: options.memoryEnabled ?? true }),
      };
  const orchestratorOptions = {
    ...memorySeams,
    ...(options.skillRouting
      ? {
          getChatSkillsRoutingPrompt: () => ({ prompt: '<available_skills></available_skills>', activeSkillIds: ['chat-skill'] }),
          skillsRoots: ['/tmp/idbots-skills'],
        }
      : {}),
    ...(options.withCoworkBridge
      ? {
          runSkillTurnViaCowork: async (params) => {
            coworkCalls.push(params);
            return REPLY_TEXT;
          },
        }
      : {}),
    ...(options.withToolLoop
      ? {
          chatWithToolsOverride: async (messages) => {
            toolLoopCalls.push(messages);
            return { content: REPLY_TEXT };
          },
        }
      : {}),
  };
  const tick = () =>
    runTickOnce(db, () => {}, getMetabotById, performChatCompletion, broadcastGroupChat, orchestratorOptions);
  return { tick, llmCalls, broadcasts, coworkCalls, toolLoopCalls };
}

test('plain direct path injects the minimal self-cognition pack (identity + dream summaries)', async () => {
  const db = await makeFixture();
  const deps = makeDeps(db);

  await deps.tick();

  assert.equal(deps.llmCalls.length, 1, 'one direct LLM call');
  const prompt = deps.llmCalls[0].systemPrompt;
  assert.match(prompt, /<metabot_identity>/, 'shared persona block still leads');
  assert.match(prompt, /<metabot_self_identity>/, 'self-identity block injected');
  assert.ok(prompt.includes(SELF_IDENTITY), 'identity text carried verbatim');
  assert.match(prompt, /<recent_daily_summaries>/, 'dream summaries block injected');
  assert.ok(prompt.includes('2026-10-02'), 'dream day rendered');
  assert.ok(prompt.includes(DREAM_SUMMARY), 'dream text carried');
  // The identity cluster sits before the channel framing.
  assert.ok(
    prompt.indexOf('<metabot_self_identity>') < prompt.indexOf('## Group Chat Channel'),
    'self-cognition pack rides right behind the persona',
  );
  // Reply still delivered through the durable outbox.
  assert.equal(deps.broadcasts.length, 1);
  assert.equal(deps.broadcasts[0].content, REPLY_TEXT);
});

test('memoryEnabled=false gates the self-cognition pack off', async () => {
  const db = await makeFixture();
  const deps = makeDeps(db, { memoryEnabled: false });

  await deps.tick();

  assert.equal(deps.llmCalls.length, 1);
  const prompt = deps.llmCalls[0].systemPrompt;
  assert.match(prompt, /<metabot_identity>/, 'persona unaffected by the memory gate');
  assert.doesNotMatch(prompt, /<metabot_self_identity>/);
  assert.doesNotMatch(prompt, /<recent_daily_summaries>/);
});

test('unwired memory seams keep the legacy direct prompt (no pack)', async () => {
  const db = await makeFixture();
  const deps = makeDeps(db, { withoutMemorySeams: true });

  await deps.tick();

  assert.equal(deps.llmCalls.length, 1);
  const prompt = deps.llmCalls[0].systemPrompt;
  assert.match(prompt, /<metabot_identity>/);
  assert.doesNotMatch(prompt, /<metabot_self_identity>/);
  assert.doesNotMatch(prompt, /<recent_daily_summaries>/);
});

test('cowork skill path is NOT double-injected (coworkRunner owns experience injection there)', async () => {
  const db = await makeFixture();
  const deps = makeDeps(db, { skillRouting: true, withCoworkBridge: true });

  await deps.tick();

  assert.equal(deps.coworkCalls.length, 1, 'skill turn routed through the cowork bridge');
  assert.equal(deps.llmCalls.length, 0, 'no direct completion call');
  const coworkPrompt = deps.coworkCalls[0].systemPrompt;
  assert.doesNotMatch(coworkPrompt, /<metabot_self_identity>/, 'no self-cognition copy on the cowork prompt');
  assert.doesNotMatch(coworkPrompt, /<recent_daily_summaries>/);
  assert.doesNotMatch(coworkPrompt, /<metabot_identity>/, 'persona also stays coworkRunner-owned');
});

test('in-orchestrator tool loop (skill routing without the cowork bridge) carries the pack', async () => {
  const db = await makeFixture();
  const deps = makeDeps(db, { skillRouting: true, withToolLoop: true });

  await deps.tick();

  assert.equal(deps.toolLoopCalls.length, 1, 'one tool-loop round');
  const systemMessage = deps.toolLoopCalls[0].find((message) => message.role === 'system');
  assert.ok(systemMessage, 'tool loop opens with the direct system prompt');
  assert.match(systemMessage.content, /<metabot_self_identity>/);
  assert.match(systemMessage.content, /<recent_daily_summaries>/);
  assert.equal(deps.broadcasts.length, 1);
});
