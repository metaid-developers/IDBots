import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { MetabotStore } from '../metabotStore';
import type { SqliteDatabase } from '../sqliteTypes';
import { resolveBundledSkillsRoot } from '../libs/skillRoots';
import { formatSwapWireMessage, parseSwapWireMessage } from './swapWireProtocol';
import {
  createMrc721ItemDescBatch,
  createMrc721Mint,
  estimateMvcMrc721PinFeeSats,
  waitForMrc721ItemInfo,
} from './mrc721Service';
import { createPin } from './metaidCore';
import { transferMetabotMrc721 } from './metabotNftService';
import { uploadMetaFile } from './metaFileUploadService';

export const SWAP_STATION_POLL_INTERVAL_MS = 30_000;
export const SWAP_STATION_TRANSIENT_RETRY_MS = 60_000;
export const SWAP_STATION_MAX_TRANSIENT_ATTEMPTS = 20;

const PILOT_CONFIG_KEY = 'nft_swap_pilot_config';
const LEDGER_FILENAME = 'nft-swap-ledger.sqlite';
const TRANSIENT_ENGINE_CODES = new Set([
  'COVER_FETCH_FAILED',
  'COVER_UPLOAD_FAILED',
  'ITEM_INFO_TIMEOUT',
  'INDEX_LAG',
  'FEE_CEILING_EXCEEDED',
]);
const PERMANENT_CLAIM_CODES = new Set([
  'INVALID_CLAIM_MESSAGE',
  'SENDER_IDENTITY_MISMATCH',
  'UNKNOWN_COLLECTION',
  'SERIES_MISMATCH',
]);

const dynamicImport = new Function('specifier', 'return import(specifier);') as <T = Record<string, unknown>>(
  specifier: string,
) => Promise<T>;

export interface SwapStationPilotConfig {
  version?: number;
  metabotId: number;
  collectionName?: string;
  genesis?: string;
  codeHash?: string;
  issuerAddress?: string;
  vaultAddress?: string;
  perSwapFeeCeilingSats?: number;
  series?: Array<Record<string, unknown>>;
}

