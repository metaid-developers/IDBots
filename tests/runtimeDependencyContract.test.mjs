import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const packageJsonPath = path.join(process.cwd(), 'package.json');
const mainProcessPath = path.join(process.cwd(), 'src', 'main', 'main.ts');
const skillManagerPath = path.join(process.cwd(), 'src', 'main', 'skillManager.ts');
const coworkUtilPath = path.join(process.cwd(), 'src', 'main', 'libs', 'coworkUtil.ts');
const metaidRpcServerPath = path.join(process.cwd(), 'src', 'main', 'services', 'metaidRpcServer.ts');
const coworkRunnerPath = path.join(process.cwd(), 'src', 'main', 'libs', 'coworkRunner.ts');
const electronMainExternalsPath = path.join(process.cwd(), 'scripts', 'electron-main-externals.cjs');
const viteConfigPath = path.join(process.cwd(), 'vite.config.ts');
const require = createRequire(import.meta.url);

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

test('Electron Node shim covers macOS/Linux, not just Windows', () => {
  const source = fs.readFileSync(coworkUtilPath, 'utf8');

  assert.doesNotMatch(
    source,
    /ensureWindowsElectronNodeShim/,
    'The shim writer must be platform-agnostic; a win32-only name means the gate is back',
  );
  const shimFn = source.match(/function ensureElectronNodeShim\(\)[\s\S]*?\n}/);
  assert.ok(shimFn, 'ensureElectronNodeShim must exist');
  assert.doesNotMatch(
    shimFn[0].slice(0, shimFn[0].indexOf('try {')),
    /process\.platform !== 'win32'/,
    'ensureElectronNodeShim must not return null on macOS/Linux — packaged macOS users without a system Node get ENOENT for every skill script otherwise',
  );

  // \r? — the Windows runner checks out with CRLF line endings; a bare \n}\n
  // only matches on LF checkouts (SOP §11.9: static source assertions must be
  // line-ending agnostic or they go red on exactly one platform).
  const overridesFn = source.match(/function applyPackagedEnvOverrides[\s\S]*?\r?\n}\r?\n/);
  assert.ok(overridesFn, 'applyPackagedEnvOverrides must exist');
  assert.match(
    overridesFn[0],
    /if \(!app\.isPackaged\) \{\s*injectElectronNodeShim\(\);/,
    'Non-Windows dev mode must also inject the shim so behavior matches packaged builds',
  );
  assert.match(
    overridesFn[0],
    /listNvmNodeBinDirs\(home\)/,
    'The macOS PATH fallback must enumerate ~/.nvm/versions/node instead of the nonexistent ~/.nvm/current/bin',
  );
  assert.doesNotMatch(
    overridesFn[0],
    /\.nvm['"`],\s*['"`]current/,
    'nvm has no current symlink; the stale fallback path must not come back',
  );
  // The fallback injection must come after the user-shell PATH assignment on
  // POSIX or resolveUserShellPath would overwrite it.
  const userPathIdx = overridesFn[0].indexOf('resolveUserShellPath()');
  const posixInjectIdx = overridesFn[0].lastIndexOf('injectElectronNodeShim();');
  assert.ok(
    userPathIdx > -1 && posixInjectIdx > userPathIdx,
    'On macOS/Linux the shim fallback must run after user-shell PATH resolution',
  );
  const injectFn = overridesFn[0].match(/const injectElectronNodeShim[\s\S]*?\n  \};/);
  assert.ok(injectFn, 'The POSIX shim injector must have a bounded implementation');
  assert.match(
    injectFn[0],
    /appendEnvPathFallback\(pathValueOf\(env\), \[shimInfo\.shimDir\]\)/,
    'An installed system Node/npm must win over the Electron shim; only a missing runtime falls back to Electron',
  );
  assert.doesNotMatch(
    injectFn[0],
    /appendEnvPath\(pathValueOf\(env\), \[shimInfo\.shimDir\]\)/,
    'Do not prepend the Electron shim on POSIX: it launches two Electron processes and creates exec Dock tiles even with real Node installed',
  );
});

test('system Chromium resolver covers platform fallbacks and cache misses', () => {
  const { resolveSystemChromium } = require('../dist-electron/main/libs/chromiumRuntime.js');
  const edge = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
  assert.deepEqual(
    resolveSystemChromium({ platform: 'darwin', existsSync: (candidate) => candidate === edge }),
    { executablePath: edge },
    'macOS must fall back to an installed Chromium-based browser',
  );
  assert.deepEqual(
    resolveSystemChromium({ platform: 'darwin', existsSync: () => false }),
    {},
    'No installed browser must stay an empty resolution instead of a fabricated path',
  );
  const windowsChrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  assert.deepEqual(
    resolveSystemChromium({
      platform: 'win32',
      env: { PROGRAMFILES: 'C:\\Program Files' },
      existsSync: (candidate) => candidate === windowsChrome,
    }),
    { executablePath: windowsChrome },
    'Windows resolution must preserve the existing PROGRAMFILES behavior',
  );
  assert.deepEqual(
    resolveSystemChromium({ platform: 'linux', existsSync: (candidate) => candidate === '/usr/bin/chromium' }),
    { executablePath: '/usr/bin/chromium' },
    'Linux resolution must retain the Chromium fallback',
  );
});

test('skill host env points Playwright MCP at an app-bundled Chromium on macOS', () => {
  const coworkSource = fs.readFileSync(coworkUtilPath, 'utf8');
  const mainSource = fs.readFileSync(mainProcessPath, 'utf8');
  assert.match(
    coworkSource,
    /process\.env\.PLAYWRIGHT_MCP_EXECUTABLE_PATH/,
    'An explicit user-provided Playwright executable must take precedence',
  );
  assert.match(
    coworkSource,
    /env\.PLAYWRIGHT_MCP_EXECUTABLE_PATH = playwrightExecutable/,
    'Skill and DSH child processes must inherit the resolved browser executable',
  );
  assert.match(
    coworkSource,
    /process\.platform === 'darwin'[\s\S]*?detectSystemChromium\(\)\.executablePath/,
    'The automatic fallback must be scoped to macOS, where unbundled headless-shell creates exec Dock tiles',
  );
  assert.match(
    mainSource,
    /import \{ detectSystemChromium \} from '\.\/libs\/chromiumRuntime'/,
    'The built-in browser automation provider must share the same resolver',
  );
  assert.doesNotMatch(
    mainSource,
    /let systemChromiumCache/,
    'The one-shot TCC probe cache must move with the resolver, not be duplicated in main.ts',
  );
  const skillServicesSource = fs.readFileSync(path.join(process.cwd(), 'src', 'main', 'skillServices.ts'), 'utf8');
  const skillManagerSource = fs.readFileSync(skillManagerPath, 'utf8');
  for (const [name, source] of [['coworkUtil', coworkSource], ['skillServices', skillServicesSource], ['skillManager', skillManagerSource]]) {
    assert.match(source, /resolveElectronSkillExecutablePath/, `${name} must use the background skill executable`);
    assert.doesNotMatch(source, /resolveElectronExecutablePath/, `${name} must not launch the ordinary Dock app binary for background skills`);
  }
});

