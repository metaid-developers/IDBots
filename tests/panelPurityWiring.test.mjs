import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Static wiring guard for the office-chat purity pass #1 (delegation
// a3c97668 / step 9febcfab, 2026-11-10): bubble timestamps, the right-click
// context menu, the localStorage reactions MVP and the shared quote-reply
// path. Behavior lives in panelMessageTimestamp.test.ts,
// panelMessageReactions.test.ts and panelContextMenuGeometry.test.ts; this
// file only pins the panel wiring so a refactor cannot quietly drop a
// channel, a close path, or re-grow persistent furniture.
//
// EXTENDED (pass #4, delegation b05ee0c6 / step 8ee05ab0, 2026-11-10): the
// menu is selection-aware — test ④ was superseded in place (its two
// whole-message-only assertions now pin the selection-first precedence), and
// test ⑥ pins the new capture + label-switch wiring. Behavior lives in
// panelBubbleSelection.test.ts.
//
// REWRITTEN (pass #5, delegation 7459ba51 / step b64861e1, 2026-11-10): the
// stamp's render guard in test ① was superseded in place — the stamp now
// mounts only on the twin side's group-end rows and reads by default (the
// pass #3 hover reveal is retired); the formula pin lives in the pass #3
// and pass #5 guard files.
//
// SUPERSEDED AGAIN (chat-window four-item fix ②, delegation 3e22c1c3 /
// step 07807b1a, owner ruling 2026-11-11): the stamp moved INSIDE the
// bubble's bottom-right corner, unified across user and assistant rows;
// the external meta line is gone and the meta row now carries the reaction
// chip alone, mounting only while that chip exists. Test ① was rewritten
// in place — same intent (the stamp must render, the chip must survive,
// no persistent furniture), extended to the new shape.

