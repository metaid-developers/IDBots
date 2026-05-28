#!/usr/bin/env node
'use strict';
/**
 * IDBots metabot-post-skill: Publish a skill package to MetaWeb chain
 * using the metabot-skill protocol (/protocols/metabot-skill).
 *
 * Requires: Node.js 18+ (for fetch). Env: IDBOTS_METABOT_ID, IDBOTS_RPC_URL.
 *
 * Usage:
 *   node index.js --request-file <request.json>
 *   node index.js --payload '<JSON>' --zip <zip-path>
 */

const { parseArgs } = require('util');
const fs = require('fs');
const pathMod = require('path');

const RPC_BASE = (process.env.IDBOTS_RPC_URL || 'http://127.0.0.1:31200').replace(/\/+$/, '');
const CREATE_PIN_URL = `${RPC_BASE}/api/metaid/create-pin`;
const SKILL_PROTOCOL_PATH = '/protocols/metabot-skill';
const MAX_ZIP_SIZE = 4 * 1024 * 1024; // 4 MB

function writeStderr(msg) {
  process.stderr.write(msg + '\n');
}

function extractRpcField(record, key) {
  const value = record[key];
  return typeof value === 'string' ? value.trim() : '';
}

function resolvePinId(resp) {
  const txid = resp.txid ?? (Array.isArray(resp.txids) ? resp.txids[0] : undefined) ?? '';
  return resp.pinId ?? (txid ? `${txid}i0` : '');
}

async function createPin(metabotId, network, metaidData) {
  const res = await fetch(CREATE_PIN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ metabot_id: metabotId, network, metaidData }),
  });
  const rawText = await res.text();
  let parsed = null;
  if (rawText.trim()) {
    try {
      const maybe = JSON.parse(rawText);
      parsed = maybe && typeof maybe === 'object' ? maybe : null;
    } catch {
      parsed = null;
    }
  }
  if (!res.ok) {
    const errMsg = parsed?.error || rawText;
    throw new Error(`HTTP ${res.status}: ${errMsg}`);
  }
  if (parsed && parsed.success === false) {
    throw new Error(parsed.error || 'Unknown RPC error');
  }
  return parsed ?? {};
}

async function uploadZip(filePath, metabotId, network) {
  const resolved = pathMod.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`File not found: ${resolved}`);
  }
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) {
    throw new Error(`Path is not a file: ${resolved}`);
  }
  if (stat.size > MAX_ZIP_SIZE) {
    const sizeMB = (stat.size / (1024 * 1024)).toFixed(2);
    throw new Error(`ZIP file too large: ${sizeMB} MB (max 4 MB). Please reduce the skill package size.`);
  }
  const buffer = fs.readFileSync(resolved);
  const base64 = buffer.toString('base64');
  writeStderr(`Uploading: ${pathMod.basename(resolved)} (application/zip, ${stat.size} bytes)...`);
  const resp = await createPin(metabotId, network, {
    operation: 'create',
    path: '/file',
    encryption: '0',
    version: '1.0',
    contentType: 'application/zip',
    encoding: 'base64',
    payload: base64,
  });
  const pinId = resolvePinId(resp);
  if (!pinId) {
    throw new Error(`Failed to get pinId for uploaded file: ${resolved}`);
  }
  const ext = pathMod.extname(resolved).toLowerCase();
  const metafileUri = `metafile://${pinId}${ext}`;
  if (typeof resp.totalCost === 'number') {
    writeStderr(`  -> Uploaded: ${metafileUri} (cost: ${resp.totalCost} satoshis)`);
  } else {
    writeStderr(`  -> Uploaded: ${metafileUri}`);
  }
  return { pinId, ext, metafileUri };
}

