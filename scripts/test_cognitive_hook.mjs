/**
 * Self-test for Cognitive Orchestrator Tool Hook & Boss listen mechanism (SDD Task 12.4).
 * When runSkillTurnViaCowork is provided: mocks it and verifies broadcast.
 * When not provided (fallback): uses getSkillsPromptForIds + skillsRoots + chatWithToolsOverride
 * (Read then Bash then final content) and verifies tool loop and broadcast.
 *
 * Run: npm run compile:electron && node scripts/test_cognitive_hook.mjs
 */

import { createRequire } from 'module';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const initSqlJs = require('sql.js');
const { runTickOnce } = require(path.join(__dirname, '../dist-electron/services/cognitiveOrchestrator.js'));

const TEST_GROUP_ID = 'hook-test-group';
const MOCK_METABOT_ID = 999;
const BOSS_METAID = 'BOSS_123';

// SKILLs root (project SKILLs dir so Read can read a real file)
const SKILLS_ROOT = path.resolve(__dirname, '..', 'SKILLs');
const TEST_SKILL_ID = 'metabot-omni-caster';
const TEST_SKILL_MD = path.join(SKILLS_ROOT, TEST_SKILL_ID, 'SKILL.md');

// Capture console.log for assertions
let broadcastPayload = null;
let readExecutions = [];
let bashExecutions = [];
let llmToolCallsLog = [];
let usedCoworkSkillTurn = false;

const originalLog = console.log;
console.log = function (...args) {
  const msg = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  if (msg.includes('[MOCK BROADCAST]')) {
    broadcastPayload = args.length > 1 ? args[1] : args[0];
  }
  if (msg.includes('Using Cowork for skill turn')) {
    usedCoworkSkillTurn = true;
  }
  if (msg.includes('[HOOK] Executing Read:')) {
    readExecutions.push(msg);
  }
  if (msg.includes('[HOOK] Executing Bash:')) {
    bashExecutions.push(msg);
  }
  if (msg.includes('LLM tool_calls:')) {
    llmToolCallsLog.push(msg);
  }
  originalLog.apply(console, args);
};

function getSkillsPromptForIds(ids) {
  if (!ids || ids.length === 0) return null;
  if (!fs.existsSync(TEST_SKILL_MD)) return null;
  const skillEntries = `  <skill><id>${TEST_SKILL_ID}</id><name>Omni Caster</name><description>Post Buzz and protocol data.</description><location>${TEST_SKILL_MD}</location></skill>`;
  return [
    '## Skills (mandatory)',
    'Before replying: scan <available_skills> <description> entries.',
    '- If exactly one skill clearly applies: read its SKILL.md at <location> with the Read tool, then follow it.',
    '<available_skills>',
    skillEntries,
    '</available_skills>',
  ].join('\n');
}

