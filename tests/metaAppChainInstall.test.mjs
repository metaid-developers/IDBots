import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let installCommunityMetaApp;
let MetaAppManager;
let AdmZip;
try {
  ({ installCommunityMetaApp } = require('../dist-electron/services/metaAppChainService.js'));
} catch {
  installCommunityMetaApp = null;
}
try {
  ({ MetaAppManager } = require('../dist-electron/metaAppManager.js'));
} catch {
  MetaAppManager = null;
}
try {
  AdmZip = require('adm-zip');
} catch {
  AdmZip = null;
}

const createTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-metaapps-chain-install-'));

const withMetaAppsRoot = async (root, run) => {
  const previous = process.env.IDBOTS_METAAPPS_ROOT;
  process.env.IDBOTS_METAAPPS_ROOT = root;
  try {
    return await run();
  } finally {
    if (previous == null) {
      delete process.env.IDBOTS_METAAPPS_ROOT;
    } else {
      process.env.IDBOTS_METAAPPS_ROOT = previous;
    }
  }
};

const createZipBuffer = (entries) => {
  assert.equal(typeof AdmZip, 'function', 'adm-zip should be available');
  const zip = new AdmZip();
  for (const entry of entries) {
    zip.addFile(entry.name, Buffer.from(entry.content, 'utf8'));
  }
  return zip.toBuffer();
};

test('installCommunityMetaApp installs zip payload and writes APP.md + registry defaults', async () => {
  assert.equal(typeof installCommunityMetaApp, 'function', 'installCommunityMetaApp() should be exported');
  assert.equal(typeof MetaAppManager, 'function', 'MetaAppManager should be exported');

  const tempDir = createTempDir();
  const metaAppsRoot = path.join(tempDir, 'METAAPPs');

  const result = await withMetaAppsRoot(metaAppsRoot, async () => {
    const manager = new MetaAppManager();
    return installCommunityMetaApp({
      sourcePinId: 'pin-buzz',
      manager,
      fetchList: async () => [
        {
          id: 'pin-buzz',
          globalMetaId: 'idq1creator',
          timestamp: 1_777_777_777,
          contentSummary: JSON.stringify({
            title: 'Buzz',
            appName: 'buzz',
            intro: 'Buzz app from chain',
            runtime: 'browser/android',
            version: '1.1.0',
            code: 'metafile://zip-buzz',
            codeType: 'application/zip',
            indexFile: 'index.html',
            disabled: false,
          }),
        },
      ],
      fetchCodeZip: async (pinId) => {
        assert.equal(pinId, 'zip-buzz');
        return createZipBuffer([
          { name: 'index.html', content: '<html>buzz</html>' },
          { name: 'app.js', content: 'console.log("buzz")' },
        ]);
      },
      now: () => 111,
    });
  });

  assert.equal(result.success, true);
  assert.equal(result.appId, 'buzz');

  const appMd = fs.readFileSync(path.join(metaAppsRoot, 'buzz', 'APP.md'), 'utf8');
  assert.equal(appMd.includes('name: "Buzz"'), true);
  assert.equal(appMd.includes('entry: "/buzz/index.html"'), true);
  assert.match(appMd, /source-type:\s*chain-community/i);
  assert.equal(appMd.includes('creator-metaid: "idq1creator"'), true);
  assert.equal(fs.existsSync(path.join(metaAppsRoot, 'buzz', 'index.html')), true);

  const config = JSON.parse(fs.readFileSync(path.join(metaAppsRoot, 'metaapps.config.json'), 'utf8'));
  assert.equal(config.defaults?.buzz?.version, '1.1.0');
  assert.equal(config.defaults?.buzz?.['creator-metaid'], 'idq1creator');
  assert.equal(config.defaults?.buzz?.['source-type'], 'chain-community');
  assert.equal(config.defaults?.buzz?.installedAt, 111);
  assert.equal(config.defaults?.buzz?.updatedAt, 111);
});

test('installCommunityMetaApp blocks install on appId conflict with different creator', async () => {
  assert.equal(typeof installCommunityMetaApp, 'function', 'installCommunityMetaApp() should be exported');
  assert.equal(typeof MetaAppManager, 'function', 'MetaAppManager should be exported');

  const tempDir = createTempDir();
  const metaAppsRoot = path.join(tempDir, 'METAAPPs');

  fs.mkdirSync(path.join(metaAppsRoot, 'chat', 'app'), { recursive: true });
  fs.writeFileSync(
    path.join(metaAppsRoot, 'chat', 'APP.md'),
    ['---', 'name: chat', 'description: local', 'entry: /chat/app/index.html', 'version: 1.0.0', 'creator-metaid: idq1local', 'source-type: manual', '---', '', 'local chat'].join('\n'),
    'utf8',
  );
  fs.writeFileSync(path.join(metaAppsRoot, 'chat', 'app', 'index.html'), '<html>chat</html>', 'utf8');

  const result = await withMetaAppsRoot(metaAppsRoot, async () => {
    const manager = new MetaAppManager();
    return installCommunityMetaApp({
      sourcePinId: 'pin-chat',
      manager,
      fetchList: async () => [
        {
          id: 'pin-chat',
          globalMetaId: 'idq1another',
          timestamp: 1_777_777_777,
          contentSummary: JSON.stringify({
            title: 'Chat',
            appName: 'chat',
            intro: 'Chat app from chain',
            runtime: 'browser',
            version: '2.0.0',
            code: 'metafile://zip-chat',
            codeType: 'application/zip',
            indexFile: 'index.html',
            disabled: false,
          }),
        },
      ],
      fetchCodeZip: async () => createZipBuffer([{ name: 'index.html', content: '<html>chain chat</html>' }]),
      now: () => 222,
    });
  });

  assert.equal(result.success, false);
  assert.match(result.error || '', /冲突|conflict|阻止覆盖安装/i);

  const existingAppMd = fs.readFileSync(path.join(metaAppsRoot, 'chat', 'APP.md'), 'utf8');
  assert.match(existingAppMd, /creator-metaid:\s*idq1local/i);
});
