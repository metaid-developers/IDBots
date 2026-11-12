import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import BotBrowserModeSwitch, {
  TOP_GAP_DEFAULT_PX,
  TOP_GAP_MAC_PX,
} from '../src/renderer/features/botBrowser/BotBrowserModeSwitch';
import type { BotBrowserSurfaceMode } from '../src/renderer/features/botBrowser/types';

const switchSource = readFileSync(
  new URL('../src/renderer/features/botBrowser/BotBrowserModeSwitch.tsx', import.meta.url),
  'utf8',
);
const sidebarSource = readFileSync(
  new URL('../src/renderer/components/Sidebar.tsx', import.meta.url),
  'utf8',
);
const homeSidebarSource = readFileSync(
  new URL('../src/renderer/components/HomeSidebar.tsx', import.meta.url),
  'utf8',
);
const panelSource = readFileSync(
  new URL('../src/renderer/features/botBrowser/BotBrowserCoworkPanel.tsx', import.meta.url),
  'utf8',
);

/**
 * Owner red-box order 2026-11-09 10:58 (supersedes the 10:29 row-1 reading),
 * amended by the D-line final ruling 2026-11-09: row 1 = the traffic lights
 * ALONE (a 52 px strip on macOS); row 2 = the two-cell segmented band ALONE,
 * dropped below the lights row on BOTH faces — the identity avatar moved to
 * the rail's top slot, so this header mounts no entry at all. Two text cells,
 * yellow fill on the current face, no mark / no chevron / no menu; radiogroup
 * + radio semantics and arrow-key movement. The header's light actions ride
 * the row directly below the band.
 */
function render(
  mode: BotBrowserSurfaceMode,
  extra: {
    actions?: React.ReactNode;
    topGapPx?: number;
  } = {},
) {
  return renderToStaticMarkup(
    <BotBrowserModeSwitch
      mode={mode}
      onSelectHome={() => {}}
      onSelectBrowser={() => {}}
      {...extra}
    />,
  );
}

test('the band is ONE shared top-track row with a two-cell radiogroup', () => {
  const markup = render('home');

  assert.match(markup, /data-slot="surface-header-bar"/);
  assert.match(markup, /data-slot="surface-header-bar"[^>]*h-\[52px\]/);
  assert.match(markup, /role="radiogroup"/);
  // Exactly two radios — the two surfaces, in order, text only.
  assert.equal((markup.match(/<button/g) ?? []).length, 2);
  assert.equal((markup.match(/role="radio"/g) ?? []).length, 2);
  const options = markup.match(/data-slot="surface-switch-option"/g) ?? [];
  assert.equal(options.length, 2);
  assert.ok(markup.indexOf('Studio') < markup.indexOf('BotWorks'));
  assert.match(markup, /data-surface="browser"/);
  assert.match(markup, /data-surface="home"/);
  // No pill residue: no logo, no chevron menu, no haspopup trigger.
  assert.doesNotMatch(markup, /surface-brand-mark/);
  assert.doesNotMatch(markup, /aria-haspopup/);
  assert.doesNotMatch(markup, /surface-switch-menu/);
  assert.doesNotMatch(markup, /surface-switch-trigger/);
});

test('the current face is the checked, yellow-filled radio', () => {
  const home = render('home');
  assert.match(home, /aria-checked="true"[^>]*data-surface="home"/);
  assert.match(home, /aria-checked="false"[^>]*data-surface="browser"/);

  const start = home.indexOf('data-surface="home"');
  const homeButton = home.slice(start, home.indexOf('</button>', start));
  assert.match(homeButton, /bg-claude-accent/);
  assert.match(homeButton, /text-claude-accentInk/);
  assert.match(homeButton, /shadow-\[3px_3px_0_var\(--btn-primary-edge\)\]/);
  assert.match(home, /aria-checked="true" tabindex="0"/);

  const browserStart = home.indexOf('data-surface="browser"');
  const browserButton = home.slice(browserStart, home.indexOf('</button>', browserStart));
  assert.match(browserButton, /text-claude-textSecondary/);
  assert.doesNotMatch(browserButton, /bg-claude-accent\b/);
  assert.match(home, /aria-checked="false" tabindex="-1"/);

  // Flipping the mode moves the fill, never duplicates it.
  const browser = render('browser');
  assert.match(browser, /aria-checked="true"[^>]*data-surface="browser"/);
  assert.match(browser, /aria-checked="false"[^>]*data-surface="home"/);
  assert.equal((browser.match(/bg-claude-accent\b/g) ?? []).length, 1);
});