test('official Playwright wrapper uses the standalone CLI package and full-Chromium guidance', () => {
  const wrapper = fs.readFileSync(
    path.join(process.cwd(), 'SKILLs', 'playwright', 'scripts', 'playwright_cli.sh'),
    'utf8',
  );
  assert.match(
    wrapper,
    /--package @playwright\/cli playwright-cli/,
    'The CLI moved out of @playwright/mcp; the wrapper must use the standalone @playwright/cli package',
  );
  assert.doesNotMatch(
    wrapper,
    /--package @playwright\/mcp playwright-cli/,
    'The old package/command pair fails with playwright-cli: command not found',
  );
  const skillDoc = fs.readFileSync(path.join(process.cwd(), 'SKILLs', 'playwright', 'SKILL.md'), 'utf8');
  assert.match(
    skillDoc,
    /channel: 'chromium', headless: true/,
    'Direct library examples must select full Chromium instead of the unbundled headless shell on macOS',
  );
});

test('skillManager npm spawns use the login-shell-aware skill env', () => {
  const source = fs.readFileSync(skillManagerPath, 'utf8');
  assert.match(
    source,
    /getSkillHostEnv/,
    'npm install for bundled skills must see the login-shell PATH (Finder-launched apps have a bare PATH)',
  );
  assert.equal(
    (source.match(/env: this\.skillChildEnv\(\)/g) || []).length >= 2,
    true,
    'Both hasNpm and runNpmInstall must spawn with the skill env',
  );
});

test('MetaID RPC 401 tells callers how to authenticate', () => {
  const source = fs.readFileSync(metaidRpcServerPath, 'utf8');
  assert.match(
    source,
    /error: 'Unauthorized',\s*\n?\s*hint:/,
    'A bare 401 makes bots guess at settings toggles; include a hint pointing at IDBOTS_RPC_TOKEN / IDBOTS_RPC_AUTHFILE',
  );
});

test('Electron main build externalizes heavy runtime dependencies', () => {
  const { createElectronMainExternalPredicate } = require(electronMainExternalsPath);
  const external = createElectronMainExternalPredicate();
  const viteConfigSource = fs.readFileSync(viteConfigPath, 'utf8');

  assert.equal(external('@metalet/utxo-wallet-service'), true);
  assert.equal(external('@metalet/utxo-wallet-service/dist/index.js'), true);
  assert.equal(external('meta-contract'), true);
  assert.equal(external('@larksuiteoapi/node-sdk'), true);
  assert.equal(external('@scure/bip39/wordlists/english'), true);
  assert.equal(external('electron'), true);
  assert.equal(external('node:path'), true);
  assert.equal(external('./services/metabotWalletService'), false);
  assert.equal(external('/absolute/project/src/main/main.ts'), false);

  assert.match(
    viteConfigSource,
    /createElectronMainExternalPredicate/,
    'vite.config.ts should use the shared Electron main external predicate',
  );
  assert.match(
    viteConfigSource,
    /external:\s*electronMainExternal/,
    'Electron main Rollup config should externalize runtime dependencies instead of bundling node_modules into main.js',
  );
});

test('production Vite builds minify bundles without source maps', () => {
  const viteConfigSource = fs.readFileSync(viteConfigPath, 'utf8');

  assert.match(
    viteConfigSource,
    /const isProductionBuild = process\.env\.NODE_ENV === 'production'/,
    'vite.config.ts should keep a single production-build flag for build output options',
  );
  assert.equal(
    (viteConfigSource.match(/sourcemap:\s*!isProductionBuild/g) || []).length,
    3,
    'renderer, Electron main, and preload builds should omit source maps in production',
  );
  assert.equal(
    (viteConfigSource.match(/minify:\s*isProductionBuild\s*\?\s*'esbuild'\s*:\s*false/g) || []).length,
    3,
    'renderer, Electron main, and preload builds should minify only production bundles',
  );
});

test('Vite dev file watching avoids polling generated output by default', () => {
  const viteConfigSource = fs.readFileSync(viteConfigPath, 'utf8');

  assert.doesNotMatch(
    viteConfigSource,
    /usePolling:\s*true/,
    'Vite should not force polling by default because it keeps macOS dev servers busy even when idle',
  );
  assert.match(
    viteConfigSource,
    /const shouldUseVitePolling = process\.env\.IDBOTS_VITE_USE_POLLING === '1'/,
    'Polling should remain available as an explicit opt-in for filesystems that need it',
  );
  assert.match(
    viteConfigSource,
    /\*\*\/dist-electron\/\*\*/,
    'Vite should ignore Electron build output so generated files do not trigger dev rebuild work',
  );
  assert.match(
    viteConfigSource,
    /\*\*\/dist\/\*\*/,
    'Vite should ignore renderer build output while watching source files',
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

test('DeepSeek missing reasoning_content failures are classified for leftover sandbox retries', () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), 'src', 'main', 'libs', 'coworkProviderErrors.ts'),
    'utf8',
  );

  assert.match(
    source,
    /export function isDeepSeekMissingReasoningContentError\(message: string\): boolean/,
    'DeepSeek thinking history failures stay classified explicitly',
  );
});

