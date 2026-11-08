import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import BotBrowserModeSwitch, { SurfaceModeMenu } from '../src/renderer/features/botBrowser/BotBrowserModeSwitch';
import { getSurfaceMenuModel } from '../src/renderer/components/sidebar/sidebarNavigation.js';
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

/**
 * Owner spec 2026-11-08 21:31: the surface switcher becomes the window's
 * Codex-style header bar — three-ring mark + current surface name + chevron on
 * the left, light actions on the right — shared by BotHub (mid column) and
 * BotWorks (sidebar). The pill keeps the old accessible contract; only its
 * position inside a full-width 36 px band changed.
 */
const t = (key: string) => ({
  botInternet: 'BotHub',
  botHome: 'BotWorks',
  surfaceSwitcherLabel: 'Switch workspace',
  surfaceBotInternetSubtitle: 'Browser, Meta Apps and your Bots',
  surfaceBotHomeSubtitle: 'Tasks, long-term work and records',
}[key] ?? key);

const items = getSurfaceMenuModel({ t });

function renderClosed(mode: BotBrowserSurfaceMode, extra: { actions?: React.ReactNode; trafficLightInset?: boolean } = {}) {
  return renderToStaticMarkup(
    <BotBrowserModeSwitch
      mode={mode}
      onSelectHome={() => {}}
      onSelectBrowser={() => {}}
      {...extra}
    />,
  );
}

function renderMenu(open: boolean, mode: BotBrowserSurfaceMode) {
  return renderToStaticMarkup(
    <SurfaceModeMenu open={open} mode={mode} items={items} onSelect={() => {}} />,
  );
}

