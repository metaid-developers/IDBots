#!/usr/bin/env node
'use strict';

const { parseArgs } = require('util');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const RPC_BASE = (process.env.IDBOTS_RPC_URL || 'http://127.0.0.1:31200').replace(/\/+$/, '');
const UPLOAD_URL = `${RPC_BASE}/api/idbots/files/upload-largefile`;
const CREATE_PIN_URL = `${RPC_BASE}/api/metaid/create-pin`;
const METAAPP_PROTOCOL_PATH = '/protocols/metaapp';
const DEFAULT_NETWORK = 'mvc';
const ZIP_CONTENT_TYPE = 'application/zip';

const MIME_MAP = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.zip': ZIP_CONTENT_TYPE,
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.md': 'text/markdown',
};

const EXCLUDE_DIRS = new Set([
  '.git',
  '.idea',
  '.vscode',
  '__MACOSX',
  '__pycache__',
  'node_modules',
  'coverage',
  '.cache',
  '.next',
]);
const EXCLUDE_FILE_NAMES = new Set(['.DS_Store']);
const EXCLUDE_EXTENSIONS = new Set(['.zip', '.log']);

function writeStderr(message) {
  process.stderr.write(`${message}\n`);
}

function expandHome(input) {
  const value = String(input || '').trim();
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

function resolveLocalPath(input) {
  return path.resolve(expandHome(input));
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cleanString(value, fallback = '') {
  if (value === undefined || value === null) return fallback;
  return String(value).trim();
}

function isMetafileUri(value) {
  return /^metafile:\/\/\S+/i.test(cleanString(value));
}

function readJsonFile(filePath) {
  const resolved = resolveLocalPath(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`File not found: ${resolved}`);
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(resolved, 'utf8'));
    if (!isObject(parsed)) {
      throw new Error('JSON root must be an object');
    }
    return { parsed, resolved };
  } catch (err) {
    throw new Error(`Invalid JSON file: ${resolved} (${err instanceof Error ? err.message : String(err)})`);
  }
}

function getMetabotId() {
  const raw = cleanString(process.env.IDBOTS_METABOT_ID);
  if (!raw) {
    throw new Error('IDBOTS_METABOT_ID is required. Set it when running from IDBots Cowork or manually.');
  }
  const id = Number.parseInt(raw, 10);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error('IDBOTS_METABOT_ID must be a positive integer.');
  }
  return id;
}

function inferContentType(filePath) {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  return MIME_MAP[ext] || 'application/octet-stream';
}

function normalizePinId(response) {
  if (!response || typeof response !== 'object') return '';
  const direct = cleanString(response.pinId);
  if (direct) return direct;
  const txid = cleanString(response.txid) ||
    (Array.isArray(response.txids) && response.txids.length > 0 ? cleanString(response.txids[0]) : '');
  return txid ? `${txid}i0` : '';
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const rawText = await response.text();
  let parsed = null;
  if (rawText.trim()) {
    try {
      parsed = JSON.parse(rawText);
    } catch {
      parsed = null;
    }
  }
  if (!response.ok) {
    throw new Error((parsed && parsed.error) || rawText || `HTTP ${response.status}`);
  }
  if (parsed && parsed.success === false) {
    throw new Error(parsed.error || 'RPC call failed');
  }
  return parsed || {};
}

async function uploadLocalFile(filePath, contentType, metabotId, network, role) {
  const resolved = resolveLocalPath(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`File not found: ${resolved}`);
  }
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) {
    throw new Error(`Path is not a file: ${resolved}`);
  }

  const finalContentType = contentType || inferContentType(resolved);
  writeStderr(`Uploading ${role}: ${path.basename(resolved)} (${finalContentType}, ${stat.size} bytes)`);
  const response = await postJson(UPLOAD_URL, {
    metabot_id: metabotId,
    file_path: resolved,
    content_type: finalContentType,
    network,
  });
  const pinId = normalizePinId(response);
  if (!pinId) {
    throw new Error(`Upload did not return pinId for ${resolved}`);
  }
  const uri = `metafile://${pinId}`;
  return {
    role,
    pinId,
    uri,
    filePath: resolved,
    contentType: finalContentType,
    size: typeof response.size === 'number' ? response.size : stat.size,
    uploadMode: response.uploadMode,
  };
}

