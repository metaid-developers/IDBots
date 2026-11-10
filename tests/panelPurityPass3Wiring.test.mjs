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
//
// SUPERSEDED IN PLACE (pass #5, delegation 7459ba51 / step b64861e1,
// 2026-11-10, merged three-item card): the stamp is now the TWIN side's
// group-end line and reads by DEFAULT — the pass #3 hover reveal
// (visibility toggles, reserved invisible slot, `group` hover proxy) is
// retired per the owner's new口径, and the pending card gets the real
// speaker name from the panel. The two ① tests below pin the pass #5
// contract; the pass #5 surface itself lives in panelPurityPass5Wiring.test.mjs.

const repoRoot = path.resolve(import.meta.dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

const panelSource = read('src/renderer/features/botBrowser/BotBrowserCoworkPanel.tsx');
const timestampSource = read('src/renderer/features/botBrowser/panelMessageTimestamp.ts');
const tilesSource = read('src/renderer/components/cowork/CoworkQuotedSelectionTiles.tsx');
const inputSource = read('src/renderer/components/cowork/CoworkPromptInput.tsx');
const i18nSource = read('src/renderer/services/i18n.ts');

test('① group-end predicate: sender adjacency, no time gap, exported and twin-side-only', () => {
  // The predicate itself: adjacency by message type flip.
  assert.match(timestampSource, /export const isPanelMessageGroupEnd/);
  assert.match(timestampSource, /return !next \|\| next\.type !== current\.type;/);
  // The panel feeds it the RENDERED sequence with the map index, scoped to
  // the twin side (pass #5 ③): a user row never carries the stamp.
  assert.match(panelSource, /showTimestamp=\{message\.type === 'assistant' && isPanelMessageGroupEnd\(visibleMessages, index\)\}/);
  assert.match(panelSource, /const renderMessage = \(message: CoworkMessage, index: number\) =>/);
});

test('① the stamp is default-visible on assistant group-end rows (hover reveal retired)', () => {
  // Pass #5 ③④: no hover gating — the meta row mounts only when it has
  // content and reads by default. The pass #3 machinery (reserved invisible
  // slot, visibility toggles, `group` hover proxy) is gone for good.
  assert.doesNotMatch(panelSource, /group-hover:/);
  assert.doesNotMatch(panelSource, /stampOnlyRow/);
  assert.doesNotMatch(panelSource, /className="group /);
  // Defense-in-depth in the row: a user bubble never carries a stamp,
  // whatever a caller passes.
  assert.match(panelSource, /const showStamp = showTimestamp && !isUser;/);
  // The row mounts only when it has content (stamp or chip)…
  assert.match(panelSource, /showStamp \|\| hasReactionChip \? \(/);
  // …aligns with the bubble side (user right, assistant left)…
  assert.match(panelSource, /isUser \? 'justify-end' : 'justify-start'/);
  // …and the row reads [👍chip][time] — chip first, stamp second.
  const metaRowBlock = panelSource.match(/data-slot="panel-message-meta"[\s\S]*?\) : null;/)?.[0] ?? '';
  assert.ok(metaRowBlock, 'meta row block found');
  const chipIndex = metaRowBlock.indexOf('data-panel-reaction-chip');
  const stampIndex = metaRowBlock.indexOf('data-panel-message-timestamp');
  assert.ok(chipIndex !== -1, 'reaction chip wired in the row');
  assert.ok(stampIndex !== -1, 'stamp wired in the row');
  assert.ok(chipIndex < stampIndex, 'assistant rows read [chip][time]');
  // The stamp renders only when formatting produced one.
  assert.match(panelSource, /\{showStamp && timestampLabel \? \(/);
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
