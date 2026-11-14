// Mobile chat emoji picker — vendored catalog, display mapping, caret
// insertion, panel SSR, and ChatScreen wiring.
//
// Harness note (same convention as tests/mobileQuotaExhausted.test.tsx and
// the desktop tests/emojiPickerComposer.test.tsx): renderer tests here are
// server-rendered (no DOM/jsdom), so event handlers cannot be fired by
// mounting. The panel and the message-bubble display mapping are asserted
// via SSR markup; the composer's caret-insertion WIRING is pinned against
// the real ChatScreen source, which is this repo's established convention
// for handler-contract coverage.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import ChatScreen from '../src/mobile/app/screens/ChatScreen.tsx';
import {
  EmojiPickerPanel,
  rememberRecentEmoji,
  recentEmojiChars,
  parsePersistedRecentEmoji,
  restoreRecentEmojiFromStorage,
} from '../src/mobile/app/components/EmojiPickerPanel.tsx';
import { EMOJI_CATEGORIES, countEmojiCatalogEntries, searchEmoji } from '../src/mobile/app/chat/emojiData.ts';
import { mapWechatBracketCodesForDisplay, WECHAT_BRACKET_EMOJI_MAP, WECHAT_BRACKET_CODE_COUNT } from '../src/mobile/app/chat/wechatEmojiDisplay.ts';
import { insertEmojiAtCaret } from '../src/mobile/app/chat/emojiTextInsert.ts';
import { mobileI18n, t } from '../src/mobile/i18n.ts';
import { TWEMOJI_CHARS, TWEMOJI_ASSET_COUNT, twemojiUrlFor } from '../src/renderer/components/chat/twemoji.ts';
import type { useChat } from '../src/mobile/app/hooks/useChat.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const readSource = (relative: string): string =>
  fs.readFileSync(path.join(here, relative), 'utf-8');

type Chat = ReturnType<typeof useChat>;

// ---------------------------------------------------------------------------
// 1. Vendored catalog integrity
// ---------------------------------------------------------------------------

test('emoji catalog is the single WeChat first-panel page (vendored from desktop, runtime-identical)', () => {
  // Owner call 2026-10-29 (final scope): ONE tab — the smileys/emotion page
  // with recents embedded as a strip, like WeChat's own first panel. Exactly
  // 85 entries: the 78 WeChat bracket-code targets (77 unique chars —
  // [得意]/[奸笑] share 😏) plus the curated laugh/think family, 🙏 and 🎉.
  const total = countEmojiCatalogEntries();
  assert.equal(total, 85, `expected the 85-entry WeChat first panel, got ${total}`);
  assert.equal(EMOJI_CATEGORIES.length, 1, 'a single category (no tabs)');
  assert.equal(EMOJI_CATEGORIES[0].id, 'smileys');
  for (const category of EMOJI_CATEGORIES) {
    assert.ok(category.emojis.length > 0, `category ${category.id} is empty`);
    for (const emoji of category.emojis) {
      assert.ok(emoji.char.length > 0, `entry with empty char in ${category.id}`);
      assert.ok(!emoji.char.includes('[') && !emoji.char.includes(']'), `entry char is a bracket code: ${emoji.char}`);
    }
  }
  // Every bracket-code target is pickable in the panel.
  const catalogChars = new Set(EMOJI_CATEGORIES.flatMap((c) => c.emojis.map((e) => e.char)));
  for (const [code, emoji] of Object.entries(WECHAT_BRACKET_EMOJI_MAP)) {
    assert.ok(catalogChars.has(emoji), `[${code}] target ${emoji} missing from the picker catalog`);
  }
});

test('the ordered catalog matches the pinned WeChat-panel sequence (desktop/mobile identity anchor)', () => {
  // The desktop picker carries this exact catalog; both worktrees pin the
  // same 85-char ordered sequence in their tests, so any drift between the
  // two ends fails one of the two suites.
  const expected = [
    '🙂', '😕', '😍', '😳', '😏', '😢', '🤐', '😴', '😭', '😓',
    '😠', '😜', '😁', '😮', '😔', '😎', '😅', '😫', '🤮', '🤭',
    '👃', '🤦', '🙁', '🥰', '🙄', '😤', '💦', '😥', '😃', '😌',
    '🥺', '😿', '😱', '😊', '😵', '🤯', '😩', '💀', '🔨', '👋',
    '💪', '🤬', '❓', '🤫', '😨', '😒', '😀', '😄', '😆', '🤣',
    '😂', '🤔', '🤗', '👍', '👎', '🤝', '✌️', '👊', '✊', '😘',
    '💋', '👏', '🙇', '👌', '⛔', '🙏', '🐷', '🐔', '🌙', '☀️',
    '🌧', '☕', '🍰', '🍺', '🍚', '🍉', '⚽', '🌹', '🥀', '❤️',
    '💔', '🎁', '🧧', '🧨', '🎉',
  ];
  assert.equal(expected.length, 85, 'the pinned anchor itself must have 85 members');
  const actual = EMOJI_CATEGORIES.flatMap((c) => c.emojis.map((e) => e.char));
  assert.deepEqual(actual, expected, 'catalog order/content drifted from the pinned WeChat-panel sequence');
});