test('CoworkRunner uses MetaBot automation model for local DSH execution', () => {
  const source = fs.readFileSync(coworkRunnerPath, 'utf8');

  assert.match(
    source,
    /resolveDshProviderRoute/,
    'CoworkRunner should resolve a MetaBot-scoped DSH provider route',
  );
  assert.match(
    source,
    /getSessionAutomationBrain/,
    'CoworkRunner should inspect the session MetaBot before local execution',
  );
  assert.match(
    source,
    /writeDshSkillSessionEnvFile/,
    'CoworkRunner should persist session env for DSH bash instead of Claude SDK child env',
  );
});

test('DSH shared runtime injects skill host env including IDBOTS_API_BASE_URL', () => {
  const coworkDshTurnSource = fs.readFileSync(
    path.join(process.cwd(), 'src', 'main', 'libs', 'coworkDshTurn.ts'),
    'utf8',
  );
  const coworkUtilSource = fs.readFileSync(
    path.join(process.cwd(), 'src', 'main', 'libs', 'coworkUtil.ts'),
    'utf8',
  );
  const coworkRunnerSource = fs.readFileSync(coworkRunnerPath, 'utf8');

  assert.match(
    coworkUtilSource,
    /export function getSkillHostEnv/,
    'Skill host env must be a shared helper so Claude and DSH inject the same channels',
  );
  assert.match(
    coworkUtilSource,
    /env\.IDBOTS_API_BASE_URL = internalApiBaseURL/,
    'getSkillHostEnv must set IDBOTS_API_BASE_URL from the local cowork proxy',
  );
  assert.match(
    coworkDshTurnSource,
    /skillHostEnvProvider/,
    'DshTurnHub must accept a skill-host env provider for the shared child env',
  );
  assert.match(
    coworkDshTurnSource,
    /export function buildDshChildEnv/,
    'DSH child env merge must stay a testable helper',
  );
  assert.match(
    coworkRunnerSource,
    /skillHostEnvProvider:\s*\(\)\s*=>\s*\(\{[\s\S]*getSkillHostEnv\(\)[\s\S]*ensureDshSkillEnvChannel/,
    'CoworkRunner must wire getSkillHostEnv plus the BASH_ENV skill-session channel into the shared DSH runtime',
  );
  const skillHostFn = coworkUtilSource.match(
    /export function getSkillHostEnv\(\)[\s\S]*?export async function getEnhancedEnv/,
  );
  assert.ok(skillHostFn, 'getSkillHostEnv must remain a bounded helper before getEnhancedEnv');
  assert.match(
    skillHostFn[0],
    /applyPackagedEnvOverrides\(env\)/,
    'DSH skill host env must reuse Claude PATH/mingit injection so Windows bash is findable',
  );
  assert.match(
    skillHostFn[0],
    /PATH:\s*process\.env\.PATH/,
    'getSkillHostEnv must seed PATH before mingit prepend',
  );
  const dshKernelSource = fs.readFileSync(
    path.join(process.cwd(), 'src', 'main', 'libs', 'dshKernel', 'dshKernel.ts'),
    'utf8',
  );
  assert.match(
    dshKernelSource,
    /mergeDshRuntimeProcessEnv\(\{\s*configEnv:\s*config\.env\s*\}\)/,
    'DSH runtime spawn must collapse Windows Path/PATH so injected mingit wins',
  );
});

test('DSH per-session skill env rides BASH_ENV after KEY/TOKEN scrub', () => {
  const coworkRunnerSource = fs.readFileSync(coworkRunnerPath, 'utf8');
  const coworkUtilSource = fs.readFileSync(
    path.join(process.cwd(), 'src', 'main', 'libs', 'coworkUtil.ts'),
    'utf8',
  );
  const dshSkillEnvSource = fs.readFileSync(
    path.join(process.cwd(), 'src', 'main', 'libs', 'dshSkillSessionEnv.ts'),
    'utf8',
  );

  assert.match(
    dshSkillEnvSource,
    /export const DSH_SKILL_ENV_LOADER_ENV = 'BASH_ENV'/,
    'Loader must use BASH_ENV so it survives DSH KEY/TOKEN scrub',
  );
  assert.match(
    dshSkillEnvSource,
    /DSH_SESSION_ID/,
    'Loader must select the env file by per-execution DSH_SESSION_ID',
  );
  assert.match(
    coworkUtilSource,
    /IDBOTS_RPC_URL\s*[:=]\s*getMetaidRpcBase\(\)/,
    'getSkillHostEnv must set IDBOTS_RPC_URL for skill scripts (global, not per-bot)',
  );
  assert.match(
    coworkRunnerSource,
    /private async syncDshSkillSessionEnv/,
    'CoworkRunner must write a per-DSH-session env file before the turn',
  );
  assert.match(
    coworkRunnerSource,
    /writeDshSkillSessionEnvFile/,
    'CoworkRunner must persist getSkillSessionEnvOverrides into the DSH session env file',
  );
  assert.match(
    coworkRunnerSource,
    /copyDshSkillSessionEnvFile/,
    'Subagent DSH sessions must inherit the parent skill env file',
  );
  assert.match(
    coworkRunnerSource,
    /private async runLocalKernel/,
    'Local sandbox fallbacks must dispatch through runLocalKernel so DSH stays the default',
  );
  assert.doesNotMatch(
    coworkUtilSource,
    /loadClaudeSdk/,
    'generateSessionTitle must not spawn the sunset Claude Agent SDK',
  );
  assert.match(
    coworkUtilSource,
    /chatCompletionWithTools/,
    'generateSessionTitle must use the configured provider one-shot, not a truncated first line',
  );
  assert.match(
    coworkRunnerSource,
    /Consumed queued manual compact via native DSH compactNow/,
    'runDshSessionLocal must consume leftover queued compact via native compactNow',
  );
  const mainProcessSource = fs.readFileSync(mainProcessPath, 'utf8');
  assert.doesNotMatch(
    mainProcessSource,
    /loadClaudeSdk/,
    'Subagent panel IPC must not load the retired Claude Agent SDK',
  );
  assert.doesNotMatch(
    mainProcessSource,
    /prewarmClaudeSdk/,
    'App startup must not pre-load the sunset Claude Agent SDK',
  );
  assert.match(
    mainProcessSource,
    /void getCoworkRunner\(\)\.prewarmDshRuntime\(\)/,
    'App startup must fire-and-forget DSH runtime warmup after first paint',
  );
  assert.match(
    coworkRunnerSource,
    /prewarmDshRuntime\(\): Promise<void>/,
    'CoworkRunner must expose DSH runtime warmup for app-ready',
  );
  const coworkDshTurnSource = fs.readFileSync(
    path.join(process.cwd(), 'src', 'main', 'libs', 'coworkDshTurn.ts'),
    'utf8',
  );
  assert.match(
    coworkDshTurnSource,
    /async prewarm\(input:/,
    'DshTurnHub must expose a spawn-only prewarm that does not send a prompt',
  );
  assert.match(
    coworkDshTurnSource,
    /kernelEnsureChain/,
    'Warmup and the first turn must serialize ensureRuntime so they cannot double-spawn',
  );
  assert.match(
    coworkDshTurnSource,
    /pinWorkspace: input\.pinWorkspace === true/,
    'Warmup workspace pin must stay opt-in (default off) so incidental prewarms cannot claim the composition cwd',
  );
  assert.match(
    coworkRunnerSource,
    /\.\.\.\(cwd \? \{ workspace: \{ cwd \} \} : \{\}\),[\s\S]*?pinWorkspace: true/,
    'App-ready warmup may pin the workspace, but only with the resolved session/config cwd — never a guess',
  );
  assert.match(
    coworkDshTurnSource,
    /cwd: input\.workspace\.cwd/,
    'Each DSH turn must pass the cowork workspace cwd on session/ensure so bash/fs do not share the first-pinned composition default',
  );
  const sdkServerSource = fs.readFileSync(
    path.join(process.cwd(), 'dsh-runtime', 'plugins', 'idbots-sdk-server.mjs'),
    'utf8',
  );
  assert.match(
    sdkServerSource,
    /idbotsBindWorkspace/,
    'session/ensure must bind session.header.cwd so Twin and Worker keep separate workspaces',
  );
  assert.match(
    sdkServerSource,
    /idbotsDisposeSession/,
    'session/dispose must exist so a provider switch can evict the old live agent',
  );
  assert.match(
    coworkDshTurnSource,
    /disposeSessionOnSlot/,
    'A mid-session provider switch must dispose the previous runtime\'s live agent',
  );
  assert.match(
    coworkRunnerSource,
    /async closeDshRuntime/,
    'CoworkRunner must close the DSH hub on app quit',
  );
  const dshKernelSource = fs.readFileSync(
    path.join(process.cwd(), 'src', 'main', 'libs', 'dshKernel', 'dshKernel.ts'),
    'utf8',
  );
  assert.match(
    dshKernelSource,
    /resolveElectronExecutablePath\(\)/,
    'DSH runtime spawn must use resolveElectronExecutablePath, not raw process.execPath',
  );
  const dshBinSource = fs.readFileSync(
    path.join(process.cwd(), 'dsh-runtime', 'bin.mjs'),
    'utf8',
  );
  assert.match(
    dshBinSource,
    /installWin32SpawnShim/,
    'DSH bin must install the Windows spawn shim so bash gets windowsHide and an absolute bash.exe',
  );
  assert.match(
    coworkRunnerSource,
    /Auto-allowed native DSH approval/,
    'acceptEdits/bypass must skip native DSH onApprovalRequest so unattended workers are not 60s-denied',
  );
  assert.match(
    coworkRunnerSource,
    /cancelAgent\(taskId/,
    'Subagent Stop must cancel the child DSH agent id',
  );
  assert.match(
    coworkRunnerSource,
    /'todo_write', 'todowrite'/,
    'Plan-mode allow-list must include the DSH todo_write name',
  );
  assert.match(
    coworkRunnerSource,
    /rewriteWin32McpStdioServer/,
    'MCP stdio commands must be rewritten to npx.cmd/npm.cmd at the DSH boundary',
  );
  assert.match(
    coworkRunnerSource,
    /appendPythonRuntimeToEnv|ensurePythonRuntimeReady/,
    'Windows Python runtime must be wired into skill env or warmup',
  );
  const pluginManagerSource = fs.readFileSync(
    path.join(process.cwd(), 'src', 'main', 'libs', 'dshPluginManager.ts'),
    'utf8',
  );
  assert.match(
    pluginManagerSource,
    /rewriteWin32StdioCommand\('npm'\)/,
    'DSH plugin install must spawn npm.cmd on Windows',
  );
  assert.match(
    pluginManagerSource,
    /fs\.cpSync/,
    'DSH plugin peer linking must copy when a junction cannot be created',
  );
  assert.match(
    coworkUtilSource,
    /appendPythonRuntimeToEnv\(env\)/,
    'getSkillHostEnv must merge the Windows Python runtime onto PATH',
  );
  const builder = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'electron-builder.json'), 'utf8'));
  assert.ok(
    (builder.win?.extraResources ?? []).some((entry) => entry && entry.to === 'python-win'),
    'Windows extraResources must ship python-win next to mingit',
  );
});
test('Claude Agent SDK is not a runtime dependency', () => {
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  const builder = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'electron-builder.json'), 'utf8'));
  const sandboxRunnerSource = fs.readFileSync(
    path.join(process.cwd(), 'sandbox', 'agent-runner', 'index.js'),
    'utf8',
  );
  const sandboxRunnerPackage = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), 'sandbox', 'agent-runner', 'package.json'), 'utf8'),
  );

  assert.equal(
    packageJson.dependencies['@anthropic-ai/claude-agent-sdk'],
    undefined,
    'Local cowork is DSH-only; the Claude Agent SDK package must be uninstalled',
  );
  assert.equal(
    sandboxRunnerPackage.dependencies['@anthropic-ai/claude-agent-sdk'],
    undefined,
    'Sandbox agent-runner must not depend on the Claude Agent SDK',
  );
  assert.ok(
    packageJson.dependencies['@anthropic-ai/sdk'],
    'Anthropic Messages API client remains for provider format transforms',
  );
  assert.ok(
    packageJson.dependencies['@modelcontextprotocol/sdk'],
    'MCP SDK remains for user-configured MCP servers',
  );
  assert.doesNotMatch(
    packageJson.scripts.postinstall,
    /patch-claude-sdk-cli/,
    'postinstall must not patch the removed cli.js bundle anymore',
  );
  assert.ok(
    !(builder.asarUnpack || []).some((entry) => String(entry).includes('claude-agent-sdk')),
    'Packaged asarUnpack must not ship Claude Agent SDK natives',
  );
  assert.equal(
    fs.existsSync(path.join(process.cwd(), 'src', 'main', 'libs', 'claudeSdk.ts')),
    false,
    'claudeSdk.ts must be deleted once the package is gone',
  );
  assert.doesNotMatch(
    fs.readFileSync(coworkRunnerPath, 'utf8'),
    /@anthropic-ai\/claude-agent-sdk/,
    'CoworkRunner must not import the Claude Agent SDK',
  );
  assert.doesNotMatch(
    sandboxRunnerSource,
    /import\(['"]@anthropic-ai\/claude-agent-sdk['"]\)/,
    'Sandbox agent-runner must not dynamically import the Claude Agent SDK',
  );
});