async function main() {
  console.log('[test_cognitive_hook] Initializing in-memory DB...');
  const SQL = await initSqlJs();
  const db = new SQL.Database();

  db.run(`
    CREATE TABLE group_chat_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id TEXT NOT NULL,
      metabot_id INTEGER NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      reply_on_mention INTEGER NOT NULL DEFAULT 1,
      random_reply_probability REAL NOT NULL DEFAULT 0,
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
      sender_global_metaid TEXT,
      sender_name TEXT,
      content TEXT,
      mention TEXT,
      is_processed INTEGER NOT NULL DEFAULT 0
    );
  `);

  // Task with allowed_skills so Read/Bash loop is used
  db.run(
    `INSERT INTO group_chat_tasks (
      group_id, metabot_id, is_active, reply_on_mention, random_reply_probability,
      discussion_background, participation_goal, supervisor_globalmetaid, allowed_skills, last_processed_msg_id
    ) VALUES (?, ?, 1, 1, 0, ?, ?, ?, ?, 0)`,
    [
      TEST_GROUP_ID,
      MOCK_METABOT_ID,
      'Test group for hook.',
      'Execute Boss orders and use Read/Bash when asked.',
      BOSS_METAID,
      JSON.stringify([TEST_SKILL_ID]),
    ]
  );

  db.run(
    `INSERT INTO group_chat_messages (pin_id, group_id, sender_global_metaid, sender_name, content, is_processed)
     VALUES ('pin-hook-1', ?, ?, 'Boss', ?, 0)`,
    [
      TEST_GROUP_ID,
      BOSS_METAID,
      '@ToolBot 用技能发一条 Buzz，内容是：我们正在创造历史！',
    ]
  );

  const saveDb = () => {};
  const getMetabotById = (id) => {
    if (id === MOCK_METABOT_ID) {
      return {
        id: MOCK_METABOT_ID,
        name: 'ToolBot',
        role: 'Worker that obeys Boss.',
        soul: 'You follow orders and use tools when needed.',
        llm_id: null,
        globalmetaid: null,
        metaid: null,
      };
    }
    return null;
  };

  const performChatCompletion = async () => {
    return 'Fallback reply (should not be used when tools are used).';
  };

  const broadcastGroupChat = async (metabotId, groupId, nickName, content) => {
    console.log('[MOCK BROADCAST] Payload:', { metabotId, groupId, nickName, content });
  };

  const expectedReply = 'Boss，技能已执行，Buzz 已发送。我们正在创造历史！';

  // Prefer runSkillTurnViaCowork (reuse Cowork path): mock returns fixed reply
  const runSkillTurnViaCowork = async (params) => {
    console.log('[test_cognitive_hook] Mock runSkillTurnViaCowork called with cwd:', params.cwd?.slice(-40));
    return expectedReply;
  };

  // Fallback: mock LLM for in-orchestrator Read/Bash loop
  let chatCallCount = 0;
  const chatWithToolsOverride = async (messages, options) => {
    chatCallCount++;
    if (chatCallCount === 1) {
      console.log('[test_cognitive_hook] Mock LLM round 1: returning tool_calls Read(SKILL.md)');
      return {
        tool_calls: [
          {
            id: 'tc-read-1',
            name: 'Read',
            arguments: JSON.stringify({ file_path: TEST_SKILL_MD }),
          },
        ],
      };
    }
    if (chatCallCount === 2) {
      console.log('[test_cognitive_hook] Mock LLM round 2: returning tool_calls Bash');
      return {
        tool_calls: [
          {
            id: 'tc-bash-1',
            name: 'Bash',
            arguments: JSON.stringify({ command: 'echo "Skill executed"', description: 'Test run' }),
          },
        ],
      };
    }
    console.log('[test_cognitive_hook] Mock LLM round 3: returning final content');
    return { content: expectedReply };
  };

  console.log('[test_cognitive_hook] Running runTickOnce with runSkillTurnViaCowork + skillsRoots...');
  await runTickOnce(
    db,
    saveDb,
    getMetabotById,
    performChatCompletion,
    broadcastGroupChat,
    {
      getSkillsPromptForIds,
      skillsRoots: [SKILLS_ROOT],
      runSkillTurnViaCowork,
      chatWithToolsOverride,
    }
  );

  await new Promise((r) => setTimeout(r, 800));

  let ok = true;

  if (!usedCoworkSkillTurn) {
    console.error('[test_cognitive_hook] FAIL: Expected "Using Cowork for skill turn" log (runSkillTurnViaCowork path)');
    ok = false;
  } else {
    console.log('[test_cognitive_hook] PASS: Cowork skill turn path used.');
  }

  const content = broadcastPayload?.content ?? '';
  const hasBoss = content.includes('Boss');
  const hasExpected = content.includes('技能') || content.includes('创造历史') || content.includes('Buzz');
  if (!broadcastPayload || !(hasBoss && hasExpected)) {
    console.error('[test_cognitive_hook] FAIL: [MOCK BROADCAST] content must contain Boss and skill summary. Got:', content?.slice(0, 120));
    ok = false;
  } else {
    console.log('[test_cognitive_hook] PASS: [MOCK BROADCAST] content contains Boss and summary.');
  }

  if (ok) {
    console.log('[test_cognitive_hook] All checks passed. Orchestrator reuse Cowork skill turn OK.');
  } else {
    console.error('[test_cognitive_hook] Some checks failed.');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[test_cognitive_hook] Error:', err);
  process.exit(1);
});
