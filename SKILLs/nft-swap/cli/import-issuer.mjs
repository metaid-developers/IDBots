#!/usr/bin/env node
/**
 * M0 gate: import & verify the legacy-NFT issuer mnemonic (PRD §8 M0, §9b).
 *
 * Reads the owner-ratified source file INSIDE this process, selects the
 * commented keyword group, derives at the 236 issuer path and gates on the
 * ratified issuer address. Prints PUBLIC FINGERPRINT EVIDENCE ONLY — the
 * mnemonic never reaches stdout, logs, or any artifact.
 *
 * Usage:
 *   node cli/import-issuer.mjs --file /path/to/metacontract_nft_issuer.md [--keyword endorse]
 *
 * Exit codes: 0 = verified; 1 = gate failed (see JSON.error).
 */

import { createRequire } from 'node:module';
import { loadIssuerMnemonic, deriveMvcAddress, deriveChatPubKey, computeMetaId, signIssuerBinding } from './lib/issuer-source.mjs';
import { ISSUER_CONFIG, issuerBindingMessage } from './lib/issuer-config.mjs';

const require_ = createRequire(import.meta.url);
const { mvc } = require_('meta-contract');

function parseArgs(argv) {
  const args = { keyword: 'endorse' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--file') args.file = argv[++i];
    else if (argv[i] === '--keyword') args.keyword = argv[++i];
    else if (argv[i] === '--keyword-file') args.keywordFile = argv[++i];
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.file) {
    console.log(JSON.stringify({ ok: false, error: 'MISSING_ARG', detail: '--file is required' }));
    process.exit(1);
  }

  const loaded = loadIssuerMnemonic({
    filePath: args.file,
    keyword: args.keyword,
    expectAddress: ISSUER_CONFIG.issuerAddress,
    path: ISSUER_CONFIG.issuerPath,
  });
  if (!loaded.ok) {
    console.log(JSON.stringify({ ok: false, error: loaded.error, detail: loaded.detail, diagnostics: loaded.diagnostics }, null, 2));
    process.exit(1);
  }

  // In-process derived handles (never printed).
  const mnemonic = loaded.mnemonic;
  const vault = deriveMvcAddress(mnemonic, ISSUER_CONFIG.vaultPath);
  const issuerKey = deriveMvcAddress(mnemonic, ISSUER_CONFIG.issuerPath);
  const legacyMvcKey = deriveMvcAddress(mnemonic, "m/44'/10001'/0'/0/0");
  const chatPubKey = deriveChatPubKey(issuerKey.privateKey);
  const chatPubKeyLegacyMvc = deriveChatPubKey(legacyMvcKey.privateKey);
  const metaId = computeMetaId(ISSUER_CONFIG.issuerAddress);
  const binding = signIssuerBinding(issuerKey.privateKey, ISSUER_CONFIG.issuerAddress);

  // Independent verify of the binding signature against the issuer ADDRESS.
  const bindingVerified = (() => {
    try {
      return new mvc.Message(issuerBindingMessage(ISSUER_CONFIG.issuerAddress)).verify(
        ISSUER_CONFIG.issuerAddress,
        binding.signature,
      );
    } catch {
      return false;
    }
  })();

  const evidence = {
    ok: true,
    stage: 'import-issuer-gate',
    file: loaded.evidence.sourceFile,
    sourceLine: loaded.evidence.sourceLine,
    wordCount: loaded.evidence.wordCount,
    issuerAddress: ISSUER_CONFIG.issuerAddress,
    derivedAddress: loaded.evidence.derivedAddress,
    addressMatches: loaded.evidence.derivedAddress === ISSUER_CONFIG.issuerAddress,
    metaId,
    expectedGlobalMetaId: ISSUER_CONFIG.expectedGlobalMetaId,
    chatPubKeyMatchesOnChain: chatPubKey === ISSUER_CONFIG.expectedChatPubKey,
    chatKeyDiagnosis: {
      // Which derivation registered the on-chain chat key? Fingerprinted
      // prefixes are public derived material (nothing reversible).
      derivedAt236Prefix: chatPubKey.slice(0, 16),
      derivedAt10001Prefix: chatPubKeyLegacyMvc.slice(0, 16),
      onChainPrefix: ISSUER_CONFIG.expectedChatPubKey.slice(0, 16),
      matchesAt236: chatPubKey === ISSUER_CONFIG.expectedChatPubKey,
      matchesAt10001: chatPubKeyLegacyMvc === ISSUER_CONFIG.expectedChatPubKey,
    },
    vault: {
      path: ISSUER_CONFIG.vaultPath,
      address: vault.address,
    },
    bindingSignature: {
      message: binding.message,
      signature: binding.signature,
      verified: bindingVerified === true,
    },
    diagnostics: loaded.evidence.diagnostics,
  };

  // Defense in depth: assert no secret-shaped string slipped into evidence.
  // (The source-file path is excluded from the scan — an innocent word like
  // "server" may legitimately appear inside a directory name.)
  const scanText = JSON.stringify({ ...evidence, file: '' });
  for (const word of mnemonic.split(' ')) {
    if (word.length >= 4 && scanText.includes(word)) {
      console.log(JSON.stringify({ ok: false, error: 'EVIDENCE_CONTAMINATION', detail: 'a mnemonic word appeared in evidence output; refusing' }));
      process.exit(1);
    }
  }

  console.log(JSON.stringify(evidence, null, 2));
  // Address + binding signature are hard gates. The chat-key check is
  // DIAGNOSTIC (the on-chain chat key may have been registered from the
  // legacy 10001 derivation — see chatKeyDiagnosis) — reported, not fatal.
  if (!evidence.addressMatches || !evidence.bindingSignature.verified) {
    console.log(JSON.stringify({ ok: false, error: 'GATE_CHECKS_FAILED', detail: 'see evidence above' }));
    process.exit(1);
  }
}

main().catch((error) => {
  console.log(JSON.stringify({ ok: false, error: 'UNEXPECTED', detail: error instanceof Error ? error.message : String(error) }));
  process.exit(1);
});
