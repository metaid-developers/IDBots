import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import MetaBotHomepageSection, {
  type HomepageSectionValues,
} from '../src/renderer/components/metabots/MetaBotHomepageSection';
import MetaBotListCard from '../src/renderer/components/metabots/MetaBotListCard';
import MetaBotEditTabs from '../src/renderer/components/metabots/MetaBotEditTabs';
import MetaBotCreateForm from '../src/renderer/components/metabots/MetaBotCreateForm';
import type { Metabot } from '../src/renderer/types/metabot';

const homepageSectionPath = new URL('../src/renderer/components/metabots/MetaBotHomepageSection.tsx', import.meta.url);

const baseValues: HomepageSectionValues = {
  homepage_source: 'default',
  homepage_metaapp_pin: '',
  homepage_metafile_uri: '',
  homepage_metafile_content_type: '',
};

function renderHomepageMarkup(values: Partial<HomepageSectionValues>) {
  return renderToStaticMarkup(
    <MetaBotHomepageSection
      values={{ ...baseValues, ...values }}
      onChange={() => {}}
      metabotId={1}
      onOpenDefaultHomepage={() => {}}
      onPreviewMetaAppHomepage={() => true}
      onRequestMetaApps={() => {}}
    />,
  );
}

function homepageControlRow(markup: string): string {
  const match = markup.match(/<div data-slot="metabot-homepage-control-row"[\s\S]*?<p data-slot="metabot-homepage-hint"/);
  assert.ok(match, 'Homepage controls should render in a dedicated row before the hint');
  return match[0];
}

test('MetaBot Homepage default template keeps source and view action in one control row', () => {
  const row = homepageControlRow(renderHomepageMarkup({ homepage_source: 'default' }));

  assert.match(row, /<select[^>]*id="metabot-homepage"/);
  assert.match(row, /<button[^>]*data-slot="metabot-homepage-view"/);
  assert.ok(row.indexOf('id="metabot-homepage"') < row.indexOf('data-slot="metabot-homepage-view"'));
  assert.doesNotMatch(row, /\bspace-y-2\b/);
});

test('MetaBot Homepage MetaApp source keeps pin input next to the source selector', () => {
  const row = homepageControlRow(renderHomepageMarkup({
    homepage_source: 'metaapp',
    homepage_metaapp_pin: 'metaapp-pin-123',
  }));

  assert.match(row, /<select[^>]*id="metabot-homepage"/);
  assert.match(row, /<input[^>]*data-slot="metabot-homepage-metaapp-pin"/);
  assert.match(row, /<button[^>]*data-slot="metabot-homepage-metaapp-select"/);
  assert.match(row, /<button[^>]*data-slot="metabot-homepage-metaapp-preview"/);
  assert.ok(row.indexOf('id="metabot-homepage"') < row.indexOf('data-slot="metabot-homepage-metaapp-pin"'));
  assert.ok(row.indexOf('data-slot="metabot-homepage-metaapp-pin"') < row.indexOf('data-slot="metabot-homepage-metaapp-select"'));
  assert.doesNotMatch(row, /\bspace-y-2\b/);
});

test('MetaBot Homepage MetaFile source keeps pin input and upload action next to the source selector', () => {
  const row = homepageControlRow(renderHomepageMarkup({ homepage_source: 'metafile' }));

  assert.match(row, /<select[^>]*id="metabot-homepage"/);
  assert.match(row, /<input[^>]*data-slot="metabot-homepage-metafile-pin"/);
  assert.match(row, /<button[^>]*data-slot="metabot-homepage-metafile-upload"/);
  assert.ok(row.indexOf('id="metabot-homepage"') < row.indexOf('data-slot="metabot-homepage-metafile-pin"'));
  assert.ok(row.indexOf('data-slot="metabot-homepage-metafile-pin"') < row.indexOf('data-slot="metabot-homepage-metafile-upload"'));
  assert.doesNotMatch(row, /\bspace-y-2\b/);
});

test('MetaBot Homepage MetaApp selector loads the current bot owner MetaApps', () => {
  const source = fs.readFileSync(homepageSectionPath, 'utf8');

  assert.match(source, /window\.electron\.metaappOwner\.list\(\{\s*metabotId,\s*size:\s*24\s*\}\)/);
  assert.match(source, /setHomepageMetaAppPickerOpen\(true\)/);
  assert.match(source, /handleChange\('homepage_metaapp_pin',\s*record\.pinId\)/);
});

