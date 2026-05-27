#!/usr/bin/env node
'use strict';

/**
 * MetaBot LLM Wiki skill runtime (RAG-first + Wiki-second)
 * Actions:
 * - registry_create
 * - registry_list
 * - registry_set_default
 * - registry_resolve
 * - registry_remove
 * - init
 * - ingest
 * - index
 * - query
 * - absorb
 * - wiki_build
 * - bundle_zip
 * - publish_zip
 * - publish_snapshot
 * - publish_all
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { parseArgs } = require('node:util');
const { spawnSync } = require('node:child_process');

const ACTIONS = new Set([
  'registry_create',
  'registry_list',
  'registry_set_default',
  'registry_resolve',
  'registry_remove',
  'init',
  'ingest',
  'index',
  'query',
  'absorb',
  'wiki_build',
  'bundle_zip',
  'publish_zip',
  'publish_snapshot',
  'publish_all',
]);

const REGISTRY_ACTIONS = new Set([
  'registry_create',
  'registry_list',
  'registry_set_default',
  'registry_resolve',
  'registry_remove',
]);

const DEFAULT_CHUNK_SIZE = 1200;
const DEFAULT_CHUNK_OVERLAP = 180;
const DEFAULT_TOP_K = 8;
const DEFAULT_MIN_SCORE = 0.18;
const DEFAULT_HYBRID_ALPHA = 0.65;
const DEFAULT_LEXICAL_WEIGHT = 0.55;
const DEFAULT_VECTOR_WEIGHT = 0.35;
const DEFAULT_PHRASE_WEIGHT = 0.10;
const DEFAULT_EMBEDDING_PROVIDER = 'local-hashing-v1';
const DEFAULT_EMBEDDING_MODEL = 'local-hashing-v1';
const DEFAULT_EMBEDDING_DIMENSION = 256;
const DEFAULT_SEARCH_BACKEND = 'hybrid';
const DEFAULT_WIKI_SNAPSHOT_PATH = '/protocols/llm-wiki-snapshot';
const DEFAULT_REGISTRY_DIR = '.metabot-llm-wiki';
const REGISTRY_FILE_NAME = 'registry.json';
const SUPPORTED_EXTENSIONS = new Set(['.md', '.txt', '.json', '.csv', '.pdf', '.docx']);

class SkillError extends Error {
  constructor(code, detail, retryable = false) {
    super(detail);
    this.name = 'SkillError';
    this.code = code;
    this.detail = detail;
    this.retryable = retryable;
  }
}

function nowTs() {
  return Date.now();
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeSlashes(value) {
  return String(value || '').replace(/\\/g, '/');
}

function toPosixRelative(baseDir, filePath) {
  return normalizeSlashes(path.relative(baseDir, filePath));
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  const out = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // skip malformed line
    }
  }
  return out;
}

function writeJsonl(filePath, rows) {
  ensureDir(path.dirname(filePath));
  const content = rows.map((row) => JSON.stringify(row)).join('\n');
  fs.writeFileSync(filePath, `${content}${content ? '\n' : ''}`, 'utf8');
}

function hashString(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function hashBuffer(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hashFile(filePath) {
  const data = fs.readFileSync(filePath);
  return hashBuffer(data);
}

function safeTrim(value) {
  return String(value == null ? '' : value).trim();
}

function parseOptionalBooleanFlag(value, fieldName) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (value === 1) return true;
    if (value === 0) return false;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (!normalized) return undefined;
    if (normalized === 'true' || normalized === '1') return true;
    if (normalized === 'false' || normalized === '0') return false;
  }
  throw new SkillError('invalid_payload', `${fieldName} must be boolean (true/false).`);
}

function normalizeLookup(value) {
  return safeTrim(value).toLowerCase();
}

function normalizeStringArray(value) {
  if (Array.isArray(value)) {
    return value.map((item) => safeTrim(item)).filter(Boolean);
  }
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((item) => safeTrim(item))
      .filter(Boolean);
  }
  return [];
}

function slugifyKbId(value) {
  const raw = safeTrim(value);
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return slug || `wiki-${hashString(raw || nowTs()).slice(0, 8)}`;
}

function resolveRegistryHome(payload = {}) {
  return path.resolve(
    safeTrim(payload.registryHome)
      || safeTrim(process.env.METABOT_LLM_WIKI_HOME)
      || path.join(os.homedir(), DEFAULT_REGISTRY_DIR)
  );
}

function resolveRegistryFile(payload = {}) {
  return path.resolve(
    safeTrim(payload.registryFile)
      || path.join(resolveRegistryHome(payload), REGISTRY_FILE_NAME)
  );
}

function normalizeRegistry(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const projectsInput = Array.isArray(input.projects) ? input.projects : [];
  const projects = projectsInput
    .map((project) => {
      const kbId = safeTrim(project?.kbId);
      const rootDir = safeTrim(project?.rootDir);
      if (!kbId || !rootDir) return null;
      return {
        kbId,
        title: safeTrim(project.title) || kbId,
        rootDir: path.resolve(rootDir),
        aliases: [...new Set(normalizeStringArray(project.aliases))],
        createdAt: safeTrim(project.createdAt) || nowIso(),
        updatedAt: safeTrim(project.updatedAt) || nowIso(),
      };
    })
    .filter(Boolean);

  const defaultKbId = safeTrim(input.defaultKbId);
  return {
    version: 1,
    defaultKbId: projects.some((project) => project.kbId === defaultKbId) ? defaultKbId : '',
    projects,
  };
}

function loadRegistry(payload = {}) {
  const registryFile = resolveRegistryFile(payload);
  const registry = normalizeRegistry(readJson(registryFile, { version: 1, defaultKbId: '', projects: [] }));
  return {
    registryFile,
    registryHome: path.dirname(registryFile),
    registry,
  };
}

function saveRegistry(payload, registry) {
  const registryFile = resolveRegistryFile(payload);
  const normalized = normalizeRegistry(registry);
  writeJson(registryFile, normalized);
  return {
    registryFile,
    registryHome: path.dirname(registryFile),
    registry: normalized,
  };
}

function getRegistryLookup(input) {
  return safeTrim(input.kbId)
    || safeTrim(input.payload.kbId)
    || safeTrim(input.payload.wiki)
    || safeTrim(input.payload.wikiName)
    || safeTrim(input.payload.project)
    || safeTrim(input.payload.projectName)
    || safeTrim(input.payload.name);
}

function findRegistryProject(registry, lookup) {
  const wanted = normalizeLookup(lookup);
  if (!wanted) return null;
  return registry.projects.find((project) => {
    if (normalizeLookup(project.kbId) === wanted) return true;
    if (normalizeLookup(project.title) === wanted) return true;
    return project.aliases.some((alias) => normalizeLookup(alias) === wanted);
  }) || null;
}

function resolveRegistryProject(input, options = {}) {
  const { registryFile, registryHome, registry } = loadRegistry(input.payload);
  const lookup = getRegistryLookup(input);

  if (lookup) {
    const project = findRegistryProject(registry, lookup);
    if (project) return { registryFile, registryHome, registry, project, reason: 'lookup' };
    if (options.allowMissingLookup) {
      return { registryFile, registryHome, registry, project: null, reason: 'missing_lookup' };
    }
    throw new SkillError('registry_not_found', `No LLM Wiki project found for "${lookup}".`);
  }

  if (registry.defaultKbId) {
    const project = findRegistryProject(registry, registry.defaultKbId);
    if (project) return { registryFile, registryHome, registry, project, reason: 'default' };
  }

  if (registry.projects.length === 1) {
    return { registryFile, registryHome, registry, project: registry.projects[0], reason: 'single_project' };
  }

  if (registry.projects.length === 0) {
    throw new SkillError('registry_empty', 'No LLM Wiki projects are registered. Create one with registry_create first.');
  }

  throw new SkillError('registry_ambiguous', 'Multiple LLM Wiki projects exist and no default is set. Pass kbId/wiki or run registry_set_default.');
}

function applyRegistryProjectToInput(input, project, resolvedBy) {
  return {
    ...input,
    kbId: project.kbId,
    payload: {
      ...input.payload,
      rootDir: safeTrim(input.payload.rootDir) || project.rootDir,
      siteTitle: safeTrim(input.payload.siteTitle) || project.title,
      resolvedKbId: project.kbId,
      resolvedBy,
    },
  };
}

function resolveInputContext(input) {
  if (REGISTRY_ACTIONS.has(input.action)) return input;

  if (safeTrim(input.kbId)) {
    const resolved = resolveRegistryProject(input, { allowMissingLookup: true });
    if (resolved.project) {
      return applyRegistryProjectToInput(input, resolved.project, 'registry_lookup');
    }
    return input;
  }

  const resolved = resolveRegistryProject(input);
  return applyRegistryProjectToInput(input, resolved.project, `registry_${resolved.reason}`);
}

function resolveSnapshotOnChainMode(payload) {
  const snapshotOnChain = parseOptionalBooleanFlag(payload.snapshotOnChain, 'payload.snapshotOnChain');
  if (snapshotOnChain !== undefined) {
    return {
      enabled: snapshotOnChain,
      source: 'snapshotOnChain',
    };
  }

  const publishOnChain = parseOptionalBooleanFlag(payload.publishOnChain, 'payload.publishOnChain');
  return {
    enabled: publishOnChain === true,
    source: publishOnChain !== undefined ? 'publishOnChain' : 'default',
  };
}

function buildResponseEnvelope(input) {
  return {
    success: true,
    action: input.action,
    kbId: input.kbId,
    message: input.message || 'ok',
    data: input.data || {},
    warnings: input.warnings || [],
    metrics: input.metrics || {},
  };
}

function buildErrorEnvelope(input) {
  return {
    success: false,
    action: input.action || '',
    kbId: input.kbId || '',
    message: input.message || 'failed',
    error: {
      code: input.code || 'unknown_error',
      detail: input.detail || 'Unknown error',
      retryable: Boolean(input.retryable),
    },
  };
}

function parsePayload(argvPayload) {
  const payloadRaw = safeTrim(argvPayload);
  if (payloadRaw) {
    try {
      return JSON.parse(payloadRaw);
    } catch (error) {
      throw new SkillError('invalid_payload', `--payload is not valid JSON: ${error.message}`);
    }
  }

  const stdin = fs.readFileSync(0, 'utf8').trim();
  if (!stdin) {
    throw new SkillError('invalid_payload', 'Missing payload JSON. Use --payload or stdin.');
  }
  try {
    return JSON.parse(stdin);
  } catch (error) {
    throw new SkillError('invalid_payload', `stdin payload is not valid JSON: ${error.message}`);
  }
}

function parseInput(rawInput) {
  if (!rawInput || typeof rawInput !== 'object') {
    throw new SkillError('invalid_payload', 'Payload must be a JSON object.');
  }
  const action = safeTrim(rawInput.action);
  if (!ACTIONS.has(action)) {
    throw new SkillError('invalid_payload', `Unsupported action "${action}".`);
  }

  const payload = rawInput.payload && typeof rawInput.payload === 'object'
    ? rawInput.payload
    : {};
  const kbId = safeTrim(rawInput.kbId) || safeTrim(payload.kbId);

  return {
    action,
    kbId,
    requestId: safeTrim(rawInput.requestId),
    payload,
  };
}

function resolveKbRoot(kbId, payload) {
  const candidate = safeTrim(payload.rootDir)
    || safeTrim(process.env.METABOT_LLM_WIKI_ROOT)
    || path.resolve(process.cwd(), 'workspaces', kbId);
  return path.resolve(candidate);
}

function resolvePaths(kbId, payload) {
  const rootDir = resolveKbRoot(kbId, payload);
  return {
    rootDir,
    rawDir: path.join(rootDir, 'raw'),
    workDir: path.join(rootDir, 'work'),
    indexDir: path.join(rootDir, 'index'),
    embeddingsDir: path.join(rootDir, 'index', 'embeddings'),
    wikiDir: path.join(rootDir, 'wiki'),
    wikiSiteDir: path.join(rootDir, 'wiki', 'site'),
    manifestsDir: path.join(rootDir, 'manifests'),
    logsDir: path.join(rootDir, 'logs'),
    docsFile: path.join(rootDir, 'work', 'docs.jsonl'),
    chunksFile: path.join(rootDir, 'work', 'chunks.jsonl'),
    lexicalIndexFile: path.join(rootDir, 'index', 'lexical.json'),
    lexicalPostingsFile: path.join(rootDir, 'index', 'lexical-postings.json'),
    chunkStoreFile: path.join(rootDir, 'index', 'chunk-store.json'),
    sqliteIndexFile: path.join(rootDir, 'index', 'search.sqlite'),
    vectorIndexFile: path.join(rootDir, 'index', 'vectors.json'),
    embeddingIndexFile: path.join(rootDir, 'index', 'embeddings', 'index.json'),
    stateFile: path.join(rootDir, 'state.json'),
    configFile: path.join(rootDir, 'kb.config.json'),
    ingestFailureFile: path.join(rootDir, 'logs', 'failed_ingest.jsonl'),
  };
}

function loadState(paths, kbId) {
  return readJson(paths.stateFile, {
    kbId,
    createdAt: nowTs(),
    updatedAt: nowTs(),
    kbVersion: 'v0',
    docsFingerprint: {},
    latestZipPath: '',
    latestZipSha256: '',
    latestZipUri: '',
  });
}

function saveState(paths, state) {
  state.updatedAt = nowTs();
  writeJson(paths.stateFile, state);
}

function bumpVersion(version) {
  const raw = safeTrim(version);
  const match = raw.match(/^v(\d+)$/i);
  if (!match) return 'v1';
  return `v${Number(match[1]) + 1}`;
}

function listFilesRecursive(rootDir) {
  const out = [];
  if (!fs.existsSync(rootDir)) return out;

  const walk = (currentDir) => {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.name || entry.name === '.DS_Store') continue;
      const abs = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
      } else if (entry.isFile()) {
        out.push(abs);
      }
    }
  };

  walk(rootDir);
  out.sort((a, b) => a.localeCompare(b));
  return out;
}

function normalizeConfig(configInput) {
  const chunkSize = Number(configInput.chunkSize);
  const chunkOverlap = Number(configInput.chunkOverlap);
  const searchBackend = safeTrim(configInput.searchBackend).toLowerCase();
  const embeddingProvider = safeTrim(configInput.embeddingProvider).toLowerCase();
  const lexicalWeight = Number(configInput.lexicalWeight);
  const vectorWeight = Number(configInput.vectorWeight);
  const phraseWeight = Number(configInput.phraseWeight);
  return {
    language: safeTrim(configInput.language) || 'zh-CN',
    chunkSize: Number.isFinite(chunkSize) && chunkSize >= 200 ? Math.floor(chunkSize) : DEFAULT_CHUNK_SIZE,
    chunkOverlap: Number.isFinite(chunkOverlap) && chunkOverlap >= 0 ? Math.floor(chunkOverlap) : DEFAULT_CHUNK_OVERLAP,
    embeddingEnabled: configInput.embeddingEnabled !== false,
    embeddingProvider: ['local-hashing-v1', 'command-json-v1'].includes(embeddingProvider)
      ? embeddingProvider
      : DEFAULT_EMBEDDING_PROVIDER,
    embeddingModel: safeTrim(configInput.embeddingModel) || DEFAULT_EMBEDDING_MODEL,
    embeddingCommand: safeTrim(configInput.embeddingCommand),
    searchBackend: ['auto', 'hybrid', 'portable', 'portable-lexical', 'sqlite', 'sqlite-fts', 'scan', 'vector', 'disabled'].includes(searchBackend)
      ? searchBackend
      : DEFAULT_SEARCH_BACKEND,
    lexicalWeight: Number.isFinite(lexicalWeight) && lexicalWeight >= 0 ? lexicalWeight : DEFAULT_LEXICAL_WEIGHT,
    vectorWeight: Number.isFinite(vectorWeight) && vectorWeight >= 0 ? vectorWeight : DEFAULT_VECTOR_WEIGHT,
    phraseWeight: Number.isFinite(phraseWeight) && phraseWeight >= 0 ? phraseWeight : DEFAULT_PHRASE_WEIGHT,
  };
}

function loadConfig(paths) {
  const cfg = readJson(paths.configFile, null);
  if (!cfg || typeof cfg !== 'object') {
    return normalizeConfig({});
  }
  return normalizeConfig(cfg);
}

function getIndexConfigSignature(config) {
  const normalized = normalizeConfig(config);
  return hashString(JSON.stringify({
    chunkSize: normalized.chunkSize,
    chunkOverlap: normalized.chunkOverlap,
    embeddingEnabled: normalized.embeddingEnabled,
    embeddingProvider: normalized.embeddingProvider,
    embeddingModel: normalized.embeddingModel,
    embeddingCommand: normalized.embeddingCommand,
    searchBackend: normalized.searchBackend,
    lexicalWeight: normalized.lexicalWeight,
    vectorWeight: normalized.vectorWeight,
    phraseWeight: normalized.phraseWeight,
  }));
}

function getEmbeddingConfigSignature(config) {
  const normalized = normalizeConfig(config);
  return hashString(JSON.stringify({
    embeddingEnabled: normalized.embeddingEnabled,
    embeddingProvider: normalized.embeddingProvider,
    embeddingModel: normalized.embeddingProvider === 'local-hashing-v1'
      ? 'local-hashing-v1'
      : normalized.embeddingModel,
    embeddingCommand: normalized.embeddingProvider === 'command-json-v1'
      ? normalized.embeddingCommand
      : '',
    localHashingDimension: normalized.embeddingProvider === 'local-hashing-v1'
      ? DEFAULT_EMBEDDING_DIMENSION
      : 0,
  }));
}

function saveConfig(paths, config) {
  writeJson(paths.configFile, normalizeConfig(config));
}

function getFileTitle(filePath, text) {
  const fileBase = path.basename(filePath, path.extname(filePath));
  const firstLine = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^#+\s*/, ''))
    .find(Boolean);
  return firstLine || fileBase || 'Untitled';
}

