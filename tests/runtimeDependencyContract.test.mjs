import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const packageJsonPath = path.join(process.cwd(), 'package.json');
const skillManagerPath = path.join(process.cwd(), 'src', 'main', 'skillManager.ts');
const coworkRunnerPath = path.join(process.cwd(), 'src', 'main', 'libs', 'coworkRunner.ts');

test('skillManager runtime YAML parser must be declared as production dependency', () => {
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  const skillManagerSource = fs.readFileSync(skillManagerPath, 'utf8');

  assert.match(
    skillManagerSource,
    /from 'js-yaml'/,
    'Expected skillManager to import js-yaml for frontmatter parsing',
  );

  assert.ok(
    packageJson.dependencies && packageJson.dependencies['js-yaml'],
    'js-yaml must be in dependencies so packaged app can load skillManager at runtime',
  );
});

test('web-search skill build must go through the runtime bootstrap wrapper', () => {
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  const buildScript = packageJson.scripts?.['build:skill:web-search'] || '';
  const aggregateBuildScript = packageJson.scripts?.['build:skills'] || '';

  assert.match(
    buildScript,
    /node\s+scripts\/build-web-search-skill\.js/,
    'build:skill:web-search should use the web-search bootstrap script so fresh worktrees can install missing skill deps before tsc',
  );

  assert.match(
    aggregateBuildScript,
    /node\s+scripts\/build-web-search-skill\.js/,
    'build:skills should use the same web-search bootstrap script so electron:dev works in fresh worktrees',
  );
});

test('SDK built-in web tools are gated by an explicit env flag', () => {
  const source = fs.readFileSync(coworkRunnerPath, 'utf8');

  assert.match(
    source,
    /const ENABLE_SDK_WEB_TOOLS_ENV = 'IDBOTS_ENABLE_SDK_WEB_TOOLS'/,
    'CoworkRunner should expose SDK WebSearch/WebFetch through an explicit opt-in env flag',
  );
  assert.match(
    source,
    /export function shouldBlockBuiltinWebTool\(toolName: string\): boolean/,
    'CoworkRunner should keep the web tool gate in a testable helper',
  );
  assert.match(
    source,
    /if \(isSdkBuiltinWebToolsEnabled\(\)\) \{\s*return false;\s*\}/,
    'IDBOTS_ENABLE_SDK_WEB_TOOLS should disable the WebSearch/WebFetch block when truthy',
  );
  assert.match(
    source,
    /const BLOCKED_BUILTIN_WEB_TOOLS = new Set\(\['websearch', 'webfetch'\]\)/,
    'Default behavior should continue blocking SDK WebSearch and WebFetch',
  );
});

test('DeepSeek missing reasoning_content failures reset stale resume state once', () => {
  const source = fs.readFileSync(coworkRunnerPath, 'utf8');

  assert.match(
    source,
    /function isDeepSeekMissingReasoningContentError\(message: string\): boolean/,
    'CoworkRunner should classify DeepSeek thinking history failures explicitly',
  );
  assert.match(
    source,
    /DeepSeek thinking history lost reasoning_content; retrying with fresh session/,
    'DeepSeek missing reasoning_content should trigger one fresh-session retry instead of leaving the run stuck',
  );
});
