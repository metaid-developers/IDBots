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
// ③④ the stamp is the twin side's group-end line, default visible, and the
//    👍chip shares that row adapting to the bubble alignment side.
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

test('③④ the meta row: twin-side default stamp + chip-first alignment', () => {
  // No hover gating survives from pass #3: no visibility-toggled reveal, no
  // reserved-slot machinery, no `group` hover proxy on the row wrappers.
  assert.doesNotMatch(panelSource, /group-hover:/);
  assert.doesNotMatch(panelSource, /stampOnlyRow/);
  assert.doesNotMatch(panelSource, /className="group /);
  // The stamp formula lives in the parent: assistant && group-end only.
  assert.match(panelSource, /showTimestamp=\{message\.type === 'assistant' && isPanelMessageGroupEnd\(visibleMessages, index\)\}/);
  // Defense-in-depth in the row: a user bubble never carries a stamp.
  assert.match(panelSource, /const showStamp = showTimestamp && !isUser;/);
  // The row mounts only when it has content…
  assert.match(panelSource, /showStamp \|\| hasReactionChip \? \(/);
  // …aligns with the bubble side (user right, assistant left)…
  assert.match(panelSource, /isUser \? 'justify-end' : 'justify-start'/);
  // …and reads [👍chip][time] on assistant rows (chip before stamp).
  const metaRowBlock = panelSource.match(/data-slot="panel-message-meta"[\s\S]*?\) : null;/)?.[0] ?? '';
  assert.ok(metaRowBlock, 'meta row block found');
  const chipIndex = metaRowBlock.indexOf('data-panel-reaction-chip');
  const stampIndex = metaRowBlock.indexOf('data-panel-message-timestamp');
  assert.ok(chipIndex !== -1, 'reaction chip wired in the row');
  assert.ok(stampIndex !== -1, 'stamp wired in the row');
  assert.ok(chipIndex < stampIndex, 'assistant rows read [chip][time]');
  // The timestamp guard only renders when formatting produced one.
  assert.match(panelSource, /\{showStamp && timestampLabel \? \(/);
});
