// REQ-E-02 / REQ-E-03 static contract tests for the two commerce MetaApps:
// pure-static packaging discipline (relative paths, no build tooling), C3
// contract alignment (envelope codes, endpoints, param names), hybrid load
// with mock snapshots, dual pricing display (ME points + CNY reference ONLY),
// XSS escaping discipline, and the thermometer's READ-ONLY iron rule.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shopDir = path.join(repoRoot, 'METAAPPs', 'personal-goods-shop');
const thermoDir = path.join(repoRoot, 'METAAPPs', 'goods-market-thermometer');

const read = (dir, rel) => fs.readFileSync(path.join(dir, rel), 'utf8');
const PIN_RE = /^[0-9a-f]{64}i\d+$/;
const GLOBAL_META_ID_RE = /^idq1[a-z0-9]{30,64}$/;

function checkAppMd(dir, name, entry) {
  const md = read(dir, 'APP.md');
  assert.match(md, /^---\n[\s\S]*?name: /);
  assert.match(md, new RegExp(`name: ${name}`));
  assert.match(md, new RegExp(`entry: ${entry.replace(/\//g, '\\/')}`));
  assert.match(md, /version: \d+\.\d+\.\d+/);
  assert.match(md, /source-type: bundled-idbots/);
  assert.match(md, /creator-metaid: idbots/);
}

function assertRelativeAssets(html) {
  const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
  for (const ref of refs) {
    assert.ok(!ref.startsWith('/'), `absolute asset path forbidden: ${ref}`);
    assert.ok(!/^https?:/i.test(ref) || ref.startsWith('https://file.metaid.io'), `external asset ref forbidden: ${ref}`);
    assert.ok(!ref.startsWith('//'), `protocol-relative ref forbidden: ${ref}`);
  }
}

test('personal-goods-shop ships APP.md + static assets, relative paths only', () => {
  checkAppMd(shopDir, 'personal-goods-shop', '/personal-goods-shop/index.html');
  for (const file of ['index.html', 'styles.css', 'app.js', 'shop-config.json']) {
    assert.ok(fs.existsSync(path.join(shopDir, file)), `${file} exists`);
  }
  assert.ok(!fs.existsSync(path.join(shopDir, 'package.json')), 'no package.json');
  assert.ok(!fs.existsSync(path.join(shopDir, 'node_modules')), 'no node_modules');
  const html = read(shopDir, 'index.html');
  assert.match(html, /href="\.\/styles\.css"/);
  assert.match(html, /src="\.\/app\.js"/);
  assertRelativeAssets(html);
});

test('goods-market-thermometer ships APP.md + static assets, relative paths only', () => {
  checkAppMd(thermoDir, 'goods-market-thermometer', '/goods-market-thermometer/index.html');
  for (const file of ['index.html', 'styles.css', 'app.js', 'market-config.json']) {
    assert.ok(fs.existsSync(path.join(thermoDir, file)), `${file} exists`);
  }
  assert.ok(!fs.existsSync(path.join(thermoDir, 'package.json')), 'no package.json');
  const html = read(thermoDir, 'index.html');
  assert.match(html, /href="\.\/styles\.css"/);
  assert.match(html, /src="\.\/app\.js"/);
  assertRelativeAssets(html);
});

test('both app.js files parse under node (syntax gate)', () => {
  for (const dir of [shopDir, thermoDir]) {
    execFileSync(process.execPath, ['--check', path.join(dir, 'app.js')], { stdio: 'pipe' });
  }
});

