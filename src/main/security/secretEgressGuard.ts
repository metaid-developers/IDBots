/**
 * Outbound Secret Egress Guard (DLP) — fail-closed hard rule filter that stops
 * mnemonics, private keys, and sensitive host credentials from leaving the
 * device via private chat, group chat / Open Team, on-chain pins, file uploads,
 * or IM gateways.
 *
 * Defense-in-depth layers:
 *  1. Local wallet fingerprint matching (all local MetaBot mnemonics + human
 *     user identity mnemonic): catches 4+ consecutive words (forward or
 *     reversed, across arbitrary punctuation/numbering), spaceless
 *     concatenations, scrambled >= 6 distinct words within a 30-word window,
 *     and Base64 / Hex encodings of full or half mnemonics.
 *  2. Generic secret detectors: BIP-39 English/CJK >= 12-word mnemonics,
 *     BTC/MVC/DOGE/testnet WIF private keys (with Base58Check verification for
 *     DOGE/testnet to avoid false positives), HD extended private keys
 *     (xprv/yprv/zprv/tprv/vprv), context-marked or 0x-prefixed 64-hex private
 *     keys, and active local RPC tokens.
 *  3. Sensitive host file path blocking: prevents uploading or attaching
 *     idbots.sqlite, metaid-rpc-token, dsh-skill-env/*.env, or SSH/cloud keys.
 *
 * Matches are NEVER logged or included in thrown errors verbatim — only the
 * detector name and a short redacted preview.
 */

import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import {
  findGenericCjkMnemonicPhrases,
  findGenericEnglishMnemonicPhrases,
  unescapeCommonStringEscapes,
} from './bip39PhraseDetector';

export interface SecretEgressViolation {
  detector: string;
  /** Redacted preview only — never contains the full secret. */
  preview: string;
}

export class SecretEgressBlockedError extends Error {
  readonly channel: string;
  readonly violations: SecretEgressViolation[];

  constructor(channel: string, violations: SecretEgressViolation[]) {
    const names = Array.from(new Set(violations.map((v) => v.detector))).join(', ');
    super(`Blocked outbound ${channel}: detected sensitive wallet/credential material (${names}).`);
    this.name = 'SecretEgressBlockedError';
    this.channel = channel;
    this.violations = violations;
  }
}

export interface LocalSecretSnapshot {
  mnemonics?: readonly string[];
  tokens?: readonly string[];
}

export type LocalSecretProvider = () => LocalSecretSnapshot;

let registeredSecretProvider: LocalSecretProvider | null = null;
const registeredSensitiveUserDataDirs = new Set<string>();

export function registerLocalSecretProvider(provider: LocalSecretProvider | null): void {
  registeredSecretProvider = provider;
  cachedRegistryKey = '';
  cachedRegistry = null;
}

export function registerSensitiveUserDataPath(dirPath: string | null | undefined): void {
  const trimmed = String(dirPath ?? '').trim();
  if (!trimmed) return;
  try {
    registeredSensitiveUserDataDirs.add(fs.realpathSync(trimmed));
  } catch {
    registeredSensitiveUserDataDirs.add(path.resolve(trimmed));
  }
}

export function clearSensitiveUserDataPathsForTest(): void {
  registeredSensitiveUserDataDirs.clear();
}

const previewOf = (value: string): string => {
  const clean = value.replace(/\s+/g, ' ').trim();
  if (clean.length <= 8) return '***';
  return `${clean.slice(0, 3)}…(${clean.length} chars)`;
};

const sha256Hex = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

const sha256Buf = (buf: Buffer): Buffer => createHash('sha256').update(buf).digest();

// --- Base58Check validation for DOGE/testnet WIF ----------------------------

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE58_INDEX = new Map<string, bigint>(
  Array.from(BASE58_ALPHABET).map((ch, idx) => [ch, BigInt(idx)]),
);

