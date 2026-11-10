/**
 * Chain-write pre-broadcast pin-reference guard ("写前合型预检").
 *
 * Why: bots habitually hallucinate pin references in chain-write payloads —
 * truncated pinids, missing the `i0` suffix, wrong characters. The AI training
 * sandbox's first cohort produced 5+ malformed payloads caught only by human
 * review and 1 that broadcast (fee burned + a permanent invalid on-chain
 * record; see the 2026-11-08 write-preflight bug report). Invalid payloads are
 * irreversible once broadcast, so interception must happen chain-side: here.
 *
 * The guard runs at the SHARED createPin chokepoint (spawnCreatePinWorker in
 * services/metaidCore.ts) so every consumer channel — agent tools, RPC
 * gateway, internal services, identity sync — is covered once and future
 * writers cannot bypass it. It is FAIL-CLOSED: a payload that carries a
 * malformed pin reference throws BEFORE the worker spawns, before any UTXO is
 * selected and before any fee is spent. The thrown message is agent-readable
 * and tells the model how to fix and retry.
 *
 * What is validated (MetaID pinid contract — a pinid is 64 lowercase hex
 * characters followed by `i` + the output index; createPinWorker always mints
 * `${txid}i0`, but references may point at pins OTHER clients minted at
 * another output index — mrc721Service.isMrc721PinId and the host's other
 * validators accept `iN`, so the guard does too):
 *  1. URI references — every `pin://`, `metafile://`, `metaapp://` occurrence
 *     in the payload text must carry a well-formed pinid. `metaid://` is
 *     intentionally NOT scanned (it carries a globalMetaId like `idq1…`, not a
 *     pinid), and `map://` is not a pin scheme. Only tokens that LOOK like a
 *     pinid attempt are judged: the segment after the scheme must start with
 *     a run of 8+ hex characters (every real, truncated, or malformed
 *     reference starts with the real hex). Prose that merely mentions the
 *     schemes — backticked scheme names, CJK punctuation, regular words —
 *     carries no reference and is never blocked (a `pin://` token with no
 *     hex prefix cannot produce an invalid pinid on-chain).
 *  2. Bare pin-named JSON fields — a string value under a key matching /pin/
 *     that looks like a hex blob must be a well-formed pinid (this is the
 *     exact reported bug shape: `coursePinId` holding 64 hex with no `iN`).
 *  3. Bare txid-named JSON fields — a hex-blob value under a key matching
 *     /txid|txhash/ must be a plain 64-hex txid (catches a pinid pasted into
 *     a txid field and vice versa).
 *  4. Modify path — a `path` targeting an existing pin (`@<pinId>`) must
 *     carry a well-formed pinid.
 *
 * What is skipped: Buffer / base64 / encrypted payloads (nothing readable to
 * validate) and doc placeholders (`pin://<pinId>`, `pin://{pinId}`,
 * `pin://${VAR}`) so tutorials and template payloads are not blocked.
 *
 * Strictness note: PIN_ID_PATTERN (self-mint teaching) stays exactly
 * `${txid}i0` — that is the only shape this codebase mints
 * (createPinWorker.ts) and the bot-facing rule (chainIdentifierPrompt.ts)
 * teaches the same. REFERENCE validation (PIN_REF_PATTERN) accepts any
 * output index `i\d{1,3}` because the market/quote tools quote indexer-read
 * foreign pins. Loosen either deliberately, not silently.
 */

/** The self-mint pinid shape: 64 lowercase hex chars + `i0` (66 chars). */
export const PIN_ID_PATTERN = /^[0-9a-f]{64}i0$/;
/** A well-formed pin REFERENCE: 64 lowercase hex + `i` + output index. */
export const PIN_REF_PATTERN = /^[0-9a-f]{64}i\d{1,3}$/;
/** A plain transaction id: 64 lowercase hex chars, no output suffix. */
const TXID_PATTERN = /^[0-9a-f]{64}$/;
/** A token that starts like a pinid attempt: 8+ hex chars up front. */
const PINID_ATTEMPT_PREFIX_RE = /^[0-9a-fA-F]{8}/;

/**
 * Scan pattern for pin URIs in free text. Captures the raw token after the
 * scheme: everything up to whitespace, a quote, an angle bracket (placeholders
 * like `<pinId>`), a closing bracket/brace, or list punctuation. Trailing
 * sentence punctuation is trimmed before validating (a pinid never ends in
 * `.,!?…`, but prose right after a URI does). The lookbehind keeps prefixed
 * schemes out of the scan (`preview-metaapp://` is a local-preview scheme,
 * not an on-chain pin reference).
 */
