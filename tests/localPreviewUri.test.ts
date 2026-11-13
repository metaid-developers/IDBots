import test from 'node:test';
import assert from 'node:assert/strict';

import { buildLocalPreviewUri } from '../src/renderer/features/botBrowser/localPreviewUri';
import { encodeLocalPreviewPath, previewMetaappUriForPath } from '../src/main/libs/localPreviewUri';

test('buildLocalPreviewUri maps documents to preview-file', () => {
  assert.equal(
    buildLocalPreviewUri('/tmp/workspace/note.md'),
    'preview-file://localhost/tmp/workspace/note.md',
  );
  assert.equal(
    buildLocalPreviewUri('/tmp/workspace/app.ts'),
    'preview-file://localhost/tmp/workspace/app.ts',
  );
  assert.equal(
    buildLocalPreviewUri('/tmp/workspace/report.pdf'),
    'preview-file://localhost/tmp/workspace/report.pdf',
  );
  assert.equal(
    buildLocalPreviewUri('/tmp/workspace/clip.mp4'),
    'preview-file://localhost/tmp/workspace/clip.mp4',
  );
});

test('buildLocalPreviewUri keeps html files and directories on preview-metaapp', () => {
  assert.equal(
    buildLocalPreviewUri('/tmp/workspace/report.html'),
    'preview-metaapp://localhost/tmp/workspace/report.html',
  );
  assert.equal(
    buildLocalPreviewUri('/tmp/workspace/my-app/'),
    'preview-metaapp://localhost/tmp/workspace/my-app',
  );
});

test('buildLocalPreviewUri percent-encodes each path segment', () => {
  assert.equal(
    buildLocalPreviewUri('/tmp/my files/a b#c.md'),
    'preview-file://localhost/tmp/my%20files/a%20b%23c.md',
  );
  assert.equal(
    buildLocalPreviewUri('/tmp/数据/备注.md'),
    `preview-file://localhost/tmp/${encodeURIComponent('数据')}/${encodeURIComponent('备注.md')}`,
  );
});

test('buildLocalPreviewUri normalizes Windows drive paths', () => {
  assert.equal(
    buildLocalPreviewUri('C:\\Users\\me\\a b.md'),
    'preview-file://localhost/C:/Users/me/a%20b.md',
  );
});

test('buildLocalPreviewUri returns null for unsupported file types', () => {
  assert.equal(buildLocalPreviewUri('/tmp/workspace/report.docx'), null);
  assert.equal(buildLocalPreviewUri('/tmp/workspace/bundle.zip'), null);
});

test('buildLocalPreviewUri keeps extensionless folder links on the openPath path', () => {
  assert.equal(buildLocalPreviewUri('/Users/me/project/src'), null);
});

test('buildLocalPreviewUri previews core-named extensionless files and dotfiles', () => {
  assert.equal(buildLocalPreviewUri('/x/README'), 'preview-file://localhost/x/README');
  assert.equal(buildLocalPreviewUri('/x/Makefile'), 'preview-file://localhost/x/Makefile');
  assert.equal(buildLocalPreviewUri('/x/.gitignore'), 'preview-file://localhost/x/.gitignore');
});

test('buildLocalPreviewUri rejects empty and relative input', () => {
  assert.equal(buildLocalPreviewUri(''), null);
  assert.equal(buildLocalPreviewUri('relative/note.md'), null);
});

test('main localPreviewUri normalizes Windows drive paths for stage and report URIs', () => {
  assert.equal(
    previewMetaappUriForPath('C:\\Users\\Alice Smith\\AppData\\Roaming\\IDBots\\live-stage\\official-abc\\stage.html'),
    'preview-metaapp://localhost/C:/Users/Alice%20Smith/AppData/Roaming/IDBots/live-stage/official-abc/stage.html',
  );
  assert.equal(
    encodeLocalPreviewPath('D:/work/my report #1.html'),
    '/D:/work/my%20report%20%231.html',
  );
  assert.equal(
    previewMetaappUriForPath('/Users/alice/Application Support/IDBots/live-stage/stage.html'),
    'preview-metaapp://localhost/Users/alice/Application%20Support/IDBots/live-stage/stage.html',
  );
});
