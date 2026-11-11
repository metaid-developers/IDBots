import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import CoworkSurfaceSessionName from '../src/renderer/features/botBrowser/CoworkSurfaceSessionName';
import {
  decideSurfaceSessionRename,
  resolveSurfaceSessionDisplayTitle,
} from '../src/renderer/features/botBrowser/surfaceSessionName';

// Surface-header session-name slot (owner order 2026-11-11 17:37, item ④;
// reworked 18:05): the Bot Internet face's open session name is the actions
// row's LEFT title — the Studio label's own lane — and renames in place.
// These tests pin the DECISION MATH — the
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
// state is a read-only BUTTON carrying the resolved display title. The
// inline editor's Enter/Escape/blur wiring is event-driven and therefore
// pinned by the static guards (workspaceRailStatic.test.mjs), not by static
// markup; its frameless styling is pinned there too.
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
  assert.doesNotMatch(markup, /<input/);
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

// Supersession (owner 18:54 left-anchor order, supersedes the 18:05
// "renders nothing" contract): the draft state no longer unmounts — it
// renders a NON-interactive spacer riding the same flex-1 lane, so the
// identity component ahead of the slot never drifts right when the name is
// absent. The intent survives (draft shows no name CONTROL: no button, no
// input, no ink) and the assertion extends to pin the left-anchor spacer.
test('render: draft state renders only the non-interactive left-anchor spacer', () => {
  const markup = renderToStaticMarkup(
    React.createElement(CoworkSurfaceSessionName, {
      sessionId: null,
      title: '抓周',
      fallbackTitle: '新会话',
      onRename: () => {},
    }),
  );
  assert.match(markup, /data-slot="cowork-surface-session-name-spacer"/);
  assert.doesNotMatch(markup, /data-slot="cowork-surface-session-name"/);
  assert.doesNotMatch(markup, /<input/);
  assert.doesNotMatch(markup, /<button/);
});
