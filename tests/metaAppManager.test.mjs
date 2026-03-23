import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { MetaAppManager } = require('../dist-electron/metaAppManager.js');

const createTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-metaapps-'));

const writeFile = (filePath, content) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
};

const withMetaAppsRoot = (root, run) => {
  const previous = process.env.IDBOTS_METAAPPS_ROOT;
  process.env.IDBOTS_METAAPPS_ROOT = root;
  try {
    return run();
  } finally {
    if (previous == null) {
      delete process.env.IDBOTS_METAAPPS_ROOT;
    } else {
      process.env.IDBOTS_METAAPPS_ROOT = previous;
    }
  }
};

test('listMetaApps registers valid APP.md entries and skips missing/invalid entry values', () => {
  const tempDir = createTempDir();
  const metaAppsRoot = path.join(tempDir, 'METAAPPs');

  writeFile(
    path.join(metaAppsRoot, 'buzz', 'APP.md'),
    [
      '---',
      'name: buzz-app',
      'description: buzz app',
      'official: true',
      'entry: /buzz/app/index.html',
      '---',
      '',
      '## When To Use',
      'Open buzz timeline.',
    ].join('\n'),
  );

  writeFile(
    path.join(metaAppsRoot, 'chat', 'APP.md'),
    [
      '---',
      'name: chat-app',
      'description: chat app',
      'entry: /chat/app/chat.html',
      '---',
      '',
      '## When To Use',
      'Open chat.',
    ].join('\n'),
  );

  writeFile(
    path.join(metaAppsRoot, 'broken', 'APP.md'),
    [
      '---',
      'name: broken-app',
      'description: should be skipped',
      'entry: app/not-absolute.html',
      '---',
      '',
      'bad app',
    ].join('\n'),
  );

  writeFile(
    path.join(metaAppsRoot, 'missing-entry', 'APP.md'),
    [
      '---',
      'name: missing-entry-app',
      'description: should be skipped when entry is missing',
      '---',
      '',
      'no entry here',
    ].join('\n'),
  );

  const apps = withMetaAppsRoot(metaAppsRoot, () => new MetaAppManager().listMetaApps());
  assert.equal(apps.length, 2);
  assert.deepEqual(apps.map((app) => app.id).sort(), ['buzz', 'chat']);
  assert.equal(apps.some((app) => app.id === 'missing-entry'), false);

  const buzz = apps.find((app) => app.id === 'buzz');
  assert.ok(buzz);
  assert.equal(buzz.entry, '/buzz/app/index.html');
  assert.equal(buzz.isOfficial, true);
  assert.equal(typeof buzz.updatedAt, 'number');
  assert.equal(buzz.appPath, path.join(metaAppsRoot, 'buzz', 'APP.md'));
  assert.equal(buzz.appRoot, path.join(metaAppsRoot, 'buzz'));
  assert.match(buzz.prompt, /When To Use/);
});

test('buildCoworkAutoRoutingPrompt emits <available_metaapps> with location and entry', () => {
  const tempDir = createTempDir();
  const metaAppsRoot = path.join(tempDir, 'METAAPPs');

  writeFile(
    path.join(metaAppsRoot, 'buzz', 'APP.md'),
    [
      '---',
      'name: buzz-app',
      'description: buzz app for reading chain posts',
      'entry: /buzz/app/index.html',
      '---',
      '',
      '## Examples',
      '- /buzz/app/index.html?view=hot',
    ].join('\n'),
  );

  const prompt = withMetaAppsRoot(metaAppsRoot, () => new MetaAppManager().buildCoworkAutoRoutingPrompt());
  assert.ok(prompt);
  assert.match(prompt, /<available_metaapps>/);
  assert.match(prompt, /<id>buzz<\/id>/);
  assert.match(prompt, /<description>buzz app for reading chain posts<\/description>/);
  assert.match(prompt, /<entry>\/buzz\/app\/index\.html<\/entry>/);
  assert.match(prompt, new RegExp(`<location>${path.join(metaAppsRoot, 'buzz', 'APP.md').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}<\\/location>`));
});

test('listMetaApps skips traversal-style entry that escapes metaapp root', () => {
  const tempDir = createTempDir();
  const metaAppsRoot = path.join(tempDir, 'METAAPPs');

  writeFile(
    path.join(metaAppsRoot, 'safe', 'APP.md'),
    [
      '---',
      'name: safe-app',
      'description: valid app',
      'entry: /safe/app/index.html',
      '---',
      '',
      'safe app',
    ].join('\n'),
  );

  writeFile(
    path.join(metaAppsRoot, 'escape', 'APP.md'),
    [
      '---',
      'name: escape-app',
      'description: traversal should be rejected',
      'entry: /escape/../../chat/app/chat.html',
      '---',
      '',
      'escape app',
    ].join('\n'),
  );

  const apps = withMetaAppsRoot(metaAppsRoot, () => new MetaAppManager().listMetaApps());
  assert.deepEqual(apps.map((app) => app.id), ['safe']);
});

test('packaged root prefers userData and sync copies bundled METAAPPs into it', () => {
  const tempDir = createTempDir();
  const resourcesPath = path.join(tempDir, 'resources');
  const bundledMetaAppsRoot = path.join(resourcesPath, 'METAAPPs');
  const userDataPath = path.join(tempDir, 'userData');

  writeFile(
    path.join(bundledMetaAppsRoot, 'buzz', 'APP.md'),
    [
      '---',
      'name: buzz-app',
      'description: bundled buzz app',
      'entry: /buzz/app/index.html',
      '---',
      '',
      'bundled prompt',
    ].join('\n'),
  );
  writeFile(path.join(bundledMetaAppsRoot, 'buzz', 'app', 'index.html'), '<html>buzz</html>');

  const manager = new MetaAppManager({
    app: {
      isPackaged: true,
      getPath(name) {
        if (name === 'userData') return userDataPath;
        throw new Error(`unexpected app path key: ${name}`);
      },
      getAppPath() {
        return path.join(tempDir, 'app.asar');
      },
    },
    resourcesPath,
  });

  assert.equal(manager.getMetaAppsRoot(), path.join(userDataPath, 'METAAPPs'));
  manager.syncBundledMetaAppsToUserData();

  const copiedAppMd = path.join(userDataPath, 'METAAPPs', 'buzz', 'APP.md');
  const copiedEntry = path.join(userDataPath, 'METAAPPs', 'buzz', 'app', 'index.html');
  assert.equal(fs.existsSync(copiedAppMd), true);
  assert.equal(fs.existsSync(copiedEntry), true);
});
