# Baoyu Image Studio Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a built-in `baoyu-image-studio` skill that generates local image files in four modes, reuses existing IDBots provider credentials when possible, and falls back to environment-only providers without changing the current Settings UI.

**Architecture:** Add a main-process image-provider environment resolver that maps the current MetaBot provider to supported image providers and injects the resolved credentials into Cowork/skill execution. Implement a new `SKILLs/baoyu-image-studio/` skill as a plain Node.js skill with a small prompt-building core plus seven provider adapters, keeping Web2 publishing and browser automation out of scope.

**Tech Stack:** Electron main-process TypeScript, Node.js skill scripts, existing `SkillManager`/Cowork environment injection, Node test runner (`node --test`), JSON skill defaults.

---

## File Structure

### Main-process wiring

- Create: `src/main/libs/skillImageProviderEnv.ts`
  - Pure helper for provider mapping, credential precedence, default model lookup, and environment variable shaping.
- Modify: `src/main/main.ts`
  - Inject image-provider env vars into Cowork sessions when `baoyu-image-studio` is active.
- Modify: `src/main/skillManager.ts`
  - Reuse the same env resolver for direct `runSkillById()` execution paths.

### Skill implementation

- Create: `SKILLs/baoyu-image-studio/SKILL.md`
  - User-facing routing and execution instructions for `generate`, `cover`, `infographic`, and `comic`.
- Create: `SKILLs/baoyu-image-studio/scripts/index.js`
  - Main CLI entrypoint for mode detection, prompt assembly, provider selection, and file output.
- Create: `SKILLs/baoyu-image-studio/scripts/lib/providerResolver.js`
  - Runtime provider choice and credential presence checks.
- Create: `SKILLs/baoyu-image-studio/scripts/lib/promptBuilder.js`
  - Prompt templates and mode-specific text expansion.
- Create: `SKILLs/baoyu-image-studio/scripts/lib/outputPaths.js`
  - Stable output directory, filename, and extension handling.
- Create: `SKILLs/baoyu-image-studio/scripts/providers/openai.js`
- Create: `SKILLs/baoyu-image-studio/scripts/providers/google.js`
- Create: `SKILLs/baoyu-image-studio/scripts/providers/openrouter.js`
- Create: `SKILLs/baoyu-image-studio/scripts/providers/dashscope.js`
- Create: `SKILLs/baoyu-image-studio/scripts/providers/replicate.js`
- Create: `SKILLs/baoyu-image-studio/scripts/providers/jimeng.js`
- Create: `SKILLs/baoyu-image-studio/scripts/providers/seedream.js`
  - Seven isolated provider adapters with consistent `generateImage()` contracts.
- Create: `SKILLs/baoyu-image-studio/templates/cover.md`
- Create: `SKILLs/baoyu-image-studio/templates/infographic.md`
- Create: `SKILLs/baoyu-image-studio/templates/comic.md`
  - Minimal prompt skeletons for the higher-level modes.

### Tests and defaults

- Modify: `SKILLs/skills.config.json`
  - Add the built-in skill with order/version/default-enabled metadata.
- Create: `tests/skillImageProviderEnv.test.mjs`
  - Unit coverage for provider mapping and env shaping.
- Create: `tests/baoyuImageStudioSkill.test.mjs`
  - Skill listing/default-enable/routing-prompt smoke coverage.
- Create: `tests/baoyuImageStudioScript.test.mjs`
  - Script-level coverage for mode detection, provider fallback, prompt building, and output path logic.

### Existing files that must remain separate

- Keep `SKILLs/seedream/` unchanged.
- Keep `SKILLs/seedance/` unchanged.
- Do not couple `baoyu-image-studio` to Web2 publishing skills.

---

### Task 1: Build Main-Process Image Provider Env Resolution

**Files:**
- Create: `src/main/libs/skillImageProviderEnv.ts`
- Test: `tests/skillImageProviderEnv.test.mjs`

- [ ] **Step 1: Write the failing test for MetaBot provider mapping**

