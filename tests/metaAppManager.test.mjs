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
  writeFile(path.join(metaAppsRoot, 'buzz', 'app', 'index.html'), '<html>buzz</html>');
  writeFile(path.join(metaAppsRoot, 'chat', 'app', 'chat.html'), '<html>chat</html>');

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

test('listMetaApps exposes version, creator-metaid, and source-type from APP.md', () => {
  const tempDir = createTempDir();
  const metaAppsRoot = path.join(tempDir, 'METAAPPs');

  writeFile(
    path.join(metaAppsRoot, 'buzz', 'APP.md'),
    [
      '---',
      'name: buzz-app',
      'description: buzz app',
      'entry: /buzz/app/index.html',
      'version: 1.2.0',
      'creator-metaid: idbots',
      'source-type: bundled-idbots',
      '---',
      '',
      '## When To Use',
      'Open buzz timeline.',
    ].join('\n'),
  );
  writeFile(path.join(metaAppsRoot, 'buzz', 'app', 'index.html'), '<html>buzz</html>');

  const apps = withMetaAppsRoot(metaAppsRoot, () => new MetaAppManager().listMetaApps());
  assert.equal(apps.length, 1);

  const buzz = apps[0];
  assert.equal(buzz.version, '1.2.0');
  assert.equal(buzz.creatorMetaId, 'idbots');
  assert.equal(buzz.sourceType, 'bundled-idbots');
  assert.equal(buzz.managedByIdbots, true);
});

test('listMetaApps falls back to metaapps.config defaults when APP.md omits managed metadata', () => {
  const tempDir = createTempDir();
  const metaAppsRoot = path.join(tempDir, 'METAAPPs');

  const defaultsConfig = {
    version: 1,
    description: 'Default MetaApp configuration for IDBots',
    defaults: {
      buzz: {
        version: '3.4.5',
        'creator-metaid': 'idbots',
        'source-type': 'bundled-idbots',
      },
    },
  };

  writeFile(path.join(metaAppsRoot, 'metaapps.config.json'), JSON.stringify(defaultsConfig, null, 2));
  writeFile(
    path.join(metaAppsRoot, 'buzz', 'APP.md'),
    [
      '---',
      'name: buzz-app',
      'description: buzz app',
      'entry: /buzz/app/index.html',
      '---',
      '',
      '## When To Use',
      'Open buzz timeline.',
    ].join('\n'),
  );
  writeFile(path.join(metaAppsRoot, 'buzz', 'app', 'index.html'), '<html>buzz</html>');

  const apps = withMetaAppsRoot(metaAppsRoot, () => new MetaAppManager().listMetaApps());
  assert.equal(apps.length, 1);

  const buzz = apps[0];
  assert.equal(buzz.version, '3.4.5');
  assert.equal(buzz.creatorMetaId, 'idbots');
  assert.equal(buzz.sourceType, 'bundled-idbots');
  assert.equal(buzz.managedByIdbots, true);
});

test('listMetaApps uses hard defaults when APP.md and config both omit managed metadata', () => {
  const tempDir = createTempDir();
  const metaAppsRoot = path.join(tempDir, 'METAAPPs');

  const defaultsConfig = {
    version: 1,
    description: 'Default MetaApp configuration for IDBots',
    defaults: {
      buzz: {},
    },
  };

  writeFile(path.join(metaAppsRoot, 'metaapps.config.json'), JSON.stringify(defaultsConfig, null, 2));
  writeFile(
    path.join(metaAppsRoot, 'buzz', 'APP.md'),
    [
      '---',
      'name: buzz-app',
      'description: buzz app',
      'entry: /buzz/app/index.html',
      '---',
      '',
      '## When To Use',
      'Open buzz timeline.',
    ].join('\n'),
  );
  writeFile(path.join(metaAppsRoot, 'buzz', 'app', 'index.html'), '<html>buzz</html>');

  const apps = withMetaAppsRoot(metaAppsRoot, () => new MetaAppManager().listMetaApps());
  assert.equal(apps.length, 1);

  const buzz = apps[0];
  assert.equal(buzz.version, '0');
  assert.equal(buzz.creatorMetaId, '');
  assert.equal(buzz.sourceType, 'manual');
  assert.equal(buzz.managedByIdbots, false);
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
  writeFile(path.join(metaAppsRoot, 'buzz', 'app', 'index.html'), '<html>buzz</html>');

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
  writeFile(path.join(metaAppsRoot, 'safe', 'app', 'index.html'), '<html>safe</html>');

  const apps = withMetaAppsRoot(metaAppsRoot, () => new MetaAppManager().listMetaApps());
  assert.deepEqual(apps.map((app) => app.id), ['safe']);
});

