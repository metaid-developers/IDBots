/**
 * mobile-page-card fence syntax — the chat contract for pages a bot hosted on
 * the tenant gateway (`mobile_open_page`, server mode).
 *
 * A bot posts a fenced code block whose tag is `mobile-page-card` and whose
 * body is one JSON object:
 *
 * ```mobile-page-card
 * {"url":"/pages/<token>/","title":"周报 · 2026-W47","description":"…",
 *  "expiresAt":1795273106906}
 * ```
 *
 * The renderer turns it into a tappable card; tapping opens the page in the
 * phone's built-in browser. Two rules this module enforces on the way in:
 *
 *  1. the URL must be the SAME-ORIGIN page route (`/pages/<token>/`) the
 *     gateway issues — never an arbitrary external URL smuggled through a
 *     bot reply, and never a `javascript:`/`data:` shape. Traversal is
 *     rejected here too (defense in depth: the route re-checks it);
 *  2. an expired grant renders a disabled card instead of a dead link
 *     (the server answers 404 after expiry; showing a live-looking button
 *     that fails is worse than saying so).
 *
 * Unparsable payloads keep the plain code-block rendering, exactly like the
 * nft-card / pay-card / escrow-card fences: a hostile or truncated fence
 * degrades to what every client already renders.
 *
 * This module is DOM-free so server-rendered tests drive it directly.
 */

import { i18nService } from '../../services/i18n';

export const MOBILE_PAGE_CARD_FENCE_TAG = 'mobile-page-card';
const MOBILE_PAGE_CARD_FENCE_TAGS = new Set(['mobile-page-card', 'mobile-page']);

/** Same-origin hosting route prefix minted by the tenant gateway. */
export const MOBILE_PAGE_CARD_URL_PREFIX = '/pages/';

/** base64url payload + '.' + base64url signature; the gateway page token shape. */
const PAGE_TOKEN_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

const MAX_TITLE_CHARS = 120;
const MAX_DESCRIPTION_CHARS = 300;

export function isMobilePageCardFenceLanguage(language: string | null | undefined): boolean {
  if (!language) return false;
  return MOBILE_PAGE_CARD_FENCE_TAGS.has(language.trim().toLowerCase());
}

export interface MobilePageCardData {
  /** Same-origin route, always `/pages/<token>/`. */
  url: string;
  title: string;
  description?: string;
  /** Grant expiry, ms since epoch. */
  expiresAt: number;
}

const cleanText = (value: unknown, max: number): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, max);
};

/**
 * True only for the page route the gateway mints: `/pages/<token>/` with a
 * single dot in the token, no `..`, no backslash, no scheme, no query.
 */
export function isMobilePageCardUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const url = value.trim();
  if (!url.startsWith(MOBILE_PAGE_CARD_URL_PREFIX)) return false;
  if (url.includes('\\') || url.includes('..') || url.includes('?') || url.includes('#')) return false;
  const rest = url.slice(MOBILE_PAGE_CARD_URL_PREFIX.length);
  const token = rest.endsWith('/') ? rest.slice(0, -1) : rest;
  if (!token || token.includes('/')) return false;
  return PAGE_TOKEN_RE.test(token);
}

export function parseMobilePageCardFence(body: string): MobilePageCardData | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const raw = parsed as Record<string, unknown>;

  const url = cleanText(raw.url, 2048);
  if (!url || !isMobilePageCardUrl(url)) return null;

  const title = cleanText(raw.title, MAX_TITLE_CHARS);
  if (!title) return null;

  const expiresAt = typeof raw.expiresAt === 'number' ? raw.expiresAt : Number.NaN;
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) return null;

  const description = cleanText(raw.description, MAX_DESCRIPTION_CHARS);
  return { url: url.endsWith('/') ? url : `${url}/`, title, ...(description ? { description } : {}), expiresAt };
}

export function serializeMobilePageCardFence(data: MobilePageCardData): string {
  const body = JSON.stringify({
    url: data.url,
    title: data.title,
    ...(data.description ? { description: data.description } : {}),
    expiresAt: data.expiresAt,
  });
  return ['```' + MOBILE_PAGE_CARD_FENCE_TAG, body, '```'].join('\n');
}

/** True once the grant has expired (server answers 404 from then on). */
export function isMobilePageCardExpired(data: MobilePageCardData, now: number = Date.now()): boolean {
  return data.expiresAt <= now;
}

/** Whole hours left before expiry, floored at 0. */
export function mobilePageCardHoursLeft(data: MobilePageCardData, now: number = Date.now()): number {
  return Math.max(0, Math.floor((data.expiresAt - now) / 3_600_000));
}

export function mobilePageCardExpiryLabel(data: MobilePageCardData, now: number = Date.now()): string {
  const hours = mobilePageCardHoursLeft(data, now);
  if (hours >= 1) {
    return i18nService.t('mobilePageCardExpiresInHours').replace('{hours}', String(hours));
  }
  return i18nService.t('mobilePageCardExpiresSoon');
}

/** The slice of `window` the card's click handler needs (injected for tests). */
export interface MobilePageOpenHost {
  /** `window.open(url, '_blank', 'noopener,noreferrer')`. */
  open?: (url: string, target: string, features: string) => unknown;
  /** Same-tab navigation fallback (`window.location.assign`). */
  assign: (url: string) => void;
}

export type MobilePageOpenOutcome = 'expired' | 'opened' | 'navigated';

/**
 * Click contract of the card, DOM-free so behavior is testable directly.
 *
 * Order matters: everything here is SYNCHRONOUS — the URL is already resolved
 * at render time, so the user gesture is still live when `window.open` runs
 * (the `installShim.ts` ~L227 lesson: no `await` before the open, or phones
 * popup-block it). A blocked popup falls back to same-tab navigation; an
 * expired grant does nothing at all (the server answers 404 from then on).
 */
export function openMobilePageCard(
  data: MobilePageCardData,
  host: MobilePageOpenHost,
  now: number = Date.now(),
): MobilePageOpenOutcome {
  if (isMobilePageCardExpired(data, now)) return 'expired';
  try {
    const opened = host.open?.(data.url, '_blank', 'noopener,noreferrer');
    if (opened) return 'opened';
  } catch {
    // Popup blocked / window.open unavailable -> fall through to navigation.
  }
  host.assign(data.url);
  return 'navigated';
}