function decodeBase58(input: string): Buffer | null {
  let num = 0n;
  for (let i = 0; i < input.length; i += 1) {
    const digit = BASE58_INDEX.get(input[i]);
    if (digit === undefined) return null;
    num = num * 58n + digit;
  }
  const bytes: number[] = [];
  while (num > 0n) {
    bytes.push(Number(num & 0xffn));
    num >>= 8n;
  }
  bytes.reverse();
  let leadingZeros = 0;
  for (let i = 0; i < input.length && input[i] === '1'; i += 1) {
    leadingZeros += 1;
  }
  const out = Buffer.alloc(leadingZeros + bytes.length);
  for (let i = 0; i < bytes.length; i += 1) {
    out[leadingZeros + i] = bytes[i];
  }
  return out;
}

const VALID_WIF_VERSIONS = new Set([0x80, 0x9e, 0xef]);

export function isValidBase58CheckWif(candidate: string): boolean {
  if (candidate.length < 51 || candidate.length > 52) return false;
  const decoded = decodeBase58(candidate);
  if (!decoded) return false;
  if (decoded.length !== 37 && decoded.length !== 38) return false;
  if (!VALID_WIF_VERSIONS.has(decoded[0])) return false;
  if (decoded.length === 38 && decoded[33] !== 0x01) return false;
  const payload = decoded.subarray(0, decoded.length - 4);
  const checksum = decoded.subarray(decoded.length - 4);
  const expected = sha256Buf(sha256Buf(payload)).subarray(0, 4);
  return checksum.equals(expected);
}

// --- Local mnemonic & token fingerprint compilation -------------------------

interface CompiledMnemonicEntry {
  kind: 'latin' | 'cjk';
  distinctWords: ReadonlySet<string>;
  minOverlapHits: number;
}

interface CompiledSecretRegistry {
  latinWindow4Set: Set<string>;
  cjkWindow4Set: Set<string>;
  spacelessWindows: string[];
  encodedFragments: string[];
  mnemonicEntries: CompiledMnemonicEntry[];
  tokens: string[];
}

const LOCAL_WINDOW_SIZE = 4;
const LOCAL_CJK_SPACELESS_WINDOW_SIZE = 6;
const LOCAL_OVERLAP_SPAN = 30;
const LOCAL_OVERLAP_THRESHOLD = 6;
const MIN_SPACELESS_WINDOW_LEN = 16;
const MIN_ENCODED_FRAGMENT_LEN = 24;
const MIN_TOKEN_LEN = 16;

const UNIFIED_WORD_OR_HAN_RE = /[a-z]+|\p{Script=Han}+/gu;
const HAN_RUN_RE = /\p{Script=Han}+/gu;

function tokenizeLatinWords(text: string): string[] {
  return text.toLowerCase().split(/[^a-z]+/).filter(Boolean);
}

/**
 * Tokenize into lowercase ASCII words plus contiguous Han runs.
 * Multi-character Han clauses remain in the stream as boundary tokens so
 * isolated single characters or sparse English words across distant Chinese
 * paragraphs are never glued into false consecutive windows.
 */
function tokenizeUnifiedWordsAndHan(text: string): string[] {
  const matches: string[] | null = text.toLowerCase().match(UNIFIED_WORD_OR_HAN_RE);
  return matches ?? [];
}

function extractCjkMnemonicChars(mnemonic: string): string[] {
  const runs: string[] | null = mnemonic.match(HAN_RUN_RE);
  if (!runs || runs.length === 0) return [];
  if (runs.length >= LOCAL_WINDOW_SIZE && runs.every((r) => r.length === 1)) {
    return runs;
  }
  if (runs.length === 1) {
    const chars = Array.from(runs[0]);
    if (chars.length >= 12) return chars;
  }
  return [];
}

