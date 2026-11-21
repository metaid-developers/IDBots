import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import MarkdownContent from '../src/renderer/components/MarkdownContent';
import MobilePageCard from '../src/renderer/components/chat/MobilePageCard';
import {
  isMobilePageCardFenceLanguage,
  isMobilePageCardExpired,
  mobilePageCardExpiryLabel,
  openMobilePageCard,
  parseMobilePageCardFence,
  serializeMobilePageCardFence,
  type MobilePageCardData,
} from '../src/renderer/components/chat/mobilePageCardSyntax';
import { buildMobilePageCardFence } from '../src/main/libs/mobilePageAgentTools';
import { i18nService } from '../src/renderer/services/i18n';

/**
 * `mobile-page-card` — mobile side of the server-mode page hosting feature.
 *
 * Pins the whole renderer contract:
 *  1. the fence parses only the same-origin `/pages/<token>/` route the
 *     gateway mints — an external URL, `javascript:`, traversal or a malformed
 *     token all degrade to the plain code block (no card, no live link);
 *  2. MarkdownContent really dispatches the fence to MobilePageCard (real SSR
 *     of the shared chat renderer), with title/description/open link;
 *  3. an expired grant renders a disabled card with no open link;
 *  4. the click contract is synchronous (no await before `window.open`):
 *     popup -> 'opened'; blocked popup -> same-tab 'navigated'; expired ->
 *     'expired' doing nothing;
 *  5. main-side emit and renderer-side parse agree byte-for-byte (the compiled
 *     builder's fence parses back through the renderer parser);
 *  6. both language decks carry the card copy (zh + en).
 */


/**
 * The card renders on the MOBILE runtime only (desktop keeps its existing
 * code-block rendering, byte-identical). Server-rendered tests fake the one
 * marker `isMobileBridgeRuntime()` reads.
 */
function withMobileRuntime(t: { after: (fn: () => void) => void }): void {
  const globals = globalThis as { window?: unknown };
  const previous = globals.window;
  globals.window = { idbotsMobile: { isMobile: true } };
  t.after(() => {
    if (previous === undefined) delete globals.window;
    else globals.window = previous;
  });
}

const NOW = Date.now();
const PAYLOAD: MobilePageCardData = {
  url: '/pages/eyJwIjoiL2RhdGEifQ.c2lnbmF0dXJlLXRlc3Q/',
  title: 'Weekly report',
  description: 'W47 · build status',
  expiresAt: NOW + 6 * 60 * 60 * 1000,
};

const fence = (data: Record<string, unknown>): string => ['```mobile-page-card', JSON.stringify(data), '```'].join('\n');

test('fence language + parsing accept the gateway page route', () => {
  assert.equal(isMobilePageCardFenceLanguage('mobile-page-card'), true);
  assert.equal(isMobilePageCardFenceLanguage('mobile-page'), true);
  assert.equal(isMobilePageCardFenceLanguage('nft-card'), false);

  const parsed = parseMobilePageCardFence(JSON.stringify(PAYLOAD));
  assert.deepEqual(parsed, PAYLOAD);
});

test('parsing refuses external / non-page / malformed payloads', () => {
  const base = { title: 'T', expiresAt: NOW + 60_000 };
  for (const url of [
    'https://evil.example.com/phish',
    'javascript:alert(1)',
    '//evil.example.com/pages/a.b/',
    '/pages/../../etc/passwd',
    '/pages/not-a-token/',
    '/pages/a.b/../../x',
    '/files/a.b/',
  ]) {
    assert.equal(parseMobilePageCardFence(JSON.stringify({ ...base, url })), null, `should refuse ${url}`);
  }
  assert.equal(parseMobilePageCardFence('{not json'), null);
  assert.equal(parseMobilePageCardFence(JSON.stringify({ url: PAYLOAD.url, expiresAt: NOW })), null, 'title required');
  assert.equal(parseMobilePageCardFence(JSON.stringify({ url: PAYLOAD.url, title: 'T' })), null, 'expiry required');
});

test('serialize -> parse round-trips', () => {
  const round = parseMobilePageCardFence(serializeMobilePageCardFence(PAYLOAD).split('\n')[1]);
  assert.deepEqual(round, PAYLOAD);
});

