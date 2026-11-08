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
 * Owner ruling 2026-11-08 22:19 (supersedes the 21:31 header-bar form): the
 * switcher is the ORIGINAL IDBots segmented control — two cells in one bordered
 * tray, the current face filled with the yellow primary capsule — mounted in
 * the same place on both faces (directly below the traffic-light strip). Labels
 * are the finalized BotHub | BotWorks; interaction semantics stay aria-pressed +
 * the same two callbacks.
 */
function render(mode: BotBrowserSurfaceMode) {
  return renderToStaticMarkup(
    <BotBrowserModeSwitch
      mode={mode}
      onSelectHome={() => {}}
      onSelectBrowser={() => {}}
    />,
  );
}

test('the switch is ONE two-cell segmented control naming both faces', () => {
  const markup = render('home');

  assert.match(markup, /data-slot="bot-browser-mode-bar"/);
  assert.match(markup, /data-slot="bot-browser-mode-segments"/);
  assert.match(markup, /role="group"/);
  // Exactly two buttons — the two surfaces, in order, text only.
  assert.equal((markup.match(/<button/g) ?? []).length, 2);
  const options = markup.match(/data-slot="surface-switch-option"/g) ?? [];
  assert.equal(options.length, 2);
  assert.ok(markup.indexOf('BotHub') < markup.indexOf('BotWorks'));
  assert.match(markup, /data-surface="browser"/);
  assert.match(markup, /data-surface="home"/);
  // No header-bar residue: no logo, no chevron menu, no standalone trigger.
  assert.doesNotMatch(markup, /surface-brand-mark/);
  assert.doesNotMatch(markup, /surface-switch-trigger/);
  assert.doesNotMatch(markup, /surface-switch-menu/);
});

test('the current face is the pressed, yellow-filled cell', () => {
  const home = render('home');
  assert.match(home, /data-surface="home"[^>]*aria-pressed="true"/);
  assert.match(home, /data-surface="browser"[^>]*aria-pressed="false"/);

  const start = home.indexOf('data-surface="home"');
  const homeButton = home.slice(start, home.indexOf('</button>', start));
  assert.match(homeButton, /btn-idchat-primary-filled/);
  assert.match(homeButton, /\bstill\b/);

  const browserStart = home.indexOf('data-surface="browser"');
  const browserButton = home.slice(browserStart, home.indexOf('</button>', browserStart));
  assert.match(browserButton, /text-claude-textSecondary/);
  assert.doesNotMatch(browserButton, /btn-idchat-primary-filled/);

  // Flipping the mode moves the fill, never duplicates it.
  const browser = render('browser');
  assert.match(browser, /data-surface="browser"[^>]*aria-pressed="true"/);
  assert.match(browser, /data-surface="home"[^>]*aria-pressed="false"/);
  assert.equal((browser.match(/btn-idchat-primary-filled/g) ?? []).length, 1);
});

test('the tray keeps the baseline segmented grammar', () => {
  const markup = render('browser');
  const trayStart = markup.indexOf('data-slot="bot-browser-mode-segments"');
  const tray = markup.slice(trayStart, markup.indexOf('</div>', trayStart));
  for (const token of ['grid-cols-2', 'rounded-lg', 'gap-1', 'p-1', 'border-claude-border/70']) {
    assert.ok(tray.includes(token), `tray is missing ${token}`);
  }
  const buttonStart = markup.indexOf('data-slot="surface-switch-option"');
  const button = markup.slice(buttonStart, markup.indexOf('</button>', buttonStart));
  for (const token of ['h-8', 'rounded-md', 'text-xs', 'font-medium']) {
    assert.ok(button.includes(token), `segment is missing ${token}`);
  }
});

test('the group aria-label speaks the new face names', () => {
  const markup = render('browser');
  assert.match(markup, /role="group"[^>]*aria-label="[^"]*BotHub[^"]*BotWorks"/);
  // The old hard-coded English label must be gone.
  assert.doesNotMatch(markup, /Bot Internet display mode/);
});

test('the switch wears this repo’s tokens, not an imported palette', () => {
  assert.doesNotMatch(switchSource, /#[0-9a-fA-F]{3,8}\b/);
  assert.doesNotMatch(switchSource, /\b(?:rgb|hsl)a?\(/);
  assert.doesNotMatch(
    switchSource,
    /\b(?:bg|text|border|ring)-(?:red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone)-\d{2,3}\b/,
  );
  for (const token of [
    'bg-claude-bg',
    'border-claude-border',
    'text-claude-textSecondary',
    'ring-claude-accent',
    'btn-idchat-primary-filled',
  ]) {
    assert.ok(switchSource.includes(token), `missing repo token ${token}`);
  }
});

test('both faces mount the SAME switch; the session actions return to the panel', () => {
  // One mount per face, none in App.
  assert.equal((sidebarSource.match(/<BotBrowserModeSwitch/g) ?? []).length, 1);
  assert.equal((homeSidebarSource.match(/<BotBrowserModeSwitch/g) ?? []).length, 1);

  // Same position on both faces: below the traffic-light strip. BotWorks uses
  // the baseline drag header + mt-3 slot; BotHub reserves the same 52/56 px
  // above its switcher slot.
  assert.match(homeSidebarSource, /draggable sidebar-header-drag h-8 flex items-center px-3/);
  assert.match(homeSidebarSource, /className="mt-3 px-3"[\s\S]{0,120}<BotBrowserModeSwitch/);
  assert.match(sidebarSource, /data-slot="mid-column-header"[\s\S]*?data-slot="surface-switcher-slot"[\s\S]{0,160}<BotBrowserModeSwitch/);

  // The 21:31 header-bar action slot is gone; new session / records live in the
  // session window's own action row again, with the same service call.
  assert.doesNotMatch(sidebarSource, /data-slot="cowork-new-session"/);
  assert.doesNotMatch(sidebarSource, /data-slot="cowork-toggle-history"/);
  assert.match(panelSource, /data-slot="cowork-panel-actions"/);
  assert.match(panelSource, /browserCoworkService\.startNewDraft\(\)/);
  assert.match(panelSource, /botBrowserCoworkNew/);
  assert.match(panelSource, /botBrowserCoworkHistory/);
  // …and the records panel restyle is untouched by this switch rework.
  assert.match(panelSource, /CoworkHistoryPanel/);
});