function compileSecretRegistry(mnemonics: readonly string[], tokens: readonly string[]): CompiledSecretRegistry {
  const latinWindow4Set = new Set<string>();
  const cjkWindow4Set = new Set<string>();
  const spacelessWindowSet = new Set<string>();
  const encodedFragmentSet = new Set<string>();
  const mnemonicEntries: CompiledMnemonicEntry[] = [];

  const addEncodedVariants = (phrase: string): void => {
    if (!phrase || phrase.length < 12) return;
    const b64 = Buffer.from(phrase, 'utf8').toString('base64');
    // Drop the last 4 chars so trailing-newline encodings (`echo "$M" | base64`)
    // share the exact same prefix and still match.
    const b64Prefix = b64.length >= MIN_ENCODED_FRAGMENT_LEN + 4 ? b64.slice(0, -4) : b64;
    if (b64Prefix.length >= MIN_ENCODED_FRAGMENT_LEN) {
      encodedFragmentSet.add(b64Prefix);
    }
    const hex = Buffer.from(phrase, 'utf8').toString('hex');
    if (hex.length >= MIN_ENCODED_FRAGMENT_LEN) {
      encodedFragmentSet.add(hex);
    }
  };

  for (const rawMnemonic of mnemonics) {
    const trimmed = String(rawMnemonic ?? '').trim();
    if (!trimmed) continue;

    const latinWords = tokenizeLatinWords(trimmed);
    const cjkWords = extractCjkMnemonicChars(trimmed);

    if (latinWords.length >= LOCAL_WINDOW_SIZE) {
      for (let i = 0; i <= latinWords.length - LOCAL_WINDOW_SIZE; i += 1) {
        const slice = latinWords.slice(i, i + LOCAL_WINDOW_SIZE);
        latinWindow4Set.add(slice.join(' '));
        latinWindow4Set.add([...slice].reverse().join(' '));
        const joined = slice.join('');
        if (joined.length >= MIN_SPACELESS_WINDOW_LEN) {
          spacelessWindowSet.add(joined);
        }
      }
      const distinct = new Set(latinWords);
      // Require >= 8 distinct words so synthetic repeated-word fixtures
      // (like "abandon ... about") rely on the 4-word window rather than
      // triggering false positives in overlap mode.
      if (distinct.size >= 8) {
        mnemonicEntries.push({
          kind: 'latin',
          distinctWords: distinct,
          minOverlapHits: LOCAL_OVERLAP_THRESHOLD,
        });
      }
      const normalized = latinWords.join(' ');
      addEncodedVariants(normalized);
      if (latinWords.length >= 12) {
        const half = Math.floor(latinWords.length / 2);
        addEncodedVariants(latinWords.slice(0, half).join(' '));
        addEncodedVariants(latinWords.slice(half).join(' '));
      }
    } else if (cjkWords.length >= LOCAL_WINDOW_SIZE) {
      for (let i = 0; i <= cjkWords.length - LOCAL_WINDOW_SIZE; i += 1) {
        const slice = cjkWords.slice(i, i + LOCAL_WINDOW_SIZE);
        cjkWindow4Set.add(slice.join(' '));
        cjkWindow4Set.add([...slice].reverse().join(' '));
      }
      if (cjkWords.length >= LOCAL_CJK_SPACELESS_WINDOW_SIZE) {
        for (let i = 0; i <= cjkWords.length - LOCAL_CJK_SPACELESS_WINDOW_SIZE; i += 1) {
          spacelessWindowSet.add(cjkWords.slice(i, i + LOCAL_CJK_SPACELESS_WINDOW_SIZE).join(''));
        }
      }
      const distinct = new Set(cjkWords);
      if (distinct.size >= 8) {
        mnemonicEntries.push({
          kind: 'cjk',
          distinctWords: distinct,
          minOverlapHits: LOCAL_OVERLAP_THRESHOLD,
        });
      }
      addEncodedVariants(cjkWords.join(' '));
      if (cjkWords.length >= 12) {
        const half = Math.floor(cjkWords.length / 2);
        addEncodedVariants(cjkWords.slice(0, half).join(' '));
        addEncodedVariants(cjkWords.slice(half).join(' '));
      }
    }
  }

  const normalizedTokens = Array.from(
    new Set(
      tokens
        .map((t) => String(t ?? '').trim())
        .filter((t) => t.length >= MIN_TOKEN_LEN),
    ),
  );

  return {
    latinWindow4Set,
    cjkWindow4Set,
    spacelessWindows: Array.from(spacelessWindowSet),
    encodedFragments: Array.from(encodedFragmentSet),
    mnemonicEntries,
    tokens: normalizedTokens,
  };
}