const crc32Table = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let j = 0; j < 8; j += 1) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = crc32Table[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function buildZip(entries) {
  const parts = [];
  const centralDir = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const deflated = zlib.deflateRawSync(data, { level: 6 });
    const useDeflate = deflated.length < data.length;
    const compressedData = useDeflate ? deflated : data;
    const compressionMethod = useDeflate ? 8 : 0;
    const crc = crc32(data);

    const localHeader = Buffer.allocUnsafe(30 + nameBytes.length);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(compressionMethod, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressedData.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(nameBytes.length, 26);
    localHeader.writeUInt16LE(0, 28);
    nameBytes.copy(localHeader, 30);

    parts.push(localHeader, compressedData);

    const centralHeader = Buffer.allocUnsafe(46 + nameBytes.length);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(compressionMethod, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(compressedData.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(nameBytes.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    nameBytes.copy(centralHeader, 46);

    centralDir.push(centralHeader);
    offset += localHeader.length + compressedData.length;
  }

  const centralDirBuffer = Buffer.concat(centralDir);
  const eocd = Buffer.allocUnsafe(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(centralDir.length, 8);
  eocd.writeUInt16LE(centralDir.length, 10);
  eocd.writeUInt32LE(centralDirBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...parts, centralDirBuffer, eocd]);
}

function shouldExclude(filePath, root) {
  const relative = path.relative(root, filePath);
  const parts = relative.split(path.sep).filter(Boolean);
  for (const part of parts) {
    if (EXCLUDE_DIRS.has(part)) return true;
  }
  const base = path.basename(filePath);
  if (EXCLUDE_FILE_NAMES.has(base)) return true;
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath).toLowerCase();
    if (EXCLUDE_EXTENSIONS.has(ext)) return true;
  }
  return false;
}

function createZipArchive(srcRoot, zipPath) {
  const root = resolveLocalPath(srcRoot);
  const output = resolveLocalPath(zipPath);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const entries = [];

  function walk(directory) {
    const items = fs.readdirSync(directory).sort((left, right) => left.localeCompare(right));
    for (const item of items) {
      const fullPath = path.join(directory, item);
      if (shouldExclude(fullPath, root)) continue;
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        walk(fullPath);
      } else if (stat.isFile()) {
        const name = path.relative(root, fullPath).replace(/\\/g, '/');
        entries.push({ name, data: fs.readFileSync(fullPath) });
      }
    }
  }

  walk(root);
  if (entries.length === 0) {
    throw new Error(`Directory has no packable files: ${root}`);
  }
  const zipBuffer = buildZip(entries);
  fs.writeFileSync(output, zipBuffer);
  return { zipPath: output, size: zipBuffer.length, fileCount: entries.length };
}

function sanitizeFileName(name) {
  return cleanString(name, 'metaapp').replace(/[^\w.-]+/g, '_') || 'metaapp';
}

function packageDirectory(directory, role) {
  const resolved = resolveLocalPath(directory);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Directory not found: ${resolved}`);
  }
  if (!fs.statSync(resolved).isDirectory()) {
    throw new Error(`Path is not a directory: ${resolved}`);
  }
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metabot-metaapp-'));
  const zipPath = path.join(tempDir, `${sanitizeFileName(path.basename(resolved) || role)}.zip`);
  const result = createZipArchive(resolved, zipPath);
  writeStderr(`Packaged ${role}: ${result.zipPath} (${result.fileCount} files, ${result.size} bytes)`);
  return result;
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(resolveLocalPath(filePath)));
  return hash.digest('hex');
}

function resourceInput(request, key) {
  const value = request[key];
  if (value === undefined || value === null) return '';
  if (typeof value === 'string' || typeof value === 'number') return cleanString(value);
  if (isObject(value)) {
    if (typeof value.uri === 'string') return cleanString(value.uri);
    if (typeof value.path === 'string') return cleanString(value.path);
    if (typeof value.file === 'string') return cleanString(value.file);
    if (typeof value.pinId === 'string') return `metafile://${cleanString(value.pinId)}`;
  }
  return '';
}

