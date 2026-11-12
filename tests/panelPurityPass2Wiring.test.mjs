import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Static wiring guard for the office-chat purity pass #2 (2026-11-10):
// ③ the message locator rail on the transcript's right edge, ④ the adaptive
// composer layout. Behavior lives in panelMessageLocator.test.ts; this file
// pins the wiring and the backward-compat surface so a refactor cannot
// quietly drop a channel, un-cap the composer, or change what
// CoworkSessionDetail / CoworkView / App receive.

const repoRoot = path.resolve(import.meta.dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

const panelSource = read('src/renderer/features/botBrowser/BotBrowserCoworkPanel.tsx');
const railSource = read('src/renderer/features/botBrowser/PanelMessageLocatorRail.tsx');
const locatorSource = read('src/renderer/features/botBrowser/panelMessageLocator.ts');
const composerSource = read('src/renderer/components/cowork/CoworkPromptInput.tsx');
const sessionDetailSource = read('src/renderer/components/cowork/CoworkSessionDetail.tsx');
const i18nSource = read('src/renderer/services/i18n.ts');

test('③ the rail mounts at the transcript edge inside a relative wrapper', () => {
  // The scroller stays unpositioned so the rail never scrolls with content.
  assert.match(panelSource, /<div className="relative min-h-0 flex-1">/);
  // The locator rail is the seat's scroll indicator, so the native
  // scrollbar is hidden on this scroller (scroll behavior unchanged).
  // 2026-11-11 14:41 rework (supersedes the bare `px-1` literal this pin
  // carried; the "preview card dodge" card was cancelled and reverted):
  // the scroller RESERVES the rail's horizontal lane — pl-1 pr-5 = 20px
  // clears the 14px (w-3.5) floating rail + the 1px ring-1 overhang + a
  // 5px safety gap, so bubbles and the jump ring never paint under the
  // locator rail.
  assert.match(panelSource, /<div ref=\{listRef\} className="h-full space-y-2\.5 overflow-y-auto overflow-x-hidden pl-1 pr-5 pb-2 \[scrollbar-width:none\] \[&::-webkit-scrollbar\]:hidden">/);
  assert.match(panelSource, /<PanelMessageLocatorRail/);
  assert.match(panelSource, /containerRef=\{listRef\}/);
  assert.match(panelSource, /rows=\{locatorRows\}/);
  assert.match(panelSource, /ariaLabel=\{i18nService\.t\('botBrowserLocatorRail'\)\}/);
  // Rows come from the pure builder with the reused owner label key.
  assert.match(panelSource, /buildPanelLocatorRows\(visibleMessages, \{/);
  assert.match(panelSource, /userLabel: i18nService\.t\('coworkOriginBadgeYou'\)/);
});

test('③ every PanelMessage root carries the measurable row id', () => {
  const hits = panelSource.match(/data-panel-message-id=\{message\.id\}/g) ?? [];
  // user, assistant-mode, professional, and the turn-failure card roots are
  // all tagged — the locator rail jumps to failure rows like any other row.
  assert.equal(hits.length, 4, 'user, assistant-mode, professional and failure-card roots all tagged');
});

test('③ the transcript auto-scroll-to-bottom behavior is untouched', () => {
  assert.match(panelSource, /const list = listRef\.current;\s*\n\s*if \(list\) \{\s*\n\s*list\.scrollTop = list\.scrollHeight;/);
  assert.match(panelSource, /\}, \[visibleMessages\.length, isStreaming\]\);/);
  // The rail reads scroll state only: it never writes scrollTop outside the
  // two interaction mappings (drag handle / click jump).
  const writes = railSource.match(/container\.scrollTop\s*=/g) ?? [];
  assert.equal(writes.length, 2, 'exactly the drag and click jump assignments');
});

test('③ the rail self-hides without overflow and wires all interaction channels', () => {
  assert.match(railSource, /if \(!overflowing\) return null;/);
  assert.match(railSource, /isPanelLocatorOverflow\(scrollHeight, clientHeight\)/);
  // Drag: pointer capture + proportional handle mapping.
  assert.match(railSource, /setPointerCapture\(event\.pointerId\)/);
  assert.match(railSource, /panelLocatorScrollForHandle\(/);
  // Click-a-tick: row-top jump with lead.
  assert.match(railSource, /panelLocatorScrollForRow\(/);
  // Hover preview: sender + first two conversation lines.
  assert.match(railSource, /panelLocatorPreviewLines\(hoverRow\.content, 2\)/);
  assert.match(railSource, /data-slot="panel-locator-preview"/);
  // Scrollbar semantics + wheel forwarding (no dead zone over the thin rail).
  assert.match(railSource, /role="scrollbar"/);
  assert.match(railSource, /scrollBy\(\{ top: event\.deltaY \}\)/);
  // Tick + thumb + track slots exist.
  assert.match(railSource, /data-slot="panel-locator-tick"/);
  assert.match(railSource, /data-slot="panel-locator-thumb"/);
  assert.match(railSource, /data-slot="panel-locator-track"/);
});

test('③ the tick map stays document-proportional and guarded', () => {
  assert.match(locatorSource, /PANEL_LOCATOR_OVERFLOW_THRESHOLD_PX = 4/);
  assert.match(locatorSource, /start = clamp01\(box\.offsetTop \/ contentHeight\)/);
  assert.match(locatorSource, /Math\.min\(1 - start, box\.offsetHeight \/ contentHeight\)/);
});

test('④ the composer textarea adapts: shrink, single-line hint, capped scroll', () => {
  // Small branch (office panel surface): the shrinkable flex item is the
  // textarea's wrapper, so narrow windows compress the input.
  assert.match(composerSource, /<div className="relative min-w-0 flex-1">/);
  // 2026-11-11 14:07 rework (supersedes the bare `overflow-y-auto` prefix
  // this pin carried): the class string opens with `overflow-x-hidden` so
  // the now-unwrapped transparent placeholder can never paint a horizontal
  // scrollbar (user text soft-wraps; only the placeholder could overflow).
  assert.match(composerSource, /'w-full peer resize-none overflow-x-hidden overflow-y-auto bg-transparent/);
  // Chromium paints no ellipsis on a textarea placeholder, so the visible
  // hint is an overlay div (`truncate` = real "…"); the native placeholder
  // stays for the accessible name but renders transparent. Both branches.
  // (Supersedes the adjacent `placeholder:text-transparent
  // dark:placeholder:text-transparent` adjacency pin: the nowrap clamp now
  // rides between them.)
  assert.match(composerSource, /placeholder:text-transparent placeholder:whitespace-nowrap dark:placeholder:text-transparent/);
  // 2026-11-11 14:07 rework, the empty-state height fix itself: Chromium
  // LAYS OUT the (transparent) placeholder, and a placeholder that wraps
  // at the narrow panel width inflated the EMPTY textarea's scrollHeight —
  // the mount-time auto-resize then wrote that height inline (48px instead
  // of the 24px floor), and the stale-height cache legitimately kept it
  // through the first keystroke. Clamping the placeholder to one line
  // makes it height-neutral in every mount form (probe-measured: panel
  // form empty auto-measure 48px → 24px; large forms keep 42/60 floors).
  // All three textarea class strings carry the clamp; both scrolling
  // textareas additionally clip the horizontal axis.
  const nowrapClamps = composerSource.match(/placeholder:whitespace-nowrap/g) ?? [];
  assert.equal(nowrapClamps.length, 3, 'textarea large + small + claim variants all clamp the placeholder to one line');
  const xHidden = composerSource.match(/overflow-x-hidden/g) ?? [];
  assert.equal(xHidden.length, 2, 'both scrolling textarea variants clip the horizontal axis');
  const overlays = composerSource.match(/data-slot="composer-hint-overlay"/g) ?? [];
  assert.equal(overlays.length, 2, 'large and small branches both carry the hint overlay');
  const gates = composerSource.match(/!composerFocused && !value\.trim\(\)/g) ?? [];
  assert.equal(gates.length, 2, 'overlay hidden while focused or while text is present');
  const focusWires = composerSource.match(/onFocus=\{\(\) => setComposerFocused\(true\)\}/g) ?? [];
  assert.equal(focusWires.length, 2, 'both textareas report focus to the overlay gate');
  // The native placeholder attribute remains on both textareas.
  const nativeHints = composerSource.match(/placeholder=\{effectivePlaceholder\}/g) ?? [];
  assert.equal(nativeHints.length, 2);
  // The JS height clamp (grow to cap, then internal scroll) is still wired.
  assert.match(composerSource, /composerTextareaHeight\(contentHeight, minHeight, maxHeight\)/);
});

test('④ attachments render as the original normal-flow strip (rail reverted)', () => {
  // Owner ruling 2026-11-11 00:58: after four layout iterations (external
  // bar → left column beside text → rail with pinned buttons) none matched
  // his mental image, so the attachment strip returns to its ORIGINAL
  // normal-flow spot above the input row with the pass #2 cap + internal
  // scroll. The caret centering from this pass STAYS. The rail forms are
  // pinned OUT so they cannot quietly regrow.
  assert.match(composerSource, /relative z-10 flex w-full max-h-24 flex-wrap gap-2 overflow-y-auto/);
  assert.doesNotMatch(composerSource, /composer-attachment-column/);
  assert.doesNotMatch(composerSource, /w-\[68px\]/);
  assert.doesNotMatch(composerSource, /flex items-stretch/);
  // The empty-state caret centering survives the revert.
  assert.match(composerSource, /const emptyPadY = isLarge && isEmptyComposer/);
  assert.match(composerSource, /style=\{isEmptyComposer \? \{ lineHeight: `\$\{minHeight\}px` \} : undefined\}/);
  assert.match(composerSource, /paddingTop: `\$\{emptyPadY\}px`/);
});

test('compat the shared composer surface contracts are unchanged', () => {
  // CoworkSessionDetail keeps its large + singleLine usage (read-only check).
  assert.match(sessionDetailSource, /size="large"/);
  assert.match(sessionDetailSource, /\bsingleLine\b/);
  // CoworkView keeps the large multi-line composer.
  const viewSource = read('src/renderer/components/cowork/CoworkView.tsx');
  assert.match(viewSource, /size="large"/);
});

test('i18n the locator copy is bilingual and the owner label key exists', () => {
  assert.match(i18nSource, /botBrowserLocatorRail: '消息定位'/);
  assert.match(i18nSource, /botBrowserLocatorRail: 'Message locator'/);
  assert.match(i18nSource, /coworkOriginBadgeYou: '你'/);
  assert.match(i18nSource, /coworkOriginBadgeYou: 'You'/);
});

test('⑤ the transcript reserves the rail lane so bubbles and the jump ring never enter it', () => {
  // Owner rework ruling 2026-11-11 14:40 (supersedes the cancelled
  // "preview card dodge" guard): that prior guard pinned
  // panelLocatorPreviewPlacement / PANEL_LOCATOR_PREVIEW_* literals whose
  // helpers were reverted with the void card. The real defect was the
  // highlight bubble's right edge — plus the ring-1 outward overhang —
  // painting under the floating locator rail, so the fix lives on the
  // scroller as a persistent lane reservation.
  assert.match(panelSource, /overflow-x-hidden pl-1 pr-5 pb-2/);
  // Count inside className attributes only — the scroller's explanatory
  // comment also names the literal, so a bare match would self-bite.
  const lanePins = panelSource.match(/className="[^"]*\bpr-5\b/g) ?? [];
  assert.equal(lanePins.length, 1, 'exactly the transcript scroller reserves the rail lane');
  // The rail itself stays a floating w-3.5 (14px) right-edge overlay —
  // the reservation lives on the scroller, never on the rail.
  assert.match(railSource, /bottom-1 right-0 top-1 z-20 w-3\.5/);
  // The reservation only matters while the jump ring can light at all:
  // pin the tick-click → host-ring seam (2026-11-11 14:51 restore — the
  // void-card revert briefly wiped the rail-side onTickJump wiring while
  // the panel kept calling it, killing the ring and tsc with it).
  assert.match(railSource, /onTickJump\?\.\(ticks\[index\]\.id\)/);
  assert.match(panelSource, /onTickJump=\{handleLocatorTickJump\}/);
  // The reservation must outlive the jump ring: ring-1 paints 1px past the
  // bubble edge, so 20px − 14px − 1px keeps a visible safety gap while
  // QUOTE_JUMP_HIGHLIGHT_MS stays the shared 2.5s ring window.
  assert.match(sessionDetailSource, /QUOTE_JUMP_HIGHLIGHT_CLASSES = \['ring-1', 'ring-claude-accent'\]/);
  assert.match(sessionDetailSource, /QUOTE_JUMP_HIGHLIGHT_MS = 2500/);
  // The hover preview card keeps its left-of-rail lane (HEAD behavior).
  assert.match(railSource, /right-full mr-2 w-56/);
});