let cachedRegistryKey = '';
let cachedRegistry: CompiledSecretRegistry | null = null;

function resolveCompiledRegistry(
  extraMnemonics?: readonly string[],
  extraTokens?: readonly string[],
): CompiledSecretRegistry {
  let providerSnapshot: LocalSecretSnapshot = {};
  if (registeredSecretProvider) {
    try {
      providerSnapshot = registeredSecretProvider() || {};
    } catch {
      providerSnapshot = {};
    }
  }
  const mnemonics: string[] = [
    ...(providerSnapshot.mnemonics ?? []),
    ...(extraMnemonics ?? []),
  ];
  const tokens: string[] = [
    ...(providerSnapshot.tokens ?? []),
    ...(extraTokens ?? []),
  ];
  if (mnemonics.length === 0 && tokens.length === 0) {
    return {
      latinWindow4Set: new Set(),
      cjkWindow4Set: new Set(),
      spacelessWindows: [],
      encodedFragments: [],
      mnemonicEntries: [],
      tokens: [],
    };
  }
  const key = sha256Hex(`${mnemonics.join('\u0000')}\u0001${tokens.join('\u0000')}`);
  if (cachedRegistry && cachedRegistryKey === key) {
    return cachedRegistry;
  }
  const compiled = compileSecretRegistry(mnemonics, tokens);
  cachedRegistryKey = key;
  cachedRegistry = compiled;
  return compiled;
}

// --- Generic detectors ------------------------------------------------------

