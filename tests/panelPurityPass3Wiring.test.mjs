import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Static wiring guard for the office-chat purity pass #3 (delegation
// 297fd2f2 / step b25fc5fd, 2026-11-10, owner-confirmed merged revision):
// ① timestamps collapse to the group's last bubble and reveal on hover with
// reserved-space hover reveal; ② the pending quote renders as a Telegram-style
// two-line reply card in the sent-quote's accent-bar family; ③ the cancel
// control no longer inherits the session's running state. Behavior lives in
// panelMessageTimestamp.test.ts (group-end predicate); this file pins the
// wiring so a refactor cannot quietly re-grow per-bubble stamps, drop the
// card's family cues, or re-deadlock the cancel button mid-stream.

const repoRoot = path.resolve(import.meta.dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

const panelSource = read('src/renderer/features/botBrowser/BotBrowserCoworkPanel.tsx');
const timestampSource = read('src/renderer/features/botBrowser/panelMessageTimestamp.ts');
const tilesSource = read('src/renderer/components/cowork/CoworkQuotedSelectionTiles.tsx');
const inputSource = read('src/renderer/components/cowork/CoworkPromptInput.tsx');
const i18nSource = read('src/renderer/services/i18n.ts');

test('① group-end predicate: sender adjacency, no time gap, exported and wired', () => {
  // The predicate itself: adjacency by message type flip.
  assert.match(timestampSource, /export const isPanelMessageGroupEnd/);
  assert.match(timestampSource, /return !next \|\| next\.type !== current\.type;/);
  // The panel feeds it the RENDERED sequence with the map index.
  assert.match(panelSource, /showTimestamp=\{isPanelMessageGroupEnd\(visibleMessages, index\)\}/);
  assert.match(panelSource, /const renderMessage = \(message: CoworkMessage, index: number\) =>/);
});

test('① the stamp is hover-revealed with reserved space (no hover jitter)', () => {
  // Owner refinement 2026-11-10: mount-on-hover made the bubble grow under
  // the pointer and jitter the transcript. The row now ALWAYS mounts with
  // its height reserved; the reveal toggles visibility only, never display.
  assert.match(panelSource, /stampOnlyRow \? 'invisible group-hover:visible' : 'flex'/);
  // A chip-carrying row stays mounted, and its stamp still waits for hover.
  assert.match(panelSource, /'invisible group-hover:inline'/);
  // The reveal is driven by a group-scoped hover proxy on the row wrapper.
  const groupWrappers = panelSource.match(/data-panel-message-id=\{message\.id\} className="group /g) ?? [];
  assert.equal(groupWrappers.length, 3, 'all three bubble branches carry the group hover proxy');
  // Non-group-end rows render no stamp at all, even when a label exists.
  assert.match(panelSource, /\{timestampLabel \? \(\n\s*showTimestamp \? \(/);
});

test('② the pending quote is a Telegram-style card in the sent-quote family', () => {
  // Same family cue as the sent quote's bar: the accent vertical rule.
  const cardBlock = tilesSource.match(/selections\.length === 1[\s\S]*?return \(\s*<div[\s\S]*?\/>/)?.[0] ?? '';
  assert.ok(cardBlock, 'single-target branch found');
  assert.match(cardBlock, /border-l-2 border-l-claude-accent/);
  // Two-line card: accent header line + secondary preview line.
  assert.match(tilesSource, /truncate font-medium text-claude-accent/);
  assert.match(tilesSource, /mt-0\.5 truncate dark:text-claude-darkTextSecondary text-claude-textSecondary/);
  // The header reads as a sentence via i18n ("回复 {speaker}").
  assert.match(tilesSource, /i18nService\.t\('coworkQuoteReplyCardReplyingTo'\)/);
  assert.match(tilesSource, /\.replace\('\{speaker\}', speakerNameFor\(selection, botName\)\)/);
  for (const key of ['coworkQuoteReplyCardReplyingTo', 'coworkQuoteReplyCardSpeakerUser']) {
    const hits = i18nSource.match(new RegExp(`^\\s*${key}:`, 'gm')) ?? [];
    assert.equal(hits.length, 2, `${key} must exist once in zh and once in en`);
  }
  assert.match(i18nSource, /coworkQuoteReplyCardReplyingTo: '回复 \{speaker\}'/);
  assert.match(i18nSource, /coworkQuoteReplyCardReplyingTo: 'Replying to \{speaker\}'/);
  assert.match(i18nSource, /coworkQuoteReplyCardSpeakerUser: '你'/);
  assert.match(i18nSource, /coworkQuoteReplyCardSpeakerUser: 'you'/);
  // aria/tooltip contract survives the redesign: preview label on the card,
  // cancel label on the ✕ button (aria-label + title).
  assert.match(tilesSource, /aria-label=\{i18nService\.t\('coworkQuoteReplyPreviewLabel'\)\}/);
  assert.match(tilesSource, /aria-label=\{cancelLabel\}/);
  assert.match(tilesSource, /title=\{cancelLabel\}/);
  // The ✕ is an icon button (XMark), not a text link.
  assert.match(tilesSource, /<XMarkIcon className="h-3\.5 w-3\.5" \/>/);
});

test('③ the cancel control never inherits the session running state', () => {
  // No disabled hand-off anywhere in the slot: cancel/removal is
  // composer-local state mutation and stays clickable while streaming.
  assert.doesNotMatch(tilesSource, /disabled=\{disabled\}/);
  assert.doesNotMatch(tilesSource, /disabled:cursor-not-allowed/);
  assert.doesNotMatch(tilesSource, /disabled:opacity-50/);
  // The composer no longer chains isStreaming into the slot. Scoped to the
  // tiles call: the composer's own controls (+ menu, textarea) legitimately
  // keep their running-state disabled semantics.
  const tilesCall = inputSource.match(/<CoworkQuotedSelectionTiles[\s\S]*?\/>/)?.[0] ?? '';
  assert.ok(tilesCall, 'tiles call site found');
  assert.doesNotMatch(tilesCall, /disabled=/);
  // Both remove controls stay wired to the local removal path.
  assert.match(tilesSource, /onClick=\{\(\) => onRemove\(selection\.id\)\}/);
  const removeWiring = tilesSource.match(/onClick=\{\(\) => onRemove\(selection\.id\)\}/g) ?? [];
  assert.equal(removeWiring.length, 2, 'card ✕ and tile ✕ both call the local removal path');
});