test('shop app.js aligns with Contract C3 endpoints and hybrid loading', () => {
  const js = read(shopDir, 'app.js');
  assert.match(js, /\/api\/mrc721\/market\/listings\?seller=/);
  assert.match(js, /\/api\/mrc721\/address\/item\?globalMetaId=/);
  assert.match(js, /\/api\/bot-homepage\/globalmetaid\/.*\?version=v3/);
  assert.match(js, /\/api\/presence\/globalmetaid\//);
  assert.match(js, /\/api\/mrc721\/ca\/registry/);
  // envelope compatibility: code===0 (market) || code===1 (legacy)
  assert.match(js, /body\.code === 0 \|\| body\.code === 1/);
  // hybrid load: URL param overrides + config + mock snapshot
  assert.match(js, /readUrlParams/);
  assert.match(js, /mockSnapshot/);
  assert.match(js, /shop-config\.json/);
  // presence unknown is not an error
  assert.match(js, /presence-unknown/);
  // dual pricing formatting: milli-ME /1000 and CNY cents /100
  assert.match(js, /amountMilli \/ 1000/);
  assert.match(js, /amountCents \/ 100\)\.toFixed\(2\)/);
  // metafile resolution per agent-browser-metaapp.md §8
  assert.match(js, /metafile-indexer\/api\/v1\/files\/accelerate\/content\//);
  // bridge usage: intent methods + no-arg private chat compose
  assert.match(js, /browser\.commerce\.askTwinToBuy/);
  assert.match(js, /browser\.social\.addFriendPrompt/);
  assert.match(js, /browser\.commerce\.openPromoPack/);
  assert.match(js, /browser\.privateChat\.compose/);
  // external-browser degradation
  assert.match(js, /window\.parent !== window/);
  // XSS discipline
  assert.ok((js.match(/escapeHtml\(/g) || []).length >= 15, 'escapeHtml used for interpolations');
});

test('shop display layer carries no crypto-denominated pricing', () => {
  for (const file of ['app.js', 'index.html', 'styles.css', 'shop-config.json']) {
    const text = read(shopDir, file);
    assert.doesNotMatch(text, /\bSPACE\b/);
    assert.doesNotMatch(text, /\bBTC\b/);
    assert.doesNotMatch(text, /priceSats|price_sats/);
    assert.doesNotMatch(text, /\bsats\b/);
  }
});

test('thermometer is 100% read-only: zero matching/order/payment actions', () => {
  const files = ['app.js', 'index.html', 'styles.css', 'market-config.json'];
  const all = files.map((file) => read(thermoDir, file)).join('\n');
  // no commerce bridge or buy/payment calls anywhere
  assert.doesNotMatch(all, /askTwinToBuy/);
  assert.doesNotMatch(all, /mrc721\.buy/);
  assert.doesNotMatch(all, /nft\.buy/);
  assert.doesNotMatch(all, /goods_buy_with_me/);
  assert.doesNotMatch(all, /me_charge|meCharge/);
  assert.doesNotMatch(all, /nft-escrow\/orders[^/]*POST|POST .*nft-escrow/);
  assert.doesNotMatch(all, /agent-browser:request/); // navigation helper only
  assert.doesNotMatch(all, /metaid\.pin\.write|paylike|paycomment|simplebuzz|simplenote|simplemsg/);
  // buy-style buttons must not exist in the DOM either
  assert.doesNotMatch(all, /购买|下单|付款|锁仓|锁积分/);
  // the only outbound navigation is "visit the seller's shop / profile"
  assert.match(all, /visitShop/);
  assert.match(all, /metaapp:\/\//);
  assert.match(all, /metaid:\/\//);
});

test('thermometer aligns with Contract C3 endpoint signatures', () => {
  const js = read(thermoDir, 'app.js');
  assert.match(js, /\/api\/mrc721\/market\/collections\?caOnly=true/);
  assert.match(js, /\/api\/mrc721\/market\/listings\?collectionPinId=/);
  assert.match(js, /\/api\/mrc721\/market\/trades\?collectionPinId=/);
  assert.match(js, /\/api\/mrc721\/collection\/holders\?pinId=/);
  assert.match(js, /body\.code === 0 \|\| body\.code === 1/);
  // price-ascending sort happens client-side per prices.me.amountMilli
  assert.match(js, /amountMilli[^\n]*Infinity/);
  // trades distinguish verified sources
  assert.match(js, /abs_escrow/);
  assert.match(js, /chain_offer/);
  assert.match(js, /escrow_bot/);
  // holders expose metaid:// profile entry
  assert.match(js, /renderDrawerHolders/);
  // mock snapshot fallback
  assert.match(js, /mockSnapshot/);
});

test('mock snapshots are structurally valid against Contract C3', () => {
  const shopConfig = JSON.parse(read(shopDir, 'shop-config.json'));
  assert.ok(GLOBAL_META_ID_RE.test(shopConfig.ownerGlobalMetaId), 'owner globalMetaId valid');
  assert.ok(typeof shopConfig.shopName === 'string' && shopConfig.shopName.length > 0);
  assert.ok(Array.isArray(shopConfig.featuredItemPinIds));
  for (const pin of shopConfig.featuredItemPinIds) assert.match(pin, PIN_RE);
  const snap = shopConfig.mockSnapshot;
  assert.ok(GLOBAL_META_ID_RE.test(snap.owner.globalMetaId));
  for (const listing of snap.listings) {
    assert.match(listing.itemPinId, PIN_RE);
    assert.equal(typeof listing.prices.me.amountMilli, 'number');
    assert.equal(listing.prices.fiat.currency, 'CNY');
    assert.equal(typeof listing.prices.fiat.amountCents, 'number');
    assert.equal(typeof listing.autoFulfillMe, 'boolean');
    assert.ok('caVerified' in listing);
  }
  for (const holding of snap.holdings) assert.match(holding.itemPinId, PIN_RE);

  const marketConfig = JSON.parse(read(thermoDir, 'market-config.json'));
  const msnap = marketConfig.mockSnapshot;
  for (const collection of msnap.collections) {
    assert.match(collection.collectionPinId, PIN_RE);
    assert.equal(typeof collection.floorPriceMeMilli, 'number');
    assert.equal(typeof collection.medianPriceMeMilli, 'number');
    assert.equal(typeof collection.floorPriceCnyCents, 'number');
    assert.equal(typeof collection.listedCount, 'number');
    assert.ok('burnedCount' in collection);
    assert.ok(collection.tradeStats && typeof collection.tradeStats.trades24h === 'number');
  }
  for (const listing of msnap.listings) assert.match(listing.itemPinId, PIN_RE);
  for (const trade of msnap.trades) {
    assert.match(trade.txId, /^[0-9a-f]{64}$/);
    assert.ok(['abs_escrow', 'chain_offer', 'escrow_bot'].includes(trade.verifiedSource));
  }
  for (const holder of msnap.holders) assert.ok(GLOBAL_META_ID_RE.test(holder.globalMetaId));
});
