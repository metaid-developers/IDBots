#!/usr/bin/env node
/**
 * MetaBot Omni-Reader (TypeScript source).
 * The canonical runtime script is omni-reader.js, which is config-driven via api_registry.json
 * (urlTemplate, responsePath, responseType). Use omni-reader.js for --list and --query-type.
 */

import { parseArgs } from 'util';
import fs from 'fs';
import path from 'path';

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

/** Safe deep get: get value at dot-separated path, e.g. get(obj, 'data.list') */
function get(obj: unknown, pathStr: string, defaultValue: unknown = null): unknown {
  if (obj == null || typeof pathStr !== 'string' || pathStr === '') return defaultValue;
  const keys = pathStr.split('.');
  let current: unknown = obj;
  for (const key of keys) {
    if (current == null || typeof current !== 'object') return defaultValue;
    current = (current as Record<string, unknown>)[key];
  }
  return current === undefined ? defaultValue : current;
}

interface RegistryEntry {
  description: string;
  baseUrl: string;
  response_list_path: string;
  sanitization_mapping: Record<string, string>;
}

interface ParsedArgs {
  list?: boolean;
  'query-type'?: string;
  size?: number;
  path?: string;
  'target-id'?: string;
}

function loadRegistry(): Record<string, RegistryEntry> {
  const registryPath = path.join(__dirname, '../api_registry.json');
  const raw = fs.readFileSync(registryPath, 'utf-8');
  return JSON.parse(raw) as Record<string, RegistryEntry>;
}

function parseSize(val: string | undefined): number {
  if (val == null) return 10;
  const n = parseInt(val, 10);
  if (Number.isNaN(n) || n < 1 || n > 100) return 10;
  return n;
}

function sanitizeItem(
  item: Record<string, unknown>,
  mapping: Record<string, string>
): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const [targetKey, sourcePath] of Object.entries(mapping)) {
    let val = get(item, sourcePath, null);
    if (typeof val === 'string' && (val.startsWith('{') || val.startsWith('['))) {
      try {
        val = JSON.parse(val) as unknown;
      } catch {
        // keep as string
      }
    }
    clean[targetKey] = val;
  }
  return clean;
}

function outputError(message: string): void {
  console.log(JSON.stringify({ error: message }));
  process.exit(1);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      list: { type: 'boolean', short: 'l' },
      'query-type': { type: 'string' },
      size: { type: 'string' },
      path: { type: 'string' },
      'target-id': { type: 'string' },
    },
    allowPositionals: true,
  });

  const args = values as ParsedArgs;
  const registry = loadRegistry();

  if (args.list) {
    const lines = Object.entries(registry).map(
      ([k, v]) => `- ${k}: ${v.description}`
    );
    console.log('Available query types:\n' + lines.join('\n'));
    process.exit(0);
  }

  const queryType = args['query-type'];
  if (!queryType || !registry[queryType]) {
    outputError(
      'Invalid query-type. Run with --list to see available options.'
    );
  }
  const config: RegistryEntry = registry[queryType!];
  const size = parseSize(typeof args.size === 'string' ? args.size : undefined);

  let url = `${config.baseUrl}?size=${size}`;
  if (args.path != null && args.path !== '') {
    url += `&path=${encodeURIComponent(args.path)}`;
  }
  if (args['target-id'] != null && args['target-id'] !== '') {
    url += `&targetId=${encodeURIComponent(args['target-id'])}`;
  }

  try {
    const response = await fetch(url);
    if (!response.ok) {
      outputError(
        `Request failed: ${response.status} ${response.statusText} for ${url}`
      );
    }
    const data = (await response.json()) as unknown;
    const rawList = get(data, config.response_list_path, []);
    const list = Array.isArray(rawList) ? rawList : [];

    const sanitizedData = list.map((item: Record<string, unknown>) =>
      sanitizeItem(item, config.sanitization_mapping)
    );

    console.log(
      JSON.stringify(
        { status: 'success', count: sanitizedData.length, data: sanitizedData },
        null,
        2
      )
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    outputError(`Request error: ${message}`);
  }
}

main();
