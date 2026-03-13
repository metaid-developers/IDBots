#!/usr/bin/env node
'use strict';
/**
 * IDBots metabot-post-skillservice: Publish a skill as a paid service to the chain
 * using the skill-service protocol (/protocols/skill-service).
 *
 * Requires: Node.js 18+ (for fetch). Env: IDBOTS_METABOT_ID, IDBOTS_METABOT_GLOBALMETAID, IDBOTS_RPC_URL.
 *
 * Usage:
 *   node index.js --payload '<JSON>'
 */

const { parseArgs } = require('util');

function writeStderr(msg) {
  process.stderr.write(msg + '\n');
}

function extractRpcField(record, key) {
  const value = record[key];
  return typeof value === 'string' ? value.trim() : '';
}

const SKILL_SERVICE_PATH = '/protocols/skill-service';
const DEFAULT_INPUT_TYPE = 'text';
const DEFAULT_OUTPUT_TYPE = 'text';
const DEFAULT_ENDPOINT = 'simplemsg';

function main() {
  const { values, positionals } = parseArgs({
    options: {
      payload: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
  });

  if (values.help) {
    process.stderr.write(
      'metabot-post-skillservice: Publish skill-service to chain via local RPC.\n\n' +
        'Usage: node index.js --payload \'<JSON>\'\n\n' +
        'Env: IDBOTS_METABOT_ID (required), IDBOTS_METABOT_GLOBALMETAID (required), IDBOTS_RPC_URL (optional).\n'
    );
    process.exit(0);
  }

  for (const p of positionals) {
    if (p.startsWith('-')) {
      writeStderr(`Unknown option: ${p}`);
      process.exit(1);
    }
  }

  const payloadRaw = values.payload ?? '';
  if (typeof payloadRaw !== 'string' || payloadRaw.trim() === '') {
    writeStderr('Error: --payload is required and must not be empty.');
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

  const serviceName = (payload.serviceName ?? '').trim();
  const displayName = (payload.displayName ?? '').trim();
  const description = (payload.description ?? '').trim();
  const providerSkill = (payload.providerSkill ?? '').trim();
  const price = payload.price != null ? String(payload.price).trim() : '';
  const currency = (payload.currency ?? '').trim().toUpperCase();

  if (!serviceName || !displayName || !description || !providerSkill || !price || !currency) {
    writeStderr(
      'Error: payload must include serviceName, displayName, description, providerSkill, price, and currency.'
    );
    process.exit(1);
  }
  if (!['SPACE', 'BTC', 'DOGE'].includes(currency)) {
    writeStderr('Error: currency must be one of SPACE, BTC, DOGE.');
    process.exit(1);
  }

  // Use payload.providerMetaBot if present and non-empty; otherwise fall back to env
  const fromPayload = (payload.providerMetaBot ?? '').trim();
  const fromEnv = (process.env.IDBOTS_METABOT_GLOBALMETAID || '').trim();
  const effectiveGlobalMetaId = fromPayload || fromEnv;
  if (!effectiveGlobalMetaId) {
    writeStderr(
      'Error: providerMetaBot is required. Provide it in the payload or set IDBOTS_METABOT_GLOBALMETAID when running this skill.'
    );
    process.exit(1);
  }

  const skillServicePayload = {
    serviceName,
    displayName,
    description,
    serviceIcon: (payload.serviceIcon ?? '').trim() || undefined,
    providerMetaBot: effectiveGlobalMetaId,
    providerSkill,
    price,
    currency,
    skillDocument: (payload.skillDocument ?? '').trim() || undefined,
    inputType: (payload.inputType ?? DEFAULT_INPUT_TYPE).trim().toLowerCase() || DEFAULT_INPUT_TYPE,
    outputType: (payload.outputType ?? DEFAULT_OUTPUT_TYPE).trim().toLowerCase() || DEFAULT_OUTPUT_TYPE,
    endpoint: (payload.endpoint ?? DEFAULT_ENDPOINT).trim().toLowerCase() || DEFAULT_ENDPOINT,
  };
  // Omit undefined so protocol consumers get clean JSON
  const cleaned = {};
  for (const [k, v] of Object.entries(skillServicePayload)) {
    if (v !== undefined && v !== '') cleaned[k] = v;
  }

  const rpcUrl = (process.env.IDBOTS_RPC_URL || 'http://127.0.0.1:31200').replace(/\/+$/, '');
  const url = `${rpcUrl}/api/metaid/create-pin`;
  const body = {
    metabot_id: metabotId,
    network: 'mvc',
    metaidData: {
      operation: 'create',
      path: SKILL_SERVICE_PATH,
      encryption: '0',
      version: '1.0',
      contentType: 'application/json',
      payload: JSON.stringify(cleaned),
    },
  };

  (async () => {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
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
        writeStderr(`HTTP ${res.status}: ${rawText}`);
        process.exit(1);
      }
      if (parsed && parsed.success === false) {
        const errorText = extractRpcField(parsed, 'error') || 'Unknown RPC error';
        writeStderr(`RPC request failed: ${errorText}`);
        process.exit(1);
      }
      const txidFromList =
        parsed && Array.isArray(parsed.txids) && typeof parsed.txids[0] === 'string'
          ? String(parsed.txids[0]).trim()
          : '';
      const txid = parsed ? extractRpcField(parsed, 'txid') || txidFromList : '';
      const pinId = parsed ? extractRpcField(parsed, 'pinId') || (txid ? `${txid}i0` : '') : '';
      const totalCost = parsed && typeof parsed.totalCost === 'number' ? parsed.totalCost : undefined;
      const result = {
        success: true,
        message: pinId ? `Skill service published: ${pinId}` : 'Skill service published successfully.',
      };
      if (txid) result.txid = txid;
      if (pinId) result.pinId = pinId;
      if (typeof totalCost === 'number') result.totalCost = totalCost;
      process.stdout.write(`${JSON.stringify(result)}\n`);
      if (typeof totalCost === 'number') {
        writeStderr(`Cost: ${totalCost} satoshis`);
      }
    } catch (err) {
      writeStderr(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  })();
}

main();
