import test from 'node:test';
import assert from 'node:assert/strict';

import { buildMarkedElementsBlock } from '../src/renderer/features/botBrowser/markedElementsPrompt';
import type { BrowserElementSelectionsSnapshot } from '@openagentinternet/agent-browser-host-contract';
import type { MarkedElementsTurnCapture } from '../src/renderer/features/botBrowser/elementSelectionsStore';

const selection = (overrides: Record<string, unknown> = {}) => ({
  markerId: 'marker-1',
  name: 'Marker 1',
  comment: '',
  capturedAt: '2026-11-10T08:15:42.183Z',
  page: { url: 'metaapp://abc', title: 'Chess App' },
  frame: { url: '/api/browser/preview-assets/preview-7/index.html' },
  locator: {
    cssSelector: '#app > button.play-btn',
    cssScope: 'document',
    xpath: '/html[1]/body[1]/div[1]/button[2]',
  },
  element: {
    tag: 'button',
    id: 'play-btn',
    classes: ['play-btn', 'primary'],
    attributes: {},
    role: 'button',
    accessibleName: 'Play game',
    textPreview: 'Play game',
    outerHtmlPreview: '<button id="play-btn">',
  },
  geometry: {},
  style: {},
  ...overrides,
});

const captureOf = (
  snapshot: Partial<BrowserElementSelectionsSnapshot>,
  stale = false,
): MarkedElementsTurnCapture => ({
  snapshot: {
    tabId: 3,
    uri: 'metaapp://abc',
    title: 'Chess App',
    selections: [selection()],
    ...snapshot,
  } as BrowserElementSelectionsSnapshot,
  stale,
});

test('block renders header, element descriptor, locator, text, and verbatim comment', () => {
  const block = buildMarkedElementsBlock(captureOf({
    selections: [selection({ comment: 'Make the label uppercase' })],
  }));

  assert.match(block, /^> Marked elements on "Chess App" \(`metaapp:\/\/abc`\)/);
  assert.match(block, /refers to these marks/);
  assert.match(block, /> 1\. Marker 1 — `<button#play-btn\.play-btn\.primary>`/);
  assert.match(block, />    locator \(document\): `#app > button\.play-btn`/);
  assert.match(block, />    text: Play game/);
  assert.match(block, />    comment: Make the label uppercase/);
});

test('human comments stay verbatim including non-English text', () => {
  const block = buildMarkedElementsBlock(captureOf({
    selections: [selection({ comment: '把这个按钮放大一点' })],
  }));
  assert.match(block, /comment: 把这个按钮放大一点/);
});

test('xpath is the fallback locator and cssScope labels come from the snapshot', () => {
  const block = buildMarkedElementsBlock(captureOf({
    selections: [selection({
      locator: { cssSelector: '', cssScope: 'browser-pane', xpath: '/html[1]/body[1]/div[1]' },
    })],
  }));
  assert.match(block, />    xpath: `\/html\[1\]\/body\[1\]\/div\[1\]`/);
  assert.doesNotMatch(block, /locator \(/);
});

test('multiline comments and text flatten to one blockquote line', () => {
  const block = buildMarkedElementsBlock(captureOf({
    selections: [selection({
      comment: 'first line\nsecond line',
      element: { tag: 'p', id: '', classes: [], textPreview: 'para one\npara two' },
    })],
  }));
  assert.match(block, /comment: first line \/ second line/);
  assert.match(block, /text: para one \/ para two/);
  assert.doesNotMatch(block, /\n[^\n>]/);
});

test('the block caps entries and reports the omitted remainder', () => {
  const selections = Array.from({ length: 13 }, (_, index) => selection({ name: `Marker ${index + 1}` }));
  const block = buildMarkedElementsBlock(captureOf({ selections }));
  assert.match(block, /> 10\. Marker 10 —/);
  assert.doesNotMatch(block, /Marker 11 —/);
  assert.match(block, /> … 3 more marked elements omitted\./);
});

test('stale captures carry the pre-navigation note', () => {
  const block = buildMarkedElementsBlock(captureOf({}, true));
  assert.match(block, /captured before the latest navigation/);
  const fresh = buildMarkedElementsBlock(captureOf({}, false));
  assert.doesNotMatch(fresh, /captured before the latest navigation/);
});

test('empty snapshots and missing titles still render sanely', () => {
  assert.equal(buildMarkedElementsBlock({ snapshot: { tabId: 1, uri: '', title: '', selections: [] } as BrowserElementSelectionsSnapshot, stale: false }), '');
  const block = buildMarkedElementsBlock(captureOf({ title: '', uri: '' }));
  assert.match(block, /> Marked elements on "untitled page" —/);
});
