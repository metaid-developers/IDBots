/**
 * Test script for Cognitive Orchestrator Phase 2 (Task 12.2).
 * Inserts mock group_chat_tasks and group_chat_messages, runs one tick,
 * and verifies prompt assembly and LLM/broadcast flow (broadcast mocked to avoid gas).
 *
 * Run: npm run compile:electron && node scripts/test_cognitive_phase2.mjs
 */

import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const initSqlJs = require('sql.js');
const { runTickOnce } = require(path.join(__dirname, '../dist-electron/services/cognitiveOrchestrator.js'));

const TEST_GROUP_ID = 'test-group-phase2';
const MOCK_METABOT_ID = 1;

async function main() {
  console.log('[test_cognitive_phase2] Initializing in-memory DB...');
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
      sender_metaid TEXT,
      sender_name TEXT,
      content TEXT,
      mention TEXT,
      is_processed INTEGER NOT NULL DEFAULT 0
    );
  `);

  db.run(
    `INSERT INTO group_chat_tasks (
      group_id, metabot_id, is_active, random_reply_probability,
      discussion_background, participation_goal, last_processed_msg_id
    ) VALUES (?, ?, 1, 1.0, ?, ?, 0)`,
    [TEST_GROUP_ID, MOCK_METABOT_ID, 'Technical discussion about IDBots.', 'Participate naturally and help answer questions.']
  );

  db.run(
    `INSERT INTO group_chat_messages (pin_id, group_id, sender_name, content, is_processed)
     VALUES ('pin-1', ?, 'Alice', 'Has anyone tried the new Cognitive Orchestrator?', 0)`,
    [TEST_GROUP_ID]
  );
  db.run(
    `INSERT INTO group_chat_messages (pin_id, group_id, sender_name, content, is_processed)
     VALUES ('pin-2', ?, 'Bob', 'Not yet. What does it do?', 0)`,
    [TEST_GROUP_ID]
  );
  db.run(
    `INSERT INTO group_chat_messages (pin_id, group_id, sender_name, content, is_processed)
     VALUES ('pin-3', ?, 'Alice', 'It runs a tick and can trigger LLM replies in group chat.', 0)`,
    [TEST_GROUP_ID]
  );

  const saveDb = () => {};
  const getMetabotById = (id) => ({
    id,
    name: 'TestBot',
    role: 'A helpful Web3 assistant.',
    soul: 'You are friendly and concise.',
    llm_id: null,
    globalmetaid: null,
    metaid: null,
  });
  const performChatCompletion = async (systemPrompt, userMessage) => {
    console.log('[test_cognitive_phase2] performChatCompletion called.');
    console.log('[test_cognitive_phase2] System prompt (first 400 chars):', systemPrompt.slice(0, 400));
    console.log('[test_cognitive_phase2] User message:', userMessage);
    return 'Mock LLM reply: Sounds interesting! I can help explain how it works.';
  };
  const broadcastGroupChat = async (metabotId, groupId, nickName, content) => {
    console.log('[test_cognitive_phase2] broadcastGroupChat (MOCK - no chain):', {
      metabotId,
      groupId,
      nickName,
      contentPreview: content.slice(0, 60),
    });
  };

  console.log('[test_cognitive_phase2] Running runTickOnce...');
  await runTickOnce(db, saveDb, getMetabotById, performChatCompletion, broadcastGroupChat);

  const taskRow = db.exec('SELECT last_processed_msg_id, last_replied_at FROM group_chat_tasks WHERE group_id = ?', [
    TEST_GROUP_ID,
  ]);
  console.log('[test_cognitive_phase2] Task after tick:', taskRow[0]?.values?.[0]);
  console.log('[test_cognitive_phase2] Done. Check logs above for assembled prompt and mock LLM/broadcast.');
}

main().catch((err) => {
  console.error('[test_cognitive_phase2] Error:', err);
  process.exit(1);
});
