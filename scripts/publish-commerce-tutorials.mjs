#!/usr/bin/env node
/**
 * publish-commerce-tutorials.mjs — validate and (optionally) build on-chain
 * publish requests for the 3 AI-internet commerce tutorial payloads.
 *
 * DEFAULT IS DRY-RUN: `node scripts/publish-commerce-tutorials.mjs --dry-run`
 * validates payload integrity (front-matter, bilingual keywords, contract
 * tool names, byte size), scans for banned financial-promise words, and
 * reports unresolved template placeholders. Exit 0 = all green.
 *
 * REAL PUBLISH REQUESTS are only BUILT with an explicit
 * `--execute --bot-id <id>` (request envelopes are written to
 * docs/nft-commerce-loop/onchain-publish-payloads/.build/ for the operator
 * to hand to the metabot posting flow). This script itself NEVER broadcasts;
 * actually publishing stays an operator decision (WS-E delivery contract).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const payloadDir = path.join(repoRoot, 'docs', 'nft-commerce-loop', 'onchain-publish-payloads');
const buildDir = path.join(payloadDir, '.build');

const PAYLOADS = [
  {
    file: '01-legacy-nft-swap-guide.md',
    title: 'IDBots 官方旧版藏品免费升级兑换指南',
    tags: ['metaweb', 'agent-goods', 'nft-swap', 'tutorial'],
    mustContain: [
      'nft_swap_verify_official_station',
      'nft_swap_submit_batch',
      '/protocols/idbots-nft-ca',
      'a3989523201851b625eedc2ef09dc837a7be737a',
      '075a1d198772e71ad2ca8fd5fb5f0fb1bd7fd680',
      'idq1gtxzx45ktj8s738s6wjak0ha27d98g8h2n059n',
      'MetaBot Avatar',
      'swap',
      '兑换',
      '升级',
    ],
    maxBytes: 60_000,
    templatePlaceholder: null,
  },
  {
    file: '02-build-personal-shop-guide.md',
    title: '如何为你的主人一键发布个人数字商品小店 MetaApp',
    tags: ['metaweb', 'agent-goods', 'personal-shop', 'metaapp', 'mrc721sell'],
    mustContain: [
      'bot_browser_publish_app',
      '--set-homepage-metaapp',
      'shop-config.json',
      'search_metaweb',
      '/protocols/mrc721sell',
      '"me": { "amountMilli"',
      '"fiat": { "currency": "CNY", "amountCents"',
      'autoFulfillMe',
      'shopMetaAppPinId',
      'acceptedCurrencies',
      'settlement',
      '个人小店',
      '上架',
    ],
    maxBytes: 60_000,
    templatePlaceholder: '{{PERSONAL_GOODS_SHOP_TEMPLATE_PIN_ID}}',
  },
  {
    file: '03-agent-goods-buy-and-trade-guide.md',
    title: 'AI 互联网数字商品寻源、议价与积分/担保交易全指南',
    tags: ['metaweb', 'agent-goods', 'trade', 'escrow', 'tutorial'],
    mustContain: [
      'goods_market_summary',
      'goods_market_search',
      'goods_holder_lookup',
      'goods_buy_with_me',
      'goods_send_inquiry',
      'tradeSpendableMilli',
      '/v1/me/nft-escrow/orders',
      'FROZEN_AWAITING_DELIVERY',
      'SETTLED',
      'EXPIRED_REFUNDED',
      'idbots-trade-v1',
      'GOODS_INQUIRY_V1',
      'ME_ESCROW_LOCKED_V1',
      'fiat-escrow',
      '托管',
      '地板价',
      'floor price',
    ],
    maxBytes: 60_000,
    templatePlaceholder: null,
  },
];

/** Compliance red line: zero financial-return promise words in payloads. */
const BANNED_WORDS = ['会涨', '暴涨', '早买早赚', '稳赚', '翻倍', '保本', '升值空间', '投资回报'];

const args = process.argv.slice(2);
const flags = new Set(args);
const templatePinIdx = args.indexOf('--template-pin');
const templatePin = templatePinIdx !== -1 ? args[templatePinIdx + 1] : '';
const botIdIdx = args.indexOf('--bot-id');
const botId = botIdIdx !== -1 ? args[botIdIdx + 1] : '';
const execute = flags.has('--execute');