const WIF_BTC_MVC_RE = /\b[5KL][1-9A-HJ-NP-Za-km-z]{50,51}\b/g;
const WIF_DOGE_TESTNET_RE = /\b[6Q9c][1-9A-HJ-NP-Za-km-z]{50,51}\b/g;
const HD_MASTER_KEY_RE = /\b(?:xprv|yprv|zprv|tprv|vprv)[1-9A-HJ-NP-Za-km-z]{50,}\b/g;
const HEX_PRIVATE_KEY_RE =
  /\b0x[0-9a-fA-F]{64}\b|\b(?:priv(?:ate)?[_-]?key|seed|wif|secret[_-]?key)\s*[:=]\s*(?:\\?["'])?[0-9a-fA-F]{64}(?:\\?["'])?/gi;

function hasOverlapInWindow(
  tokens: readonly string[],
  distinctWords: ReadonlySet<string>,
  threshold: number,
  span: number,
): boolean {
  if (tokens.length < threshold) return false;
  const counts = new Map<string, number>();
  let uniqueHits = 0;
  for (let i = 0; i < tokens.length; i += 1) {
    const entering = tokens[i];
    if (distinctWords.has(entering)) {
      const prev = counts.get(entering) ?? 0;
      if (prev === 0) uniqueHits += 1;
      counts.set(entering, prev + 1);
    }
    if (i >= span) {
      const leaving = tokens[i - span];
      if (distinctWords.has(leaving)) {
        const prev = counts.get(leaving) ?? 0;
        if (prev <= 1) {
          counts.delete(leaving);
          uniqueHits -= 1;
        } else {
          counts.set(leaving, prev - 1);
        }
      }
    }
    if (uniqueHits >= threshold) return true;
  }
  return false;
}

export interface SecretEgressScanOptions {
  extraMnemonics?: readonly string[];
  extraTokens?: readonly string[];
}

/**
 * Scan outbound text for mnemonics, private keys, or registered local secrets.
 * Pure, deterministic, zero-LLM. Returns all violations (empty array = safe).
 */
export function scanSecretEgressText(
  text: string,
  options?: SecretEgressScanOptions,
): SecretEgressViolation[] {
  if (!text || typeof text !== 'string') return [];
  const violations: SecretEgressViolation[] = [];
  const registry = resolveCompiledRegistry(options?.extraMnemonics, options?.extraTokens);

  const unescaped = unescapeCommonStringEscapes(text);
  const views = unescaped !== text ? [text, unescaped] : [text];
  const tokenizedViews =
    registry.latinWindow4Set.size > 0 ||
    registry.cjkWindow4Set.size > 0 ||
    registry.mnemonicEntries.length > 0
      ? views.map((v) => tokenizeUnifiedWordsAndHan(v))
      : [];

  // 1a. Local mnemonic 4-word sliding window (Latin)
  if (registry.latinWindow4Set.size > 0) {
    let matched = false;
    for (const tokens of tokenizedViews) {
      if (tokens.length < LOCAL_WINDOW_SIZE) continue;
      for (let i = 0; i <= tokens.length - LOCAL_WINDOW_SIZE; i += 1) {
        const key = `${tokens[i]} ${tokens[i + 1]} ${tokens[i + 2]} ${tokens[i + 3]}`;
        if (registry.latinWindow4Set.has(key)) {
          violations.push({ detector: 'local_mnemonic_window', preview: '4-word match' });
          matched = true;
          break;
        }
      }
      if (matched) break;
    }
  }

  // 1b. Local mnemonic 4-word sliding window (CJK)
  if (registry.cjkWindow4Set.size > 0) {
    let matched = false;
    for (const tokens of tokenizedViews) {
      if (tokens.length < LOCAL_WINDOW_SIZE) continue;
      for (let i = 0; i <= tokens.length - LOCAL_WINDOW_SIZE; i += 1) {
        const key = `${tokens[i]} ${tokens[i + 1]} ${tokens[i + 2]} ${tokens[i + 3]}`;
        if (registry.cjkWindow4Set.has(key)) {
          violations.push({ detector: 'local_mnemonic_window', preview: '4-char CJK match' });
          matched = true;
          break;
        }
      }
      if (matched) break;
    }
  }

  // 1c. Local mnemonic spaceless concatenation (e.g. word1word2word3word4)
  if (registry.spacelessWindows.length > 0) {
    let matched = false;
    for (const view of views) {
      // Keep Han runs intact so English words in separate Chinese paragraphs do
      // not collapse together, while stripping ASCII punctuation/spaces so
      // `word1word2word3word4` and `w.o.r.d.1...` still match.
      const squashed = view.toLowerCase().replace(/[^a-z\p{Script=Han}]+/gu, '');
      if (squashed.length < LOCAL_CJK_SPACELESS_WINDOW_SIZE) continue;
      for (const fragment of registry.spacelessWindows) {
        if (squashed.includes(fragment)) {
          violations.push({ detector: 'local_mnemonic_concat', preview: 'concat match' });
          matched = true;
          break;
        }
      }
      if (matched) break;
    }
  }

  // 1d. Local mnemonic scrambled / interleaved overlap within a 30-token span
  if (registry.mnemonicEntries.length > 0) {
    let matched = false;
    for (const entry of registry.mnemonicEntries) {
      for (const tokens of tokenizedViews) {
        if (hasOverlapInWindow(tokens, entry.distinctWords, entry.minOverlapHits, LOCAL_OVERLAP_SPAN)) {
          violations.push({ detector: 'local_mnemonic_overlap', preview: '>=6 local mnemonic words' });
          matched = true;
          break;
        }
      }
      if (matched) break;
    }
  }

  // 1e. Local mnemonic Base64 / Hex encoded fragments
  if (registry.encodedFragments.length > 0 && text.length >= MIN_ENCODED_FRAGMENT_LEN) {
    const lowerText = text.toLowerCase();
    for (const fragment of registry.encodedFragments) {
      if (text.includes(fragment) || lowerText.includes(fragment)) {
        violations.push({ detector: 'local_mnemonic_encoded', preview: 'encoded mnemonic match' });
        break;
      }
    }
  }

  // 1f. Active local RPC token / registered secret tokens
  for (const token of registry.tokens) {
    if (views.some((v) => v.includes(token))) {
      violations.push({ detector: 'local_rpc_token', preview: previewOf(token) });
      break;
    }
  }

  // 2a. Generic BIP-39 >= 12-word mnemonics (catches unknown wallets too)
  if (findGenericEnglishMnemonicPhrases(text).length > 0) {
    violations.push({ detector: 'bip39_mnemonic', preview: '>=12 English BIP-39 words' });
  }
  if (findGenericCjkMnemonicPhrases(text).length > 0) {
    violations.push({ detector: 'bip39_mnemonic', preview: '>=12 CJK BIP-39 words' });
  }

  // 2b. WIF private keys (BTC / MVC mainnet regex + DOGE / testnet Base58Check)
  WIF_BTC_MVC_RE.lastIndex = 0;
  for (const match of text.match(WIF_BTC_MVC_RE) ?? []) {
    violations.push({ detector: 'wif_private_key', preview: previewOf(match) });
  }
  WIF_DOGE_TESTNET_RE.lastIndex = 0;
  for (const match of text.match(WIF_DOGE_TESTNET_RE) ?? []) {
    if (isValidBase58CheckWif(match)) {
      violations.push({ detector: 'wif_private_key', preview: previewOf(match) });
    }
  }

  // 2c. HD extended private keys
  HD_MASTER_KEY_RE.lastIndex = 0;
  for (const match of text.match(HD_MASTER_KEY_RE) ?? []) {
    violations.push({ detector: 'hd_master_key', preview: previewOf(match) });
  }

  // 2d. 0x-prefixed or explicitly labeled 64-hex private keys
  HEX_PRIVATE_KEY_RE.lastIndex = 0;
  for (const match of text.match(HEX_PRIVATE_KEY_RE) ?? []) {
    violations.push({ detector: 'hex_private_key', preview: previewOf(match) });
  }

  return violations;
}

export interface SecretEgressAssertOptions extends SecretEgressScanOptions {
  channel: string;
}

export function assertNoSecretEgressText(
  text: string,
  options: SecretEgressAssertOptions,
): void {
  const violations = scanSecretEgressText(text, options);
  if (violations.length > 0) {
    console.warn(
      `[SecretEgressGuard] blocked outbound ${options.channel}: ${violations.map((v) => `${v.detector}(${v.preview})`).join(', ')}`,
    );
    throw new SecretEgressBlockedError(options.channel, violations);
  }
}

// --- Sensitive host file path guard -----------------------------------------

const SENSITIVE_BASENAMES = new Set([
  'idbots.sqlite',
  'idbots.sqlite-wal',
  'idbots.sqlite-shm',
  'idbots.sqlite-journal',
  'cowork.sqlite',
  'cowork.sqlite-wal',
  'cowork.sqlite-shm',
  'cowork.sqlite-journal',
  'metaid-rpc-token',
  '.env',
  'id_rsa',
  'id_ed25519',
  'id_ecdsa',
  'id_dsa',
]);

const SENSITIVE_PATH_SEGMENTS = new Set([
  'dsh-skill-env',
  '.dsh-skill-env',
  '.ssh',
  '.gnupg',
  '.aws',
]);

const SENSITIVE_USERDATA_EXTENSIONS = new Set([
  '.sqlite',
  '.sqlite3',
  '.db',
  '.env',
]);

function resolveCanonicalPath(filePath: string): string {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

export function isSensitiveHostFilePath(filePath: string): boolean {
  const trimmed = String(filePath ?? '').trim();
  if (!trimmed) return false;
  const canonical = resolveCanonicalPath(trimmed);
  const base = path.basename(canonical).toLowerCase();
  if (SENSITIVE_BASENAMES.has(base)) return true;
  if (base.startsWith('.env.')) return true;

  const segments = canonical.split(/[\\/]+/).map((s) => s.toLowerCase());
  for (const seg of segments) {
    if (SENSITIVE_PATH_SEGMENTS.has(seg)) return true;
  }

  for (const userDataDir of registeredSensitiveUserDataDirs) {
    const rel = path.relative(userDataDir, canonical);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
      const ext = path.extname(base).toLowerCase();
      if (SENSITIVE_USERDATA_EXTENSIONS.has(ext) || base === 'metaid-rpc-token') {
        return true;
      }
    }
  }

  return false;
}

export function assertSafeOutboundFilePath(filePath: string, channel: string): void {
  if (isSensitiveHostFilePath(filePath)) {
    const base = path.basename(String(filePath || ''));
    console.warn(`[SecretEgressGuard] blocked sensitive host file upload on ${channel}: ${base}`);
    throw new SecretEgressBlockedError(channel, [
      { detector: 'sensitive_host_file', preview: base || 'sensitive-file' },
    ]);
  }
}

// --- Buffer / payload / file content scanning -------------------------------

const MAX_TEXT_SCAN_BYTES = 2 * 1024 * 1024; // 2 MiB
const BINARY_PROBE_BYTES = 8 * 1024;

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.json', '.csv', '.tsv', '.log', '.env',
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.sh', '.bash', '.zsh',
  '.html', '.htm', '.xml', '.svg', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
  '.sql', '.rtf',
]);

