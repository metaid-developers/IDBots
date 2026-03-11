#!/usr/bin/env node
'use strict';
/**
 * MetaBot Omni-Reader: Fetches on-chain (MetaWeb) data from manapi.metaid.io and
 * file.metaid.io/metafile-indexer. Registry-driven: each query-type has a
 * urlTemplate (with {{param}} placeholders), responsePath, and optional sanitization.
 *
 * Usage:
 *   node omni-reader.js --list
 *   node omni-reader.js --query-type info_metaid --metaid "idq12sdfqxwt..."
 *   node omni-reader.js --query-type metaid_pin_list --metaid "xxx" --path "/protocols/simplebuzz" --size 20
 */

const fs = require('fs');
const path = require('path');

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

const REGISTRY_PATH = path.join(__dirname, '..', 'api_registry.json');

/** Deep get by dot path, e.g. get(obj, 'data.list') */
function get(obj, pathStr, defaultValue = null) {
  if (obj == null || typeof pathStr !== 'string') return defaultValue;
  if (pathStr === '' || pathStr === '.') return obj;
  const keys = pathStr.split('.');
  let current = obj;
  for (const key of keys) {
    if (current == null || typeof current !== 'object') return defaultValue;
    current = current[key];
  }
  return current === undefined ? defaultValue : current;
}

function loadRegistry() {
  const raw = fs.readFileSync(REGISTRY_PATH, 'utf-8');
  return JSON.parse(raw);
}

/** Parse CLI: first pass for --list and --query-type, then collect all --key value */
function parseArgs() {
  const argv = process.argv.slice(2);
  const result = { list: false, 'query-type': null, params: {} };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--list' || arg === '-l') {
      result.list = true;
      continue;
    }
    if (arg === '--query-type' && argv[i + 1] != null) {
      result['query-type'] = argv[++i];
      continue;
    }
    if (arg.startsWith('--') && arg.length > 2) {
      const key = arg.slice(2);
      const value = argv[i + 1] != null && !String(argv[i + 1]).startsWith('--')
        ? argv[++i]
        : '';
      result.params[key] = value;
    }
  }
  return result;
}

/** Substitute {{name}} in template; strip query params whose value is empty. */
function substituteTemplate(template, params) {
  const paramNames = [];
  const re = /\{\{(\w+)\}\}/g;
  let m;
  while ((m = re.exec(template)) !== null) paramNames.push(m[1]);
  let out = template;
  for (const name of paramNames) {
    const raw = params[name] != null ? String(params[name]).trim() : '';
    out = out.replace(new RegExp(`\\{\\{${name}\\}\\}`, 'g'), encodeURIComponent(raw));
  }
  const q = out.indexOf('?');
  if (q !== -1) {
    const base = out.slice(0, q);
    const query = out.slice(q + 1);
    const pairs = query.split('&').filter((p) => {
      const eq = p.indexOf('=');
      if (eq === -1) return true;
      let v;
      try {
        v = decodeURIComponent(p.slice(eq + 1));
      } catch {
        v = p.slice(eq + 1);
      }
      return v !== '' && v !== 'undefined';
    });
    out = pairs.length ? base + '?' + pairs.join('&') : base;
  }
  return out;
}

/** Sanitize item by mapping: targetKey <- get(item, sourcePath) */
function sanitizeItem(item, mapping) {
  if (!mapping || typeof item !== 'object') return item;
  const clean = {};
  for (const [targetKey, sourcePath] of Object.entries(mapping)) {
    let val = get(item, sourcePath, null);
    if (typeof val === 'string' && (val.startsWith('{') || val.startsWith('['))) {
      try {
        val = JSON.parse(val);
      } catch {
        // keep as string
      }
    }
    clean[targetKey] = val;
  }
  return clean;
}

function outputError(message) {
  console.log(JSON.stringify({ error: message }));
  process.exit(1);
}

async function main() {
  const args = parseArgs();
  const registry = loadRegistry();

  if (args.list) {
    const lines = Object.entries(registry).map(([k, v]) => {
      const desc = v.description || '';
      return `- ${k}: ${desc}`;
    });
    console.log('Available query types:\n' + lines.join('\n'));
    process.exit(0);
  }

  const queryType = args['query-type'];
  if (!queryType || !registry[queryType]) {
    outputError('Invalid or missing --query-type. Run with --list to see available options.');
  }

  const config = registry[queryType];
  const urlTemplate = config.urlTemplate;
  if (!urlTemplate) {
    outputError(`Registry entry "${queryType}" has no urlTemplate.`);
  }

  const url = substituteTemplate(urlTemplate, args.params);

  try {
    const response = await fetch(url);
    if (!response.ok) {
      outputError(`Request failed: ${response.status} ${response.statusText} for ${url}`);
    }

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      const text = await response.text();
      console.log(
        JSON.stringify({
          status: 'success',
          contentType: contentType.split(';')[0],
          data: text.slice(0, 5000),
          truncated: text.length > 5000,
        })
      );
      return;
    }

    const body = await response.json();

    const responsePath = config.responsePath != null ? config.responsePath : 'data';
    const payload = responsePath === '' || responsePath === '.' ? body : get(body, responsePath, null);

    const responseType = config.responseType || 'object';
    const mapping = config.sanitization_mapping;

    if (responseType === 'list' && Array.isArray(payload)) {
      const sanitized = mapping
        ? payload.map((item) => sanitizeItem(item, mapping))
        : payload;
      console.log(
        JSON.stringify(
          { status: 'success', count: sanitized.length, data: sanitized, total: body.data?.total },
          null,
          2
        )
      );
    } else if (responseType === 'list' && payload && typeof payload === 'object' && !Array.isArray(payload)) {
      const list = payload.list != null ? payload.list : payload.Pins || payload.files || [];
      const arr = Array.isArray(list) ? list : [];
      const sanitized = mapping ? arr.map((item) => sanitizeItem(item, mapping)) : arr;
      const extra = {};
      if (payload.total != null) extra.total = payload.total;
      if (payload.nextCursor != null) extra.nextCursor = payload.nextCursor;
      if (payload.next_cursor != null) extra.next_cursor = payload.next_cursor;
      if (payload.LastId != null) extra.lastId = payload.LastId;
      console.log(
        JSON.stringify(
          { status: 'success', count: sanitized.length, data: sanitized, ...extra },
          null,
          2
        )
      );
    } else {
      const out = mapping && payload && typeof payload === 'object' ? sanitizeItem(payload, mapping) : payload;
      console.log(JSON.stringify({ status: 'success', data: out }, null, 2));
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    outputError(`Request error: ${message}`);
  }
}

main();
