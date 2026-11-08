import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getSidebarInternetNavModel,
  getSidebarPrimaryNavModel,
  isBotBrowserPaneVisible,
} from '../src/renderer/components/sidebar/sidebarNavigation.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const t = (key) => key;

/** The 跟踪任务 entry of the Bot Home nav model. */
const trackedTasksItem = (params) =>
  getSidebarPrimaryNavModel({ t, ...params }).find((item) => item.id === 'scheduledTasks');

test('Bot Home primary nav keeps tasks; My Bots has moved to the Bot Internet side', () => {
  const ids = getSidebarPrimaryNavModel({ t, hasRunningScheduledTask: false })
    .filter((item) => !item.hidden)
    .map((item) => item.id);

  assert.deepEqual(ids, ['scheduledTasks', 'groupTasks']);
});

test('the 跟踪任务 entry carries no dot by default, an amber running dot while a task runs', () => {
  const idle = trackedTasksItem({ hasRunningScheduledTask: false, needsDecisionCount: 0 });
  assert.equal(idle.hasIndicator, false);
  assert.equal(idle.indicatorKind, undefined);
  assert.equal(idle.indicatorLabel, undefined);

  const running = trackedTasksItem({ hasRunningScheduledTask: true, needsDecisionCount: 0 });
  assert.equal(running.hasIndicator, true);
  assert.equal(running.indicatorKind, 'running', 'no owner decision pending: the plain running dot');
  assert.equal(running.indicatorLabel, undefined, 'the running dot stays unlabelled (historic behaviour)');
});

test('a pending owner decision lights the 跟踪任务 dot with its own count label, and outranks "running"', () => {
  const decision = trackedTasksItem({ hasRunningScheduledTask: false, needsDecisionCount: 2 });
  assert.equal(decision.hasIndicator, true);
  assert.equal(decision.indicatorKind, 'decision');
  assert.equal(decision.indicatorLabel, 'trackedTaskNeedsDecision', 'the label key carries the count placeholder');

  const both = trackedTasksItem({ hasRunningScheduledTask: true, needsDecisionCount: 1 });
  assert.equal(both.indicatorKind, 'decision', 'the owner decision wins over a running task');
  assert.equal(both.hasIndicator, true);

  // Garbage counts must not light the dot.
  for (const needsDecisionCount of [0, -3, undefined, null, NaN]) {
    assert.equal(
      trackedTasksItem({ hasRunningScheduledTask: false, needsDecisionCount }).hasIndicator,
      false,
      `needsDecisionCount=${String(needsDecisionCount)} keeps the dot off`,
    );
  }
});

test('Bot Internet nav model keeps Bot Hub implemented but hidden, and mounts My Bots below Meta Apps', () => {
  const items = getSidebarInternetNavModel({ t });

  assert.deepEqual(items.map((item) => item.id), ['browser', 'gigSquare', 'metaapps', 'myBots']);
  assert.equal(items[0].icon, 'globe');
  assert.equal(items[1].icon, 'shoppingBag');
  assert.equal(items[1].badge, 'gigSquareAlphaBadge');
  assert.equal(items[2].icon, 'squares2x2');
  assert.equal(items[3].label, 'metabots');
  assert.equal(items[3].icon, 'cpuChip');

  // Bot Hub is not a promoted column for now: its entry stays implemented but
  // hidden, so the sidebar lists Bot Browser, Meta Apps and My Bots.
  assert.equal(items[1].hidden, true);
  assert.deepEqual(
    items.filter((item) => !item.hidden).map((item) => item.id),
    ['browser', 'metaapps', 'myBots'],
  );
});

test('Bot Browser pane stays the visible internet destination only when selected', () => {
  assert.equal(isBotBrowserPaneVisible('browser', 'browser'), true);
  assert.equal(isBotBrowserPaneVisible('browser', 'gigSquare'), false);
  assert.equal(isBotBrowserPaneVisible('browser', 'metaapps'), false);
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