function fail(message) {
  console.error(`[publish-commerce-tutorials] FAIL: ${message}`);
  process.exit(1);
}

if (execute && !botId) {
  fail('--execute requires --bot-id <id>');
}
if (templatePinIdx !== -1 && !/^[0-9a-f]{64}i\d+$/.test(templatePin || '')) {
  fail('--template-pin must be a 64-hex pin id with an output index');
}

const PIN_ID_RE = /^[0-9a-f]{64}i\d+$/;

const report = { dryRun: !execute, payloads: [], bannedHits: [], unresolvedPlaceholders: [] };

for (const spec of PAYLOADS) {
  const filePath = path.join(payloadDir, spec.file);
  if (!fs.existsSync(filePath)) fail(`missing payload: ${spec.file}`);
  let raw = fs.readFileSync(filePath, 'utf8');
  const originalBytes = Buffer.byteLength(raw, 'utf8');

  if (spec.templatePlaceholder) {
    if (templatePin) {
      if (!raw.includes(spec.templatePlaceholder)) {
        fail(`${spec.file}: template placeholder ${spec.templatePlaceholder} not found for substitution`);
      }
      raw = raw.split(spec.templatePlaceholder).join(templatePin);
    } else if (!raw.includes(spec.templatePlaceholder)) {
      report.unresolvedPlaceholders.push(`${spec.file}: ${spec.templatePlaceholder} missing (expected in payload)`);
    }
  }

  const bytes = Buffer.byteLength(raw, 'utf8');
  if (bytes > spec.maxBytes) fail(`${spec.file}: ${bytes} bytes exceeds limit ${spec.maxBytes}`);
  if (bytes < 2000) fail(`${spec.file}: ${bytes} bytes is too small for a tutorial payload`);
  if (!raw.startsWith('# ')) fail(`${spec.file}: missing H1 title`);
  if (raw.includes('\r\n')) fail(`${spec.file}: CRLF line endings are not allowed`);

  const missing = spec.mustContain.filter((needle) => !raw.includes(needle));
  if (missing.length) fail(`${spec.file}: missing required contract strings: ${missing.join(', ')}`);

  for (const word of BANNED_WORDS) {
    if (raw.includes(word)) report.bannedHits.push(`${spec.file}: banned word "${word}"`);
  }

  report.payloads.push({ file: spec.file, title: spec.title, tags: spec.tags, bytes });
}

if (report.bannedHits.length) fail(`banned compliance words found:\n  ${report.bannedHits.join('\n  ')}`);

if (execute) {
  fs.mkdirSync(buildDir, { recursive: true });
  for (const entry of report.payloads) {
    const raw = fs.readFileSync(path.join(payloadDir, entry.file), 'utf8');
    const content = templatePin ? raw.split('{{PERSONAL_GOODS_SHOP_TEMPLATE_PIN_ID}}').join(templatePin) : raw;
    const request = {
      protocol: 'simplenote',
      operation: 'create',
      botId,
      payload: {
        title: entry.title,
        content,
        contentType: 'text/markdown',
        tags: entry.tags,
      },
      note: `built ${new Date().toISOString()} — hand off to the metabot posting flow; this script never broadcasts`,
    };
    const outFile = path.join(buildDir, entry.file.replace(/\.md$/, '.publish-request.json'));
    fs.writeFileSync(outFile, `${JSON.stringify(request, null, 2)}\n`, 'utf8');
    entry.requestFile = path.relative(repoRoot, outFile);
  }
  if (templatePin && !PIN_ID_RE.test(templatePin)) fail('unreachable: template pin validated above');
}

console.log(`[publish-commerce-tutorials] mode=${execute ? 'EXECUTE (build requests only, no broadcast)' : 'DRY-RUN'}`);
for (const entry of report.payloads) {
  console.log(`  ok  ${entry.file}  ${entry.bytes} B${entry.requestFile ? ` -> ${entry.requestFile}` : ''}`);
}
if (report.unresolvedPlaceholders.length) {
  for (const line of report.unresolvedPlaceholders) console.log(`  placeholder: ${line}`);
}
console.log(`[publish-commerce-tutorials] banned-word scan: clean (${BANNED_WORDS.length} words x ${PAYLOADS.length} files)`);
console.log('[publish-commerce-tutorials] PASS');
process.exit(0);
