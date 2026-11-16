import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Static wiring guard for Studio Twin-only Chief-of-Staff single-stream
// identity (superseding the multi-bot draft picker in Studio, owner ruling
// 2026-11-15): Studio pins exclusively to the machine's Twin Bot via
// CoworkSurfaceIdentityBadge, uses Clear Screen + Past Conversations instead of
// multi-session worker switching, and keeps BotPickerChip isolated for history
// filters / standalone surfaces without metabot_type mutations.

const repoRoot = path.resolve(import.meta.dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

const panelSource = read('src/renderer/features/botBrowser/BotBrowserCoworkPanel.tsx');
const chipSource = read('src/renderer/features/botBrowser/BotPickerChip.tsx');
const badgeSource = read('src/renderer/features/botBrowser/CoworkSurfaceIdentityBadge.tsx');
const badgePureSource = read('src/renderer/features/botBrowser/surfaceIdentityBadge.ts');
const dismissSource = read('src/renderer/features/botBrowser/seatMenuDismiss.ts');
const resolverSource = read('src/renderer/services/coworkSessionStart.ts');
const managerSource = read('src/renderer/components/metabots/MetabotsManager.tsx');
const i18nSource = read('src/renderer/services/i18n.ts');

test('Studio panel pins exclusively to the Twin Bot and renders read-only identity badges', () => {
  assert.doesNotMatch(panelSource, /<BotPickerChip/, 'Studio conversation panel no longer mounts a multi-bot picker');
  assert.match(panelSource, /import CoworkSurfaceIdentityBadge from '\.\/CoworkSurfaceIdentityBadge';/);
  assert.match(panelSource, /import \{ resolveTwinOnlyMetabotId \} from '\.\.\/\.\.\/services\/coworkSessionStart';/);
  assert.match(panelSource, /resolveTwinOnlyMetabotId\(metabots\)/);
  assert.match(resolverSource, /export function resolveTwinOnlyMetabotId/);
  assert.match(resolverSource, /const twin = bots\.find\(\(bot\) => bot\.metabot_type === 'twin'\);/);
  assert.match(panelSource, /data-slot="cowork-draft-twin-identity"/);
  assert.match(panelSource, /identityAnchorEl && currentSession/);
  assert.match(panelSource, /metabotId=\{currentSession\.metabotId \?\? null\}/);
  assert.match(panelSource, /fallbackName=\{currentSession\.metabotName \?\? null\}/);
  assert.match(panelSource, /fallbackAvatar=\{currentSession\.metabotAvatar \?\? null\}/);
});

test('the Studio header rests at identity height, previews title on hover/focus, and wires Clear Screen', () => {
  const sidebarSource = read('src/renderer/components/Sidebar.tsx');
  assert.match(panelSource, /import \{ createPortal \} from 'react-dom';/);
  assert.match(panelSource, /cowork-header-identity-anchor/);
  assert.match(panelSource, /className="flex items-center justify-end gap-0\.5 pb-1\.5"/);

  const headerStart = sidebarSource.indexOf('data-slot="studio-task-header"');
  const headerTagEnd = sidebarSource.indexOf('>', headerStart);
  const headerTag = sidebarSource.slice(headerStart, headerTagEnd);
  // The title lane is its own element under the task header (grace-collapse
  // rework): the height transition lives on studio-title-preview, not on the
  // header tag itself.
  const previewStart = sidebarSource.indexOf('data-slot="studio-title-preview"');
  const previewTag = sidebarSource.slice(previewStart, sidebarSource.indexOf('>', previewStart));
  assert.match(previewTag, /showStudioTitle \? 'h-9' : 'h-0'/);
  assert.match(previewTag, /transition-\[height\]/);
  assert.ok(previewStart > headerStart, 'the title lane sits inside the task header');

  const headerSpan = sidebarSource.slice(
    headerStart,
    sidebarSource.indexOf('data-slot="cowork-toggle-history"', headerStart),
  );
  const anchorAt = headerSpan.indexOf('cowork-header-identity-anchor');
  const nameAt = headerSpan.indexOf('<CoworkSurfaceSessionName');
  const newAt = headerSpan.indexOf('data-slot="cowork-new-session"');
  assert.ok(anchorAt !== -1, 'identity anchor present');
  assert.ok(nameAt > anchorAt, 'session title sits below the centered identity');
  assert.ok(newAt > nameAt, 'session actions remain in the same header');
  assert.match(headerSpan, /browserCoworkService\.clearCurrentScreen\(\)/);
  assert.match(headerSpan, /studio-decision-queue-badge/);
  assert.match(headerSpan, /onMouseEnter/);
  assert.match(headerSpan, /onMouseLeave/);
  assert.match(headerSpan, /onFocus/);
  assert.match(headerSpan, /onBlur/);
  assert.match(headerSpan, /aria-hidden=\{!showStudioTitle\}/);
  // The lane hides by collapsing its height (overflow-hidden + h-9/h-0 on
  // studio-title-preview), not by an invisible overlay layer.
  assert.match(previewTag, /overflow-hidden/);
  assert.doesNotMatch(headerSpan, /invisible pointer-events-none/);
  assert.match(sidebarSource, /identityRowEl\.addEventListener\('mouseenter', openPreview\)/);
  assert.match(sidebarSource, /headerEl\.addEventListener\('mouseleave', closePreviewOnLeave\)/);
  assert.match(sidebarSource, /nextTarget && event\.currentTarget\.contains\(nextTarget\)/);
});

test('Studio history panel stacks above the Twin welcome identity', () => {
  const historySource = read('src/renderer/features/botBrowser/CoworkHistoryPanel.tsx');
  assert.match(historySource, /data-slot="cowork-history-panel"[\s\S]*?\bz-30\b/);
});

test('Studio panel never mutates metabot_type or shows appointment toasts', () => {
  assert.doesNotMatch(panelSource, /appointTwinSeat/);
  assert.doesNotMatch(panelSource, /window\.electron\.metabot\.update/);
  assert.doesNotMatch(panelSource, /metabot_type: 'worker'/);
  assert.doesNotMatch(panelSource, /metabot_type: 'twin'/);
  assert.doesNotMatch(panelSource, /app:showToast/);
});

test('badge and standalone chip keep their clean component contracts', () => {
  assert.match(chipSource, /\{roster\.map\(\(metabot\) => \(/);
  assert.doesNotMatch(chipSource, /disabled=\{/, 'a pure selection never disables a roster row');
  assert.match(chipSource, /aria-selected=\{isSelected\}/);
  assert.doesNotMatch(chipSource, /live \? \(/, 'the chip has no live branch anymore');
  assert.match(badgeSource, /data-slot="cowork-surface-identity-badge"/);
  assert.match(badgeSource, /h-8 w-8 shrink-0 rounded-full/);
  assert.match(badgeSource, /gap-2/);
  assert.match(chipSource, /h-8 w-8 rounded-full/);
  assert.doesNotMatch(badgeSource, /<button/, 'the badge renders no click target');
  assert.doesNotMatch(badgeSource, /onClick=/, 'the badge owns no interaction');
  assert.match(badgePureSource, /export function resolveSurfaceIdentityBadge/);
  assert.match(chipSource, /import \{ bindSeatMenuOutsideDismiss \} from '\.\/seatMenuDismiss';/);
  assert.match(dismissSource, /addEventListener\('pointerdown', handlePointerDown, true\)/);
});

test('My Bots subscribes to the shared broadcast and refetches silently', () => {
  assert.match(
    managerSource,
    /import \{ dispatchMetabotsChanged, subscribeMetabotsChanged \} from '\.\.\/\.\.\/services\/metabotEvents';/,
  );
  assert.match(managerSource, /useEffect\(\(\) => subscribeMetabotsChanged/);
  assert.match(managerSource, /void loadList\(\{ silent: true \}\)/);
  assert.match(managerSource, /dispatchMetabotsChanged\(\{ metabotIds: \[editId\], reason: 'edit' \}\)/);
});

test('Studio single-stream and decision-queue copy exists in both locales and retired appointment copy stays gone', () => {
  for (const key of [
    'studioClearScreen',
    'studioHistoryChapters',
    'studioDecisionQueueBadge',
    'studioDecisionPresentingBadge',
    'botInternetNeedsBot',
    'botInternetGoBotWorks',
  ]) {
    const occurrences = i18nSource.match(new RegExp(`${key}:`, 'g')) ?? [];
    assert.equal(occurrences.length, 2, `${key} must exist in zh and en`);
  }
  for (const key of [
    'botInternetTwinSeatTitle',
    'botInternetTwinSeatHint',
    'botInternetTwinSeatAppoint',
    'botInternetTwinSeatChip',
    'botInternetTwinSeatAppointed',
    'botInternetTwinSeatRollbackFailed',
    'botInternetNeedsTwin',
    'botInternetGoBotHome',
  ]) {
    const occurrences = i18nSource.match(new RegExp(`${key}:`, 'g')) ?? [];
    assert.equal(occurrences.length, 0, `${key} must be gone — the seat appointment is retired`);
  }
});
