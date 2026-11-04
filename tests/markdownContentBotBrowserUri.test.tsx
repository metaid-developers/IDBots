import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import MarkdownContent, { isBotBrowserUri, linkifyAgentInternetUris } from '../src/renderer/components/MarkdownContent';

test('isBotBrowserUri recognizes agent internet schemes', () => {
  assert.equal(isBotBrowserUri('metaapp://abc123i0'), true);
  assert.equal(isBotBrowserUri('metaid://idq1xyz'), true);
  assert.equal(isBotBrowserUri('map://alias'), true);
  assert.equal(isBotBrowserUri('metafile://pin.png'), true);
  assert.equal(isBotBrowserUri('preview-metaapp://localhost/tmp/app'), true);
  assert.equal(isBotBrowserUri('https://example.com'), false);
  assert.equal(isBotBrowserUri('file:///tmp/a'), false);
  assert.equal(isBotBrowserUri('javascript:alert(1)'), false);
});

test('agent internet links keep their href and become clickable with an opener', () => {
  const markup = renderToStaticMarkup(
    React.createElement(MarkdownContent, {
      content: '[Buzz Client](metaapp://84b78cchi0) and [Bob](metaid://idq1xyz)',
      onOpenBotBrowserUri: () => {},
    }),
  );
  assert.match(markup, /href="metaapp:\/\/84b78cchi0"/);
  assert.match(markup, /href="metaid:\/\/idq1xyz"/);
});

test('agent internet links keep their href even without an opener', () => {
  const markup = renderToStaticMarkup(
    React.createElement(MarkdownContent, {
      content: '[Buzz Client](metaapp://84b78cchi0)',
    }),
  );
  assert.match(markup, /href="metaapp:\/\/84b78cchi0"/);
});

test('dangerous schemes are stripped by the url transform', () => {
  const markup = renderToStaticMarkup(
    React.createElement(MarkdownContent, {
      content: '[x](javascript:alert(1))',
    }),
  );
  assert.doesNotMatch(markup, /javascript:/);
});

test('bare agent internet uris are linkified; existing links and code are untouched', () => {
  const input = [
    'play metaapp://6185c9f340c0be92c0466503c53c8c1b54e91dbd472c70c852aa127c35c72ecbi0 now',
    'already [linked](metaid://idq1xyz)',
    '`code metaapp://aaa`',
    'see https://example.com',
  ].join('\n');
  const output = linkifyAgentInternetUris(input);
  assert.match(output, /\[metaapp:\/\/6185c9f340c0be92c0466503c53c8c1b54e91dbd472c70c852aa127c35c72ecbi0\]\(metaapp:\/\/6185c9f340c0be92c0466503c53c8c1b54e91dbd472c70c852aa127c35c72ecbi0\)/);
  // No double-wrapping of existing markdown links
  assert.equal((output.match(/\[linked\]\(metaid:\/\/idq1xyz\)/g) || []).length, 1);
  // R3: a metaweb URI wrapped in INLINE backticks is now linkified too (bots
  // habitually wrap URIs in backticks); only code BLOCKS stay verbatim.
  assert.match(output, /\[metaapp:\/\/aaa\]\(metaapp:\/\/aaa\)/);
  assert.doesNotMatch(output, /\[https:\/\/example\.com\]/);
});

test('linkify trims trailing punctuation and covers all agent internet schemes', () => {
  const output = linkifyAgentInternetUris('open metaid://idq1abc, then pin://deadbeef.');
  assert.match(output, /\[metaid:\/\/idq1abc\]\(metaid:\/\/idq1abc\),/);
  assert.match(output, /\[pin:\/\/deadbeef\]\(pin:\/\/deadbeef\)\./);
});

test('R3: a bare pin id (64 hex + i0) becomes a clickable pin:// link', () => {
  const pin = '9d51fea7b26fc0ded56d436d85425c960593ac216b8ca46096f43b73255875f6i0';
  const output = linkifyAgentInternetUris(`see deliverable ${pin} for details`);
  assert.match(output, new RegExp(`\\[${pin}\\]\\(pin://${pin}\\)`));
});

test('R3: a bare pin id that is the tail of a scheme URI is NOT double-linkified', () => {
  const pin = '9d51fea7b26fc0ded56d436d85425c960593ac216b8ca46096f43b73255875f6i0';
  const output = linkifyAgentInternetUris(`metaapp://${pin}`);
  // The whole URI becomes one link; the pin tail is not separately wrapped.
  assert.match(output, new RegExp(`\\[metaapp://${pin}\\]\\(metaapp://${pin}\\)`));
  assert.doesNotMatch(output, new RegExp(`\\[${pin}\\]\\(pin://${pin}\\)`));
});

test('R3: a metaweb URI wrapped in inline backticks is still linkified', () => {
  const output = linkifyAgentInternetUris('deliverable at `metaapp://abc123i0`');
  assert.match(output, /\[metaapp:\/\/abc123i0\]\(metaapp:\/\/abc123i0\)/);
});

test('R3: a code BLOCK (triple backtick) is left untouched', () => {
  const output = linkifyAgentInternetUris('```\nmetaapp://abc123i0\n```');
  assert.doesNotMatch(output, /\[metaapp:\/\/abc123i0\]/);
  assert.match(output, /metaapp:\/\/abc123i0/);
});

test('R3: inline backticks without a URI are preserved as code', () => {
  const output = linkifyAgentInternetUris('plain `code snippet` here');
  assert.equal(output, 'plain `code snippet` here');
});

const REWRITE_PIN = '1efcf89496d74d839012d65feb00634b60cc791bd593cb0699d3ac6e99edefa7i0';