function runCommand(command, args) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error || null,
  };
}

function commandExists(command) {
  const checker = process.platform === 'win32' ? 'where' : 'which';
  const result = spawnSync(checker, [command], {
    stdio: 'ignore',
  });
  return result.status === 0;
}

function getPdftotextInstallHint() {
  if (process.platform === 'darwin') {
    return 'Install with: brew install poppler';
  }
  if (process.platform === 'win32') {
    return 'Install Poppler and ensure pdftotext is in PATH. Example: choco install poppler or scoop install poppler';
  }
  if (process.platform === 'linux') {
    return 'Install poppler-utils. Examples: sudo apt install poppler-utils | sudo dnf install poppler-utils | sudo pacman -S poppler';
  }
  return 'Install Poppler and ensure the pdftotext command is available in PATH.';
}

function getDocxDependencyHint() {
  if (process.platform === 'darwin') {
    return 'DOCX parsing uses textutil (built-in on macOS).';
  }
  return 'DOCX parsing currently uses textutil (macOS). On non-macOS, convert DOCX to .md/.txt first.';
}

function detectRuntimeDependencies() {
  return {
    pdftotext: {
      command: 'pdftotext',
      available: commandExists('pdftotext'),
      requiredFor: ['.pdf'],
      installHint: getPdftotextInstallHint(),
    },
    textutil: {
      command: 'textutil',
      available: commandExists('textutil'),
      requiredFor: ['.docx'],
      installHint: getDocxDependencyHint(),
    },
  };
}

function extractTextFromFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.md' || ext === '.txt' || ext === '.json' || ext === '.csv') {
    return fs.readFileSync(filePath, 'utf8');
  }

  if (ext === '.pdf') {
    if (!commandExists('pdftotext')) {
      throw new SkillError(
        'dependency_missing',
        `Missing dependency "pdftotext" for PDF parsing. ${getPdftotextInstallHint()}`
      );
    }
    const pdfResult = runCommand('pdftotext', ['-layout', '-enc', 'UTF-8', filePath, '-']);
    if (pdfResult.status === 0 && safeTrim(pdfResult.stdout)) {
      return pdfResult.stdout;
    }
    throw new SkillError(
      'unsupported_format',
      `Failed to parse PDF "${filePath}". ${getPdftotextInstallHint()}`
    );
  }

  if (ext === '.docx') {
    if (!commandExists('textutil')) {
      throw new SkillError('dependency_missing', getDocxDependencyHint());
    }
    const textutilResult = runCommand('textutil', ['-convert', 'txt', '-stdout', filePath]);
    if (textutilResult.status === 0 && safeTrim(textutilResult.stdout)) {
      return textutilResult.stdout;
    }
    throw new SkillError(
      'unsupported_format',
      `Failed to parse DOCX "${filePath}". Install textutil/docx parser to enable .docx parsing.`
    );
  }

  throw new SkillError('unsupported_format', `Unsupported file extension: ${ext}`);
}

