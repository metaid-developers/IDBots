/**
 * Memory defense — deterministic secret/PII screening at the memory-write
 * chokepoint (Hindsight's Memory Defense, adapted; comparison item #6).
 *
 * Why: this app carries wallets. Extracted memory text is a real leak
 * channel — a mnemonic or API key that lands in user_memories can flow into
 * external-channel injections and settings surfaces. The base prompt forbids
 * disclosing secrets, but a prompt rule is not a control; this module is.
 *
 * Policy (fail-closed, zero LLM, zero per-turn cost):
 *  - BLOCK detectors (mnemonic, private keys): the whole candidate is
 *    refused — redacting 11 of 12 mnemonic words is worse than useless, the
 *    model already saw everything. Callers drop the write and count it.
 *  - REDACT detectors (API keys, bearer tokens, password assignments): the
 *    match is replaced with [REDACTED:<detector>] and the fact persists.
 *  - Matches are NEVER logged verbatim — only the detector name and a
 *    redacted preview.
 */

import {
  findGenericCjkMnemonicPhrases,
  findGenericEnglishMnemonicPhrases,
} from '../security/bip39PhraseDetector';

export type MemoryDefenseSeverity = 'block' | 'redact';

export interface MemoryDefenseViolation {
  detector: string;
  severity: MemoryDefenseSeverity;
  /** Redacted preview of the match — never the secret itself. */
  preview: string;
}

/** Thrown by the write paths when a blocking detector fires. */
export class MemoryDefenseError extends Error {
  readonly violations: MemoryDefenseViolation[];
  constructor(violations: MemoryDefenseViolation[]) {
    super(`memory defense: refused to persist (${violations.map((v) => v.detector).join(', ')})`);
    this.name = 'MemoryDefenseError';
    this.violations = violations;
  }
}

const previewOf = (match: string): string => {
  const text = match.replace(/\s+/g, ' ').trim();
  return text.length <= 12 ? `${text.slice(0, 2)}…` : `${text.slice(0, 4)}…${text.length} chars`;
};

function findMnemonicPhrases(text: string): string[] {
  return findGenericEnglishMnemonicPhrases(text);
}

function findCjkMnemonicPhrases(text: string): string[] {
  return findGenericCjkMnemonicPhrases(text);
}

interface Detector {
  detector: string;
  severity: MemoryDefenseSeverity;
  pattern: RegExp;
}

/**
 * Ordered detectors. Generic "secret-looking assignment" patterns run LAST
 * so specific formats (sk-, ghp_, AKIA…) name themselves in the redaction.
 */
const DETECTORS: Detector[] = [
  { detector: 'wif_private_key', severity: 'block', pattern: /\b[5KL][1-9A-HJ-NP-Za-km-z]{50,51}\b/g },
  { detector: 'hd_master_key', severity: 'block', pattern: /\b(xprv|zprv|tprv|vprv)[1-9A-HJ-NP-Za-km-z]{50,}\b/g },
  // NOTE: bare 64-hex is deliberately NOT a detector — it is exactly the
  // shape of on-chain pin ids and tx ids, which memories legitimately carry.
  // Only context-marked hex keys are blocked.
  { detector: 'hex_private_key', severity: 'block', pattern: /\b0x[0-9a-fA-F]{64}\b|\b(?:priv(?:ate)?[_-]?key|seed)\s*[:=]\s*[0-9a-fA-F]{64}\b/gi },
  { detector: 'openai_api_key', severity: 'redact', pattern: /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}\b/g },
  { detector: 'github_token', severity: 'redact', pattern: /\b(?:ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{20,})\b/g },
  { detector: 'aws_access_key', severity: 'redact', pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { detector: 'bearer_token', severity: 'redact', pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/g },
  // The value must be a secret-shaped ASCII run: >= 8 key-class characters
  // containing at least one digit/symbol. CJK has no spaces, so the previous
  // any-non-space value class swallowed the whole Chinese clause after a label
  // ("助记词:千万不能泄露给任何人，这是底线") and destroyed its meaning;
  // prose now passes, typical API keys/passwords still match. Pure-CJK
  // "values" are either prose (keep) or a Chinese mnemonic (bip39 detector).
  { detector: 'credential_assignment', severity: 'redact', pattern: /(?:api[\s_-]?key|secret|token|passwd|passphrase|password|密码|密钥|助记词|私钥)\s*[:：=]\s*["']?(?=[A-Za-z0-9+/=_.:@#&$%^*!?~-]{8,})(?=[A-Za-z0-9+/=_.:@#&$%^*!?~-]*[0-9+/=_.:@#&$%^*!?~-])[A-Za-z0-9+/=_.:@#&$%^*!?~-]{8,}["']?/gi },
];

/** Scan one candidate text. Returns every violation (block first). */
export function scanMemoryText(text: string): MemoryDefenseViolation[] {
  const violations: MemoryDefenseViolation[] = [];
  for (const phrase of findMnemonicPhrases(text)) {
    violations.push({ detector: 'bip39_mnemonic', severity: 'block', preview: previewOf(phrase) });
  }
  for (const phrase of findCjkMnemonicPhrases(text)) {
    violations.push({ detector: 'bip39_mnemonic', severity: 'block', preview: previewOf(phrase) });
  }
  for (const detector of DETECTORS) {
    detector.pattern.lastIndex = 0;
    for (const match of text.match(detector.pattern) ?? []) {
      violations.push({ detector: detector.detector, severity: detector.severity, preview: previewOf(match) });
    }
  }
  return violations.sort((left, right) => (left.severity === right.severity ? 0 : left.severity === 'block' ? -1 : 1));
}

/**
 * Apply the write policy: redact in place, refuse on any blocking detector.
 * Returns the (possibly redacted) text; throws MemoryDefenseError when the
 * candidate must not be persisted at all.
 */
export function applyMemoryDefense(text: string): string {
  const violations = scanMemoryText(text);
  if (violations.length === 0) return text;
  const blockers = violations.filter((violation) => violation.severity === 'block');
  if (blockers.length > 0) {
    console.warn(`[MemoryDefense] refused a memory write: ${blockers.map((v) => v.detector).join(', ')}`);
    throw new MemoryDefenseError(violations);
  }
  let defended = text;
  for (const detector of DETECTORS) {
    if (detector.severity !== 'redact') continue;
    detector.pattern.lastIndex = 0;
    defended = defended.replace(detector.pattern, () => `[REDACTED:${detector.detector}]`);
  }
  console.warn(`[MemoryDefense] redacted a memory write: ${violations.map((v) => v.detector).join(', ')}`);
  return defended;
}

/**
 * Evidence quotes (user_memory_sources.quote) are best-effort provenance that
 * only idle-time passes read. They quote raw conversation, so they carry the
 * same leak risk as memory text: redact detector matches; on a blocking hit
 * return null and drop the quote instead of throwing — the memory text itself
 * was already defended, and provenance is never worth refusing a write over.
 */
export function defendMemoryQuote(quote: string | null | undefined): string | null {
  if (!quote) return null;
  try {
    return applyMemoryDefense(quote);
  } catch (error) {
    if (error instanceof MemoryDefenseError) return null;
    throw error;
  }
}