test('MarkdownContent renders the card (not a code block) for a valid fence', (t) => {
  withMobileRuntime(t);
  const html = renderToStaticMarkup(React.createElement(MarkdownContent, { content: fence(PAYLOAD) }));
  assert.match(html, /data-mobile-page-card/);
  assert.match(html, /data-mobile-page-url="\/pages\//);
  assert.match(html, /Weekly report/);
  assert.match(html, /W47 · build status/);
  assert.match(html, /data-mobile-page-open/);
  assert.match(html, /href="\/pages\//);
  assert.doesNotMatch(html, /language-mobile-page-card/);
});

test('an invalid payload keeps the plain code block (no live link)', (t) => {
  withMobileRuntime(t);
  const html = renderToStaticMarkup(
    React.createElement(MarkdownContent, {
      content: fence({ url: 'https://evil.example.com/x', title: 'Bad', expiresAt: NOW + 60_000 }),
    }),
  );
  assert.doesNotMatch(html, /data-mobile-page-card/);
  assert.doesNotMatch(html, /data-mobile-page-open/);
  assert.match(html, /https:\/\/evil\.example\.com\/x/);
});


test('desktop runtime keeps its existing rendering: the fence stays a code block', () => {
  // No window.idbotsMobile marker -> desktop renderer path, unchanged.
  const html = renderToStaticMarkup(React.createElement(MarkdownContent, { content: fence(PAYLOAD) }));
  assert.doesNotMatch(html, /data-mobile-page-card/);
  assert.match(html, /mobile-page-card/);
});

test('an expired grant renders a disabled card with no open link', () => {
  const expired = { ...PAYLOAD, expiresAt: NOW - 1 };
  assert.equal(isMobilePageCardExpired(expired, NOW), true);
  const html = renderToStaticMarkup(React.createElement(MobilePageCard, { data: expired }));
  assert.match(html, /data-mobile-page-expired="true"/);
  assert.doesNotMatch(html, /data-mobile-page-open/);
  assert.match(html, /data-mobile-page-expired-notice/);
});

test('expiry label reports whole hours left', () => {
  i18nService.setLanguage('en', { persist: false });
  const label = mobilePageCardExpiryLabel({ ...PAYLOAD, expiresAt: NOW + 6 * 3_600_000 }, NOW);
  assert.equal(label, 'Expires in 6 h');
});

test('click contract is synchronous: popup -> opened, blocked -> navigated, expired -> nothing', () => {
  const opened = [];
  const assigned = [];
  const outcomeOpen = openMobilePageCard(PAYLOAD, {
    open: (url, target, features) => {
      opened.push({ url, target, features });
      return {};
    },
    assign: (url) => assigned.push(url),
  }, NOW - 1_000);
  assert.equal(outcomeOpen, 'opened');
  assert.deepEqual(opened, [{ url: PAYLOAD.url, target: '_blank', features: 'noopener,noreferrer' }]);
  assert.deepEqual(assigned, []);

  const outcomeBlocked = openMobilePageCard(PAYLOAD, {
    open: () => null,
    assign: (url) => assigned.push(url),
  }, NOW);
  assert.equal(outcomeBlocked, 'navigated');
  assert.deepEqual(assigned, [PAYLOAD.url]);

  opened.length = 0;
  assigned.length = 0;
  const outcomeExpired = openMobilePageCard({ ...PAYLOAD, expiresAt: NOW - 1 }, {
    open: (url) => opened.push(url),
    assign: (url) => assigned.push(url),
  }, NOW);
  assert.equal(outcomeExpired, 'expired');
  assert.deepEqual(opened, []);
  assert.deepEqual(assigned, []);
});

test('main-side builder and renderer-side parser agree', () => {
  const built = buildMobilePageCardFence({
    url: PAYLOAD.url,
    title: PAYLOAD.title,
    description: PAYLOAD.description,
    expiresAt: PAYLOAD.expiresAt,
  });
  const parsed = parseMobilePageCardFence(built.split('\n')[1]);
  assert.deepEqual(parsed, PAYLOAD);
});

test('both language decks carry the card copy', () => {
  for (const key of [
    'mobilePageCardHeader',
    'mobilePageCardOpen',
    'mobilePageCardExpired',
    'mobilePageCardExpiredBody',
    'mobilePageCardExpiresInHours',
    'mobilePageCardExpiresSoon',
  ]) {
    i18nService.setLanguage('zh', { persist: false });
    const zh = i18nService.t(key);
    i18nService.setLanguage('en', { persist: false });
    const en = i18nService.t(key);
    assert.notEqual(zh, key, `zh missing ${key}`);
    assert.notEqual(en, key, `en missing ${key}`);
    assert.doesNotMatch(en, /[\u4e00-\u9fff]/, `en ${key} must stay English`);
  }
  i18nService.setLanguage('en', { persist: false });
});