function cleanText(value) {
  return String(value || '')
    .replace(/\u0000/g, ' ')
    .replace(/\r/g, '')
    .replace(/\t/g, ' ')
    .replace(/[ ]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function buildDocId(relativePath) {
  return `doc_${hashString(relativePath).slice(0, 12)}`;
}

function tokenize(text) {
  const source = String(text || '').toLowerCase();
  const tokens = [];
  const latin = source.match(/[a-z0-9_]+/g) || [];
  tokens.push(...latin);
  const cjk = source.match(/[\u4e00-\u9fff]/g) || [];
  tokens.push(...cjk);
  return tokens;
}

function normalizeVector(vector, expectedDimension = 0) {
  if (!Array.isArray(vector)) {
    throw new SkillError('embedding_failed', 'Embedding provider returned a non-array vector.');
  }
  if (expectedDimension > 0 && vector.length !== expectedDimension) {
    throw new SkillError(
      'embedding_failed',
      `Embedding provider returned dimension ${vector.length}; expected ${expectedDimension}.`
    );
  }
  if (vector.length === 0) {
    throw new SkillError('embedding_failed', 'Embedding provider returned an empty vector.');
  }
  if (vector.some((item) => typeof item !== 'number' || !Number.isFinite(item))) {
    throw new SkillError('embedding_failed', 'Embedding provider returned a vector with non-numeric values.');
  }
  const values = vector.slice();
  const magnitude = Math.sqrt(values.reduce((sum, item) => sum + (item * item), 0));
  if (!Number.isFinite(magnitude) || magnitude <= 0) {
    return values.map(() => 0);
  }
  return values.map((item) => item / magnitude);
}

function localHashingEmbedText(text, dimension = DEFAULT_EMBEDDING_DIMENSION) {
  const vector = new Array(dimension).fill(0);
  const tokens = tokenize(text);
  for (const token of tokens) {
    const digest = crypto.createHash('sha256').update(token, 'utf8').digest();
    const bucket = digest.readUInt32BE(0) % dimension;
    const sign = (digest[4] % 2) === 0 ? 1 : -1;
    vector[bucket] += sign;
  }
  return normalizeVector(vector, dimension);
}

function parseCommandLine(commandText) {
  const input = safeTrim(commandText);
  const parts = [];
  let current = '';
  let quote = '';

  for (let idx = 0; idx < input.length; idx += 1) {
    const char = input[idx];
    if (char === '\\') {
      const next = input[idx + 1];
      if (quote && next === quote) {
        current += next;
        idx += 1;
      } else if (!quote && next && /\s/.test(next)) {
        current += next;
        idx += 1;
      } else if (!quote && (next === '"' || next === "'")) {
        current += next;
        idx += 1;
      } else {
        current += char;
      }
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = '';
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        parts.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }

  if (quote) {
    throw new SkillError('embedding_failed', 'embeddingCommand has an unterminated quote.');
  }
  if (current) parts.push(current);
  return parts;
}

function embedTextsWithCommand(config, texts) {
  const commandParts = parseCommandLine(config.embeddingCommand);
  if (commandParts.length === 0) {
    throw new SkillError('embedding_failed', 'embeddingCommand is required for command-json-v1.');
  }

  const result = spawnSync(commandParts[0], commandParts.slice(1), {
    input: JSON.stringify({
      model: config.embeddingModel,
      texts,
    }),
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
    timeout: 120000,
  });

  if (result.error) {
    throw new SkillError('embedding_failed', `embeddingCommand failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = safeTrim(result.stderr) || safeTrim(result.stdout) || `exit code ${result.status}`;
    throw new SkillError('embedding_failed', `embeddingCommand failed: ${detail}`);
  }

  let output;
  try {
    output = JSON.parse(result.stdout || '{}');
  } catch (error) {
    throw new SkillError('embedding_failed', `embeddingCommand stdout is not valid JSON: ${error.message}`);
  }
  if (!output || typeof output !== 'object' || !Array.isArray(output.vectors)) {
    throw new SkillError('embedding_failed', 'embeddingCommand must output JSON shaped as { "vectors": [[...]] }.');
  }
  if (output.vectors.length !== texts.length) {
    throw new SkillError(
      'embedding_failed',
      `embeddingCommand returned ${output.vectors.length} vectors for ${texts.length} texts.`
    );
  }

  const dimension = output.vectors.length > 0 && Array.isArray(output.vectors[0]) ? output.vectors[0].length : 0;
  if (dimension <= 0) {
    throw new SkillError('embedding_failed', 'embeddingCommand returned no vector dimensions.');
  }
  return {
    provider: 'command-json-v1',
    model: config.embeddingModel,
    dimension,
    vectors: output.vectors.map((vector) => normalizeVector(vector, dimension)),
  };
}

function embedTexts(configInput, texts) {
  const config = normalizeConfig(configInput);
  if (!config.embeddingEnabled) {
    throw new SkillError('embedding_failed', 'Embedding is disabled for this wiki.');
  }
  if (config.embeddingProvider === 'local-hashing-v1') {
    return {
      provider: 'local-hashing-v1',
      model: 'local-hashing-v1',
      dimension: DEFAULT_EMBEDDING_DIMENSION,
      vectors: texts.map((text) => localHashingEmbedText(text, DEFAULT_EMBEDDING_DIMENSION)),
    };
  }
  if (config.embeddingProvider === 'command-json-v1') {
    return embedTextsWithCommand(config, texts);
  }
  throw new SkillError('embedding_failed', `Unsupported embeddingProvider: ${config.embeddingProvider}`);
}

function cosineSimilarity(left, right) {
  const limit = Math.min(left.length, right.length);
  let score = 0;
  for (let i = 0; i < limit; i += 1) {
    score += Number(left[i] || 0) * Number(right[i] || 0);
  }
  return score;
}

function cjkBigrams(text) {
  const chars = safeTrim(text).match(/[\u4e00-\u9fff]/g) || [];
  const out = [];
  for (let idx = 0; idx < chars.length - 1; idx += 1) {
    out.push(`${chars[idx]}${chars[idx + 1]}`);
  }
  return out;
}

function phraseScore(question, text) {
  const q = cleanText(question);
  const body = cleanText(text);
  if (!q || !body) return 0;

  let score = body.includes(q) ? 1 : 0;
  const queryBigrams = new Set(cjkBigrams(q));
  if (queryBigrams.size > 0) {
    const bodyBigrams = new Set(cjkBigrams(body));
    let shared = 0;
    for (const item of queryBigrams) {
      if (bodyBigrams.has(item)) shared += 1;
    }
    score += shared / queryBigrams.size;
  }

  const latinTokens = tokenize(q).filter((token) => /[a-z0-9_]/i.test(token));
  if (latinTokens.length > 0) {
    const lowerBody = body.toLowerCase();
    const matched = latinTokens.filter((token) => lowerBody.includes(token.toLowerCase())).length;
    score += matched / latinTokens.length;
  }
  return score;
}

function normalizedPositive(value, maxValue) {
  const raw = Number(value) || 0;
  const max = Number(maxValue) || 0;
  if (max <= 1e-9) return 0;
  return Math.max(0, raw) / max;
}

function toFrequencyMap(tokens) {
  const map = new Map();
  for (const token of tokens) {
    map.set(token, (map.get(token) || 0) + 1);
  }
  return map;
}

function objectFromMap(map) {
  return Object.fromEntries([...map.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
}

function buildPortableSearchIndex(chunks, docCount) {
  const postingsByToken = new Map();
  const docFreq = new Map();
  const chunkStore = {};

  for (const chunk of chunks) {
    const tokens = tokenize(chunk.text);
    const tokenMap = toFrequencyMap(tokens);
    const uniqueTokens = new Set(tokenMap.keys());

    chunkStore[chunk.chunkId] = {
      docId: chunk.docId,
      docTitle: chunk.docTitle,
      sourcePath: chunk.sourcePath,
      chunkId: chunk.chunkId,
      snippet: buildCitationSnippet(chunk.text),
      text: chunk.text,
      startOffset: chunk.startOffset,
      endOffset: chunk.endOffset,
      updatedAt: chunk.updatedAt,
    };

    for (const token of uniqueTokens) {
      docFreq.set(token, (docFreq.get(token) || 0) + 1);
    }
    for (const [token, tf] of tokenMap.entries()) {
      if (!postingsByToken.has(token)) {
        postingsByToken.set(token, []);
      }
      postingsByToken.get(token).push({
        chunkId: chunk.chunkId,
        tf,
      });
    }
  }

  const postings = {};
  for (const [token, rows] of [...postingsByToken.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    postings[token] = rows.sort((a, b) => a.chunkId.localeCompare(b.chunkId));
  }

  const generatedAt = nowIso();
  return {
    lexicalIndex: {
      generatedAt,
      searchBackend: 'portable-lexical',
      tokenizer: {
        name: 'latin+cjk-char',
        version: 1,
        latinPattern: '[a-z0-9_]+',
        cjkPattern: '[\\u4e00-\\u9fff]',
      },
      chunkCount: chunks.length,
      docCount,
      docFreq: objectFromMap(docFreq),
      postings,
    },
    chunkStore: {
      generatedAt,
      searchBackend: 'portable-lexical',
      chunkCount: chunks.length,
      docCount,
      chunks: chunkStore,
    },
  };
}

function loadSqliteModule() {
  try {
    return require('node:sqlite');
  } catch {
    return null;
  }
}

function sqliteFtsAvailable() {
  const sqlite = loadSqliteModule();
  if (!sqlite || !sqlite.DatabaseSync) return false;
  let db = null;
  try {
    db = new sqlite.DatabaseSync(':memory:');
    db.exec("CREATE VIRTUAL TABLE wiki_fts_probe USING fts5(text, tokenize='trigram')");
    return true;
  } catch {
    return false;
  } finally {
    if (db) {
      try {
        db.close();
      } catch {
        // ignore close errors for optional capability probing
      }
    }
  }
}

function buildSqliteFtsIndex(chunks, docCount, sqliteIndexFile) {
  const sqlite = loadSqliteModule();
  if (!sqlite || !sqlite.DatabaseSync) {
    return { available: false, reason: 'node:sqlite is not available in this runtime.' };
  }

  ensureDir(path.dirname(sqliteIndexFile));
  fs.rmSync(sqliteIndexFile, { force: true });
  fs.rmSync(`${sqliteIndexFile}-wal`, { force: true });
  fs.rmSync(`${sqliteIndexFile}-shm`, { force: true });

  let db = null;
  try {
    db = new sqlite.DatabaseSync(sqliteIndexFile);
    db.exec(`
      PRAGMA journal_mode = DELETE;
      CREATE TABLE meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE chunks_fts USING fts5(
        chunkId UNINDEXED,
        docId UNINDEXED,
        sourcePath UNINDEXED,
        docTitle UNINDEXED,
        text,
        snippet UNINDEXED,
        startOffset UNINDEXED,
        endOffset UNINDEXED,
        updatedAt UNINDEXED,
        tokenize='trigram'
      );
    `);
    const metaInsert = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
    metaInsert.run('generatedAt', nowIso());
    metaInsert.run('searchBackend', 'sqlite-fts');
    metaInsert.run('tokenizer', 'fts5-trigram');
    metaInsert.run('chunkCount', String(chunks.length));
    metaInsert.run('docCount', String(docCount));

    const insert = db.prepare(`
      INSERT INTO chunks_fts (
        chunkId,
        docId,
        sourcePath,
        docTitle,
        text,
        snippet,
        startOffset,
        endOffset,
        updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    db.exec('BEGIN');
    for (const chunk of chunks) {
      insert.run(
        chunk.chunkId,
        chunk.docId,
        chunk.sourcePath,
        chunk.docTitle,
        chunk.text,
        buildCitationSnippet(chunk.text),
        String(chunk.startOffset || 0),
        String(chunk.endOffset || 0),
        String(chunk.updatedAt || 0)
      );
    }
    db.exec('COMMIT');
    return {
      available: true,
      searchBackend: 'sqlite-fts',
      sqliteIndexFile,
      tokenizer: 'fts5-trigram',
      chunkCount: chunks.length,
      docCount,
    };
  } catch (error) {
    try {
      if (db) db.exec('ROLLBACK');
    } catch {
      // rollback is best-effort; the index can be rebuilt later
    }
    fs.rmSync(sqliteIndexFile, { force: true });
    return {
      available: false,
      reason: `sqlite_fts_unavailable: ${error.message}`,
    };
  } finally {
    if (db) {
      try {
        db.close();
      } catch {
        // ignore close errors after optional index build
      }
    }
  }
}

function buildVectorIndex(chunks, config) {
  const embedded = embedTexts(config, chunks.map((chunk) => chunk.text));
  const normalizedConfig = normalizeConfig(config);
  return {
    generatedAt: nowIso(),
    provider: embedded.provider,
    model: embedded.model,
    dimension: embedded.dimension,
    embeddingConfigSignature: getEmbeddingConfigSignature(config),
    embeddingCommandHash: normalizedConfig.embeddingProvider === 'command-json-v1'
      ? hashString(normalizedConfig.embeddingCommand)
      : '',
    vectorNormalization: 'l2',
    chunkCount: chunks.length,
    vectors: chunks.map((chunk, idx) => ({
      chunkId: chunk.chunkId,
      docId: chunk.docId,
      sourcePath: chunk.sourcePath,
      docTitle: chunk.docTitle,
      text: chunk.text,
      snippet: buildCitationSnippet(chunk.text),
      startOffset: chunk.startOffset,
      endOffset: chunk.endOffset,
      updatedAt: chunk.updatedAt,
      vector: embedded.vectors[idx],
    })),
  };
}

function portableIndexFilesExist(paths) {
  return fs.existsSync(paths.lexicalPostingsFile) && fs.existsSync(paths.chunkStoreFile);
}

function vectorIndexFileExists(paths) {
  return fs.existsSync(paths.vectorIndexFile);
}

function sqliteIndexFileExists(paths) {
  return fs.existsSync(paths.sqliteIndexFile);
}

function normalizeSearchBackend(value) {
  const normalized = safeTrim(value).toLowerCase();
  if (!normalized) return '';
  if ([
    'auto',
    'hybrid',
    'portable',
    'portable-lexical',
    'sqlite',
    'sqlite-fts',
    'vector',
    'scan',
    'chunk-scan',
    'disabled',
    'none',
  ].includes(normalized)) {
    return normalized;
  }
  return '';
}

function chunkText(text, chunkSize, chunkOverlap) {
  const normalized = cleanText(text);
  if (!normalized) return [];
  if (normalized.length <= chunkSize) {
    return [{ text: normalized, startOffset: 0, endOffset: normalized.length }];
  }

  const chunks = [];
  const step = Math.max(1, chunkSize - chunkOverlap);
  let cursor = 0;
  while (cursor < normalized.length) {
    const end = Math.min(normalized.length, cursor + chunkSize);
    const slice = normalized.slice(cursor, end).trim();
    if (slice) {
      chunks.push({
        text: slice,
        startOffset: cursor,
        endOffset: end,
      });
    }
    if (end >= normalized.length) break;
    cursor += step;
  }
  return chunks;
}

function buildCitationSnippet(text, maxChars = 220) {
  const normalized = cleanText(text);
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars - 1)}…`;
}

function summarizeCitations(citations) {
  if (!citations.length) {
    return '当前知识库证据不足，无法给出可靠结论。';
  }
  const lines = citations.slice(0, 3).map((item, idx) => {
    return `${idx + 1}. ${item.docTitle || item.sourcePath}: ${item.snippet}`;
  });
  return `基于当前知识库证据，相关要点如下：\n${lines.join('\n')}`;
}

function ensureKbStructure(paths) {
  ensureDir(paths.rootDir);
  ensureDir(paths.rawDir);
  ensureDir(paths.workDir);
  ensureDir(paths.indexDir);
  ensureDir(paths.embeddingsDir);
  ensureDir(paths.wikiDir);
  ensureDir(paths.wikiSiteDir);
  ensureDir(paths.manifestsDir);
  ensureDir(paths.logsDir);
}

function actionRegistryCreate(input) {
  const startedAt = nowTs();
  const registryState = loadRegistry(input.payload);
  const registry = registryState.registry;
  const title = safeTrim(input.payload.title) || safeTrim(input.payload.name) || safeTrim(input.kbId) || 'LLM Wiki';
  const kbId = safeTrim(input.kbId) || safeTrim(input.payload.kbId) || slugifyKbId(title);
  const rootDir = safeTrim(input.payload.rootDir)
    ? path.resolve(input.payload.rootDir)
    : path.join(registryState.registryHome, 'projects', kbId);
  const aliases = [...new Set(normalizeStringArray(input.payload.aliases))];
  const existingIndex = registry.projects.findIndex((project) => project.kbId === kbId);
  const existing = existingIndex >= 0 ? registry.projects[existingIndex] : null;
  const now = nowIso();
  const project = {
    kbId,
    title,
    rootDir,
    aliases,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };

  if (existingIndex >= 0) {
    registry.projects[existingIndex] = project;
  } else {
    registry.projects.push(project);
  }
  registry.projects.sort((a, b) => a.kbId.localeCompare(b.kbId));

  const setDefaultFlag = parseOptionalBooleanFlag(input.payload.setDefault, 'payload.setDefault');
  if (setDefaultFlag === true || !registry.defaultKbId || registry.projects.length === 1) {
    registry.defaultKbId = kbId;
  }

  const saved = saveRegistry(input.payload, registry);
  const paths = resolvePaths(kbId, { rootDir });
  ensureKbStructure(paths);

  const config = normalizeConfig(input.payload.config || {});
  saveConfig(paths, config);
  const state = loadState(paths, kbId);
  saveState(paths, {
    ...state,
    kbId,
    createdAt: state.createdAt || nowTs(),
  });

  return {
    message: existing ? 'LLM Wiki project updated' : 'LLM Wiki project registered',
    data: {
      project,
      defaultKbId: saved.registry.defaultKbId,
      registryFile: saved.registryFile,
      directories: {
        raw: paths.rawDir,
        work: paths.workDir,
        index: paths.indexDir,
        wikiSite: paths.wikiSiteDir,
        manifests: paths.manifestsDir,
        logs: paths.logsDir,
      },
    },
    metrics: {
      elapsedMs: nowTs() - startedAt,
    },
  };
}

function actionRegistryList(input) {
  const startedAt = nowTs();
  const { registryFile, registry } = loadRegistry(input.payload);
  return {
    message: 'LLM Wiki registry loaded',
    data: {
      registryFile,
      defaultKbId: registry.defaultKbId,
      projects: registry.projects,
      count: registry.projects.length,
    },
    metrics: {
      elapsedMs: nowTs() - startedAt,
    },
  };
}

function actionRegistryResolve(input) {
  const startedAt = nowTs();
  const resolved = resolveRegistryProject(input);
  return {
    message: 'LLM Wiki project resolved',
    data: {
      project: resolved.project,
      resolvedBy: resolved.reason,
      registryFile: resolved.registryFile,
      defaultKbId: resolved.registry.defaultKbId,
    },
    metrics: {
      elapsedMs: nowTs() - startedAt,
    },
  };
}

function actionRegistrySetDefault(input) {
  const startedAt = nowTs();
  const resolved = resolveRegistryProject(input);
  const registry = resolved.registry;
  registry.defaultKbId = resolved.project.kbId;
  const saved = saveRegistry(input.payload, registry);
  return {
    message: 'Default LLM Wiki project updated',
    data: {
      defaultKbId: saved.registry.defaultKbId,
      project: resolved.project,
      registryFile: saved.registryFile,
    },
    metrics: {
      elapsedMs: nowTs() - startedAt,
    },
  };
}

function actionRegistryRemove(input) {
  const startedAt = nowTs();
  const resolved = resolveRegistryProject(input);
  const registry = resolved.registry;
  registry.projects = registry.projects.filter((project) => project.kbId !== resolved.project.kbId);
  if (registry.defaultKbId === resolved.project.kbId) {
    registry.defaultKbId = '';
  }
  const saved = saveRegistry(input.payload, registry);
  return {
    message: 'LLM Wiki project removed from registry',
    data: {
      removed: resolved.project,
      defaultKbId: saved.registry.defaultKbId,
      registryFile: saved.registryFile,
      deletedFiles: false,
    },
    metrics: {
      elapsedMs: nowTs() - startedAt,
    },
  };
}

function actionInit(input, paths, state) {
  ensureKbStructure(paths);
  const config = normalizeConfig(input.payload.config || {});
  saveConfig(paths, config);
  const dependencies = detectRuntimeDependencies();
  const warnings = [];
  if (!dependencies.pdftotext.available) {
    warnings.push(`Missing dependency "pdftotext". ${dependencies.pdftotext.installHint}`);
  }
  if (!dependencies.textutil.available) {
    warnings.push(`DOCX parsing may be unavailable. ${dependencies.textutil.installHint}`);
  }

  const createdNow = !fs.existsSync(paths.stateFile);
  const nextState = {
    ...state,
    kbId: input.kbId,
    createdAt: createdNow ? nowTs() : state.createdAt || nowTs(),
    updatedAt: nowTs(),
  };
  saveState(paths, nextState);

  return {
    message: 'Knowledge base initialized',
    warnings,
    data: {
      rootDir: paths.rootDir,
      kbVersion: nextState.kbVersion || 'v0',
      config,
      dependencies,
      directories: {
        raw: paths.rawDir,
        work: paths.workDir,
        index: paths.indexDir,
        wikiSite: paths.wikiSiteDir,
        manifests: paths.manifestsDir,
        logs: paths.logsDir,
      },
    },
  };
}

function actionIngest(input, paths, state) {
  ensureKbStructure(paths);
  const startedAt = nowTs();
  const mode = safeTrim(input.payload.mode || 'incremental').toLowerCase();
  const docsExisting = readJsonl(paths.docsFile);
  const docsBySource = new Map(docsExisting.map((doc) => [doc.sourcePath, doc]));
  const prevFingerprint = state.docsFingerprint && typeof state.docsFingerprint === 'object'
    ? state.docsFingerprint
    : {};
  const nextFingerprint = {};
  const failedRows = [];
  const warnings = [];

  const files = listFilesRecursive(paths.rawDir);
  const candidateFiles = files.filter((absPath) => SUPPORTED_EXTENSIONS.has(path.extname(absPath).toLowerCase()));
  const activeSources = new Set();

  let docsNew = 0;
  let docsUpdated = 0;
  let docsSkipped = 0;
  let parseFailed = 0;

  for (const absPath of candidateFiles) {
    const relPath = toPosixRelative(paths.rootDir, absPath);
    const stat = fs.statSync(absPath);
    const fileHash = hashFile(absPath);
    const previous = prevFingerprint[relPath];

    nextFingerprint[relPath] = {
      hash: fileHash,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      updatedAt: nowTs(),
      docId: previous && previous.docId ? previous.docId : buildDocId(relPath),
    };

    activeSources.add(relPath);

    if (mode === 'incremental' && previous && previous.hash === fileHash) {
      docsSkipped += 1;
      continue;
    }

    try {
      const extracted = cleanText(extractTextFromFile(absPath));
      if (!extracted) {
        throw new SkillError('parse_failed', `No text extracted from ${relPath}`);
      }

      const ext = path.extname(absPath).toLowerCase();
      const docId = buildDocId(relPath);
      const docRecord = {
        docId,
        sourcePath: relPath,
        sourceType: ext.slice(1),
        title: getFileTitle(absPath, extracted),
        text: extracted,
        textHash: hashString(extracted),
        fileHash,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        updatedAt: nowTs(),
      };

      if (docsBySource.has(relPath)) {
        docsUpdated += 1;
      } else {
        docsNew += 1;
      }
      docsBySource.set(relPath, docRecord);
    } catch (error) {
      parseFailed += 1;
      failedRows.push({
        sourcePath: relPath,
        failedAt: nowIso(),
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  let docsRemoved = 0;
  for (const sourcePath of [...docsBySource.keys()]) {
    if (!activeSources.has(sourcePath)) {
      docsBySource.delete(sourcePath);
      docsRemoved += 1;
    }
  }

  if (failedRows.length > 0) {
    writeJsonl(paths.ingestFailureFile, failedRows);
    warnings.push(`Some files failed to parse. See ${paths.ingestFailureFile}`);
  }

  const docsOut = [...docsBySource.values()].sort((a, b) => a.sourcePath.localeCompare(b.sourcePath));
  writeJsonl(paths.docsFile, docsOut);

  const changed = docsNew + docsUpdated + docsRemoved > 0;
  const nextState = {
    ...state,
    docsFingerprint: nextFingerprint,
    lastIngestAt: nowTs(),
  };
  if (changed) {
    nextState.kbVersion = bumpVersion(state.kbVersion);
  }
  saveState(paths, nextState);

  return {
    message: 'Ingest completed',
    warnings,
    data: {
      mode,
      docsSeen: candidateFiles.length,
      docsTotal: docsOut.length,
      docsNew,
      docsUpdated,
      docsRemoved,
      docsSkipped,
      parseFailed,
      changed,
      kbVersion: nextState.kbVersion,
    },
    metrics: {
      elapsedMs: nowTs() - startedAt,
    },
  };
}

function actionIndex(input, paths, state) {
  ensureKbStructure(paths);
  const startedAt = nowTs();
  const config = loadConfig(paths);
  const docs = readJsonl(paths.docsFile);
  if (docs.length === 0) {
    throw new SkillError('index_build_failed', 'No documents found. Run ingest first.');
  }

  const chunks = [];
  for (const doc of docs) {
    const pieces = chunkText(doc.text, config.chunkSize, config.chunkOverlap);
    pieces.forEach((piece, idx) => {
      const chunkTextHash = hashString(piece.text);
      chunks.push({
        chunkId: `${doc.docId}#c${idx + 1}`,
        docId: doc.docId,
        docTitle: doc.title,
        sourcePath: doc.sourcePath,
        text: piece.text,
        textHash: chunkTextHash,
        startOffset: piece.startOffset,
        endOffset: piece.endOffset,
        updatedAt: nowTs(),
      });
    });
  }

  writeJsonl(paths.chunksFile, chunks);
  const portableSearch = buildPortableSearchIndex(chunks, docs.length);
  writeJson(paths.lexicalPostingsFile, portableSearch.lexicalIndex);
  writeJson(paths.chunkStoreFile, portableSearch.chunkStore);
  const sqliteIndex = buildSqliteFtsIndex(chunks, docs.length, paths.sqliteIndexFile);

  const lexicalIndex = {
    generatedAt: nowIso(),
    chunkCount: chunks.length,
    docCount: docs.length,
    tokenizer: 'latin+cjk-char',
    searchBackend: 'portable-lexical',
    portableIndexFile: paths.lexicalPostingsFile,
    chunkStoreFile: paths.chunkStoreFile,
    sqliteFts: sqliteIndex,
  };
  writeJson(paths.lexicalIndexFile, lexicalIndex);

  let vectorIndex = null;
  if (config.embeddingEnabled) {
    vectorIndex = buildVectorIndex(chunks, config);
    writeJson(paths.vectorIndexFile, vectorIndex);
  } else {
    writeJson(paths.vectorIndexFile, {
      generatedAt: nowIso(),
      provider: config.embeddingProvider,
      model: config.embeddingModel,
      dimension: 0,
      embeddingConfigSignature: getEmbeddingConfigSignature(config),
      disabled: true,
      chunkCount: chunks.length,
      vectors: [],
    });
  }

  const embeddingIndex = {
    generatedAt: nowIso(),
    enabled: Boolean(config.embeddingEnabled),
    provider: vectorIndex ? vectorIndex.provider : config.embeddingProvider,
    model: vectorIndex ? vectorIndex.model : config.embeddingModel,
    dimension: vectorIndex ? vectorIndex.dimension : 0,
    embeddingConfigSignature: vectorIndex ? vectorIndex.embeddingConfigSignature : getEmbeddingConfigSignature(config),
    status: config.embeddingEnabled ? 'built' : 'disabled',
    vectors: vectorIndex ? vectorIndex.vectors.length : 0,
    vectorIndexFile: paths.vectorIndexFile,
  };
  writeJson(paths.embeddingIndexFile, embeddingIndex);

  const chunkHash = hashString(chunks.map((chunk) => chunk.textHash).join('|'));
  const nextState = {
    ...state,
    lastIndexAt: nowTs(),
    lastChunkHash: chunkHash,
    lastIndexConfigSignature: getIndexConfigSignature(config),
  };
  if (state.lastChunkHash !== chunkHash) {
    nextState.kbVersion = bumpVersion(state.kbVersion);
  }
  saveState(paths, nextState);

  return {
    message: 'Index completed',
    warnings: [],
    data: {
      chunkCount: chunks.length,
      docCount: docs.length,
      kbVersion: nextState.kbVersion,
      lexicalIndexFile: paths.lexicalIndexFile,
      lexicalPostingsFile: paths.lexicalPostingsFile,
      chunkStoreFile: paths.chunkStoreFile,
      searchBackend: 'portable-lexical',
      sqliteFts: sqliteIndex,
      sqliteIndexFile: sqliteIndex.available ? paths.sqliteIndexFile : '',
      vectorIndexFile: paths.vectorIndexFile,
      embeddingIndexFile: paths.embeddingIndexFile,
    },
    metrics: {
      elapsedMs: nowTs() - startedAt,
    },
  };
}

