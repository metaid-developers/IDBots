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

function readJsonl(filePath) {
  return fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
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
  assert.equal(generatedConfig.queryAutoAbsorb, false);

  const runtimeScript = path.join(generatedSkillDir, 'scripts', 'index.js');

  const initRes = runNode(runtimeScript, { action: 'init' }, { SKILLS_ROOT: skillsRoot });
  assert.equal(initRes.code, 0, initRes.stderr || initRes.stdout);
  assert.equal(initRes.json?.success, true);

  const absorbRes = runNode(runtimeScript, { action: 'absorb' }, { SKILLS_ROOT: skillsRoot });
  assert.equal(absorbRes.code, 0, absorbRes.stderr || absorbRes.stdout);
  assert.equal(absorbRes.json?.success, true);
  assert.equal(absorbRes.json?.action, 'absorb');
  assert.equal(absorbRes.json?.data?.ingest?.docsTotal, 2);

  const secondAbsorbRes = runNode(runtimeScript, { action: 'absorb' }, { SKILLS_ROOT: skillsRoot });
  assert.equal(secondAbsorbRes.code, 0, secondAbsorbRes.stderr || secondAbsorbRes.stdout);
  assert.equal(secondAbsorbRes.json?.success, true);
  assert.equal(secondAbsorbRes.json?.data?.index?.skipped, true);

  const forceIndexRes = runNode(
    runtimeScript,
    { action: 'absorb', payload: { forceIndex: true } },
    { SKILLS_ROOT: skillsRoot }
  );
  assert.equal(forceIndexRes.code, 0, forceIndexRes.stderr || forceIndexRes.stdout);
  assert.equal(forceIndexRes.json?.success, true);
  assert.notEqual(forceIndexRes.json?.data?.index?.skipped, true);
  assert.ok(forceIndexRes.json?.data?.index?.chunkCount > 0);

  const generatedConfigPath = path.join(generatedSkillDir, 'wiki.config.json');
  const generatedConfigAfterInit = JSON.parse(fs.readFileSync(generatedConfigPath, 'utf8'));
  fs.writeFileSync(
    generatedConfigPath,
    `${JSON.stringify({ ...generatedConfigAfterInit, chunkSize: 240, chunkOverlap: 0 }, null, 2)}\n`,
    'utf8'
  );

  const configChangeAbsorbRes = runNode(runtimeScript, { action: 'absorb' }, { SKILLS_ROOT: skillsRoot });
  assert.equal(configChangeAbsorbRes.code, 0, configChangeAbsorbRes.stderr || configChangeAbsorbRes.stdout);
  assert.equal(configChangeAbsorbRes.json?.success, true);
  assert.notEqual(configChangeAbsorbRes.json?.data?.index?.skipped, true);
  assert.ok(configChangeAbsorbRes.json?.data?.index?.chunkCount > 0);

  const fastQueryRes = runNode(
    runtimeScript,
    {
      action: 'query',
      payload: {
        question: 'MetaID 是做什么的？',
        autoAbsorb: false,
        minScore: 0.01,
      },
    },
    { SKILLS_ROOT: skillsRoot }
  );
  assert.equal(fastQueryRes.code, 0, fastQueryRes.stderr || fastQueryRes.stdout);
  assert.equal(fastQueryRes.json?.success, true);
  assert.equal(fastQueryRes.json?.data?.insufficient, false);

  fs.writeFileSync(
    path.join(rawSourceDir, 'fresh.md'),
    '新的资料内容：快速查询不应自动吸收。fresh-only-token-7291\n',
    'utf8'
  );
  const noRefreshQueryRes = runNode(
    runtimeScript,
    {
      action: 'query',
      payload: {
        question: 'fresh-only-token-7291',
        autoAbsorb: false,
        minScore: 0.01,
      },
    },
    { SKILLS_ROOT: skillsRoot }
  );
  assert.equal(noRefreshQueryRes.code, 0, noRefreshQueryRes.stderr || noRefreshQueryRes.stdout);
  assert.equal(noRefreshQueryRes.json?.success, true);
  const noRefreshDocs = readJsonl(path.join(generatedConfig.workspaceRoot, 'work', 'docs.jsonl'));
  assert.equal(noRefreshDocs.length, 2);
  assert.equal(noRefreshQueryRes.json?.data?.insufficient, true);

  const refreshQueryRes = runNode(
    runtimeScript,
    {
      action: 'query',
      payload: {
        question: 'fresh-only-token-7291',
        autoAbsorb: true,
        minScore: 0.01,
      },
    },
    { SKILLS_ROOT: skillsRoot }
  );
  assert.equal(refreshQueryRes.code, 0, refreshQueryRes.stderr || refreshQueryRes.stdout);
  assert.equal(refreshQueryRes.json?.success, true);
  assert.equal(refreshQueryRes.json?.data?.insufficient, false);
  const refreshDocs = readJsonl(path.join(generatedConfig.workspaceRoot, 'work', 'docs.jsonl'));
  assert.equal(refreshDocs.length, 3);

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