const sampleMetabot: Metabot = {
  id: 1,
  wallet_id: 1,
  mvc_address: '1BoatSLRHtKNngkdXEeobR76b53LETtpyT',
  btc_address: 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh',
  doge_address: 'D7Y55r6h1V56b2g2883kL7v89oPqRsTuVw',
  public_key: '02abcdef',
  chat_public_key: '04abcdef',
  chat_public_key_pin_id: 'chatpin0',
  name: 'AI_Sunny',
  avatar: null,
  enabled: true,
  metaid: 'metaid123',
  globalmetaid: 'idq1c9fe82a109c77d8f2a',
  metabot_info_pinid: 'infopin0',
  metabot_type: 'twin',
  role: 'Chief of Staff',
  soul: 'Calm and concise',
  goal: 'Coordinate local workers and daily briefings',
  llm_id: 'claude-sonnet-4-5',
  created_at: 1_700_000_000,
  updated_at: 1_700_000_000,
};

test('Studio Linear MetaBotListCard renders both twinStrip and worker tile variants cleanly', () => {
  const twinHtml = renderToStaticMarkup(
    <MetaBotListCard
      variant="twinStrip"
      metabot={{ ...sampleMetabot, surfing: true }}
      onEdit={() => {}}
      onToggleEnabled={() => {}}
      isChainSynced
      chainSyncState="synced"
      onSyncToChain={() => {}}
      onOpenMetabotInBrowser={() => {}}
    />,
  );
  assert.match(twinHtml, /AI_Sunny/);
  assert.match(twinHtml, /data-slot="metabot-twin-badge"/);
  assert.match(twinHtml, /idq1c9…8f2a/);

  const partialWorkerHtml = renderToStaticMarkup(
    <MetaBotListCard
      variant="tile"
      metabot={{ ...sampleMetabot, id: 2, name: 'Design_Muse', metabot_type: 'worker', dreaming: true }}
      onEdit={() => {}}
      onToggleEnabled={() => {}}
      isChainSynced={false}
      chainSyncState="partial"
      onSyncToChain={() => {}}
    />,
  );
  assert.match(partialWorkerHtml, /Design_Muse/);
  assert.doesNotMatch(partialWorkerHtml, /data-slot="metabot-twin-badge"/);
});

test('Studio Linear MetaBotEditTabs mounts all 6 tabs with scoped homepage save and Twin daily report', () => {
  const html = renderToStaticMarkup(
    <MetaBotEditTabs
      headerSlot={<div data-slot="test-edit-header">AI_Sunny</div>}
      metabotId={1}
      initialValues={{ name: 'AI_Sunny', metabot_type: 'twin' }}
      onCancel={() => {}}
      onSaveTab={async () => {}}
      llmOptions={[{ id: 'anthropic', label: 'Anthropic' }]}
      skillOptions={[
        { id: 'ext-skill', name: 'Ext Skill', description: '', enabled: true, isofficial: false, isBuiltIn: false, updatedAt: 0, prompt: '', skillPath: '' },
        { id: 'builtin-skill', name: 'Builtin Skill', description: '', enabled: true, isofficial: true, isBuiltIn: true, updatedAt: 0, prompt: '', skillPath: '' },
      ]}
      metabot={sampleMetabot}
      onDelete={() => {}}
    />,
  );

  assert.match(html, /data-slot="test-edit-header"/);
  for (const tab of ['basic', 'persona', 'chatSettings', 'knowledgeBase', 'surf', 'advanced']) {
    assert.match(html, new RegExp(`data-slot="metabot-edit-tab-${tab}"`));
    assert.match(html, new RegExp(`data-slot="metabot-edit-panel-${tab}"`));
  }
  assert.match(html, /data-slot="metabot-edit-save-advanced"/);
  assert.match(html, /data-slot="metabot-daily-report-section"/);
  assert.match(html, /data-slot="metabot-advanced-chain-wallet-card"/);
  assert.match(html, /data-slot="metabot-advanced-danger-card"/);

  const createHtml = renderToStaticMarkup(
    <MetaBotCreateForm
      onCancel={() => {}}
      onSave={async () => {}}
      llmOptions={[{ id: 'anthropic', label: 'Anthropic' }]}
    />,
  );
  assert.match(createHtml, /data-slot="metabot-archetype-select"/);
});