function main() {
  const { values, positionals } = parseArgs({
    options: {
      'request-file': { type: 'string' },
      payload: { type: 'string' },
      zip: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
  });

  if (values.help) {
    process.stderr.write(
      'metabot-post-skill: Publish a skill package to MetaWeb via /protocols/metabot-skill.\n\n' +
      'Usage:\n' +
      '  node index.js --request-file <request.json>\n' +
      '  node index.js --payload \'<JSON>\' --zip <zip-path>\n' +
      '  node index.js --payload \'<JSON>\'                  (when skillFileUri already provided in payload)\n\n' +
      'Env: IDBOTS_METABOT_ID (required), IDBOTS_RPC_URL (optional).\n'
    );
    process.exit(0);
  }

  for (const p of positionals) {
    if (p.startsWith('-')) {
      writeStderr(`Unknown option: ${p}`);
      process.exit(1);
    }
  }

  const requestFile = values['request-file'];
  let payloadRaw = values.payload ?? '';
  let zipPath = values.zip ?? '';

  if (requestFile) {
    const resolved = pathMod.resolve(requestFile);
    if (!fs.existsSync(resolved)) {
      writeStderr(`Error: Request file not found: ${resolved}`);
      process.exit(1);
    }
    let requestJson;
    try {
      requestJson = JSON.parse(fs.readFileSync(resolved, 'utf8'));
    } catch (e) {
      writeStderr(`Error: Invalid request file JSON: ${resolved}`);
      process.exit(1);
    }
    if (!requestJson || typeof requestJson !== 'object') {
      writeStderr('Error: Request file must contain a JSON object.');
      process.exit(1);
    }
    if (typeof requestJson.payload === 'string') {
      payloadRaw = requestJson.payload;
    } else {
      for (const key of ['name', 'description', 'version', 'skill-file']) {
        const v = requestJson[key];
        if (typeof v === 'string' || typeof v === 'number') {
          requestJson[key] = String(v);
        }
      }
      payloadRaw = JSON.stringify({
        name: requestJson.name ?? '',
        description: requestJson.description ?? '',
        version: requestJson.version ?? '',
      });
    }
    if (typeof requestJson.zip === 'string') {
      zipPath = requestJson.zip;
    }
    if (typeof requestJson.skillFileUri === 'string') {
      requestJson['skill-file'] = requestJson.skillFileUri;
    }
    if (!payloadRaw || payloadRaw.trim() === '') {
      writeStderr('Error: request file must include payload or name/description/version.');
      process.exit(1);
    }
  }

  if (!payloadRaw || payloadRaw.trim() === '') {
    writeStderr('Error: --payload or --request-file is required.');
    process.exit(1);
  }

  const metabotIdStr = process.env.IDBOTS_METABOT_ID;
  if (!metabotIdStr || metabotIdStr.trim() === '') {
    writeStderr('Error: IDBOTS_METABOT_ID is required. Set it when running from IDBots Cowork or manually.');
    process.exit(1);
  }
  const metabotId = parseInt(metabotIdStr.trim(), 10);
  if (Number.isNaN(metabotId) || metabotId < 1) {
    writeStderr('Error: IDBOTS_METABOT_ID must be a positive integer.');
    process.exit(1);
  }

  let payload;
  try {
    payload = JSON.parse(payloadRaw);
  } catch (e) {
    writeStderr('Error: --payload must be valid JSON.');
    process.exit(1);
  }
  if (!payload || typeof payload !== 'object') {
    writeStderr('Error: --payload must be a JSON object.');
    process.exit(1);
  }

  const name = (payload.name ?? '').trim();
  const description = (payload.description ?? '').trim();
  const version = (payload.version ?? '').trim();
  let skillFileUri = (payload['skill-file'] ?? payload.skillFileUri ?? '').trim();

  if (!name) {
    writeStderr('Error: payload must include "name".');
    process.exit(1);
  }
  if (!version) {
    writeStderr('Error: payload must include "version".');
    process.exit(1);
  }

  // If --zip is provided, it overrides any existing skill-file URI
  if (zipPath) {
    payload.zipPath = zipPath;
  }
  // If request file had a zip field, use that
  const effectiveZipPath = (payload.zipPath ?? '').trim();

  const network = 'mvc';

  (async () => {
    try {
      if (effectiveZipPath) {
        const { metafileUri } = await uploadZip(effectiveZipPath, metabotId, network);
        skillFileUri = metafileUri;
      }

      if (!skillFileUri || !skillFileUri.startsWith('metafile://')) {
        writeStderr('Error: skill-file URI is required. Provide it via --zip to upload, or include skillFileUri in the payload.');
        process.exit(1);
      }

      const skillPayload = {
        name,
        description,
        version,
        'skill-file': skillFileUri,
      };
      // Omit empty optional fields
      const cleaned = {};
      for (const [k, v] of Object.entries(skillPayload)) {
        if (v !== undefined && v !== '') cleaned[k] = v;
      }

      writeStderr(`Publishing skill to ${SKILL_PROTOCOL_PATH}: ${name} v${version}`);

      const resp = await createPin(metabotId, network, {
        operation: 'create',
        path: SKILL_PROTOCOL_PATH,
        encryption: '0',
        version: '1.0',
        contentType: 'application/json',
        payload: JSON.stringify(cleaned),
      });

      const txid = extractRpcField(resp, 'txid') ||
        (Array.isArray(resp.txids) && typeof resp.txids[0] === 'string' ? String(resp.txids[0]).trim() : '');
      const pinId = resolvePinId(resp);
      const totalCost = typeof resp.totalCost === 'number' ? resp.totalCost : undefined;

      const result = {
        success: true,
        message: pinId ? `Skill published: ${pinId}` : 'Skill published successfully.',
      };
      if (txid) result.txid = txid;
      if (pinId) result.pinId = pinId;
      if (totalCost !== undefined) result.totalCost = totalCost;
      if (skillFileUri) result.skillFileUri = skillFileUri;
      process.stdout.write(`${JSON.stringify(result)}\n`);
      if (totalCost !== undefined) {
        writeStderr(`Cost: ${totalCost} satoshis`);
      }
    } catch (err) {
      writeStderr(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  })();
}

main();
