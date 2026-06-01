#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');

function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function normalizeString(value) {
  return String(value == null ? '' : value).trim();
}

function normalizeArray(value) {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeString(item)).filter(Boolean);
  }
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((item) => normalizeString(item))
      .filter(Boolean);
  }
  return [];
}

function slugify(value) {
  const raw = normalizeString(value);
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return slug;
}

function isWithin(parent, child) {
  const rel = path.relative(parent, child);
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function resolveSkillsRoot() {
  const envRoot = normalizeString(process.env.SKILLS_ROOT) || normalizeString(process.env.IDBOTS_SKILLS_ROOT);
  if (envRoot) return path.resolve(envRoot);
  return path.resolve(__dirname, '..', '..');
}

function resolveTemplatePath() {
  return path.join(__dirname, '..', 'assets', 'wiki-skill', 'scripts', 'index.js.template');
}

function resolveRuntimeAssetDir() {
  return path.join(__dirname, '..', 'assets', 'metabot-llm-wiki-runtime');
}

function resolveTemplateSchemaPath() {
  return path.join(resolveRuntimeAssetDir(), 'references', 'payload-schema-v1.json');
}

function resolveSkillDir(root, skillName) {
  return path.join(root, skillName);
}

function renderSkillMarkdown(config) {
  return `---
name: ${config.skillName}
description: ${config.description}
---

# ${config.title}

这是一个一对一的本地 Wiki 技能，绑定到固定的资料源：

- raw source: \`${config.rawSourceDir}\`
- workspace: \`${config.workspaceRoot}\`
- private registry: \`${config.registryHome}\`

## 运行方式

- 运行: \`node "$SKILLS_ROOT/${config.skillName}/scripts/index.js" --payload '<JSON>'\`

## 动作

- \`init\`
- \`ingest\`
- \`index\`
- \`absorb\`
- \`query\`
- \`wiki_build\`
- \`bundle_zip\`
- \`publish_zip\`
- \`publish_snapshot\`
- \`publish_all\`

## 约定

- \`absorb\`、\`ingest\`、\`index\`、发布和构建动作会把 \`rawSourceDir\` 镜像到内部 workspace。
- 普通 \`query\` 不复制 raw、不重建索引，只读已有索引。
- 日常 \`query\` 默认不重建索引，使用已生成的 lexical/vector/hybrid 本地索引快速查询。
- 资料更新流程：把文件放进绑定的 \`rawSourceDir\`，运行 \`absorb\` 刷新索引，再运行 \`query\` 快速查询。
- 如果明确需要边更新边查，\`query\` 可传 \`autoAbsorb:true\` 或 \`refresh:true\`。
- 生成的 HTML wiki、ZIP、snapshot 都由新 skill 内嵌的 wiki 运行时完成。
`;
}

function renderWikiConfig(config) {
  return {
    skillName: config.skillName,
    title: config.title,
    description: config.description,
    kbId: config.kbId,
    aliases: config.aliases,
    rawSourceDir: config.rawSourceDir,
    workspaceRoot: config.workspaceRoot,
    registryHome: config.registryHome,
    siteTitle: config.siteTitle,
    language: config.language,
    chunkSize: config.chunkSize,
    chunkOverlap: config.chunkOverlap,
    queryAutoAbsorb: false,
    embeddingEnabled: config.embeddingEnabled,
    embeddingProvider: config.embeddingProvider,
    embeddingModel: config.embeddingModel,
    embeddingCommand: config.embeddingCommand,
    searchBackend: config.searchBackend,
    lexicalWeight: config.lexicalWeight,
    vectorWeight: config.vectorWeight,
    phraseWeight: config.phraseWeight,
  };
}

function updateSkillsConfig(targetRoot, skillName) {
  const configPath = path.join(targetRoot, 'skills.config.json');
  const fallback = { version: 1, description: 'Default skill configuration for IDBots', defaults: {} };
  const config = readJson(configPath, fallback);
  if (!config || typeof config !== 'object') {
    throw new Error(`Invalid skills.config.json at ${configPath}`);
  }
  if (!config.defaults || typeof config.defaults !== 'object') {
    config.defaults = {};
  }

  let maxOrder = 0;
  for (const value of Object.values(config.defaults)) {
    const order = Number(value && typeof value === 'object' ? value.order : undefined);
    if (Number.isFinite(order)) {
      maxOrder = Math.max(maxOrder, order);
    }
  }
  const nextOrder = maxOrder + 1;
  const existing = config.defaults[skillName] && typeof config.defaults[skillName] === 'object'
    ? config.defaults[skillName]
    : {};

  config.defaults[skillName] = {
    ...existing,
    order: Number.isFinite(Number(existing.order)) ? Number(existing.order) : nextOrder,
    version: normalizeString(existing.version) || '1.0.0',
    'creator-metaid': normalizeString(existing['creator-metaid']) || '',
    installedAt: Date.now(),
    enabled: existing.enabled !== false,
  };

  writeJson(configPath, config);
}

function ensureNoOverlap(sourceRawDir, skillDir) {
  const resolvedSource = path.resolve(sourceRawDir);
  const resolvedSkillDir = path.resolve(skillDir);
  if (resolvedSource === resolvedSkillDir) {
    throw new Error('rawSourceDir cannot be the same as the generated skill directory.');
  }
  if (isWithin(resolvedSkillDir, resolvedSource) || isWithin(resolvedSource, resolvedSkillDir)) {
    throw new Error('rawSourceDir must not live inside the generated skill directory tree.');
  }
}

function validatePayload(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Payload must be a JSON object.');
  }

  const rawSourceDir = normalizeString(payload.rawSourceDir);
  if (!rawSourceDir) {
    throw new Error('payload.rawSourceDir is required.');
  }
  if (!fs.existsSync(rawSourceDir) || !fs.statSync(rawSourceDir).isDirectory()) {
    throw new Error(`payload.rawSourceDir must point to an existing directory: ${rawSourceDir}`);
  }

  const rawSkillName = normalizeString(payload.skillName || payload.name);
  if (!rawSkillName) {
    throw new Error('payload.skillName is required.');
  }

  const skillName = slugify(rawSkillName);
  if (!skillName) {
    throw new Error('payload.skillName must contain letters or numbers.');
  }

  const description = normalizeString(payload.description);
  if (!description) {
    throw new Error('payload.description is required.');
  }

  const title = normalizeString(payload.title) || skillName;
  const aliases = normalizeArray(payload.aliases);
  const kbId = normalizeString(payload.kbId) || skillName;
  const targetRoot = path.resolve(normalizeString(payload.targetRoot) || resolveSkillsRoot());
  const skillDir = resolveSkillDir(targetRoot, skillName);
  const workspaceRoot = path.resolve(normalizeString(payload.workspaceRoot) || path.join(skillDir, 'workspace'));
  const registryHome = path.resolve(normalizeString(payload.registryHome) || path.join(skillDir, '.wiki-home'));
  const siteTitle = normalizeString(payload.siteTitle) || title;
  const language = normalizeString(payload.language) || 'zh-CN';

  ensureNoOverlap(rawSourceDir, skillDir);

  return {
    skillName,
    title,
    description,
    kbId,
    aliases,
    rawSourceDir: path.resolve(rawSourceDir),
    targetRoot,
    skillDir,
    workspaceRoot,
    registryHome,
    siteTitle,
    language,
    chunkSize: Number.isFinite(Number(payload.chunkSize)) ? Number(payload.chunkSize) : 1200,
    chunkOverlap: Number.isFinite(Number(payload.chunkOverlap)) ? Number(payload.chunkOverlap) : 180,
    embeddingEnabled: payload.embeddingEnabled !== false,
    embeddingProvider: ['local-hashing-v1', 'command-json-v1'].includes(normalizeString(payload.embeddingProvider).toLowerCase())
      ? normalizeString(payload.embeddingProvider).toLowerCase()
      : 'local-hashing-v1',
    embeddingModel: normalizeString(payload.embeddingModel) || 'local-hashing-v1',
    embeddingCommand: normalizeString(payload.embeddingCommand),
    searchBackend: ['auto', 'hybrid', 'portable', 'sqlite', 'sqlite-fts', 'scan', 'vector'].includes(normalizeString(payload.searchBackend).toLowerCase())
      ? normalizeString(payload.searchBackend).toLowerCase()
      : 'hybrid',
    lexicalWeight: Number.isFinite(Number(payload.lexicalWeight)) ? Number(payload.lexicalWeight) : 0.55,
    vectorWeight: Number.isFinite(Number(payload.vectorWeight)) ? Number(payload.vectorWeight) : 0.35,
    phraseWeight: Number.isFinite(Number(payload.phraseWeight)) ? Number(payload.phraseWeight) : 0.10,
    overwrite: payload.overwrite === true,
  };
}

