#!/usr/bin/env node
/**
 * MetaApp Checklist Validator (Node.js)
 *
 * Hard-gate validator for metabot-create-metaapp workflow.
 *
 * Phases:
 *   - pregen:     validate scaffold/baseline readiness and target project path policy
 *   - predeliver: validate generated project against SKILL.md hard constraints
 *
 * Usage:
 *   node scripts/validate_metaapp_checklist.js --phase pregen --project ~/idbots/project/MyMetaApp
 *   node scripts/validate_metaapp_checklist.js --phase predeliver --project ~/idbots/project/MyMetaApp
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MIN_REQUIRED_FILES = [
  'index.html',
  'app.css',
  'app.js',
  'idframework.js',
  'idconfig.js',
  'idutils.js',
  'bootstrap-stores.js',
  'app-env-compat.js',
  'idcomponents/id-connect-button.js',
  'commands/FetchUserCommand.js',
  'commands/CheckWebViewBridgeCommand.js',
  'commands/CheckBtcAddressSameAsMvcCommand.js',
];

const MIN_REQUIRED_DIRS = [
  'commands',
  'idcomponents',
];

const INDEX_REQUIRED_SNIPPETS = [
  './bootstrap-stores.js',
  './idconfig.js',
  './idutils.js',
  './idframework.js',
  './idcomponents/id-connect-button.js',
  './app.js',
  './app-env-compat.js',
  '<id-connect-button',
];

const APP_JS_REQUIRED_PATTERNS = [
  /register\(\s*['"]fetchUser['"]\s*,\s*['"]\.\/commands\/FetchUserCommand\.js['"]\s*\)/,
  /register\(\s*['"]checkWebViewBridge['"]\s*,\s*['"]\.\/commands\/CheckWebViewBridgeCommand\.js['"]\s*\)/,
  /register\(\s*['"]checkBtcAddressSameAsMvc['"]\s*,\s*['"]\.\/commands\/CheckBtcAddressSameAsMvcCommand\.js['"]\s*\)/,
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readText(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function checkItem(results, name, ok, detail = '') {
  results.push({ name, ok, detail });
}

function printResults(results, phase) {
  console.log(`\n=== MetaApp Checklist (${phase}) ===`);
  let allOk = true;
  for (const { name, ok, detail } of results) {
    const icon = ok ? '✅' : '❌';
    console.log(`${icon} ${name}${detail ? ' - ' + detail : ''}`);
    if (!ok) allOk = false;
  }
  console.log('=== End Checklist ===\n');
  return allOk;
}

/**
 * Returns the metabot-create-metaapp directory (skill root).
 * Script lives at: <skill_root>/scripts/validate_metaapp_checklist.js
 */
function getSkillRoot() {
  return path.resolve(path.dirname(__filename), '..');
}

/**
 * Returns the mandatory target root for all generated MetaApp projects.
 * Always: <OS home>/idbots/project
 */
function getTargetRoot() {
  return path.join(os.homedir(), 'idbots', 'project');
}

function fileEquals(a, b) {
  if (!fs.existsSync(a) || !fs.existsSync(b)) return false;
  return fs.readFileSync(a, 'utf8') === fs.readFileSync(b, 'utf8');
}

// ---------------------------------------------------------------------------
// Phase: pregen
// ---------------------------------------------------------------------------

function validatePregen(projectDir, skillRoot) {
  const results = [];
  const targetRoot = path.resolve(getTargetRoot());
  const parentDir = path.resolve(path.dirname(projectDir));

  // 1) Target project must be inside ~/idbots/project/
  checkItem(
    results,
    '目标目录在 ~/idbots/project/ 下',
    parentDir === targetRoot,
    `expected parent=${targetRoot}, got=${parentDir}`,
  );

  // 2) Target project must NOT be inside the skill (metabot-create-metaapp) directory
  const resolvedProject = path.resolve(projectDir);
  const resolvedSkill = path.resolve(skillRoot);
  const notInSkill =
    !resolvedProject.startsWith(resolvedSkill + path.sep) &&
    resolvedProject !== resolvedSkill;
  checkItem(
    results,
    '目标目录不在 metabot-create-metaapp 内',
    notInSkill,
    `project=${resolvedProject}`,
  );

  // 3) Baseline files must exist
  const baselineFiles = [
    'templates/index.html',
    'templates/app.js',
    'templates/app.css',
    'templates/idframework.js',
    'templates/bootstrap-stores.js',
    'templates/app-env-compat.js',
    'idframework/idframework.js',
    'idframework/commands/FetchUserCommand.js',
    'idframework/idcomponents/id-connect-button.js',
    'references/MetaApp-Development-Guide.md',
  ];

  for (const rel of baselineFiles) {
    const p = path.join(skillRoot, rel);
    checkItem(results, `基线文件存在: ${rel}`, fs.existsSync(p), p);
  }

  return results;
}

// ---------------------------------------------------------------------------
// Phase: predeliver
// ---------------------------------------------------------------------------

