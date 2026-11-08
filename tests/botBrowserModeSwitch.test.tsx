import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import BotBrowserModeSwitch, { SurfaceModeMenu } from '../src/renderer/features/botBrowser/BotBrowserModeSwitch';
import { getSurfaceMenuModel } from '../src/renderer/components/sidebar/sidebarNavigation.js';
import type { BotBrowserSurfaceMode } from '../src/renderer/features/botBrowser/types';

/**
 * The surface switch became the middle column header's Codex-style capsule
 * (owner ruling 2026-11-08 14:15). It used to be an icon-only trigger in the
 * 64 px rail; a rail cannot hold a NAME, so the trigger is now a white capsule
 * reading the current surface plus a chevron, and the menu hangs BELOW it with
 * both surfaces, each with its subtitle, the current one checked with a ✓.
 *
 * The old assertions pinned the two-segment control this replaced; the rail-era
 * ones pinned an icon-only trigger that no longer exists.
 */
const t = (key: string) => ({
  botInternet: 'Bot Internet',
  botHome: 'Bot Home',
  surfaceSwitcherLabel: 'Switch workspace',
  surfaceBotInternetSubtitle: 'Browser, Meta Apps and your Bots',
  surfaceBotHomeSubtitle: 'Tasks, long-term work and records',
}[key] ?? key);

const items = getSurfaceMenuModel({ t });

function renderClosed(mode: BotBrowserSurfaceMode) {
  return renderToStaticMarkup(
    <BotBrowserModeSwitch
      mode={mode}
      onSelectHome={() => {}}
      onSelectBrowser={() => {}}
    />,
  );
}

function renderMenu(open: boolean, mode: BotBrowserSurfaceMode) {
  return renderToStaticMarkup(
    <SurfaceModeMenu open={open} mode={mode} items={items} onSelect={() => {}} />,
  );
}

test('the closed switch is ONE capsule that names the current surface', () => {
  const markup = renderClosed('home');

  assert.match(markup, /data-slot="surface-switch-trigger"/);
  assert.match(markup, /aria-haspopup="menu"/);
  assert.match(markup, /aria-expanded="false"/);
  // Single row: one button, no two-column grid of segments.
  assert.equal((markup.match(/<button/g) ?? []).length, 1);
  assert.doesNotMatch(markup, /grid-cols-2/);
  assert.doesNotMatch(markup, /data-slot="surface-switch-menu"/);
  // The VISIBLE text is the current surface's name — the thing the rail's
  // icon-only trigger could not show, and the reason the switch moved.
  assert.match(markup, /data-slot="surface-switch-current"[^>]*>Bot Home</);
});

test('the trigger names the surface it is currently on, visibly and accessibly', () => {
  const home = renderClosed('home');
  assert.match(home, /aria-label="Switch workspace: Bot Home"/);
  assert.match(home, /data-slot="surface-switch-current"[^>]*>Bot Home</);

  const internet = renderClosed('browser');
  assert.match(internet, /aria-label="Switch workspace: Bot Internet"/);
  assert.match(internet, /data-slot="surface-switch-current"[^>]*>Bot Internet</);
});

test('the open menu lists both surfaces in order, each with its subtitle', () => {
  const markup = renderMenu(true, 'browser');

  assert.match(markup, /data-slot="surface-switch-menu"/);
  assert.match(markup, /role="menu"/);
  assert.ok(markup.indexOf('Bot Internet') < markup.indexOf('Bot Home'));
  // Subtitles ride the same entries (the "副标语" of the Codex-style menu).
  assert.match(markup, /Browser, Meta Apps and your Bots/);
  assert.match(markup, /Tasks, long-term work and records/);
  // Two options, each a menuitemradio carrying its surface id.
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
  // The old active marker was a dot; it must be gone, not sitting next to the ✓.
  assert.doesNotMatch(browser, /rounded-full bg-claude-accent/);

  const browserRow = browser.slice(
    browser.indexOf('data-surface="browser"'),
    browser.indexOf('data-surface="home"'),
  );
  const homeRow = browser.slice(browser.indexOf('data-surface="home"'));
  assert.match(browserRow, /data-slot="surface-switch-check"/);
  assert.doesNotMatch(homeRow, /data-slot="surface-switch-check"/);

  // Flipping the surface moves the ✓ rather than adding a second one.
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
