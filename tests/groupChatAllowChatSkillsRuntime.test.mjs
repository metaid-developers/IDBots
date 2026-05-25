import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { runTickOnce } = require('../dist-electron/services/cognitiveOrchestrator.js');

function makeDb(senderGlobalMetaId, overrides = {}) {
  const runs = [];
  const task = {
    id: 7,
    group_id: 'group-1',
    metabot_id: 9,
    is_active: 1,
    reply_on_mention: 1,
    random_reply_probability: 0,
    cooldown_seconds: 0,
    context_message_count: 10,
    discussion_background: 'Discuss useful work.',
    participation_goal: 'Reply when useful.',
    supervisor_metaid: null,
    supervisor_globalmetaid: 'boss-global',
    allowed_skills: '["legacy-task-skill"]',
    original_prompt: null,
    start_time: null,
    last_replied_at: null,
    last_processed_msg_id: 0,
    ...overrides.task,
  };
  const messageContent = overrides.messageContent ?? 'Bot, please use the chat skill.';

  return {
    runs,
    exec(sql, params) {
      if (/SELECT \* FROM group_chat_tasks/.test(sql)) {
        const columns = Object.keys(task);
        return [{ columns, values: [columns.map((key) => task[key])] }];
      }
      if (/COALESCE\(MAX\(id\)/.test(sql)) {
        return [{ columns: ['max_id'], values: [[1]] }];
      }
      if (/WHERE group_id = \? AND id > \? AND is_processed = 0/.test(sql)) {
        return [{
          columns: ['id', 'group_id', 'content', 'mention', 'sender_global_metaid', 'sender_metaid'],
          values: [[1, 'group-1', messageContent, null, senderGlobalMetaId, null]],
        }];
      }
      if (/ORDER BY id DESC LIMIT/.test(sql)) {
        return [{
          columns: ['id', 'group_id', 'content', 'sender_name', 'sender_global_metaid'],
          values: [[1, 'group-1', messageContent, 'Sender', senderGlobalMetaId]],
        }];
      }
      throw new Error(`Unexpected SQL: ${sql} ${JSON.stringify(params)}`);
    },
    run(sql, params) {
      runs.push({ sql, params });
    },
  };
}

async function runGroupCase(senderGlobalMetaId, overrides = {}) {
  const db = makeDb(senderGlobalMetaId, overrides);
  const skillTurnCalls = [];
  const chatRoutingCalls = [];
  const broadcasts = [];
  const metabot = {
    id: 9,
    name: 'Bot',
    role: 'helper',
    soul: 'direct',
    llm_id: null,
    globalmetaid: 'bot-global',
    metaid: 'bot-meta',
    boss_global_metaid: 'boss-global',
    allow_chat_skills: ['chat-allowed-skill'],
    ...overrides.metabot,
  };
  const performChatCompletionCalls = [];

  await runTickOnce(
    db,
    () => {},
    () => metabot,
    async (systemPrompt, userMessage) => {
      performChatCompletionCalls.push({ systemPrompt, userMessage });
      return 'llm reply';
    },
    async (metabotId, groupId, nickName, content) => {
      broadcasts.push({ metabotId, groupId, nickName, content });
    },
    {
      skillsRoots: [process.cwd()],
      getChatSkillsRoutingPrompt: (input) => {
        chatRoutingCalls.push(input);
        const activeSkillIds = input.allowAllEnabled ? ['enabled-skill-a', 'enabled-skill-b'] : input.allowChatSkills;
        if (!activeSkillIds || activeSkillIds.length === 0) {
          return { activeSkillIds: [], prompt: null };
        }
        return {
          activeSkillIds,
          prompt: `<available_skills>${activeSkillIds.map((id) => `<skill><id>${id}</id></skill>`).join('')}</available_skills>`,
        };
      },
      runSkillTurnViaCowork: async (params) => {
        skillTurnCalls.push(params);
        return `used ${params.activeSkillIds.join(',')}`;
      },
    }
  );

  return { chatRoutingCalls, skillTurnCalls, broadcasts, performChatCompletionCalls };
}

test('group chat Boss turns run with all enabled chat skills instead of deprecated task allowed_skills', async () => {
  const { chatRoutingCalls, skillTurnCalls, broadcasts } = await runGroupCase('boss-global');

  assert.deepEqual(chatRoutingCalls, [{ allowAllEnabled: true }]);
  assert.deepEqual(skillTurnCalls[0].activeSkillIds, ['enabled-skill-a', 'enabled-skill-b']);
  assert.equal(broadcasts.at(-1).content, 'used enabled-skill-a,enabled-skill-b');
});

test('group chat non-Boss turns run only with metabot allow_chat_skills after attention gate passes', async () => {
  const { chatRoutingCalls, skillTurnCalls, broadcasts } = await runGroupCase('peer-global');

  assert.deepEqual(chatRoutingCalls, [{ allowChatSkills: ['chat-allowed-skill'] }]);
  assert.deepEqual(skillTurnCalls[0].activeSkillIds, ['chat-allowed-skill']);
  assert.equal(broadcasts[0].content, 'used chat-allowed-skill');
});

test('group chat non-Boss turns with empty allowlist use the normal LLM path', async () => {
  const { chatRoutingCalls, skillTurnCalls, broadcasts, performChatCompletionCalls } = await runGroupCase('peer-global', {
    metabot: { allow_chat_skills: [] },
  });

  assert.deepEqual(chatRoutingCalls, [{ allowChatSkills: [] }]);
  assert.equal(skillTurnCalls.length, 0);
  assert.equal(performChatCompletionCalls.length, 1);
  assert.equal(broadcasts.at(-1).content, 'llm reply');
});

test('group chat skips replies when attention gate does not trigger even for skill-like text', async () => {
  const { chatRoutingCalls, skillTurnCalls, broadcasts, performChatCompletionCalls } = await runGroupCase('peer-global', {
    task: {
      reply_on_mention: 1,
      random_reply_probability: 0,
    },
    messageContent: 'please use the chat skill',
  });

  assert.equal(chatRoutingCalls.length, 0);
  assert.equal(skillTurnCalls.length, 0);
  assert.equal(performChatCompletionCalls.length, 0);
  assert.equal(broadcasts.length, 0);
});
