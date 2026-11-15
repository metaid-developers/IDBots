import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import CoworkSurfaceSessionName from '../src/renderer/features/botBrowser/CoworkSurfaceSessionName';
import {
  SESSION_TITLE_HIDE_GRACE_MS,
  decideSurfaceSessionRename,
  resolveSurfaceSessionDisplayTitle,
  resolveTitleHideDelayMs,
} from '../src/renderer/features/botBrowser/surfaceSessionName';

// Studio left-anchors the session title below the bot identity (owner order
// 2026-11-15: the centered lane is retired and the hover-revealed title
// steps up one size token) and renames it in
// place. These tests pin the DECISION MATH — the
// same contract the two existing rename implementations share
// (CoworkSessionItem rows, CoworkSessionDetail header):
//   - empty/whitespace input commits NOTHING (the display falls back to the
//     default title; the stored title is never blanked);
//   - an unchanged title commits NOTHING (no redundant IPC write);
//   - anything else commits the TRIMMED value through the shared channel.
// The Interaction wiring (Enter/blur commit, Escape cancel, blur-guard) is a
// direct mirror of the transcript header's rename and is pinned by the static
// guards in workspaceRailStatic.test.mjs — this file covers the logic, not
// browser-level E2E.

test('display title: blank stored titles fall back to the default title', () => {
  assert.equal(resolveSurfaceSessionDisplayTitle('', '新会话'), '新会话');
  assert.equal(resolveSurfaceSessionDisplayTitle('   ', '新会话'), '新会话');
  assert.equal(resolveSurfaceSessionDisplayTitle(null, '新会话'), '新会话');
  assert.equal(resolveSurfaceSessionDisplayTitle(undefined, '新会话'), '新会话');
});

test('display title: a stored title shows trimmed, verbatim otherwise', () => {
  assert.equal(resolveSurfaceSessionDisplayTitle('  抓周  ', '新会话'), '抓周');
  assert.equal(resolveSurfaceSessionDisplayTitle('抓周', '新会话'), '抓周');
});

test('rename decision: empty/whitespace input is a no-op (never blanks the title)', () => {
  assert.deepEqual(decideSurfaceSessionRename('旧标题', ''), { action: 'noop' });
  assert.deepEqual(decideSurfaceSessionRename('旧标题', '   '), { action: 'noop' });
});

test('rename decision: unchanged title is a no-op (no redundant write)', () => {
  assert.deepEqual(decideSurfaceSessionRename('抓周', '抓周'), { action: 'noop' });
});

test('rename decision: a changed title commits trimmed', () => {
  assert.deepEqual(decideSurfaceSessionRename('旧标题', '  新标题  '), {
    action: 'rename',
    nextTitle: '新标题',
  });
});

test('rename decision: padding-only edits do not write', () => {
  // Input is trimmed first; if the trimmed value equals the stored title the
  // commit is a no-op — same as the header's
  // `nextTitle !== currentSession.title` guard.
  assert.deepEqual(decideSurfaceSessionRename('抓周', ' 抓周 '), { action: 'noop' });
});

// Render smoke (renderToStaticMarkup, Node — no DOM, no store): the default
// state is a left-anchored read-only BUTTON carrying the resolved display
// title (left-anchor order 2026-11-15 supersedes the centered lane).
test('render: default state is a read-only button showing the display title', () => {
  const markup = renderToStaticMarkup(
    React.createElement(CoworkSurfaceSessionName, {
      sessionId: 'sess-1',
      title: '  抓周  ',
      fallbackTitle: '新会话',
      onRename: () => {},
    }),
  );
  assert.match(markup, /data-slot="cowork-surface-session-name"/);
  assert.match(markup, /抓周/);
  assert.match(markup, /flex h-9 w-full min-w-0 items-center gap-2 rounded-lg px-1 text-left text-sm font-medium/);
  assert.match(markup, /group flex h-9 w-full min-w-0 items-center gap-2 rounded-lg px-1 text-left text-sm font-medium/);
  assert.match(markup, /text-sm font-medium/);
  assert.doesNotMatch(markup, /text-center/);
  assert.match(markup, /data-slot="cowork-surface-session-name-icon"/);
  assert.doesNotMatch(markup, /<input/);
});

