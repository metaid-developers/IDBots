import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import BotBrowserModeSwitch from '../src/renderer/features/botBrowser/BotBrowserModeSwitch';
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
 * Owner ruling 2026-11-08 22:26 (supersedes the 22:19 "second row" reading):
 * the surface switcher is the long two-cell segmented band on the window's TOP
 * track, to the RIGHT of the traffic-light dots — the same geometry on both
 * faces. Two text cells, yellow fill on the current face, no mark / no chevron
 * / no menu; radiogroup + radio semantics and arrow-key movement. The header's
 * light actions ride the row directly below the band.
 */
function render(
  mode: BotBrowserSurfaceMode,
  extra: { actions?: React.ReactNode; trafficLightInset?: boolean } = {},
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
  assert.ok(markup.indexOf('BotHub') < markup.indexOf('BotWorks'));
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

test('both faces land the band on the same absolute left edge', () => {
  // BotHub: 64 px rail + 16 px inset = 80 px. BotWorks: 80 px traffic-light
  // safe area. Same top (6 px inside the 52 px row) and same 40 px height.
  const hub = render('browser');
  const works = render('home', { trafficLightInset: true });
  assert.match(hub, /data-slot="surface-header-bar"[^>]*pl-4/);
  assert.match(works, /data-slot="surface-header-bar"[^>]*pl-20/);
  for (const markup of [hub, works]) {
    assert.match(markup, /data-slot="surface-header-bar"[^>]*h-\[52px\]/);
    assert.match(markup, /data-slot="bot-browser-mode-segments"[^>]*h-10/);
  }
});

test('the group aria-label speaks the new face names', () => {
  const markup = render('browser');
  assert.match(markup, /role="radiogroup"[^>]*aria-label="[^"]*BotHub[^"]*BotWorks"/);
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
  // The action row is its own row (after the 52 px band row), right-aligned.
  const actionsStart = markup.indexOf('data-slot="surface-header-actions"');
  const actionsRow = markup.slice(actionsStart, markup.indexOf('>', actionsStart));
  assert.match(actionsRow, /justify-end/);
  assert.match(actionsRow, /h-7/);
  assert.match(bar, /aria-label="new session"/);
});

test('both faces mount the SAME band; the session actions ride the row below', () => {
  // One mount per face, none in App.
  assert.equal((sidebarSource.match(/<BotBrowserModeSwitch/g) ?? []).length, 1);
  assert.equal((homeSidebarSource.match(/<BotBrowserModeSwitch/g) ?? []).length, 1);

  // Same geometry on both faces: the band rides the TOP track, to the right of
  // the traffic lights on BotWorks and at the top of the mid column on BotHub.
  assert.match(homeSidebarSource, /trafficLightInset={isMac}/);
  assert.match(homeSidebarSource, /<BotBrowserModeSwitch[\s\S]{0,220}trafficLightInset={isMac}/);
  assert.match(sidebarSource, /data-slot="mid-column-header"[\s\S]{0,320}<BotBrowserModeSwitch/);
  assert.match(sidebarSource, /actions={surfaceHeaderActions}/);

  // The 21:31 action slots stay in the bar: new session / records on BotHub,
  // collapse + update badge on BotWorks.
  assert.match(sidebarSource, /data-slot="cowork-new-session"/);
  assert.match(sidebarSource, /data-slot="cowork-toggle-history"/);
  assert.match(homeSidebarSource, /onToggleCollapse/);
  assert.match(homeSidebarSource, /updateBadge/);
  // The panel keeps the records overlay but no second action row.
  assert.match(panelSource, /CoworkHistoryPanel/);
  assert.doesNotMatch(panelSource, /data-slot="cowork-panel-actions"/);
  assert.match(panelSource, /historyOpen \?\? internalShowHistory/);
});