export interface SwapPendingClaimRow {
  request_id: string;
  station_metabot_id: number;
  sender_global_metaid: string;
  sender_address: string | null;
  collection_slug: string;
  raw_message: string;
  status: string;
  last_wire_type: string | null;
  last_wire_status: string | null;
  last_error: string | null;
  attempts: number;
  next_retry_at: number;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

export interface SwapLedgerLike {
  close(): void;
  pendingClaimById(requestId: string): SwapPendingClaimRow | null;
  upsertPendingClaim(input: {
    requestId: string;
    stationMetabotId: number;
    senderGlobalMetaId: string;
    senderAddress?: string | null;
    collectionSlug: string;
    rawMessage: string;
    nextRetryAt: number;
    now?: number;
  }): SwapPendingClaimRow | null;
  listDuePendingClaims(input?: {
    stationMetabotId?: number | null;
    now?: number;
    limit?: number;
  }): SwapPendingClaimRow[];
  markPendingClaimRetry(input: {
    requestId: string;
    lastWireType?: string | null;
    lastWireStatus?: string | null;
    lastError?: string | null;
    nextRetryAt: number;
    now?: number;
  }): SwapPendingClaimRow | null;
  markPendingClaimCompleted(input: {
    requestId: string;
    lastWireType?: string;
    now?: number;
  }): SwapPendingClaimRow | null;
  markPendingClaimFailed(input: {
    requestId: string;
    lastError?: string | null;
    lastWireType?: string | null;
    now?: number;
  }): SwapPendingClaimRow | null;
}

export interface HandleClaimMessageResult {
  ok: boolean;
  pending?: boolean;
  requestId: string;
  collectionSlug: string;
  replyPayload?: {
    type: string;
    status?: string;
    results?: Array<{
      tokenIndex: string;
      status: string;
      code?: string;
      error?: string;
    }>;
  };
  replyText?: string;
}

export interface SwapStationFulfillDeps {
  getMetabotStore: () => MetabotStore;
  getUserDataPath: () => string;
  getBundledSkillsRoot?: () => string;
  getFeeRate?: () => number;
  sendSwapWireMessage: (input: {
    metabotId: number;
    toGlobalMetaId: string;
    content: string;
  }) => Promise<{ txid?: string; pinId?: string }>;
  recordA2AMessage?: (input: {
    metabotId: number;
    peerGlobalMetaId: string;
    direction: 'incoming' | 'outgoing';
    content: string;
    peerName?: string | null;
    peerAvatar?: string | null;
    pinId?: string | null;
  }) => void | Promise<void>;
  openLedger?: (ledgerPath: string) => Promise<SwapLedgerLike> | SwapLedgerLike;
  handleClaimMessageFn?: (input: {
    rawMessage: string;
    ledger: SwapLedgerLike;
    deps: Record<string, unknown>;
    vaultAddressOverride?: string | null;
    broadcast: boolean;
    senderGlobalMetaId?: string | null;
    senderAddress?: string | null;
  }) => Promise<HandleClaimMessageResult>;
  createEngineDeps?: (input: {
    metabotId: number;
    vaultAddress: string;
    userDataPath: string;
    skillsRoot: string;
  }) => Promise<Record<string, unknown>>;
  now?: () => number;
  retryIntervalMs?: number;
  transientRetryMs?: number;
  maxTransientAttempts?: number;
  emitLog?: (msg: string) => void;
}

interface SwapSkillModules {
  handleClaimMessage: NonNullable<SwapStationFulfillDeps['handleClaimMessageFn']>;
  SwapLedger: new (dbPath: string) => SwapLedgerLike;
  registerSeries: (entry: Record<string, unknown>) => unknown;
  createIndexReaders: () => {
    fetchConfirmations: (txid: string) => Promise<number>;
    fetchDepositSenderAddresses: (txid: string) => Promise<string[]>;
    probeItemPath: (input: unknown) => Promise<unknown>;
    fetchCollectionInfo: (name: string) => Promise<unknown>;
    fetchItemVerify: (pinId: string) => Promise<unknown>;
    fetchItemInfo: (pinId: string) => Promise<unknown>;
  };
  waitForTransferStable: (input: unknown) => Promise<unknown>;
  fetchVaultTokenRows: (input: { address: string }) => Promise<unknown[]>;
  createCoverResolver: (input: Record<string, unknown>) => (args: unknown) => Promise<unknown>;
  ESTIMATE_PLACEHOLDER_PINID: string;
  buildMrc721ItemDescContent?: unknown;
}

function defaultSkillsRoot(): string {
  try {
    const resolved = resolveBundledSkillsRoot();
    if (resolved && fs.existsSync(path.join(resolved, 'nft-swap', 'cli', 'lib', 'claim-handler.mjs'))) {
      return resolved;
    }
  } catch {
    // Electron app may not exist in plain Node tests
  }
  const cwdCandidate = path.resolve(process.cwd(), 'SKILLs');
  if (fs.existsSync(path.join(cwdCandidate, 'nft-swap', 'cli', 'lib', 'claim-handler.mjs'))) {
    return cwdCandidate;
  }
  return path.resolve(__dirname, '../../../SKILLs');
}

function registerConfiguredSeriesFromConfig(
  config: SwapStationPilotConfig,
  registerSeries: (entry: Record<string, unknown>) => unknown,
): void {
  const list = Array.isArray(config.series) ? config.series : [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const collectionSlug = String(item.collectionSlug ?? '').trim().toLowerCase();
    const legacyGenesis = String(item.legacyGenesis ?? item.genesis ?? '').trim().toLowerCase();
    const legacyCodeHash = String(item.legacyCodeHash ?? item.codeHash ?? item.codehash ?? '').trim().toLowerCase();
    if (!collectionSlug || !legacyGenesis || !legacyCodeHash) continue;
    registerSeries({
      ...item,
      collectionSlug,
      legacyGenesis,
      legacyCodeHash,
    });
  }
}

export class SwapStationFulfillDaemon {
  private readonly db: SqliteDatabase;
  private readonly saveDb: () => void;
  private readonly deps: SwapStationFulfillDeps;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private processingQueue: Promise<unknown> = Promise.resolve();
  private cachedModules: SwapSkillModules | null = null;

