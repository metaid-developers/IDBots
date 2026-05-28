import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const packageJsonPath = path.join(process.cwd(), 'package.json');
const mainProcessPath = path.join(process.cwd(), 'src', 'main', 'main.ts');
const skillManagerPath = path.join(process.cwd(), 'src', 'main', 'skillManager.ts');
const coworkRunnerPath = path.join(process.cwd(), 'src', 'main', 'libs', 'coworkRunner.ts');
const claudeSdkCliPatchScriptPath = path.join(process.cwd(), 'scripts', 'patch-claude-sdk-cli.js');

const CYGPATH_SNIPPET =
  'BS=(A)=>{let Q=g4([A]);return NL(`cygpath -u ${Q}`,{shell:dM1()}).toString().trim()},B0Q=(A)=>{let Q=g4([A]);return NL(`cygpath -w ${Q}`,{shell:dM1()}).toString().trim()};';

const EXPLORE_AGENT_SNIPPET =
  'FT={agentType:"Explore",whenToUse:"Fast agent specialized for exploring codebases.",disallowedTools:[P6,eZ1,S6,NG,EC],source:"built-in",baseDir:"built-in",model:"haiku",getSystemPrompt:()=>JH5,criticalSystemReminder_EXPERIMENTAL:"CRITICAL: This is a READ-ONLY task. You CANNOT edit, write, or create files."}';

function createClaudeSdkCliFixture() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-claude-sdk-patch-'));
  const cliDir = path.join(tempDir, 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
  fs.mkdirSync(cliDir, { recursive: true });
  const cliPath = path.join(cliDir, 'cli.js');
  fs.writeFileSync(
    cliPath,
    ['before', CYGPATH_SNIPPET, EXPLORE_AGENT_SNIPPET, 'after'].join('\n'),
    'utf8',
  );
  return { tempDir, cliPath };
}

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

test('electron dev scripts use IPv4 loopback for Vite readiness', () => {
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  const mainProcessSource = fs.readFileSync(mainProcessPath, 'utf8');
  const electronDevScript = packageJson.scripts?.['electron:dev'] || '';
  const startElectronScript = packageJson.scripts?.['start:electron'] || '';

  assert.match(
    electronDevScript,
    /http:\/\/127\.0\.0\.1:5175/,
    'electron:dev should wait for the Vite server on IPv4 loopback so localhost cannot resolve to an unrelated ::1 listener',
  );
  assert.doesNotMatch(
    electronDevScript,
    /http:\/\/localhost:5175/,
    'electron:dev should not wait on localhost because wait-on may probe IPv6 ::1 before this project server',
  );
  assert.match(
    startElectronScript,
    /ELECTRON_START_URL=http:\/\/127\.0\.0\.1:5175/,
    'Electron should load the same IPv4 loopback URL that electron:dev waits for',
  );
  assert.match(
    mainProcessSource,
    /ELECTRON_START_URL \|\| 'http:\/\/127\.0\.0\.1:5175'/,
    'The main process development fallback should avoid localhost for direct Electron starts too',
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

test('CoworkRunner uses MetaBot DeepSeek automation model for local service execution', () => {
  const source = fs.readFileSync(coworkRunnerPath, 'utf8');

  assert.match(
    source,
    /resolveApiConfigForModel/,
    'CoworkRunner should be able to resolve a MetaBot-scoped automation model',
  );
  assert.match(
    source,
    /getSessionAutomationModelOverride/,
    'CoworkRunner should inspect the session MetaBot before local execution',
  );
  assert.match(
    source,
    /getEnhancedEnvWithTmpdir\(\s*cwd,\s*'local',\s*apiConfig\s*\)/,
    'CoworkRunner should pass the resolved API config into the child process environment',
  );
});

test('Claude SDK CLI patch makes the built-in Explore sub-agent inherit the main model', (t) => {
  const { tempDir, cliPath } = createClaudeSdkCliFixture();
  t.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  execFileSync(process.execPath, [claudeSdkCliPatchScriptPath], { cwd: tempDir, stdio: 'pipe' });

  const patched = fs.readFileSync(cliPath, 'utf8');
  assert.match(
    patched,
    /agentType:"Explore"[\s\S]*?model:"inherit"/,
    'Explore should inherit the parent Cowork model instead of forcing Claude Haiku',
  );
  assert.doesNotMatch(
    patched,
    /agentType:"Explore"[\s\S]*?model:"haiku"/,
    'Explore must not keep the SDK default haiku override',
  );
});

test('CoworkRunner injects SDK subagent overrides that inherit the main model', () => {
  const source = fs.readFileSync(coworkRunnerPath, 'utf8');

  assert.match(
    source,
    /buildCoworkSdkAgentOverrides/,
    'CoworkRunner should build explicit SDK agent overrides instead of depending on SDK built-ins',
  );
  assert.match(
    source,
    /Explore[\s\S]*?model:\s*'inherit'/,
    'Explore subagent override should inherit the active Cowork model',
  );
  assert.match(
    source,
    /'general-purpose'[\s\S]*?model:\s*'inherit'/,
    'general-purpose subagent override should inherit the active Cowork model',
  );
  assert.match(
    source,
    /options\.agents\s*=\s*\{[\s\S]*?buildCoworkSdkAgentOverrides\(\)/,
    'CoworkRunner should pass the overrides through SDK options.agents',
  );
});