const PIN_URI_SCAN_RE = /(?<![a-z0-9-])(?:pin|metafile|metaapp):\/\/([^\s"'<>)\]},;{]*)/gi;
/** Hex-blob shape for bare JSON field values (pinid-family lengths and wider). */
const HEX_BLOB_RE = /^[0-9a-f]{48,128}(i\d{1,3})?$/i;
/** Trailing sentence punctuation to trim off a scanned URI token. */
const TRAILING_PUNCT_RE = /[.,:!?…]+$/;

/** One malformed reference, rendered for the agent. */
export interface PinRefViolation {
  /** Where it was found: `text`, `json:<keyPath>`, or `path`. */
  location: string;
  /** The malformed reference as it appears in the payload. */
  found: string;
  /** What is wrong with it, in one agent-readable clause. */
  problem: string;
}

/** Structural subset of MetaidDataPayload — avoids importing services/metaidCore (cycle). */
export interface PinGuardMetaidData {
  path?: string;
  payload: string | Buffer;
  encoding?: 'utf-8' | 'base64';
  encryption?: '0' | '1' | '2';
}

/** The canonical example pinid shown in error messages and prompts. */
export const PIN_ID_EXAMPLE = '1e288800fdec1a5911a169e0cb499a3bc63e6083e5f035f5d552f73c601f2cf2i0';

/** True when value is a well-formed self-mint pinid (64 lowercase hex + `i0`). */
export function isValidPinId(value: string): boolean {
  return PIN_ID_PATTERN.test(value);
}

/** True when value is a well-formed pin reference (64 lowercase hex + `iN`). */
export function isValidPinRef(value: string): boolean {
  return PIN_REF_PATTERN.test(value);
}

/**
 * Describe why a URI token is malformed; null when it is fine or not a
 * reference at all (prose, placeholders).
 */
function judgeUriToken(token: string, _nextChar: string): string | null {
  const trimmed = token.replace(TRAILING_PUNCT_RE, '');
  if (!trimmed) {
    // Empty token: a doc placeholder (`pin://<pinId>`, `pin://{pinId}`) or a
    // prose scheme mention (`pin://, metafile:// …`). Neither carries a
    // pinid, and a `pin://` with no pinid cannot create an invalid pinid
    // record on-chain — never block prose.
    return null;
  }
  // Template placeholders (`pin://${VAR}`) are doc text, not references.
  if (trimmed.startsWith('$')) return null;
  // Tolerate a deep-link suffix (`pin://<pinId>/route`, `?query`) — validate
  // the pinid segment before the first `/`, `?`, or `#`.
  const segment = trimmed.split(/[/?#]/, 1)[0];
  // Only judge tokens that look like a pinid attempt: a run of 8+ hex chars
  // at the start (every real, truncated, or half-garbled reference begins
  // with the real hex). Backticked scheme names, CJK punctuation, and regular
  // words are prose — flagging them blocked legitimate docs quoting the
  // scheme (2026-11-10 release review: 11 false positives on one SKILL.md).
  if (!PINID_ATTEMPT_PREFIX_RE.test(segment)) return null;
  if (isValidPinRef(segment)) return null;
  if (/^[0-9a-fA-F]{64}[iI]\d{1,3}$/.test(segment)) {
    return 'uppercase hex — a pinid must be 64 LOWERCASE hex characters + the output suffix (`i0` for self-minted pins)';
  }
  if (/^[0-9a-fA-F]{64}$/.test(segment)) {
    return '64 hex characters but missing the output suffix (a pinid is 64 lowercase hex + `i` + output index, e.g. `i0`)';
  }
  if (/^[0-9a-f]{64}i\d{4,}$/.test(segment)) {
    return 'malformed — the output index suffix is implausibly long (a pinid is 64 lowercase hex + `i` + output index, 67 chars max)';
  }
  return 'malformed — a pinid is EXACTLY 64 lowercase hex characters followed by `i` + output index (66+ chars, self-minted pins end in `i0`)';
}

function violation(location: string, found: string, problem: string): PinRefViolation {
  return { location, found, problem };
}

/** Scan free text for malformed `pin://` / `metafile://` / `metaapp://` references. */
export function scanPinUriViolations(text: string): PinRefViolation[] {
  const violations: PinRefViolation[] = [];
  // JSON.stringify can emit `\/`; normalize so `pin:\/\/` still matches the scan.
  const normalized = text.replace(/\\\//g, '/');
  for (const match of normalized.matchAll(PIN_URI_SCAN_RE)) {
    const token = match[1];
    const nextChar = normalized[match.index! + match[0].length] ?? '';
    const problem = judgeUriToken(token, nextChar);
    if (problem) violations.push(violation('text', match[0], problem));
  }
  return violations;
}

/**
 * Walk a parsed JSON payload and validate bare pin/txid-named string fields.
 * Key contract: a hex-blob value under a /pin/i key must be a well-formed
 * pinid; a hex-blob value under a /txid|txhash/i key must be a plain txid.
 * Full URI values are skipped here (the URI scan covers them).
 */
export function scanBareFieldViolations(parsed: unknown): PinRefViolation[] {
  const violations: PinRefViolation[] = [];
  const visit = (node: unknown, keyPath: string, depth: number): void => {
    if (violations.length >= 20 || depth > 8) return;
    if (Array.isArray(node)) {
      node.forEach((item) => visit(item, keyPath, depth + 1));
      return;
    }
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      const childPath = keyPath ? `${keyPath}.${key}` : key;
      if (typeof value === 'string') {
        if (HEX_BLOB_RE.test(value)) {
          if (/pin/i.test(key) && !isValidPinRef(value)) {
            violations.push(violation(`json:${childPath}`, value, `field "${key}" holds an invalid pinid — a pinid is EXACTLY 64 lowercase hex characters + \`i\` + output index (self-minted pins end in \`i0\`), not ${value.length} chars`));
          } else if (/txid|txhash/i.test(key) && !TXID_PATTERN.test(value)) {
            violations.push(violation(`json:${childPath}`, value, `field "${key}" must hold a plain 64-hex txid${isValidPinId(value) ? ' — you pasted a pinid (it ends in `i0`); strip the suffix or use the right field' : ''}`));
          }
        }
      } else if (value && typeof value === 'object') {
        visit(value, childPath, depth + 1);
      }
    }
  };
  visit(parsed, '', 0);
  return violations;
}

/**
 * Validate one createPin payload before broadcast. Returns an aggregated,
 * agent-readable error message when the write must be blocked, or null when
 * the payload carries no malformed pin references.
 *
 * Skipped inputs: Buffer payloads, base64-encoded payloads, and encrypted
 * (`encryption !== '0'`) payloads — nothing human-readable to validate there.
 */
export function validateChainWritePinRefs(metaidData: PinGuardMetaidData): string | null {
  const violations: PinRefViolation[] = [];

  // Modify path targeting an existing pin: `@<pinId>` (optionally `@<pinId>/…`).
  const path = typeof metaidData.path === 'string' ? metaidData.path.trim() : '';
  if (path.startsWith('@')) {
    const pinSegment = path.slice(1).split('/')[0];
    if (!isValidPinRef(pinSegment)) {
      violations.push(violation('path', path, `the \`@pinId\` modify path must carry a well-formed pinid (64 lowercase hex + \`i\` + output index, self-minted pins end in \`i0\`), got "${pinSegment}"`));
    }
  }

  const payload = metaidData.payload;
  const isReadableText =
    typeof payload === 'string'
    && metaidData.encoding !== 'base64'
    && (!metaidData.encryption || metaidData.encryption === '0');
  if (isReadableText && (payload as string).length > 0) {
    const text = payload as string;
    violations.push(...scanPinUriViolations(text));
    // Bare pin-named JSON fields only apply when the payload is actually JSON;
    // a prose text will simply fail JSON.parse and the URI scan already ran.
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object') {
        violations.push(...scanBareFieldViolations(parsed));
      }
    } catch {
      // Not JSON — prose/binary-as-text; URI scan above is the full check.
    }
  }

  if (!violations.length) return null;
  const shown = violations.slice(0, 5);
  const lines = shown.map((v) => `  - [${v.location}] "${v.found}" — ${v.problem}`);
  const more = violations.length > shown.length ? `\n  - …and ${violations.length - shown.length} more` : '';
  return [
    'Chain write BLOCKED before broadcast by the pin-reference format guard — nothing was sent on-chain and no fee was spent.',
    `Malformed pin reference(s) found (${violations.length}):`,
    ...lines,
    more,
    '',
    'A pinid is 64 lowercase hex characters followed by `i` and the output index — self-minted pins always end in `i0` (e.g. `' + PIN_ID_EXAMPLE + '`); a pin minted at another output index ends in `i1`, `i2`, … .',
    'Inside `pin://`, `metafile://`, and `metaapp://` URIs the same rule applies. Fix: copy the identifier VERBATIM from the tool result that produced it — never reconstruct it from memory, never truncate it — correct the payload, and retry the same write.',
  ].filter(Boolean).join('\n');
}

/**
 * Fail-closed gate for the shared createPin chokepoint. Throws (before the
 * worker spawns, before any spend) when the payload carries a malformed pin
 * reference. Never throws for clean payloads.
 */
export function assertChainWritePinRefs(metaidData: PinGuardMetaidData): void {
  const error = validateChainWritePinRefs(metaidData);
  if (error) throw new Error(error);
}

/**
 * Compact rule sentence for chain-write TOOL DESCRIPTIONS (post_buzz,
 * post_simplenote, omni_cast, post_metaprotocol, post/answer qa). Teaches the
 * same contract the guard enforces so the model formats references correctly
 * on the first try; the guard stays as the backstop.
 */
export const PIN_REF_TOOL_RULE =
  'Pin-reference format (enforced by the host BEFORE broadcast): every `pin://`, `metafile://`, or `metaapp://` URI and every pin-named JSON field must carry a pinid of EXACTLY 64 lowercase hex characters followed by `i` and the output index — pins minted by this host always end in `i0` (66 characters); references read from an indexer may end in another output index (e.g. `i1`) and must still be copied VERBATIM. Copy identifiers verbatim from the tool result that produced them, never from memory — a malformed reference is blocked before broadcast (nothing is sent, no fee is spent): fix it and retry the same write.';
