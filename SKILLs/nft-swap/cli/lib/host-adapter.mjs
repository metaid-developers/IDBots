/**
 * Host adapter — the ONLY place that touches the IDBots Electron build
 * (dist-electron). Loaded lazily by the CLIs in --broadcast mode; a dry-run,
 * --help, or pure read never requires the app build.
 *
 * Safety posture (PRD §9 / §12c): every write goes through the app's own
 * services and host confirmation surface — this file wires dep functions, it
 * does NOT re-implement or weaken any host gate (ownerAddress check,
 * burned-refuse, chain check, collection createAddress check).
 */

import { existsSync } from 'node:fs';
import Module, { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { ESTIMATE_PLACEHOLDER_PINID, SwapEngineError } from './swap-engine.mjs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** cli/lib → cli → nft-swap → SKILLs → repo root. */
export const REPO_ROOT = path.resolve(__dirname, '../../../..');

export function distMainPath(repoRoot = REPO_ROOT) {
  return path.join(repoRoot, 'dist-electron', 'main');
}

function hasHostBuild(candidateDir) {
  if (!candidateDir) return false;
  try {
    return existsSync(path.join(candidateDir, 'sqliteStore.js'));
  } catch {
    return false;
  }
}

export function resolveDistMainPath({ repoRoot, env = process.env } = {}) {
  if (repoRoot && path.resolve(repoRoot) !== REPO_ROOT) {
    return distMainPath(repoRoot);
  }
  const candidates = [];
  if (env.IDBOTS_DIST_MAIN_PATH?.trim()) {
    candidates.push(path.resolve(env.IDBOTS_DIST_MAIN_PATH.trim()));
  }
  if (env.IDBOTS_APP_PATH?.trim()) {
    candidates.push(path.join(path.resolve(env.IDBOTS_APP_PATH.trim()), 'dist-electron', 'main'));
  }
  candidates.push(distMainPath(REPO_ROOT));
  if (env.IDBOTS_ELECTRON_PATH?.trim()) {
    const exeDir = path.dirname(path.resolve(env.IDBOTS_ELECTRON_PATH.trim()));
    candidates.push(
      path.resolve(exeDir, '../Resources/app.asar/dist-electron/main'),
      path.resolve(exeDir, '../Resources/app/dist-electron/main'),
      path.resolve(exeDir, 'resources/app.asar/dist-electron/main'),
      path.resolve(exeDir, 'resources/app/dist-electron/main'),
    );
  }
  if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/IDBots.app/Contents/Resources/app.asar/dist-electron/main',
      '/Applications/IDBots.app/Contents/Resources/app/dist-electron/main',
    );
  }
  for (const candidate of candidates) {
    if (hasHostBuild(candidate)) {
      return candidate;
    }
  }
  return distMainPath(repoRoot || REPO_ROOT);
}

/** Sum(inputs) − Sum(outputs) from a signed raw tx; null when unparseable. */
function feeFromRawTx(rawTx) {
  try {
    const { mvc } = require('meta-contract');
    const tx = new mvc.Transaction(rawTx);
    const inSum = tx.inputs.reduce((sum, input) => sum + Number(input?.output?.satoshis ?? 0), 0);
    const outSum = tx.outputs.reduce((sum, output) => sum + Number(output?.satoshis ?? 0), 0);
    return inSum >= outSum && inSum > 0 ? inSum - outSum : null;
  } catch {
    return null;
  }
}

/**
 * Open the host store + services for one CLI run.
 * @param {{userDataPath: string, metabotId: number, repoRoot?: string}} args
 */
/**
 * When nft-swap CLIs run under plain Node.js (e.g. Cowork Bash), `require('electron')`
 * resolves to the npm launcher string (path to Electron binary) rather than `{ app }`.
 * Populate a minimal CJS `app` shim before loading `dist-electron/main/*` modules.
 */
function ensurePlainNodeElectronAppShim({ userDataPath, appRoot }) {
  const exePath = process.env.IDBOTS_ELECTRON_PATH || process.execPath;
  const isPackaged = appRoot.includes('app.asar') || appRoot.includes(`${path.sep}Resources${path.sep}`);
  const shimExports = {
    app: {
      isPackaged,
      getAppPath: () => appRoot,
      getPath: (name) => (name === 'exe' ? exePath : userDataPath),
    },
  };
  try {
    const electronModuleId = require.resolve('electron', { paths: [appRoot, REPO_ROOT, __dirname] });
    const rawElectron = require(electronModuleId);
    if (typeof rawElectron === 'string' && rawElectron.length > 0) {
      const cached = require.cache[electronModuleId];
      if (cached) {
        cached.exports = {
          app: {
            ...shimExports.app,
            getPath: (name) => (name === 'exe' ? rawElectron : userDataPath),
          },
        };
      }
    }
    return;
  } catch {
    // In a packaged IDBots install, `electron` is a built-in module rather than a node_modules package.
  }
  if (!Module.__idbotsElectronShimInstalled) {
    const origLoad = Module._load;
    Module._load = function patchedLoad(request, parent, isMain) {
      if (request === 'electron') {
        return Module.__idbotsElectronShimExports || shimExports;
      }
      return origLoad.call(this, request, parent, isMain);
    };
    Module.__idbotsElectronShimInstalled = true;
  }
  Module.__idbotsElectronShimExports = shimExports;
}

