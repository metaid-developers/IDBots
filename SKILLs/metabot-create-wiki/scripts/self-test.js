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
  const runtimeTestUtils = require(path.join(runtimeSource, 'scripts', 'index.js')).__llmWikiTestUtils;
  assert.deepEqual(
    runtimeTestUtils.parseCommandLine(String.raw`"C:\Program Files\nodejs\node.exe" "C:\tmp\embedder.js"`),
    [
      String.raw`C:\Program Files\nodejs\node.exe`,
      String.raw`C:\tmp\embedder.js`,
    ]
  );
  assert.deepEqual(
    runtimeTestUtils.parseCommandLine(String.raw`"\\server\share\embed.exe" --mode vector`),
    [
      String.raw`\\server\share\embed.exe`,
      '--mode',
      'vector',
    ]
  );

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
  assert.equal(generatedConfig.embeddingEnabled, true);
  assert.equal(generatedConfig.embeddingProvider, 'local-hashing-v1');
  assert.equal(generatedConfig.embeddingModel, 'local-hashing-v1');
  assert.equal(generatedConfig.embeddingCommand, '');
  assert.equal(generatedConfig.searchBackend, 'hybrid');
  assert.equal(generatedConfig.lexicalWeight, 0.55);
  assert.equal(generatedConfig.vectorWeight, 0.35);
  assert.equal(generatedConfig.phraseWeight, 0.10);

  const generatedSkillMd = fs.readFileSync(path.join(generatedSkillDir, 'SKILL.md'), 'utf8');
  assert.match(generatedSkillMd, /autoAbsorb/);
  assert.match(generatedSkillMd, /absorb/);

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

  const vectorsFile = path.join(generatedConfig.workspaceRoot, 'index', 'vectors.json');
  assert.ok(fs.existsSync(vectorsFile));
  const vectorIndex = JSON.parse(fs.readFileSync(vectorsFile, 'utf8'));
  assert.equal(vectorIndex.provider, 'local-hashing-v1');
  assert.equal(vectorIndex.model, 'local-hashing-v1');
  assert.ok(vectorIndex.dimension >= 128);
  assert.ok((vectorIndex.vectors || []).length > 0);

  const vectorQueryRes = runNode(
    runtimeScript,
    {
      action: 'query',
      payload: {
        question: 'MetaID 用于组织链上身份、内容和应用数据',
        searchBackend: 'vector',
        minScore: 0.01,
      },
    },
    { SKILLS_ROOT: skillsRoot }
  );
  assert.equal(vectorQueryRes.code, 0, vectorQueryRes.stderr || vectorQueryRes.stdout);
  assert.equal(vectorQueryRes.json?.success, true);
  assert.equal(vectorQueryRes.json?.data?.query?.searchBackend, 'vector');
  assert.equal(vectorQueryRes.json?.data?.query?.vectorProvider, 'local-hashing-v1');
  assert.ok(vectorQueryRes.json?.metrics?.vectorCandidates > 0);
  assert.ok((vectorQueryRes.json?.data?.citations || []).length > 0);

  const sqliteIndexFile = path.join(generatedConfig.workspaceRoot, 'index', 'search.sqlite');
  assert.ok(fs.existsSync(sqliteIndexFile));
  const sqliteQueryRes = runNode(
    runtimeScript,
    {
      action: 'query',
      payload: {
        question: '合同违约',
        searchBackend: 'sqlite-fts',
        minScore: 0.01,
      },
    },
    { SKILLS_ROOT: skillsRoot }
  );
  assert.equal(sqliteQueryRes.code, 0, sqliteQueryRes.stderr || sqliteQueryRes.stdout);
  assert.equal(sqliteQueryRes.json?.success, true);
  assert.equal(sqliteQueryRes.json?.data?.query?.searchBackend, 'sqlite-fts');
  assert.ok((sqliteQueryRes.json?.data?.citations || []).length > 0);

  fs.rmSync(vectorsFile, { force: true });
  const missingVectorQueryRes = runNode(
    runtimeScript,
    {
      action: 'query',
      payload: {
        question: 'MetaID 用于组织链上身份、内容和应用数据',
        searchBackend: 'vector',
        minScore: 0.01,
      },
    },
    { SKILLS_ROOT: skillsRoot }
  );
  assert.notEqual(missingVectorQueryRes.code, 0);
  assert.match(missingVectorQueryRes.stderr || missingVectorQueryRes.stdout, /No vector index found|Run ingest \+ index/i);

  const commandEmbedderA = path.join(tempRoot, 'command-embedder-a.js');
  const commandEmbedderB = path.join(tempRoot, 'command-embedder-b.js');
  const invalidCommandEmbedder = path.join(tempRoot, 'command-embedder-invalid.js');
  const commandEmbedderScript = [
    "const fs = require('node:fs');",
    "const input = JSON.parse(fs.readFileSync(0, 'utf8'));",
    'const vectors = input.texts.map((text) => {',
    '  const value = String(text || "").includes("MetaID") ? 1 : 0.25;',
    '  return [value, 1, String(text || "").length % 11 + 1];',
    '});',
    'process.stdout.write(JSON.stringify({ vectors }));',
    '',
  ].join('\n');
  fs.writeFileSync(commandEmbedderA, commandEmbedderScript, 'utf8');
  fs.writeFileSync(commandEmbedderB, commandEmbedderScript, 'utf8');
  fs.writeFileSync(
    invalidCommandEmbedder,
    [
      "const fs = require('node:fs');",
      "const input = JSON.parse(fs.readFileSync(0, 'utf8'));",
      'process.stdout.write(JSON.stringify({ vectors: input.texts.map(() => ["1", null, true]) }));',
      '',
    ].join('\n'),
    'utf8'
  );

  const commandScaffoldRes = runNode(
    scaffoldScript,
    {
      skillName: 'command-vector-wiki',
      title: 'Command Vector Wiki',
      description: 'Command embedding signature regression wiki.',
      rawSourceDir,
      targetRoot: skillsRoot,
      embeddingProvider: 'command-json-v1',
      embeddingModel: 'command-test-model',
      embeddingCommand: `"${process.execPath}" "${commandEmbedderA}"`,
    },
    { SKILLS_ROOT: skillsRoot }
  );
  assert.equal(commandScaffoldRes.code, 0, commandScaffoldRes.stderr || commandScaffoldRes.stdout);
  assert.equal(commandScaffoldRes.json?.success, true);
  const commandSkillDir = path.join(skillsRoot, 'command-vector-wiki');
  const commandRuntimeScript = path.join(commandSkillDir, 'scripts', 'index.js');
  const commandAbsorbRes = runNode(
    commandRuntimeScript,
    { action: 'absorb', payload: { forceIndex: true } },
    { SKILLS_ROOT: skillsRoot }
  );
  assert.equal(commandAbsorbRes.code, 0, commandAbsorbRes.stderr || commandAbsorbRes.stdout);
  assert.equal(commandAbsorbRes.json?.success, true);

  const commandConfigPath = path.join(commandSkillDir, 'wiki.config.json');
  const commandConfig = JSON.parse(fs.readFileSync(commandConfigPath, 'utf8'));
  fs.writeFileSync(
    commandConfigPath,
    `${JSON.stringify({ ...commandConfig, embeddingCommand: `"${process.execPath}" "${commandEmbedderB}"` }, null, 2)}\n`,
    'utf8'
  );
  const staleCommandVectorRes = runNode(
    commandRuntimeScript,
    {
      action: 'query',
      payload: {
        question: 'MetaID',
        searchBackend: 'vector',
        minScore: 0.01,
      },
    },
    { SKILLS_ROOT: skillsRoot }
  );
  assert.notEqual(staleCommandVectorRes.code, 0);
  assert.match(staleCommandVectorRes.stderr || staleCommandVectorRes.stdout, /embedding configuration is stale|Re-run index/i);

  const invalidCommandScaffoldRes = runNode(
    scaffoldScript,
    {
      skillName: 'invalid-command-vector-wiki',
      title: 'Invalid Command Vector Wiki',
      description: 'Invalid command embedding regression wiki.',
      rawSourceDir,
      targetRoot: skillsRoot,
      embeddingProvider: 'command-json-v1',
      embeddingModel: 'invalid-command-test-model',
      embeddingCommand: `"${process.execPath}" "${invalidCommandEmbedder}"`,
    },
    { SKILLS_ROOT: skillsRoot }
  );
  assert.equal(invalidCommandScaffoldRes.code, 0, invalidCommandScaffoldRes.stderr || invalidCommandScaffoldRes.stdout);
  assert.equal(invalidCommandScaffoldRes.json?.success, true);
  const invalidCommandRuntimeScript = path.join(skillsRoot, 'invalid-command-vector-wiki', 'scripts', 'index.js');
  const invalidCommandAbsorbRes = runNode(
    invalidCommandRuntimeScript,
    { action: 'absorb', payload: { forceIndex: true } },
    { SKILLS_ROOT: skillsRoot }
  );
  assert.notEqual(invalidCommandAbsorbRes.code, 0);
  assert.match(invalidCommandAbsorbRes.stderr || invalidCommandAbsorbRes.stdout, /embedding_failed|non-numeric/i);

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
        searchBackend: 'portable',
        minScore: 0.01,
      },
    },
    { SKILLS_ROOT: skillsRoot }
  );
  assert.equal(noRefreshQueryRes.code, 0, noRefreshQueryRes.stderr || noRefreshQueryRes.stdout);
  assert.equal(noRefreshQueryRes.json?.success, true);
  const noRefreshDocs = readJsonl(path.join(generatedConfig.workspaceRoot, 'work', 'docs.jsonl'));
  assert.equal(noRefreshDocs.length, 2);
  assert.equal(fs.existsSync(path.join(generatedConfig.workspaceRoot, 'raw', 'fresh.md')), false);
  assert.equal(noRefreshQueryRes.json?.data?.insufficient, true);

  const refreshQueryRes = runNode(
    runtimeScript,
    {
      action: 'query',
      payload: {
        question: 'fresh-only-token-7291',
        autoAbsorb: true,
        searchBackend: 'portable',
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
  assert.equal(queryRes.json?.data?.query?.searchBackend, 'hybrid');
  assert.equal(queryRes.json?.data?.query?.vectorProvider, 'local-hashing-v1');
  assert.ok(queryRes.json?.metrics?.vectorCandidates > 0);
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
      searchBackend: 'portable',
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
  fs.writeFileSync(
    path.join(rawSourceDir, 'legal.md'),
    '合同违约责任包括继续履行、采取补救措施或者赔偿损失。\n',
    'utf8'
  );

  const updateAbsorbRes = runNode(runtimeScript, { action: 'absorb' }, { SKILLS_ROOT: skillsRoot });
  assert.equal(updateAbsorbRes.code, 0, updateAbsorbRes.stderr || updateAbsorbRes.stdout);
  assert.equal(updateAbsorbRes.json?.success, true);

  const legalHybridQueryRes = runNode(
    runtimeScript,
    {
      action: 'query',
      payload: {
        question: '合同违约责任',
        searchBackend: 'hybrid',
        minScore: 0.01,
      },
    },
    { SKILLS_ROOT: skillsRoot }
  );
  assert.equal(legalHybridQueryRes.code, 0, legalHybridQueryRes.stderr || legalHybridQueryRes.stdout);
  assert.equal(legalHybridQueryRes.json?.success, true);
  assert.equal(legalHybridQueryRes.json?.data?.query?.searchBackend, 'hybrid');
  assert.equal(legalHybridQueryRes.json?.data?.query?.vectorProvider, 'local-hashing-v1');
  assert.ok(legalHybridQueryRes.json?.metrics?.vectorCandidates > 0);
  assert.equal(legalHybridQueryRes.json?.data?.citations?.[0]?.sourcePath?.endsWith('legal.md'), true);

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