test('sandbox agent-runner refuses to boot the retired Claude Agent SDK', () => {
  const sandboxRunnerSource = fs.readFileSync(
    path.join(process.cwd(), 'sandbox', 'agent-runner', 'index.js'),
    'utf8',
  );

  assert.match(
    sandboxRunnerSource,
    /Claude Agent SDK has been removed/,
    'Guest runner must fail closed instead of calling sdk.query',
  );
});

test('cowork subprocess env disables Claude Code nonessential external traffic', () => {
  const coworkUtilSource = fs.readFileSync(
    path.join(process.cwd(), 'src', 'main', 'libs', 'coworkUtil.ts'),
    'utf8',
  );

  for (const flag of [
    'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
    'DISABLE_TELEMETRY',
    'DISABLE_ERROR_REPORTING',
    'DISABLE_AUTOUPDATER',
    'DISABLE_BUG_COMMAND',
  ]) {
    assert.match(
      coworkUtilSource,
      new RegExp(`env\\.${flag} = '1'`),
      `${flag} must be forced on so leftover Claude Code subprocesses never depend on Anthropic-operated endpoints`,
    );
  }
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
    /const agentModel = model\?\.trim\(\) \? model\.trim\(\) : undefined/,
    'CoworkRunner should derive an explicit subagent model from the active Cowork model',
  );
  assert.match(
    source,
    /Explore[\s\S]*?\.\.\.\(agentModel \? \{ model: agentModel \} : \{\}\)/,
    'Explore subagent override should inherit the active Cowork model',
  );
  assert.match(
    source,
    /'general-purpose'[\s\S]*?\.\.\.\(agentModel \? \{ model: agentModel \} : \{\}\)/,
    'general-purpose subagent override should inherit the active Cowork model',
  );
  assert.match(
    source,
    /agents:\s*buildCoworkSdkAgentOverrides\(/,
    'Sandbox Claude SDK path should pass the overrides through SDK options.agents',
  );
});