export async function createHostAdapter({ userDataPath, metabotId, repoRoot = REPO_ROOT, feeRate = 1 }) {
  const distMain = resolveDistMainPath({ repoRoot });
  const appRoot = path.resolve(distMain, '../..');
  ensurePlainNodeElectronAppShim({ userDataPath, appRoot });
  let SqliteStore;
  let MetabotStore;
  let mrc721;
  let metaidCore;
  let metabotNft;
  try {
    ({ SqliteStore } = require(path.join(distMain, 'sqliteStore.js')));
    ({ MetabotStore } = require(path.join(distMain, 'metabotStore.js')));
    mrc721 = await import(pathToFileURL(path.join(distMain, 'services/mrc721Service.js')).href);
    metaidCore = await import(pathToFileURL(path.join(distMain, 'services/metaidCore.js')).href);
    metabotNft = await import(pathToFileURL(path.join(distMain, 'services/metabotNftService.js')).href);
  } catch (error) {
    throw new SwapEngineError(
      'HOST_BUILD_MISSING',
      `the IDBots Electron build is not available at ${distMain} (${error instanceof Error ? error.message : String(error)}) — a dry-run needs no build; for --broadcast build the app first`,
      { distMain },
    );
  }
  const store = await SqliteStore.create(userDataPath);
  const metabotStore = new MetabotStore(store.getDatabase(), store.getSaveFunction());

  const createPinWrapper = (id, metaidData, options) =>
    metaidCore.createPin(metabotStore, id, metaidData, {
      ...options,
      feeRate: options?.feeRate ?? feeRate,
      sponsorMode: 'self',
    });

  return {
    metabotId,

    /** Upper-bound fee estimate for the two mint pins (no broadcast). */
    async estimateMintPins({ collectionName, itemPath, display }) {
      const itemPin = mrc721.estimateMvcMrc721PinFeeSats(
        {
          operation: 'create',
          path: `/nft/mrc721/${collectionName}/${itemPath}`,
          encryption: '0',
          version: '1.0.0',
          contentType: 'application/json',
          payload: '{}',
        },
        feeRate,
      );
      const descPayload = JSON.stringify(
        mrc721.buildMrc721ItemDescContent([{ pinid: ESTIMATE_PLACEHOLDER_PINID, ...display }]),
      );
      const descPin = mrc721.estimateMvcMrc721PinFeeSats(
        {
          operation: 'create',
          path: `/nft/mrc721/${collectionName}/item_desc`,
          encryption: '0',
          version: '1.0.0',
          contentType: 'application/json',
          payload: descPayload,
        },
        feeRate,
      );
      return { feeRate, itemPinSats: itemPin, itemDescSats: descPin, totalSats: itemPin + descPin };
    },

    /** item create pin only — display rides a separate retryable item_desc pin. */
    async mintItemPin({ collectionName, itemPath }) {
      return mrc721.createMrc721Mint(
        { createPin: createPinWrapper },
        { metabotId, collectionName, itemPath, network: 'mvc', origin: 'skill:nft_swap' },
      );
    },

    async writeItemDesc({ collectionName, item }) {
      return mrc721.createMrc721ItemDescBatch(
        { createPin: createPinWrapper },
        {
          metabotId,
          collectionName,
          items: [item],
          network: 'mvc',
          origin: 'skill:nft_swap',
          settleDelayMs: 3_000,
        },
      );
    },

    async waitItemInfo({ pinId, timeoutMs }) {
      return mrc721.waitForMrc721ItemInfo({ pinId, timeoutMs, intervalMs: 5_000 });
    },

    async transferItem({ pinId, toAddress }) {
      // The NFT services expect the MetaBOT store surface (getMetabotById /
      // getMetabotWalletByMetabotId) — the app's IPC layer passes
      // getMetabotStore() here too (metabotNftIpc.ts). Passing the plain
      // SqliteStore fails at runtime with "store.getMetabotById is not a
      // function" AFTER the mint has already been broadcast.
      const result = await metabotNft.transferMetabotMrc721(metabotStore, {
        metabotId,
        pinId,
        toAddress,
        feeRate,
      });
      return {
        txId: result.txId,
        spentOutpoint: result.spentOutpoint,
        outputValue: result.outputValue,
        feeSats: null, // the transfer service does not expose the raw tx
      };
    },

    async transferLegacyToken({ genesis, codehash, tokenIndex, toAddress }) {
      const result = await metabotNft.transferMetabotMvcNft(metabotStore, {
        metabotId,
        genesis,
        codehash,
        tokenIndex,
        toAddress,
        feeRate,
      });
      return { txId: result.txId, feeSats: feeFromRawTx(result.rawTx) };
    },

    close() {
      try {
        store.close();
      } catch {
        // best-effort close; never mask the CLI result
      }
    },
  };
}
