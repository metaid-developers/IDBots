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

/** The BotWorks 定时任务 rail entry — the one that carries the running dot. */
const longTermItem = (params) =>
  getRailHomeNavModel({ t, ...params }).find((item) => item.id === 'longTerm');

test('Bot Home rail keeps the four destinations in order: new task, long-term, group tasks, records', () => {
  const ids = getRailHomeNavModel({ t, hasRunningScheduledTask: false })
    .filter((item) => !item.hidden)
    .map((item) => item.id);

  assert.deepEqual(ids, ['newTask', 'longTerm', 'groupTasks', 'records']);
  const items = getRailHomeNavModel({ t, hasRunningScheduledTask: false });
  assert.equal(items[0].icon, 'compose');
  assert.equal(items[1].icon, 'bell');
  assert.equal(items[2].icon, 'userGroup');
  assert.equal(items[3].icon, 'archive');
  // Every rail entry is an icon + a tooltip label — no text row survives.
  for (const item of items) {
    assert.equal(typeof item.label, 'string');
    assert.ok(item.label.length > 0);
  }
});

test('the 定时任务 rail entry carries no dot by default, an amber running dot while a task runs', () => {
  const idle = longTermItem({ hasRunningScheduledTask: false, needsDecisionCount: 0 });
  assert.equal(idle.hasIndicator, false);
  assert.equal(idle.indicatorKind, undefined);
  assert.equal(idle.indicatorLabel, undefined);

  const running = longTermItem({ hasRunningScheduledTask: true, needsDecisionCount: 0 });
  assert.equal(running.hasIndicator, true);
  assert.equal(running.indicatorKind, 'running', 'no owner decision pending: the plain running dot');
  assert.equal(running.indicatorLabel, undefined, 'the running dot stays unlabelled (historic behaviour)');
});

test('the decision dot rides the Studio tasks entry with its own count label; the BotWorks scheduled-tasks entry never carries it', () => {
  // Studio migration: the parked-decision dot moved to the Internet rail's
  // Studio `tasks` entry; the BotWorks 定时任务 entry only ever carries the
  // plain running dot (see the previous test).
  const studioTasks = (needsDecisionCount) =>
    getRailInternetNavModel({ t, needsDecisionCount }).find((item) => item.id === 'tasks');

  const decision = studioTasks(2);
  assert.equal(decision.hasIndicator, true);
  assert.equal(decision.indicatorKind, 'decision');
  assert.equal(decision.indicatorLabel, 'trackedTaskNeedsDecision', 'the label key carries the count placeholder');

  // Garbage counts must not light the dot.
  for (const needsDecisionCount of [0, -3, undefined, null, NaN]) {
    assert.equal(
      studioTasks(needsDecisionCount).hasIndicator,
      false,
      `needsDecisionCount=${String(needsDecisionCount)} keeps the dot off`,
    );
  }

  // The BotWorks scheduled-tasks entry ignores decision counts: its model has
  // no needsDecisionCount input, so the amber decision dot never moves back.
  const botWorks = longTermItem({ hasRunningScheduledTask: false, needsDecisionCount: 2 });
  assert.equal(botWorks.hasIndicator, false);
  assert.equal(botWorks.indicatorKind, undefined);
});

test('Bot Internet rail lists browser, the Studio tasks entry, hidden Bot Hub, Meta Apps and My Bots — the Co-Work entry is retired', () => {
  const items = getRailInternetNavModel({ t });

  assert.deepEqual(items.map((item) => item.id), ['browser', 'tasks', 'gigSquare', 'metaapps', 'myBots']);
  assert.equal(items[0].icon, 'globe');
  // Studio tasks = the long-term task board: the roadmap (clock token → Map),
  // NOT the scheduled-tasks bell that lives on the BotWorks rail.
  assert.equal(items[1].icon, 'clock');
  assert.equal(items[1].label, 'railLongTermTasks');
  assert.equal(items[2].icon, 'shoppingBag');
  assert.equal(items[2].badge, 'gigSquareAlphaBadge');
  assert.equal(items[3].icon, 'squares2x2');
  assert.equal(items[4].label, 'metabots');
  assert.equal(items[4].icon, 'cpuChip');

  // Bot Hub is not a promoted column for now: its entry stays implemented but
  // hidden, so the rail lists exactly FOUR visible destinations.
  assert.equal(items[2].hidden, true);
  assert.deepEqual(
    items.filter((item) => !item.hidden).map((item) => item.id),
    ['browser', 'tasks', 'metaapps', 'myBots'],
  );
  // Owner ruling 2026-11-08 20:18: the bubble icon is retired. The Co-Work
  // face is this surface's default (the session list IS the mid column), so it
  // needs no rail door — and no `chatBubbles` icon token stays behind.
  assert.equal(items.some((item) => item.id === 'cowork'), false);
  assert.equal(items.some((item) => item.icon === 'chatBubbles'), false);
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
  // A retired Co-Work pane id still hides the browser pane: it resolves to the
  // Bot Internet default branch, never to the browser surface.
  assert.equal(isBotBrowserPaneVisible('browser', 'cowork'), false);
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

test('Studio prompt submission switches the right pane to Bot Browser and preserves active interactive MetaApps', () => {
  const appSrc = fs.readFileSync(path.join(root, 'src/renderer/App.tsx'), 'utf8');
  const sidebarSrc = fs.readFileSync(path.join(root, 'src/renderer/components/Sidebar.tsx'), 'utf8');
  const panelSrc = fs.readFileSync(path.join(root, 'src/renderer/features/botBrowser/BotBrowserCoworkPanel.tsx'), 'utf8');

  assert.match(
    appSrc,
    /const handleRevealStudioBrowser = useCallback\(\(\): boolean => \{\s*const wasBrowserVisible = botBrowserShell\.internetPane === 'browser';\s*botBrowserShell\.selectInternetPane\('browser'\);\s*return wasBrowserVisible;/,
  );
  assert.match(appSrc, /onRevealBrowser=\{handleRevealStudioBrowser\}/);
  assert.match(sidebarSrc, /onRevealBrowser=\{onRevealBrowser\}/);

  const submitStart = panelSrc.indexOf('const handleSubmit = async');
  const submitEnd = panelSrc.indexOf('const handleSelectHistory = async');
  assert.ok(submitStart !== -1 && submitEnd > submitStart, 'BotBrowserCoworkPanel handleSubmit block exists');
  const submitBlock = panelSrc.slice(submitStart, submitEnd);
  assert.match(submitBlock, /const wasBrowserVisible = onRevealBrowser\?\.\(\) === true/);
  assert.match(submitBlock, /sessionTabBinding\.revealSessionTab\(currentSession\.id,\s*\{\s*preserveActiveInteractiveTab: wasBrowserVisible,\s*\}\)/);
  assert.match(submitBlock, /sessionTabBinding\.prepareDraftTab\(effectiveMetabotId,\s*\{\s*preserveActiveInteractiveTab: wasBrowserVisible,\s*\}\)/);
});