test('every catalog emoji has an embedded Twemoji data URI (85-entry subset, no CDN, packager-decoupled)', () => {
  // Display artwork: panel cells and bubbles render the bundled Twemoji
  // 14.0.2 subset (CC-BY 4.0 — LICENSES/twemoji-NOTICE.md). The manifest
  // must mirror the catalog 1:1 and resolve to EMBEDDED data:image/svg+xml
  // string literals carried inside twemoji.ts itself (the same single-module
  // contract as the desktop gate scripts/verify-twemoji-bundle.mjs) — no
  // `new URL(...)` asset files, which are the desktop-1.0.9-asar loss mode
  // ("dev fine, packaged fallback"). Each literal must be the EXACT Vite
  // svgToDataURL encoding of the vendored SVG on disk.
  assert.equal(TWEMOJI_ASSET_COUNT, 85, `expected 85 bundled assets, got ${TWEMOJI_ASSET_COUNT}`);
  const catalogChars = EMOJI_CATEGORIES.flatMap((c) => c.emojis.map((e) => e.char));
  assert.deepEqual([...TWEMOJI_CHARS], [...new Set(catalogChars)], 'manifest chars must equal the catalog chars in order');
  const manifestSource = readSource('../src/renderer/components/chat/twemoji.ts');
  const manifestCode = manifestSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!manifestCode.includes('new URL('), 'manifest must not regress to packager-dependent new URL() asset delivery');
  assert.ok(!manifestCode.includes('TWEMOJI_DATA_URLS'), 'manifest must not import a separate generated values module (single-module literal contract)');
  // The exact data URI encoding the manifest generator embeds (Vite svgToDataURL branch).
  const svgToDataUri = (content: string): string =>
    'data:image/svg+xml,' +
    content
      .replace(/"/g, "'")
      .replace(/%/g, '%25')
      .replace(/#/g, '%23')
      .replace(/</g, '%3c')
      .replace(/>/g, '%3e')
      .replace(/\?/g, '%3f')
      .replace(/\[/g, '%5b')
      .replace(/\]/g, '%5d')
      .replace(/\\/g, '%5c')
      .replace(/\{/g, '%7b')
      .replace(/\}/g, '%7d')
      .replace(/\|/g, '%7c')
      .replace(/\^/g, '%5e')
      .replace(/`/g, '%60')
      .replace(/\s/g, '%20');
  const stemOf = (ch: string): string =>
    [...ch].map((c) => c.codePointAt(0)!.toString(16)).filter((h) => h !== 'fe0f').join('-');
  const assetsDir = path.join(here, '..', 'src', 'renderer', 'components', 'chat', 'assets', 'twemoji');
  for (const char of catalogChars) {
    const url = twemojiUrlFor(char);
    assert.ok(url, `no bundled asset for ${char}`);
    assert.ok(url.startsWith('data:image/svg+xml,'), `${char} asset must be an embedded svg data URI, got ${url.slice(0, 40)}`);
    assert.ok(!/^https?:/.test(url), `${char} asset must not be a CDN URL`);
    const stem = stemOf(char);
    const vendored = fs.readFileSync(path.join(assetsDir, `${stem}.svg`), 'utf8');
    assert.equal(url, svgToDataUri(vendored), `${char} embedded artwork must be the exact svgToDataURL encoding of the vendored ${stem}.svg`);
  }
  // Exactly the 85-file subset lives in the assets dir (generation input,
  // never the full set).
  const svgs = fs.readdirSync(assetsDir).filter((f) => f.endsWith('.svg'));
  assert.equal(svgs.length, 85, `assets dir must hold exactly 85 SVGs, got ${svgs.length}`);
  // VS16 naming: upstream asset names strip fe0f (✌️ -> 270c).
  assert.match(stemOf('✌️'), /^270c$/);
  // Non-catalog chars fall back to the raw glyph (no asset, no throw).
  assert.equal(twemojiUrlFor('🚀'), null);
});

test('every category labelKey resolves in BOTH mobile dictionaries (zh + en)', () => {
  for (const lang of ['zh', 'en'] as const) {
    mobileI18n.setLanguage(lang);
    for (const category of EMOJI_CATEGORIES) {
      const key = `mobile.chat.${category.labelKey}`;
      const label = t(key);
      assert.notEqual(label, key, `${lang}: missing i18n value for ${key}`);
      assert.ok(label.trim().length > 0, `${lang}: empty label for ${key}`);
    }
    const aux = [
      'mobile.chat.emojiPicker',
      'mobile.chat.emojiSearch',
      'mobile.chat.emojiPickerNoResults',
      'mobile.chat.emojiCategoryRecent',
    ];
    for (const key of aux) {
      assert.notEqual(t(key), key, `${lang}: missing i18n value for ${key}`);
    }
  }
});

test('bilingual search finds emoji by Chinese and English keywords', () => {
  const zh = searchEmoji('玫瑰', 10).map((entry) => entry.char);
  assert.ok(zh.includes('🌹'), `zh keyword search failed: ${zh.join(',')}`);
  const en = searchEmoji('rose', 10).map((entry) => entry.char);
  assert.ok(en.includes('🌹'), `en keyword search failed: ${en.join(',')}`);
  assert.deepEqual(searchEmoji('   '), [], 'blank query returns nothing');
  // The emoji itself matches too (paste-to-find).
  assert.ok(searchEmoji('😀', 10).some((entry) => entry.char === '😀'));
});

// ---------------------------------------------------------------------------
// 2. WeChat bracket-code display mapping (shared ~78-code table with desktop, synced at 1a26c43a7)
// ---------------------------------------------------------------------------

test('the WeChat bracket table is the shared ~60+ code table with Unicode emoji values', () => {
  assert.ok(WECHAT_BRACKET_CODE_COUNT >= 60, `expected >= 60 codes, got ${WECHAT_BRACKET_CODE_COUNT}`);
  assert.ok(WECHAT_BRACKET_CODE_COUNT <= 100, 'table should stay a curated ~60-100, not a dump');
  for (const [code, emoji] of Object.entries(WECHAT_BRACKET_EMOJI_MAP)) {
    assert.ok(emoji.length > 0, `code ${code} maps to empty value`);
    assert.ok([...emoji].some((ch) => ch.codePointAt(0)! > 0x2000), `code ${code} maps to non-emoji "${emoji}"`);
    assert.ok(!emoji.includes('[') && !emoji.includes(']'), `code ${code} maps back to a bracket code`);
    assert.ok(!emoji.includes('://'), `code ${code} maps to a URI (asset references are forbidden)`);
    assert.ok(!code.includes('[') && !code.includes(']'), `key ${code} unexpectedly contains brackets`);
  }
  // Flagship spot-checks — identical values to the desktop table.
  assert.equal(WECHAT_BRACKET_EMOJI_MAP['微笑'], '🙂');
  assert.equal(WECHAT_BRACKET_EMOJI_MAP['强'], '👍');
  assert.equal(WECHAT_BRACKET_EMOJI_MAP['玫瑰'], '🌹');
  assert.equal(WECHAT_BRACKET_EMOJI_MAP['爱心'], '❤️');
  assert.equal(WECHAT_BRACKET_EMOJI_MAP['胜利'], '✌️');
  // The 2026-10-29 desktop 4-code addition (commit 1a26c43a7) is in sync.
  assert.equal(WECHAT_BRACKET_EMOJI_MAP['抠鼻'], '👃');
  assert.equal(WECHAT_BRACKET_EMOJI_MAP['捂脸'], '🤦');
  assert.equal(WECHAT_BRACKET_EMOJI_MAP['奸笑'], '😏');
  assert.equal(WECHAT_BRACKET_EMOJI_MAP['皱眉'], '🙁');
});

test('bracket codes in chat prose render as Unicode emoji; unknown codes pass through', () => {
  assert.equal(mapWechatBracketCodesForDisplay('早上好[微笑]'), '早上好🙂');
  assert.equal(mapWechatBracketCodesForDisplay('[强]这个方案[强]'), '👍这个方案👍');
  assert.equal(mapWechatBracketCodesForDisplay('[不存在的表情]'), '[不存在的表情]');
  assert.equal(mapWechatBracketCodesForDisplay('plain text 123'), 'plain text 123');
  const noBrackets = 'no brackets here';
  assert.equal(mapWechatBracketCodesForDisplay(noBrackets), noBrackets, 'no-bracket strings take the no-op path');
});

test('code spans stay verbatim so messages ABOUT bracket codes keep the literal brackets', () => {
  assert.equal(mapWechatBracketCodesForDisplay('run `[微笑]` to smile'), 'run `[微笑]` to smile');
  assert.equal(
    mapWechatBracketCodesForDisplay('```\nconst code = "[强]";\n```'),
    '```\nconst code = "[强]";\n```',
  );
  assert.equal(
    mapWechatBracketCodesForDisplay('mixed [微笑] `code [玫瑰]` done [玫瑰]'),
    'mixed 🙂 `code [玫瑰]` done 🌹',
  );
});

test('mapping is display-only: the stored form survives a store/chain-style roundtrip untouched', () => {
  const stored = '辛苦了[抱拳]，[玫瑰][爱心]';
  const displayed = mapWechatBracketCodesForDisplay(stored);
  assert.equal(displayed, `辛苦了${WECHAT_BRACKET_EMOJI_MAP['抱拳']}，${WECHAT_BRACKET_EMOJI_MAP['玫瑰']}${WECHAT_BRACKET_EMOJI_MAP['爱心']}`);
  // What the store/chain reload gives back is the ORIGINAL text.
  const reloaded = JSON.parse(JSON.stringify({ content: stored })).content;
  assert.equal(reloaded, stored);
  assert.equal(mapWechatBracketCodesForDisplay(reloaded), displayed, 're-render after reload is stable');
});

// ---------------------------------------------------------------------------
// 3. Caret insertion (pure core)
// ---------------------------------------------------------------------------

test('insertEmojiAtCaret inserts at the caret, replaces selections, and appends at the end', () => {
  // Middle insert.
  assert.deepEqual(insertEmojiAtCaret('ab', '😀', { start: 1, end: 1 }), { text: 'a😀b', caret: 3 });
  // Selection replace (start > end order tolerated).
  assert.deepEqual(insertEmojiAtCaret('abcd', '😀', { start: 3, end: 1 }), { text: 'a😀d', caret: 3 });
  // Null selection appends at the end.
  assert.deepEqual(insertEmojiAtCaret('ab', '😀', null), { text: 'ab😀', caret: 4 });
  // Empty draft.
  assert.deepEqual(insertEmojiAtCaret('', '👍', null), { text: '👍', caret: 2 });
  // Out-of-range selections clamp (defensive against stale pending carets).
  assert.deepEqual(insertEmojiAtCaret('ab', '😀', { start: 99, end: 99 }), { text: 'ab😀', caret: 4 });
  assert.deepEqual(insertEmojiAtCaret('ab', '😀', { start: -5, end: -5 }), { text: '😀ab', caret: 2 });
  // Consecutive picks chain: caret from pick 1 feeds pick 2 (UTF-16 units —
  // '😀' is 2 units, so the caret lands after the pair, never inside it).
  const first = insertEmojiAtCaret('hi', '😀', { start: 2, end: 2 });
  const second = insertEmojiAtCaret(first.text, '👍', { start: first.caret, end: first.caret });
  assert.deepEqual(second, { text: 'hi😀👍', caret: 6 });
  // Empty emoji is a defensive no-op.
  assert.deepEqual(insertEmojiAtCaret('ab', '', { start: 1, end: 2 }), { text: 'ab', caret: 2 });
});

// ---------------------------------------------------------------------------
// 4. EmojiPickerPanel (SSR)
// ---------------------------------------------------------------------------

test('panel renders as one flat dialog: search, NO tabs, recents strip, single Twemoji grid', () => {
  restoreRecentEmojiFromStorage(null); // fresh-install view for this test
  const markup = renderToStaticMarkup(
    <EmojiPickerPanel onSelect={() => undefined} onClose={() => undefined} />,
  );
  assert.match(markup, /role="dialog"/);
  assert.match(markup, /id="mobile-chat-emoji-panel"/);
  assert.match(markup, /type="text"[^>]*placeholder="[^"]+"/);
  // Single WeChat-style page: NO tab bar anywhere.
  assert.doesNotMatch(markup, /role="tablist"/);
  assert.doesNotMatch(markup, /role="tab"/);
  // One flat grid of 85 options, every cell a bundled Twemoji image
  // (alt = codepoint; NO runtime CDN URL).
  const optionCount = (markup.match(/role="option"/g) ?? []).length;
  assert.equal(optionCount, 85, `expected 85 grid options, got ${optionCount}`);
  const imgCount = (markup.match(/<img /g) ?? []).length;
  assert.equal(imgCount, 85, `expected 85 Twemoji <img> cells, got ${imgCount}`);
  assert.match(markup, /<img[^>]*alt="🙂"/, 'grid starts with the WeChat code-table order (微笑 first)');
  assert.match(markup, /src="data:image\/svg\+xml,/);
  assert.doesNotMatch(markup, /src="https?:\/\//, 'assets must be embedded, never fetched from a CDN');
  // Fresh install: no recents -> no recents strip.
  assert.ok(!markup.includes(t('mobile.chat.emojiCategoryRecent')), 'recents strip hidden while recents are empty');
  // Touch targets: every grid cell is a 44px-tall button (min-h convention).
  assert.match(markup, /h-\[44px\]/);
});

test('recents render as a strip ABOVE the main grid after picks (no Recent tab)', () => {
  // No window in the SSR test env => module-init hydration is a no-op and
  // the module state starts empty (same as a first-ever app launch).
  restoreRecentEmojiFromStorage(null);
  assert.equal(recentEmojiChars().length, 0, 'fresh module state starts empty');
  const before = renderToStaticMarkup(
    <EmojiPickerPanel onSelect={() => undefined} onClose={() => undefined} />,
  );
  assert.ok(!before.includes(t('mobile.chat.emojiCategoryRecent')), 'no recents strip before any pick');

  rememberRecentEmoji('🥰');
  rememberRecentEmoji('😀');
  const after = renderToStaticMarkup(
    <EmojiPickerPanel onSelect={() => undefined} onClose={() => undefined} />,
  );
  assert.ok(after.includes(t('mobile.chat.emojiCategoryRecent')), 'recents strip appears after picks');
  assert.doesNotMatch(after, /role="tab"/, 'recents must be a strip, not a tab');
  assert.deepEqual([...recentEmojiChars()], ['😀', '🥰'], 'most-recent-first, deduped');
  // 2 recents + 85 catalog entries; the strip must sit ABOVE the main grid
  // (its label precedes the first catalog emoji 🙂 in the markup).
  const optionCount = (after.match(/role="option"/g) ?? []).length;
  assert.equal(optionCount, 87, `expected 2 recents + 85 catalog options, got ${optionCount}`);
  const stripLabelIndex = after.indexOf(t('mobile.chat.emojiCategoryRecent'));
  const firstGridEmojiIndex = after.indexOf('alt="🙂"');
  assert.ok(stripLabelIndex >= 0 && stripLabelIndex < firstGridEmojiIndex, 'recents strip sits above the main grid');
  // Recents render as Twemoji images too (alt = codepoint), most-recent first.
  assert.match(after, /<img[^>]*alt="😀"/, 'most-recent emoji leads the strip as an image');
  assert.match(after, /<img[^>]*alt="🥰"/);
  assert.ok(after.indexOf('alt="😀"') < firstGridEmojiIndex, 'most-recent emoji leads the strip');
  restoreRecentEmojiFromStorage(null);
});

// ---------------------------------------------------------------------------
// 4a. Recents persistence (window.localStorage, local-only)
// ---------------------------------------------------------------------------

const EMOJI_RECENTS_STORAGE_KEY = 'idbots.mobile.chat.emojiRecents.v1';

const makeStorageStub = (): { storage: Storage; map: Map<string, string> } => {
  const map = new Map<string, string>();
  const storage = {
    getItem: (key: string) => (map.has(key) ? map.get(key)! : null),
    setItem: (key: string, value: string) => { map.set(key, String(value)); },
  } as Storage;
  return { storage, map };
};

const installWindow = (storage: Storage): void => {
  (globalThis as Record<string, unknown>).window = { localStorage: storage };
};

const removeWindow = (): void => {
  delete (globalThis as Record<string, unknown>).window;
};

test('parsePersistedRecentEmoji: malformed shapes fall back empty; cap 16; dedupe keeps first (= most recent)', () => {
  assert.deepEqual(parsePersistedRecentEmoji(null), []);
  assert.deepEqual(parsePersistedRecentEmoji(''), []);
  assert.deepEqual(parsePersistedRecentEmoji('not json'), []);
  assert.deepEqual(parsePersistedRecentEmoji('{"a":1}'), []);
  assert.deepEqual(parsePersistedRecentEmoji(JSON.stringify([1, null, {}, '😀', ''])), ['😀']);
  assert.deepEqual(parsePersistedRecentEmoji(JSON.stringify(['😀', '😀', '🙂'])), ['😀', '🙂']);
  const twenty = Array.from({ length: 20 }, (_, i) => `e${i}`);
  assert.deepEqual(parsePersistedRecentEmoji(JSON.stringify(twenty)), twenty.slice(0, 16));
});

test('rememberRecentEmoji persists MRU-first through the real window.localStorage path (dedupe, cap 16)', () => {
  const { storage, map } = makeStorageStub();
  installWindow(storage);
  try {
    restoreRecentEmojiFromStorage(null); // reset module state (fresh app)
    rememberRecentEmoji('🥰');
    rememberRecentEmoji('😀');
    assert.deepEqual([...recentEmojiChars()], ['😀', '🥰'], 'most-recent-first after two picks');
    rememberRecentEmoji('🥰'); // re-pick moves to front, no duplicate
    assert.deepEqual([...recentEmojiChars()], ['🥰', '😀']);
    // Cap: 20 more distinct picks on top of ['🥰','😀'] keep the 16 most
    // recent (e19..e4); 🥰/😀/e3..e0 are the evicted ones.
    for (let i = 0; i < 20; i += 1) rememberRecentEmoji(`e${i}`);
    assert.equal(recentEmojiChars().length, 16, 'cap stays 16');
    assert.equal(recentEmojiChars()[15], 'e4', 'oldest beyond the cap evicted');
    assert.equal(map.get(EMOJI_RECENTS_STORAGE_KEY), JSON.stringify([...recentEmojiChars()]));
  } finally {
    removeWindow();
  }
});

test('storage failures degrade to session-memory behavior (no throw, no write)', () => {
  const throwing: Storage = {
    getItem: () => { throw new Error('quota'); },
    setItem: () => { throw new Error('quota'); },
  } as unknown as Storage;
  installWindow(throwing);
  try {
    restoreRecentEmojiFromStorage(throwing); // read path: swallowed, empty
    assert.deepEqual([...recentEmojiChars()], []);
    assert.doesNotThrow(() => rememberRecentEmoji('😀'));
    assert.deepEqual([...recentEmojiChars()], ['😀'], 'pick still lands in memory');
  } finally {
    removeWindow();
  }
});

test('app restart (fresh module evaluation) restores persisted recents and renders the recents strip', async () => {
  const { storage } = makeStorageStub();
  storage.setItem(EMOJI_RECENTS_STORAGE_KEY, JSON.stringify(['🚀', '🙂', '👍']));
  installWindow(storage);
  try {
    // Fresh module instance = relaunched app: module init hydrates from
    // the same localStorage before the first render.
    const fresh = await import(`../src/mobile/app/components/EmojiPickerPanel.tsx?restart=${Date.now()}`);
    assert.deepEqual(
      [...fresh.recentEmojiChars()],
      ['🚀', '🙂', '👍'],
      'boot hydration restores the persisted LRU order',
    );
    const markup = renderToStaticMarkup(
      <fresh.EmojiPickerPanel onSelect={() => undefined} onClose={() => undefined} />,
    );
    // WeChat-style single panel: no tab bar; the persisted recents render
    // as a strip ABOVE the main grid, most-recent first.
    assert.doesNotMatch(markup, /role="tab"/, 'single panel must not carry a tab bar');
    assert.ok(markup.includes(t('mobile.chat.emojiCategoryRecent')), 'recents strip label present right after restart');
    const stripLabelIndex = markup.indexOf(t('mobile.chat.emojiCategoryRecent'));
    const firstGridEmojiIndex = markup.indexOf('🙂');
    assert.ok(stripLabelIndex >= 0 && stripLabelIndex < firstGridEmojiIndex, 'strip renders above the main grid');
    assert.ok(markup.indexOf('🚀') < firstGridEmojiIndex, 'strip leads with the most-recent emoji');
    // 3 restored recents + 85 catalog entries.
    const optionCount = (markup.match(/role="option"/g) ?? []).length;
    assert.equal(optionCount, 88, `expected 3 recents + 85 catalog options, got ${optionCount}`);
  } finally {
    removeWindow();
  }
  // Leave module state clean for the ChatScreen SSR tests below.
  restoreRecentEmojiFromStorage(null);
});

// ---------------------------------------------------------------------------
// 5. ChatScreen wiring (SSR markup + source contract)
// ---------------------------------------------------------------------------

type ChatMessageViewShape = {
  id: string;
  role: 'user' | 'assistant' | 'error' | 'system';
  text: string;
  streaming: boolean;
  diagnostic: null;
  message: Record<string, unknown>;
};

const view = (role: ChatMessageViewShape['role'], text: string): ChatMessageViewShape => ({
  id: `${role}-${Math.random().toString(36).slice(2)}`,
  role,
  text,
  streaming: false,
  diagnostic: null,
  message: { id: 'm', content: text, metadata: {} },
});

function chatFixture(overrides: Record<string, unknown> = {}): Chat {
  return {
    messages: [],
    sessions: [],
    sessionId: null,
    sessionTitle: null,
    metabotId: null,
    isStreaming: false,
    isSending: false,
    isUploading: false,
    restoring: false,
    pendingPermissionCount: 0,
    turnPhase: 'idle',
    permission: null,
    toolCalls: [],
    attempts: [],
    actionError: null,
    quotaExhausted: false,
    quotaKind: null,
    hasMoreHistory: false,
    draft: '',
    attachments: [],
    uploads: [],
    setMetabotId: () => undefined,
    setDraft: () => undefined,
    reloadSessions: async () => undefined,
    openSession: async () => undefined,
    newChat: () => undefined,
    send: async () => undefined,
    stop: async () => undefined,
    pickAttachments: () => undefined,
    removeAttachment: () => undefined,
    removeUpload: () => undefined,
    loadEarlierMessages: async () => undefined,
    respondPermission: async () => undefined,
    dismissPermission: () => undefined,
    reopenPermissions: () => undefined,
    dismissQuota: () => undefined,
    reconcileSubmission: async () => undefined,
    retrySubmission: async () => undefined,
    discardSubmission: () => undefined,
    applyResync: () => undefined,
    getOpenSessionId: () => null,
    getStreamingMessage: () => null,
    ...overrides,
  } as unknown as Chat;
}

test('composer keeps the text area wide between one plus button and voice, with emoji and attachments in the plus sheet', () => {
  mobileI18n.setLanguage('zh');
  const markup = renderToStaticMarkup(
    <ChatScreen chat={chatFixture()} bots={[]} onOpenRecharge={() => undefined} />,
  );
  const composerLabel = t('mobile.chat.composerActions');
  const plusButton = markup.match(new RegExp(`<button[^>]*aria-label="${composerLabel}"[^>]*>`))?.[0] ?? '';
  assert.ok(plusButton, 'composer plus button rendered');
  assert.match(plusButton, /aria-expanded="false"/);
  assert.match(plusButton, /aria-haspopup="dialog"/);
  assert.ok(!markup.includes('data-testid="emoji-panel"'));
  assert.ok(!markup.includes('data-testid="composer-action-sheet"'));
  const plusIdx = markup.indexOf('data-testid="composer-plus"');
  const inputIdx = markup.indexOf('data-testid="chat-composer-input"');
  const sendIdx = markup.indexOf('data-testid="composer-send"');
  const voiceIdx = markup.indexOf('data-testid="voice-btn-idle"');
  assert.ok(plusIdx >= 0 && plusIdx < inputIdx && inputIdx < sendIdx && sendIdx < voiceIdx, 'plus → wide input → send → voice layout');
  assert.match(markup, /data-testid="composer-send"/);
  const source = readSource('../src/mobile/app/screens/ChatScreen.tsx');
  assert.match(source, /data-testid="composer-action-emoji"/);
  assert.match(source, /data-testid="composer-action-attachment"/);
  assert.match(source, /event\.nativeEvent\.isComposing/);
  assert.match(source, /enterKeyHint="send"/);
});

test('user bubble renders WeChat bracket codes as Twemoji images (display-only), unknown codes verbatim', () => {
  const markup = renderToStaticMarkup(
    <ChatScreen
      chat={chatFixture({
        messages: [
          view('user', '早上好[微笑][强]'),
          view('user', '[不存在的表情]'),
        ] as never,
      })}
      bots={[]}
      onOpenRecharge={() => undefined}
    />,
  );
  // Mixed text + inline images: prose stays, mapped codes become <img>
  // with alt = codepoint (no font glyph, no contiguous emoji string).
  assert.ok(markup.includes('早上好'), 'prose text survives the mixed rendering');
  assert.match(markup, /<img[^>]*alt="🙂"/, 'mapped [微笑] renders as a Twemoji image');
  assert.match(markup, /<img[^>]*alt="👍"/, 'mapped [强] renders as a Twemoji image');
  assert.ok(
    markup.indexOf('alt="🙂"') < markup.indexOf('alt="👍"'),
    'image order follows the mapped text order',
  );
  assert.ok(markup.includes('[不存在的表情]'), 'unknown codes stay literal');
  assert.ok(!markup.includes('[微笑]'), 'the stored bracket form never leaks into the user bubble markup');
});

test('assistant bubble maps bracket codes ahead of markdown rendering, code spans verbatim', () => {
  mobileI18n.setLanguage('zh'); // earlier tests may have switched language
  const markup = renderToStaticMarkup(
    <ChatScreen
      chat={chatFixture({
        messages: [
          view('assistant', '辛苦了[抱拳]，见 `code [玫瑰]` 和\n\n```\n[强]\n```\n\n[玫瑰]'),
        ] as never,
      })}
      bots={[]}
      onOpenRecharge={() => undefined}
    />,
  );
  // Prose codes render as inline Twemoji images (alt carries the codepoint).
  assert.match(markup, new RegExp(`<img[^>]*alt="${WECHAT_BRACKET_EMOJI_MAP['抱拳']}"`), 'prose code mapped via markdown preprocessing');
  assert.match(markup, new RegExp(`<img[^>]*alt="${WECHAT_BRACKET_EMOJI_MAP['玫瑰']}"`), 'prose code outside code spans mapped');
  // Code spans keep the LITERAL bracket codes (text nodes in code nodes are
  // structurally immune to the Twemoji remark swap).
  assert.ok(markup.includes('[玫瑰]'), 'inline code span keeps the literal bracket code');
  assert.ok(markup.includes('[强]'), 'fenced code block keeps the literal bracket code');
});

test('assistant bubble img src survives safeUrlTransform: exact-set Twemoji literals stay alive, off-manifest data: URIs stay blocked', () => {
  // Regression for the SAFE_URL_PROTOCOLS wash: safeUrlTransform (the
  // urlTransform of ReactMarkdown) rewrote every scheme outside its whitelist
  // to ''. The embedded-Twemoji pipeline (chat/twemoji.ts data URIs) emits
  // `data:image/svg+xml,...` srcs, so the assistant bubble's markdown <img>
  // rendered as `<img src="">` + alt fallback ("dev fine, packaged broken"
  // under the old new-URL pipeline; shape-independent since the decoupling).
  // alt SURVIVES the wash, so an alt-only assertion stays green on a broken
  // render — this test pins the src alive at SSR level.
  mobileI18n.setLanguage('zh');
  const markup = renderToStaticMarkup(
    <ChatScreen
      chat={chatFixture({
        messages: [
          view('assistant', '收到[玫瑰] 👊 看图'),
          // Security-boundary companions: ONLY the 85 exact bundled-artwork
          // literals pass safeUrlTransform (isTwemojiAssetUrl membership) —
          // never `data:` wholesale, and not even a `data:image/` prefix.
          view('assistant', '![pwn](data:text/html;base64,PHNjcmlwdD4=)'),
          view(
            'assistant',
            '![x](data:image/svg+xml,%3Csvg%3E%3Cscript%3E%3C%2Fscript%3E%3C%2Fsvg%3E)',
          ),
        ] as never,
      })}
      bots={[]}
      onOpenRecharge={() => undefined}
    />,
  );
  const twemojiImgs = markup.match(/<img[^>]*alt="(🌹|👊)"[^>]*>/g) ?? [];
  assert.equal(
    twemojiImgs.length,
    2,
    `expected both catalog emoji as <img> in the assistant bubble, got ${twemojiImgs.length}`,
  );
  for (const tag of twemojiImgs) {
    assert.match(
      tag,
      /src="data:image\/svg\+xml,/,
      `twemoji img src must survive safeUrlTransform (live data:image/svg+xml src), got: ${tag}`,
    );
    assert.doesNotMatch(tag, /src=""/, `washed empty src is the bug shape, got: ${tag}`);
  }
  // data:text/html stays washed: only the exact bundled-artwork manifest
  // passes, never `data:` wholesale (companion assertion kept byte-identical
  // from the data:image/ prefix era).
  assert.doesNotMatch(markup, /src="data:text\/html/, 'non-image data: URIs must stay blocked (no wholesale data: allow)');
  assert.match(markup, /src=""/, 'the data:text/html image must render with the washed empty src');
  // Off-manifest data:image/svg+xml must ALSO stay washed: the allow is
  // exact-set membership over the 85 embedded literals (isTwemojiAssetUrl),
  // NOT a data:image/ prefix — a foreign scriptable svg data URI is exactly
  // the smuggling shape a prefix allow would have passed through.
  assert.doesNotMatch(
    markup,
    /src="data:image\/svg\+xml,[^"]*%3Cscript%3E/,
    'off-manifest data:image/svg+xml must stay washed (exact-set allow, not a prefix allow)',
  );
  const liveSvgSrcs = markup.match(/src="data:image\/svg\+xml,/g) ?? [];
  assert.equal(
    liveSvgSrcs.length,
    2,
    `exactly the two catalog Twemoji <img> keep a live svg data src, got ${liveSvgSrcs.length} — an off-manifest svg URI must add none`,
  );
});

test('error and system bubbles render catalog emoji as Twemoji (display-only), non-catalog glyphs verbatim', () => {
  const markup = renderToStaticMarkup(
    <ChatScreen
      chat={chatFixture({
        messages: [
          view('error', '失败了 💀 请重试'),
          view('system', '[微笑] 会话已压缩'),
          view('system', '🫠 non-catalog emoji stay native'),
        ] as never,
      })}
      bots={[]}
      onOpenRecharge={() => undefined}
    />,
  );
  assert.ok(markup.includes('data-testid="error-bubble"'), 'error bubble rendered');
  assert.ok(markup.includes('data-testid="system-notice"'), 'system notice rendered');
  assert.match(markup, /<img[^>]*alt="💀"/, 'catalog emoji inside the error bubble renders as Twemoji');
  assert.match(markup, new RegExp(`<img[^>]*alt="${WECHAT_BRACKET_EMOJI_MAP['微笑']}"`), 'bracket codes inside the system notice map and render as Twemoji');
  assert.ok(markup.includes('🫠'), 'non-catalog emoji falls back to the raw platform glyph');
});

test('ChatScreen source contract: caret insertion wiring, panel flow, display-only boundary', () => {
  const source = readSource('../src/mobile/app/screens/ChatScreen.tsx');
  // Insertion goes through the pure caret helper with a pending-caret
  // fallback for the keyboard-hidden flow.
  assert.match(source, /insertEmojiAtCaret\(draft, emoji, currentEmojiSelection\(\)\)/);
  assert.match(source, /pendingCaretRef\.current = insertion\.caret/);
  // Picking never refocuses the textarea (software keyboard stays hidden).
  assert.match(source, /No refocus \(WeChat-style flow\)\./);
  // Tapping back into the textarea closes the panel (back to text input).
  assert.match(source, /onFocus=\{\(\) => \{\s*setEmojiPanelOpen\(false\);/);
  // The plus action sheet opens the panel without crowding the composer.
  assert.match(source, /setEmojiPanelOpen\(true\)/);
  // All four bubble kinds map at DISPLAY time only — and only the display
  // layer swaps in Twemoji artwork (user/error/system bubbles via
  // TwemojiText, assistant via MarkdownContent's opt-in emojiImages prop).
  assert.match(source, /mapWechatBracketCodesForDisplay\(message\.text\)/);
  assert.match(source, /<TwemojiText text=\{mapWechatBracketCodesForDisplay\(message\.text\)\} \/>/);
  assert.match(source, /onOpenLocalFile=\{onOpenFile\} onOpenBotBrowserUri=\{onOpenUri\} emojiImages \/>/);
  // Error + system bubbles route through the same display pipeline.
  const twemojiTextFaces = source.match(/<TwemojiText text=\{mapWechatBracketCodesForDisplay\(messageText\(message\)\)\} \/>/g) ?? [];
  assert.equal(twemojiTextFaces.length, 2, 'error + system bubbles both route through TwemojiText');
  // The projection layer must NOT map (stored text untouched) — the mapping
  // imports live only in the screen module, not the projection.
  const projection = readSource('../src/mobile/app/chatProjection.ts');
  assert.ok(!projection.includes('wechatEmojiDisplay'), 'chatProjection must stay mapping-free');
});
