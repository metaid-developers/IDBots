// Bot Internet sidebar panel — image attachments must render as pictures too.
//
// The panel is a deliberately minimal separate renderer, and that is exactly
// how it missed the transcript's image-attachment fix: the two surfaces each
// had their own idea of how a user body renders, so a message carrying
// `附件路径: <path>` marker lines showed the raw path as text in the panel while
// the main cowork transcript showed a thumbnail.
//
// The fix is a shared body pipeline (UserAttachmentBody) used by BOTH surfaces.
// This test pins three things:
//   1. the panel renders its user branch through the shared UserMessageBody and
//      passes a resolver built from the session cwd/executionMode;
//   2. the panel defines NO splitter copy of its own (the anti-drift assertion);
//   3. behaviorally — server-rendered — an image marker disappears into a
//      thumbnail, a non-image marker stays as text, and the absolute-path
//      fallback still works when no resolver is available.
//
// Harness note: renderer tests here are server-rendered (no DOM/jsdom). Effects
// never run, so the thumbnail is fed from the shared preview cache — the strip
// seeds its first paint from that cache synchronously, which is also what keeps
// a cached thumbnail from flashing empty in the real app.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { PanelMessage } from '../src/renderer/features/botBrowser/BotBrowserCoworkPanel';
import { splitUserAttachmentLines } from '../src/renderer/components/cowork/UserAttachmentBody';
import { setLocalImagePreviewEntry } from '../src/renderer/utils/localImage';
import { resolveLocalPathAgainstCwd } from '../src/renderer/utils/localPath';
import type { CoworkMessage } from '../src/renderer/types/cowork';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const panelSource = fs.readFileSync(
  path.join(projectRoot, 'src', 'renderer', 'features', 'botBrowser', 'BotBrowserCoworkPanel.tsx'),
  'utf8',
);

const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const userMessage = (content: string): CoworkMessage => ({
  id: 'panel-user-1',
  type: 'user',
  content,
  timestamp: 1,
});

const renderPanelMessage = (
  content: string,
  resolveLocalFilePath?: (href: string, text: string) => string | null,
): string => renderToStaticMarkup(
  <PanelMessage
    message={userMessage(content)}
    onOpenUri={() => {}}
    resolveLocalFilePath={resolveLocalFilePath}
  />,
);

test('a panel user message renders an image attachment as a thumbnail, not a path', () => {
  const imagePath = '/var/folders/1k/v7v7vc757rj9zz7rk4h151k40000gn/T/idbots/attachments/image-1792426935569-bhsokg.png';
  setLocalImagePreviewEntry(imagePath, { status: 'ready', dataUrl: PNG_DATA_URL });

  const markup = renderPanelMessage(`look at this\n\n附件路径: ${imagePath}`);

  assert.match(markup, /<img/);
  assert.ok(markup.includes(PNG_DATA_URL), 'the thumbnail must be fed by the shared preview cache');
  assert.equal(markup.includes('附件路径'), false, 'the marker line must not leak as text');
  assert.ok(markup.includes('look at this'), 'the instruction text survives');
  assert.ok(markup.includes('image-1792426935569-bhsokg.png'), 'the basename still labels the thumbnail');
});

test('a non-image attachment marker stays visible in the panel body as text', () => {
  const markup = renderPanelMessage('see attached\n\n附件路径: /tmp/notes/report.pdf');

  assert.equal(markup.includes('report.pdf'), true, 'nothing is silently swallowed');
  assert.doesNotMatch(markup, /<img/);
});

test('the panel resolver is context-aware; with no resolver, only absolute paths render', () => {
  const cwd = '/Users/wufeng/idbots/project/bots/3/2026-11-04';
  const resolver = (href: string, text: string) => resolveLocalPathAgainstCwd(href, text, {
    cwd,
    executionMode: 'local',
  });

  const absolute = '/var/folders/tmp/image-1.png';
  assert.equal(resolveLocalPathAgainstCwd(absolute, absolute, { cwd }), absolute);

  const relative = 'pics/shot.png';
  assert.equal(resolveLocalPathAgainstCwd(relative, relative, { cwd }), `${cwd}/pics/shot.png`);
  assert.equal(resolveLocalPathAgainstCwd(relative, relative, {}), null, 'a relative path is never guessed without a cwd');

  // The splitter: with the resolver the relative marker becomes a picture...
  const resolved = splitUserAttachmentLines(`附件路径: ${relative}`, resolver);
  assert.deepEqual(resolved.imagePaths, [`${cwd}/pics/shot.png`]);
  assert.equal(resolved.body, '');

  // ...and with NO resolver the same relative marker stays in the body, while
  // an absolute temp path still renders through the fallback.
  const unresolved = splitUserAttachmentLines(`附件路径: ${relative}`);
  assert.deepEqual(unresolved.imagePaths, []);
  assert.ok(unresolved.body.includes('附件路径'));

  const absoluteOnly = splitUserAttachmentLines(`附件路径: ${absolute}`);
  assert.deepEqual(absoluteOnly.imagePaths, [absolute]);
  assert.equal(absoluteOnly.body, '');
});

test('the panel renders through the shared body and keeps no splitter copy of its own', () => {
  assert.ok(
    /import \{ UserMessageBody \} from '\.\.\/\.\.\/components\/cowork\/UserAttachmentBody';/.test(panelSource),
    'the panel must import the shared body',
  );
  assert.equal((panelSource.match(/<UserMessageBody/g) ?? []).length, 1, 'the user branch renders exactly one shared body');
  assert.ok(
    /<UserMessageBody content=\{message\.content\} resolveLocalFilePath=\{resolveLocalFilePath\} \/>/.test(panelSource),
    'the panel hands its own resolver to the shared body',
  );

  // Anti-drift: none of the display-side attachment pipeline may be re-declared
  // here. If any of these appear, the panel has forked from the shared module.
  assert.equal(panelSource.includes('splitUserAttachmentLines'), false, 'no splitter copy');
  assert.equal(panelSource.includes('USER_ATTACHMENT_MARKER_PATTERN'), false, 'no marker-regex copy');
  assert.equal(panelSource.includes('hasSupportedImageExtension'), false, 'no extension-gate copy');
  assert.equal(panelSource.includes('const ImagePreviewStrip'), false, 'no strip copy');
  assert.doesNotMatch(panelSource, /附件(?:路径|文件)|输入文件/, 'no attachment marker literal of its own');

  // The resolver exists only when the session carries a cwd.
  assert.ok(
    /const cwd = currentSession\?\.cwd\?\.trim\(\);/.test(panelSource)
      && /if \(!cwd\) return undefined;/.test(panelSource)
      && /const executionMode = currentSession\?\.executionMode;/.test(panelSource)
      && /\{ cwd, executionMode \}/.test(panelSource),
    'the resolver is built from the session cwd/executionMode, and absent without a cwd',
  );

  // Assistant branches are untouched: still two markdown renders (assistant
  // mode bubble + plain final answer), and the old plain-text bubble pass is gone.
  assert.equal((panelSource.match(/<MarkdownContent content=\{message\.content\}/g) ?? []).length, 2);
  assert.equal(panelSource.includes('TwemojiText'), false, 'the user bubble no longer uses the plain-text pass');
});
