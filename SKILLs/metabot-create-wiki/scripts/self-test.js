#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

const skillRoot = path.resolve(__dirname, '..');
const repoSkillsRoot = path.resolve(skillRoot, '..');
const repoRoot = path.resolve(repoSkillsRoot, '..');
const scaffoldScript = path.join(skillRoot, 'scripts', 'scaffold-wiki-skill.js');
const runtimeSource = path.join(repoSkillsRoot, 'metabot-llm-wiki');
const repoNodeModules = path.join(repoRoot, 'node_modules');

function runNode(scriptPath, payload, env = {}) {
  const mergedEnv = { ...process.env, ...env };
  if (!mergedEnv.NODE_PATH && fs.existsSync(repoNodeModules)) {
    mergedEnv.NODE_PATH = repoNodeModules;
  }
  const result = spawnSync(process.execPath, [scriptPath, '--payload', JSON.stringify(payload)], {
    encoding: 'utf8',
    env: mergedEnv,
    maxBuffer: 20 * 1024 * 1024,
  });
  const stdout = (result.stdout || '').trim();
  let json = null;
  try {
    json = JSON.parse(stdout || 'null');
  } catch {
    try {
      json = JSON.parse((stdout.split(/\r?\n/).filter(Boolean).pop()) || 'null');
    } catch {
      json = null;
    }
  }
  return {
    code: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    json,
  };
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'metabot-create-wiki-'));
  const skillsRoot = path.join(tempRoot, 'SKILLs');
  const rawSourceDir = path.join(tempRoot, 'source-raw');
  ensureDir(skillsRoot);
  ensureDir(rawSourceDir);

  fs.cpSync(runtimeSource, path.join(skillsRoot, 'metabot-llm-wiki'), {
    recursive: true,
    force: true,
    dereference: true,
  });

  fs.writeFileSync(
    path.join(rawSourceDir, 'metaid.md'),
    '# MetaID 简介\n\nMetaID 用于组织链上身份、内容和应用数据。\n',
    'utf8'
  );
  fs.writeFileSync(
    path.join(rawSourceDir, 'notes.txt'),
    '法律资料：合同违约后，应优先查看违约条款、损害赔偿与履行方式。\n',
    'utf8'
  );

  const missingSkillNameRes = runNode(
    scaffoldScript,
    {
      title: 'Broken Wiki',
      description: 'Should fail without a skill name.',
      rawSourceDir,
      targetRoot: skillsRoot,
    },
    { SKILLS_ROOT: skillsRoot }
  );
  assert.notEqual(missingSkillNameRes.code, 0);
  assert.match(missingSkillNameRes.stderr || missingSkillNameRes.stdout, /skillName/i);

  const missingRawSourceRes = runNode(
    scaffoldScript,
    {
      skillName: 'broken-wiki',
      title: 'Broken Wiki',
      description: 'Should fail without an existing raw directory.',
      rawSourceDir: path.join(tempRoot, 'missing-raw'),
      targetRoot: skillsRoot,
    },
    { SKILLS_ROOT: skillsRoot }
  );
  assert.notEqual(missingRawSourceRes.code, 0);
  assert.match(missingRawSourceRes.stderr || missingRawSourceRes.stdout, /rawSourceDir/i);

  const scaffoldRes = runNode(
    scaffoldScript,
    {
      skillName: 'metaid-wiki',
      title: 'MetaID Wiki',
      description: '面向 MetaID 资料的一对一本地 Wiki 技能。',
      rawSourceDir,
      targetRoot: skillsRoot,
      aliases: ['metaid', 'MetaID'],
      siteTitle: 'MetaID Wiki',
    },
    { SKILLS_ROOT: skillsRoot }
  );

  assert.equal(scaffoldRes.code, 0, scaffoldRes.stderr || scaffoldRes.stdout);
  assert.equal(scaffoldRes.json?.success, true);

  const generatedSkillDir = path.join(skillsRoot, 'metaid-wiki');
  assert.ok(fs.existsSync(path.join(generatedSkillDir, 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(generatedSkillDir, 'wiki.config.json')));
  assert.ok(fs.existsSync(path.join(generatedSkillDir, 'scripts', 'index.js')));
  assert.ok(fs.existsSync(path.join(generatedSkillDir, 'references', 'payload-schema-v1.json')));

  const generatedConfig = JSON.parse(fs.readFileSync(path.join(generatedSkillDir, 'wiki.config.json'), 'utf8'));
  assert.equal(generatedConfig.rawSourceDir, rawSourceDir);
  assert.ok(generatedConfig.workspaceRoot.includes('metaid-wiki'));

  const runtimeScript = path.join(generatedSkillDir, 'scripts', 'index.js');

  const initRes = runNode(runtimeScript, { action: 'init' }, { SKILLS_ROOT: skillsRoot });
  assert.equal(initRes.code, 0, initRes.stderr || initRes.stdout);
  assert.equal(initRes.json?.success, true);

  const absorbRes = runNode(runtimeScript, { action: 'absorb' }, { SKILLS_ROOT: skillsRoot });
  assert.equal(absorbRes.code, 0, absorbRes.stderr || absorbRes.stdout);
  assert.equal(absorbRes.json?.success, true);
  assert.equal(absorbRes.json?.action, 'absorb');
  assert.equal(absorbRes.json?.data?.ingest?.docsTotal, 2);

  const queryRes = runNode(
    runtimeScript,
    {
      action: 'query',
      payload: {
        question: 'MetaID 是做什么的？',
        minScore: 0.01,
      },
    },
    { SKILLS_ROOT: skillsRoot }
  );
  assert.equal(queryRes.code, 0, queryRes.stderr || queryRes.stdout);
  assert.equal(queryRes.json?.success, true);
  assert.equal(queryRes.json?.data?.insufficient, false);
  assert.ok((queryRes.json?.data?.citations || []).length > 0);

  fs.writeFileSync(
    path.join(rawSourceDir, 'metaid.md'),
    '# MetaID 简介\n\nMetaID 也用于管理用户身份、内容索引与本地应用资料。\n',
    'utf8'
  );

  const updateAbsorbRes = runNode(runtimeScript, { action: 'absorb' }, { SKILLS_ROOT: skillsRoot });
  assert.equal(updateAbsorbRes.code, 0, updateAbsorbRes.stderr || updateAbsorbRes.stdout);
  assert.equal(updateAbsorbRes.json?.success, true);

  const buildRes = runNode(runtimeScript, { action: 'wiki_build' }, { SKILLS_ROOT: skillsRoot });
  assert.equal(buildRes.code, 0, buildRes.stderr || buildRes.stdout);
  assert.equal(buildRes.json?.success, true);
  assert.ok(fs.existsSync(path.join(generatedConfig.workspaceRoot, 'wiki', 'site', 'index.html')));

  const seedOldZipUriRes = runNode(
    runtimeScript,
    {
      action: 'publish_zip',
      payload: {
        uploadZip: false,
        pinUri: 'metafile://old-upload',
      },
    },
    { SKILLS_ROOT: skillsRoot }
  );
  assert.equal(seedOldZipUriRes.code, 0, seedOldZipUriRes.stderr || seedOldZipUriRes.stdout);
  assert.equal(seedOldZipUriRes.json?.success, true);
  assert.equal(seedOldZipUriRes.json?.data?.zipUri, 'metafile://old-upload');

  const snapshotRes = runNode(
    runtimeScript,
    {
      action: 'publish_snapshot',
      payload: {
        uploadZip: false,
        snapshotOnChain: false,
      },
    },
    { SKILLS_ROOT: skillsRoot }
  );
  assert.equal(snapshotRes.code, 0, snapshotRes.stderr || snapshotRes.stdout);
  assert.equal(snapshotRes.json?.success, true);
  assert.equal(snapshotRes.json?.data?.publishMode?.zipUriSource, 'payload');
  assert.match(snapshotRes.json?.data?.snapshot?.zipUri || '', /^file:\/\//);
  assert.notEqual(snapshotRes.json?.data?.snapshot?.zipUri, 'metafile://old-upload');

  const publishRes = runNode(
    runtimeScript,
    {
      action: 'publish_all',
      payload: {
        uploadZip: false,
        snapshotOnChain: false,
      },
    },
    { SKILLS_ROOT: skillsRoot }
  );
  assert.equal(publishRes.code, 0, publishRes.stderr || publishRes.stdout);
  assert.equal(publishRes.json?.success, true);
  assert.equal(publishRes.json?.data?.steps?.publish_zip?.skipped, true);
  assert.match(publishRes.json?.data?.steps?.publish_snapshot?.snapshot?.zipUri || '', /^file:\/\//);
  assert.notEqual(publishRes.json?.data?.steps?.publish_snapshot?.snapshot?.zipUri, 'metafile://old-upload');

  process.stdout.write('metabot-create-wiki self-test passed\n');
}

main();
