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
  if (!Object.prototype.hasOwnProperty.call(env, 'NODE_PATH') && !mergedEnv.NODE_PATH && fs.existsSync(repoNodeModules)) {
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

function runNodePortable(scriptPath, payload, env = {}) {
  return runNode(scriptPath, payload, {
    ...env,
    NODE_PATH: '',
  });
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

function cleanupTempDir(dirPath) {
  if (dirPath && fs.existsSync(dirPath)) {
    fs.rmSync(dirPath, { recursive: true, force: true });
  }
}

function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'metabot-create-wiki-'));
  let portableRoot = '';
  const skillsRoot = path.join(tempRoot, 'SKILLs');
  const rawSourceDir = path.join(tempRoot, 'source-raw');
  try {
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

    portableRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'metabot-create-wiki-portable-'));
  const portableSkillsRoot = path.join(portableRoot, 'SKILLs');
  const portableRawSourceDir = path.join(portableRoot, 'source-raw');
  ensureDir(portableSkillsRoot);
  ensureDir(portableRawSourceDir);
  fs.cpSync(runtimeSource, path.join(portableSkillsRoot, 'metabot-llm-wiki'), {
    recursive: true,
    force: true,
    dereference: true,
  });
  fs.writeFileSync(
    path.join(portableRawSourceDir, 'alpha.md'),
    [
      '# Alpha Topic',
      'portablealphatoken7291 appears in this exact article and explains alpha behavior.',
      'Shared wiki words are present for background only.',
    ].join('\n'),
    'utf8'
  );
  fs.writeFileSync(
    path.join(portableRawSourceDir, 'beta.md'),
    [
      '# Beta Topic',
      'portable-beta-token appears in a different article and explains beta behavior.',
      'Shared wiki words are present for background only.',
    ].join('\n'),
    'utf8'
  );
  fs.writeFileSync(
    path.join(portableRawSourceDir, 'gamma.md'),
    [
      '# Gamma Topic',
      'portable-gamma-token appears in a separate article and explains gamma behavior.',
      'Shared wiki words are present for background only.',
    ].join('\n'),
    'utf8'
  );

  const portableScaffoldRes = runNodePortable(
    scaffoldScript,
    {
      skillName: 'portable-wiki',
      title: 'Portable Wiki',
      description: 'Portable backend verification wiki.',
      rawSourceDir: portableRawSourceDir,
      targetRoot: portableSkillsRoot,
      chunkSize: 240,
      chunkOverlap: 0,
    },
    { SKILLS_ROOT: portableSkillsRoot }
  );
  assert.equal(portableScaffoldRes.code, 0, portableScaffoldRes.stderr || portableScaffoldRes.stdout);
  assert.equal(portableScaffoldRes.json?.success, true);

  const portableSkillDir = path.join(portableSkillsRoot, 'portable-wiki');
  const portableConfig = JSON.parse(fs.readFileSync(path.join(portableSkillDir, 'wiki.config.json'), 'utf8'));
  assert.equal(portableConfig.searchBackend, 'portable');
  const portableRuntimeScript = path.join(portableSkillDir, 'scripts', 'index.js');

  const portableIngestRes = runNodePortable(
    portableRuntimeScript,
    { action: 'ingest' },
    { SKILLS_ROOT: portableSkillsRoot }
  );
  assert.equal(portableIngestRes.code, 0, portableIngestRes.stderr || portableIngestRes.stdout);
  assert.equal(portableIngestRes.json?.success, true);

  const portableIndexRes = runNodePortable(
    portableRuntimeScript,
    { action: 'index' },
    { SKILLS_ROOT: portableSkillsRoot }
  );
  assert.equal(portableIndexRes.code, 0, portableIndexRes.stderr || portableIndexRes.stdout);
  assert.equal(portableIndexRes.json?.success, true);

  const portableLexicalIndexFile = path.join(portableConfig.workspaceRoot, 'index', 'lexical-postings.json');
  const portableChunkStoreFile = path.join(portableConfig.workspaceRoot, 'index', 'chunk-store.json');
  assert.ok(fs.existsSync(portableLexicalIndexFile));
  assert.ok(fs.existsSync(portableChunkStoreFile));

  const portableQueryRes = runNodePortable(
    portableRuntimeScript,
    {
      action: 'query',
      payload: {
        question: 'portablealphatoken7291',
        searchBackend: 'portable',
        minScore: 0.01,
      },
    },
    { SKILLS_ROOT: portableSkillsRoot }
  );
  assert.equal(portableQueryRes.code, 0, portableQueryRes.stderr || portableQueryRes.stdout);
  assert.equal(portableQueryRes.json?.success, true);
  assert.equal(portableQueryRes.json?.data?.query?.searchBackend, 'portable-lexical');
  assert.ok((portableQueryRes.json?.data?.citations || []).length > 0);
  assert.ok(portableQueryRes.json?.metrics?.totalChunks >= 3);
  assert.ok(portableQueryRes.json?.metrics?.candidateChunks < portableQueryRes.json?.metrics?.totalChunks);

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

  const staleZipPath = path.join(generatedConfig.workspaceRoot, 'manifests', 'stale-test-wiki.zip');
  fs.mkdirSync(path.dirname(staleZipPath), { recursive: true });
  fs.writeFileSync(staleZipPath, 'stale zip placeholder\n', 'utf8');

  const seedOldZipUriRes = runNode(
    runtimeScript,
    {
      action: 'publish_zip',
      payload: {
        zipPath: staleZipPath,
        uploadZip: false,
        pinUri: 'metafile://old-upload',
      },
    },
    { SKILLS_ROOT: skillsRoot }
  );
  assert.equal(seedOldZipUriRes.code, 0, seedOldZipUriRes.stderr || seedOldZipUriRes.stdout);
  assert.equal(seedOldZipUriRes.json?.success, true);
  assert.equal(seedOldZipUriRes.json?.data?.zipUri, 'metafile://old-upload');
  assert.ok(seedOldZipUriRes.json?.data?.zipSha256);

  const localZipPath = path.join(generatedConfig.workspaceRoot, 'manifests', 'local-test-wiki.zip');
  fs.mkdirSync(path.dirname(localZipPath), { recursive: true });
  fs.writeFileSync(localZipPath, 'local zip placeholder for snapshot tests\n', 'utf8');

  const snapshotRes = runNode(
    runtimeScript,
    {
      action: 'publish_snapshot',
      payload: {
        zipPath: localZipPath,
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
  assert.equal(snapshotRes.json?.data?.snapshot?.zipUri, `file://${localZipPath.replace(/\\/g, '/')}`);
  assert.notEqual(snapshotRes.json?.data?.snapshot?.zipUri, 'metafile://old-upload');

  const publishRes = runNode(
    runtimeScript,
    {
      action: 'publish_all',
      payload: {
        zipPath: localZipPath,
        uploadZip: false,
        snapshotOnChain: false,
      },
    },
    { SKILLS_ROOT: skillsRoot }
  );
  assert.equal(publishRes.code, 0, publishRes.stderr || publishRes.stdout);
  assert.equal(publishRes.json?.success, true);
  assert.equal(publishRes.json?.data?.steps?.publish_zip?.skipped, true);
  assert.equal(publishRes.json?.data?.steps?.bundle_zip, undefined);
  assert.match(publishRes.json?.data?.steps?.publish_snapshot?.snapshot?.zipUri || '', /^file:\/\//);
  assert.equal(
    publishRes.json?.data?.steps?.publish_snapshot?.snapshot?.zipUri,
    `file://${localZipPath.replace(/\\/g, '/')}`
  );
  assert.notEqual(publishRes.json?.data?.steps?.publish_snapshot?.snapshot?.zipUri, 'metafile://old-upload');

  const directExternalSnapshotRes = runNode(
    runtimeScript,
    {
      action: 'publish_snapshot',
      payload: {
        pinUri: 'metafile://direct-new-upload',
        snapshotOnChain: false,
      },
    },
    { SKILLS_ROOT: skillsRoot }
  );
  assert.equal(directExternalSnapshotRes.code, 0, directExternalSnapshotRes.stderr || directExternalSnapshotRes.stdout);
  assert.equal(directExternalSnapshotRes.json?.success, true);
  assert.equal(directExternalSnapshotRes.json?.data?.snapshot?.zipUri, 'metafile://direct-new-upload');
  assert.equal(directExternalSnapshotRes.json?.data?.snapshot?.zipSha256, '');

  const missingZipSnapshotRes = runNode(
    runtimeScript,
    {
      action: 'publish_snapshot',
      payload: {
        zipPath: path.join(generatedConfig.workspaceRoot, 'manifests', 'missing-local.zip'),
        snapshotOnChain: false,
      },
    },
    { SKILLS_ROOT: skillsRoot }
  );
  assert.notEqual(missingZipSnapshotRes.code, 0);
  assert.match(missingZipSnapshotRes.stderr || missingZipSnapshotRes.stdout, /zipPath does not exist/i);

  const externalPublishRes = runNode(
    runtimeScript,
    {
      action: 'publish_all',
      payload: {
        uploadZip: false,
        pinUri: 'metafile://new-upload',
        snapshotOnChain: false,
      },
    },
    { SKILLS_ROOT: skillsRoot }
  );
  assert.equal(externalPublishRes.code, 0, externalPublishRes.stderr || externalPublishRes.stdout);
  assert.equal(externalPublishRes.json?.success, true);
  assert.equal(externalPublishRes.json?.data?.steps?.bundle_zip, undefined);
  assert.equal(externalPublishRes.json?.data?.steps?.publish_zip?.zipUri, 'metafile://new-upload');
  assert.equal(externalPublishRes.json?.data?.steps?.publish_zip?.zipSha256, '');
  assert.equal(externalPublishRes.json?.data?.steps?.publish_snapshot?.snapshot?.zipUri, 'metafile://new-upload');
  assert.equal(externalPublishRes.json?.data?.steps?.publish_snapshot?.snapshot?.zipSha256, '');

  process.stdout.write('metabot-create-wiki self-test passed\n');
  } finally {
    cleanupTempDir(portableRoot);
    cleanupTempDir(tempRoot);
  }
}

main();
