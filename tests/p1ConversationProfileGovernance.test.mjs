import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const require = Module.createRequire(import.meta.url);

const conversationProfile = require('../dist-electron/main/libs/conversationProfile.js');
const toolRegistry = require('../dist-electron/main/libs/toolCapabilityRegistry.js');
const promptComposer = require('../dist-electron/main/libs/promptComposer.js');

function loadWithMockedElectron(modulePath, language = 'en') {
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') {
      return {
        app: {
          getAppPath: () => repoRoot,
          getPath: () => repoRoot,
          getPreferredSystemLanguages: () => [language === 'zh' ? 'zh-CN' : 'en-US'],
          getLocale: () => (language === 'zh' ? 'zh-CN' : 'en-US'),
        },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const resolved = require.resolve(modulePath);
    delete require.cache[resolved];
    return require(resolved);
  } finally {
    Module._load = originalLoad;
  }
}

function extractAllRegisteredHostTools() {
  const libsDir = path.join(repoRoot, 'src', 'main', 'libs');
  const files = fs.readdirSync(libsDir).filter((file) => file.endsWith('AgentTools.ts') || file === 'coworkRunner.ts');
  const names = new Set();
  for (const file of files) {
    const src = fs.readFileSync(path.join(libsDir, file), 'utf8');
    for (const match of src.matchAll(/\b(?:tool|passthrough)\(\s*\n?\s*['"]([a-zA-Z0-9_]+)['"]/g)) {
      names.add(match[1]);
    }
    if (file.endsWith('AgentTools.ts')) {
      for (const match of src.matchAll(/\bname:\s*['"]([a-zA-Z0-9_]+)['"]/g)) {
        names.add(match[1]);
      }
    }
  }
  return [...names].sort();
}

test('CI invariant: every host and inline tool in src/main/libs declares a domain in TOOL_CAPABILITY_REGISTRY', () => {
  const discovered = extractAllRegisteredHostTools();
  assert.ok(discovered.length >= 230, `expected at least 230 registered tools, found ${discovered.length}`);

  const missing = discovered.filter((name) => !toolRegistry.TOOL_CAPABILITY_REGISTRY.has(name));
  assert.deepEqual(
    missing,
    [],
    `Unregistered tools found in src/main/libs — every tool MUST declare a domain in toolCapabilityRegistry.ts: ${missing.join(', ')}`,
  );

  // Also ensure built-in DSH tools and Playwright MCP prefix resolve cleanly.
  for (const builtin of ['bash', 'read', 'write', 'edit', 'glob', 'grep', 'read_image', 'web_search', 'web_fetch', 'subagent', 'send_message', 'list_subagent_models', 'list_agents', 'interrupt_agent', 'ask_user_question']) {
    assert.ok(toolRegistry.getToolCapabilitySpec(builtin), `DSH built-in "${builtin}" must declare a capability spec`);
  }
  const pwSpec = toolRegistry.getToolCapabilitySpec('mcp__playwright-mcp__browser_navigate');
  assert.equal(pwSpec?.domain, 'browser_automation');
  assert.equal(pwSpec?.expansion, 'automation');
});

test('ToolCapabilityRegistry: fail-closed visibility and desktopOnly derivation', () => {
  const {
    TOOL_CAPABILITY_REGISTRY,
    SERVER_MODE_DISABLED_AGENT_TOOLS,
    MOBILE_TOOL_EXPANSIONS,
    isMobileToolVisible,
    isToolAllowedForHostEnv,
    resolveToolMountPolicy,
  } = toolRegistry;

  // SERVER_MODE_DISABLED_AGENT_TOOLS is derived strictly from desktopOnly registry entries.
  const expectedDesktopOnly = new Set(
    [...TOOL_CAPABILITY_REGISTRY.entries()]
      .filter(([, spec]) => spec.desktopOnly === true)
      .map(([name]) => name),
  );
  assert.deepEqual(
    new Set(SERVER_MODE_DISABLED_AGENT_TOOLS),
    expectedDesktopOnly,
    'SERVER_MODE_DISABLED_AGENT_TOOLS must stay in 1:1 sync with desktopOnly registry specs',
  );

  // Fail-closed: unknown tools never pass mobile visibility, even with all expansions.
  assert.equal(isMobileToolVisible('unclassified_future_tool', []), false);
  assert.equal(isMobileToolVisible('unclassified_future_tool', MOBILE_TOOL_EXPANSIONS), false);
  assert.equal(isMobileToolVisible('mcp__user_custom__danger', MOBILE_TOOL_EXPANSIONS), false);

  // Previously leaked tools (goods_*, send_private_chat, post_simplequestion, start_new_im_session, twin_todo)
  // stay hidden from mobile core and only appear under their declared domain (or never for imOnly).
  assert.equal(isMobileToolVisible('goods_market_search', []), false);
  assert.equal(isMobileToolVisible('goods_market_search', ['financial']), true);
  assert.equal(isMobileToolVisible('send_private_chat', []), false);
  assert.equal(isMobileToolVisible('send_private_chat', ['social']), true);
  assert.equal(isMobileToolVisible('post_simplequestion', []), false);
  assert.equal(isMobileToolVisible('post_simplequestion', ['social']), true);
  assert.equal(isMobileToolVisible('twin_todo', []), false);
  assert.equal(isMobileToolVisible('twin_todo', ['orchestration']), true);
  assert.equal(isMobileToolVisible('start_new_im_session', MOBILE_TOOL_EXPANSIONS), false);

  // Welcome role gets metabot_list / metabot_create on Turn 1; standard/twin require orchestration expansion.
  assert.equal(isMobileToolVisible('metabot_list', [], { executionRole: 'welcome' }), true);
  assert.equal(isMobileToolVisible('metabot_create', [], { executionRole: 'welcome' }), true);
  assert.equal(isMobileToolVisible('metabot_create', [], { executionRole: 'standard' }), false);
  assert.equal(isMobileToolVisible('metabot_create', ['orchestration'], { executionRole: 'twin' }), true);

  // Host env eligibility.
  assert.equal(isToolAllowedForHostEnv('mobile_open_page', 'server'), true);
  assert.equal(isToolAllowedForHostEnv('mobile_open_page', 'desktop'), false);
  assert.equal(isToolAllowedForHostEnv('projection_begin', 'server'), false);
  assert.equal(isToolAllowedForHostEnv('projection_begin', 'desktop'), true);

  // Policy resolution: Studio slims workerEconomy & social; Mobile slims all 7 unless expanded.
  assert.deepEqual(
    resolveToolMountPolicy({ isStudioOwnerChat: true, isMobileOwnerChat: false }, []),
    { workerEconomy: false, financial: true, social: false, metaweb: true, orchestration: true, memoryAdvanced: true, automation: true },
  );
  assert.deepEqual(
    resolveToolMountPolicy({ isStudioOwnerChat: true, isMobileOwnerChat: true }, ['financial']),
    { workerEconomy: false, financial: true, social: false, metaweb: false, orchestration: false, memoryAdvanced: false, automation: false },
  );
});

test('ConversationProfile: single deterministic matrix across all surfaces and cross-surface transitions', () => {
  const { resolveConversationProfile } = conversationProfile;

  // 1. Desktop BotWorks (standard professional chat)
  const botworks = resolveConversationProfile({
    serverMode: false,
    session: { sessionType: 'standard', assistantMode: false, autoOrigin: null },
    sourceChannel: 'cowork_ui',
    executionRole: 'standard',
  });
  assert.equal(botworks.surface, 'desktop_botworks');
  assert.equal(botworks.interactionStyle, 'professional');
  assert.equal(botworks.isOwnerProgressChat, false);
  assert.equal(botworks.isStudioOwnerChat, false);
  assert.equal(botworks.isProjectorMode, false);
  assert.equal(botworks.isUnattendedAutomation, false);
  assert.equal(botworks.fastEffortMode, false);

  // 2. Desktop Studio Twin (projector right pane)
  const studioProjector = resolveConversationProfile({
    serverMode: false,
    session: { sessionType: 'browser', assistantMode: true, autoOrigin: null },
    sourceChannel: 'cowork_ui',
    executionRole: 'twin',
  });
  assert.equal(studioProjector.surface, 'desktop_studio');
  assert.equal(studioProjector.interactionStyle, 'owner_assistant');
  assert.equal(studioProjector.presentation, 'projector_right_pane');
  assert.equal(studioProjector.isStudioOwnerChat, true);
  assert.equal(studioProjector.isProjectorMode, true);
  assert.equal(studioProjector.isStudioTwinFrontOffice, true);
  assert.equal(studioProjector.isOwnerProgressChat, true);
  assert.equal(studioProjector.fastEffortMode, true);
  assert.equal(studioProjector.isUnattendedAutomation, false);

  // 3. Reopened Desktop Studio projector session on Cloud Mobile -> mobile_cloud shadows Studio flags
  const reopenedOnMobile = resolveConversationProfile({
    serverMode: true,
    session: { sessionType: 'browser', assistantMode: true, autoOrigin: null },
    sourceChannel: 'cowork_ui',
    executionRole: 'twin',
  });
  assert.equal(reopenedOnMobile.surface, 'mobile_cloud');
  assert.equal(reopenedOnMobile.presentation, 'mobile_phone');
  assert.equal(reopenedOnMobile.isMobileOwnerChat, true);
  assert.equal(reopenedOnMobile.isOwnerProgressChat, true);
  assert.equal(reopenedOnMobile.fastEffortMode, true);
  assert.equal(reopenedOnMobile.isStudioOwnerChat, false);
  assert.equal(reopenedOnMobile.isProjectorMode, false);
  assert.equal(reopenedOnMobile.isStudioTwinFrontOffice, false);
  assert.equal(reopenedOnMobile.isUnattendedAutomation, false);

  // 4. IM channel stored under 'a2a' stays interactive IM human chat
  const imDirect = resolveConversationProfile({
    serverMode: false,
    session: { sessionType: 'a2a', assistantMode: false, autoOrigin: null },
    sourceChannel: 'im:telegram:direct',
    executionRole: 'standard',
  });
  assert.equal(imDirect.surface, 'im_channel');
  assert.equal(imDirect.interactionStyle, 'im_human');
  assert.equal(imDirect.presentation, 'im_bridge');
  assert.equal(imDirect.isUnattendedAutomation, false);
  assert.equal(imDirect.isOwnerProgressChat, false);

  // 5. Desktop Bot Browser (non-assistant) runs unattended
  const botBrowser = resolveConversationProfile({
    serverMode: false,
    session: { sessionType: 'browser', assistantMode: false, autoOrigin: null },
    sourceChannel: 'cowork_ui',
  });
  assert.equal(botBrowser.surface, 'desktop_browser');
  assert.equal(botBrowser.isUnattendedAutomation, true);

  // 6. autoOrigin overrides everything (including assistantMode + cowork_ui + serverMode)
  const autoRun = resolveConversationProfile({
    serverMode: true,
    session: { sessionType: 'browser', assistantMode: true, autoOrigin: 'schedule' },
    sourceChannel: 'cowork_ui',
    executionRole: 'twin',
  });
  assert.equal(autoRun.surface, 'automation_unattended');
  assert.equal(autoRun.isUnattendedAutomation, true);
  assert.equal(autoRun.isMobileOwnerChat, false);
  assert.equal(autoRun.isStudioOwnerChat, false);
  assert.equal(autoRun.isProjectorMode, false);
  assert.equal(autoRun.isOwnerProgressChat, false);

  // 7. Unattended active marker (surf/study/practice)
  const surfRun = resolveConversationProfile({
    serverMode: false,
    session: { sessionType: 'standard', assistantMode: false, autoOrigin: null },
    sourceChannel: 'cowork_ui',
    isUnattendedActiveMarker: true,
  });
  assert.equal(surfRun.surface, 'automation_unattended');
  assert.equal(surfRun.isUnattendedAutomation, true);
});

test('Shared idbots:owner-interaction eliminates prompt duplication and links guidance to active capabilities', () => {
  const ownerPromptMod = loadWithMockedElectron('../dist-electron/main/libs/ownerInteractionPrompt.js', 'en');
  const assistantPromptMod = loadWithMockedElectron('../dist-electron/main/libs/assistantModePrompt.js', 'en');
  const mobilePromptMod = loadWithMockedElectron('../dist-electron/main/libs/mobileModePrompt.js', 'en');

  assert.ok(
    promptComposer.PROMPT_SECTION_ORDER.OWNER_INTERACTION > promptComposer.PROMPT_SECTION_ORDER.BASE
      && promptComposer.PROMPT_SECTION_ORDER.OWNER_INTERACTION < promptComposer.PROMPT_SECTION_ORDER.ASSISTANT_MODE,
    'OWNER_INTERACTION order must sit strictly between BASE (50) and ASSISTANT_MODE/MOBILE_MODE (55)',
  );

  // Studio composed prompt: shared rules appear ONCE, never duplicated across owner-interaction + assistant-mode.
  const studioShared = ownerPromptMod.buildOwnerInteractionPrompt({
    surface: 'desktop_studio',
    presentation: 'projector_right_pane',
    hasOwnerUpdate: true,
    hasProjector: true,
    hasDesktopBrowser: true,
    hasWebSearch: true,
  });
  const studioSpecific = assistantPromptMod.buildAssistantModePrompt(true, { includeSharedOwnerRules: false });
  const studioComposed = promptComposer.composePromptSections([
    { name: 'idbots:base', order: promptComposer.PROMPT_SECTION_ORDER.BASE, text: 'Base prompt' },
    { name: 'idbots:owner-interaction', order: promptComposer.PROMPT_SECTION_ORDER.OWNER_INTERACTION, text: studioShared },
    { name: 'idbots:assistant-mode', order: promptComposer.PROMPT_SECTION_ORDER.ASSISTANT_MODE, text: studioSpecific },
    { name: 'idbots:projector-mode', order: promptComposer.PROMPT_SECTION_ORDER.PROJECTOR_MODE, text: assistantPromptMod.buildProjectorModePrompt() },
  ]);
  assert.equal((studioComposed.match(/owner_update\(\{ message, kind \}\)/g) ?? []).length, 1);
  assert.equal((studioComposed.match(/NEVER open with a bare acknowledgment/g) ?? []).length, 1);
  assert.equal((studioComposed.match(/call conversation_recall before answering/g) ?? []).length, 1);
  assert.match(studioComposed, /right-pane projector via projection_begin/);

  // Mobile composed prompt: shared rules appear ONCE, reflects active expansions, excludes desktop projector prose.
  const mobileSharedSlim = ownerPromptMod.buildOwnerInteractionPrompt({
    surface: 'mobile_cloud',
    presentation: 'mobile_phone',
    hasOwnerUpdate: true,
    hasProjector: false,
    hasDesktopBrowser: false,
    hasWebSearch: true,
    mobileExpansions: [],
  });
  const mobileSpecific = mobilePromptMod.buildMobileModePrompt({ includeSharedOwnerRules: false });
  const mobileComposedSlim = promptComposer.composePromptSections([
    { name: 'idbots:base', order: promptComposer.PROMPT_SECTION_ORDER.BASE, text: 'Base prompt' },
    { name: 'idbots:owner-interaction', order: promptComposer.PROMPT_SECTION_ORDER.OWNER_INTERACTION, text: mobileSharedSlim },
    { name: 'idbots:mobile-mode', order: promptComposer.PROMPT_SECTION_ORDER.MOBILE_MODE, text: mobileSpecific },
  ]);
  assert.equal((mobileComposedSlim.match(/owner_update\(\{ message, kind \}\)/g) ?? []).length, 1);
  assert.equal((mobileComposedSlim.match(/NEVER open with a bare acknowledgment/g) ?? []).length, 1);
  assert.equal((mobileComposedSlim.match(/call conversation_recall before answering/g) ?? []).length, 1);
  assert.match(mobileComposedSlim, /minimal mobile core tool set/);
  assert.doesNotMatch(mobileComposedSlim, /## Projector Mode|HTML visual reports|Embedded MetaApps/);

  // Capability linkage: expanded domains reflect in the prompt, and disabling owner_update removes its protocol.
  const mobileSharedExpanded = ownerPromptMod.buildOwnerInteractionPrompt({
    surface: 'mobile_cloud',
    presentation: 'mobile_phone',
    hasOwnerUpdate: false,
    hasProjector: false,
    hasDesktopBrowser: false,
    hasWebSearch: false,
    mobileExpansions: ['financial', 'metaweb'],
  });
  assert.match(mobileSharedExpanded, /Active domain expansions for this turn: financial, metaweb/);
  assert.doesNotMatch(mobileSharedExpanded, /owner_update\(\{ message, kind \}\)/);
});