test('listMetaApps skips entry that collapses to the app root directory', () => {
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
    path.join(metaAppsRoot, 'collapse', 'APP.md'),
    [
      '---',
      'name: collapse-app',
      'description: root-collapse should be rejected',
      'entry: /collapse/app/..',
      '---',
      '',
      'collapse app',
    ].join('\n'),
  );
  writeFile(path.join(metaAppsRoot, 'safe', 'app', 'index.html'), '<html>safe</html>');

  const apps = withMetaAppsRoot(metaAppsRoot, () => new MetaAppManager().listMetaApps());
  assert.deepEqual(apps.map((app) => app.id).sort(), ['safe']);
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

test('packaged sync seeds metaapps.config defaults for bundled-idbots apps', () => {
  const tempDir = createTempDir();
  const resourcesPath = path.join(tempDir, 'resources');
  const bundledMetaAppsRoot = path.join(resourcesPath, 'METAAPPs');
  const userDataPath = path.join(tempDir, 'userData');

  const defaultsConfig = {
    version: 1,
    description: 'Default MetaApp configuration for IDBots',
    defaults: {
      buzz: {
        version: '1.0.0',
        'creator-metaid': 'idbots',
        'source-type': 'bundled-idbots',
        installedAt: 1774224000000,
        updatedAt: 1774224000000,
      },
    },
  };

  writeFile(path.join(bundledMetaAppsRoot, 'metaapps.config.json'), JSON.stringify(defaultsConfig, null, 2));
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

  manager.syncBundledMetaAppsToUserData();

  const userConfigPath = path.join(userDataPath, 'METAAPPs', 'metaapps.config.json');
  assert.equal(fs.existsSync(userConfigPath), true);
  const userConfig = JSON.parse(fs.readFileSync(userConfigPath, 'utf8'));
  assert.equal(userConfig.defaults?.buzz?.version, '1.0.0');
  assert.equal(userConfig.defaults?.buzz?.['creator-metaid'], 'idbots');
  assert.equal(userConfig.defaults?.buzz?.['source-type'], 'bundled-idbots');
});

test('packaged sync does not classify pre-existing same-id user app as bundled-idbots via seeded config', () => {
  const tempDir = createTempDir();
  const resourcesPath = path.join(tempDir, 'resources');
  const bundledMetaAppsRoot = path.join(resourcesPath, 'METAAPPs');
  const userDataPath = path.join(tempDir, 'userData');
  const userMetaAppsRoot = path.join(userDataPath, 'METAAPPs');

  writeFile(
    path.join(userMetaAppsRoot, 'buzz', 'APP.md'),
    [
      '---',
      'name: my-local-buzz',
      'description: user-owned local app with same id',
      'entry: /buzz/app/index.html',
      '---',
      '',
      'user local buzz',
    ].join('\n'),
  );
  writeFile(path.join(userMetaAppsRoot, 'buzz', 'app', 'index.html'), '<html>local-buzz</html>');

  const bundledConfig = {
    version: 1,
    description: 'Default MetaApp configuration for IDBots',
    defaults: {
      buzz: {
        version: '1.0.0',
        'creator-metaid': 'idbots',
        'source-type': 'bundled-idbots',
      },
    },
  };
  writeFile(path.join(bundledMetaAppsRoot, 'metaapps.config.json'), JSON.stringify(bundledConfig, null, 2));
  writeFile(
    path.join(bundledMetaAppsRoot, 'buzz', 'APP.md'),
    [
      '---',
      'name: bundled-buzz',
      'description: bundled buzz app',
      'entry: /buzz/app/index.html',
      'version: 1.0.0',
      'creator-metaid: idbots',
      'source-type: bundled-idbots',
      '---',
      '',
      'bundled buzz',
    ].join('\n'),
  );
  writeFile(path.join(bundledMetaAppsRoot, 'buzz', 'app', 'index.html'), '<html>bundled-buzz</html>');

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

  manager.syncBundledMetaAppsToUserData();

  const apps = manager.listMetaApps();
  assert.equal(apps.length, 1);
  const buzz = apps[0];
  assert.equal(buzz.id, 'buzz');
  assert.equal(buzz.version, '0');
  assert.equal(buzz.creatorMetaId, '');
  assert.equal(buzz.sourceType, 'manual');
  assert.equal(buzz.managedByIdbots, false);
});

test('packaged sync preserves existing user metaapps.config.json and does not overwrite it', () => {
  const tempDir = createTempDir();
  const resourcesPath = path.join(tempDir, 'resources');
  const bundledMetaAppsRoot = path.join(resourcesPath, 'METAAPPs');
  const userDataPath = path.join(tempDir, 'userData');
  const userMetaAppsRoot = path.join(userDataPath, 'METAAPPs');
  const userConfigPath = path.join(userMetaAppsRoot, 'metaapps.config.json');

  const userConfig = {
    version: 1,
    description: 'user config should be preserved',
    defaults: {
      buzz: {
        version: '9.9.9',
        'creator-metaid': 'alice',
        'source-type': 'manual',
      },
    },
  };
  writeFile(userConfigPath, JSON.stringify(userConfig, null, 2));

  const bundledConfig = {
    version: 1,
    description: 'bundled config should not overwrite user config',
    defaults: {
      buzz: {
        version: '1.0.0',
        'creator-metaid': 'idbots',
        'source-type': 'bundled-idbots',
      },
      chat: {
        version: '1.0.0',
        'creator-metaid': 'idbots',
        'source-type': 'bundled-idbots',
      },
    },
  };
  writeFile(path.join(bundledMetaAppsRoot, 'metaapps.config.json'), JSON.stringify(bundledConfig, null, 2));
  writeFile(
    path.join(bundledMetaAppsRoot, 'chat', 'APP.md'),
    [
      '---',
      'name: chat-app',
      'description: bundled chat app',
      'entry: /chat/app/chat.html',
      'version: 1.0.0',
      'creator-metaid: idbots',
      'source-type: bundled-idbots',
      '---',
      '',
      'bundled chat',
    ].join('\n'),
  );
  writeFile(path.join(bundledMetaAppsRoot, 'chat', 'app', 'chat.html'), '<html>chat</html>');

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

  manager.syncBundledMetaAppsToUserData();

  const actual = JSON.parse(fs.readFileSync(userConfigPath, 'utf8'));
  assert.equal(actual.defaults?.buzz?.version, '9.9.9');
  assert.equal(actual.defaults?.buzz?.['creator-metaid'], 'alice');
  assert.equal(actual.defaults?.buzz?.['source-type'], 'manual');
  assert.equal(actual.defaults?.chat?.version, '1.0.0');
  assert.equal(actual.defaults?.chat?.['creator-metaid'], 'idbots');
  assert.equal(actual.defaults?.chat?.['source-type'], 'bundled-idbots');
});

test('listMetaApps keeps managed metadata from registry even after APP.md frontmatter edits', () => {
  const tempDir = createTempDir();
  const resourcesPath = path.join(tempDir, 'resources');
  const bundledMetaAppsRoot = path.join(resourcesPath, 'METAAPPs');
  const userDataPath = path.join(tempDir, 'userData');

  const bundledConfig = {
    version: 1,
    description: 'Default MetaApp configuration for IDBots',
    defaults: {
      buzz: {
        version: '1.0.0',
        'creator-metaid': 'idbots',
        'source-type': 'bundled-idbots',
      },
    },
  };
  writeFile(path.join(bundledMetaAppsRoot, 'metaapps.config.json'), JSON.stringify(bundledConfig, null, 2));
  writeFile(
    path.join(bundledMetaAppsRoot, 'buzz', 'APP.md'),
    [
      '---',
      'name: bundled-buzz',
      'description: bundled buzz app',
      'entry: /buzz/app/index.html',
      'version: 1.0.0',
      'creator-metaid: idbots',
      'source-type: bundled-idbots',
      '---',
      '',
      'bundled buzz',
    ].join('\n'),
  );
  writeFile(path.join(bundledMetaAppsRoot, 'buzz', 'app', 'index.html'), '<html>bundled-buzz</html>');

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

  manager.syncBundledMetaAppsToUserData();

  writeFile(
    path.join(userDataPath, 'METAAPPs', 'buzz', 'APP.md'),
    [
      '---',
      'name: edited-buzz',
      'description: edited app should not flip managed ownership',
      'entry: /buzz/app/index.html',
      'version: 9.9.9',
      'creator-metaid: alice',
      'source-type: manual',
      '---',
      '',
      'edited buzz',
    ].join('\n'),
  );

  const apps = manager.listMetaApps();
  assert.equal(apps.length, 1);
  const buzz = apps[0];
  assert.equal(buzz.name, 'edited-buzz');
  assert.equal(buzz.version, '1.0.0');
  assert.equal(buzz.creatorMetaId, 'idbots');
  assert.equal(buzz.sourceType, 'bundled-idbots');
  assert.equal(buzz.managedByIdbots, true);
});