async function resolveZipResource(request, key, metabotId, network, uploads) {
  const value = resourceInput(request, key);
  if (!value) return { uri: '', localFile: '', packaged: false };
  if (isMetafileUri(value)) return { uri: value, localFile: '', packaged: false };

  const resolved = resolveLocalPath(value);
  if (!fs.existsSync(resolved)) {
    throw new Error(`${key} path not found: ${resolved}`);
  }
  const stat = fs.statSync(resolved);
  let uploadFile = resolved;
  let packaged = false;
  if (stat.isDirectory()) {
    const result = packageDirectory(resolved, key);
    uploadFile = result.zipPath;
    packaged = true;
  } else if (stat.isFile()) {
    if (path.extname(resolved).toLowerCase() !== '.zip') {
      throw new Error(`${key} must be a directory, a .zip file, or a metafile:// URI: ${resolved}`);
    }
  } else {
    throw new Error(`${key} must be a directory or .zip file: ${resolved}`);
  }

  const upload = await uploadLocalFile(uploadFile, ZIP_CONTENT_TYPE, metabotId, network, key);
  uploads.push(upload);
  return { uri: upload.uri, localFile: uploadFile, packaged };
}

async function resolveImageResource(value, role, metabotId, network, uploads) {
  const input = typeof value === 'string' || typeof value === 'number'
    ? cleanString(value)
    : isObject(value)
      ? resourceInput({ value }, 'value')
      : '';
  if (!input) return '';
  if (isMetafileUri(input)) return input;

  const resolved = resolveLocalPath(input);
  if (!fs.existsSync(resolved)) {
    throw new Error(`${role} path not found: ${resolved}`);
  }
  if (!fs.statSync(resolved).isFile()) {
    throw new Error(`${role} must be a local file or metafile:// URI: ${resolved}`);
  }
  const upload = await uploadLocalFile(resolved, inferContentType(resolved), metabotId, network, role);
  uploads.push(upload);
  return upload.uri;
}

function normalizeTags(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => cleanString(entry)).filter(Boolean);
  }
  const asString = cleanString(value);
  if (!asString) return [];
  return asString.split(',').map((entry) => entry.trim()).filter(Boolean);
}

function normalizeDisabled(value) {
  if (typeof value === 'boolean') return value;
  const normalized = cleanString(value).toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes';
}

