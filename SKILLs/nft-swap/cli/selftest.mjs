#!/usr/bin/env node
/**
 * Self-test for the issuer import gate (public fixture mnemonic only —
 * abandon…about, the same throwaway BIP39 vector used by repo tests).
 *
 * Covers:
 *  1. single-line commented group selected by keyword; ACTIVE group skipped;
 *  2. address gate positive (236 ground truth) and negative (wrong address);
 *  3. wrapped (multi-line) group recovered by the join fallback;
 *  4. binding signature verifies against the issuer address;
 *  5. CLI refuses a wrong file with ISSUER_ADDRESS_MISMATCH and never prints
 *     any mnemonic word.
 *
 * Run: node SKILLs/nft-swap/cli/selftest.mjs
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { mvc } = require('meta-contract');

const FIXTURE_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const OTHER_MNEMONIC = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const PATH_236 = "m/44'/236'/0'/0/0";
const EXPECTED_236_ADDRESS = '1K6LZdwpKT5XkEZo2T2kW197aMXYbYMc4f';

const { loadIssuerMnemonic, deriveMvcAddress, deriveChatPubKey, signIssuerBinding } = await import(
  path.join(__dirname, 'lib/issuer-source.mjs')
);
const { ISSUER_CONFIG, issuerBindingMessage } = await import(
  path.join(__dirname, 'lib/issuer-config.mjs')
);

const tmp = mkdtempSync(path.join(tmpdir(), 'nft-swap-selftest-'));
let failures = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`  ✔ ${name}`);
  } catch (error) {
    failures++;
    console.log(`  ✘ ${name}: ${error.message}`);
  }
};

// Ground truth: fixture mnemonic derives the known 236 address.
check('fixture 236 ground truth', () => {
  const derived = deriveMvcAddress(FIXTURE_MNEMONIC, PATH_236);
  assert.equal(derived.address, EXPECTED_236_ADDRESS);
});

// Decoy notes file: an ACTIVE fixture group (must be skipped) plus a
// commented wrong group (different keyword) plus the commented fixture group.
const decoyPath = path.join(tmp, 'decoy_issuer.md');
await writeFile(
  decoyPath,
  [
    '# issuer notes (decoy)',
    '',
    `${FIXTURE_MNEMONIC}`,
    '',
    '<!--',
    '# retired groups',
    `# ${OTHER_MNEMONIC}`,
    `# ${FIXTURE_MNEMONIC}`,
    '-->',
    '',
  ].join('\n'),
  'utf8',
);

check('single-line gate: commented keyword group wins over active twin', () => {
  const result = loadIssuerMnemonic({
    filePath: decoyPath,
    keyword: 'abandon',
    expectAddress: EXPECTED_236_ADDRESS,
    path: PATH_236,
  });
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics ?? result.error));
  assert.equal(result.evidence.derivedAddress, EXPECTED_236_ADDRESS);
  assert.equal(result.evidence.sourceLine, 8); // commented fixture line, not line 3
  assert.equal(result.evidence.diagnostics.keywordCandidates, 1);
});

check('address gate rejects the wrong issuer address', () => {
  const result = loadIssuerMnemonic({
    filePath: decoyPath,
    keyword: 'abandon',
    expectAddress: ISSUER_CONFIG.issuerAddress, // real address; decoy derives elsewhere
    path: PATH_236,
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'ISSUER_ADDRESS_MISMATCH');
  assert.equal(result.diagnostics.keywordCandidates, 1);
  assert.equal(result.diagnostics.keywordVerdicts[0].derivedAddress, EXPECTED_236_ADDRESS);
});

check('binding signature verifies against the signing address', () => {
  const loaded = loadIssuerMnemonic({
    filePath: decoyPath,
    keyword: 'abandon',
    expectAddress: EXPECTED_236_ADDRESS,
    path: PATH_236,
  });
  assert.equal(loaded.ok, true);
  const key = deriveMvcAddress(loaded.mnemonic, PATH_236);
  const binding = signIssuerBinding(key.privateKey, EXPECTED_236_ADDRESS);
  const verified = new mvc.Message(issuerBindingMessage(EXPECTED_236_ADDRESS)).verify(
    EXPECTED_236_ADDRESS,
    binding.signature,
  );
  assert.equal(verified, true);
  const chat = deriveChatPubKey(key.privateKey);
  assert.match(chat, /^04[0-9a-f]{128}$/);
});

// Wrapped group: fixture split across two commented lines (no keyword label,
// each half too short to be a candidate alone) — the join fallback must
// rebuild the 12-word group inside the block comment.
const wrappedPath = path.join(tmp, 'wrapped_issuer.md');
await writeFile(
  wrappedPath,
  [
    '<!--',
    `# ${FIXTURE_MNEMONIC.split(' ').slice(0, 6).join(' ')}`,
    `${FIXTURE_MNEMONIC.split(' ').slice(6).join(' ')}`,
    '-->',
  ].join('\n'),
  'utf8',
);

check('join fallback recovers a wrapped 12-word group', () => {
  const result = loadIssuerMnemonic({
    filePath: wrappedPath,
    keyword: 'abandon',
    expectAddress: EXPECTED_236_ADDRESS,
    path: PATH_236,
  });
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics ?? result.error));
  assert.equal(result.evidence.wordCount, 12);
  assert.equal(result.evidence.derivedAddress, EXPECTED_236_ADDRESS);
});

// CLI end-to-end: wrong file must exit non-zero, leak nothing, and report the
// structured error.
check('CLI refuses decoy with real gate and leaks no mnemonic words', () => {
  const cli = path.join(__dirname, 'import-issuer.mjs');
  let stdout = '';
  let code = 0;
  try {
    stdout = execFileSync('node', [cli, '--file', decoyPath], { encoding: 'utf8' });
  } catch (error) {
    code = error.status ?? 1;
    stdout = error.stdout ?? '';
  }
  assert.notEqual(code, 0, 'CLI must fail on a wrong-address file');
  assert.match(stdout, /ISSUER_ADDRESS_MISMATCH|GATE_CHECKS_FAILED/);
  for (const word of [...FIXTURE_MNEMONIC.split(' '), ...OTHER_MNEMONIC.split(' ')]) {
    if (word.length >= 4) {
      assert.ok(!stdout.includes(word), `stdout must not contain mnemonic word "${word}"`);
    }
  }
});

rmSync(tmp, { recursive: true, force: true });
console.log(failures === 0 ? 'selftest: all green' : `selftest: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
