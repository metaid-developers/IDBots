import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildPanelAutoScrollFollowSignal,
  resolvePanelScrollInteraction,
  shouldPinPanelToBottomOnUpdate,
} from '../src/renderer/features/botBrowser/panelAutoScroll';

const repoRoot = path.resolve(import.meta.dirname, '..');
const panelSource = fs.readFileSync(
  path.join(repoRoot, 'src/renderer/features/botBrowser/BotBrowserCoworkPanel.tsx'),
  'utf8',
);

test('buildPanelAutoScrollFollowSignal tracks in-place streaming delta growth even when message count stays fixed', () => {
  const s1 = buildPanelAutoScrollFollowSignal([
    { id: 'u1', content: 'hi' },
    { id: 'a1', content: 'First line', metadata: { isStreaming: true } },
  ], true);
  const s2 = buildPanelAutoScrollFollowSignal([
    { id: 'u1', content: 'hi' },
    { id: 'a1', content: 'First line\nSecond line\n' + 'x'.repeat(800), metadata: { isStreaming: true } },
  ], true);
  const s3 = buildPanelAutoScrollFollowSignal([
    { id: 'u1', content: 'hi' },
    { id: 'a1', content: 'First line\nSecond line\n' + 'x'.repeat(1600), metadata: { isStreaming: true } },
  ], true);

  assert.notEqual(s1, s2, 'streaming chunk growth must advance follow signal');
  assert.notEqual(s2, s3, 'continued long-message streaming must advance follow signal');
});

test('buildPanelAutoScrollFollowSignal ignores prepended earlier history when idle, but catches tail updates and completion', () => {
  const tail = { id: 'a1', content: 'final answer', metadata: { isStreaming: false } };
  const beforePrepend = buildPanelAutoScrollFollowSignal([
    { id: 'u1', content: 'question' },
    tail,
  ], false);
  const afterPrepend = buildPanelAutoScrollFollowSignal([
    { id: 'u0', content: 'older user' },
    { id: 'a0', content: 'older answer' },
    { id: 'u1', content: 'question' },
    tail,
  ], false);
  assert.equal(afterPrepend, beforePrepend, 'loading earlier messages must not change idle follow signal');

  const whileStreaming = buildPanelAutoScrollFollowSignal([
    { id: 'u1', content: 'question' },
    { id: 'a1', content: 'final answer', metadata: { isStreaming: true } },
  ], true);
  assert.notEqual(whileStreaming, beforePrepend, 'stream completion changes follow signal');
});

test('shouldPinPanelToBottomOnUpdate pins throughout streaming and on stream completion even if previously scrolled up', () => {
  // User had scrolled up before streaming started: streaming still pushes bottom into view.
  assert.equal(shouldPinPanelToBottomOnUpdate({
    isStreaming: true,
    wasStreaming: false,
    shouldAutoScroll: false,
    isLoadingEarlier: false,
    sessionChanged: false,
  }), true);

  // Ongoing streaming chunks when scrolled up: stays pinned to bottom.
  assert.equal(shouldPinPanelToBottomOnUpdate({
    isStreaming: true,
    wasStreaming: true,
    shouldAutoScroll: false,
    isLoadingEarlier: false,
    sessionChanged: false,
  }), true);

  // Stream just finished (`wasStreaming && !isStreaming`): always pin final tail even if flag had drifted.
  assert.equal(shouldPinPanelToBottomOnUpdate({
    isStreaming: false,
    wasStreaming: true,
    shouldAutoScroll: false,
    isLoadingEarlier: false,
    sessionChanged: false,
  }), true);

  // Idle & scrolled up: do not yank user away from history.
  assert.equal(shouldPinPanelToBottomOnUpdate({
    isStreaming: false,
    wasStreaming: false,
    shouldAutoScroll: false,
    isLoadingEarlier: false,
    sessionChanged: false,
  }), false);

  // Prepending earlier messages never jumps to bottom.
  assert.equal(shouldPinPanelToBottomOnUpdate({
    isStreaming: false,
    wasStreaming: false,
    shouldAutoScroll: true,
    isLoadingEarlier: true,
    sessionChanged: false,
  }), false);
});

test('resolvePanelScrollInteraction keeps auto-scroll armed when content grows downward, and only disengages on real upward scroll', () => {
  // Content grew by 600px while scrollTop stayed at 1000 (did not scroll up):
  // must NOT kill auto-scroll!
  const onGrowth = resolvePanelScrollInteraction({
    scrollTop: 1000,
    scrollHeight: 2000,
    clientHeight: 400,
    prevScrollTop: 1000,
    prevShouldAutoScroll: true,
  });
  assert.equal(onGrowth.nextShouldAutoScroll, true);

  // User genuinely scrolls upward away from bottom: disengages auto-scroll.
  const onScrollUp = resolvePanelScrollInteraction({
    scrollTop: 850,
    scrollHeight: 2000,
    clientHeight: 400,
    prevScrollTop: 1000,
    prevShouldAutoScroll: true,
  });
  assert.equal(onScrollUp.nextShouldAutoScroll, false);
  assert.equal(onScrollUp.nextShowScrollToBottom, true);

  // User scrolls back within 96px of bottom: re-engages auto-scroll.
  const onBackToBottom = resolvePanelScrollInteraction({
    scrollTop: 1550,
    scrollHeight: 2000,
    clientHeight: 400,
    prevScrollTop: 850,
    prevShouldAutoScroll: false,
  });
  assert.equal(onBackToBottom.nextShouldAutoScroll, true);
  assert.equal(onBackToBottom.nextShowScrollToBottom, false);
});

test('BotBrowserCoworkPanel mounts bottom activity/delegation status outside the scroll container so it is always visible', () => {
  const scrollerStart = panelSource.indexOf('ref={listRef}');
  const scrollToBottomSlot = panelSource.indexOf('data-slot="panel-scroll-to-bottom"');
  const locatorRail = panelSource.indexOf('<PanelMessageLocatorRail');
  const bottomStatusSlot = panelSource.indexOf('data-slot="panel-bottom-status"');
  const activityIndicator = panelSource.indexOf('<AssistantActivityIndicator');
  const delegationRow = panelSource.indexOf('<PanelDelegationStatusRow');

  assert.ok(scrollerStart !== -1, 'listRef scroller exists');
  assert.ok(scrollToBottomSlot > scrollerStart, 'scroll-to-bottom button follows scroller');
  assert.ok(locatorRail > scrollToBottomSlot, 'locator rail wraps the scroller wrapper');
  assert.ok(bottomStatusSlot > locatorRail, 'panel-bottom-status is mounted outside the scroller wrapper');
  assert.ok(activityIndicator > bottomStatusSlot, 'AssistantActivityIndicator renders inside pinned bottom status');
  assert.ok(delegationRow > bottomStatusSlot, 'PanelDelegationStatusRow renders inside pinned bottom status');
});