```js
test('prefers current metabot provider mapping before global fallback providers', async () => {
  const { buildImageSkillEnvOverrides } = require('../dist-electron/libs/skillImageProviderEnv.js');

  const env = buildImageSkillEnvOverrides({
    activeSkillIds: ['baoyu-image-studio'],
    metabotLlmId: 'gemini',
    appConfig: {
      providers: {
        gemini: { enabled: true, apiKey: 'g-key', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', models: [] },
        openai: { enabled: true, apiKey: 'o-key', baseUrl: 'https://api.openai.com', models: [] },
      },
    },
    processEnv: {},
  });

  assert.equal(env.BAOYU_IMAGE_PROVIDER, 'google');
  assert.equal(env.GOOGLE_API_KEY, 'g-key');
  assert.equal(env.GOOGLE_IMAGE_MODEL, 'gemini-3-pro-image-preview');
});
```

- [ ] **Step 2: Write the failing test for unsupported-provider fallback**

```js
test('falls back from unsupported metabot provider to configured openrouter then env-only providers', async () => {
  const { buildImageSkillEnvOverrides } = require('../dist-electron/libs/skillImageProviderEnv.js');

  const env = buildImageSkillEnvOverrides({
    activeSkillIds: ['baoyu-image-studio'],
    metabotLlmId: 'anthropic',
    appConfig: {
      providers: {
        openrouter: { enabled: true, apiKey: 'router-key', baseUrl: 'https://openrouter.ai/api', models: [] },
      },
    },
    processEnv: {},
  });

  assert.equal(env.BAOYU_IMAGE_PROVIDER, 'openrouter');
  assert.equal(env.OPENROUTER_API_KEY, 'router-key');
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm run compile:electron && node --test tests/skillImageProviderEnv.test.mjs`

Expected: FAIL with `Cannot find module '../dist-electron/libs/skillImageProviderEnv.js'` or missing export errors.

- [ ] **Step 4: Implement the pure resolver helper**

```ts
export function buildImageSkillEnvOverrides(input: {
  activeSkillIds?: string[];
  metabotLlmId?: string | null;
  appConfig?: AppConfig | null;
  processEnv?: NodeJS.ProcessEnv;
}): Record<string, string> {
  // 1. Ignore sessions that do not activate baoyu-image-studio.
  // 2. Map MetaBot llm_id -> image provider.
  // 3. Prefer mapped provider from appConfig.providers.
  // 4. Fall back to configured bridge providers.
  // 5. Fall back to env-only providers.
  // 6. Return normalized env vars + BAOYU_IMAGE_PROVIDER.
}
```

- [ ] **Step 5: Re-run tests to verify they pass**

Run: `npm run compile:electron && node --test tests/skillImageProviderEnv.test.mjs`

Expected: PASS with provider mapping, default model, and precedence assertions green.

- [ ] **Step 6: Commit**

```bash
git add src/main/libs/skillImageProviderEnv.ts tests/skillImageProviderEnv.test.mjs
git commit -m "feat: add baoyu image provider env resolver"
```

---

### Task 2: Inject Image Provider Env Into Cowork And Direct Skill Execution

**Files:**
- Modify: `src/main/main.ts`
- Modify: `src/main/skillManager.ts`
- Test: `tests/skillImageProviderEnv.test.mjs`

- [ ] **Step 1: Extend the failing test to cover Cowork skill activation gating**

```js
test('returns empty overrides when baoyu-image-studio is not active', async () => {
  const { buildImageSkillEnvOverrides } = require('../dist-electron/libs/skillImageProviderEnv.js');
  const env = buildImageSkillEnvOverrides({
    activeSkillIds: ['superpowers-writing-plans'],
    metabotLlmId: 'openai',
    appConfig: { providers: { openai: { enabled: true, apiKey: 'key', baseUrl: 'https://api.openai.com', models: [] } } },
    processEnv: {},
  });
  assert.deepEqual(env, {});
});
```

- [ ] **Step 2: Run the targeted test to see the new assertion fail**

Run: `npm run compile:electron && node --test tests/skillImageProviderEnv.test.mjs`

Expected: FAIL until the helper and wiring respect `activeSkillIds`.

- [ ] **Step 3: Wire the resolver into CoworkRunner session env overrides**

```ts
const imageEnv = buildImageSkillEnvOverrides({
  activeSkillIds: skillIds,
  metabotLlmId: session?.metabotId != null ? metabot?.llm_id : null,
  appConfig: getStore().get('app_config'),
  processEnv: process.env,
});
Object.assign(overrides, imageEnv);
```

- [ ] **Step 4: Reuse the same resolver in `SkillManager.runSkillById()`**

