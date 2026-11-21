import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const require = Module.createRequire(import.meta.url);

const toolRegistry = require('../dist-electron/main/libs/toolCapabilityRegistry.js');
const studioGuard = require('../dist-electron/main/libs/studioToolGuard.js');
const metataskAgentTools = require('../dist-electron/main/libs/metataskAgentTools.js');
const escrowAgentTools = require('../dist-electron/main/libs/escrowAgentTools.js');
const mobileToolIntent = require('../dist-electron/main/cerebellum/mobileToolIntent.js');
const turnDecisionBundle = require('../dist-electron/main/cerebellum/turnDecisionBundle.js');

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

function makeFakeToolFactory() {
  return (name, description, _schema, handler) => ({ name, description, handler });
}

test('P2-1: resolveReadOnlyToolMountPolicy opens socialRead & economyRead for Studio Twin while keeping write domains closed', () => {
  const studioProfile = { isStudioOwnerChat: true, isMobileOwnerChat: false };
  assert.deepEqual(
    toolRegistry.resolveReadOnlyToolMountPolicy(studioProfile, []),
    { economyRead: true, socialRead: true },
  );
  assert.deepEqual(
    toolRegistry.resolveToolMountPolicy(studioProfile, []),
    {
      workerEconomy: false,
      financial: true,
      social: false,
      metaweb: true,
      orchestration: true,
      memoryAdvanced: true,
      automation: true,
    },
  );

  // Mobile remains fail-closed until workerEconomy / social / metaweb expand.
  const mobileProfile = { isStudioOwnerChat: false, isMobileOwnerChat: true };
  assert.deepEqual(
    toolRegistry.resolveReadOnlyToolMountPolicy(mobileProfile, []),
    { economyRead: false, socialRead: false },
  );
  assert.deepEqual(
    toolRegistry.resolveReadOnlyToolMountPolicy(mobileProfile, ['workerEconomy']),
    { economyRead: true, socialRead: false },
  );
  assert.deepEqual(
    toolRegistry.resolveReadOnlyToolMountPolicy(mobileProfile, ['metaweb']),
    { economyRead: false, socialRead: true },
  );
});

test('P2-1: metatask and escrow readOnly tool builders mount only read-only lookup tools', () => {
  const fakeTool = makeFakeToolFactory();
  const metataskReadTools = metataskAgentTools.buildMetataskAgentTools({
    tool: fakeTool,
    control: {},
    sessionId: 'studio-1',
    readOnly: true,
  });
  assert.deepEqual(
    metataskReadTools.map((t) => t.name),
    ['metatask_list', 'metatask_get', 'metatask_replay'],
  );
  for (const t of metataskReadTools) {
    assert.equal(toolRegistry.getToolCapabilitySpec(t.name)?.readOnly, true);
  }

  const escrowReadTools = escrowAgentTools.buildEscrowAgentTools({
    tool: fakeTool,
    control: {},
    orders: {},
    sessionId: 'studio-1',
    readOnly: true,
  });
  assert.deepEqual(
    escrowReadTools.map((t) => t.name),
    ['escrow_order_list', 'escrow_order_info'],
  );
  for (const t of escrowReadTools) {
    assert.equal(toolRegistry.getToolCapabilitySpec(t.name)?.readOnly, true);
  }
});

test('P2-1: evaluateStudioTwinToolGuard allows read-only bash verification and blocks mutating/production bash', () => {
  const ws = path.join(repoRoot, 'tmp-workspace');

  const allowedCommands = [
    'git status --short',
    'git diff HEAD~1',
    'git log --oneline -5',
    'ls -la src/main',
    'rg "resolveReadOnlyToolMountPolicy" src/main',
    'pnpm exec tsc --noEmit',
    'pnpm test',
    'node --test tests/p1ConversationProfileGovernance.test.mjs',
    'curl -s https://example.com/health',
    'mkdir -p reports',
    'rm -rf .cowork-temp/scratch-1',
  ];
  for (const cmd of allowedCommands) {
    const verdict = studioGuard.evaluateStudioTwinToolGuard({
      isStudioTwinFrontOffice: true,
      toolName: 'bash',
      toolInput: { command: cmd },
      workspaceRoot: ws,
    });
    assert.deepEqual(verdict, { action: 'allow' }, `expected bash to allow: ${cmd}`);
  }

  const deniedCommands = [
    'echo "hack" > src/main/libs/foo.ts',
    'cat <<EOF > docs/note.md\nhi\nEOF',
    "sed -i '' 's/a/b/' src/main/libs/foo.ts",
    'rm -rf reports',
    'rm src/main/libs/foo.ts',
    'git commit -m "sneaky"',
    'git checkout -b tmp',
    'pnpm install lodash',
    'npm run build',
    'python3 -c "open(\'out.txt\', \'w\').write(\'hi\')"',
    'node -e "fs.writeFileSync(\'a.txt\', \'b\')"',
    'curl -O https://example.com/file.zip',
    'git status && echo bad > src/a.ts',
  ];
  for (const cmd of deniedCommands) {
    const verdict = studioGuard.evaluateStudioTwinToolGuard({
      isStudioTwinFrontOffice: true,
      toolName: 'bash',
      toolInput: { command: cmd },
      workspaceRoot: ws,
    });
    assert.equal(verdict.action, 'deny', `expected bash to deny: ${cmd}`);
    assert.match(verdict.reason, /Chief-of-Staff guardrail|local_worker_delegate/);
  }

  // Non-Studio Twin sessions (Workers / standard desktop) stay unblocked.
  assert.deepEqual(
    studioGuard.evaluateStudioTwinToolGuard({
      isStudioTwinFrontOffice: false,
      toolName: 'bash',
      toolInput: { command: 'pnpm install' },
      workspaceRoot: ws,
    }),
    { action: 'allow' },
  );
});