test('the closed switch is ONE pill: three-ring mark, current surface name, chevron', () => {
  const markup = renderClosed('home');

  assert.match(markup, /data-slot="surface-switch-trigger"/);
  assert.match(markup, /aria-haspopup="menu"/);
  assert.match(markup, /aria-expanded="false"/);
  // Single row: one button, no two-segment grid.
  assert.equal((markup.match(/<button/g) ?? []).length, 1);
  assert.doesNotMatch(markup, /grid-cols-2/);
  assert.doesNotMatch(markup, /data-slot="surface-switch-menu"/);
  // The house mark is the pill's leading glyph: three rings, drawn on
  // currentColor (no baked palette).
  assert.match(markup, /data-slot="surface-brand-mark"/);
  const markStart = markup.indexOf('data-slot="surface-brand-mark"');
  const mark = markup.slice(markStart, markup.indexOf('</svg>', markStart));
  assert.equal((mark.match(/<circle/g) ?? []).length, 3);
  assert.match(mark, /stroke="currentColor"/);
  assert.doesNotMatch(mark, /#[0-9a-fA-F]{3,8}\b/);
  // …and the VISIBLE text is still the current surface's name.
  assert.match(markup, /data-slot="surface-switch-current"[^>]*>BotWorks</);
});

test('the pill names the surface it is currently on, visibly and accessibly', () => {
  const home = renderClosed('home');
  assert.match(home, /aria-label="Switch workspace: BotWorks"/);
  assert.match(home, /data-slot="surface-switch-current"[^>]*>BotWorks</);

  const internet = renderClosed('browser');
  assert.match(internet, /aria-label="Switch workspace: BotHub"/);
  assert.match(internet, /data-slot="surface-switch-current"[^>]*>BotHub</);
});

test('the bar is a full-width 36 px header row with a light action slot', () => {
  const markup = renderClosed('browser', {
    actions: <button type="button" aria-label="new session">✎</button>,
  });
  assert.match(markup, /data-slot="surface-header-bar"/);
  const barStart = markup.indexOf('data-slot="surface-header-bar"');
  const bar = markup.slice(barStart, markup.indexOf('data-slot="surface-header-actions"', barStart));
  assert.match(bar, /\bh-9\b/, 'the band keeps the mid column header height');
  assert.match(bar, /\bdraggable\b/, 'the empty band stays a window drag region');
  assert.match(markup, /data-slot="surface-header-actions"/);
  assert.match(markup, /aria-label="new session"/);
  // The slot sits at the far end and is explicitly non-draggable.
  assert.match(markup, /data-slot="surface-header-actions"[^>]*non-draggable/);
});

test('only BotWorks reserves the macOS traffic lights', () => {
  const works = renderClosed('home', { trafficLightInset: true });
  assert.match(works, /data-slot="surface-header-bar"[^>]*\bpl-20\b/);

  const hub = renderClosed('browser');
  assert.match(hub, /data-slot="surface-header-bar"[^>]*px-2\.5/);
  assert.doesNotMatch(hub, /\bpl-20\b/);
});

test('the open menu lists both surfaces in order, each with its subtitle', () => {
  const markup = renderMenu(true, 'browser');

  assert.match(markup, /data-slot="surface-switch-menu"/);
  assert.match(markup, /role="menu"/);
  assert.ok(markup.indexOf('BotHub') < markup.indexOf('BotWorks'));
  assert.match(markup, /Browser, Meta Apps and your Bots/);
  assert.match(markup, /Tasks, long-term work and records/);
  const options = markup.match(/data-slot="surface-switch-option"/g) ?? [];
  assert.equal(options.length, 2);
  assert.match(markup, /data-surface="browser"/);
  assert.match(markup, /data-surface="home"/);
});

test('the current surface is the checked radio entry', () => {
  const internet = renderMenu(true, 'browser');
  assert.match(internet, /aria-checked="true"[\s\S]*?data-surface="browser"/);
  assert.match(internet, /aria-checked="false"[\s\S]*?data-surface="home"/);

  const home = renderMenu(true, 'home');
  assert.match(home, /aria-checked="true"[\s\S]*?data-surface="home"/);
  assert.match(home, /aria-checked="false"[\s\S]*?data-surface="browser"/);
});

test('the checked entry carries a ✓ — exactly one, on the current row', () => {
  const browser = renderMenu(true, 'browser');
  assert.equal((browser.match(/data-slot="surface-switch-check"/g) ?? []).length, 1);
  assert.doesNotMatch(browser, /rounded-full bg-claude-accent/);

  const browserRow = browser.slice(
    browser.indexOf('data-surface="browser"'),
    browser.indexOf('data-surface="home"'),
  );
  const homeRow = browser.slice(browser.indexOf('data-surface="home"'));
  assert.match(browserRow, /data-slot="surface-switch-check"/);
  assert.doesNotMatch(homeRow, /data-slot="surface-switch-check"/);

  const home = renderMenu(true, 'home');
  assert.equal((home.match(/data-slot="surface-switch-check"/g) ?? []).length, 1);
  assert.doesNotMatch(
    home.slice(home.indexOf('data-surface="browser"'), home.indexOf('data-surface="home"')),
    /data-slot="surface-switch-check"/,
  );
});

test('a closed menu renders nothing at all', () => {
  assert.equal(renderMenu(false, 'browser'), '');
});

test('the switcher wears this repo’s tokens, not an imported palette', () => {
  assert.doesNotMatch(switchSource, /#[0-9a-fA-F]{3,8}\b/);
  assert.doesNotMatch(switchSource, /\b(?:rgb|hsl)a?\(/);
  assert.doesNotMatch(
    switchSource,
    /\b(?:bg|text|border|ring)-(?:red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone)-\d{2,3}\b/,
  );
  for (const token of [
    'bg-claude-surface',
    'border-claude-border',
    'text-claude-text',
    'bg-claude-surfaceHover',
    'ring-claude-accent',
  ]) {
    assert.ok(switchSource.includes(token), `missing repo token ${token}`);
  }

  // Same metrics as the header's other controls: h-7 + rounded-lg on a 36 px
  // band, so the pill reads as a member of the row.
  const triggerStart = switchSource.indexOf('data-slot="surface-switch-trigger"');
  const trigger = switchSource.slice(triggerStart, switchSource.indexOf('</button>', triggerStart));
  for (const metric of ['h-7', 'rounded-lg', 'text-xs']) {
    assert.match(trigger, new RegExp(`\\b${metric}\\b`), `trigger is missing ${metric}`);
  }
  assert.match(switchSource, /data-slot="surface-header-bar"[\s\S]{0,200}\bh-9\b/);

  // The popover is anchored with the spacing scale (top-full + mt-1.5).
  assert.doesNotMatch(switchSource, /top-\[calc\(/);
  assert.match(switchSource, /top-full[\s\S]{0,80}mt-1\.5/);
});

test('both faces mount the SAME bar; the session actions live in its slot', () => {
  // One mount per face, none in App (App owns neither column).
  assert.equal((sidebarSource.match(/<BotBrowserModeSwitch/g) ?? []).length, 1);
  assert.equal((homeSidebarSource.match(/<BotBrowserModeSwitch/g) ?? []).length, 1);
  assert.match(homeSidebarSource, /trafficLightInset=\{isMac\}/);

  // BotHub's two session actions are part of the header slot now — no second
  // action row inside the panel.
  assert.match(sidebarSource, /data-slot="cowork-new-session"/);
  assert.match(sidebarSource, /data-slot="cowork-toggle-history"/);
  assert.match(sidebarSource, /browserCoworkService\.startNewDraft\(\)/);
  for (const control of ['cowork-new-session', 'cowork-toggle-history']) {
    const start = sidebarSource.indexOf(`data-slot="${control}"`);
    const controlSource = sidebarSource.slice(start, start + 900);
    assert.match(controlSource, /\bh-7\b/);
    assert.match(controlSource, /\brounded-lg\b/);
  }
});