function copyTextFile(source, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

function copyRuntimeAsset(targetDir) {
  const runtimeSource = resolveRuntimeAssetDir();
  if (!fs.existsSync(path.join(runtimeSource, 'scripts', 'index.js'))) {
    throw new Error(`Missing embedded wiki runtime asset: ${runtimeSource}`);
  }

  fs.cpSync(runtimeSource, targetDir, {
    recursive: true,
    force: true,
    dereference: true,
  });
}

function writeGeneratedSkill(config) {
  const skillDir = config.skillDir;
  if (fs.existsSync(skillDir)) {
    if (!config.overwrite) {
      throw new Error(`Skill directory already exists: ${skillDir}`);
    }
    fs.rmSync(skillDir, { recursive: true, force: true });
  }

  fs.mkdirSync(skillDir, { recursive: true });
  fs.mkdirSync(path.join(skillDir, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(skillDir, 'references'), { recursive: true });

  const templatePath = resolveTemplatePath();
  const template = fs.readFileSync(templatePath, 'utf8');
  const indexJsPath = path.join(skillDir, 'scripts', 'index.js');
  fs.writeFileSync(indexJsPath, template, 'utf8');
  fs.chmodSync(indexJsPath, 0o755);

  copyRuntimeAsset(path.join(skillDir, 'runtime', 'metabot-llm-wiki'));

  const payloadSchemaPath = resolveTemplateSchemaPath();
  copyTextFile(payloadSchemaPath, path.join(skillDir, 'references', 'payload-schema-v1.json'));

  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), renderSkillMarkdown(config), 'utf8');
  writeJson(path.join(skillDir, 'wiki.config.json'), renderWikiConfig(config));
  updateSkillsConfig(config.targetRoot, config.skillName);

  return {
    skillDir,
    files: [
      path.join(skillDir, 'SKILL.md'),
      path.join(skillDir, 'wiki.config.json'),
      path.join(skillDir, 'scripts', 'index.js'),
      path.join(skillDir, 'runtime', 'metabot-llm-wiki', 'scripts', 'index.js'),
      path.join(skillDir, 'references', 'payload-schema-v1.json'),
      path.join(config.targetRoot, 'skills.config.json'),
    ],
  };
}

function main() {
  const { values, positionals } = parseArgs({
    options: {
      payload: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
  });

  if (values.help) {
    process.stdout.write(
      'Usage: node scaffold-wiki-skill.js --payload \'<json>\'\n' +
      'Creates a dedicated wiki skill from a raw documents directory.\n'
    );
    process.exit(0);
  }

  for (const arg of positionals) {
    if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  const payloadRaw = normalizeString(values.payload);
  if (!payloadRaw) {
    throw new Error('--payload is required.');
  }

  let payload;
  try {
    payload = JSON.parse(payloadRaw);
  } catch (error) {
    throw new Error(`--payload must be valid JSON: ${error.message}`);
  }

  const config = validatePayload(payload);
  ensureDir(config.targetRoot);
  const result = writeGeneratedSkill(config);

  process.stdout.write(
    `${JSON.stringify({
      success: true,
      message: 'Wiki skill scaffolded',
      data: {
        skillDir: result.skillDir,
        sourceRawDir: config.rawSourceDir,
        workspaceRoot: config.workspaceRoot,
        registryHome: config.registryHome,
        files: result.files,
      },
    }, null, 2)}\n`
  );
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
