import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import BotBrowserModeSwitch, {
  TOP_GAP_DEFAULT_PX,
  TOP_GAP_MAC_PX,
  TOP_GAP_WINDOWS_PX,
} from '../src/renderer/features/botBrowser/BotBrowserModeSwitch';
import MacWindowLights, {
  MAC_LIGHT_DOT_COLORS,
  MAC_LIGHT_DOT_GAP_PX,
  MAC_LIGHT_DOT_PX,
  MAC_LIGHT_INSET_PX,
} from '../src/renderer/features/botBrowser/MacWindowLights';
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
const lightsSource = readFileSync(
  new URL('../src/renderer/features/botBrowser/MacWindowLights.tsx', import.meta.url),
  'utf8',
);

/**
 * Owner red-box order 2026-11-09 10:58 (supersedes the 10:29 row-1 reading),
 * amended by the D-line final ruling 2026-11-09: row 1 = the traffic lights
 * ALONE (a 42.375 px strip on macOS); row 2 = the two-cell segmented band ALONE,
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
  // v2 rect-flat (owner ruling 2026-11-14): the selected face is a FLAT fill —
  // the old 3 px grey offset edge is retired, so depth is border + colour only.
  assert.doesNotMatch(homeButton, /shadow-\[/);
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

test('the tray keeps the rect-flat segmented grammar (v2, owner ruling 2026-11-14)', () => {
  const markup = render('browser');
  const trayStart = markup.indexOf('data-slot="bot-browser-mode-segments"');
  const tray = markup.slice(trayStart, markup.indexOf('>', trayStart));
  for (const token of ['grid-cols-2', 'rounded-[var(--shape-radius-lg)]', 'gap-0', 'overflow-hidden', 'border-claude-border/70']) {
    assert.ok(tray.includes(token), `tray is missing ${token}`);
  }
  // The capsule grammar is retired: no pill radius, no gutter between cells.
  assert.ok(!tray.includes('rounded-xl'), 'the tray must not carry the retired capsule radius');
  assert.ok(!tray.split(' ').includes('gap-1'), 'the cells sit flush (gap-0), not on a gutter');
  // The fill must meet the border (reference .seg has no tray padding). An
  // inset fill read as two tiles pasted inside a rounded frame — owner rejected.
  assert.ok(!tray.split(' ').includes('p-0.5'), 'the tray has no inner padding; the fill meets the 1px border');

  const firstStart = markup.indexOf('data-slot="surface-switch-option"');
  const first = markup.slice(firstStart, markup.indexOf('>', firstStart));
  const secondStart = markup.indexOf('data-slot="surface-switch-option"', firstStart + 1);
  const second = markup.slice(secondStart, markup.indexOf('>', secondStart));
  for (const token of ['h-full', 'text-xs', 'font-medium', 'transition-colors']) {
    assert.ok(first.includes(token), `segment is missing ${token}`);
  }
  // The cell itself is square and flat — the tray owns the only radius.
  for (const segment of [first, second]) {
    assert.ok(!segment.includes('rounded-[10px]'), 'the per-cell radius is retired');
    assert.ok(!segment.includes('shadow-[3px'), 'the offset hard shadow is retired');
    assert.ok(!segment.includes('transition-all'), 'colour-only transition, no layout tween');
    // No divider between the cells at all (owner ruling 2026-11-14): the two
    // cells are one surface, split by fill alone.
    assert.ok(!/\bborder-l\b/.test(segment), 'no seam divider — the split is fill only');
  }
});

test('the shape tokens the tray depends on exist in the theme block', () => {
  const css = readFileSync(new URL('../src/renderer/index.css', import.meta.url), 'utf8');
  const rootBlock = css.slice(css.indexOf(':root {'), css.indexOf('.dark {'));
  for (const [token, value] of [
    ['--shape-radius-lg', '8px'],
    ['--shape-radius-md', '10px'],
    ['--shape-radius-sm', '8px'],
    ['--shape-radius-xs', '4px'],
  ] as const) {
    assert.match(
      rootBlock,
      new RegExp(`${token}:\\s*${value};`),
      `theme block is missing ${token}: ${value}`,
    );
  }
  // The rect-flat ruling is recorded where the tokens live.
  assert.match(rootBlock, /rect-flat/);
  assert.match(rootBlock, /owner ruling 2026-11-14/);
  assert.match(rootBlock, /no capsules, no offset shadows/i);
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
 * Owner baseline order 2026-11-15 08:27 (supersedes the 11-09 10:58 y=45
 * tabstrip baseline): on macOS a 42.375 px traffic-light strip precedes the
 * band row (TOP_GAP_MAC_PX = 42.375) — the lights own row 1 alone and the
 * identity+band row starts at the strip's bottom edge, with the strip sized
 * so the tray's VISIBLE top border lands on the bot-home panel's header
 * divider (y=50.625); elsewhere a 12 px gap precedes it. Windows + browser
 * face is the third tier (TOP_GAP_WINDOWS_PX = 36, the right column's h-9
 * Windows title-bar strip, owner alignment ruling 2026-11-17); its
 * mode-aware parse is pinned at source level because a Node render has no
 * window, so the render-level branches are pinned through the explicit
 * `topGapPx` prop.
 */
