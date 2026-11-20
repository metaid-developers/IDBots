/**
 * C2 gateway tokens — HMAC-SHA256 signed, base64url-encoded.
 *
 * - File download tokens (C2 "File Download"):
 *     payload = base64url(JSON.stringify({ p, d, e, t }))
 *     token   = payload + "." + base64url(HMAC-SHA256(secret, payload))
 *   `p` resolved path, `d` disposition, `e` expiry (ms), `t` tenant id.
 * - Reverify tokens (C2 "Sensitive Route: Mnemonic Export"):
 *     payload = base64url(JSON.stringify({ t, p, e, n }))
 *     token   = payload + "." + base64url(HMAC-SHA256(secret, JSON))
 *   The signature input is the DECODED JSON string, not the base64url text —
 *   the control plane is the minter (cloud/control-plane/src/routes/
 *   sensitive.ts) and contract 01 §Sensitive Route defines it that way.
 *   `p` purpose, `n` random nonce; the tenant rejects reused nonces.
 * - Mobile page tokens (server mode `mobile_open_page`, C2 hosting):
 *     payload = base64url(JSON.stringify({ p, i, e, t }))
 *   `p` realpath'd page root, `i` entry file relative to the root. Same
 *   HMAC-over-base64url-text shape as file tokens; minted and verified in
 *   this process.
 *
 * Verification returns null on bad signature, wrong tenant, or expiry — the
 * HTTP routes map null to 404 (file) / 403 (reverify). Signature comparison
 * is constant-time (crypto.timingSafeEqual). Secrets are never logged.
 *
 * Pure module: node:crypto only, loadable from plain node.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export type FileTokenDisposition = 'inline' | 'attachment';

export interface FileTokenPayload {
  /** Resolved (realpath'd) file path. */
  p: string;
  /** Content-Disposition. */
  d: FileTokenDisposition;
  /** Expiry, ms since epoch. */
  e: number;
  /** Tenant id. */
  t: string;
}

export interface ReverifyTokenPayload {
  /** Tenant id. */
  t: string;
  /** Purpose, e.g. 'reveal-mnemonic'. */
  p: string;
  /** Expiry, ms since epoch. */
  e: number;
  /** Random nonce, single-use while unexpired. */
  n: string;
}

/**
 * Mobile page token (server mode `mobile_open_page`): a temporary hosting
 * grant for one page root directory.
 *
 *     payload = base64url(JSON.stringify({ p, i, e, t }))
 *     token   = payload + "." + base64url(HMAC-SHA256(secret, payload))
 *
 * `p` realpath'd page root, `i` entry file relative to the root (index.html
 * when a directory was hosted), `e` expiry, `t` tenant. Minted and verified
 * in this process (like file tokens, the signature input is the base64url
 * text). A page token never grants a path outside `p`: the pages route
 * resolves every requested asset under the root and re-checks containment.
 */
export interface PageTokenPayload {
  /** Resolved (realpath'd) page root directory. */
  p: string;
  /** Entry file relative to `p` (no separators). */
  i: string;
  /** Expiry, ms since epoch. */
  e: number;
  /** Tenant id. */
  t: string;
  /**
   * Single-file hosting: when 1, ONLY the entry file is servable (the caller
   * handed the tool one .html file, not a page directory), so the token can
   * never expose sibling files that happen to share the parent directory.
   */
  s?: 0 | 1;
}

// ---------------------------------------------------------------------------
// base64url helpers (padding-free, strict alphabet)
// ---------------------------------------------------------------------------

const B64URL_ALPHABET = /^[A-Za-z0-9_-]+$/;