function scoreChunks(question, chunks, alpha) {
  const queryTokens = tokenize(question);
  const querySet = [...new Set(queryTokens)];
  const docFreq = new Map();
  const chunkTokenMaps = [];

  for (const chunk of chunks) {
    const tokenMap = toFrequencyMap(tokenize(chunk.text));
    chunkTokenMaps.push(tokenMap);
    for (const token of new Set(tokenMap.keys())) {
      docFreq.set(token, (docFreq.get(token) || 0) + 1);
    }
  }

  const totalDocs = Math.max(1, chunks.length);
  const scored = chunks.map((chunk, idx) => {
    const tokenMap = chunkTokenMaps[idx];
    let rawLexical = 0;
    for (const token of querySet) {
      const tf = tokenMap.get(token) || 0;
      if (!tf) continue;
      const idf = Math.log((totalDocs + 1) / ((docFreq.get(token) || 0) + 1)) + 1;
      rawLexical += (1 + Math.log(tf)) * idf;
    }

    return {
      chunk,
      lexicalRaw: rawLexical,
      phraseRaw: phraseScore(question, chunk.text),
      vectorRaw: 0,
      score: 0,
    };
  });

  const maxLex = Math.max(1e-9, ...scored.map((item) => item.lexicalRaw));
  const maxPhrase = Math.max(1e-9, ...scored.map((item) => item.phraseRaw));
  for (const row of scored) {
    const lexicalNorm = normalizedPositive(row.lexicalRaw, maxLex);
    const phraseNorm = normalizedPositive(row.phraseRaw, maxPhrase);
    const vectorNorm = 0;
    row.score = (alpha * lexicalNorm) + ((1 - alpha) * vectorNorm) + (DEFAULT_PHRASE_WEIGHT * phraseNorm);
  }

  scored.sort((a, b) => b.score - a.score);
  return scored;
}