```ts
const imageEnv = buildImageSkillEnvOverrides({
  activeSkillIds: [skillId],
  metabotLlmId: context?.metabotId != null ? metabotLlmIdFromStore : null,
  appConfig: this.getStore().get('app_config'),
  processEnv: process.env,
});
const env: NodeJS.ProcessEnv = { ...baseEnv, ...envOverrides, ...imageEnv };
```

- [ ] **Step 5: Re-run the resolver test suite**

Run: `npm run compile:electron && node --test tests/skillImageProviderEnv.test.mjs`

Expected: PASS, proving the helper still behaves after call-site integration.

- [ ] **Step 6: Commit**

```bash
git add src/main/main.ts src/main/skillManager.ts tests/skillImageProviderEnv.test.mjs
git commit -m "feat: inject baoyu image env into skill execution"
```

---

### Task 3: Scaffold The Built-In Skill And Default Metadata

**Files:**
- Create: `SKILLs/baoyu-image-studio/SKILL.md`
- Create: `SKILLs/baoyu-image-studio/templates/cover.md`
- Create: `SKILLs/baoyu-image-studio/templates/infographic.md`
- Create: `SKILLs/baoyu-image-studio/templates/comic.md`
- Modify: `SKILLs/skills.config.json`
- Test: `tests/baoyuImageStudioSkill.test.mjs`

- [ ] **Step 1: Write the failing test for built-in listing and default enablement**

```js
test('listSkills exposes baoyu-image-studio as an enabled built-in skill', () => {
  const { SkillManager } = require('../dist-electron/skillManager.js');
  const manager = new SkillManager(() => new MemoryStore());
  manager.getBundledSkillsRoot = () => process.env.IDBOTS_SKILLS_ROOT;

  const skill = manager.listSkills().find((entry) => entry.id === 'baoyu-image-studio');
  assert.ok(skill);
  assert.equal(skill.enabled, true);
  assert.equal(skill.isBuiltIn, true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run compile:electron && node --test tests/baoyuImageStudioSkill.test.mjs`

Expected: FAIL because the skill directory and config entry do not exist yet.

- [ ] **Step 3: Add the skill skeleton and defaults**

```md
---
name: baoyu-image-studio
description: 使用多 provider 生成封面图、信息图、漫画风图片和通用图像文件。
official: true
---

# Baoyu Image Studio

当用户请求生成图片、封面图、信息图、漫画风图片或参考图改图时使用本技能。
```

- [ ] **Step 4: Add `skills.config.json` default metadata**

```json
"baoyu-image-studio": {
  "order": 320,
  "version": "1.0.0",
  "creator-metaid": "",
  "installedAt": 1774310400000,
  "enabled": true
}
```

- [ ] **Step 5: Re-run the built-in skill test**

Run: `npm run compile:electron && node --test tests/baoyuImageStudioSkill.test.mjs`

Expected: PASS and `manager.listSkills()` includes the new skill.

- [ ] **Step 6: Commit**

```bash
git add SKILLs/baoyu-image-studio SKILLs/skills.config.json tests/baoyuImageStudioSkill.test.mjs
git commit -m "feat: scaffold baoyu image studio skill"
```

---

### Task 4: Implement Mode Detection, Prompt Building, And Output Paths

**Files:**
- Create: `SKILLs/baoyu-image-studio/scripts/index.js`
- Create: `SKILLs/baoyu-image-studio/scripts/lib/providerResolver.js`
- Create: `SKILLs/baoyu-image-studio/scripts/lib/promptBuilder.js`
- Create: `SKILLs/baoyu-image-studio/scripts/lib/outputPaths.js`
- Test: `tests/baoyuImageStudioScript.test.mjs`

- [ ] **Step 1: Write the failing script-level tests**

```js
test('detects infographic mode from payload and writes a stable output path', async () => {
  const mod = await import('../SKILLs/baoyu-image-studio/scripts/lib/promptBuilder.js');
  const paths = await import('../SKILLs/baoyu-image-studio/scripts/lib/outputPaths.js');

  const mode = mod.detectMode({ mode: 'infographic', topic: 'UTXO 解释', bullets: ['定义', '流程', '风险'] });
  const output = paths.buildOutputPath({
    cwd: '/tmp/demo',
    mode,
    title: 'UTXO 解释',
    extension: '.png',
  });

  assert.equal(mode, 'infographic');
  assert.match(output, /utxo/);
  assert.match(output, /\.png$/);
});
```

- [ ] **Step 2: Run the script tests to verify they fail**

