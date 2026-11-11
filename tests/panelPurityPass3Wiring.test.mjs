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
//
// SUPERSEDED AGAIN (chat-window four-item fix ②, delegation 3e22c1c3 /
// step 07807b1a, owner ruling 2026-11-11): the stamp moved INSIDE the
// bubble, unified across user and assistant rows; the meta row now carries
// the 👍chip alone and mounts only while that chip exists. The second ①
// test was rewritten in place to the new shape; the first ① keeps pinning
// the parent feed, now documented as the retired showTimestamp gate.

const repoRoot = path.resolve(import.meta.dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

const panelSource = read('src/renderer/features/botBrowser/BotBrowserCoworkPanel.tsx');
const timestampSource = read('src/renderer/features/botBrowser/panelMessageTimestamp.ts');
const tilesSource = read('src/renderer/components/cowork/CoworkQuotedSelectionTiles.tsx');
const inputSource = read('src/renderer/components/cowork/CoworkPromptInput.tsx');
const i18nSource = read('src/renderer/services/i18n.ts');

test('① group-end predicate: sender adjacency, no time gap, exported and parent-fed', () => {
  // The predicate itself: adjacency by message type flip.
  assert.match(timestampSource, /export const isPanelMessageGroupEnd/);
  assert.match(timestampSource, /return !next \|\| next\.type !== current\.type;/);
  // The panel feeds it the RENDERED sequence with the map index. Gate
  // history (superseded twice, kept current): pass #3 made it a hover gate,
  // fix ② (11:19) retired it while unifying the stamp on both sides, and
  // the 14:07 rework promoted the same expression back to the deciding
  // gate — it now drives timestampLabel itself (plus rides showTimestamp
  // verbatim for contract stability). (Supersedes the "retired-only gate"
  // comment this assertion carried.)
  assert.match(panelSource, /showTimestamp=\{message\.type === 'assistant' && isPanelMessageGroupEnd\(visibleMessages, index\)\}/);
  assert.match(panelSource, /const renderMessage = \(message: CoworkMessage, index: number\) =>/);
});

test('① stamp + chip share the in-bubble footer (chip left, stamp right); hover reveal stays retired', () => {
  // Fix ② (owner ruling 2026-11-11) superseded the external meta-line
  // stamp of pass #5 ③④: the stamp moved INSIDE the bubble. The sixth
  // item (owner ruling 2026-11-11 14:45) supersedes that again: the
  // reaction chip moved inside too — one in-bubble footer row per bubble,
  // chip LEFT of the stamp, flush with the bubble's bottom-right corner;
  // the old external chip row is gone for good. The pass #3 machinery
  // (reserved invisible slot, visibility toggles, hover proxy) stays gone
  // for good.
  assert.doesNotMatch(panelSource, /group-hover:/);
  assert.doesNotMatch(panelSource, /stampOnlyRow/);
  assert.doesNotMatch(panelSource, /className="group /);
  // The stamp gate is formatting-only: an empty label renders no stamp.
  assert.match(panelSource, /const bubbleStamp = timestampLabel \? \(/);
  assert.match(panelSource, /data-panel-message-timestamp="true"/);
  // SUPERSEDED (sixth item, owner ruling 2026-11-11 14:45): the three
  // bubble branches close with the in-bubble FOOTER (chip left, stamp
  // right); the footer composes {bubbleStamp} exactly once.
  const footerInserts = panelSource.match(/\{bubbleFooter\}/g) ?? [];
  assert.equal(footerInserts.length, 3, 'all three bubble branches close with the in-bubble footer');
  assert.equal((panelSource.match(/\{bubbleStamp\}/g) ?? []).length, 1, 'the footer is the only stamp mount point');
  // SUPERSEDED (sixth item): the external chip row is gone; the chip rides
  // the in-bubble footer beside the stamp — the alignment no longer
  // mirrors the bubble side.
  assert.doesNotMatch(panelSource, /panel-message-meta/);
  assert.match(panelSource, /const bubbleFooter = hasReactionChip \|\| bubbleStamp \? \(/);
  const footerBlock = panelSource.match(/data-slot="panel-bubble-footer"[\s\S]*?\) : null;/)?.[0] ?? '';
  assert.ok(footerBlock, 'bubble footer block found');
  assert.ok(footerBlock.includes('data-panel-reaction-chip'), 'reaction chip wired in the footer');
  assert.ok(footerBlock.includes('{bubbleStamp}'), 'the stamp rides the same footer row');
  assert.ok(
    footerBlock.indexOf('data-panel-reaction-chip') < footerBlock.indexOf('{bubbleStamp}'),
    'chip LEFT of the stamp on the footer row',
  );
  assert.match(footerBlock, /justify-end/, 'the pair hugs the bubble bottom-right corner');
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