test('sandbox runner mirrors IDBots cross-session host tools', () => {
  const sandboxRunnerPath = path.join(process.cwd(), 'sandbox/agent-runner/index.js');
  const source = fs.readFileSync(sandboxRunnerPath, 'utf8');

  assert.ok(
    source.includes('idbots_session_read_all'),
    'Sandbox runner should expose the full-session IDBots host tool',
  );
  assert.ok(
    source.includes('idbots_session_read_latest'),
    'Sandbox runner should expose the latest-message IDBots host tool',
  );
  assert.ok(
    source.includes('idbots_session_insert_user_message'),
    'Sandbox runner should expose the cross-session insert IDBots host tool',
  );
  assert.ok(
    source.includes("callHostTool('idbots_session_read_all'"),
    'Sandbox full-session tool should delegate to the matching host tool',
  );
  assert.ok(
    source.includes("callHostTool('idbots_session_read_latest'"),
    'Sandbox latest-message tool should delegate to the matching host tool',
  );
  assert.ok(
    source.includes("callHostTool('idbots_session_insert_user_message'"),
    'Sandbox insert tool should delegate to the matching host tool',
  );
  assert.ok(
    source.includes('twinOrchestrationEnabled === true') && source.includes("callHostTool('local_workers_list'"),
    'Sandbox Twin directory tool should be gated by trusted orchestration enablement and call the host',
  );
  assert.ok(
    source.includes("callHostTool('local_worker_delegate'"),
    'Sandbox Worker delegation tool should delegate to the host',
  );
  for (const toolName of ['twin_task_status', 'twin_task_cancel', 'twin_task_reassign']) {
    assert.ok(source.includes(`callHostTool('${toolName}'`), `Sandbox should delegate ${toolName} to the host`);
  }
});

test('CoworkRunner prompt teaches IDBots session links and write boundary', () => {
  const source = fs.readFileSync(coworkRunnerPath, 'utf8');

  assert.ok(
    source.includes('IDBots://{sessionId}'),
    'CoworkRunner prompt should teach the IDBots session link format',
  );
  assert.ok(
    source.includes('idbots_session_read_all'),
    'CoworkRunner prompt should mention the full-session read tool',
  );
  assert.ok(
    source.includes('idbots_session_read_latest'),
    'CoworkRunner prompt should mention the latest-message read tool',
  );
  assert.ok(
    source.includes('idbots_session_insert_user_message'),
    'CoworkRunner prompt should mention the cross-session insert tool',
  );
  assert.ok(
    source.includes('A2A sessions are read-only'),
    'CoworkRunner prompt should describe the A2A write boundary',
  );
});

test('Twin orchestration tools have a host-side gate and trusted sandbox registration flag', () => {
  const source = fs.readFileSync(coworkRunnerPath, 'utf8');
  assert.match(source, /toolName === 'local_workers_list'[\s\S]*?isTwinSession\(sessionId\)/);
  assert.match(source, /toolName === 'local_worker_delegate'[\s\S]*?isTwinSession\(sessionId\)/);
  for (const toolName of ['twin_task_status', 'twin_task_cancel', 'twin_task_reassign']) {
    assert.match(source, new RegExp(`toolName === '${toolName}'[\\s\\S]*?isTwinSession\\(sessionId\\)`));
  }
  assert.match(source, /twinOrchestrationEnabled: Boolean\(this\.listLocalWorkers && this\.isTwinSession\(sessionId\)\)/);
});