function scorePortableChunks(question, lexicalIndex, chunkStore, alpha) {
  const queryTokens = tokenize(question);
  const querySet = [...new Set(queryTokens)];
  const indexChunks = chunkStore && typeof chunkStore.chunks === 'object' ? chunkStore.chunks : {};
  const postings = lexicalIndex && typeof lexicalIndex.postings === 'object' ? lexicalIndex.postings : {};
  const docFreq = lexicalIndex && typeof lexicalIndex.docFreq === 'object' ? lexicalIndex.docFreq : {};
  const totalDocs = Math.max(1, Number(lexicalIndex?.chunkCount) || Object.keys(indexChunks).length);
  const rawByChunkId = new Map();

  for (const token of querySet) {
    const rows = Array.isArray(postings[token]) ? postings[token] : [];
    const idf = Math.log((totalDocs + 1) / ((Number(docFreq[token]) || 0) + 1)) + 1;
    for (const row of rows) {
      const chunkId = safeTrim(row?.chunkId);
      const tf = Number(row?.tf) || 0;
      if (!chunkId || !tf) continue;
      rawByChunkId.set(chunkId, (rawByChunkId.get(chunkId) || 0) + ((1 + Math.log(tf)) * idf));
    }
  }

  const scored = [...rawByChunkId.entries()].map(([chunkId, lexicalRaw]) => {
    const chunk = indexChunks[chunkId];
    return {
      chunk,
      lexicalRaw,
      phraseRaw: phraseScore(question, chunk?.text || chunk?.snippet || ''),
      vectorRaw: 0,
      score: 0,
    };
  }).filter((row) => row.chunk);

  const maxLex = Math.max(1e-9, ...scored.map((row) => row.lexicalRaw));
  const maxPhrase = Math.max(1e-9, ...scored.map((row) => row.phraseRaw));
  for (const row of scored) {
    const lexicalNorm = normalizedPositive(row.lexicalRaw, maxLex);
    const phraseNorm = normalizedPositive(row.phraseRaw, maxPhrase);
    row.score = (alpha * lexicalNorm) + (DEFAULT_PHRASE_WEIGHT * phraseNorm);
  }

  scored.sort((a, b) => b.score - a.score);
  return scored;
}