test('the tray keeps the baseline segmented grammar', () => {
  const markup = render('browser');
  const trayStart = markup.indexOf('data-slot="bot-browser-mode-segments"');
  const tray = markup.slice(trayStart, markup.indexOf('>', trayStart));
  for (const token of ['grid-cols-2', 'rounded-xl', 'gap-1', 'p-0.5', 'border-claude-border/70']) {
    assert.ok(tray.includes(token), `tray is missing ${token}`);
  }
  const buttonStart = markup.indexOf('data-slot="surface-switch-option"');
  const button = markup.slice(buttonStart, markup.indexOf('>', buttonStart));
  for (const token of ['h-[34px]', 'rounded-[10px]', 'text-xs', 'font-medium']) {
    assert.ok(button.includes(token), `segment is missing ${token}`);
  }
});

test('both faces land the pill + band at the same column inset, below the lights', () => {
  // The lights no longer share the band's row, so the old 64 px horizontal
  // reserve is retired: BOTH faces start the row at their own small inset.
  const hub = render('browser');
  const works = render('home');
  assert.match(hub, /data-slot="surface-header-bar"[^>]*pl-2/);
  assert.match(works, /data-slot="surface-header-bar"[^>]*pl-2/);
  // The retired prop must not survive anywhere in the source.
  assert.doesNotMatch(switchSource, /trafficLightInset/);
  assert.doesNotMatch(sidebarSource, /trafficLightInset/);
  assert.doesNotMatch(homeSidebarSource, /trafficLightInset/);
  for (const markup of [hub, works]) {
    assert.match(markup, /data-slot="surface-header-bar"[^>]*h-\[52px\]/);
    assert.match(markup, /data-slot="bot-browser-mode-segments"[^>]*h-10/);
  }
});

test('the group aria-label speaks the new face names', () => {
  const markup = render('browser');
  assert.match(markup, /role="radiogroup"[^>]*aria-label="[^"]*Studio[^"]*BotWorks"/);
  // The old hard-coded English label must be gone.
  assert.doesNotMatch(markup, /Bot Internet display mode/);
});

test('arrow keys move focus and the checked face (radiogroup keyboard contract)', () => {
  for (const token of [
    'onKeyDown',
    'ArrowRight',
    'ArrowLeft',
    'ArrowUp',
    'ArrowDown',
    'Home',
    'End',
    'tabIndex',
    'role="radiogroup"',
    'role="radio"',
  ]) {
    assert.ok(switchSource.includes(token), `switch source is missing ${token}`);
  }
});

test('the actions ride the row directly below the band', () => {
  const markup = render('browser', {
    actions: <button type="button" aria-label="new session">✎</button>,
  });
  assert.match(markup, /data-slot="surface-header-actions"/);
  const bar = markup.slice(markup.indexOf('data-slot="surface-header-bar"'));
  assert.ok(bar.indexOf('surface-header-actions') > bar.indexOf('bot-browser-mode-segments'));
  // The default action area stays compact and right-aligned; its minimum
  // height also lets Studio supply the taller task header.
  const actionsStart = markup.indexOf('data-slot="surface-header-actions"');
  const actionsRow = markup.slice(actionsStart, markup.indexOf('>', actionsStart));
  assert.match(actionsRow, /justify-end/);
  assert.match(actionsRow, /min-h-7/);
  assert.match(bar, /aria-label="new session"/);
});

