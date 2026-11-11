import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Static wiring guard for the office-chat purity pass #5 (delegation
// 7459ba51 / step b64861e1, 2026-11-10, merged three-item card), as amended
// by the owner on 2026-11-11:
// ① the pending reply card names the REAL speaker (the panel feeds the
//    composer's botName);
// ② REVERTED — the owner live-tested the Telegram sent-quote card and
//    ruled the quote felt disjointed from the reply inside one bubble; sent
//    quotes keep the ORIGINAL inline generated-block style. This file pins
//    the ABSENCE of the card machinery so it cannot quietly regrow;
// ③④ SUPERSEDED by the chat-window four-item fix ② (delegation 3e22c1c3 /
//    step 07807b1a, owner ruling 2026-11-11): the stamp moved INSIDE the
//    bubble, unified across user and assistant rows; the external meta
//    line is gone. SUPERSEDED AGAIN by the sixth item (owner ruling
//    2026-11-11 14:45): the 👍chip moved inside too — one in-bubble footer
//    row, chip LEFT of the stamp; the external chip row is gone for good.
//    The ③④ test below was rewritten in place to the newest shape.
// Timestamp-related pins superseded in the pass #1 and pass #3 guard files
// live with their own rewrites; this file owns the pass #5 surface.

const repoRoot = path.resolve(import.meta.dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

const panelSource = read('src/renderer/features/botBrowser/BotBrowserCoworkPanel.tsx');
const inputSource = read('src/renderer/components/cowork/CoworkPromptInput.tsx');
const tilesSource = read('src/renderer/components/cowork/CoworkQuotedSelectionTiles.tsx');
const i18nSource = read('src/renderer/services/i18n.ts');

test('① the panel feeds the real bot name to the composer (pending card)', () => {
  // The composer wire names the pending reply card's speaker — 「回复
  // Monday」 replaces 「回复 Bot」. (The PanelMessage wire from the reverted
  // sent-quote card is gone with it.)
  const wires = panelSource.match(/botName=\{chipMetabot\?\.name \?\? null\}/g) ?? [];
  assert.equal(wires.length, 2, 'composer AND PanelMessage receive the bot name');
  // The composer forwards it into the pending tiles.
  const tilesCall = inputSource.match(/<CoworkQuotedSelectionTiles[\s\S]*?\/>/)?.[0] ?? '';
  assert.ok(tilesCall, 'tiles call site found');
  assert.match(tilesCall, /botName=\{botName\}/);
  // The tiles name the assistant by the bot name with the i18n 「Bot」
  // fallback only when no name is known (unchanged pass #3 contract).
  assert.match(tilesSource, /speakerNameFor\(selection, botName\)/);
  assert.match(i18nSource, /coworkQuoteSentReplySourceAssistantFallback: 'Bot'/);
});

test('② sent quotes render INLINE with the real speaker (card stays reverted)', () => {
  // Owner rulings, synthesized 2026-11-11: the quote and the reply live in
  // ONE bubble (no Telegram card) AND the label shows the real speaker via
  // the main transcript's WeChat-style mapping, not the machine label.
  // No card machinery may survive or regrow in the panel.
  assert.doesNotMatch(panelSource, /panelSentQuoteCard/);
  assert.doesNotMatch(panelSource, /buildPanelSentQuoteCardModel/);
  assert.doesNotMatch(panelSource, /data-panel-sent-quote/);
  assert.doesNotMatch(panelSource, /panelQuoteDisplaySources/);
  // The inline mapping rides the shared parsers + display-source builders.
  assert.match(panelSource, /parseSentQuoteBlock\(message\.content, buildSentQuoteDisplaySources\(botName\)\)/);
  assert.match(panelSource, /parseSentSelectionQuoteBlock\(message\.content, buildSentSelectionQuoteLabelSets\(botName\)\)/);
  // The body renders the display transform, not the stored body.
  assert.match(panelSource, /<UserMessageBody content=\{displayContent\}/);
  // DISPLAY-ONLY BOUNDARY (still holds): the stored body is never rewritten.
  assert.doesNotMatch(panelSource, /message\.content\s*=[^=]/);
});

test('③④ stamp + chip share the in-bubble footer (chip left, stamp right), gated to assistant group-ends at the parent (sixth item supersession)', () => {
  // No hover gating survives from pass #3: no visibility-toggled reveal, no
  // reserved-slot machinery, no hover proxy on the row wrappers.
  assert.doesNotMatch(panelSource, /group-hover:/);
  assert.doesNotMatch(panelSource, /stampOnlyRow/);
  assert.doesNotMatch(panelSource, /className="group /);
  // The parent feeds the assistant&&group-end expression. Gate history
  // (superseded twice): pass #5's hover gate → fix ② (11:19) retired it →
  // the 14:07 rework promoted it back as the DECIDING gate: it pre-gates
  // timestampLabel (only assistant group-end bubbles receive one) and rides
  // showTimestamp verbatim for contract stability.
  assert.match(panelSource, /showTimestamp=\{message\.type === 'assistant' && isPanelMessageGroupEnd\(visibleMessages, index\)\}/);
  // The stamp: an in-bubble 10px muted span, rendered from the parent-gated
  // label alone; the footer row right-aligns it — the component re-decides
  // nothing about WHO carries it (supersedes the "user and assistant
  // unified, formatting alone" wording).
  assert.match(panelSource, /const bubbleStamp = timestampLabel \? \(/);
  assert.match(panelSource, /data-panel-message-timestamp="true"/);
  // SUPERSEDED (sixth item, owner ruling 2026-11-11 14:45): the three
  // bubble branches now close with the in-bubble FOOTER (chip left, stamp
  // right); the footer composes {bubbleStamp} exactly once — no branch
  // mounts the stamp directly.
  const footerInserts = panelSource.match(/\{bubbleFooter\}/g) ?? [];
  assert.equal(footerInserts.length, 3, 'all three bubble branches close with the in-bubble footer');
  assert.equal((panelSource.match(/\{bubbleStamp\}/g) ?? []).length, 1, 'the footer is the only stamp mount point');
  // SUPERSEDED (sixth item, owner ruling 2026-11-11 14:45): the external
  // chip row is gone for good; the chip rides the in-bubble footer beside
  // the stamp, flush with the bubble's bottom-right corner — the alignment
  // no longer mirrors the bubble side.
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