  constructor(db: SqliteDatabase, saveDb: () => void, deps: SwapStationFulfillDeps) {
    this.db = db;
    this.saveDb = saveDb;
    this.deps = deps;
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private retryIntervalMs(): number {
    return this.deps.retryIntervalMs ?? SWAP_STATION_POLL_INTERVAL_MS;
  }

  private transientRetryMs(): number {
    return this.deps.transientRetryMs ?? SWAP_STATION_TRANSIENT_RETRY_MS;
  }

  private maxTransientAttempts(): number {
    return this.deps.maxTransientAttempts ?? SWAP_STATION_MAX_TRANSIENT_ATTEMPTS;
  }

  private log(msg: string): void {
    if (this.deps.emitLog) {
      this.deps.emitLog(msg);
    } else {
      console.log(msg);
    }
  }

  private readPilotConfig(): SwapStationPilotConfig | null {
    try {
      const result = this.db.exec('SELECT value FROM cowork_config WHERE key = ? LIMIT 1', [PILOT_CONFIG_KEY]);
      const raw = result[0]?.values?.[0]?.[0];
      if (typeof raw !== 'string' || !raw.trim()) return null;
      const parsed = JSON.parse(raw) as SwapStationPilotConfig;
      const metabotId = Number(parsed?.metabotId);
      if (!Number.isInteger(metabotId) || metabotId <= 0) return null;
      return { ...parsed, metabotId };
    } catch {
      return null;
    }
  }

  private getSkillsRoot(): string {
    return this.deps.getBundledSkillsRoot ? this.deps.getBundledSkillsRoot() : defaultSkillsRoot();
  }

  private async loadSkillModules(): Promise<SwapSkillModules> {
    if (this.cachedModules) {
      return this.cachedModules;
    }
    const cliLib = path.join(this.getSkillsRoot(), 'nft-swap', 'cli', 'lib');
    const [claimMod, ledgerMod, registryMod, engineMod, pollMod, coverMod] = await Promise.all([
      dynamicImport<{ handleClaimMessage: SwapSkillModules['handleClaimMessage'] }>(
        pathToFileURL(path.join(cliLib, 'claim-handler.mjs')).href,
      ),
      dynamicImport<{ SwapLedger: SwapSkillModules['SwapLedger'] }>(
        pathToFileURL(path.join(cliLib, 'swap-ledger.mjs')).href,
      ),
      dynamicImport<{ registerSeries: SwapSkillModules['registerSeries'] }>(
        pathToFileURL(path.join(cliLib, 'series-registry.mjs')).href,
      ),
      dynamicImport<{
        createIndexReaders: SwapSkillModules['createIndexReaders'];
        waitForTransferStable: SwapSkillModules['waitForTransferStable'];
        ESTIMATE_PLACEHOLDER_PINID: string;
      }>(pathToFileURL(path.join(cliLib, 'swap-engine.mjs')).href),
      dynamicImport<{ fetchVaultTokenRows: SwapSkillModules['fetchVaultTokenRows'] }>(
        pathToFileURL(path.join(cliLib, 'vault-poll-lib.mjs')).href,
      ),
      dynamicImport<{ createCoverResolver: SwapSkillModules['createCoverResolver'] }>(
        pathToFileURL(path.join(cliLib, 'cover-bridge.mjs')).href,
      ),
    ]);
    this.cachedModules = {
      handleClaimMessage: claimMod.handleClaimMessage,
      SwapLedger: ledgerMod.SwapLedger,
      registerSeries: registryMod.registerSeries,
      createIndexReaders: engineMod.createIndexReaders,
      waitForTransferStable: engineMod.waitForTransferStable,
      fetchVaultTokenRows: pollMod.fetchVaultTokenRows,
      createCoverResolver: coverMod.createCoverResolver,
      ESTIMATE_PLACEHOLDER_PINID: engineMod.ESTIMATE_PLACEHOLDER_PINID,
    };
    return this.cachedModules;
  }

  private async openLedger(userDataPath: string): Promise<SwapLedgerLike> {
    const ledgerPath = path.join(userDataPath, LEDGER_FILENAME);
    if (this.deps.openLedger) {
      return await this.deps.openLedger(ledgerPath);
    }
    const mods = await this.loadSkillModules();
    return new mods.SwapLedger(ledgerPath);
  }

  private async buildEngineDeps(config: SwapStationPilotConfig, userDataPath: string): Promise<Record<string, unknown>> {
    const metabotId = config.metabotId;
    const vaultAddress = String(config.vaultAddress || '').trim();
    if (this.deps.createEngineDeps) {
      return await this.deps.createEngineDeps({
        metabotId,
        vaultAddress,
        userDataPath,
        skillsRoot: this.getSkillsRoot(),
      });
    }

    const mods = await this.loadSkillModules();
    const readers = mods.createIndexReaders();
    const metabotStore = this.deps.getMetabotStore();
    const feeRate = this.deps.getFeeRate ? this.deps.getFeeRate() : 1;
    const createPinWrapper = (id: number, metaidData: Parameters<typeof createPin>[2], options?: { feeRate?: number; origin?: string }) =>
      createPin(metabotStore, id, metaidData, {
        ...options,
        feeRate: options?.feeRate ?? feeRate,
        sponsorMode: 'selfpay',
      });

    const coverDir = path.join(userDataPath, 'nft-swap-cover');
    const coverOutDir = path.join(coverDir, 'swap-mint-cover');
    const coverCatalogFile = path.join(coverDir, 'cover-catalog.jsonl');

    return {
      fetchConfirmations: (txid: string) => readers.fetchConfirmations(txid),
      fetchDepositSenderAddresses: (txid: string) => readers.fetchDepositSenderAddresses(txid),
      probeItemPath: (input: unknown) => readers.probeItemPath(input),
      fetchVaultRows: () => mods.fetchVaultTokenRows({ address: vaultAddress }),
      fetchCollectionInfo: (name: string) => readers.fetchCollectionInfo(name),
      fetchItemVerify: (pinId: string) => readers.fetchItemVerify(pinId),
      waitTransferStable: ({ pinId, minCount }: { pinId: string; minCount: number }) =>
        mods.waitForTransferStable({ pinId, fetchItemInfo: readers.fetchItemInfo, minCount }),
      resolveCover: mods.createCoverResolver({
        vaultAddress,
        metabotId,
        catalogFile: coverCatalogFile,
        outDir: coverOutDir,
        upload: async (uploaderId: number, image: { buffer: Buffer; sha256: string }) => {
          const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nft-swap-cover-'));
          const tmpFile = path.join(tmpDir, `cover-${image.sha256.slice(0, 12)}.png`);
          fs.writeFileSync(tmpFile, image.buffer);
          try {
            const uploaded = await uploadMetaFile(metabotStore, {
              metabotId: uploaderId,
              filePath: tmpFile,
              contentType: 'image/png',
              network: 'mvc',
              verify: true,
            });
            const pinId = String(uploaded.pinId || '').trim().toLowerCase();
            if (!/^[0-9a-f]{64}i\d+$/.test(pinId)) {
              throw new Error(`upload returned invalid pinId "${pinId}"`);
            }
            return {
              pinId,
              metafileUri: `metafile://${pinId}`,
              uploadMode: uploaded.uploadMode ?? null,
              totalCost: Number.isFinite(Number(uploaded.totalCost)) ? Number(uploaded.totalCost) : null,
              feeAssist: null,
              txids: Array.isArray(uploaded.txids) ? uploaded.txids : [],
            };
          } finally {
            try {
              fs.rmSync(tmpDir, { recursive: true, force: true });
            } catch {
              // best-effort temp cleanup
            }
          }
        },
      }),
      estimateMintPins: async ({
        collectionName,
        itemPath,
        display,
      }: {
        collectionName: string;
        itemPath: string;
        display: Record<string, unknown>;
      }) => {
        const itemPin = estimateMvcMrc721PinFeeSats(
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
        const { buildMrc721ItemDescContent } = await import('./mrc721Service');
        const descPayload = JSON.stringify(
          buildMrc721ItemDescContent([{ pinid: mods.ESTIMATE_PLACEHOLDER_PINID, ...display }]),
        );
        const descPin = estimateMvcMrc721PinFeeSats(
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
      mintItemPin: async ({ collectionName, itemPath }: { collectionName: string; itemPath: string }) =>
        createMrc721Mint(
          { createPin: createPinWrapper },
          { metabotId, collectionName, itemPath, network: 'mvc', origin: 'skill:nft_swap' },
        ),
      writeItemDesc: async ({ collectionName, item }: { collectionName: string; item: Record<string, unknown> }) =>
        createMrc721ItemDescBatch(
          { createPin: createPinWrapper },
          {
            metabotId,
            collectionName,
            items: [item as unknown as Parameters<typeof createMrc721ItemDescBatch>[1]['items'][number]],
            network: 'mvc',
            origin: 'skill:nft_swap',
            settleDelayMs: 3_000,
          },
        ),
      waitItemInfo: async ({ pinId, timeoutMs }: { pinId: string; timeoutMs?: number }) =>
        waitForMrc721ItemInfo({ pinId, timeoutMs, intervalMs: 5_000 }),
      transferItem: async ({ pinId, toAddress }: { pinId: string; toAddress: string }) => {
        const result = await transferMetabotMrc721(metabotStore, {
          metabotId,
          pinId,
          toAddress,
          feeRate,
        });
        return {
          txId: result.txId,
          spentOutpoint: result.spentOutpoint,
          outputValue: result.outputValue,
          feeSats: null,
        };
      },
    };
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.processingQueue.then(fn, fn);
    this.processingQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async safeSendAndRecord(input: {
    metabotId: number;
    toGlobalMetaId: string;
    content: string;
  }): Promise<void> {
    const sent = await this.deps.sendSwapWireMessage({
      metabotId: input.metabotId,
      toGlobalMetaId: input.toGlobalMetaId,
      content: input.content,
    });
    try {
      await this.deps.recordA2AMessage?.({
        metabotId: input.metabotId,
        peerGlobalMetaId: input.toGlobalMetaId,
        direction: 'outgoing',
        content: input.content,
        pinId: sent?.pinId ?? null,
      });
    } catch (err) {
      this.log(`[SwapStation] recordA2AMessage outgoing failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async handleIncomingClaimMessage(input: {
    metabotId: number;
    fromGlobalMetaId: string;
    plaintext: string;
    senderName?: string | null;
    senderAvatar?: string | null;
    pinId?: string | null;
  }): Promise<{
    handled: boolean;
    type?: 'SWAP_CLAIM_V1';
    requestId?: string;
    outcome?: 'pending_1_conf' | 'completed' | 'failed' | 'retrying';
  }> {
    const parsed = parseSwapWireMessage(input.plaintext);
    if (!parsed || parsed.type !== 'SWAP_CLAIM_V1') {
      return { handled: false };
    }

    const config = this.readPilotConfig();
    if (!config || config.metabotId !== input.metabotId) {
      return { handled: false };
    }

    const metabot = this.deps.getMetabotStore().getMetabotById(input.metabotId);
    if (!metabot || metabot.enabled === false) {
      return { handled: false };
    }

    try {
      await this.deps.recordA2AMessage?.({
        metabotId: input.metabotId,
        peerGlobalMetaId: input.fromGlobalMetaId,
        direction: 'incoming',
        content: input.plaintext,
        peerName: input.senderName ?? null,
        peerAvatar: input.senderAvatar ?? null,
        pinId: input.pinId ?? null,
      });
    } catch (err) {
      this.log(`[SwapStation] recordA2AMessage incoming failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    return this.enqueue(async () => {
      const userDataPath = this.deps.getUserDataPath();
      const ledger = await this.openLedger(userDataPath);
      try {
        const ts = this.now();
        ledger.upsertPendingClaim({
          requestId: parsed.requestId,
          stationMetabotId: input.metabotId,
          senderGlobalMetaId: input.fromGlobalMetaId,
          senderAddress: parsed.recipientAddress || null,
          collectionSlug: parsed.collectionSlug,
          rawMessage: input.plaintext,
          nextRetryAt: ts,
          now: ts,
        });
        const row = ledger.pendingClaimById(parsed.requestId);
        if (!row || row.status === 'completed') {
          return {
            handled: true,
            type: 'SWAP_CLAIM_V1',
            requestId: parsed.requestId,
            outcome: 'completed' as const,
          };
        }
        const outcome = await this.processClaimRow(row, config, ledger, userDataPath);
        return {
          handled: true,
          type: 'SWAP_CLAIM_V1',
          requestId: parsed.requestId,
          outcome,
        };
      } finally {
        ledger.close();
      }
    });
  }

  async processDueClaimsOnce(): Promise<{
    checked: number;
    completed: number;
    deferred: number;
    failed: number;
  }> {
    return this.enqueue(async () => {
      const config = this.readPilotConfig();
      if (!config) {
        return { checked: 0, completed: 0, deferred: 0, failed: 0 };
      }
      const metabot = this.deps.getMetabotStore().getMetabotById(config.metabotId);
      if (!metabot || metabot.enabled === false) {
        return { checked: 0, completed: 0, deferred: 0, failed: 0 };
      }

      const userDataPath = this.deps.getUserDataPath();
      const ledger = await this.openLedger(userDataPath);
      let checked = 0;
      let completed = 0;
      let deferred = 0;
      let failed = 0;
      try {
        const dueRows = ledger.listDuePendingClaims({
          stationMetabotId: config.metabotId,
          now: this.now(),
        });
        for (const row of dueRows) {
          checked += 1;
          const outcome = await this.processClaimRow(row, config, ledger, userDataPath);
          if (outcome === 'completed') completed += 1;
          else if (outcome === 'failed') failed += 1;
          else deferred += 1;
        }
      } finally {
        ledger.close();
      }
      return { checked, completed, deferred, failed };
    });
  }

  private async processClaimRow(
    row: SwapPendingClaimRow,
    config: SwapStationPilotConfig,
    ledger: SwapLedgerLike,
    userDataPath: string,
  ): Promise<'pending_1_conf' | 'completed' | 'failed' | 'retrying'> {
    const ts = this.now();
    try {
      const mods = this.deps.handleClaimMessageFn ? null : await this.loadSkillModules();
      if (mods) {
        registerConfiguredSeriesFromConfig(config, mods.registerSeries);
      }
      const handleClaimFn = this.deps.handleClaimMessageFn ?? mods!.handleClaimMessage;
      const engineDeps = await this.buildEngineDeps(config, userDataPath);

      const result = await handleClaimFn({
        rawMessage: row.raw_message,
        ledger,
        deps: engineDeps,
        vaultAddressOverride: config.vaultAddress ?? null,
        broadcast: true,
        senderGlobalMetaId: row.sender_global_metaid,
        senderAddress: null,
      });

      if (result.pending) {
        if (row.last_wire_status !== 'pending_1_conf' && result.replyText) {
          await this.safeSendAndRecord({
            metabotId: config.metabotId,
            toGlobalMetaId: row.sender_global_metaid,
            content: result.replyText,
          });
        }
        ledger.markPendingClaimRetry({
          requestId: row.request_id,
          lastWireType: 'SWAP_STATUS_V1',
          lastWireStatus: 'pending_1_conf',
          lastError: null,
          nextRetryAt: ts + this.retryIntervalMs(),
          now: ts,
        });
        this.log(`[SwapStation] Deferred claim ${row.request_id} (${row.collection_slug}) at pending_1_conf`);
        return 'pending_1_conf';
      }

      const itemResults = Array.isArray(result.replyPayload?.results) ? result.replyPayload!.results! : [];
      const transientFailure = itemResults.find(
        (item) => item.status === 'failed' && item.code && TRANSIENT_ENGINE_CODES.has(item.code),
      );
      if (transientFailure && row.attempts + 1 < this.maxTransientAttempts()) {
        ledger.markPendingClaimRetry({
          requestId: row.request_id,
          lastWireType: row.last_wire_type,
          lastWireStatus: 'retrying',
          lastError: transientFailure.error || transientFailure.code || 'transient failure',
          nextRetryAt: ts + this.transientRetryMs(),
          now: ts,
        });
        this.log(
          `[SwapStation] Retrying claim ${row.request_id} after transient ${transientFailure.code}: ${transientFailure.error || ''}`,
        );
        return 'retrying';
      }

      if (result.replyText) {
        await this.safeSendAndRecord({
          metabotId: config.metabotId,
          toGlobalMetaId: row.sender_global_metaid,
          content: result.replyText,
        });
      }
      ledger.markPendingClaimCompleted({
        requestId: row.request_id,
        lastWireType: result.replyPayload?.type ?? 'SWAP_COMPLETED_V1',
        now: ts,
      });
      this.log(`[SwapStation] Completed claim ${row.request_id} (${row.collection_slug})`);
      return 'completed';
    } catch (error) {
      const code =
        error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code ?? '') : '';
      const message = error instanceof Error ? error.message : String(error);
      const isPermanent = PERMANENT_CLAIM_CODES.has(code) || row.attempts + 1 >= this.maxTransientAttempts();

      if (isPermanent) {
        const failReply = formatSwapWireMessage({
          type: 'SWAP_STATUS_V1',
          requestId: row.request_id,
          collectionSlug: row.collection_slug,
          status: 'failed',
          note: message,
        });
        try {
          await this.safeSendAndRecord({
            metabotId: config.metabotId,
            toGlobalMetaId: row.sender_global_metaid,
            content: failReply,
          });
        } catch (sendErr) {
          this.log(
            `[SwapStation] Failed to send failure status for ${row.request_id}: ${sendErr instanceof Error ? sendErr.message : String(sendErr)}`,
          );
        }
        ledger.markPendingClaimFailed({
          requestId: row.request_id,
          lastWireType: 'SWAP_STATUS_V1',
          lastError: message,
          now: ts,
        });
        this.log(`[SwapStation] Claim ${row.request_id} failed permanently (${code || 'ERROR'}): ${message}`);
        return 'failed';
      }

      ledger.markPendingClaimRetry({
        requestId: row.request_id,
        lastWireType: row.last_wire_type,
        lastWireStatus: 'retrying',
        lastError: message,
        nextRetryAt: ts + this.transientRetryMs(),
        now: ts,
      });
      this.log(`[SwapStation] Claim ${row.request_id} transient error, scheduled retry: ${message}`);
      return 'retrying';
    }
  }

  startPolling(intervalMs = SWAP_STATION_POLL_INTERVAL_MS): void {
    this.stopPolling();
    const timer = setInterval(() => {
      void this.processDueClaimsOnce().catch((err) => {
        this.log(`[SwapStation] poll error: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, intervalMs);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
    this.pollTimer = timer;
  }

  stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }
}
