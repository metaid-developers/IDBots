// Compliance red-line scan (REQ-E-04 / REQ-E-05): zero financial-return
// promise words across the promo pack components, both commerce MetaApps and
// the on-chain publish payloads; plus no crypto-denominated pricing tokens in
// the two MetaApps' user-facing layers.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const commerceDir = path.join(repoRoot, 'src', 'renderer', 'components', 'commerce');
const shopDir = path.join(repoRoot, 'METAAPPs', 'personal-goods-shop');
const thermoDir = path.join(repoRoot, 'METAAPPs', 'goods-market-thermometer');
const payloadDir = path.join(repoRoot, 'docs', 'nft-commerce-loop', 'onchain-publish-payloads');

const BANNED = ['会涨', '暴涨', '早买早赚', '稳赚', '翻倍', '保本', '升值空间', '投资回报'];
const CRYPTO_PRICE_TOKENS = [/\bSPACE\b/, /\bBTC\b/, /priceSats/, /price_sats/];

function listFiles(dir, exts) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, exts));
    else if (exts.some((ext) => entry.name.endsWith(ext))) out.push(full);
  }
  return out;
}

test('banned compliance words: zero hits in commerce components, MetaApps and payloads', () => {
  const targets = [
    ...listFiles(commerceDir, ['.ts', '.tsx']),
    ...listFiles(shopDir, ['.html', '.css', '.js', '.json', '.md']),
    ...listFiles(thermoDir, ['.html', '.css', '.js', '.json', '.md']),
    ...listFiles(payloadDir, ['.md']),
  ];
  assert.ok(targets.length >= 12, `expected a real scan surface, got ${targets.length} files`);
  const hits = [];
  for (const file of targets) {
    const text = fs.readFileSync(file, 'utf8');
    for (const word of BANNED) {
      if (text.includes(word)) hits.push(`${path.relative(repoRoot, file)}: ${word}`);
    }
  }
  assert.deepEqual(hits, [], `banned words found:\n${hits.join('\n')}`);
});

test('crypto pricing tokens: zero hits in the two MetaApps (user-facing layers)', () => {
  const targets = [
    ...listFiles(shopDir, ['.html', '.css', '.js', '.json']),
    ...listFiles(thermoDir, ['.html', '.css', '.js', '.json']),
  ];
  const hits = [];
  for (const file of targets) {
    const text = fs.readFileSync(file, 'utf8');
    for (const token of CRYPTO_PRICE_TOKENS) {
      if (token.test(text)) hits.push(`${path.relative(repoRoot, file)}: ${token}`);
    }
  }
  assert.deepEqual(hits, [], `crypto pricing tokens found:\n${hits.join('\n')}`);
});

test('promo templates keep the compliant angles (upgrade / AI-runs-shop / provenance)', () => {
  const i18n = fs.readFileSync(path.join(commerceDir, 'commercePromoI18n.ts'), 'utf8');
  for (const required of ['免费 1:1 升级', '24 小时自动接单', '上链后删不掉、抄不走', 'free, into AI-internet digital goods']) {
    assert.ok(i18n.includes(required), `missing compliant angle: ${required}`);
  }
});
