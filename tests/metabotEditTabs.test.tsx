import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import MetaBotEditTabs, {
  EDIT_TAB_FIELDS,
  EDIT_TAB_SYNC_GROUPS,
  normalizeA2AAutoReplyEnabledOption,
  type MetaBotEditValues,
} from '../src/renderer/components/metabots/MetaBotEditTabs';
import {
  composeHomepageForSave,
  type HomepageSectionValues,
} from '../src/renderer/components/metabots/MetaBotHomepageSection';
import { configService } from '../src/renderer/services/config';
import { i18nService } from '../src/renderer/services/i18n';
import type { AppConfig } from '../src/renderer/config';

// The model+effort picker reads the live app_config; seed the in-memory
// singleton so the catalog has providers in the Node test environment.
(configService as unknown as { config: AppConfig }).config = {
  ...(configService.getConfig() as AppConfig),
  providers: {
    codex: {
      enabled: true,
      apiKey: 'sk-test',
      baseUrl: 'https://codex.example.com/v1',
      apiFormat: 'openai',
      models: [{ id: 'codex-mini', name: 'Codex Mini' }],
    },
  } as AppConfig['providers'],
};

const baseInitialValues: Partial<MetaBotEditValues> = {
  name: 'Alice Bot',
  role: 'Assistant',
  soul: 'Direct',
  goal: 'Help',
  bio: 'Bio',
  llm_id: 'codex',
  fallback_llm_id: '',
  homepage_source: 'default',
  homepage_metaapp_pin: '',
  homepage_metafile_uri: '',
  homepage_metafile_content_type: '',
  homepage_initial: null,
};

function renderTabsMarkup(
  initialValues: Partial<MetaBotEditValues> = {},
  skillOptions: Array<import('../src/renderer/types/skill').Skill> = [],
) {
  return renderToStaticMarkup(
    <MetaBotEditTabs
      initialValues={{ ...baseInitialValues, ...initialValues }}
      metabotId={1}
      onCancel={() => {}}
      onSaveTab={async () => {}}
      llmOptions={[{ id: 'codex', label: 'Codex' }]}
      skillOptions={skillOptions}
      onOpenDefaultHomepage={() => {}}
      onPreviewMetaAppHomepage={() => true}
    />,
  );
}

/** Slice one panel's markup: from its data-slot marker to the next panel's marker (or end). */
function panelMarkup(markup: string, tab: string): string {
  const marker = `data-slot="metabot-edit-panel-${tab}"`;
  const start = markup.indexOf(marker);
  assert.ok(start >= 0, `panel ${tab} should render`);
  const rest = markup.slice(start);
  const nextPanel = rest.indexOf('data-slot="metabot-edit-panel-', marker.length);
  return nextPanel > 0 ? rest.slice(0, nextPanel) : rest;
}

const homepageValues = (overrides: Partial<HomepageSectionValues>): HomepageSectionValues => ({
  homepage_source: 'default',
  homepage_metafile_uri: '',
  homepage_metafile_content_type: '',
  homepage_metaapp_pin: '',
  ...overrides,
});

test('MetaBot edit tabs render all four tab buttons in order', () => {
  const markup = renderTabsMarkup();

  const basic = markup.indexOf('data-slot="metabot-edit-tab-basic"');
  const persona = markup.indexOf('data-slot="metabot-edit-tab-persona"');
  const chatSettings = markup.indexOf('data-slot="metabot-edit-tab-chatSettings"');
  const advanced = markup.indexOf('data-slot="metabot-edit-tab-advanced"');

  assert.ok(basic >= 0 && persona >= 0 && chatSettings >= 0 && advanced >= 0, 'all four tabs render');
  assert.ok(basic < persona && persona < chatSettings && chatSettings < advanced, 'tab order is basic/persona/chatSettings/advanced');
});

test('Basic panel hosts identity, owner and LLM fields plus its own save button', () => {
  const panel = panelMarkup(renderTabsMarkup(), 'basic');

  assert.match(panel, /id="metabot-name"/);
  assert.match(panel, /id="metabot-bio"/);
  assert.match(panel, /id="metabot-boss-metaid"/);
  assert.match(panel, /id="metabot-llm"/);
  assert.match(panel, /id="metabot-fallback-llm"/);
  assert.match(panel, /data-slot="metabot-edit-save-basic"/);
});

test('Persona panel keeps role/soul/goal optional with no required markers', () => {
  const panel = panelMarkup(renderTabsMarkup(), 'persona');

  assert.match(panel, /id="metabot-role"/);
  assert.match(panel, /id="metabot-soul"/);
  assert.match(panel, /id="metabot-goal"/);
  assert.match(panel, /data-slot="metabot-edit-save-persona"/);
  assert.doesNotMatch(panel, /<span class="ml-1 text-red-500">/);
});