test('both faces mount the SAME band; the session actions ride the row below', () => {
  // One mount per face, none in App.
  assert.equal((sidebarSource.match(/<BotBrowserModeSwitch/g) ?? []).length, 1);
  assert.equal((homeSidebarSource.match(/<BotBrowserModeSwitch/g) ?? []).length, 1);

  // Same geometry on both faces: the band rides the row BELOW the traffic-
  // light strip, with the identity pill still in the slot left of the tray.
  assert.match(sidebarSource, /data-slot="mid-column-header"[\s\S]{0,320}<BotBrowserModeSwitch/);
  assert.match(sidebarSource, /actions={surfaceHeaderActions}/);

  // The 21:31 action slots stay in the bar: new session / records on Studio.
  // On BotWorks the actions row carries the update badge ONLY since the
  // 侧栏微调批单 (2026-11-09 12:23): the collapse » toggle is gone from the
  // title row — the shell's seam tab (App's floating PanelToggleIcon) stays
  // the one collapse control — and the records SEARCH moved into the 按 Bot
  // toolbar row beside the filter/sort + archive controls.
  assert.match(sidebarSource, /data-slot="cowork-new-session"/);
  assert.match(sidebarSource, /data-slot="cowork-toggle-history"/);
  // Code form only (import / JSX usage) — prose comments naming the shell's
  // seam tab are fine and must not trip this pin.
  assert.doesNotMatch(homeSidebarSource, /(<PanelToggleIcon|import PanelToggleIcon)/);
  assert.doesNotMatch(homeSidebarSource, /onToggleCollapse/);
  assert.match(homeSidebarSource, /updateBadge/);
  // The records search has exactly ONE seat — the 按 Bot toolbar row, ahead
  // of the filter/sort (≡) and archive controls, same control class.
  assert.equal(
    (homeSidebarSource.match(/onClick=\{\(\) => \{\s*onShowCowork\(\);\s*setIsSearchOpen\(true\);\s*\}\}/g) ?? []).length,
    1,
    'the records search opens from exactly one seat',
  );
  const toolbarBlock = homeSidebarSource.slice(homeSidebarSource.indexOf('sessionViewByBot'));
  const searchSeat = toolbarBlock.indexOf("aria-label={i18nService.t('search')}");
  assert.ok(searchSeat > -1, 'the search seat is inside the 按 Bot toolbar row');
  assert.ok(searchSeat < toolbarBlock.indexOf('FilterLinesIcon'), 'search sits beside filter/sort (≡)');
  assert.ok(toolbarBlock.indexOf('FilterLinesIcon') < toolbarBlock.indexOf('ArchiveBoxIcon'), 'filter/sort (≡) precedes archive');
  // The panel keeps the records overlay but no second action row.
  assert.match(panelSource, /CoworkHistoryPanel/);
  assert.doesNotMatch(panelSource, /data-slot="cowork-panel-actions"/);
  assert.match(panelSource, /historyOpen \?\? internalShowHistory/);
});

/**
 * Owner red-box order 2026-11-09 10:58 (supersedes the 10:29 row-1 reading):
 * on macOS a 52 px traffic-light strip precedes the band row (TOP_GAP_MAC_PX
 * = 52) — the lights own row 1 alone and the identity+band row starts at the
 * strip's bottom edge; elsewhere a 12 px gap precedes it. Both platform
 * branches are pinned through the explicit `topGapPx` prop, because a Node
 * render has no window.
 */
test('macOS: a 52 px traffic-light strip precedes the band row; elsewhere 12 px', () => {
  const mac = render('home', { topGapPx: TOP_GAP_MAC_PX });
  const other = render('home', { topGapPx: TOP_GAP_DEFAULT_PX });

  assert.equal(TOP_GAP_MAC_PX, 52);
  assert.equal(TOP_GAP_DEFAULT_PX, 12);

  // macOS: the 52 px gap node is the FIRST element of the header — the lights'
  // own row, pure air, strictly above the band row.
  assert.match(mac, /data-slot="surface-header-top-gap"/);
  assert.ok(mac.includes('data-top-gap-px="52"'));
  assert.ok(mac.includes('height:52px'));
  assert.ok(
    mac.indexOf('surface-header-top-gap') < mac.indexOf('surface-header-bar'),
    'the lights strip must precede the band row',
  );
  const macGapTag = mac.slice(mac.indexOf('data-slot="surface-header-top-gap"'), mac.indexOf('>', mac.indexOf('data-slot="surface-header-top-gap"')));
  assert.doesNotMatch(macGapTag, /bot-browser-mode-segments/, 'the lights strip is pure air');
  assert.equal(mac.indexOf('surface-header-actions'), -1, 'no actions prop, no actions row');

  // Elsewhere: a 12 px gap precedes the band row.
  assert.match(other, /data-slot="surface-header-top-gap"/);
  assert.ok(other.includes('data-top-gap-px="12"'));
  assert.ok(other.includes('height:12px'));
  assert.ok(
    other.indexOf('surface-header-top-gap') < other.indexOf('surface-header-bar'),
    'the gap must precede the band row',
  );
  const gapTag = other.slice(other.indexOf('data-slot="surface-header-top-gap"'), other.indexOf('>', other.indexOf('data-slot="surface-header-top-gap"')));
  assert.doesNotMatch(gapTag, /bot-browser-mode-segments/, 'the gap is pure air');

  // The band row keeps its 52 px height and its tray.
  const macBar = mac.slice(mac.indexOf('data-slot="surface-header-bar"'));
  assert.match(macBar, /h-\[52px\]/);
});