const repoRoot = path.resolve(import.meta.dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

const panelSource = read('src/renderer/features/botBrowser/BotBrowserCoworkPanel.tsx');
const menuComponentSource = read('src/renderer/features/botBrowser/PanelMessageContextMenu.tsx');
const reactionsSource = read('src/renderer/features/botBrowser/panelMessageReactions.ts');
const timestampSource = read('src/renderer/features/botBrowser/panelMessageTimestamp.ts');
const geometrySource = read('src/renderer/features/botBrowser/panelContextMenuGeometry.ts');
const bubbleSelectionSource = read('src/renderer/features/botBrowser/panelBubbleSelection.ts');
const quotedSelectionsSource = read('src/renderer/components/cowork/coworkQuotedSelections.ts');
const i18nSource = read('src/renderer/services/i18n.ts');

test('① stamp + chip share the in-bubble footer (chip left, stamp right); parent gate decides who carries the stamp (sixth item supersession)', () => {
  // Parent formula (owner ruling 2026-11-11 14:07, narrowing fix ②'s
  // unify-all-bubbles scope): the timestampLabel prop is handed down
  // PRE-GATED by the assistant&&group-end expression — user bubbles and
  // non-final rows inside a group never receive a label, and an absent
  // label renders no stamp. The HH:mm/MM-DD formatting call survives
  // unchanged inside the gate. (Supersedes the 11:19 "label on every
  // bubble" formula this assertion pinned.)
  assert.match(
    panelSource,
    /timestampLabel=\{\s*\n\s*message\.type === 'assistant' && isPanelMessageGroupEnd\(visibleMessages, index\)\s*\n\s*\? formatPanelMessageTimestamp\(message\.timestamp, Date\.now\(\)\)\s*\n\s*: undefined\s*\n\s*\}/,
    'the label is pre-gated by the assistant&&group-end expression at the parent',
  );
  assert.match(panelSource, /showTimestamp=\{message\.type === 'assistant' && isPanelMessageGroupEnd\(visibleMessages, index\)\}/);
  // The stamp is an in-bubble 10px muted span, rendered from the
  // (parent-gated) label alone; the footer row right-aligns it — the
  // component renders whatever gated label it is handed and must not
  // re-decide WHO carries it (supersedes the external meta-line stamp of
  // pass #5; the who-decision lives at the parent gate since 14:07).
  assert.match(panelSource, /const bubbleStamp = timestampLabel \? \(/);
  assert.match(panelSource, /data-panel-message-timestamp="true"/);
  // SUPERSEDED (sixth item, owner ruling 2026-11-11 14:45): the three
  // bubble branches close with the in-bubble FOOTER (chip left, stamp
  // right); the footer composes {bubbleStamp} exactly once.
  const footerInserts = panelSource.match(/\{bubbleFooter\}/g) ?? [];
  assert.equal(footerInserts.length, 3, 'all three bubble branches close with the in-bubble footer');
  assert.equal((panelSource.match(/\{bubbleStamp\}/g) ?? []).length, 1, 'the footer is the only stamp mount point');
  // SUPERSEDED (sixth item, owner ruling 2026-11-11 14:45): the external
  // chip row is gone; its 11px secondary tone survives verbatim on the
  // streaming indicator, while the in-bubble chip keeps the SAME muted
  // secondary tone at 10px.
  assert.match(panelSource, /text-\[11px\][^`]*dark:text-claude-darkTextSecondary text-claude-textSecondary/);
  assert.match(panelSource, /text-\[10px\][^`]*dark:text-claude-darkTextSecondary text-claude-textSecondary/);
  assert.doesNotMatch(panelSource, /panel-message-meta/);
  assert.match(panelSource, /const bubbleFooter = hasReactionChip \|\| bubbleStamp \? \(/);
  const footerBlock = panelSource.match(/data-slot="panel-bubble-footer"[\s\S]*?\) : null;/)?.[0] ?? '';
  assert.ok(footerBlock, 'bubble footer block found');
  assert.ok(footerBlock.includes('data-panel-reaction-chip'), 'the chip is wired in the footer');
  assert.ok(footerBlock.includes('{bubbleStamp}'), 'the stamp rides the same footer row');
  assert.ok(
    footerBlock.indexOf('data-panel-reaction-chip') < footerBlock.indexOf('{bubbleStamp}'),
    'chip LEFT of the stamp on the footer row',
  );
  assert.match(footerBlock, /justify-end/, 'the pair hugs the bubble bottom-right corner');
  // The stamp renders only when formatting produced one.
  assert.match(timestampSource, /sameDay \? clock : `\$\{formatPanelDate\(stamp\)\} \$\{clock\}`/);
});

test('② the context menu is conditionally mounted and closes on all three channels', () => {
  // No persistent furniture: the component exists only inside a conditional.
  assert.match(panelSource, /\{contextMenu \? \(/);
  assert.match(panelSource, /<PanelMessageContextMenu/);
  assert.match(panelSource, /onDismiss=\{\(\) => setContextMenu\(null\)\}/);
  // Close channel 1: outside pointerdown (capture phase), keeping the opener bubble alive.
  assert.match(panelSource, /document\.addEventListener\('pointerdown', handlePointerDown, true\)/);
  assert.match(panelSource, /isPointerOutsideContextMenu\(panelMenuRef\.current, menu\.opener, event\.target\)/);
  // Close channel 2: Escape.
  assert.match(panelSource, /if \(event\.key === 'Escape'\) dismiss\(\)/);
  // Close channel 3: any scroll, capture phase.
  assert.match(panelSource, /window\.addEventListener\('scroll', dismiss, true\)/);
  // Viewport-flipped fixed placement at open time.
  assert.match(panelSource, /resolveContextMenuPlacement\(event\.clientX, event\.clientY/);
  // Dark compact chrome (WeChat/Telegram style), icon+label rows, hover highlight.
  assert.match(menuComponentSource, /bg-\[#2b2b2d\]/);
  assert.match(menuComponentSource, /rounded-xl border border-white\/10 .*shadow-elevated/);
  assert.match(menuComponentSource, /hover:bg-white\/10/);
  // Exactly four rows at runtime: the shared reactRow rendered for both
  // sides plus the quote and copy rows.
  assert.match(menuComponentSource, /data-panel-menu-action=\{rating\}/);
  assert.match(menuComponentSource, /\{reactRow\('up'\)\}/);
  assert.match(menuComponentSource, /\{reactRow\('down'\)\}/);
  assert.match(menuComponentSource, /data-panel-menu-action="quote"/);
  assert.match(menuComponentSource, /data-panel-menu-action="copy"/);
});

test('③ reactions persist locally under the twinChatReactions key, toggle-cancellable', () => {
  assert.match(reactionsSource, /`\$\{PANEL_REACTIONS_STORAGE_PREFIX\}:\$\{sessionId\}:\$\{messageId\}`/);
  assert.match(reactionsSource, /export const PANEL_REACTIONS_STORAGE_PREFIX = 'twinChatReactions';/);
  assert.match(reactionsSource, /current === next \? null : next/);
  assert.match(reactionsSource, /FUTURE IPC UPGRADE PATH/);
  // The panel goes through the module surface (never raw localStorage).
  assert.match(panelSource, /import \{\s*applyPanelReactionToggle,\s*getPanelReactionsStorage,\s*readPanelReactionsForSession,\s*writePanelReaction,/);
  assert.match(panelSource, /readPanelReactionsForSession\(getPanelReactionsStorage\(\), sessionId\)/);
  assert.match(panelSource, /applyPanelReactionToggle\(prev\[messageId\] \?\? null, rating\)/);
  // The chip renders only while a rating is active and clicking cancels it.
  assert.match(panelSource, /\{currentReaction && onToggleReaction \? \(/);
  assert.match(panelSource, /data-panel-reaction-chip=\{currentReaction\}/);
});

test('④ quote reply rides the shared composer slot; copy writes raw text', () => {
  // Same entry as CoworkSessionDetail's reply path: fragment → composer quote
  // slot → shared chip / removal / send composition.
  assert.match(panelSource, /import \{[^}]*createMessageQuotedSelection[^}]*\} from '\.\.\/\.\.\/components\/cowork\/coworkQuotedSelections';/);
  // SUPERSEDED in place (pass #4): the content is the captured selection when
  // one exists, else the whole message — one factory, same truncation cap.
  assert.match(panelSource, /const content = menu\.selectedText \?\? message\.content;/);
  assert.match(panelSource, /createMessageQuotedSelection\(\{\s*content,/);
  assert.match(panelSource, /promptInputRef\.current\?\.addQuotedSelection\(fragment\)/);
  assert.match(panelSource, /promptInputRef\.current\?\.focus\(\)/);
  // Copy text writes the RAW stored content (not a rendered derivative) —
  // with the selection-first precedence (pass #4).
  assert.match(panelSource, /const raw = menu\.selectedText \?\? menu\.message\.content;/);
  assert.match(panelSource, /navigator\.clipboard\?\.writeText/);
});

test('⑤ the menu labels are bilingual and wired through i18nService', () => {
  for (const key of [
    'botBrowserPanelMenuLike',
    'botBrowserPanelMenuDislike',
    'botBrowserPanelMenuQuoteReply',
    'botBrowserPanelMenuCopyText',
  ]) {
    // Exactly one definition per dictionary (zh + en).
    const hits = i18nSource.match(new RegExp(`^\\s*${key}:`, 'gm')) ?? [];
    assert.equal(hits.length, 2, `${key} must exist once in zh and once in en`);
    // The like/dislike rows resolve through the isUp ternary; the other two
    // call t() directly. Either form counts as wired through i18nService.
    const wired = menuComponentSource.includes(`i18nService.t('${key}')`)
      || menuComponentSource.includes(`'${key}'`);
    assert.ok(wired, `${key} must be referenced by the menu component`);
  }
});

test('the menu component forwardRef contract stays intact', () => {
  assert.match(menuComponentSource, /React\.forwardRef<HTMLDivElement, PanelMessageContextMenuProps>/);
  assert.match(menuComponentSource, /PanelMessageContextMenu\.displayName = 'PanelMessageContextMenu'/);
  assert.match(panelSource, /ref=\{panelMenuRef\}/);
  assert.match(geometrySource, /export const CONTEXT_MENU_WIDTH = 156/);
});

test('⑥ selection capture happens in the contextmenu handler with both endpoints contained', () => {
  // The panel reads window.getSelection() INSIDE handlePanelContextMenu —
  // the only reliable moment for select-then-right-click (Chromium keeps the
  // live selection there) — and resolves it through the pure helper.
  assert.match(panelSource, /import \{ resolveBubbleSelectedText \} from '\.\/panelBubbleSelection';/);
  assert.match(panelSource, /const selection = typeof window !== 'undefined' \? window\.getSelection\(\) : null;/);
  assert.match(panelSource, /resolveBubbleSelectedText\(/);
  // The state carries the captured fragment (null = whole-message fallback).
  assert.match(panelSource, /selectedText: string \| null;/);
  assert.match(panelSource, /selectedText,/);
  // Pure helper: BOTH endpoints must sit inside the bubble — a selection
  // spanning another bubble (or starting outside it) never harvests foreign
  // text; whichever bubble was right-clicked falls back to its whole message.
  assert.match(bubbleSelectionSource, /export const resolveBubbleSelectedText/);
  assert.match(bubbleSelectionSource, /!bubble\.contains\(anchorNode\) \|\| !bubble\.contains\(focusNode\)/);
  // Whitespace-only selections resolve to null (whole-message fallback).
  assert.match(bubbleSelectionSource, /rawText\.trim\(\)\.length === 0/);
});

test('⑥ menu labels switch with the selection; 👍👎 never do', () => {
  // The component takes the flag and drives BOTH selected-text variants
  // through i18n (quote reuses the coworkQuoteActionLabel key).
  assert.match(menuComponentSource, /selectionActive: boolean;/);
  assert.match(panelSource, /selectionActive=\{Boolean\(contextMenu\.selectedText\)\}/);
  assert.match(menuComponentSource, /selectionActive \? 'coworkQuoteActionLabel' : 'botBrowserPanelMenuQuoteReply'/);
  assert.match(menuComponentSource, /selectionActive \? 'botBrowserPanelMenuCopySelected' : 'botBrowserPanelMenuCopyText'/);
  // The selection marker rides the DOM for future E2E assertions.
  assert.match(menuComponentSource, /data-panel-menu-selection=/);
  // 👍👎 stay whole-bubble: the reactRow body never reads the selection flag.
  const reactRowBody = menuComponentSource.match(/const reactRow = \(rating: PanelReactionRating\) => \{[\s\S]*?\n {2}\};/)?.[0] ?? '';
  assert.ok(reactRowBody, 'reactRow found');
  assert.ok(!reactRowBody.includes('selectionActive'), 'reaction rows must ignore the selection');
  // New copy key exists exactly once per dictionary (zh + en); the reused
  // quote key is pre-existing and equally bilingual.
  for (const key of ['botBrowserPanelMenuCopySelected', 'coworkQuoteActionLabel']) {
    const hits = i18nSource.match(new RegExp(`^\\s*${key}:`, 'gm')) ?? [];
    assert.equal(hits.length, 2, `${key} must exist once in zh and once in en`);
  }
});

test('⑥ fragment quoting keeps the shared truncation cap', () => {
  // QUOTED_SELECTION_MAX_CHARS stays 4000 and the factory still applies it —
  // the selection path goes through createMessageQuotedSelection, so the cap
  // must not have been re-implemented or lowered somewhere else.
  assert.match(quotedSelectionsSource, /export const QUOTED_SELECTION_MAX_CHARS = 4000;/);
  assert.match(quotedSelectionsSource, /text\.length > QUOTED_SELECTION_MAX_CHARS/);
});