test('Chat Settings panel hosts the allow-chat-skills editor and Advanced panel the homepage section', () => {
  const markup = renderTabsMarkup();

  const chatPanel = panelMarkup(markup, 'chatSettings');
  assert.match(chatPanel, /data-slot="metabot-a2a-auto-reply-switch"/);
  assert.match(chatPanel, /aria-checked="true"/);
  // OpenTeam remote-collab switch: immediate-effect kv toggle, not part of EDIT_TAB_FIELDS.
  assert.match(chatPanel, /data-slot="metabot-openteam-remote-collab-switch"/);
  assert.match(chatPanel, /id="metabot-allow-chat-skills"/);
  assert.match(chatPanel, /id="metabot-a2a-max-turns"/);
  assert.match(chatPanel, /id="metabot-a2a-bye-cooldown"/);
  assert.match(chatPanel, /data-slot="metabot-edit-save-chatSettings"/);

  const advancedPanel = panelMarkup(markup, 'advanced');
  assert.match(advancedPanel, /data-slot="metabot-homepage-control-row"/);
  assert.match(advancedPanel, /data-slot="metabot-edit-save-advanced"/);
});

test('Chat Settings panel lists bundled skills read-only and keeps them out of the assign picker', () => {
  const skillOptions = [
    { id: 'seedream', name: 'seedream', description: 'img', enabled: true, isOfficial: true, isBuiltIn: true, updatedAt: 1, prompt: 'p', skillPath: '/x' },
    { id: 'docx', name: 'docx', description: 'doc', enabled: true, isOfficial: true, isBuiltIn: true, updatedAt: 1, prompt: 'p', skillPath: '/x' },
    { id: 'baoyu-image-studio', name: 'baoyu-image-studio', description: 'third-party', enabled: true, isOfficial: false, isBuiltIn: false, updatedAt: 1, prompt: 'p', skillPath: '/x' },
    { id: 'disabled-bundled', name: 'disabled-bundled', description: 'off', enabled: false, isOfficial: true, isBuiltIn: true, updatedAt: 1, prompt: 'p', skillPath: '/x' },
  ] as Array<import('../src/renderer/types/skill').Skill>;

  const chatPanel = panelMarkup(renderTabsMarkup({}, skillOptions), 'chatSettings');

  // Read-only bundled section present with only the enabled built-in skills.
  assert.ok(chatPanel.includes('data-slot="metabot-bundled-skills"'), 'bundled skills section renders');
  assert.match(chatPanel, /data-slot="metabot-bundled-skills-list"/);
  assert.match(chatPanel, /seedream/);
  assert.match(chatPanel, /docx/);

  // The assign picker still excludes built-ins; the third-party skill stays assignable.
  const pickerOptions = chatPanel.slice(chatPanel.indexOf('id="metabot-allow-chat-skills"'), chatPanel.indexOf('data-slot="metabot-bundled-skills"'));
  assert.match(pickerOptions, /baoyu-image-studio/);
  assert.doesNotMatch(pickerOptions, /seedream/);

  // No bundled section when the library has no enabled built-in skills.
  const externalOnly = renderTabsMarkup({}, [skillOptions[2]]);
  assert.doesNotMatch(externalOnly, /data-slot="metabot-bundled-skills"/);
});

test('tab field and sync group mappings pin each editable field to its tab', () => {
  assert.deepEqual(EDIT_TAB_FIELDS.basic, ['name', 'avatar', 'bio', 'metabot_type', 'boss_global_metaid', 'llm_id', 'llm_provider', 'llm_effort', 'fallback_llm_id', 'fallback_llm_provider', 'fallback_llm_effort']);
  assert.deepEqual(EDIT_TAB_FIELDS.persona, ['role', 'soul', 'goal']);
  assert.deepEqual(EDIT_TAB_FIELDS.chatSettings, ['allow_chat_skills', 'a2a_max_incoming_turns', 'a2a_bye_cooldown_ms', 'a2a_auto_reply_enabled']);
  assert.deepEqual(EDIT_TAB_FIELDS.advanced, ['homepage_source', 'homepage_metafile_uri', 'homepage_metafile_content_type', 'homepage_metaapp_pin']);

  assert.deepEqual(EDIT_TAB_SYNC_GROUPS.basic, ['name', 'avatar', 'bio', 'owner', 'llm']);
  assert.deepEqual(EDIT_TAB_SYNC_GROUPS.persona, ['persona']);
  assert.deepEqual(EDIT_TAB_SYNC_GROUPS.chatSettings, ['chatSkills']);
  assert.deepEqual(EDIT_TAB_SYNC_GROUPS.advanced, ['homepage']);

  // The Twin/Worker role is editable on the Basic tab but never published on-chain.
  const allSyncGroups = Object.values(EDIT_TAB_SYNC_GROUPS).flat();
  assert.ok(!allSyncGroups.includes('metabot_type'), 'metabot_type must stay out of the chain sync groups');
  // A2A chat limits are local-only runtime knobs and must also stay off-chain.
  assert.ok(!allSyncGroups.includes('a2a_max_incoming_turns'), 'a2a_max_incoming_turns must stay out of the chain sync groups');
  assert.ok(!allSyncGroups.includes('a2a_bye_cooldown_ms'), 'a2a_bye_cooldown_ms must stay out of the chain sync groups');
});