test('the band row is a PURE band: no identity slot (identity lives in the rail, D-line final 2026-11-09)', () => {
  const markup = render('home', { topGapPx: TOP_GAP_MAC_PX });

  // No identity slot is rendered — the leading prop itself is retired.
  assert.doesNotMatch(markup, /surface-header-leading/);
  assert.doesNotMatch(switchSource, /leading\?:/);
  assert.doesNotMatch(switchSource, /surface-header-leading/);
  // The tray is the band row's content: the row renders the radiogroup only.
  const barStart = markup.indexOf('data-slot="surface-header-bar"');
  const trayStart = markup.indexOf('bot-browser-mode-segments');
  assert.ok(trayStart > barStart, 'the tray rides the band row');
});

test('neither face mounts an identity entry in the header (it lives in the rail)', () => {
  assert.doesNotMatch(sidebarSource, /UserProfileAvatarButton/);
  assert.doesNotMatch(homeSidebarSource, /UserProfileAvatarButton/);
  assert.match(sidebarSource, /import \{ UserProfilePage \} from '\.\.\/features\/userProfile';/);
  assert.match(homeSidebarSource, /import \{ UserProfilePage \} from '\.\.\/features\/userProfile';/);
});

/**
 * D-line geometry (static, not a browser measurement), owner red-box order
 * 2026-11-09 10:58: on mac the traffic lights own row 1 alone and the whole
 * identity+band row falls BELOW it —
 *   lights          = trafficLightPosition y=20, dot ≈12 px → extent ≈14–26,
 *                     strictly inside the 0–52 strip (same height as the
 *                     rail's mac top track)
 *   band row top    = TOP_GAP_MAC_PX = 52 on BOTH faces (the rail face's
 *                     lights live over the rail column's strip, so the mid
 *                     column needs the same 52 px strip above its header)
 *   home menu top   = 52 (lights strip) + 52 (band row) + 8 (row pt-2) = 112
 * The rail face's icons start at 52 + 52 + 8 = 112 px (D-line final ruling
 * 2026-11-09: below the rail's avatar slot) — an independent column, never
 * part of the header row the owner ordered down.
 */
test('mac: the band row starts below the 52 px traffic-light strip on both faces', () => {
  const railSource = readFileSync(
    new URL('../src/renderer/components/layout/WorkspaceRail.tsx', import.meta.url),
    'utf8',
  );
  const mainWindowSource = readFileSync(
    new URL('../src/main/main.ts', import.meta.url),
    'utf8',
  );

  // The rail keeps its 52 px mac strip — that strip IS the lights' row.
  assert.match(railSource, /isMac \? 'h-\[52px\]' : 'h-3'/);
  assert.match(railSource, /className="mt-2 flex min-h-0 w-full flex-1 flex-col items-center/);

  // The lights' true position: center y=20, so their extent stays inside 0–52.
  assert.match(mainWindowSource, /trafficLightPosition: \{ x: 12, y: 20 \}/);

  // The switch's mac branch: a 52 px strip precedes the band row; the row
  // keeps its 52 px height and the retired lights inset is gone.
  assert.match(switchSource, /TOP_GAP_MAC_PX = 52/);
  assert.match(switchSource, /flex h-\[52px\] w-full min-w-0 items-center gap-2 pl-2 pr-2\.5/);
  assert.doesNotMatch(switchSource, /pt-1/);
  assert.doesNotMatch(switchSource, /pl-16/);

  // Three-column final ruling 2026-11-09 (settles the inherited red left by
  // the 11:16 order): the home face's records column mounts the SAME header
  // stack via BotBrowserModeSwitch with an `actions` prop — the old merged
  // menu+actions row is gone (its task entries live in the rail), and the
  // records body starts right below the shared header wrapper with the
  // Studio face's pt-1 spacing.
  assert.match(homeSidebarSource, /<BotBrowserModeSwitch/);
  assert.match(homeSidebarSource, /actions=\{surfaceHeaderActions\}/);
  assert.match(homeSidebarSource, /data-slot="mid-column-header"/);
  assert.match(homeSidebarSource, /px-2\.5 pt-1/);
  assert.doesNotMatch(homeSidebarSource, /justify-between gap-1\.5 px-3 pt-2/);

  const lightsTop = 20 - 6;
  const lightsBottom = 20 + 6;
  const bandRowTop = 52;
  // D-line final ruling 2026-11-09: the rail column is [52 strip][52 avatar
  // slot][mt-2 8] — the first function icon starts at 112, below the avatar,
  // never in the top cell.
  const railIconTop = 52 + 52 + 8;
  const homeMenuTop = 52 + 52 + 8;
  assert.ok(lightsTop >= 0 && lightsBottom <= bandRowTop, 'lights stay inside the strip');
  assert.equal(bandRowTop, 52);
  assert.equal(railIconTop, 112);
  assert.equal(homeMenuTop, 112);
});
