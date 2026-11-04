/**
 * Issuer secret handling for the nft-swap pilot (PRD §9/§9b hard constraints).
 *
 * RULES ENCODED HERE — do not weaken:
 * - The mnemonic never leaves this module's return value. Nothing here may
 *   console.log / write / stringify the mnemonic.
 * - The source file is read inside this process only (owner-ratified handoff:
 *   "worker direct-read of the existing file", 2026-11-05).
 * - Every consumer gates on the issuer address: a parse only succeeds when the
 *   derived 236-path address equals the ratified issuer address, so a wrong
 *   group/wrong file can never pass silently.
 * - All log-friendly outputs are public fingerprints only (address,
 *   globalmetaid, chat pubkey, signature, word counts).
 */

import { createRequire } from 'node:module';
import * as crypto from 'node:crypto';

const require = createRequire(import.meta.url);
const { mvc } = require('meta-contract');
const bip39 = require('@scure/bip39');
const { wordlist } = require('@scure/bip39/wordlists/english');

const NETWORK = mvc.Networks.livenet;
const COMMENT_PREFIX_RE = /^\s*(?:\/\*+|\/\/+|#+|\*+|<!--+|-->+)/;

/** Normalize a mnemonic string: lowercase, single-space, trim. */
function normalizeMnemonicText(raw) {
  return String(raw || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Notes files glue punctuation/case onto mnemonic words ("endorse:", "01.word",
 * quotes). Strip non-letter edges per token; inner characters must stay
 * letters or the word is discarded (bip39 validation is the next gate anyway).
 */
function cleanWordToken(token) {
  return String(token || '').toLowerCase().replace(/^[^a-z]+|[^a-z]+$/g, '');
}

/** True when a (stripped) line looks like a bare 12/24-word BIP39 group. */
function isWordGroupLine(stripped) {
  const words = stripped.split(' ');
  if (words.length !== 12 && words.length !== 24) return false;
  return words.every((word) => /^[a-z]+$/.test(word));
}

/**
 * Parse candidate mnemonic groups out of a notes file WITHOUT keeping any
 * content around beyond what validation needs.
 *
 * Entry-line shape (measured 2026-11-05 on the owner's real file): comment
 * marker + first mnemonic word glued with punctuation + remaining words +
 * a trailing non-word tag token. So per commented line we slide 12/24-word
 * windows over the cleaned token sequence; every candidate is later gated by
 * the ratified issuer address, so a wrong window can never pass.
 */
function extractCandidates(fileText, keyword, { anyFirstWord = false } = {}) {
  const lines = fileText.split(/\r?\n/);
  const candidates = [];
  let inHtmlComment = false;
  let commentedCount = 0;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const opensBlock = raw.includes('<!--');
    const closesBlock = raw.includes('-->');
    const isCommented = COMMENT_PREFIX_RE.test(raw) || inHtmlComment || opensBlock;
    if (opensBlock) inHtmlComment = true;
    if (closesBlock && !opensBlock) inHtmlComment = false;

    const stripped = raw.replace(COMMENT_PREFIX_RE, ' ').trim();
    if (!stripped) continue;
    if (isCommented) commentedCount++;
    // Owner spec: the issuer group lives in the COMMENT layer. Active groups
    // are never candidates (they belong to other identities).
    if (!isCommented) continue;

    const cleaned = stripped.split(/\s+/).map(cleanWordToken).filter((word) => /^[a-z]+$/.test(word));
    const windows = [];
    for (let start = 0; start + 12 <= cleaned.length; start++) {
      windows.push(cleaned.slice(start, start + 12).join(' '));
    }
    for (let start = 0; cleaned.length >= 24 && start + 24 <= cleaned.length; start++) {
      windows.push(cleaned.slice(start, start + 24).join(' '));
    }
    for (const words of windows.slice(0, 6)) {
      const firstWord = words.split(' ')[0];
      if (anyFirstWord || firstWord === String(keyword).toLowerCase()) {
        candidates.push({ words, commented: isCommented, line: i + 1, joined: false });
      }
    }
  }
  return { candidates, commentedCount, totalLines: lines.length };
}

/**
 * Fallback: join short commented lines to rebuild a 12/24-word group that was
 * wrapped across lines. Only used when the per-line pass found no match; every
 * candidate is still gated by the ratified issuer address.
 */
function extractJoinedCandidates(fileText, keyword, singleLineCount) {
  const lines = fileText.split(/\r?\n/);
  const candidates = [];
  let buffer = [];
  let bufferStartLine = 0;
  let inHtmlComment = false;
  const flush = (endLine) => {
    if (!buffer.length) return;
    const words = normalizeMnemonicText(buffer.join(' '));
    const count = words.split(' ').length;
    if ((count === 12 || count === 24) && isWordGroupLine(words)) {
      const firstWord = words.split(' ')[0];
      if (firstWord === String(keyword).toLowerCase() || singleLineCount === 0) {
        candidates.push({ words, commented: true, line: `${bufferStartLine}-${endLine}`, joined: true });
      }
    }
    buffer = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const opensBlock = raw.includes('<!--');
    const closesBlock = raw.includes('-->');
    const isCommented = COMMENT_PREFIX_RE.test(raw) || inHtmlComment || opensBlock;
    if (opensBlock) inHtmlComment = true;
    if (closesBlock && !opensBlock) inHtmlComment = false;
    const stripped = raw.replace(COMMENT_PREFIX_RE, ' ').trim();
    const cleaned = stripped.split(/\s+/).map(cleanWordToken).filter((word) => /^[a-z]+$/.test(word));
    const looksWordy = cleaned.length > 0;
    if (isCommented && looksWordy) {
      if (!buffer.length) bufferStartLine = i + 1;
      buffer.push(cleaned.join(' '));
      if (buffer.join(' ').split(/\s+/).length >= 24) flush(i + 1);
    } else {
      flush(i === 0 ? 1 : i);
    }
  }
  flush(lines.length);
  return candidates;
}

/** Derive the MVC address for a mnemonic at a full BIP44 path (236-honoring,
 *  identical derivation to src/main/libs/createPinWorker.ts). */
export function deriveMvcAddress(mnemonic, path) {
  const coinMatch = String(path || '').trim().match(/^m\/44'\/(\d+)'\/0'\/0\/(\d+)$/);
  if (!coinMatch) throw new Error(`unsupported BIP44 path: ${path}`);
  const coin = coinMatch[1] === '236' ? 236 : 10001;
  const index = parseInt(coinMatch[2], 10);
  const hdpk = mvc.Mnemonic.fromString(mnemonic).toHDPrivateKey('', NETWORK);
  const child = hdpk.deriveChild(`m/44'/${coin}'/0'/0/${index}`);
  return {
    address: child.publicKey.toAddress(NETWORK).toString(),
    publicKeyHex: child.publicKey.toString('hex'),
    privateKey: child.privateKey,
  };
}

/** Chat pubkey via ECDH with the MAN peer key (mirror of
 *  metabotWalletService.deriveChatPublicKey). */
export function deriveChatPubKey(privateKey) {
  const privBuf = Buffer.from(privateKey.bn.toArray('be', 32));
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(privBuf);
  void ecdh.computeSecret(Buffer.from(getManPubKey(), 'hex'));
  return ecdh.getPublicKey('hex', 'uncompressed');
}

// Lazily bound to avoid a require cycle with issuer-config in tests.
let manPubKeyCache = null;
function getManPubKey() {
  if (!manPubKeyCache) {
    manPubKeyCache = require('./issuer-config.mjs').MAN_PUB_KEY;
  }
  return manPubKeyCache;
}

/** metaid = sha256(mvc_address) (mirror of metabotWalletService.computeMetaId). */
export function computeMetaId(address) {
  return crypto.createHash('sha256').update(address, 'utf8').digest('hex');
}

/** Sign the same-origin binding message with the issuer 236 key. Returns the
 *  compact recoverable signature (base64) — third parties verify it against
 *  the issuer ADDRESS with any mvc-lib-compatible Message verifier. */
export function signIssuerBinding(privateKey, address) {
  const { issuerBindingMessage } = require('./issuer-config.mjs');
  const message = issuerBindingMessage(address);
  const sig = new mvc.Message(message).sign(privateKey);
  return { message, signature: sig };
}

/**
 * Load + verify the issuer mnemonic from the owner-ratified source file.
 * Never returns or logs the mnemonic to anything but the in-process consumer.
 *
 * @param {object} opts
 * @param {string} opts.filePath     absolute path to the owner's notes file
 * @param {string} [opts.keyword]    first-word selector (default 'endorse')
 * @param {string} opts.expectAddress ratified issuer address (gate)
 * @param {string} [opts.path]       BIP44 path (default 236 issuer path)
 */
export function loadIssuerMnemonic({ filePath, keyword = 'endorse', expectAddress, path }) {
  const { issuerPath, issuerAddress } = require('./issuer-config.mjs').ISSUER_CONFIG;
  const resolvedPath = path || issuerPath;
  const resolvedExpect = expectAddress || issuerAddress;

  let fileText;
  try {
    fileText = require('node:fs').readFileSync(filePath, 'utf8');
  } catch (error) {
    return { ok: false, error: 'SOURCE_FILE_UNREADABLE', detail: error.message };
  }

  let single = extractCandidates(fileText, keyword);
  let tried = [...single.candidates];
  if (tried.length === 0) {
    // Keyword glued in an unexpected shape — retry every commented window and
    // let the ratified-address gate pick (fail-closed either way).
    single = extractCandidates(fileText, keyword, { anyFirstWord: true });
    tried = [...single.candidates];
  }
  let verdicts = tried.map((candidate) => scoreCandidate(candidate, resolvedPath, resolvedExpect));
  let matches = verdicts.filter((v) => v.valid && v.address === resolvedExpect);

  if (matches.length === 0) {
    const joined = extractJoinedCandidates(fileText, keyword, single.candidates.length);
    const joinedVerdicts = joined.map((candidate) => scoreCandidate(candidate, resolvedPath, resolvedExpect));
    const joinedMatches = joinedVerdicts.filter((v) => v.valid && v.address === resolvedExpect);
    if (joinedMatches.length === 1) {
      verdicts = [...verdicts, ...joinedVerdicts];
      matches = joinedMatches;
    }
  }

  const diagnostics = {
    totalLines: single.totalLines,
    commentedGroups: single.commentedCount,
    keywordCandidates: tried.length,
    keywordVerdicts: verdicts.filter((v) => !v.joined).map((v) => ({
      line: v.line,
      words: v.wordCount,
      validBip39: v.valid,
      derivedAddress: v.address, // public fingerprint evidence
    })),
    joinedKeywordCandidates: verdicts.filter((v) => v.joined).length,
  };

  if (matches.length === 0) {
    return {
      ok: false,
      error: 'ISSUER_ADDRESS_MISMATCH',
      detail:
        `no commented "${keyword}" group derived the ratified issuer address; ` +
        `check the selector keyword or the source file`,
      diagnostics,
    };
  }
  if (matches.length > 1) {
    return { ok: false, error: 'AMBIGUOUS_MATCH', detail: `${matches.length} groups matched`, diagnostics };
  }

  const match = matches[0];
  return {
    ok: true,
    // SECRET — consumers must handle in-process only.
    mnemonic: match.words,
    evidence: {
      sourceFile: filePath,
      sourceLine: match.line,
      wordCount: match.wordCount,
      derivedAddress: match.address,
      derivedPath: resolvedPath,
      publicKeyHex: match.publicKeyHex,
      diagnostics,
    },
  };
}

function scoreCandidate(candidate, path, expectAddress) {
  const words = candidate.words;
  const wordCount = words.split(' ').length;
  const valid = bip39.validateMnemonic(words, wordlist);
  if (!valid) {
    return { ...candidate, wordCount, valid: false, address: null, publicKeyHex: null };
  }
  const derived = deriveMvcAddress(words, path);
  return {
    ...candidate,
    wordCount,
    valid: true,
    address: derived.address,
    publicKeyHex: derived.publicKeyHex,
    privateKey: derived.privateKey,
  };
}