test('session-name icon: square bubble inside circular-frame pill rides the title row (owner rulings 10:48 circle frame → 10:51 elongated pill, left-aligned)', () => {
  const markup = renderToStaticMarkup(
    React.createElement(CoworkSurfaceSessionName, {
      sessionId: 'sess-1',
      title: '抓周',
      fallbackTitle: '新会话',
      onRename: () => {},
    }),
  );
  // The icon rides BEFORE the title text node, inside the read-only button
  // (the button's aria-label also carries the title earlier in the markup —
  // anchor on the TEXT NODE, not the bare string).
  const iconAt = markup.indexOf('data-slot="cowork-surface-session-name-icon"');
  const titleAt = markup.indexOf('>抓周</span>');
  assert.ok(iconAt > 0, 'icon rendered');
  assert.ok(titleAt > iconAt, 'icon precedes the title text');
  // lucide `MessageSquare` path, verbatim (square bubble — the pill frame
  // NOT a double-bubble variant).
  assert.match(
    markup,
    /d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/,
  );
  // Mon design pins: 14 px square, secondary text color (dark twin), 6 px
  // gap, vertical centering rides the row's items-center, hover deepens via
  // the button's group without touching the title's interaction.
  assert.match(markup, /h-4 w-4 shrink-0/);
  assert.match(markup, /text-claude-textSecondary/);
  assert.match(markup, /dark:text-claude-darkTextSecondary/);
  assert.match(markup, /gap-2/);
  assert.match(markup, /group-hover:text-claude-text/);
  assert.match(markup, /aria-hidden="true"/);
  // Title lane (owner 10:56): spans the tray width like the switcher.
  assert.match(markup, /group flex h-9 w-full min-w-0 items-center/);
  // Owner 09:51 same-scale ruling: title typography = badge name typography
  // (text-sm font-medium leading-none — read from CoworkSurfaceIdentityBadge).
  assert.match(markup, /text-sm font-medium leading-none/);
  assert.match(markup, /text-claude-text/);
  assert.match(markup, /dark:text-claude-darkText/);
});

test('render: blank stored title displays the default title', () => {
  const markup = renderToStaticMarkup(
    React.createElement(CoworkSurfaceSessionName, {
      sessionId: 'sess-1',
      title: '',
      fallbackTitle: '新会话',
      onRename: () => {},
    }),
  );
  assert.match(markup, /新会话/);
});

test('render: draft state preserves the title row with a non-interactive spacer', () => {
  const markup = renderToStaticMarkup(
    React.createElement(CoworkSurfaceSessionName, {
      sessionId: null,
      title: '抓周',
      fallbackTitle: '新会话',
      onRename: () => {},
    }),
  );
  assert.match(markup, /data-slot="cowork-surface-session-name-spacer"/);
  assert.match(markup, /h-6 w-full min-w-0 flex-none/);
  assert.doesNotMatch(markup, /data-slot="cowork-surface-session-name"/);
  assert.doesNotMatch(markup, /<input/);
  assert.doesNotMatch(markup, /<button/);
});

test('grace collapse: editing pins the row, otherwise the 2000 ms grace applies (owner rulings 09:17 → 16:08 two seconds)', () => {
  assert.equal(SESSION_TITLE_HIDE_GRACE_MS, 2000); // owner ruling 2026-11-15 16:08: collapse after two seconds
  // Clause ②: the inline editor pins the row — no collapse timer at all.
  assert.equal(resolveTitleHideDelayMs(true), null);
  // Plain leave: the full grace window before the collapse fires.
  assert.equal(resolveTitleHideDelayMs(false), 2000);
});