test('release packaging wires nested DSH runtime install, extraResources, and pack gates', () => {
  const {
    extraResourceFilterExcludesNodeModules,
    RUNTIME_DEAD_FILE_FILTERS,
    RUNTIME_TEST_DIRECTORY_FILTERS,
    RESOURCE_DOT_ENTRY_FILTERS,
  } = require('../scripts/packagedRuntimes.cjs');
  const workflow = fs.readFileSync(path.join(process.cwd(), '.github/workflows/build.yml'), 'utf8');
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  const builder = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'electron-builder.json'), 'utf8'));
  const hooks = fs.readFileSync(path.join(process.cwd(), 'scripts/electron-builder-hooks.cjs'), 'utf8');
  const runtimePkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'dsh-runtime/package.json'), 'utf8'));
  const dshResource = (builder.extraResources || []).find((entry) => entry && entry.from === 'dsh-runtime');

  assert.match(
    workflow,
    /working-directory:\s*dsh-runtime[\s\S]*?run:\s*pnpm install --frozen-lockfile/,
    'CI must pnpm-install dsh-runtime from the committed lockfile so extraResources can copy node_modules',
  );
  assert.match(
    packageJson.scripts.postinstall,
    /pnpm --dir dsh-runtime install/,
    'postinstall must install dsh-runtime so local dist:mac also ships node_modules',
  );
  assert.equal(packageJson.packageManager, 'pnpm@11.24.0', 'the repository must pin pnpm via packageManager');
  assert.ok(
    fs.existsSync(path.join(process.cwd(), 'pnpm-lock.yaml')) && !fs.existsSync(path.join(process.cwd(), 'package-lock.json')),
    'pnpm-lock.yaml must be committed and package-lock.json removed',
  );
  assert.ok(dshResource, 'electron-builder extraResources must copy dsh-runtime');
  assert.equal(
    extraResourceFilterExcludesNodeModules(dshResource.filter),
    false,
    'dsh-runtime extraResources filter must not exclude the node_modules tree',
  );
  for (const pattern of RUNTIME_DEAD_FILE_FILTERS) {
    assert.ok(
      (dshResource.filter || []).includes(pattern),
      `dsh-runtime extraResources filter must keep ${pattern}: declarations and source maps are roughly 43% of the files the Windows installer extracts`,
    );
  }
  for (const pattern of RUNTIME_TEST_DIRECTORY_FILTERS) {
    assert.ok(
      (dshResource.filter || []).includes(pattern),
      `dsh-runtime extraResources filter must keep ${pattern}: dependency test fixtures add thousands of files for NSIS and Defender to process`,
    );
  }
  const skillsResource = (builder.extraResources || []).find((entry) => entry && entry.from === 'SKILLs');
  assert.ok(skillsResource, 'electron-builder extraResources must copy SKILLs');
  for (const pattern of RESOURCE_DOT_ENTRY_FILTERS) {
    assert.ok(
      (skillsResource.filter || []).includes(pattern),
      `SKILLs extraResources filter must keep ${pattern}: git-ignored local scratch dirs (SKILLs/.tmp_*, .cowork-temp) shipped ~30k files / ~1.2 GB in the 1.0.2/1.0.3 installers`,
    );
  }
  for (const pattern of RUNTIME_DEAD_FILE_FILTERS) {
    assert.ok(
      (skillsResource.filter || []).includes(pattern),
      `SKILLs extraResources filter must keep ${pattern}: the web-search node_modules ships dead declarations and source maps otherwise`,
    );
  }
  for (const pattern of RUNTIME_TEST_DIRECTORY_FILTERS) {
    assert.ok(
      (skillsResource.filter || []).includes(pattern),
      `SKILLs extraResources filter must keep ${pattern}: web-search uses playwright-core, whose production files do not require dependency test fixtures`,
    );
  }
  const metaappsResource = (builder.extraResources || []).find((entry) => entry && entry.from === 'METAAPPs');
  assert.ok(metaappsResource, 'electron-builder extraResources must copy METAAPPs');
  for (const pattern of RESOURCE_DOT_ENTRY_FILTERS) {
    assert.ok(
      (metaappsResource.filter || []).includes(pattern),
      `METAAPPs extraResources filter must keep ${pattern}: the same untracked-scratch leak vector applies`,
    );
  }
  assert.match(hooks, /verifySourceRuntimes\(\)/, 'beforePack must fail closed if nested runtime deps are missing');
  assert.match(hooks, /verifyPackagedRuntimes\(context\)/, 'afterPack must fail closed if the copied app Resources omit runtime deps');
  assert.match(hooks, /verifyPackagedContentResources\(context\)/, 'afterPack must fail closed if content resources ship dot-entries or dead files');
  assert.match(
    hooks,
    /verifyMacBackgroundSkillHelper\(appPath, appName\)/,
    'afterPack must require the LSUIElement helper used by background skill processes',
  );
  assert.match(
    hooks,
    /LSUIElement/,
    'the packaging gate must reject helpers that would register as a Dock app',
  );
  assert.match(
    workflow,
    /node scripts\/setup-ffmpeg\.js --required/,
    'CI must download gitignored ffmpeg binaries; electron-builder only warns when the extraResource is missing',
  );
  assert.doesNotMatch(
    workflow,
    /echo "CSC_LINK=\$\{SECRET_CSC_LINK\}" >> "\$GITHUB_ENV"/,
    'macOS packaging must reuse the certificate imported into the workflow keychain instead of making electron-builder create a second keychain',
  );
  assert.match(
    workflow,
    /security find-identity -v -p codesigning "\$KEYCHAIN_PATH"/,
    'macOS signing must verify the imported identity before packaging',
  );
  assert.match(
    workflow,
    /release_tag[\s\S]*?tag_name: \$\{\{ inputs\.release_tag \|\| github\.ref_name \}\}/,
    'manual release reruns must publish the explicitly selected existing tag',
  );
  assert.match(hooks, /ensureFfmpeg\(/, 'beforePack must download ffmpeg for the current target if the binary is absent');
  assert.match(hooks, /verifySourceFfmpeg\(context\)/, 'beforePack must fail closed if ffmpeg was not prepared');
  assert.match(hooks, /verifyPackagedFfmpeg\(context\)/, 'afterPack must fail closed if the copied app Resources omit ffmpeg');
  assert.ok(
    (builder.mac?.extraResources || []).some((entry) => entry && entry.from === 'resources/ffmpeg/ffmpeg-darwin-${arch}'),
    'mac extraResources must copy the arch-specific ffmpeg binary',
  );
  assert.ok(
    (builder.win?.extraResources || []).some((entry) => entry && entry.from === 'resources/ffmpeg/ffmpeg-win32-x64.exe'),
    'win extraResources must copy the Windows ffmpeg binary',
  );
  assert.equal(
    runtimePkg.dependencies['@deepseek-ai/dsh-sdk-client'],
    '0.2.2-rc.1',
    'dsh-sdk-client is a packaged runtime dependency of the Electron host, not a test-only devDependency',
  );
  assert.equal(
    runtimePkg.devDependencies?.['@deepseek-ai/dsh-sdk-client'],
    undefined,
    'dsh-sdk-client must not live in dsh-runtime devDependencies (NODE_ENV=production would omit it)',
  );
  assert.ok(
    fs.existsSync(path.join(process.cwd(), 'dsh-runtime', 'bin.mjs')),
    'dsh-runtime/bin.mjs must exist for the packaged DSH kernel entry',
  );
});