function scoreVectorChunks(question, vectorIndex, config) {
  if (!vectorIndex || typeof vectorIndex !== 'object') {
    throw new SkillError('query_no_evidence', 'No vector index found. Run ingest + index first.');
  }
  const rows = Array.isArray(vectorIndex.vectors) ? vectorIndex.vectors : [];
  const dimension = Number(vectorIndex.dimension) || 0;
  if (dimension <= 0 || rows.length === 0) {
    throw new SkillError('query_no_evidence', 'Vector index is empty. Run ingest + index first.');
  }
  const expectedProvider = safeTrim(vectorIndex.provider);
  const expectedModel = safeTrim(vectorIndex.model);
  const expectedSignature = safeTrim(vectorIndex.embeddingConfigSignature);
  const currentSignature = getEmbeddingConfigSignature(config);
  if (!expectedSignature || expectedSignature !== currentSignature) {
    throw new SkillError(
      'embedding_failed',
      'Vector index embedding configuration is stale or missing a signature. Re-run index.'
    );
  }
  if (expectedProvider && expectedProvider !== config.embeddingProvider) {
    throw new SkillError(
      'embedding_failed',
      `Vector index provider ${expectedProvider} does not match configured provider ${config.embeddingProvider}. Re-run index.`
    );
  }
  if (expectedModel && expectedModel !== config.embeddingModel && config.embeddingProvider !== 'local-hashing-v1') {
    throw new SkillError(
      'embedding_failed',
      `Vector index model ${expectedModel} does not match configured model ${config.embeddingModel}. Re-run index.`
    );
  }

  const embedded = embedTexts(
    {
      ...config,
      embeddingProvider: expectedProvider || config.embeddingProvider,
      embeddingModel: expectedModel || config.embeddingModel,
    },
    [question]
  );
  if (embedded.dimension !== dimension) {
    throw new SkillError(
      'embedding_failed',
      `Query embedding dimension ${embedded.dimension} does not match vector index dimension ${dimension}. Re-run index.`
    );
  }
  const queryVector = embedded.vectors[0];
  const scored = rows.map((row) => {
    const chunk = {
      docId: row.docId,
      docTitle: row.docTitle,
      sourcePath: row.sourcePath,
      chunkId: row.chunkId,
      text: row.text || row.snippet || '',
      startOffset: row.startOffset,
      endOffset: row.endOffset,
      updatedAt: row.updatedAt,
    };
    const vector = normalizeVector(row.vector, dimension);
    const vectorRaw = cosineSimilarity(queryVector, vector);
    return {
      chunk,
      lexicalRaw: 0,
      vectorRaw,
      score: Math.max(0, vectorRaw),
    };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

function escapeSqliteFtsPhrase(value) {
  return safeTrim(value).replace(/"/g, '""');
}

function buildSqliteFtsQueries(question) {
  const cleaned = cleanText(question)
    .replace(/[^\p{L}\p{N}_\u4e00-\u9fff]+/gu, ' ')
    .trim();
  const queries = [];
  if (cleaned.length >= 3) {
    queries.push(`"${escapeSqliteFtsPhrase(cleaned)}"`);
  }

  const tokenQueries = [...new Set(tokenize(question)
    .filter((token) => token.length >= 3)
    .map((token) => `"${escapeSqliteFtsPhrase(token)}"`))];
  if (tokenQueries.length > 0) {
    queries.push(tokenQueries.join(' OR '));
  }

  const cjkQuery = (safeTrim(question).match(/[\u4e00-\u9fff]/g) || []).join('');
  if (cjkQuery.length >= 3) {
    queries.push(`"${escapeSqliteFtsPhrase(cjkQuery)}"`);
  }

  return [...new Set(queries)].filter(Boolean);
}

function scoreSqliteFtsChunks(question, paths, limit = 512) {
  const sqlite = loadSqliteModule();
  if (!sqlite || !sqlite.DatabaseSync || !fs.existsSync(paths.sqliteIndexFile)) {
    throw new SkillError('query_no_evidence', 'No SQLite FTS index found. Run ingest + index first.');
  }

  const queries = buildSqliteFtsQueries(question);
  if (queries.length === 0) return [];

  let db = null;
  try {
    db = new sqlite.DatabaseSync(paths.sqliteIndexFile, { readOnly: true });
    const statement = db.prepare(`
      SELECT
        chunkId,
        docId,
        sourcePath,
        docTitle,
        text,
        snippet,
        startOffset,
        endOffset,
        updatedAt,
        bm25(chunks_fts) AS rank
      FROM chunks_fts
      WHERE chunks_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `);

    let rows = [];
    for (const query of queries) {
      try {
        rows = statement.all(query, limit);
      } catch {
        rows = [];
      }
      if (rows.length > 0) break;
    }

    const scored = rows.map((row, idx) => {
      const lexicalRaw = Math.max(0, -Number(row.rank || 0)) || (1 / (idx + 1));
      const chunk = {
        docId: row.docId,
        docTitle: row.docTitle,
        sourcePath: row.sourcePath,
        chunkId: row.chunkId,
        text: row.text || row.snippet || '',
        startOffset: Number(row.startOffset) || 0,
        endOffset: Number(row.endOffset) || 0,
        updatedAt: Number(row.updatedAt) || 0,
      };
      return {
        chunk,
        lexicalRaw,
        phraseRaw: phraseScore(question, chunk.text),
        vectorRaw: 0,
        score: 0,
      };
    });

    const maxLex = Math.max(1e-9, ...scored.map((row) => row.lexicalRaw));
    const maxPhrase = Math.max(1e-9, ...scored.map((row) => row.phraseRaw));
    for (const row of scored) {
      row.score = (
        normalizedPositive(row.lexicalRaw, maxLex) +
        (DEFAULT_PHRASE_WEIGHT * normalizedPositive(row.phraseRaw, maxPhrase))
      );
    }

    scored.sort((a, b) => b.score - a.score);
    return scored;
  } finally {
    if (db) {
      try {
        db.close();
      } catch {
        // ignore close errors on a read-only optional backend
      }
    }
  }
}

function scoreHybridChunks(question, lexicalIndex, chunkStore, vectorIndex, config) {
  const lexicalRows = scorePortableChunks(question, lexicalIndex, chunkStore, 1);
  const vectorRows = scoreVectorChunks(question, vectorIndex, config);
  const byChunkId = new Map();

  for (const row of lexicalRows) {
    if (!row.chunk?.chunkId) continue;
    byChunkId.set(row.chunk.chunkId, {
      chunk: row.chunk,
      lexicalRaw: row.lexicalRaw || 0,
      phraseRaw: row.phraseRaw || phraseScore(question, row.chunk.text || row.chunk.snippet || ''),
      vectorRaw: 0,
      score: 0,
    });
  }

  for (const row of vectorRows) {
    if (!row.chunk?.chunkId) continue;
    const existing = byChunkId.get(row.chunk.chunkId) || {
      chunk: row.chunk,
      lexicalRaw: 0,
      phraseRaw: phraseScore(question, row.chunk.text || row.chunk.snippet || ''),
      vectorRaw: 0,
      score: 0,
    };
    existing.vectorRaw = Math.max(existing.vectorRaw || 0, row.vectorRaw || 0);
    byChunkId.set(row.chunk.chunkId, existing);
  }

  const rows = [...byChunkId.values()];
  const maxLex = Math.max(1e-9, ...rows.map((row) => row.lexicalRaw));
  const maxVector = Math.max(1e-9, ...rows.map((row) => Math.max(0, row.vectorRaw)));
  const maxPhrase = Math.max(1e-9, ...rows.map((row) => row.phraseRaw));
  const lexicalWeight = Number(config.lexicalWeight) || DEFAULT_LEXICAL_WEIGHT;
  const vectorWeight = Number(config.vectorWeight) || DEFAULT_VECTOR_WEIGHT;
  const phraseWeight = Number(config.phraseWeight) || DEFAULT_PHRASE_WEIGHT;
  const totalWeight = Math.max(1e-9, lexicalWeight + vectorWeight + phraseWeight);

  for (const row of rows) {
    row.score = (
      (lexicalWeight * normalizedPositive(row.lexicalRaw, maxLex)) +
      (vectorWeight * normalizedPositive(row.vectorRaw, maxVector)) +
      (phraseWeight * normalizedPositive(row.phraseRaw, maxPhrase))
    ) / totalWeight;
  }

  rows.sort((a, b) => b.score - a.score);
  return {
    rows,
    lexicalCandidates: lexicalRows.length,
    vectorCandidates: vectorRows.length,
    vectorProvider: safeTrim(vectorIndex.provider) || config.embeddingProvider,
  };
}

function resolveQuerySearchBackend(requested, config, paths) {
  const wanted = normalizeSearchBackend(requested)
    || normalizeSearchBackend(config.searchBackend)
    || 'auto';
  const hasPortableIndex = portableIndexFilesExist(paths);
  const hasVectorIndex = vectorIndexFileExists(paths);
  const hasSqliteIndex = sqliteIndexFileExists(paths) && sqliteFtsAvailable();

  if (wanted === 'disabled' || wanted === 'none' || wanted === 'scan' || wanted === 'chunk-scan') {
    return 'chunk-scan';
  }
  if (wanted === 'vector') {
    return 'vector';
  }
  if (wanted === 'hybrid') {
    if (hasPortableIndex && hasVectorIndex) return 'hybrid';
    if (hasVectorIndex) return 'vector';
    if (hasPortableIndex) return 'portable-lexical';
  }
  if (wanted === 'sqlite' || wanted === 'sqlite-fts') {
    if (hasSqliteIndex) return 'sqlite-fts';
    if (hasPortableIndex) return 'portable-lexical';
  }
  if (wanted === 'auto') {
    if (hasPortableIndex && hasVectorIndex) return 'hybrid';
    if (hasSqliteIndex) return 'sqlite-fts';
  }
  if ((wanted === 'auto' || wanted === 'portable' || wanted === 'portable-lexical') && hasPortableIndex) {
    return 'portable-lexical';
  }
  return 'chunk-scan';
}

function actionQuery(input, paths) {
  const startedAt = nowTs();
  const question = safeTrim(input.payload.question);
  if (!question) {
    throw new SkillError('invalid_payload', 'query.payload.question is required.');
  }

  const config = loadConfig(paths);
  const searchBackend = resolveQuerySearchBackend(
    input.payload.searchBackend,
    config,
    paths
  );
  let totalChunks = 0;
  let scored = [];
  let vectorProvider = '';
  let vectorCandidates = 0;
  let lexicalCandidates = 0;

  const topKRaw = Number(input.payload.topK);
  const minScoreRaw = Number(input.payload.minScore);
  const hybridAlphaRaw = Number(input.payload.hybridAlpha);
  const topK = Number.isFinite(topKRaw) && topKRaw > 0 ? Math.floor(topKRaw) : DEFAULT_TOP_K;
  const minScore = Number.isFinite(minScoreRaw) ? minScoreRaw : DEFAULT_MIN_SCORE;
  const hybridAlpha = Number.isFinite(hybridAlphaRaw) ? hybridAlphaRaw : DEFAULT_HYBRID_ALPHA;
  const requireCitations = input.payload.requireCitations !== false;

  if (searchBackend === 'vector') {
    const vectorIndex = readJson(paths.vectorIndexFile, null);
    totalChunks = Math.max(0, Number(vectorIndex?.chunkCount) || (Array.isArray(vectorIndex?.vectors) ? vectorIndex.vectors.length : 0));
    scored = scoreVectorChunks(question, vectorIndex, config);
    vectorProvider = safeTrim(vectorIndex?.provider) || config.embeddingProvider;
    vectorCandidates = scored.length;
  } else if (searchBackend === 'hybrid') {
    const lexicalIndex = readJson(paths.lexicalPostingsFile, null);
    const chunkStore = readJson(paths.chunkStoreFile, null);
    const vectorIndex = readJson(paths.vectorIndexFile, null);
    totalChunks = Math.max(
      0,
      Number(lexicalIndex?.chunkCount) || 0,
      Number(chunkStore?.chunkCount) || 0,
      Number(vectorIndex?.chunkCount) || 0,
      Array.isArray(vectorIndex?.vectors) ? vectorIndex.vectors.length : 0
    );
    if (!lexicalIndex || !chunkStore || totalChunks === 0) {
      throw new SkillError('query_no_evidence', 'No portable lexical index found. Run ingest + index first.');
    }
    const hybrid = scoreHybridChunks(question, lexicalIndex, chunkStore, vectorIndex, config);
    scored = hybrid.rows;
    lexicalCandidates = hybrid.lexicalCandidates;
    vectorCandidates = hybrid.vectorCandidates;
    vectorProvider = hybrid.vectorProvider;
  } else if (searchBackend === 'sqlite-fts') {
    const lexicalIndex = readJson(paths.lexicalIndexFile, null);
    totalChunks = Math.max(0, Number(lexicalIndex?.chunkCount) || 0);
    scored = scoreSqliteFtsChunks(question, paths);
    lexicalCandidates = scored.length;
  } else if (searchBackend === 'portable-lexical') {
    const lexicalIndex = readJson(paths.lexicalPostingsFile, null);
    const chunkStore = readJson(paths.chunkStoreFile, null);
    totalChunks = Math.max(
      0,
      Number(lexicalIndex?.chunkCount) || 0,
      Number(chunkStore?.chunkCount) || 0
    );
    if (!lexicalIndex || !chunkStore || totalChunks === 0) {
      throw new SkillError('query_no_evidence', 'No portable lexical index found. Run ingest + index first.');
    }
    scored = scorePortableChunks(question, lexicalIndex, chunkStore, hybridAlpha);
    lexicalCandidates = scored.length;
  } else {
    const chunks = readJsonl(paths.chunksFile);
    totalChunks = chunks.length;
    if (chunks.length === 0) {
      throw new SkillError('query_no_evidence', 'No chunks indexed. Run ingest + index first.');
    }
    scored = scoreChunks(question, chunks, hybridAlpha);
    lexicalCandidates = scored.length;
  }

  const selected = scored.filter((row) => row.score >= minScore).slice(0, topK);
  const citations = selected.map((row) => ({
    docId: row.chunk.docId,
    docTitle: row.chunk.docTitle,
    sourcePath: row.chunk.sourcePath,
    chunkId: row.chunk.chunkId,
    snippet: buildCitationSnippet(row.chunk.text),
    startOffset: row.chunk.startOffset,
    endOffset: row.chunk.endOffset,
    score: Number(row.score.toFixed(6)),
    updatedAt: row.chunk.updatedAt,
  }));

  const insufficient = citations.length === 0 || (requireCitations && citations.length === 0);
  const answer = insufficient
    ? '当前知识库证据不足，无法给出可靠结论。请补充相关文档后再试。'
    : summarizeCitations(citations);
  const confidence = insufficient ? 0 : Number((citations[0].score || 0).toFixed(4));

  return {
    message: insufficient ? 'Query completed with insufficient evidence' : 'Query completed',
    data: {
      answer,
      insufficient,
      reason: insufficient ? 'No chunk passed minScore threshold.' : '',
      confidence,
      citations,
      query: {
        question,
        topK,
        minScore,
        hybridAlpha,
        lexicalWeight: config.lexicalWeight,
        vectorWeight: config.vectorWeight,
        phraseWeight: config.phraseWeight,
        requireCitations,
        searchBackend,
        vectorProvider,
      },
    },
    metrics: {
      elapsedMs: nowTs() - startedAt,
      candidateChunks: scored.length,
      totalChunks,
      matchedChunks: citations.length,
      lexicalCandidates,
      vectorCandidates,
    },
  };
}

function buildWikiHtml(siteTitle) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${siteTitle}</title>
  <link rel="stylesheet" href="./assets/style.css" />
</head>
<body>
  <header class="topbar">
    <h1>${siteTitle}</h1>
    <input id="searchInput" placeholder="搜索文档标题或摘要..." />
  </header>
  <main>
    <section id="meta"></section>
    <section id="list" class="article-list"></section>
  </main>
  <script src="./assets/app.js"></script>
</body>
</html>
`;
}

function buildWikiCss() {
  return `:root {
  --bg: #f4f4f0;
  --fg: #1f2328;
  --muted: #5f6a77;
  --card: #ffffff;
  --line: #d9dde3;
  --accent: #184a8b;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  font-family: "Source Han Sans SC","Noto Sans SC","Segoe UI",sans-serif;
  color: var(--fg);
  background: radial-gradient(circle at top right, #e8efe0 0%, var(--bg) 60%);
}
.topbar {
  position: sticky;
  top: 0;
  z-index: 10;
  backdrop-filter: blur(8px);
  background: rgba(244, 244, 240, 0.92);
  border-bottom: 1px solid var(--line);
  padding: 12px 16px;
  display: flex;
  gap: 12px;
  align-items: center;
}
h1 {
  margin: 0;
  font-size: 18px;
  font-weight: 700;
}
#searchInput {
  flex: 1;
  min-width: 160px;
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 10px 12px;
  font-size: 14px;
}
main { padding: 16px; }
#meta {
  color: var(--muted);
  margin-bottom: 12px;
  font-size: 13px;
}
.article-list {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 12px;
}
.card {
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 14px;
  padding: 12px;
}
.card h3 {
  margin: 0 0 8px;
  font-size: 15px;
  line-height: 1.4;
}
.meta {
  color: var(--muted);
  font-size: 12px;
  margin-bottom: 8px;
}
.snippet {
  font-size: 13px;
  line-height: 1.6;
}
a.path {
  color: var(--accent);
  text-decoration: none;
}
`;
}

function buildWikiJs() {
  return `async function loadJson(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error('Failed to load ' + path);
  return response.json();
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderList(listEl, rows) {
  listEl.innerHTML = rows.map((row) => {
    return '<article class="card">'
      + '<h3>' + escapeHtml(row.title) + '</h3>'
      + '<div class="meta"><a class="path" href="#" onclick="return false;">' + escapeHtml(row.sourcePath) + '</a></div>'
      + '<div class="snippet">' + escapeHtml(row.summary || '') + '</div>'
      + '</article>';
  }).join('');
}

function normalize(value) {
  return String(value || '').toLowerCase();
}

function filterRows(rows, keyword) {
  const key = normalize(keyword).trim();
  if (!key) return rows;
  return rows.filter((row) => {
    return normalize(row.title).includes(key)
      || normalize(row.summary).includes(key)
      || normalize(row.sourcePath).includes(key);
  });
}

async function main() {
  const metaEl = document.getElementById('meta');
  const listEl = document.getElementById('list');
  const searchInput = document.getElementById('searchInput');
  const [meta, articles] = await Promise.all([
    loadJson('./data/meta.json'),
    loadJson('./data/articles.json'),
  ]);

  metaEl.textContent = 'KB: ' + (meta.kbId || '-') + ' | 版本: ' + (meta.kbVersion || '-') + ' | 文档数: ' + (articles.length || 0);
  renderList(listEl, articles);

  searchInput.addEventListener('input', () => {
    const filtered = filterRows(articles, searchInput.value);
    renderList(listEl, filtered);
  });
}

main().catch((error) => {
  const metaEl = document.getElementById('meta');
  if (metaEl) metaEl.textContent = '加载失败: ' + (error && error.message ? error.message : String(error));
});
`;
}

function getDirFileEntries(rootDir) {
  const files = [];
  const walk = (currentDir) => {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
      } else if (entry.isFile()) {
        files.push(abs);
      }
    }
  };
  walk(rootDir);
  files.sort((a, b) => a.localeCompare(b));
  return files;
}

function hashDirectory(rootDir) {
  const files = getDirFileEntries(rootDir);
  const digestInput = files.map((abs) => {
    const rel = toPosixRelative(rootDir, abs);
    const sha = hashFile(abs);
    return `${rel}:${sha}`;
  }).join('\n');
  return hashString(digestInput);
}

function actionWikiBuild(input, paths, state) {
  ensureKbStructure(paths);
  const startedAt = nowTs();
  const docs = readJsonl(paths.docsFile);
  if (!docs.length) {
    throw new SkillError('wiki_build_failed', 'No documents found. Run ingest first.');
  }

  const siteTitle = safeTrim(input.payload.siteTitle) || `LLM Wiki - ${input.kbId}`;
  const articles = docs
    .map((doc) => ({
      id: doc.docId,
      title: doc.title,
      sourcePath: doc.sourcePath,
      updatedAt: doc.updatedAt,
      summary: buildCitationSnippet(doc.text, 320),
    }))
    .sort((a, b) => String(a.title).localeCompare(String(b.title)));

  ensureDir(paths.wikiSiteDir);
  ensureDir(path.join(paths.wikiSiteDir, 'assets'));
  ensureDir(path.join(paths.wikiSiteDir, 'data'));

  fs.writeFileSync(path.join(paths.wikiSiteDir, 'index.html'), buildWikiHtml(siteTitle), 'utf8');
  fs.writeFileSync(path.join(paths.wikiSiteDir, 'assets', 'style.css'), buildWikiCss(), 'utf8');
  fs.writeFileSync(path.join(paths.wikiSiteDir, 'assets', 'app.js'), buildWikiJs(), 'utf8');

  writeJson(path.join(paths.wikiSiteDir, 'data', 'articles.json'), articles);
  writeJson(path.join(paths.wikiSiteDir, 'data', 'meta.json'), {
    kbId: input.kbId,
    kbVersion: state.kbVersion || 'v0',
    generatedAt: nowIso(),
    articleCount: articles.length,
  });

  const siteSha256 = hashDirectory(paths.wikiSiteDir);
  const nextState = {
    ...state,
    lastWikiBuildAt: nowTs(),
    lastSiteSha256: siteSha256,
  };
  saveState(paths, nextState);

  return {
    message: 'Static wiki site generated',
    data: {
      siteDir: paths.wikiSiteDir,
      entrypoint: path.join(paths.wikiSiteDir, 'index.html'),
      articleCount: articles.length,
      siteSha256,
      kbVersion: nextState.kbVersion,
    },
    metrics: {
      elapsedMs: nowTs() - startedAt,
    },
  };
}

function zipDeterministic(input) {
  return new Promise((resolve, reject) => {
    let yazl;
    try {
      yazl = require('yazl');
    } catch {
      reject(new SkillError(
        'dependency_missing',
        'Missing optional dependency "yazl" for bundle_zip. ingest/index/query work without it; install or bundle yazl to create ZIP archives.'
      ));
      return;
    }
    const zipFile = new yazl.ZipFile();
    const output = fs.createWriteStream(input.outPath);
    let settled = false;

    const done = (error) => {
      if (settled) return;
      settled = true;
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };

    output.on('close', () => done(null));
    output.on('error', (err) => done(err));
    zipFile.outputStream.pipe(output);

    const stableMtime = new Date(0);
    for (const file of input.files) {
      zipFile.addFile(file.absPath, file.zipPath, {
        mtime: stableMtime,
        mode: 0o100644,
      });
    }
    if (input.bundleManifestBuffer) {
      zipFile.addBuffer(input.bundleManifestBuffer, 'bundle-manifest.json', {
        mtime: stableMtime,
        mode: 0o100644,
      });
    }
    zipFile.end();
  });
}

async function actionBundleZip(input, paths, state) {
  ensureKbStructure(paths);
  const startedAt = nowTs();

  const siteDir = safeTrim(input.payload.siteDir)
    ? path.resolve(input.payload.siteDir)
    : paths.wikiSiteDir;
  if (!fs.existsSync(siteDir)) {
    throw new SkillError('wiki_build_failed', `Site directory not found: ${siteDir}`);
  }
  const siteIndex = path.join(siteDir, 'index.html');
  if (!fs.existsSync(siteIndex)) {
    throw new SkillError('wiki_build_failed', `Entrypoint not found: ${siteIndex}`);
  }

  const filesAbs = getDirFileEntries(siteDir);
  const fileEntries = filesAbs.map((absPath) => {
    const rel = toPosixRelative(siteDir, absPath);
    return {
      absPath,
      relPath: rel,
      zipPath: `site/${rel}`,
      sha256: hashFile(absPath),
      size: fs.statSync(absPath).size,
    };
  });

  const version = state.kbVersion || 'v0';
  const zipName = safeTrim(input.payload.zipName) || `${input.kbId}-${version}-wiki.zip`;
  const zipPath = path.join(paths.manifestsDir, zipName);

  const bundleManifest = {
    kbId: input.kbId,
    version,
    generatedAt: nowIso(),
    entrypoint: 'site/index.html',
    fileCount: fileEntries.length,
    files: fileEntries.map((entry) => ({
      path: entry.zipPath,
      size: entry.size,
      sha256: entry.sha256,
    })),
  };

  ensureDir(path.dirname(zipPath));
  await zipDeterministic({
    outPath: zipPath,
    files: fileEntries,
    bundleManifestBuffer: Buffer.from(JSON.stringify(bundleManifest, null, 2), 'utf8'),
  });

  const zipSha256 = hashFile(zipPath);
  const zipSize = fs.statSync(zipPath).size;

  const nextState = {
    ...state,
    latestZipPath: zipPath,
    latestZipSha256: zipSha256,
  };
  saveState(paths, nextState);

  return {
    message: 'Wiki ZIP bundle created',
    data: {
      zipPath,
      zipSha256,
      zipSize,
      entrypoint: 'site/index.html',
      kbVersion: version,
      fileCount: fileEntries.length,
      bundleManifestPath: path.join(paths.manifestsDir, 'bundle-manifest.json'),
      bundleManifest,
    },
    metrics: {
      elapsedMs: nowTs() - startedAt,
    },
  };
}

function findUploadSkillScript() {
  const roots = [];
  const skillsRoot = safeTrim(process.env.SKILLS_ROOT) || safeTrim(process.env.IDBOTS_SKILLS_ROOT);
  if (skillsRoot) roots.push(path.resolve(skillsRoot));
  roots.push(path.resolve(process.cwd()));
  roots.push(path.resolve(process.cwd(), '..'));

  for (const root of roots) {
    const candidate = path.join(root, 'metabot-upload-largefile', 'scripts', 'upload-largefile.js');
    if (fs.existsSync(candidate)) return candidate;
    const candidate2 = path.join(root, 'SKILLs', 'metabot-upload-largefile', 'scripts', 'upload-largefile.js');
    if (fs.existsSync(candidate2)) return candidate2;
  }
  return null;
}

function parseLastJsonLine(stdoutText) {
  const lines = String(stdoutText || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i]);
    } catch {
      // continue
    }
  }
  return null;
}

function actionPublishZip(input, paths, state) {
  ensureKbStructure(paths);
  const startedAt = nowTs();
  const pinUriInput = safeTrim(input.payload.pinUri) || safeTrim(input.payload.zipUri);
  const uploadZipFlag = parseOptionalBooleanFlag(input.payload.uploadZip, 'payload.uploadZip');
  const payloadZipPath = safeTrim(input.payload.zipPath)
    ? path.resolve(input.payload.zipPath)
    : '';
  const stateZipPath = safeTrim(state.latestZipPath)
    ? path.resolve(state.latestZipPath)
    : '';
  const shouldUpload = uploadZipFlag !== undefined ? uploadZipFlag : !pinUriInput;
  const zipPath = payloadZipPath
    ? payloadZipPath
    : shouldUpload
      ? stateZipPath
      : '';

  if (!shouldUpload && !pinUriInput) {
    throw new SkillError('invalid_payload', 'uploadZip=false requires payload.pinUri or payload.zipUri.');
  }
  if (shouldUpload && (!zipPath || !fs.existsSync(zipPath))) {
    throw new SkillError('invalid_payload', 'zipPath is required. Run bundle_zip first.');
  }

  let zipUri = pinUriInput;
  let uploadResult = null;

  if (shouldUpload) {
    const uploadScript = findUploadSkillScript();
    if (!uploadScript) {
      throw new SkillError(
        'dependency_missing',
        'metabot-upload-largefile skill not found. Provide payload.pinUri/payload.zipUri or install metabot-upload-largefile.'
      );
    }
    const result = spawnSync(
      process.execPath,
      [uploadScript, '--file', zipPath, '--content-type', 'application/zip', '--network', safeTrim(input.payload.network) || 'mvc'],
      { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }
    );
    if (result.status !== 0) {
      const errorDetail = safeTrim(result.stderr) || safeTrim(result.stdout) || 'Upload script failed';
      throw new SkillError('publish_failed', errorDetail, true);
    }
    uploadResult = parseLastJsonLine(result.stdout);
    if (!uploadResult || !uploadResult.success || !safeTrim(uploadResult.pinId)) {
      throw new SkillError('publish_failed', 'Upload script did not return valid pinId.', true);
    }
    zipUri = `metafile://${safeTrim(uploadResult.pinId)}`;
  }

  const nextState = {
    ...state,
    latestZipPath: zipPath,
    latestZipUri: zipUri,
    latestZipSha256: zipPath && fs.existsSync(zipPath)
      ? hashFile(zipPath)
      : safeTrim(input.payload.zipSha256),
  };
  saveState(paths, nextState);

  return {
    message: 'ZIP published',
    data: {
      zipPath,
      zipUri,
      zipSha256: nextState.latestZipSha256,
      uploadResult,
      publishMode: {
        uploadZip: shouldUpload,
        source: shouldUpload ? 'upload' : 'provided_uri',
        explicitUploadZip: uploadZipFlag !== undefined,
      },
    },
    metrics: {
      elapsedMs: nowTs() - startedAt,
    },
  };
}

async function createMetaidPin(input) {
  const rpcBase = safeTrim(process.env.IDBOTS_RPC_URL) || 'http://127.0.0.1:31200';
  const metabotIdRaw = safeTrim(process.env.IDBOTS_METABOT_ID);
  if (!metabotIdRaw) {
    throw new SkillError('invalid_payload', 'IDBOTS_METABOT_ID env is required for snapshotOnChain/publishOnChain.');
  }
  const metabotId = Number(metabotIdRaw);
  if (!Number.isFinite(metabotId) || metabotId <= 0) {
    throw new SkillError('invalid_payload', 'IDBOTS_METABOT_ID must be a positive integer.');
  }

  const url = `${rpcBase.replace(/\/+$/, '')}/api/metaid/create-pin`;
  const requestBody = {
    metabot_id: metabotId,
    network: safeTrim(input.network) || 'mvc',
    metaidData: {
      operation: 'create',
      path: safeTrim(input.path) || DEFAULT_WIKI_SNAPSHOT_PATH,
      encryption: '0',
      version: '1.0.0',
      contentType: 'application/json',
      payload: JSON.stringify(input.payload),
    },
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
  });
  const rawText = await response.text();
  if (!response.ok) {
    throw new SkillError('publish_failed', `RPC ${response.status}: ${rawText}`, true);
  }
  let parsed = null;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    parsed = null;
  }
  if (parsed && parsed.success === false) {
    throw new SkillError('publish_failed', safeTrim(parsed.error) || 'RPC request failed', true);
  }
  const txid = parsed && parsed.txid ? safeTrim(parsed.txid) : (Array.isArray(parsed?.txids) ? safeTrim(parsed.txids[0]) : '');
  const pinId = parsed && parsed.pinId ? safeTrim(parsed.pinId) : (txid ? `${txid}i0` : '');
  return { pinId, txid, raw: parsed || rawText };
}

