// zh/en parity for the ME billing i18n namespaces (2026-11-11 hardening).
//
// The desktop i18n file carries two hand-maintained locale blocks; nothing
// guarded the me*/quota* copy, so a key added to one locale silently
// rendered as the raw key (or stale fallback) in the other. These tests
// pin, for the billing namespaces only (me*, quota*, freeQuota*,
// usageCredits*, trafficErr*):
//   1. key-set parity across zh and en (missing on either side fails);
//   2. placeholder parity ({date}, {n}, …) for keys present in both —
//      a renamed placeholder breaks .replace() silently;
//   3. no empty values.
//
// Run: node --test tests/meI18nParity.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const source = fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/renderer/services/i18n.ts'),
  'utf8',
);

const NAMESPACES = /^(me|quota|freeQuota|usageCredits|trafficErr)/;

/** Unquoted camelCase keys with single-quoted values, 4-space indent. */
const KEY_RE = /^    ([A-Za-z][A-Za-z0-9]*): '((?:[^'\\]|\\.)*)',?\s*$/gm;

function parseBlock(block) {
  const map = new Map();
  let match;
  KEY_RE.lastIndex = 0;
  while ((match = KEY_RE.exec(block)) !== null) {
    map.set(match[1], match[2]);
  }
  return map;
}

const zhStart = source.indexOf('\n  zh: {');
const enStart = source.indexOf('\n  en: {');
assert.ok(zhStart > 0 && enStart > zhStart, 'i18n.ts must carry a zh block before the en block');
const zh = parseBlock(source.slice(zhStart, enStart));
const en = parseBlock(source.slice(enStart));

const scopedKeys = (map) => [...map.keys()].filter((key) => NAMESPACES.test(key));

test('billing namespaces carry the same key set in zh and en', () => {
  const zhKeys = new Set(scopedKeys(zh));
  const enKeys = new Set(scopedKeys(en));
  const missingInEn = [...zhKeys].filter((key) => !enKeys.has(key));
  const missingInZh = [...enKeys].filter((key) => !zhKeys.has(key));
  assert.deepEqual(missingInEn, [], `keys missing in the EN block: ${missingInEn.join(', ')}`);
  assert.deepEqual(missingInZh, [], `keys missing in the ZH block: ${missingInZh.join(', ')}`);
  assert.ok(zhKeys.size > 100, 'the billing namespaces should match a substantial key set — did the parser break?');
});

test('placeholders match across locales for every shared billing key', () => {
  const PLACEHOLDER_RE = /\{[A-Za-z0-9]+\}/g;
  const problems = [];
  for (const key of scopedKeys(zh)) {
    const zhValue = zh.get(key);
    const enValue = en.get(key);
    if (zhValue === undefined || enValue === undefined) continue;
    const zhTokens = (zhValue.match(PLACEHOLDER_RE) ?? []).sort();
    const enTokens = (enValue.match(PLACEHOLDER_RE) ?? []).sort();
    if (JSON.stringify(zhTokens) !== JSON.stringify(enTokens)) {
      problems.push(`${key}: zh ${JSON.stringify(zhTokens)} vs en ${JSON.stringify(enTokens)}`);
    }
  }
  assert.deepEqual(problems, [], `placeholder drift: ${problems.join(' | ')}`);
});

test('no empty billing values in either locale', () => {
  for (const key of scopedKeys(zh)) assert.ok(zh.get(key).length > 0, `empty zh value: ${key}`);
  for (const key of scopedKeys(en)) assert.ok(en.get(key).length > 0, `empty en value: ${key}`);
});
