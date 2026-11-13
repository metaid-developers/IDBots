/**
 * Twin product primer: the bundled IDBots/MetaID/AI-Internet knowledge every
 * Twin session carries, so first questions ("what can I do here?", "Studio or
 * BotWorks?") never depend on a lucky search.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  readTwinProductPrimer,
  buildTwinProductPrimerSection,
  twinProductPrimerPath,
} = require('../dist-electron/main/libs/twinProductPrimer.js');

const repoRoot = path.resolve(import.meta.dirname, '..');
const read = (relative) => fs.readFileSync(path.join(repoRoot, relative), 'utf8');

test('the primer carries the facts a new owner asks about first', () => {
  const primer = readTwinProductPrimer(repoRoot);
  assert.ok(primer.length > 1500, 'primer is present');
  for (const needle of [
    'https://idbots.ai',
    'https://openagentinternet.org',
    '**Studio**',
    '**BotWorks**',
    'recommended for most people',
    'programming',
    'MetaID',
    'Twin Bot',
    'Worker Bots',
    'Settings → Model',
    'search_metaweb',
    'What can I do here?',
  ]) {
    assert.ok(primer.includes(needle), `primer mentions ${needle}`);
  }
  assert.doesNotMatch(primer, /\d+\s*(积分|credits|tokens?\/day|元|USD)/i, 'no quota numbers or prices');
});

test('the primer stays short enough to ride every Twin turn', () => {
  const primer = readTwinProductPrimer(repoRoot);
  assert.ok(primer.length < 6000, `${primer.length} chars`);
});

test('the section wraps the primer and drops out when the file is missing', () => {
  const section = buildTwinProductPrimerSection('hello');
  assert.match(section, /^## IDBots Product Primer/);
  assert.ok(section.includes('<idbots_product_primer>\nhello\n</idbots_product_primer>'));
  assert.equal(buildTwinProductPrimerSection('  '), '');
  assert.equal(readTwinProductPrimer(path.join(repoRoot, 'no-such-root')), '');
  assert.equal(twinProductPrimerPath('/app'), path.join('/app', 'sandbox', 'agent-runner', 'IDBotsPrimer.md'));
});

test('wiring: Twin-only injection on both prompt paths, and the file ships in the package', () => {
  const runner = read('src/main/libs/coworkRunner.ts');
  const method = runner.slice(runner.indexOf('private buildTwinProductPrimerPrompt('));
  assert.ok(method.slice(0, 400).includes("if (!this.isTwinSession(sessionId)) return '';"), 'Twin sessions only');
  const calls = runner.split('this.buildTwinProductPrimerPrompt(sessionId),').length - 1;
  assert.equal(calls, 2, 'injected on session start and on continue');
  const builder = JSON.parse(read('electron-builder.json'));
  assert.ok(builder.files.includes('sandbox/agent-runner/IDBotsPrimer.md'), 'packaged with the app');
});