test('A2A auto-reply: an unstored (null/undefined) value defaults to ON for every bot', () => {
  assert.equal(normalizeA2AAutoReplyEnabledOption(null), true);
  assert.equal(normalizeA2AAutoReplyEnabledOption(undefined), true);
  assert.equal(normalizeA2AAutoReplyEnabledOption(1), true);
  assert.equal(normalizeA2AAutoReplyEnabledOption(0), false);
  assert.equal(normalizeA2AAutoReplyEnabledOption(true), true);
  assert.equal(normalizeA2AAutoReplyEnabledOption(false), false);

  // The edit form renders the switch checked when the bot has no stored value.
  const panel = panelMarkup(renderTabsMarkup({ a2a_auto_reply_enabled: normalizeA2AAutoReplyEnabledOption(null) }), 'chatSettings');
  assert.match(panel, /data-slot="metabot-a2a-auto-reply-switch"/);
  assert.match(panel, /aria-checked="true"/);
});

test('Basic panel renders the Twin switch, demote-confirm enabled for the current Twin', () => {
  const workerPanel = panelMarkup(renderTabsMarkup({ metabot_type: 'worker' }), 'basic');
  assert.match(workerPanel, /data-slot="metabot-twin-switch"/);
  assert.match(workerPanel, /role="switch"/);
  assert.match(workerPanel, /aria-checked="false"/);
  assert.doesNotMatch(workerPanel, /aria-disabled="true"/);

  // Since 0569a147 the switch is never aria-disabled: for the current Twin it
  // stays clickable and opens the demote-confirm dialog so the seat can be
  // vacated (steal-by-promotion is refused with TWIN_ALREADY_EXISTS instead).
  const twinPanel = panelMarkup(renderTabsMarkup({ metabot_type: 'twin' }), 'basic');
  assert.match(twinPanel, /data-slot="metabot-twin-switch"/);
  assert.match(twinPanel, /aria-checked="true"/);
  assert.doesNotMatch(twinPanel, /aria-disabled="true"/);
  assert.ok(twinPanel.includes(i18nService.t('metabotTwinSwitchHintCurrent')), 'current-twin hint rendered');
});

test('composeHomepageForSave builds protocol JSON and rejects invalid pins', () => {
  assert.equal(composeHomepageForSave(homepageValues({ homepage_source: 'default' })), null);

  const metafile = composeHomepageForSave(homepageValues({
    homepage_source: 'metafile',
    homepage_metafile_uri: 'metafile://pin-1.html',
    homepage_metafile_content_type: 'text/html',
  }));
  assert.deepEqual(JSON.parse(metafile as string), {
    uri: 'metafile://pin-1.html',
    renderer: 'auto',
    contentType: 'text/html',
  });

  const metaapp = composeHomepageForSave(homepageValues({
    homepage_source: 'metaapp',
    homepage_metaapp_pin: 'metaapp://pin-2',
  }));
  assert.deepEqual(JSON.parse(metaapp as string), {
    uri: 'metaapp://pin-2',
    renderer: 'metaapp',
    contentType: 'application/vnd.metaapp',
  });

  assert.throws(() => composeHomepageForSave(homepageValues({ homepage_source: 'metafile' })));
  assert.throws(() => composeHomepageForSave(homepageValues({ homepage_source: 'metaapp', homepage_metaapp_pin: 'a b' })));
});

test('Basic panel shows follow-global reset when primary llm_id is set and enables fallback setup when cleared', () => {
  const withPrimary = panelMarkup(renderTabsMarkup({ llm_id: 'codex-mini', llm_provider: 'codex' }), 'basic');
  assert.match(withPrimary, /data-slot="metabot-clear-primary-llm"/);

  const followingGlobal = panelMarkup(renderTabsMarkup({ llm_id: '', llm_provider: '' }), 'basic');
  assert.doesNotMatch(followingGlobal, /data-slot="metabot-clear-primary-llm"/);
  assert.ok(
    followingGlobal.includes(i18nService.t('metabotPrimaryLlmFollowGlobalEmpty')),
    'primary picker should show follow-global placeholder when llm_id is empty',
  );
  // Fallback setup button remains enabled when primary follows global default.
  const fallbackMatch = /<button[^>]*id="metabot-fallback-llm"[^>]*>/.exec(followingGlobal);
  assert.ok(fallbackMatch, 'fallback setup button renders');
  const attrOnly = fallbackMatch[0].replace(/\sclass="[^"]*"/, '');
  assert.doesNotMatch(attrOnly, /\bdisabled\b/);
});