function normalizeMetadata(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

async function prepareMetaApp(request, metabotId, network) {
  const title = cleanString(request.title);
  const appName = cleanString(request.appName);
  if (!title) throw new Error('title is required');
  if (!appName) throw new Error('appName is required');

  const uploads = [];
  const contentResource = await resolveZipResource(request, 'content', metabotId, network, uploads);
  const codeResource = await resolveZipResource(request, 'code', metabotId, network, uploads);

  if (!contentResource.uri && !codeResource.uri) {
    throw new Error('content and code cannot both be empty');
  }

  const icon = await resolveImageResource(request.icon, 'icon', metabotId, network, uploads);
  const coverImg = await resolveImageResource(request.coverImg, 'coverImg', metabotId, network, uploads);
  const introImgInputs = Array.isArray(request.introImgs) ? request.introImgs : [];
  const introImgs = [];
  for (let i = 0; i < introImgInputs.length; i += 1) {
    const uri = await resolveImageResource(introImgInputs[i], `introImgs[${i}]`, metabotId, network, uploads);
    if (uri) introImgs.push(uri);
  }

  const contentHash = contentResource.localFile
    ? sha256File(contentResource.localFile)
    : cleanString(request.contentHash);

  const payload = {
    title,
    appName,
    prompt: cleanString(request.prompt),
    icon,
    coverImg,
    introImgs,
    intro: cleanString(request.intro),
    runtime: cleanString(request.runtime, 'browser'),
    version: cleanString(request.version, 'v1.0.0'),
    contentType: contentResource.uri ? ZIP_CONTENT_TYPE : cleanString(request.contentType, ZIP_CONTENT_TYPE),
    content: contentResource.uri,
    indexFile: cleanString(request.indexFile, 'index.html'),
    code: codeResource.uri,
    contentHash,
    metadata: normalizeMetadata(request.metadata),
    tags: normalizeTags(request.tags),
    disabled: normalizeDisabled(request.disabled),
    codeType: codeResource.uri ? ZIP_CONTENT_TYPE : cleanString(request.codeType, ZIP_CONTENT_TYPE),
  };

  return {
    success: true,
    path: METAAPP_PROTOCOL_PATH,
    payload,
    uploads,
    preparedAt: new Date().toISOString(),
  };
}

async function publishPrepared(prepared, metabotId, network) {
  const payload = prepared.payload;
  if (!isObject(payload)) {
    throw new Error('prepared file must include payload object');
  }
  const pathValue = cleanString(prepared.path, METAAPP_PROTOCOL_PATH);
  if (pathValue !== METAAPP_PROTOCOL_PATH) {
    throw new Error(`prepared path must be ${METAAPP_PROTOCOL_PATH}`);
  }
  if (!cleanString(payload.content) && !cleanString(payload.code)) {
    throw new Error('content and code cannot both be empty');
  }

  writeStderr(`Publishing MetaApp to ${METAAPP_PROTOCOL_PATH}: ${cleanString(payload.title)} ${cleanString(payload.version)}`);
  const response = await postJson(CREATE_PIN_URL, {
    metabot_id: metabotId,
    network,
    metaidData: {
      operation: 'create',
      path: METAAPP_PROTOCOL_PATH,
      encryption: '0',
      version: '1.0',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
    },
  });

  const pinId = normalizePinId(response);
  const result = {
    success: true,
    message: pinId ? `MetaApp published: ${pinId}` : 'MetaApp published successfully.',
  };
  const txid = cleanString(response.txid) ||
    (Array.isArray(response.txids) && response.txids.length > 0 ? cleanString(response.txids[0]) : '');
  if (pinId) result.pinId = pinId;
  if (txid) result.txid = txid;
  if (typeof response.totalCost === 'number') result.totalCost = response.totalCost;
  return result;
}

function printHelp() {
  writeStderr(
    'metabot-post-metaapp: prepare and publish /protocols/metaapp payloads.\n\n' +
    'Usage:\n' +
    '  node index.js --prepare-request <request.json> [--output <prepared.json>] [--network mvc]\n' +
    '  node index.js --publish-prepared <prepared.json> [--network mvc]\n\n' +
    'Env: IDBOTS_METABOT_ID (required), IDBOTS_RPC_URL (optional).'
  );
}

async function main() {
  const { values, positionals } = parseArgs({
    options: {
      'prepare-request': { type: 'string' },
      'publish-prepared': { type: 'string' },
      output: { type: 'string' },
      network: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
  });

  if (values.help) {
    printHelp();
    return;
  }
  for (const positional of positionals) {
    if (String(positional).startsWith('-')) {
      throw new Error(`Unknown option: ${positional}`);
    }
  }

  const prepareRequest = cleanString(values['prepare-request']);
  const publishFile = cleanString(values['publish-prepared']);
  if (!prepareRequest && !publishFile) {
    printHelp();
    throw new Error('--prepare-request or --publish-prepared is required');
  }
  if (prepareRequest && publishFile) {
    throw new Error('Use either --prepare-request or --publish-prepared, not both');
  }

  const metabotId = getMetabotId();
  const network = cleanString(values.network, DEFAULT_NETWORK);

  if (prepareRequest) {
    const { parsed } = readJsonFile(prepareRequest);
    const prepared = await prepareMetaApp(parsed, metabotId, network);
    const output = cleanString(values.output);
    if (output) {
      const resolvedOutput = resolveLocalPath(output);
      fs.mkdirSync(path.dirname(resolvedOutput), { recursive: true });
      fs.writeFileSync(resolvedOutput, `${JSON.stringify(prepared, null, 2)}\n`, 'utf8');
      writeStderr(`Prepared payload written to: ${resolvedOutput}`);
    }
    process.stdout.write(`${JSON.stringify(prepared)}\n`);
    return;
  }

  const { parsed } = readJsonFile(publishFile);
  const result = await publishPrepared(parsed, metabotId, network);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch((err) => {
  writeStderr(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
