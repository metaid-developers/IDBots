import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import MetaBotListCard from '../src/renderer/components/metabots/MetaBotListCard';
import type { Metabot } from '../src/renderer/types/metabot';

const baseMetabot = {
  id: 1,
  wallet_id: 11,
  mvc_address: '1BLoQMNePNqFMj4nJMoBa6BxvbikVGkEso',
  btc_address: 'btc-address',
  doge_address: 'doge-address',
  chat_public_key_pin_id: null,
  metabot_info_pinid: 'pin-1',
  name: 'AI_Sunny',
  avatar: null,
  enabled: true,
  metabot_type: 'worker',
  role: 'assistant',
  soul: 'helpful',
  goal: null,
  background: null,
  boss_id: null,
  boss_global_metaid: null,
  llm_id: null,
  tools: [],
  skills: [],
  created_at: 1,
  updated_at: 1,
  globalmetaid: 'idq14habcdefg9xz',
} as unknown as Metabot;

test('MetaBotListCard renders global meta id summary below the avatar with a copy action', () => {
  const markup = renderToStaticMarkup(
    <MetaBotListCard
      metabot={baseMetabot}
      onEdit={() => {}}
      onToggleEnabled={() => {}}
      onDelete={() => {}}
      isChainSynced
      onSyncToChain={() => {}}
    />,
  );

  assert.match(markup, /metaid:idq14h\.\.\.\.g9xz/);
  assert.match(markup, /title="复制 metaid"/);
});
