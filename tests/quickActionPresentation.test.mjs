import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildPromptPanelHeaderModel,
  resolveQuickActionPromptSkillMapping,
} from '../src/renderer/components/quick-actions/quickActionPresentation.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

async function readJson(relativePath) {
  const raw = await readFile(path.join(repoRoot, relativePath), 'utf8');
  return JSON.parse(raw);
}

function getAction(config, actionId) {
  return config.actions.find((action) => action.id === actionId);
}

function getPrompt(action, promptId) {
  return action.prompts.find((prompt) => prompt.id === promptId);
}

test('Prompt panel header shows title and back action when a quick action is selected', () => {
  assert.deepEqual(buildPromptPanelHeaderModel('发送链上信息'), {
    title: '发送链上信息',
    showBackButton: true,
  });
  assert.deepEqual(buildPromptPanelHeaderModel(''), {
    title: '',
    showBackButton: false,
  });
});

test('resolveQuickActionPromptSkillMapping prefers prompt mapping and falls back to action mapping', () => {
  const action = {
    id: 'chat',
    skillMapping: 'metabot-chat',
    prompts: [
      { id: 'open-chat-metaapp', skillMapping: null },
      { id: 'join-group', skillMapping: 'metabot-chat-groupchat' },
      { id: 'send-dm', skillMapping: 'metabot-chat-privatechat' },
      { id: 'group-reply-strategy' },
    ],
  };

  assert.equal(resolveQuickActionPromptSkillMapping(action, 'open-chat-metaapp'), null);
  assert.equal(resolveQuickActionPromptSkillMapping(action, 'join-group'), 'metabot-chat-groupchat');
  assert.equal(resolveQuickActionPromptSkillMapping(action, 'send-dm'), 'metabot-chat-privatechat');
  assert.equal(resolveQuickActionPromptSkillMapping(action, 'group-reply-strategy'), 'metabot-chat');
  assert.equal(resolveQuickActionPromptSkillMapping(action, 'missing'), 'metabot-chat');
});

test('quick action config maps local MetaApp openings to no skill and chat prompts to the requested skills', async () => {
  const config = await readJson('public/quick-actions.json');
  const i18n = await readJson('public/quick-actions-i18n.json');

  const readChain = getAction(config, 'read-chain');
  const chat = getAction(config, 'chat');
  const readChainI18n = i18n.zh['read-chain'];
  const chatI18n = i18n.zh.chat;

  assert.ok(readChain);
  assert.ok(chat);

  assert.equal(readChainI18n.label, '查看链上信息');
  assert.equal(chatI18n.label, '私聊和群聊');

  assert.equal(getPrompt(readChain, 'open-buzz-metaapp').skillMapping, null);
  assert.equal(readChainI18n.prompts['open-buzz-metaapp'].label, '打开本地元应用 Buzz');

  assert.equal(getPrompt(chat, 'open-chat-metaapp').skillMapping, null);
  assert.equal(chatI18n.prompts['open-chat-metaapp'].label, '打开元应用 Chat');
  assert.equal(getPrompt(chat, 'join-group').skillMapping, 'metabot-chat-groupchat');
  assert.equal(getPrompt(chat, 'send-dm').skillMapping, 'metabot-chat-privatechat');
  assert.equal(getPrompt(chat, 'group-reply-strategy').skillMapping, 'metabot-chat-groupchat');
});

test('more skill combos use the requested prompt labels and skill mappings', async () => {
  const config = await readJson('public/quick-actions.json');
  const i18n = await readJson('public/quick-actions-i18n.json');

  const action = getAction(config, 'more-skills');
  const zhPrompts = i18n.zh['more-skills'].prompts;

  assert.ok(action);

  assert.equal(getPrompt(action, 'weather-to-buzz').skillMapping, 'weather');
  assert.equal(zhPrompts['weather-to-buzz'].label, '获取天气并发送 buzz');

  assert.equal(getPrompt(action, 'develop-game-metaapp').skillMapping, 'metabot-create-metaapp');
  assert.equal(zhPrompts['develop-game-metaapp'].label, '开发一个游戏 MetaApp');

  assert.equal(getPrompt(action, 'tech-news-to-buzz').skillMapping, 'technology-news-search');
  assert.equal(zhPrompts['tech-news-to-buzz'].label, '将最新科技新闻发送 buzz');

  assert.equal(getPrompt(action, 'video-to-buzz').skillMapping, 'seedance');
  assert.equal(zhPrompts['video-to-buzz'].label, '制作一个视频并发送 buzz');
});
