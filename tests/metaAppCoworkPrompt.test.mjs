import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const createTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-metaapp-cowork-'));

const writeFile = (filePath, content) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
};

const withMetaAppsRoot = (root, run) => {
  const previous = process.env.IDBOTS_METAAPPS_ROOT;
  process.env.IDBOTS_METAAPPS_ROOT = root;
  try {
    return run();
  } finally {
    if (previous == null) {
      delete process.env.IDBOTS_METAAPPS_ROOT;
    } else {
      process.env.IDBOTS_METAAPPS_ROOT = previous;
    }
  }
};

test('buildCoworkAutoRoutingPrompt emits the MetaApps section with available_metaapps entries', () => {
  const { MetaAppManager } = require('../dist-electron/metaAppManager.js');
  const tempDir = createTempDir();
  const metaAppsRoot = path.join(tempDir, 'METAAPPs');

  writeFile(
    path.join(metaAppsRoot, 'buzz', 'APP.md'),
    [
      '---',
      'name: buzz-app',
      'description: Browse buzz timelines',
      'entry: /buzz/app/index.html',
      '---',
      '',
      'Open the local buzz timeline.',
    ].join('\n'),
  );
  writeFile(path.join(metaAppsRoot, 'buzz', 'app', 'index.html'), '<html>buzz</html>');

  writeFile(
    path.join(metaAppsRoot, 'chat', 'APP.md'),
    [
      '---',
      'name: chat-app',
      'description: Open direct chat',
      'entry: /chat/app/index.html',
      '---',
      '',
      'Open the local chat view.',
    ].join('\n'),
  );
  writeFile(path.join(metaAppsRoot, 'chat', 'app', 'index.html'), '<html>chat</html>');

  const prompt = withMetaAppsRoot(metaAppsRoot, () => new MetaAppManager().buildCoworkAutoRoutingPrompt());

  assert.ok(prompt);
  assert.match(prompt, /## MetaApps \(Cowork\)/);
  assert.match(prompt, /<available_metaapps>/);
  assert.match(prompt, /<id>buzz<\/id>/);
  assert.match(prompt, /<name>buzz-app<\/name>/);
  assert.match(prompt, /<entry>\/buzz\/app\/index\.html<\/entry>/);
  assert.match(prompt, /<id>chat<\/id>/);
  assert.match(prompt, /<name>chat-app<\/name>/);
  assert.match(prompt, /<\/available_metaapps>/);
});

test('CoworkRunner registers the open_metaapp tool when starting a local Claude session', async () => {
  const electronModuleId = require.resolve('electron');
  const originalElectronExports = require.cache[electronModuleId]?.exports ?? require('electron');
  require.cache[electronModuleId] = {
    ...require.cache[electronModuleId],
    exports: {
      app: {
        isPackaged: false,
        getPath: () => os.tmpdir(),
        getAppPath: () => process.cwd(),
      },
    },
  };

  const claudeSdk = require('../dist-electron/libs/claudeSdk.js');
  const claudeSettings = require('../dist-electron/libs/claudeSettings.js');
  const coworkUtil = require('../dist-electron/libs/coworkUtil.js');
  const { CoworkRunner } = require('../dist-electron/libs/coworkRunner.js');

  const originalLoadClaudeSdk = claudeSdk.loadClaudeSdk;
  const originalGetCurrentApiConfig = claudeSettings.getCurrentApiConfig;
  const originalGetClaudeCodePath = claudeSettings.getClaudeCodePath;
  const originalGetEnhancedEnvWithTmpdir = coworkUtil.getEnhancedEnvWithTmpdir;

  const toolCalls = [];
  const openMetaAppCalls = [];

  claudeSdk.loadClaudeSdk = async () => ({
    query: async () => (async function* emptyEvents() {})(),
    createSdkMcpServer: (config) => config,
    tool: (name, description, schema, handler) => {
      const record = { name, description, schema, handler };
      toolCalls.push(record);
      return record;
    },
  });
  claudeSettings.getCurrentApiConfig = () => ({ apiKey: 'test', model: 'claude-test' });
  claudeSettings.getClaudeCodePath = () => '/tmp/fake-claude-code';
  coworkUtil.getEnhancedEnvWithTmpdir = async () => ({});

  const sessionId = 'session-metaapp-tool';
  const store = {
    session: {
      id: sessionId,
      status: 'running',
      claudeSessionId: null,
    },
    updates: [],
    getConfig() {
      return { executionMode: 'local' };
    },
    getSession(id) {
      return id === this.session.id ? this.session : null;
    },
    updateSession(id, patch) {
      assert.equal(id, this.session.id);
      this.updates.push(patch);
      Object.assign(this.session, patch);
    },
    getMemoryBackend() {
      return {
        getEffectiveMemoryPolicyForSession() {
          return {
            memoryEnabled: false,
            memoryImplicitUpdateEnabled: false,
            memoryLlmJudgeEnabled: false,
            memoryGuardLevel: 'strict',
            memoryUserMemoriesMaxItems: 12,
          };
        },
      };
    },
  };

  const runner = new CoworkRunner(store, {
    openMetaApp: async (input) => {
      openMetaAppCalls.push(input);
      return {
        success: true,
        name: 'buzz-app',
        url: 'http://127.0.0.1:38421/buzz/app/index.html?view=hot',
      };
    },
  });

  const activeSession = {
    sessionId,
    claudeSessionId: null,
    workspaceRoot: process.cwd(),
    confirmationMode: 'modal',
    pendingPermission: null,
    abortController: new AbortController(),
    currentStreamingMessageId: null,
    currentStreamingContent: '',
    currentStreamingThinkingMessageId: null,
    currentStreamingThinking: '',
    currentStreamingBlockType: null,
    currentStreamingTextTruncated: false,
    currentStreamingThinkingTruncated: false,
    lastStreamingTextUpdateAt: 0,
    lastStreamingThinkingUpdateAt: 0,
    hasAssistantTextOutput: false,
    hasAssistantThinkingOutput: false,
    staleResumeDetected: false,
    staleResumeRetryAllowed: true,
    executionMode: 'local',
  };

  try {
    await runner.runClaudeCodeLocal(activeSession, 'open the buzz app', process.cwd(), 'metaapp prompt');
  } finally {
    require.cache[electronModuleId] = {
      ...require.cache[electronModuleId],
      exports: originalElectronExports,
    };
    claudeSdk.loadClaudeSdk = originalLoadClaudeSdk;
    claudeSettings.getCurrentApiConfig = originalGetCurrentApiConfig;
    claudeSettings.getClaudeCodePath = originalGetClaudeCodePath;
    coworkUtil.getEnhancedEnvWithTmpdir = originalGetEnhancedEnvWithTmpdir;
  }

  const openMetaAppTool = toolCalls.find((entry) => entry.name === 'open_metaapp');
  assert.ok(openMetaAppTool, 'Expected open_metaapp to be registered');
  assert.equal(openMetaAppTool.description, 'Open a local MetaApp by app id and optional target path.');
  assert.equal(openMetaAppTool.schema.appId.safeParse('buzz-app').success, true);
  assert.equal(openMetaAppTool.schema.appId.safeParse('').success, false);
  assert.equal(openMetaAppTool.schema.targetPath.safeParse(undefined).success, true);
  assert.equal(openMetaAppTool.schema.targetPath.safeParse('/buzz/app/index.html?view=hot').success, true);

  const toolResult = await openMetaAppTool.handler({
    appId: 'buzz-app',
    targetPath: '/buzz/app/index.html?view=hot',
  });

  assert.deepEqual(openMetaAppCalls, [
    {
      appId: 'buzz-app',
      targetPath: '/buzz/app/index.html?view=hot',
    },
  ]);
  assert.deepEqual(toolResult, {
    content: [
      {
        type: 'text',
        text: 'Opened metaapp "buzz-app" at http://127.0.0.1:38421/buzz/app/index.html?view=hot',
      },
    ],
  });
});