test('P2-1: Studio prompts and coworkRunner align on read-only verification and bash Chief-of-Staff boundary', () => {
  const ownerPromptMod = loadWithMockedElectron('../dist-electron/main/libs/ownerInteractionPrompt.js', 'en');
  const studioPrompt = ownerPromptMod.buildOwnerInteractionPrompt({
    surface: 'desktop_studio',
    presentation: 'projector_right_pane',
    hasOwnerUpdate: true,
    hasProjector: true,
    hasDesktopBrowser: true,
    hasWebSearch: true,
  });
  assert.match(studioPrompt, /metatask_list/);
  assert.match(studioPrompt, /escrow_order_list/);
  assert.match(studioPrompt, /mutating\/build `bash` commands/);
  assert.match(studioPrompt, /local_worker_delegate/);

  const runnerSrc = fs.readFileSync(path.join(repoRoot, 'src/main/libs/coworkRunner.ts'), 'utf8');
  assert.match(runnerSrc, /resolveReadOnlyToolMountPolicy\(conversationProfile, mobileExpansions\)/);
  assert.match(runnerSrc, /else if \(this\.metataskTools && mountWorkerEconomyReadTools\)/);
  assert.match(runnerSrc, /else if \(this\.escrowTools && mountWorkerEconomyReadTools\)/);
  assert.match(runnerSrc, /readOnly: true/);
  assert.match(runnerSrc, /keep `bash` strictly to read-only inspection and verification/);
});

test('P2-2: mobileToolIntent skips sticky-active domains, parses noul verdicts, and fails closed on low coverage', () => {
  assert.deepEqual(
    mobileToolIntent.selectPendingMobileToolExpansions(['financial', 'automation']),
    ['workerEconomy', 'social', 'metaweb', 'orchestration', 'memoryAdvanced'],
  );
  assert.deepEqual(
    mobileToolIntent.selectPendingMobileToolExpansions(mobileToolIntent.MOBILE_TOOL_INTENT_KEYS),
    [],
  );

  const pending = mobileToolIntent.MOBILE_TOOL_INTENT_KEYS;
  const questions = mobileToolIntent.buildMobileToolIntentQuestions(pending);
  assert.equal(Object.keys(questions).length, 7);
  assert.ok(questions.mob_exp_financial);

  const parsed = mobileToolIntent.parseMobileToolIntentAnswers(
    {
      answers: {
        mob_exp_workerEconomy: { noul: 0.1 },
        mob_exp_financial: { noul: 0.92 },
        mob_exp_social: { noul: 0.2 },
        mob_exp_metaweb: { noul: 0.1 },
        mob_exp_orchestration: { noul: 0.3 },
        mob_exp_memoryAdvanced: { noul: 0.15 },
        mob_exp_automation: { noul: 0.05 },
      },
    },
    pending,
  );
  assert.deepEqual(parsed, ['financial']);

  // Casual chat with false-positive regex keywords produces [] when Cerebellum answers low across all domains.
  const casualParsed = mobileToolIntent.parseMobileToolIntentAnswers(
    {
      answers: {
        mob_exp_workerEconomy: { noul: 0.05 },
        mob_exp_financial: { noul: 0.05 },
        mob_exp_social: { noul: 0.12 },
        mob_exp_metaweb: { noul: 0.1 },
        mob_exp_orchestration: { noul: 0.2 },
        mob_exp_memoryAdvanced: { noul: 0.05 },
        mob_exp_automation: { noul: 0.1 },
      },
    },
    pending,
  );
  assert.deepEqual(casualParsed, []);

  // Below 70% answer coverage -> returns null so caller falls back to regex.
  const lowCoverage = mobileToolIntent.parseMobileToolIntentAnswers(
    {
      answers: {
        mob_exp_financial: { noul: 0.9 },
        mob_exp_social: { noul: 0.1 },
      },
    },
    pending,
  );
  assert.equal(lowCoverage, null);
});

