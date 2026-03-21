#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const projectRoot = path.resolve(__dirname, '..');

const args = new Set(process.argv.slice(2));
const shouldRunLint = !args.has('--skip-lint');
const shouldRunCompile = !args.has('--skip-compile');
const shouldRunBuild = args.has('--with-build');

const checks = [];

function addCheck(name, ok, detail) {
  checks.push({ name, ok, detail });
  const icon = ok ? 'PASS' : 'FAIL';
  console.log(`[${icon}] ${name}${detail ? ` - ${detail}` : ''}`);
}

function resolveInProject(relPath) {
  return path.resolve(projectRoot, relPath);
}

function readFileSafe(relPath) {
  const filePath = resolveInProject(relPath);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return fs.readFileSync(filePath, 'utf8');
}

function checkFileContains(relPath, snippets, checkName) {
  const content = readFileSafe(relPath);
  if (content == null) {
    addCheck(checkName, false, `missing file: ${relPath}`);
    return;
  }
  const missing = snippets.filter((snippet) => !content.includes(snippet));
  addCheck(
    checkName,
    missing.length === 0,
    missing.length === 0 ? relPath : `missing snippets in ${relPath}: ${missing.join(', ')}`
  );
}

function checkFileNotContains(relPath, snippets, checkName) {
  const content = readFileSafe(relPath);
  if (content == null) {
    addCheck(checkName, false, `missing file: ${relPath}`);
    return;
  }
  const hit = snippets.filter((snippet) => content.includes(snippet));
  addCheck(
    checkName,
    hit.length === 0,
    hit.length === 0 ? relPath : `forbidden snippets in ${relPath}: ${hit.join(', ')}`
  );
}

function runNpmScript(scriptName) {
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(npmCmd, ['run', scriptName], {
    cwd: projectRoot,
    encoding: 'utf8',
    stdio: 'pipe',
  });

  const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
  const ok = result.status === 0;
  addCheck(`npm run ${scriptName}`, ok, ok ? 'ok' : `exit=${result.status}`);

  if (!ok && output) {
    const clipped = output.length > 4000 ? `${output.slice(0, 4000)}\n...[truncated]` : output;
    console.log('----- command output begin -----');
    console.log(clipped);
    console.log('----- command output end -----');
  }
}

function runStaticChecks() {
  checkFileContains(
    'src/main/libs/runtimePaths.ts',
    ['export function isPathWithin', 'export function resolveElectronExecutablePath'],
    'runtime path helper exists'
  );

  checkFileContains(
    'src/main/libs/coworkRunner.ts',
    ['resolveElectronExecutablePath(', 'isStaleConversationSessionError(', 'staleResumeDetected'],
    'cowork runner uses resilient executable/session handling'
  );

  checkFileNotContains(
    'src/main/libs/coworkRunner.ts',
    ['function isPathWithin('],
    'cowork runner avoids local duplicated path checker'
  );

  checkFileContains(
    'src/main/libs/coworkUtil.ts',
    ['MSYS_NO_PATHCONV', 'MSYS2_ARG_CONV_EXCL', 'cygpath', 'IDBOTS_SKILLS_ROOT', 'resolveElectronExecutablePath('],
    'cowork util has windows shell + skills root hardening'
  );

  checkFileContains(
    'src/main/skillServices.ts',
    ['getEnhancedEnv(', 'resolveElectronExecutablePath(', 'IDBOTS_ELECTRON_PATH'],
    'skill services share cowork env hardening'
  );

  checkFileNotContains(
    'src/main/skillServices.ts',
    ['process.execPath'],
    'skill services avoid direct process.execPath usage'
  );

  checkFileContains(
    'src/main/skillManager.ts',
    ['getEnhancedEnv(', 'resolveElectronExecutablePath(', 'IDBOTS_SKILLS_ROOT'],
    'skill manager aligns env and skills root resolution'
  );

  checkFileNotContains(
    'src/main/skillManager.ts',
    ['resolvedTarget.startsWith(resolvedRoot + path.sep)'],
    'skill manager avoids string-prefix path boundary checks'
  );

  checkFileContains(
    'src/main/services/skillSyncService.ts',
    ['IDBOTS_SKILLS_ROOT', 'SKILLS_ROOT'],
    'skill sync honors skills root env overrides'
  );

  checkFileContains(
    'src/main/services/cognitiveOrchestrator.ts',
    ['isPathWithin('],
    'orchestrator read tool uses robust path boundary checks'
  );

  checkFileContains(
    'src/main/libs/coworkVmRunner.ts',
    ['isPathWithin('],
    'sandbox bridge file sync uses robust path boundary checks'
  );

  const builderRaw = readFileSafe('electron-builder.json');
  if (!builderRaw) {
    addCheck('electron-builder resource checks', false, 'missing electron-builder.json');
  } else {
    try {
      const builder = JSON.parse(builderRaw);
      const resources = Array.isArray(builder.extraResources) ? builder.extraResources : [];
      const hasSkills = resources.some((r) => r && r.from === 'SKILLs');
      const winResources = Array.isArray(builder.win?.extraResources) ? builder.win.extraResources : [];
      const hasMinGit = winResources.some((r) => r && r.from === 'resources/mingit');
      const platformHasP2PConfig = (section) => {
        const extraResources = Array.isArray(section?.extraResources) ? section.extraResources : [];
        return extraResources.some((r) => r && r.from === 'resources/man-p2p/config.toml');
      };
      addCheck('electron-builder bundles SKILLs', hasSkills, hasSkills ? 'ok' : 'missing extraResources.from=SKILLs');
      addCheck('electron-builder bundles mingit for win', hasMinGit, hasMinGit ? 'ok' : 'missing win.extraResources.from=resources/mingit');
      addCheck(
        'electron-builder bundles man-p2p config on mac',
        platformHasP2PConfig(builder.mac),
        platformHasP2PConfig(builder.mac) ? 'ok' : 'missing mac.extraResources.from=resources/man-p2p/config.toml'
      );
      addCheck(
        'electron-builder bundles man-p2p config on win',
        platformHasP2PConfig(builder.win),
        platformHasP2PConfig(builder.win) ? 'ok' : 'missing win.extraResources.from=resources/man-p2p/config.toml'
      );
      addCheck(
        'electron-builder bundles man-p2p config on linux',
        platformHasP2PConfig(builder.linux),
        platformHasP2PConfig(builder.linux) ? 'ok' : 'missing linux.extraResources.from=resources/man-p2p/config.toml'
      );
    } catch (error) {
      addCheck('electron-builder resource checks', false, `invalid JSON: ${error.message}`);
    }
  }
}

function summarizeAndExit() {
  const passed = checks.filter((check) => check.ok).length;
  const failed = checks.length - passed;
  console.log('\n=== Cross-Platform Path Check Summary ===');
  console.log(`Total: ${checks.length}, Passed: ${passed}, Failed: ${failed}`);
  if (failed > 0) {
    process.exitCode = 1;
  }
}

function main() {
  console.log('Running cross-platform path/env checks...\n');
  runStaticChecks();

  if (shouldRunLint) {
    runNpmScript('lint');
  } else {
    addCheck('npm run lint', true, 'skipped via --skip-lint');
  }

  if (shouldRunCompile) {
    runNpmScript('compile:electron');
  } else {
    addCheck('npm run compile:electron', true, 'skipped via --skip-compile');
  }

  if (shouldRunBuild) {
    runNpmScript('build');
  }

  summarizeAndExit();
}

main();