async function actionPublishSnapshot(input, paths, state) {
  ensureKbStructure(paths);
  const startedAt = nowTs();
  const snapshotOnChainMode = resolveSnapshotOnChainMode(input.payload);

  const payloadZipPath = safeTrim(input.payload.zipPath)
    ? path.resolve(input.payload.zipPath)
    : '';
  if (payloadZipPath && !fs.existsSync(payloadZipPath)) {
    throw new SkillError('invalid_payload', `payload.zipPath does not exist: ${payloadZipPath}`);
  }
  const zipPath = payloadZipPath
    ? payloadZipPath
    : safeTrim(state.latestZipPath)
      ? path.resolve(state.latestZipPath)
      : '';

  let zipUri = '';
  let zipUriSource = '';
  const zipUriInput = safeTrim(input.payload.zipUri) || safeTrim(input.payload.pinUri);
  if (zipUriInput) {
    zipUri = zipUriInput;
    zipUriSource = 'payload';
  } else if (payloadZipPath) {
    zipUri = `file://${normalizeSlashes(payloadZipPath)}`;
    zipUriSource = 'local_file';
  } else {
    const stateZipUri = safeTrim(state.latestZipUri);
    if (stateZipUri) {
      zipUri = stateZipUri;
      zipUriSource = 'state';
    } else if (zipPath) {
      zipUri = `file://${normalizeSlashes(zipPath)}`;
      zipUriSource = 'local_file';
    }
  }

  if (!zipUri) {
    throw new SkillError('invalid_payload', 'zipUri is required. Run publish_zip first or pass payload.zipUri.');
  }
  if (snapshotOnChainMode.enabled && zipUri.startsWith('file://')) {
    throw new SkillError(
      'invalid_payload',
      'snapshotOnChain=true requires a public zipUri. Set uploadZip=true or provide payload.zipUri.'
    );
  }

  let zipSha256 = safeTrim(input.payload.zipSha256);
  if (!zipSha256 && payloadZipPath && fs.existsSync(payloadZipPath)) {
    zipSha256 = hashFile(payloadZipPath);
  }
  if (!zipSha256 && !zipUriInput) {
    zipSha256 = zipPath && fs.existsSync(zipPath) ? hashFile(zipPath) : safeTrim(state.latestZipSha256);
  }
  const kbVersion = safeTrim(input.payload.kbVersion) || safeTrim(state.kbVersion) || 'v0';

  const snapshot = {
    kbId: input.kbId,
    version: kbVersion,
    zipUri,
    zipSha256,
    entrypoint: safeTrim(input.payload.entrypoint) || 'site/index.html',
    generatedAt: nowIso(),
    visibility: safeTrim(input.payload.visibility) || 'public',
  };

  const snapshotFileName = safeTrim(input.payload.snapshotFileName)
    || `${input.kbId}-${kbVersion}-snapshot-${nowTs()}.json`;
  const snapshotPath = path.join(paths.manifestsDir, snapshotFileName);
  writeJson(snapshotPath, snapshot);

  let chainResult = null;
  if (snapshotOnChainMode.enabled) {
    chainResult = await createMetaidPin({
      path: safeTrim(input.payload.path) || DEFAULT_WIKI_SNAPSHOT_PATH,
      payload: snapshot,
      network: safeTrim(input.payload.network) || 'mvc',
    });
  }

  return {
    message: chainResult ? 'Snapshot published on-chain' : 'Snapshot generated locally',
    data: {
      snapshotPath,
      snapshot,
      chain: chainResult,
      publishMode: {
        snapshotOnChain: snapshotOnChainMode.enabled,
        source: snapshotOnChainMode.source,
        zipUriSource,
      },
    },
    metrics: {
      elapsedMs: nowTs() - startedAt,
    },
  };
}