function isTextLikeHint(contentType?: string, fileName?: string): boolean {
  const ct = String(contentType ?? '').toLowerCase();
  if (
    ct.startsWith('text/') ||
    ct.includes('json') ||
    ct.includes('javascript') ||
    ct.includes('xml') ||
    ct.includes('yaml') ||
    ct.includes('csv') ||
    ct.includes('x-sh')
  ) {
    return true;
  }
  if (fileName) {
    const ext = path.extname(fileName).toLowerCase();
    if (TEXT_EXTENSIONS.has(ext)) return true;
  }
  return false;
}

function bufferLooksLikeText(buf: Buffer): boolean {
  if (buf.length === 0 || buf.length > MAX_TEXT_SCAN_BYTES) return false;
  const probeLen = Math.min(buf.length, BINARY_PROBE_BYTES);
  let controlCount = 0;
  for (let i = 0; i < probeLen; i += 1) {
    const b = buf[i];
    if (b === 0x00) return false; // NUL byte -> binary
    if (b < 0x09 || (b > 0x0d && b < 0x20)) {
      controlCount += 1;
    }
  }
  return controlCount / probeLen < 0.05;
}

export function assertNoSecretEgressBuffer(
  buffer: Buffer,
  options: SecretEgressAssertOptions & { contentType?: string; fileName?: string },
): void {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return;
  if (buffer.length > MAX_TEXT_SCAN_BYTES) return;
  if (!isTextLikeHint(options.contentType, options.fileName) && !bufferLooksLikeText(buffer)) {
    return;
  }
  assertNoSecretEgressText(buffer.toString('utf8'), options);
}

