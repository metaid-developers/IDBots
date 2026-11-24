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

test('MetaBotListCard renders global meta id summary with a copy action across tile and twinStrip variants', () => {
  const tileMarkup = renderToStaticMarkup(
    <MetaBotListCard
      metabot={baseMetabot}
      onEdit={() => {}}
      onToggleEnabled={() => {}}
      isChainSynced
      onSyncToChain={() => {}}
    />,
  );

  assert.match(tileMarkup, /idq14h…g9xz/);
  assert.match(tileMarkup, /title="Copy metaid"/);
  assert.match(tileMarkup, /aria-label="Copy metaid"/);

  const stripMarkup = renderToStaticMarkup(
    <MetaBotListCard
      variant="twinStrip"
      metabot={{ ...baseMetabot, metabot_type: 'twin' }}
      onEdit={() => {}}
      onToggleEnabled={() => {}}
      isChainSynced
      onSyncToChain={() => {}}
    />,
  );

  assert.match(stripMarkup, /metaid:idq14h…g9xz/);
  assert.match(stripMarkup, /title="Copy metaid"/);
});

test('MetaBotListCard shows the Twin badge only on the Twin bot', () => {
  const renderCard = (metabot: Metabot) =>
    renderToStaticMarkup(
      <MetaBotListCard
        metabot={metabot}
        onEdit={() => {}}
        onToggleEnabled={() => {}}
        isChainSynced
        onSyncToChain={() => {}}
      />,
    );

  const workerMarkup = renderCard(baseMetabot);
  assert.doesNotMatch(workerMarkup, /data-slot="metabot-twin-badge"/);

  const twinMarkup = renderCard({ ...baseMetabot, metabot_type: 'twin' });
  assert.match(twinMarkup, /data-slot="metabot-twin-badge"/);
});