function validatePredeliver(projectDir, skillRoot) {
  const results = [];

  // 1) Minimum file set
  for (const rel of MIN_REQUIRED_FILES) {
    const p = path.join(projectDir, rel);
    checkItem(results, `存在必需文件: ${rel}`, fs.existsSync(p) && fs.statSync(p).isFile(), p);
  }

  for (const rel of MIN_REQUIRED_DIRS) {
    const p = path.join(projectDir, rel);
    checkItem(results, `存在必需目录: ${rel}`, fs.existsSync(p) && fs.statSync(p).isDirectory(), p);
  }

  // 2) index.html references and render
  const indexPath = path.join(projectDir, 'index.html');
  if (fs.existsSync(indexPath)) {
    const indexText = readText(indexPath);
    for (const snippet of INDEX_REQUIRED_SNIPPETS) {
      checkItem(results, `index.html 包含: ${snippet}`, indexText.includes(snippet));
    }
  } else {
    for (const snippet of INDEX_REQUIRED_SNIPPETS) {
      checkItem(results, `index.html 包含: ${snippet}`, false, 'index.html missing');
    }
  }

  // 3) app.js command registrations
  const appJsPath = path.join(projectDir, 'app.js');
  if (fs.existsSync(appJsPath)) {
    const appText = readText(appJsPath);
    for (const pat of APP_JS_REQUIRED_PATTERNS) {
      checkItem(results, `app.js 注册命令: ${pat}`, pat.test(appText));
    }
  } else {
    for (const pat of APP_JS_REQUIRED_PATTERNS) {
      checkItem(results, `app.js 注册命令: ${pat}`, false, 'app.js missing');
    }
  }

  // 4) Login core files must align with idframework baseline
  const comparePairs = [
    ['idframework.js', 'idframework/idframework.js'],
    ['commands/FetchUserCommand.js', 'idframework/commands/FetchUserCommand.js'],
    ['idcomponents/id-connect-button.js', 'idframework/idcomponents/id-connect-button.js'],
  ];
  for (const [projectRel, baselineRel] of comparePairs) {
    const p = path.join(projectDir, projectRel);
    const b = path.join(skillRoot, baselineRel);
    const same = fileEquals(p, b);
    checkItem(results, `核心文件对齐: ${projectRel}`, same, `baseline=${baselineRel}`);
  }

  // 5) Prohibit runtime dependency by parent traversal
  const disallowRefs = [
    '../metabot-create-metaapp/',
    '..\\metabot-create-metaapp\\',
    '/metabot-create-metaapp/',
  ];

  const scannedFiles = ['index.html', 'app.js', 'idframework.js'];
  const commandsDir = path.join(projectDir, 'commands');
  if (fs.existsSync(commandsDir)) {
    for (const f of fs.readdirSync(commandsDir)) {
      if (f.endsWith('.js')) scannedFiles.push(`commands/${f}`);
    }
  }
  const idcompsDir = path.join(projectDir, 'idcomponents');
  if (fs.existsSync(idcompsDir)) {
    for (const f of fs.readdirSync(idcompsDir)) {
      if (f.endsWith('.js')) scannedFiles.push(`idcomponents/${f}`);
    }
  }

  let foundBadRef = false;
  for (const rel of scannedFiles) {
    const p = path.join(projectDir, rel);
    if (!fs.existsSync(p)) continue;
    const text = readText(p);
    if (disallowRefs.some((ref) => text.includes(ref))) {
      foundBadRef = true;
      checkItem(results, `禁止上级运行依赖引用: ${rel}`, false, 'found ../metabot-create-metaapp ref');
    }
  }
  if (!foundBadRef) {
    checkItem(results, '禁止上级运行依赖引用', true);
  }

  return results;
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);

  // Simple arg parser
  const getArg = (flag) => {
    const idx = args.indexOf(flag);
    return idx !== -1 ? args[idx + 1] : null;
  };

  const phase = getArg('--phase');
  const projectArg = getArg('--project');

  if (!phase || !['pregen', 'predeliver'].includes(phase)) {
    console.error('Usage: node validate_metaapp_checklist.js --phase <pregen|predeliver> --project <path>');
    process.exit(1);
  }
  if (!projectArg) {
    console.error('Error: --project is required');
    process.exit(1);
  }

  const skillRoot = getSkillRoot();
  // Expand leading ~ to home directory
  const expandedProject = projectArg.startsWith('~')
    ? path.join(os.homedir(), projectArg.slice(1))
    : projectArg;
  const projectDir = path.resolve(expandedProject);

  if (phase === 'pregen') {
    const results = validatePregen(projectDir, skillRoot);
    const ok = printResults(results, 'pregen');
    if (!ok) {
      process.stderr.write('❌ pregen checklist failed. Do NOT generate project until all checks pass.\n');
      process.exit(1);
    }
    console.log('✅ pregen checklist passed.');
    return;
  }

  // predeliver
  const results = validatePredeliver(projectDir, skillRoot);
  const ok = printResults(results, 'predeliver');
  if (!ok) {
    process.stderr.write('❌ predeliver checklist failed. Project is NOT eligible for delivery.\n');
    process.exit(1);
  }
  console.log('✅ predeliver checklist passed.');
}

main();
