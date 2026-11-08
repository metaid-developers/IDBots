import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import BotBrowserModeSwitch, { SurfaceModeMenu } from '../src/renderer/features/botBrowser/BotBrowserModeSwitch';
import { getSurfaceMenuModel } from '../src/renderer/components/sidebar/sidebarNavigation.js';
import type { BotBrowserSurfaceMode } from '../src/renderer/features/botBrowser/types';

/**
 * The surface switch became the Codex-style dropdown of the three-column
 * shell: a single-line trigger in the icon rail plus a menu whose entries each
 * carry a title and a subtitle. The old assertions pinned the two-segment
 * control this replaced.
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

test('the closed switch is ONE single-line trigger — no menu, no segments', () => {
  const markup = renderClosed('home');

  assert.match(markup, /data-slot="surface-switch-trigger"/);
  assert.match(markup, /aria-haspopup="menu"/);
  assert.match(markup, /aria-expanded="false"/);
  // Single row: one button, no two-column grid of segments.
  assert.equal((markup.match(/<button/g) ?? []).length, 1);
  assert.doesNotMatch(markup, /grid-cols-2/);
  assert.doesNotMatch(markup, /data-slot="surface-switch-menu"/);
  assert.doesNotMatch(markup, /Bot Home<\/button>/);
});

test('the trigger names the surface it is currently on', () => {
  assert.match(renderClosed('home'), /aria-label="Switch workspace: Bot Home"/);
  assert.match(renderClosed('browser'), /aria-label="Switch workspace: Bot Internet"/);
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

test('a closed menu renders nothing at all', () => {
  assert.equal(renderMenu(false, 'browser'), '');
});