test('P2-2: applyMobileToolExpansionVerdict prevents regex false positives, preserves sticky domains, and degrades cleanly', () => {
  const noisyCasualPrompt = '我今天任务好多，先发个链接看看行业动态，明天再说';
  // Regex alone would falsely trigger orchestration + automation + social + metaweb.
  const regexOnly = toolRegistry.resolveMobileToolExpansions([], noisyCasualPrompt);
  assert.ok(regexOnly.length >= 3);

  // Cerebellum semantic verdict [] suppresses those false expansions completely.
  assert.deepEqual(
    toolRegistry.applyMobileToolExpansionVerdict([], noisyCasualPrompt, []),
    [],
  );

  // Sticky prior expansions remain intact on follow-up turns.
  assert.deepEqual(
    toolRegistry.applyMobileToolExpansionVerdict(['financial'], '继续', []),
    ['financial'],
  );

  // Null/undefined cerebellum verdict degrades cleanly to regex fallback.
  assert.deepEqual(
    toolRegistry.applyMobileToolExpansionVerdict(['financial'], '看看今天的 buzz 动态', null),
    toolRegistry.resolveMobileToolExpansions(['financial'], '看看今天的 buzz 动态'),
  );
});

test('P2-2: runCerebellumTurnDecisions bundles mobileToolExpansions into one /v1/systemone call', async () => {
  let requests = 0;
  let capturedBody = null;
  const fetchImpl = async (_url, init) => {
    requests += 1;
    capturedBody = JSON.parse(String(init.body));
    return {
      ok: true,
      async json() {
        return {
          answers: {
            experience: { noul: 0.1 },
            'twin-impression': { noul: 0.1 },
            'knowledge-bases': { noul: 0.1 },
            'remote-services': { noul: 0.1 },
            'team-culture': { noul: 0.1 },
            mob_exp_workerEconomy: { noul: 0.05 },
            mob_exp_financial: { noul: 0.91 },
            mob_exp_social: { noul: 0.08 },
            mob_exp_metaweb: { noul: 0.1 },
            mob_exp_orchestration: { noul: 0.12 },
            mob_exp_memoryAdvanced: { noul: 0.04 },
            mob_exp_automation: { noul: 0.06 },
          },
        };
      },
    };
  };

  const result = await turnDecisionBundle.runCerebellumTurnDecisions({
    config: {
      provider: 'deepseek',
      baseUrl: 'https://example.invalid',
      apiKey: 'test-key',
      model: 'test-model',
    },
    fetchImpl,
    decisions: {
      currentUserText: '帮我查下我的钱包余额',
      memories: [],
      knowledge: [],
      skills: [],
      services: [],
      includeGate: true,
      includeMobileToolExpansions: true,
      currentMobileExpansions: [],
    },
  });

  assert.equal(requests, 1);
  assert.ok(capturedBody.questions.mob_exp_financial);
  assert.deepEqual(result?.mobileToolExpansions, ['financial']);

  // Already-expanded domains are omitted from questions on follow-up turns.
  let followUpBody = null;
  await turnDecisionBundle.runCerebellumTurnDecisions({
    config: {
      provider: 'deepseek',
      baseUrl: 'https://example.invalid',
      apiKey: 'test-key',
      model: 'test-model',
    },
    fetchImpl: async (_url, init) => {
      followUpBody = JSON.parse(String(init.body));
      return { ok: false };
    },
    decisions: {
      currentUserText: '继续',
      memories: [],
      knowledge: [],
      skills: [],
      services: [],
      includeGate: false,
      includeMobileToolExpansions: true,
      currentMobileExpansions: ['financial', 'automation'],
    },
  });
  assert.equal(followUpBody.questions.mob_exp_financial, undefined);
  assert.equal(followUpBody.questions.mob_exp_automation, undefined);
  assert.ok(followUpBody.questions.mob_exp_social);
});

test('P2-2: coworkRunner and main wire prepareMobileTurnDecisions with single-bundle reuse', () => {
  const runnerSrc = fs.readFileSync(path.join(repoRoot, 'src/main/libs/coworkRunner.ts'), 'utf8');
  assert.match(runnerSrc, /await this\.prepareMobileTurnDecisions\(sessionId, activeSession, prompt\)/);
  assert.match(runnerSrc, /includeMobileToolExpansions:\s*true/);
  assert.match(runnerSrc, /activeForDecisions\?\.pendingTurnDecisions\?\.prompt === prompt/);
  assert.match(runnerSrc, /applyMobileToolExpansionVerdict\(previous, prompt, cerebellumExpanded\)/);

  const mainSrc = fs.readFileSync(path.join(repoRoot, 'src/main/main.ts'), 'utf8');
  assert.match(mainSrc, /includeMobileToolExpansions:\s*input\.includeMobileToolExpansions === true/);
  assert.match(mainSrc, /mobileToolExpansions:\s*outcome\.mobileToolExpansions \?\? null/);
});