async function actionPublishAll(input, paths, state) {
  ensureKbStructure(paths);
  const startedAt = nowTs();
  const steps = {};
  const warnings = [];

  let currentState = state;
  const skipWikiBuild = input.payload.skipWikiBuild === true;
  const skipBundle = input.payload.skipBundle === true;
  const skipSnapshot = input.payload.skipSnapshot === true;
  const autoAbsorb = input.payload.autoAbsorb !== false;
  const uploadZipFlag = parseOptionalBooleanFlag(input.payload.uploadZip, 'payload.uploadZip');
  const snapshotOnChainMode = resolveSnapshotOnChainMode(input.payload);
  const requestedZipUri = safeTrim(input.payload.zipUri) || safeTrim(input.payload.pinUri);

  const existingDocs = readJsonl(paths.docsFile);
  const existingChunks = readJsonl(paths.chunksFile);
  if (autoAbsorb && (existingDocs.length === 0 || existingChunks.length === 0)) {
    const absorbResult = actionAbsorb({
      ...input,
      payload: {
        ...input.payload,
        runWikiDelta: false,
      },
    }, paths, currentState);
    steps.absorb = absorbResult.data;
    if (Array.isArray(absorbResult.warnings)) warnings.push(...absorbResult.warnings);
    currentState = loadState(paths, input.kbId);
  }

  if (!skipWikiBuild) {
    const wikiResult = actionWikiBuild(input, paths, currentState);
    steps.wiki_build = wikiResult.data;
    if (Array.isArray(wikiResult.warnings)) warnings.push(...wikiResult.warnings);
    currentState = loadState(paths, input.kbId);
  }

  let effectiveZipPath = safeTrim(input.payload.zipPath);
  const canReuseExternalZipUri = Boolean(requestedZipUri) && uploadZipFlag !== true;
  if (!canReuseExternalZipUri && !skipBundle && !effectiveZipPath) {
    const bundleResult = await actionBundleZip({
      ...input,
      payload: {
        ...input.payload,
        zipPath: undefined,
      },
    }, paths, currentState);
    steps.bundle_zip = bundleResult.data;
    if (Array.isArray(bundleResult.warnings)) warnings.push(...bundleResult.warnings);
    effectiveZipPath = safeTrim(bundleResult.data.zipPath);
    currentState = loadState(paths, input.kbId);
  }

  const shouldRunPublishZip = uploadZipFlag !== false || Boolean(requestedZipUri);
  let publishZipResult = null;
  if (shouldRunPublishZip) {
    publishZipResult = actionPublishZip({
      ...input,
      payload: {
        ...input.payload,
        zipPath: effectiveZipPath,
        pinUri: requestedZipUri || undefined,
        uploadZip: uploadZipFlag,
      },
    }, paths, currentState);
    steps.publish_zip = publishZipResult.data;
    if (Array.isArray(publishZipResult.warnings)) warnings.push(...publishZipResult.warnings);
    currentState = loadState(paths, input.kbId);
  } else {
    const localZipSha256 = effectiveZipPath && fs.existsSync(effectiveZipPath) ? hashFile(effectiveZipPath) : '';
    steps.publish_zip = {
      skipped: true,
      reason: 'uploadZip=false and no external zipUri provided; keeping ZIP local.',
      zipPath: effectiveZipPath,
      zipSha256: localZipSha256,
      publishMode: {
        uploadZip: false,
        source: 'local_only',
        explicitUploadZip: true,
      },
    };
  }

  if (!skipSnapshot) {
    const snapshotResult = await actionPublishSnapshot({
      ...input,
      payload: {
        ...input.payload,
        zipPath: publishZipResult ? publishZipResult.data.zipPath : effectiveZipPath,
        zipUri: publishZipResult ? publishZipResult.data.zipUri : (requestedZipUri || undefined),
        zipSha256: publishZipResult
          ? publishZipResult.data.zipSha256
          : (effectiveZipPath && fs.existsSync(effectiveZipPath) ? hashFile(effectiveZipPath) : undefined),
        snapshotOnChain: input.payload.snapshotOnChain,
        publishOnChain: input.payload.publishOnChain,
      },
    }, paths, currentState);
    steps.publish_snapshot = snapshotResult.data;
    if (Array.isArray(snapshotResult.warnings)) warnings.push(...snapshotResult.warnings);
  }

  return {
    message: 'Publish all pipeline completed',
    warnings,
    data: {
      steps,
      publishMode: {
        uploadZip: shouldRunPublishZip ? steps.publish_zip.publishMode?.uploadZip : false,
        snapshotOnChain: snapshotOnChainMode.enabled,
        snapshotFlagSource: snapshotOnChainMode.source,
      },
    },
    metrics: {
      elapsedMs: nowTs() - startedAt,
    },
  };
}

function actionAbsorb(input, paths, state) {
  const ingestResult = actionIngest({
    ...input,
    payload: {
      ...(input.payload || {}),
      mode: 'incremental',
    },
  }, paths, state);

  const stateAfterIngest = loadState(paths, input.kbId);
  const indexConfigSignature = getIndexConfigSignature(loadConfig(paths));
  const configChanged = stateAfterIngest.lastIndexConfigSignature !== indexConfigSignature;
  const shouldRunIndex = ingestResult.data?.changed === true
    || configChanged
    || input.payload.forceIndex === true;
  const indexResult = shouldRunIndex
    ? actionIndex({
      ...input,
      payload: {
        ...(input.payload || {}),
        mode: 'incremental',
      },
    }, paths, stateAfterIngest)
    : {
      message: 'Index skipped',
      warnings: [],
      data: {
        skipped: true,
        reason: 'raw_files_unchanged',
        kbVersion: stateAfterIngest.kbVersion,
      },
      metrics: {
        elapsedMs: 0,
      },
    };

  let wikiResult = null;
  if (input.payload.runWikiDelta === true) {
    const stateAfterIndex = loadState(paths, input.kbId);
    wikiResult = actionWikiBuild(input, paths, stateAfterIndex);
  }

  return {
    message: 'Absorb completed',
    warnings: [...(ingestResult.warnings || []), ...(indexResult.warnings || [])],
    data: {
      ingest: ingestResult.data,
      index: indexResult.data,
      wiki: wikiResult ? wikiResult.data : null,
    },
    metrics: {
      elapsedMs: (ingestResult.metrics?.elapsedMs || 0) + (indexResult.metrics?.elapsedMs || 0),
    },
  };
}

async function dispatchAction(input, paths, state) {
  switch (input.action) {
    case 'registry_create':
      return actionRegistryCreate(input);
    case 'registry_list':
      return actionRegistryList(input);
    case 'registry_set_default':
      return actionRegistrySetDefault(input);
    case 'registry_resolve':
      return actionRegistryResolve(input);
    case 'registry_remove':
      return actionRegistryRemove(input);
    case 'init':
      return actionInit(input, paths, state);
    case 'ingest':
      return actionIngest(input, paths, state);
    case 'index':
      return actionIndex(input, paths, state);
    case 'query':
      return actionQuery(input, paths, state);
    case 'absorb':
      return actionAbsorb(input, paths, state);
    case 'wiki_build':
      return actionWikiBuild(input, paths, state);
    case 'bundle_zip':
      return actionBundleZip(input, paths, state);
    case 'publish_zip':
      return actionPublishZip(input, paths, state);
    case 'publish_snapshot':
      return actionPublishSnapshot(input, paths, state);
    case 'publish_all':
      return actionPublishAll(input, paths, state);
    default:
      throw new SkillError('invalid_payload', `Unsupported action ${input.action}`);
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      payload: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
  });

  if (values.help) {
    process.stdout.write(
      'metabot-llm-wiki\n' +
      'Usage: node scripts/index.js --payload \'<json>\'\n' +
      'Actions: registry_create | registry_list | registry_set_default | registry_resolve | registry_remove | init | ingest | index | query | absorb | wiki_build | bundle_zip | publish_zip | publish_snapshot | publish_all\n'
    );
    process.exit(0);
  }

  let input = null;
  try {
    const raw = parsePayload(values.payload);
    input = resolveInputContext(parseInput(raw));

    const paths = input.kbId ? resolvePaths(input.kbId, input.payload) : null;
    const state = paths ? loadState(paths, input.kbId) : null;
    const result = await dispatchAction(input, paths, state);
    const envelope = buildResponseEnvelope({
      action: input.action,
      kbId: input.kbId,
      message: result.message,
      data: result.data,
      warnings: result.warnings,
      metrics: result.metrics,
    });
    process.stdout.write(`${JSON.stringify(envelope)}\n`);
    process.exit(0);
  } catch (error) {
    const envelope = buildErrorEnvelope({
      action: input?.action || '',
      kbId: input?.kbId || '',
      message: 'action failed',
      code: error instanceof SkillError ? error.code : 'unknown_error',
      detail: error instanceof SkillError ? error.detail : (error instanceof Error ? error.message : String(error)),
      retryable: error instanceof SkillError ? error.retryable : false,
    });
    process.stdout.write(`${JSON.stringify(envelope)}\n`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  __llmWikiTestUtils: {
    chunkText,
    tokenize,
    scoreChunks,
    normalizeConfig,
    normalizeVector,
    parseCommandLine,
  },
};
