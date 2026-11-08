import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getHomeSectionModel,
  getRailHomeNavModel,
  getRailInternetNavModel,
  getSurfaceMenuModel,
  isBotBrowserPaneVisible,
} from '../src/renderer/components/sidebar/sidebarNavigation.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const t = (key) => key;

/** The 长期任务 rail entry — the one that carries the attention dot. */
const longTermItem = (params) =>
  getRailHomeNavModel({ t, ...params }).find((item) => item.id === 'longTerm');

test('Bot Home rail keeps the four destinations in order: new task, long-term, group tasks, records', () => {
  const ids = getRailHomeNavModel({ t, hasRunningScheduledTask: false })
    .filter((item) => !item.hidden)
    .map((item) => item.id);

  assert.deepEqual(ids, ['newTask', 'longTerm', 'groupTasks', 'records']);
  const items = getRailHomeNavModel({ t, hasRunningScheduledTask: false });
  assert.equal(items[0].icon, 'compose');
  assert.equal(items[1].icon, 'clock');
  assert.equal(items[2].icon, 'userGroup');
  assert.equal(items[3].icon, 'archive');
  // Every rail entry is an icon + a tooltip label — no text row survives.
  for (const item of items) {
    assert.equal(typeof item.label, 'string');
    assert.ok(item.label.length > 0);
  }
});

test('the 长期任务 rail entry carries no dot by default, an amber running dot while a task runs', () => {
  const idle = longTermItem({ hasRunningScheduledTask: false, needsDecisionCount: 0 });
  assert.equal(idle.hasIndicator, false);
  assert.equal(idle.indicatorKind, undefined);
  assert.equal(idle.indicatorLabel, undefined);

  const running = longTermItem({ hasRunningScheduledTask: true, needsDecisionCount: 0 });
  assert.equal(running.hasIndicator, true);
  assert.equal(running.indicatorKind, 'running', 'no owner decision pending: the plain running dot');
  assert.equal(running.indicatorLabel, undefined, 'the running dot stays unlabelled (historic behaviour)');
});

test('a pending owner decision lights the 长期任务 dot with its own count label, and outranks "running"', () => {
  const decision = longTermItem({ hasRunningScheduledTask: false, needsDecisionCount: 2 });
  assert.equal(decision.hasIndicator, true);
  assert.equal(decision.indicatorKind, 'decision');
  assert.equal(decision.indicatorLabel, 'trackedTaskNeedsDecision', 'the label key carries the count placeholder');

  const both = longTermItem({ hasRunningScheduledTask: true, needsDecisionCount: 1 });
  assert.equal(both.indicatorKind, 'decision', 'the owner decision wins over a running task');
  assert.equal(both.hasIndicator, true);

  // Garbage counts must not light the dot.
  for (const needsDecisionCount of [0, -3, undefined, null, NaN]) {
    assert.equal(
      longTermItem({ hasRunningScheduledTask: false, needsDecisionCount }).hasIndicator,
      false,
      `needsDecisionCount=${String(needsDecisionCount)} keeps the dot off`,
    );
  }
});

test('Bot Internet rail lists browser, hidden Bot Hub, Meta Apps, My Bots and the Co-Work destination', () => {
  const items = getRailInternetNavModel({ t });

  assert.deepEqual(items.map((item) => item.id), ['browser', 'gigSquare', 'metaapps', 'myBots', 'cowork']);
  assert.equal(items[0].icon, 'globe');
  assert.equal(items[1].icon, 'shoppingBag');
  assert.equal(items[1].badge, 'gigSquareAlphaBadge');
  assert.equal(items[2].icon, 'squares2x2');
  assert.equal(items[3].label, 'metabots');
  assert.equal(items[3].icon, 'cpuChip');
  assert.equal(items[4].label, 'botBrowserCoworkTitle', 'the Co-Work rail entry reuses the existing i18n label');
  assert.equal(items[4].icon, 'chatBubbles');

  // Bot Hub is not a promoted column for now: its entry stays implemented but
  // hidden, so the rail lists Bot Browser, Meta Apps, My Bots and Co-Work.
  assert.equal(items[1].hidden, true);
  assert.deepEqual(
    items.filter((item) => !item.hidden).map((item) => item.id),
    ['browser', 'metaapps', 'myBots', 'cowork'],
  );
});

test('the surface menu is the Codex-style pair: Bot Internet first, each entry carrying its subtitle', () => {
  const items = getSurfaceMenuModel({ t });

  assert.deepEqual(items, [
    { id: 'browser', label: 'botInternet', subtitle: 'surfaceBotInternetSubtitle' },
    { id: 'home', label: 'botHome', subtitle: 'surfaceBotHomeSubtitle' },
  ]);
});

test('the Bot Home middle column keeps exactly three list sections', () => {
  assert.deepEqual(
    getHomeSectionModel({ t }).map((section) => section.id),
    ['longTerm', 'groupTasks', 'records'],
  );
});

test('Bot Browser pane stays the visible internet destination only when selected', () => {
  assert.equal(isBotBrowserPaneVisible('browser', 'browser'), true);
  assert.equal(isBotBrowserPaneVisible('browser', 'gigSquare'), false);
  assert.equal(isBotBrowserPaneVisible('browser', 'metaapps'), false);
  assert.equal(isBotBrowserPaneVisible('browser', 'cowork'), false, 'the Co-Work destination hides the browser pane');
  assert.equal(isBotBrowserPaneVisible('home', 'browser'), false);
});

test('App keeps the Bot Browser surface mounted and only toggles visibility', () => {
  const src = fs.readFileSync(path.join(root, 'src/renderer/App.tsx'), 'utf8');
  assert.match(src, /hasMountedBrowser \? \(/);
  assert.match(src, /isBrowserPaneVisible \? 'relative flex flex-1 min-w-0 flex-col' : 'hidden'/);
  assert.match(src, /visible=\{botBrowserShell\.isBrowserPaneVisible\}/);
});

test('opening a Bot Browser URI selects the browser pane inside Bot Internet', () => {
  const src = fs.readFileSync(path.join(root, 'src/renderer/features/botBrowser/useBotBrowserShell.ts'), 'utf8');
  assert.match(src, /const showBrowser[\s\S]*setInternetPane\('browser'\)/);
  assert.match(src, /const openBrowserHome[\s\S]*setInternetPane\('browser'\)/);
  assert.match(src, /const controlTabs[\s\S]*setInternetPane\('browser'\)/);
});

test('Bot Internet keeps the Co-Work panel visible for Hub and Meta Apps', () => {
  const src = fs.readFileSync(path.join(root, 'src/renderer/components/Sidebar.tsx'), 'utf8');
  const internetBranch = src.slice(src.indexOf("mode === 'home'"));
  assert.match(internetBranch, /<BotBrowserCoworkPanel\s+onShowSkills=\{onShowSkills\}/);
  assert.doesNotMatch(internetBranch, /internetPane === 'browser'/);
  assert.doesNotMatch(internetBranch, /internetPane !== 'browser'/);
});