test('macOS: a 42.375 px traffic-light strip precedes the band row; elsewhere 12 px', () => {
  const mac = render('home', { topGapPx: TOP_GAP_MAC_PX });
  const other = render('home', { topGapPx: TOP_GAP_DEFAULT_PX });

  assert.equal(TOP_GAP_MAC_PX, 42.375);
  assert.equal(TOP_GAP_DEFAULT_PX, 12);

  // Windows tier: TOP_GAP_WINDOWS_PX = 36, and the parse is mode-aware —
  // win32 resolves to WINDOWS only on the browser face (the right column's
  // 36 px h-9 strip exists only while that pane is visible); win32 + any
  // other face falls back to DEFAULT. A Node render has no window, so the
  // gate itself is pinned at source level; the constant renders through the
  // same explicit-prop path the other two tiers are pinned with.
  assert.equal(TOP_GAP_WINDOWS_PX, 36);
  assert.match(
    switchSource,
    /if \(window\.electron\?\.platform === 'win32' && mode === 'browser'\) return TOP_GAP_WINDOWS_PX;/,
  );
  const windows = render('home', { topGapPx: TOP_GAP_WINDOWS_PX });
  assert.ok(windows.includes('data-top-gap-px="36"'));
  assert.ok(windows.includes('height:36px'));

  // macOS: the 42.375 px gap node is the FIRST element of the header — the
  // lights' own row, strictly above the band row (tray top edge lands on the
  // bot-home divider y=50.625, owner baseline 2026-11-15 08:27). The strip
  // mounts the self-drawn MacWindowLights (main.ts hides the native buttons;
  // in a Node render the platform probe is undefined so the component itself
  // renders null — the marker check below is a source-level guard).
  assert.match(mac, /data-slot="surface-header-top-gap"/);
  assert.ok(mac.includes('data-top-gap-px="42.375"'));
  assert.ok(mac.includes('height:42.375px'));
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
 * 2026-11-09 10:58, amended by the owner baseline 2026-11-15 08:27: on mac
 * the traffic lights own row 1 alone and the whole identity+band row falls
 * BELOW it —
 *   lights          = MacWindowLights: 10 px dots at pt-[7.25px] in the
 *                     strip -> extent 7.25-17.25 (center 12.25), strictly
 *                     inside the 0-42.375 strip, never touching the band row
 *   band row top    = TOP_GAP_MAC_PX = 42.375 on BOTH faces (the strip is
 *                     sized so the tray's VISIBLE top border lands on the
 *                     bot-home panel's header divider y=50.625, owner
 *                     baseline 2026-11-15 08:27; the rail face needs the
 *                     same strip for the shared avatar/labels centerline)
 *   home menu top   = 42.375 (lights strip) + 52 (band row) + 8 (row pt-2)
 *                     = 102.375
 * The rail face's icons start at 42.375 + 52 + 8 = 102.375 px (D-line final
 * ruling 2026-11-09: below the rail's avatar slot; height amended by the
 * 08:27 baseline change) — an independent column, never part of the header
 * row the owner ordered down.
 */
test('mac: the band row starts below the 42.375 px traffic-light strip on both faces', () => {
  const railSource = readFileSync(
    new URL('../src/renderer/components/layout/WorkspaceRail.tsx', import.meta.url),
    'utf8',
  );
  const mainWindowSource = readFileSync(
    new URL('../src/main/main.ts', import.meta.url),
    'utf8',
  );

  // The rail keeps its 42.375 px mac strip — that strip IS the lights' row,
  // kept in lockstep with the switch's TOP_GAP_MAC_PX (baseline change
  // 2026-11-15 08:27) so the avatar's centerline rides the band labels'.
  // (win32 + browser face rides the third tier, 36 px = h-9 — owner
  // alignment ruling 2026-11-17.)
  assert.match(railSource, /isMac \? 'h-\[42\.375px\]' : isWindowsBrowserFace \? 'h-9' : 'h-3'/);
  assert.match(railSource, /className="mt-2 flex min-h-0 w-full flex-1 flex-col items-center/);

  // The lights' true position: pt-[7.25px] inside the 42.375 px strip
  // (extent 7.25–17.25), so they stay strictly above the band row.
  // SUPERSEDED (mini-lights ruling 2026-11-14, owner): the native lights
  // are gone — main.ts drops the darwin branch to the plain hidden style,
  // retires the reposition option, and removes the native buttons after
  // creation; the renderer's MacWindowLights owns the strip instead. The
  // non-darwin branches are pinned UNCHANGED (behavior frozen there).
  const winCreateIdx = mainWindowSource.indexOf('const win = new BrowserWindow({');
  const darwinBranch = mainWindowSource.slice(
    mainWindowSource.indexOf('...(isMac', winCreateIdx),
    mainWindowSource.indexOf(': isWindows', winCreateIdx),
  );
  assert.match(darwinBranch, /titleBarStyle: 'hidden' as const/);
  assert.doesNotMatch(mainWindowSource, /titleBarStyle: 'hiddenInset'/);
  assert.doesNotMatch(mainWindowSource, /trafficLightPosition: \{/);
  // Hotfix eb3c579f shape: creation-time hide + ready-to-show re-apply
  // (macOS re-shows native buttons when a still-hidden window first shows).
  assert.match(mainWindowSource, /const hideNativeLights = \(\) => \{/);
  assert.match(mainWindowSource, /win\.setWindowButtonVisibility\(false\);/);
  assert.match(mainWindowSource, /win\.once\('ready-to-show', hideNativeLights\);/);
  assert.match(mainWindowSource, /frame: false,/);
  assert.match(mainWindowSource, /titleBarOverlay: getTitleBarOverlayOptions\(\)/);
  // The drawn dots mount in the top-gap strip: 10 px, pt-[7.25px] -> extent
  // 7.25-17.25 inside the 0-42.375 strip.
  assert.match(switchSource, /<MacWindowLights \/>/);

  // The switch's mac branch: a 42.375 px strip precedes the band row; the row
  // keeps its 52 px height and the retired lights inset is gone.
  assert.match(switchSource, /TOP_GAP_MAC_PX = 42\.375/);
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

  const lightsTop = 7.25; // MacWindowLights: 10 px dot, pt-[7.25px] in the gap strip
  const lightsBottom = 7.25 + 10;
  const bandRowTop = 42.375;
  // D-line final ruling 2026-11-09, height amended by the baseline change
  // 2026-11-15 08:27: the rail column is [42.375 strip][52 avatar slot][mt-2 8] —
  // the first function icon starts at 102.375, below the avatar, never in the
  // top cell.
  const railIconTop = 42.375 + 52 + 8;
  const homeMenuTop = 42.375 + 52 + 8;
  assert.ok(lightsTop >= 0 && lightsBottom <= bandRowTop, 'lights stay inside the strip');
  assert.equal(bandRowTop, 42.375);
  assert.equal(railIconTop, 102.375);
  assert.equal(homeMenuTop, 102.375);
});


test('mac mini lights: three 10px dots, close | minimize | zoom, drag container, IPC wiring', () => {
  // Sizes are px literals — the app root font is 15px, so rem-scaled classes
  // drift (exact-fill arithmetic must stay in px; shape-language v2).
  assert.match(lightsSource, /MAC_LIGHT_DOT_PX = 10/);
  assert.match(lightsSource, /MAC_LIGHT_DOT_GAP_PX = 10/);
  assert.match(lightsSource, /MAC_LIGHT_INSET_PX = 15/);
  assert.match(lightsSource, /className="draggable flex items-center pt-\[7\.25px\] pl-\[15px\] gap-\[10px\]"/);
  assert.match(lightsSource, /non-draggable h-\[10px\] w-\[10px\] rounded-full/);
  // The three actions ride the EXISTING window-control bridge: preload
  // window.close / window.minimize / window.toggleMaximize -> send channels
  // window-close / window-minimize / window-maximize -> ipcMain.on handlers.
  assert.match(lightsSource, /window\.electron\.window\.close\(\)/);
  assert.match(lightsSource, /window\.electron\.window\.minimize\(\)/);
  assert.match(lightsSource, /window\.electron\.window\.toggleMaximize\(\)/);
  const closeIdx = lightsSource.indexOf("action: 'close'");
  const minIdx = lightsSource.indexOf("action: 'minimize'");
  const zoomIdx = lightsSource.indexOf("action: 'zoom'");
  assert.ok(closeIdx >= 0 && closeIdx < minIdx && minIdx < zoomIdx, 'dots run close, minimize, zoom');

  const mac = renderToStaticMarkup(<MacWindowLights platform="darwin" />);
  assert.equal((mac.match(/<button /g) ?? []).length, 3);
  assert.ok(
    mac.indexOf('data-window-action="close"') < mac.indexOf('data-window-action="minimize"')
      && mac.indexOf('data-window-action="minimize"') < mac.indexOf('data-window-action="zoom"'),
    'markup order: close, minimize, zoom',
  );
  assert.match(mac, /data-window-action="close"[^>]*aria-label="Close"/);
  assert.match(mac, /data-window-action="minimize"[^>]*aria-label="Minimize"/);
  assert.match(mac, /data-window-action="zoom"[^>]*aria-label="Zoom"/);
  assert.match(mac, /h-\[10px\] w-\[10px\]/);
  assert.match(mac, /pl-\[15px\] gap-\[10px\]/);
  assert.match(mac, /draggable flex items-center/);
  assert.match(mac, /non-draggable h-\[10px\]/);
  for (const color of Object.values(MAC_LIGHT_DOT_COLORS)) {
    assert.ok(mac.includes(color), `dot color ${color} rides the inline style`);
  }
  assert.equal(MAC_LIGHT_DOT_PX, 10);
  assert.equal(MAC_LIGHT_DOT_GAP_PX, 10);
  assert.equal(MAC_LIGHT_INSET_PX, 15);
});

test('mac mini lights render NOTHING off darwin (win32 / linux / Node renders)', () => {
  assert.equal(renderToStaticMarkup(<MacWindowLights platform="win32" />), '');
  assert.equal(renderToStaticMarkup(<MacWindowLights platform="linux" />), '');
  assert.equal(renderToStaticMarkup(<MacWindowLights />), '', 'no prop + no window (Node) renders nothing');
});

test('the drawn lights ride the top-gap strip, centered in the window-top → tray-top gap (both faces)', () => {
  const gapStart = switchSource.indexOf('data-slot="surface-header-top-gap"');
  const gapEnd = switchSource.indexOf('data-slot="surface-header-bar"', gapStart);
  assert.ok(gapEnd > gapStart, 'band-row anchor found');
  const gapSlice = switchSource.slice(gapStart, gapEnd);
  assert.ok(gapSlice.includes('<MacWindowLights />'), 'lights mount inside the gap strip');
  assert.match(lightsSource, /pt-\[7\.25px\]/, 'the dots ride the gap-center offset (tray-top/2)');
});