Run: `node --test tests/baoyuImageStudioScript.test.mjs`

Expected: FAIL because the script modules do not exist yet.

- [ ] **Step 3: Implement mode detection and prompt builders**

```js
export function detectMode(payload) {
  if (payload.mode) return normalizeMode(payload.mode);
  if (payload.bullets?.length) return 'infographic';
  if (payload.panels?.length || /漫画|comic/i.test(payload.style || '')) return 'comic';
  if (payload.title || /封面|cover|海报/i.test(payload.intent || '')) return 'cover';
  return 'generate';
}
```

- [ ] **Step 4: Implement stable output path generation**

```js
export function buildOutputPath({ cwd, mode, title, extension }) {
  const root = path.resolve(cwd, 'outputs', 'baoyu-image-studio', mode);
  const slug = slugify(title || mode);
  return path.join(root, `${slug}-${Date.now()}${extension}`);
}
```

- [ ] **Step 5: Re-run the script tests**

Run: `node --test tests/baoyuImageStudioScript.test.mjs`

Expected: PASS for mode selection, prompt shaping, and file naming.

- [ ] **Step 6: Commit**

```bash
git add SKILLs/baoyu-image-studio/scripts tests/baoyuImageStudioScript.test.mjs
git commit -m "feat: add baoyu image studio script core"
```

---

### Task 5: Implement Bridge Provider Adapters For OpenAI, Google, OpenRouter, And DashScope

**Files:**
- Create: `SKILLs/baoyu-image-studio/scripts/providers/openai.js`
- Create: `SKILLs/baoyu-image-studio/scripts/providers/google.js`
- Create: `SKILLs/baoyu-image-studio/scripts/providers/openrouter.js`
- Create: `SKILLs/baoyu-image-studio/scripts/providers/dashscope.js`
- Modify: `SKILLs/baoyu-image-studio/scripts/lib/providerResolver.js`
- Test: `tests/baoyuImageStudioScript.test.mjs`

- [ ] **Step 1: Add failing adapter tests for the four bridge providers**

```js
test('providerResolver returns bridge providers before env-only providers', async () => {
  const { resolveProviderConfig } = await import('../SKILLs/baoyu-image-studio/scripts/lib/providerResolver.js');
  const result = resolveProviderConfig({
    env: {
      BAOYU_IMAGE_PROVIDER: 'openrouter',
      OPENROUTER_API_KEY: 'router-key',
      OPENROUTER_IMAGE_MODEL: 'google/gemini-3.1-flash-image-preview',
    },
  });

  assert.equal(result.provider, 'openrouter');
  assert.equal(result.model, 'google/gemini-3.1-flash-image-preview');
});
```

- [ ] **Step 2: Run the script tests and confirm the new cases fail**

Run: `node --test tests/baoyuImageStudioScript.test.mjs`

Expected: FAIL with missing adapter or missing resolver branch errors.

- [ ] **Step 3: Implement four HTTP provider adapters with one shared contract**

```js
export async function generateImage({ prompt, model, outputPath, env, options }) {
  // Validate required credential env.
  // Build provider-specific request body.
  // Download binary image bytes.
  // mkdir -p output dir and write outputPath.
  // Return { provider, model, outputPath, mimeType }.
}
```

- [ ] **Step 4: Teach the runtime resolver about default image models**

```js
const DEFAULT_MODELS = {
  openai: 'gpt-image-1.5',
  google: 'gemini-3-pro-image-preview',
  openrouter: 'google/gemini-3.1-flash-image-preview',
  dashscope: 'qwen-image-2.0-pro',
};
```

- [ ] **Step 5: Re-run the script suite**

Run: `node --test tests/baoyuImageStudioScript.test.mjs`

Expected: PASS for bridge-provider selection and request-shaping tests.

- [ ] **Step 6: Commit**

```bash
git add SKILLs/baoyu-image-studio/scripts/providers SKILLs/baoyu-image-studio/scripts/lib/providerResolver.js tests/baoyuImageStudioScript.test.mjs
git commit -m "feat: add baoyu image bridge providers"
```

---

### Task 6: Implement Env-Only Provider Adapters And Final Fallback Behavior

**Files:**
- Create: `SKILLs/baoyu-image-studio/scripts/providers/replicate.js`
- Create: `SKILLs/baoyu-image-studio/scripts/providers/jimeng.js`
- Create: `SKILLs/baoyu-image-studio/scripts/providers/seedream.js`
- Modify: `SKILLs/baoyu-image-studio/scripts/index.js`
- Modify: `tests/baoyuImageStudioScript.test.mjs`