export function assertNoSecretEgressPayload(
  payload: string | Buffer | undefined | null,
  options: SecretEgressAssertOptions & { contentType?: string; fileName?: string },
): void {
  if (payload == null) return;
  if (typeof payload === 'string') {
    assertNoSecretEgressText(payload, options);
    return;
  }
  if (Buffer.isBuffer(payload)) {
    assertNoSecretEgressBuffer(payload, options);
  }
}

export function assertNoSecretEgressFile(
  filePath: string,
  options: SecretEgressAssertOptions & { contentType?: string },
): void {
  assertSafeOutboundFilePath(filePath, options.channel);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return;
  }
  if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_TEXT_SCAN_BYTES) return;
  const fileName = path.basename(filePath);
  const textHint = isTextLikeHint(options.contentType, fileName);
  // Read first probe or full file depending on hint
  if (!textHint) {
    let fd: number | null = null;
    try {
      fd = fs.openSync(filePath, 'r');
      const probe = Buffer.alloc(Math.min(stat.size, BINARY_PROBE_BYTES));
      fs.readSync(fd, probe, 0, probe.length, 0);
      if (!bufferLooksLikeText(probe)) return;
    } catch {
      return;
    } finally {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {
          // ignore close error
        }
      }
    }
  }
  let buf: Buffer;
  try {
    buf = fs.readFileSync(filePath);
  } catch {
    return;
  }
  assertNoSecretEgressBuffer(buf, { ...options, fileName });
}