test('Web2 pin-viewer URLs (metaid.io / openagentinternet.org) are rewritten to MetaWeb URIs', () => {
  const output = linkifyAgentInternetUris(
    `see [this pin](https://www.metaid.io/pin/${REWRITE_PIN}) and https://openagentinternet.org/browser/buzz/${REWRITE_PIN}`,
  );
  // Markdown link destination rewritten, label untouched.
  assert.match(output, new RegExp(`\\[this pin\\]\\(pin://${REWRITE_PIN}\\)`));
  // Bare buzz viewer URL rewritten to the universal pin:// scheme and linkified.
  assert.match(output, new RegExp(`\\[pin://${REWRITE_PIN}\\]\\(pin://${REWRITE_PIN}\\)`));
  assert.doesNotMatch(output, /metaid\.io|openagentinternet\.org/);
});

test('Web2 viewer rewrite maps the app/file kinds to their schemes', () => {
  const output = linkifyAgentInternetUris(
    `app https://openagentinternet.org/browser/metaapp/${REWRITE_PIN} file https://openagentinternet.org/browser/metafile/${REWRITE_PIN}`,
  );
  assert.match(output, new RegExp(`\\[metaapp://${REWRITE_PIN}\\]\\(metaapp://${REWRITE_PIN}\\)`));
  assert.match(output, new RegExp(`\\[metafile://${REWRITE_PIN}\\]\\(metafile://${REWRITE_PIN}\\)`));
});

test('Web2 viewer rewrite ignores non-viewer URLs and code blocks', () => {
  const input = [
    'docs at https://www.metaid.io/docs remain plain web links',
    '```',
    `https://www.metaid.io/pin/${REWRITE_PIN}`,
    '```',
  ].join('\n');
  const output = linkifyAgentInternetUris(input);
  // Non-viewer https URLs are not linkified and not rewritten; the viewer URL
  // inside a code block stays verbatim.
  assert.equal(output, input);
});

test('Web2 viewer rewrite drops ?query/#fragment residue', () => {
  const output = linkifyAgentInternetUris(
    `[doc](https://www.metaid.io/pin/${REWRITE_PIN}?from=feed#anchor) and bare https://openagentinternet.org/browser/pin/${REWRITE_PIN}?utm=x`,
  );
  assert.match(output, new RegExp(`\\[doc\\]\\(pin://${REWRITE_PIN}\\)`));
  assert.match(output, new RegExp(`\\[pin://${REWRITE_PIN}\\]\\(pin://${REWRITE_PIN}\\)`));
  assert.doesNotMatch(output, /\?from=feed|\?utm=x|#anchor/);
});

test('Web2 viewer URLs inside INLINE code spans are rewritten too (they must stay clickable)', () => {
  const output = linkifyAgentInternetUris('deliverable at `https://www.metaid.io/pin/' + REWRITE_PIN + '`');
  assert.match(output, new RegExp(`\\[pin://${REWRITE_PIN}\\]\\(pin://${REWRITE_PIN}\\)`));
  assert.doesNotMatch(output, /metaid\.io/);
});

test('session deep links (idbots://session/<id>) keep their href and render clickable', () => {
  const markup = renderToStaticMarkup(
    React.createElement(MarkdownContent, {
      content: '[Open report context](idbots://session/3f6f8c42-9d1b-4a7e-b5c2-71d0e9a4f6c2)',
    }),
  );
  assert.match(markup, /href="idbots:\/\/session\//);
});

test('bare IDBots://<sessionId> markdown links keep their href and render clickable', () => {
  // The canonical user-facing form (copy-session-link menu, cross-session
  // refs, bot instructions) — the click must dispatch cowork:viewSession via
  // the shared deep-link path, not land on the "Unsupported idbots:// link"
  // console warning.
  const markup = renderToStaticMarkup(
    React.createElement(MarkdownContent, {
      content: '[聊天 NFT 卡片会话](IDBots://2799a548-f81c-4cf0-a664-eaebe5236c1b)',
    }),
  );
  assert.match(markup, /href="IDBots:\/\/2799a548-f81c-4cf0-a664-eaebe5236c1b"/);
});

test('bare IDBots://<sessionId> in plain text is linkified like agent internet URIs', () => {
  const output = linkifyAgentInternetUris('see IDBots://2799a548-f81c-4cf0-a664-eaebe5236c1b for the NFT cards.');
  assert.match(output, /\[IDBots:\/\/2799a548-f81c-4cf0-a664-eaebe5236c1b\]\(IDBots:\/\/2799a548-f81c-4cf0-a664-eaebe5236c1b\) for/);
  // Already a markdown link destination — not double-wrapped.
  const linked = linkifyAgentInternetUris('[jump](IDBots://2799a548-f81c-4cf0-a664-eaebe5236c1b)');
  assert.equal((linked.match(/\[jump\]\(IDBots:\/\/2799a548-f81c-4cf0-a664-eaebe5236c1b\)/g) || []).length, 1);
});

test('bare session deep links are linkified like agent internet URIs', () => {
  const output = linkifyAgentInternetUris('see idbots://session/abc-123_456 for the full briefing.');
  assert.match(output, /\[idbots:\/\/session\/abc-123_456\]\(idbots:\/\/session\/abc-123_456\) for/);
  // Already a markdown link destination — not double-wrapped.
  const linked = linkifyAgentInternetUris('[jump](idbots://session/abc-123_456)');
  assert.equal((linked.match(/\[jump\]\(idbots:\/\/session\/abc-123_456\)/g) || []).length, 1);
});