- [ ] **Step 1: Add failing tests for env-only provider fallback**

```js
test('falls back to seedream when no bridge provider is configured but ARK_API_KEY exists', async () => {
  const { resolveProviderConfig } = await import('../SKILLs/baoyu-image-studio/scripts/lib/providerResolver.js');
  const result = resolveProviderConfig({
    env: {
      ARK_API_KEY: 'ark-key',
      SEEDREAM_IMAGE_MODEL: 'doubao-seedream-5-0-260128',
    },
  });

  assert.equal(result.provider, 'seedream');
  assert.equal(result.model, 'doubao-seedream-5-0-260128');
});
```

- [ ] **Step 2: Run the script tests and verify failure**

Run: `node --test tests/baoyuImageStudioScript.test.mjs`

Expected: FAIL until env-only providers and fallback order are implemented.

- [ ] **Step 3: Implement the three env-only adapters**

```js
// replicate.js
// - require REPLICATE_API_TOKEN
// - submit prediction
// - poll if needed
// - download output URL

// jimeng.js
// - require JIMENG_ACCESS_KEY_ID + JIMENG_SECRET_ACCESS_KEY
// - sign request
// - persist output file

// seedream.js
// - require ARK_API_KEY
// - call Ark image endpoint
// - download returned image URL
```

- [ ] **Step 4: Make the CLI return actionable failures**

```js
if (!providerConfig) {
  throw new Error(
    'No supported image provider is available. Configure openai/gemini/openrouter/qwen in IDBots Settings, or export REPLICATE_API_TOKEN / JIMENG_ACCESS_KEY_ID+JIMENG_SECRET_ACCESS_KEY / ARK_API_KEY.'
  );
}
```

- [ ] **Step 5: Re-run the script suite**

Run: `node --test tests/baoyuImageStudioScript.test.mjs`

Expected: PASS for env-only fallback, error messaging, and final provider order.

- [ ] **Step 6: Commit**

```bash
git add SKILLs/baoyu-image-studio/scripts/providers SKILLs/baoyu-image-studio/scripts/index.js tests/baoyuImageStudioScript.test.mjs
git commit -m "feat: add baoyu image env-only providers"
```

---

### Task 7: End-To-End Verification, Skill Build Smoke, And Final Cleanup

**Files:**
- Modify: `tests/baoyuImageStudioSkill.test.mjs`
- Modify: `tests/baoyuImageStudioScript.test.mjs`
- Modify: `package-lock.json` only if dependency drift must be intentionally retained

- [ ] **Step 1: Run the focused automated verification**

Run: `npm run compile:electron && node --test tests/skillImageProviderEnv.test.mjs tests/baoyuImageStudioSkill.test.mjs tests/baoyuImageStudioScript.test.mjs`

Expected: PASS with all new suites green.

- [ ] **Step 2: Run the existing superpowers routing regression**

Run: `node --test tests/superpowersCoworkPrompt.test.mjs`

Expected: PASS with `4` tests, `0` failures.

- [ ] **Step 3: Run skill build smoke if any TS companions were added**

Run: `npm run build:skills`

Expected: PASS or `No SKILL .ts files ... Nothing to compile.` if all new skill files are plain `.js`.

- [ ] **Step 4: Restore incidental lockfile drift unless the implementation intentionally needs it**

Run: `git restore -- package-lock.json`

Expected: `git status --short` no longer shows a standalone `package-lock.json` change from bootstrap-only `npm install`.

- [ ] **Step 5: Manual acceptance in the worktree**

Run these checks in a Cowork session bound to a MetaBot:

```text
使用 baoyu-image-studio 生成一张橙色太空猫封面图
使用 baoyu-image-studio 生成一张解释 UTXO 的信息图
使用 baoyu-image-studio 生成一张漫画风的「机器人在链上发帖」图
```

Expected:

- Each request selects the correct mode.
- Output contains a local image file path.
- When the current MetaBot uses `openai/gemini/openrouter/qwen`, the skill runs without asking for a new UI configuration.
- When the current MetaBot uses an unsupported provider, the skill suggests bridge providers or env-only providers.

- [ ] **Step 6: Commit**

```bash
git add src/main tests SKILLs
git commit -m "feat: add baoyu image studio"
```