test('packaged runtime gates fail closed on missing source and packaged markers', () => {
  const {
    missingMarkers,
    verifySourceRuntimes,
    verifyPackagedRuntimes,
    verifySourceFfmpeg,
    verifyPackagedFfmpeg,
    resolvePackagedResourcesDir,
    resolveFfmpegPlatformKey,
    extraResourceFilterExcludesNodeModules,
    isRuntimeDeadFile,
    findPackagedRuntimeDeadFiles,
    RUNTIME_DEAD_FILE_SUFFIXES,
    RUNTIME_DEAD_FILE_FILTERS,
  } = require('../scripts/packagedRuntimes.cjs');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-packaged-runtimes-'));

  try {
    assert.deepEqual(
      missingMarkers(tmpRoot, ['bin.mjs', path.join('node_modules', 'missing.js')]),
      ['bin.mjs', path.join('node_modules', 'missing.js')],
    );
    fs.writeFileSync(path.join(tmpRoot, 'bin.mjs'), 'ok');
    assert.deepEqual(missingMarkers(tmpRoot, ['bin.mjs']), []);

    assert.throws(
      () => verifySourceRuntimes(tmpRoot),
      /dsh-runtime\/bin\.mjs/,
    );

    const macResources = resolvePackagedResourcesDir({
      appOutDir: path.join(tmpRoot, 'mac-out'),
      electronPlatformName: 'darwin',
      packager: { appInfo: { productFilename: 'IDBots' } },
    });
    assert.equal(
      macResources,
      path.join(tmpRoot, 'mac-out', 'IDBots.app', 'Contents', 'Resources'),
    );
    assert.throws(
      () => verifyPackagedRuntimes({
        appOutDir: path.join(tmpRoot, 'mac-out'),
        electronPlatformName: 'darwin',
        packager: { appInfo: { productFilename: 'IDBots' } },
      }),
      /dsh-runtime\/bin\.mjs/,
    );

    assert.equal(
      resolveFfmpegPlatformKey({ electronPlatformName: 'darwin', arch: 3 }),
      'darwin-arm64',
    );
    assert.equal(
      resolveFfmpegPlatformKey({ electronPlatformName: 'win32', arch: 1 }),
      'win32-x64',
    );
    assert.equal(
      resolveFfmpegPlatformKey({ electronPlatformName: 'linux', arch: 1 }),
      null,
    );
    const macFfmpegContext = {
      appOutDir: path.join(tmpRoot, 'mac-out'),
      electronPlatformName: 'darwin',
      arch: 'arm64',
      packager: { appInfo: { productFilename: 'IDBots' } },
    };
    assert.throws(
      () => verifySourceFfmpeg(macFfmpegContext, tmpRoot),
      /bundled ffmpeg for darwin-arm64/,
    );
    assert.throws(
      () => verifyPackagedFfmpeg(macFfmpegContext),
      /missing bundled ffmpeg/,
    );

    assert.equal(extraResourceFilterExcludesNodeModules(['**/*', '!**/node_modules/**']), true);
    assert.equal(extraResourceFilterExcludesNodeModules(['**/*', '!**/node_modules']), true);
    assert.equal(extraResourceFilterExcludesNodeModules(['**/*', '!node_modules/**/*']), true);
    assert.equal(extraResourceFilterExcludesNodeModules(['**/*', '!**/.test-sessions/**']), false);
    assert.equal(
      extraResourceFilterExcludesNodeModules(['**/*', ...RUNTIME_DEAD_FILE_FILTERS]),
      false,
      'dropping declarations and source maps inside node_modules is not a node_modules exclusion',
    );

    assert.ok(
      !RUNTIME_DEAD_FILE_SUFFIXES.includes('.md'),
      'markdown is not dead weight: the DSH kernel loads SKILL.md and DevTools issue descriptions from node_modules at run time',
    );
    for (const name of ['index.d.ts', 'index.d.mts', 'index.d.cts', 'index.js.map', 'index.d.mts.map']) {
      assert.equal(isRuntimeDeadFile(name), true, `${name} is never loaded at run time`);
    }
    for (const name of ['index.js', 'index.mjs', 'index.cjs', 'index.ts', 'package.json', 'LICENSE', 'run.cmd', 'README.md', 'SKILL.md']) {
      assert.equal(isRuntimeDeadFile(name), false, `${name} must stay in the package`);
    }

    const runtimeRoot = path.join(tmpRoot, 'mac-out', 'IDBots.app', 'Contents', 'Resources', 'dsh-runtime');
    const pkgDir = path.join(runtimeRoot, 'node_modules', 'pkg');
    fs.mkdirSync(path.join(pkgDir, 'node_modules', 'dep'), { recursive: true });
    fs.mkdirSync(path.join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh-sdk-client', 'lib'), { recursive: true });
    fs.mkdirSync(path.join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh-app-boot'), { recursive: true });
    fs.writeFileSync(path.join(runtimeRoot, 'bin.mjs'), 'ok');
    fs.writeFileSync(path.join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh-sdk-client', 'lib', 'index.js'), 'ok');
    fs.writeFileSync(path.join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'package.json'), '{}');
    fs.writeFileSync(path.join(pkgDir, 'index.js'), 'ok');
    fs.writeFileSync(path.join(pkgDir, 'index.d.ts'), 'export {}');
    fs.writeFileSync(path.join(pkgDir, 'index.js.map'), '{}');
    fs.writeFileSync(path.join(pkgDir, 'README.md'), '# pkg');
    fs.writeFileSync(path.join(pkgDir, 'SKILL.md'), '---\nname: pkg\n---');
    fs.writeFileSync(path.join(pkgDir, 'node_modules', 'dep', 'types.d.mts'), 'export {}');
    fs.mkdirSync(path.join(pkgDir, 'tests'), { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'tests', 'fixture.js'), 'not runtime code');
    const playwrightBackend = path.join(runtimeRoot, 'node_modules', 'playwright', 'lib', 'mcp', 'test', 'browserBackend.js');
    fs.mkdirSync(path.dirname(playwrightBackend), { recursive: true });
    fs.writeFileSync(playwrightBackend, 'required by playwright/lib/index.js at runtime');
    assert.deepEqual(findPackagedRuntimeDeadFiles(runtimeRoot), [
      'node_modules/pkg/index.d.ts',
      'node_modules/pkg/index.js.map',
      'node_modules/pkg/node_modules/dep/types.d.mts',
      'node_modules/pkg/tests/fixture.js',
    ]);
    const packagedContext = {
      appOutDir: path.join(tmpRoot, 'mac-out'),
      electronPlatformName: 'darwin',
      packager: { appInfo: { productFilename: 'IDBots' } },
    };
    assert.throws(
      () => verifyPackagedRuntimes(packagedContext),
      /4 file\(s\) nothing loads at run time[\s\S]*dsh-runtime\/node_modules\/pkg\/index\.d\.ts/,
    );
    for (const rel of findPackagedRuntimeDeadFiles(runtimeRoot)) {
      fs.rmSync(path.join(runtimeRoot, rel));
    }
    assert.deepEqual(findPackagedRuntimeDeadFiles(runtimeRoot), []);
    assert.ok(fs.existsSync(path.join(pkgDir, 'SKILL.md')), 'run-time markdown survives the prune');
    assert.ok(fs.existsSync(playwrightBackend), 'Playwright production code under lib/mcp/test must not be pruned as tests');
    assert.doesNotThrow(() => verifyPackagedRuntimes(packagedContext));
  } finally {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      // Temp cleanup is best-effort, including on Windows CI.
    }
  }
});

test('packaged content resource gates fail closed on dot entries and dead files', () => {
  const {
    findDotEntries,
    verifyPackagedContentResources,
    PACKAGED_CONTENT_RESOURCES,
  } = require('../scripts/packagedRuntimes.cjs');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-packaged-content-'));

  try {
    assert.deepEqual(
      PACKAGED_CONTENT_RESOURCES.map((entry) => entry.extraResourceTo),
      ['SKILLs', 'METAAPPs'],
    );

    const context = {
      appOutDir: path.join(tmpRoot, 'win-out'),
      electronPlatformName: 'win32',
      packager: { appInfo: { productFilename: 'IDBots' } },
    };
    const resourcesDir = path.join(context.appOutDir, 'resources');

    assert.throws(
      () => verifyPackagedContentResources(context),
      /SKILLs\//,
      'missing content resource trees must fail closed',
    );

    const skillsRoot = path.join(resourcesDir, 'SKILLs');
    fs.mkdirSync(path.join(skillsRoot, 'web-search', 'node_modules', 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(skillsRoot, 'skills.config.json'), '{}');
    fs.mkdirSync(path.join(resourcesDir, 'METAAPPs', 'demo'), { recursive: true });
    fs.writeFileSync(path.join(resourcesDir, 'METAAPPs', 'demo', 'index.html'), '<html></html>');
    assert.doesNotThrow(() => verifyPackagedContentResources(context));

    fs.mkdirSync(path.join(skillsRoot, '.tmp_lucy_task29_whisper', 'nested'), { recursive: true });
    fs.writeFileSync(path.join(skillsRoot, '.tmp_lucy_task29_whisper', 'nested', 'chunk.wav'), 'x');
    fs.writeFileSync(path.join(resourcesDir, 'METAAPPs', '.DS_Store'), 'x');
    fs.mkdirSync(path.join(skillsRoot, 'web-search', 'node_modules', '.bin'), { recursive: true });
    fs.writeFileSync(path.join(skillsRoot, 'web-search', 'node_modules', '.bin', 'tsc'), 'x');
    assert.deepEqual(
      findDotEntries(skillsRoot),
      ['.tmp_lucy_task29_whisper', 'web-search/node_modules/.bin'],
      'dot-directories are recorded without descending into them',
    );
    assert.throws(
      () => verifyPackagedContentResources(context),
      /dot-entr[\s\S]*SKILLs\/\.tmp_lucy_task29_whisper/,
      'untracked scratch dirs must fail the pack',
    );

    fs.rmSync(path.join(skillsRoot, '.tmp_lucy_task29_whisper'), { recursive: true, force: true });
    fs.rmSync(path.join(resourcesDir, 'METAAPPs', '.DS_Store'));
    fs.rmSync(path.join(skillsRoot, 'web-search', 'node_modules', '.bin'), { recursive: true, force: true });
    assert.doesNotThrow(() => verifyPackagedContentResources(context));

    fs.writeFileSync(path.join(skillsRoot, 'web-search', 'node_modules', 'pkg', 'index.d.ts'), 'export {}');
    assert.throws(
      () => verifyPackagedContentResources(context),
      /nothing loads at run time[\s\S]*SKILLs\/web-search\/node_modules\/pkg\/index\.d\.ts/,
      'dead declarations under the web-search node_modules must fail the pack',
    );
    fs.rmSync(path.join(skillsRoot, 'web-search', 'node_modules', 'pkg', 'index.d.ts'));
    assert.doesNotThrow(() => verifyPackagedContentResources(context));
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('ffmpeg Windows download maps the extension-less release asset to the local .exe target', () => {
  const setupFfmpeg = require(path.join(process.cwd(), 'scripts', 'setup-ffmpeg.js'));
  assert.equal(setupFfmpeg.PLATFORM_ASSETS['win32-x64'], 'ffmpeg-win32-x64.exe');
  assert.equal(setupFfmpeg.REMOTE_ASSETS['win32-x64'], 'ffmpeg-win32-x64');
});