export function base64urlEncode(data: Buffer | string): string {
  const buffer = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Returns null on characters outside the base64url alphabet. */
export function base64urlDecode(text: string): Buffer | null {
  if (text.length === 0 || !B64URL_ALPHABET.test(text)) return null;
  const base64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const padding = (4 - (base64.length % 4)) % 4;
  return Buffer.from(base64 + '='.repeat(padding), 'base64');
}

function hmacSignature(secret: string, payload: string): string {
  return base64urlEncode(createHmac('sha256', secret).update(payload, 'utf8').digest());
}

function constantTimeEqual(a: string, b: string): boolean {
  const aBuffer = Buffer.from(a, 'utf8');
  const bBuffer = Buffer.from(b, 'utf8');
  if (aBuffer.length !== bBuffer.length) return false;
  return timingSafeEqual(aBuffer, bBuffer);
}

function splitToken(token: string): { payload: string; signature: string } | null {
  const parts = token.split('.');
  if (parts.length !== 2 || parts[0].length === 0 || parts[1].length === 0) return null;
  return { payload: parts[0], signature: parts[1] };
}

// ---------------------------------------------------------------------------
// File download tokens
// ---------------------------------------------------------------------------

export function signFileToken(
  secret: string,
  tenantId: string,
  resolvedPath: string,
  disposition: FileTokenDisposition,
  expiresAt: number,
): string {
  const payload = base64urlEncode(JSON.stringify({ p: resolvedPath, d: disposition, e: expiresAt, t: tenantId }));
  return `${payload}.${hmacSignature(secret, payload)}`;
}

export function verifyFileToken(
  secret: string,
  tenantId: string,
  token: string,
  now: number = Date.now(),
): FileTokenPayload | null {
  const parts = splitToken(token);
  if (!parts) return null;
  if (!constantTimeEqual(hmacSignature(secret, parts.payload), parts.signature)) return null;
  const decoded = base64urlDecode(parts.payload);
  if (!decoded) return null;
  let payload: FileTokenPayload;
  try {
    payload = JSON.parse(decoded.toString('utf8'));
  } catch {
    return null;
  }
  if (
    !payload
    || typeof payload !== 'object'
    || typeof payload.p !== 'string'
    || typeof payload.e !== 'number'
    || typeof payload.t !== 'string'
  ) {
    return null;
  }
  if (payload.t !== tenantId) return null;
  if (payload.e <= now) return null;
  return payload;
}

// ---------------------------------------------------------------------------
// Mobile page tokens
// ---------------------------------------------------------------------------

/** Entry file names are plain file names: no separators, no traversal. */
const PAGE_ENTRY_NAME_RE = /^[A-Za-z0-9._-]{1,128}$/;

export function signPageToken(
  secret: string,
  tenantId: string,
  pageRoot: string,
  entry: string,
  expiresAt: number,
  singleFile: boolean = false,
): string {
  const payload = base64urlEncode(JSON.stringify({
    p: pageRoot,
    i: entry,
    e: expiresAt,
    t: tenantId,
    ...(singleFile ? { s: 1 } : {}),
  }));
  return `${payload}.${hmacSignature(secret, payload)}`;
}

export function verifyPageToken(
  secret: string,
  tenantId: string,
  token: string,
  now: number = Date.now(),
): PageTokenPayload | null {
  const parts = splitToken(token);
  if (!parts) return null;
  if (!constantTimeEqual(hmacSignature(secret, parts.payload), parts.signature)) return null;
  const decoded = base64urlDecode(parts.payload);
  if (!decoded) return null;
  let payload: PageTokenPayload;
  try {
    payload = JSON.parse(decoded.toString('utf8'));
  } catch {
    return null;
  }
  if (
    !payload
    || typeof payload !== 'object'
    || typeof payload.p !== 'string'
    || typeof payload.i !== 'string'
    || typeof payload.e !== 'number'
    || typeof payload.t !== 'string'
  ) {
    return null;
  }
  if (!PAGE_ENTRY_NAME_RE.test(payload.i) || payload.i === '.' || payload.i === '..' || payload.i.startsWith('.')) return null;
  if (payload.s !== undefined && payload.s !== 0 && payload.s !== 1) return null;
  if (payload.t !== tenantId) return null;
  if (payload.e <= now) return null;
  return payload;
}

// ---------------------------------------------------------------------------
// Reverify tokens
// ---------------------------------------------------------------------------

export function signReverifyToken(
  secret: string,
  tenantId: string,
  purpose: string,
  expiresAt: number,
  nonce: string,
): string {
  // Test/dev stand-in for the control-plane minter: signature over the raw
  // JSON string (see the module header — NOT over the base64url payload text).
  const json = JSON.stringify({ t: tenantId, p: purpose, e: expiresAt, n: nonce });
  return `${base64urlEncode(json)}.${hmacSignature(secret, json)}`;
}

export interface VerifyReverifyOptions {
  /** When given, the nonce is claimed on successful verification; a reuse fails. */
  nonceStore?: NonceStore;
  /** When given, a payload with a different purpose fails verification. */
  expectedPurpose?: string;
  now?: number;
}

export function verifyReverifyToken(
  secret: string,
  tenantId: string,
  token: string,
  options: VerifyReverifyOptions = {},
): ReverifyTokenPayload | null {
  const now = options.now ?? Date.now();
  const parts = splitToken(token);
  if (!parts) return null;
  // The control plane signs the decoded JSON string, so the HMAC input here
  // must be the decoded payload too (unlike file tokens, which are minted and
  // verified inside this process over the base64url text).
  const decoded = base64urlDecode(parts.payload);
  if (!decoded) return null;
  if (!constantTimeEqual(hmacSignature(secret, decoded.toString('utf8')), parts.signature)) return null;
  let payload: ReverifyTokenPayload;
  try {
    payload = JSON.parse(decoded.toString('utf8'));
  } catch {
    return null;
  }
  if (
    !payload
    || typeof payload !== 'object'
    || typeof payload.t !== 'string'
    || typeof payload.p !== 'string'
    || typeof payload.e !== 'number'
    || typeof payload.n !== 'string'
  ) {
    return null;
  }
  if (payload.t !== tenantId) return null;
  if (payload.e <= now) return null;
  if (options.expectedPurpose && payload.p !== options.expectedPurpose) return null;
  if (options.nonceStore && !options.nonceStore.claim(payload.n, payload.e)) return null;
  return payload;
}

/**
 * Single-use nonce memory for the sensitive route (C2: "The tenant rejects
 * reused nonces (kept in memory until expiry)"). Expired entries are swept
 * lazily on every claim.
 */
export class NonceStore {
  private readonly entries = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Record `nonce` until `expiresAt`. False when the nonce is already present
   * and unexpired; an expired entry is swept and the claim succeeds.
   */
  claim(nonce: string, expiresAt: number): boolean {
    this.sweep();
    const existing = this.entries.get(nonce);
    if (existing !== undefined && existing > this.now()) {
      return false;
    }
    this.entries.set(nonce, expiresAt);
    return true;
  }

  sweep(): void {
    const now = this.now();
    for (const [nonce, expiresAt] of this.entries) {
      if (expiresAt <= now) {
        this.entries.delete(nonce);
      }
    }
  }

  get size(): number {
    this.sweep();
    return this.entries.size;
  }
}
