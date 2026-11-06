import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  findCoworkSearchOccurrences,
  getNextCoworkSearchIndex,
  isCoworkConversationSearchShortcut,
} from '../src/renderer/components/cowork/coworkConversationSearchUtils';
import { CoworkConversationSearchBar } from '../src/renderer/components/cowork/CoworkConversationSearch';
import { i18nService } from '../src/renderer/services/i18n';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sessionDetailSource = fs.readFileSync(
  path.join(projectRoot, 'src', 'renderer', 'components', 'cowork', 'CoworkSessionDetail.tsx'),
  'utf8',
);
const searchControllerSource = fs.readFileSync(
  path.join(projectRoot, 'src', 'renderer', 'components', 'cowork', 'CoworkConversationSearch.tsx'),
  'utf8',
);
const stylesheetSource = fs.readFileSync(
  path.join(projectRoot, 'src', 'renderer', 'index.css'),
  'utf8',
);

const shortcut = (overrides: Record<string, unknown> = {}) => ({
  key: 'f',
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...overrides,
});

const renderBar = (overrides: Record<string, unknown> = {}) => renderToStaticMarkup(
  <CoworkConversationSearchBar
    inputRef={React.createRef<HTMLInputElement>()}
    query="运行"
    resultCount={56}
    activeIndex={55}
    isSearching={false}
    isPartial={false}
    onQueryChange={() => {}}
    onNavigate={() => {}}
    onClose={() => {}}
    {...overrides}
  />,
);

test('conversation search finds case-insensitive Chinese, English, and literal regex characters', () => {
  assert.deepEqual(findCoworkSearchOccurrences('Run run RUN', 'run'), [
    { start: 0, end: 3 },
    { start: 4, end: 7 },
    { start: 8, end: 11 },
  ]);
  assert.deepEqual(findCoworkSearchOccurrences('先运行，再次运行', '运行'), [
    { start: 1, end: 3 },
    { start: 6, end: 8 },
  ]);
  assert.deepEqual(findCoworkSearchOccurrences('a+b a+b', 'a+b'), [
    { start: 0, end: 3 },
    { start: 4, end: 7 },
  ]);
  assert.deepEqual(findCoworkSearchOccurrences('aaaa', 'aa'), [
    { start: 0, end: 2 },
    { start: 2, end: 4 },
  ]);
  assert.deepEqual(findCoworkSearchOccurrences('anything', ''), []);
});

test('previous and next navigation wrap in both directions', () => {
  assert.equal(getNextCoworkSearchIndex(-1, 3, 'next'), 0);
  assert.equal(getNextCoworkSearchIndex(-1, 3, 'previous'), 2);
  assert.equal(getNextCoworkSearchIndex(0, 3, 'next'), 1);
  assert.equal(getNextCoworkSearchIndex(2, 3, 'next'), 0);
  assert.equal(getNextCoworkSearchIndex(0, 3, 'previous'), 2);
  assert.equal(getNextCoworkSearchIndex(1, 0, 'next'), -1);
});

test('Command+F and Control+F open search without accepting modified or unrelated shortcuts', () => {
  assert.equal(isCoworkConversationSearchShortcut(shortcut({ metaKey: true })), true);
  assert.equal(isCoworkConversationSearchShortcut(shortcut({ ctrlKey: true, key: 'F' })), true);
  assert.equal(isCoworkConversationSearchShortcut(shortcut({ metaKey: true, altKey: true })), false);
  assert.equal(isCoworkConversationSearchShortcut(shortcut({ ctrlKey: true, shiftKey: true })), false);
  assert.equal(isCoworkConversationSearchShortcut(shortcut({ metaKey: true, key: 'g' })), false);
  assert.equal(isCoworkConversationSearchShortcut(shortcut()), false);
});

test('search bar renders the query, result position, navigation, and close controls', () => {
  const markup = renderBar();
  assert.match(markup, /role="search"/);
  assert.match(markup, /value="运行"/);
  assert.ok(markup.includes(i18nService.t('coworkConversationSearchPrevious')));
  assert.ok(markup.includes(i18nService.t('coworkConversationSearchNext')));
  assert.ok(markup.includes('56/56'));
  assert.match(markup, /tabular-nums/);
  assert.match(markup, /aria-live="polite"/);
});

test('search bar disables navigation without matches and exposes searching and partial states', () => {
  const emptyMarkup = renderBar({ resultCount: 0, activeIndex: -1 });
  assert.match(emptyMarkup, /0\/0/);
  assert.match(emptyMarkup, /disabled=""/);
  assert.ok(renderBar({ isSearching: true }).includes(i18nService.t('coworkConversationSearchSearching')));
  const partialMarkup = renderBar({ isPartial: true, resultCount: 2, activeIndex: 0 });
  assert.ok(partialMarkup.includes(
    i18nService.t('coworkConversationSearchPartialResults').replace('{count}', '2'),
  ));
});

test('session detail wires a local-only search trigger before the folder action and mounts the search panel', () => {
  assert.match(sessionDetailSource, /currentSession\?\.sessionType !== 'a2a'/);
  const triggerIndex = sessionDetailSource.indexOf('data-cowork-conversation-search-trigger');
  const folderIndex = sessionDetailSource.indexOf('{/* Folder button */}');
  assert.ok(triggerIndex >= 0 && triggerIndex < folderIndex);
  assert.match(sessionDetailSource, /<CoworkConversationSearch/);
  assert.match(sessionDetailSource, /contentVersion=\{currentSession\.messages\}/);
  assert.match(sessionDetailSource, /onBeforeNavigate=\{handleConversationSearchNavigate\}/);
});

test('search controller supports keyboard navigation and non-mutating CSS highlights', () => {
  assert.match(searchControllerSource, /event\.shiftKey \? 'previous' : 'next'/);
  assert.match(searchControllerSource, /event\.nativeEvent\.isComposing/);
  assert.match(searchControllerSource, /inputRef\.current\?\.select\(\)/);
  assert.match(searchControllerSource, /event\.key === 'Escape'/);
  assert.match(searchControllerSource, /loadEarlierMessages\(\)/);
  assert.match(searchControllerSource, /findCoworkConversationSearchMatches/);
  assert.match(searchControllerSource, /scrollCoworkSearchMatchIntoView/);
  assert.match(stylesheetSource, /::highlight\(cowork-conversation-search\)/);
  assert.match(stylesheetSource, /::highlight\(cowork-conversation-search-active\)/);
});
