import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Static wiring guard for Studio bot selection: the draft picker lives in the
// welcome page, live identity stays read-only in the header, and no selection
// path can grow into a Twin appointment.

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

test('the panel centers the draft picker in the welcome page and portals only live identity', () => {
  assert.match(panelSource, /import BotPickerChip from '\.\/BotPickerChip';/);
  assert.match(panelSource, /import CoworkSurfaceIdentityBadge from '\.\/CoworkSurfaceIdentityBadge';/);
  assert.match(panelSource, /import \{ resolveDefaultMetabotId \} from '\.\.\/\.\.\/services\/coworkSessionStart';/);
  assert.match(panelSource, /resolveDefaultMetabotId\(metabots, pickedMetabotId\)/);
  assert.match(resolverSource, /const twin = bots\.find\(\(bot\) => bot\.metabot_type === 'twin'\);/);
  assert.match(panelSource, /data-slot="cowork-draft-bot-picker"/);
  assert.match(panelSource, /<BotPickerChip/);
  assert.match(panelSource, /menuOpen=\{showBotPickerMenu\}/);
  assert.match(panelSource, /identityAnchorEl && currentSession/);
  assert.match(panelSource, /metabotId=\{currentSession\.metabotId \?\? null\}/);
  assert.match(panelSource, /fallbackName=\{currentSession\.metabotName \?\? null\}/);
  assert.match(panelSource, /fallbackAvatar=\{currentSession\.metabotAvatar \?\? null\}/);
});

test('the Studio header rests at identity height and previews the title on hover or focus', () => {
  const sidebarSource = read('src/renderer/components/Sidebar.tsx');
  assert.equal((panelSource.match(/<BotPickerChip/g) ?? []).length, 1, 'the chip mounts exactly once');
  assert.match(panelSource, /import \{ createPortal \} from 'react-dom';/);
  assert.match(panelSource, /cowork-header-identity-anchor/);
  assert.match(panelSource, /menuDirection="down"/);
  assert.match(panelSource, /className="flex items-center justify-end gap-0\.5 pb-1\.5"/);

  const headerStart = sidebarSource.indexOf('data-slot="studio-task-header"');
  const headerTagEnd = sidebarSource.indexOf('>', headerStart);
  const headerTag = sidebarSource.slice(headerStart, headerTagEnd);
  assert.match(headerTag, /showStudioTitle \? 'h-16' : 'h-9'/);
  assert.match(headerTag, /transition-\[height\]/);

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
  assert.match(headerSpan, /onMouseEnter/);
  assert.match(headerSpan, /onMouseLeave/);
  assert.match(headerSpan, /onFocus/);
  assert.match(headerSpan, /onBlur/);
  assert.match(headerSpan, /aria-hidden=\{!showStudioTitle\}/);
  assert.match(headerSpan, /invisible pointer-events-none/);
  assert.match(headerSpan, /absolute right-0 top-0/);
  assert.match(sidebarSource, /identityRowEl\.addEventListener\('mouseenter', openPreview\)/);
  assert.match(sidebarSource, /headerEl\.addEventListener\('mouseleave', closePreviewOnLeave\)/);
  assert.match(sidebarSource, /nextTarget && event\.currentTarget\.contains\(nextTarget\)/);
});

test('Studio history panel stacks above the centered draft bot picker', () => {
  const historySource = read('src/renderer/features/botBrowser/CoworkHistoryPanel.tsx');
  assert.match(historySource, /data-slot="cowork-history-panel"[\s\S]*?\bz-30\b/);
  assert.match(panelSource, /setShowBotPickerMenu\(false\)/);
});

test('picking a bot is a pure selection: no metabot_type write, no IPC, no toast', () => {
  assert.match(panelSource, /const handlePickBot = useCallback\(\(target: PanelMetabot\) => \{/);
  assert.match(panelSource, /setPickedMetabotId\(target\.id\);/);
  assert.match(panelSource, /setShowBotPickerMenu\(false\);/);
  // The appointment machinery must never grow back into the picker: metabot
  // updates belong to the My Bots editor alone.
  assert.doesNotMatch(panelSource, /appointTwinSeat/);
  assert.doesNotMatch(panelSource, /window\.electron\.metabot\.update/);
  assert.doesNotMatch(panelSource, /metabot_type: 'worker'/);
  assert.doesNotMatch(panelSource, /metabot_type: 'twin'/);
  // A selection needs no toast either — silence is the success path.
  assert.doesNotMatch(panelSource, /app:showToast/);
});

test('the chip menu lists the roster with every row enabled; live identity is the badge (v3 close supersession)', () => {
  assert.match(chipSource, /\{roster\.map\(\(metabot\) => \(/);
  assert.doesNotMatch(chipSource, /disabled=\{/, 'a pure selection never disables a roster row');
  assert.match(chipSource, /aria-selected=\{isSelected\}/);
  // Supersession: the chip's display-only live branch moved OUT to the
  // badge — the chip is draft-only, so a live transcript can never grow a
  // menu trigger.
  assert.doesNotMatch(chipSource, /live \? \(/, 'the chip has no live branch anymore');
  // The live and draft identities share the enlarged centered avatar grammar.
  assert.match(badgeSource, /data-slot="cowork-surface-identity-badge"/);
  assert.match(badgeSource, /h-8 w-8 shrink-0 rounded-full/);
  assert.match(badgeSource, /gap-2/);
  assert.match(chipSource, /h-8 w-8 rounded-full/);
  assert.doesNotMatch(badgeSource, /<button/, 'the badge renders no click target');
  assert.doesNotMatch(badgeSource, /onClick=/, 'the badge owns no interaction');
  assert.match(badgePureSource, /export function resolveSurfaceIdentityBadge/);
});

test('an open picker menu closes on an outside pointer through the tested helper', () => {
  assert.match(chipSource, /import \{ bindSeatMenuOutsideDismiss \} from '\.\/seatMenuDismiss';/);
  assert.match(chipSource, /if \(!menuOpen\) return undefined;/);
  assert.match(chipSource, /container: \(\) => containerRef\.current/);
  assert.match(chipSource, /onDismiss: onDismissMenu/);
  assert.match(chipSource, /ref=\{containerRef\}/);
  assert.match(panelSource, /onDismissMenu=\{closeBotPickerMenu\}/);
  // Capture phase: a row that stops propagation cannot pin the menu open.
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

test('the picker copy exists in both locales and the appointment copy is gone', () => {
  for (const key of [
    'botInternetBotPickerTitle',
    'botInternetBotPickerHint',
    'botInternetBotPickerChip',
    'botBrowserCoworkPlaceholderWorker',
    'botBrowserCoworkEmptySubWorker',
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
