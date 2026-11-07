/**
 * Minimal headless `electron` shim for the nft-swap M0 CLIs (register/
 * announcement scripts run outside the Electron app while it is closed).
 *
 * Only what the createPin spawn chain actually touches:
 *  - app.getAppPath()  → repo root (worker bundle lookup under dist-electron)
 *  - app.getPath('userData') → real IDBots userData dir (spawn cwd)
 *  - app.getPath('exe') → THROWS on purpose, so resolveElectronExecutablePath
 *    falls back to process.execPath (node) and the worker runs under
 *    ELECTRON_RUN_AS_NODE=1 exactly like in the packaged app.
 *
 * Load with: node --require <this file> <script.mjs>
 * Set IDBOTS_USER_DATA to override the userData dir (tests).
 */

const Module = require('module');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const USER_DATA =
  process.env.IDBOTS_USER_DATA ||
  path.join(process.env.HOME || '', 'Library', 'Application Support', 'IDBots');

const fakeElectron = {
  app: {
    isPackaged: false,
    getAppPath: () => REPO_ROOT,
    getPath: (name) => {
      if (name === 'userData') return USER_DATA;
      throw new Error(`electron-shim: app.getPath(${JSON.stringify(name)}) not supported`);
    },
    on: () => {},
    once: () => {},
  },
  ipcMain: { on: () => {}, handle: () => {} },
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'electron') {
    return fakeElectron;
  }
  return originalLoad.apply(this, arguments);
};
