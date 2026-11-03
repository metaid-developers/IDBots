import { createPin } from './metaidCore';
import { buildModifyMetaidPayload } from './metaidPinMutationService';
import { getRate as getGlobalFeeRate } from './feeRateStore';
import { syncUserBotsToMobile } from './userBotsPinService';
import { deriveBackupKey, objectId } from './chainBackupCrypto';
import {
  extractBackupObjects,
  readChainBackupState,
  writeChainBackupState,
  type ChainBackupSegmentRef,
} from './chainBackupData';
import {
  buildManifestContent,
  buildObjectPinContent,
  chainBackupSegmentRefKey,
  packSegments,
} from './chainBackupSegments';
import {
  CHAIN_BACKUP_MANIFEST_PATH,
  CHAIN_BACKUP_OBJECT_PATH,
} from './chainBackupProtocol';
import {
  ChainBackupPausedError,
  computeBackupRetryDelayMs,
  fetchChainBackupManifestState,
  findPublishedSegmentPin,
  isChainBackupNetworkError,
} from './chainBackupPublication';
import {
  createChainBackupRun,
  ensureChainBackupRunSchema,
  getActiveChainBackupRun,
  getChainBackupSegmentUpload,
  saveChainBackupRun,
  saveChainBackupSegmentUpload,
  type ChainBackupRunRow,
  type ChainBackupSegmentUploadRow,
} from './chainBackupRunStore';
import type { SqliteDatabase } from '../sqliteTypes';
import type { MetabotStore } from '../metabotStore';
import type { UserIdentityStore } from '../userIdentityStore';
import type { Metabot } from '../types/metabot';

export { listChainBackupStates, type ChainBackupStateRow } from './chainBackupData';
export type { ChainBackupSegmentRef } from './chainBackupData';
export { buildManifestContent, buildObjectPinContent } from './chainBackupSegments';
export {
  CHAIN_BACKUP_OBJECT_PATH,
  CHAIN_BACKUP_MANIFEST_PATH,
  CHAIN_BACKUP_VERSION,
  CHAIN_BACKUP_CIPHER,
  CHAIN_BACKUP_KDF,
  CHAIN_BACKUP_ENCODING_GZIP,
  CHAIN_BACKUP_SEGMENT_PLAINTEXT_LIMIT,
} from './chainBackupProtocol';

const DEFAULT_NETWORK_ATTEMPTS = 4;
const RECONCILE_MISS_CONFIRMATIONS = 2;

export interface ChainBackupProgress {
  phase: 'extract' | 'publish' | 'manifest' | 'done' | 'error';
  botName?: string;
  botIndex?: number;
  botCount?: number;
  segmentsDone?: number;
  segmentsTotal?: number;
  resumedSegments?: number;
  retryAttempt?: number;
  retryDelayMs?: number;
  message?: string;
}

export interface ChainBackupBotResult {
  globalMetaId: string;
  name: string;
  uploadedObjects: number;
  skippedObjects: number;
  segments: number;
  resumedSegments: number;
  networkRetries: number;
  bytes: number;
  costSats: number;
  manifestPinId?: string;
  error?: string;
}

export interface ChainBackupResult {
  success: boolean;
  resumable?: boolean;
  bots: ChainBackupBotResult[];
  totalBytes: number;
  totalCostSats: number;
  discoveryNetworkRetries?: number;
  botsManifestSynced?: boolean;
  botsManifestError?: string;
  error?: string;
}

export interface RunChainBackupDeps {
  db: SqliteDatabase;
  metabotStore: MetabotStore;
  userStore: UserIdentityStore;
  saveDb?: () => void;
  onProgress?: (progress: ChainBackupProgress) => void;
  createPinImpl?: typeof createPin;
  syncBotsManifestImpl?: typeof syncUserBotsToMobile;
  findPublishedSegmentPinImpl?: typeof findPublishedSegmentPin;
  fetchManifestStateImpl?: typeof fetchChainBackupManifestState;
  maxNetworkAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function refFromUpload(row: ChainBackupSegmentUploadRow): ChainBackupSegmentRef {
  if (!row.pin_id) throw new Error(`segment ${row.segment_key} has no published pin`);
  return {
    pinId: row.pin_id,
    segment: row.segment_hash,
    segmentKey: row.segment_key,
    bytes: row.bytes,
    kinds: parseStringArray(row.kinds_json),
    objectIds: parseStringArray(row.object_ids_json),
  };
}

function normalizeSegmentRefs(botGlobalMetaId: string, refs: ChainBackupSegmentRef[]): ChainBackupSegmentRef[] {
  const seen = new Set<string>();
  const normalized: ChainBackupSegmentRef[] = [];
  for (const ref of refs) {
    const key = ref.pinId || ref.segment;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    normalized.push({ ...ref, segmentKey: chainBackupSegmentRefKey(botGlobalMetaId, ref) });
  }
  return normalized;
}

function manifestHash(content: string): string {
  return objectId(JSON.parse(content));
}

async function syncDiscoveryWithRetry(
  deps: RunChainBackupDeps,
  syncBotsManifest: typeof syncUserBotsToMobile,
  maxAttempts: number,
  sleep: (ms: number) => Promise<void>,
): Promise<{ success: boolean; error?: string; resumable: boolean; retries: number }> {
  let retries = 0;
  while (true) {
    try {
      const sync = await syncBotsManifest(deps.userStore, deps.metabotStore);
      if (sync.success) return { success: true, resumable: false, retries };
      const message = sync.error ?? 'BOTS_MANIFEST_SYNC_FAILED';
      if (!isChainBackupNetworkError(new Error(message))) {
        return { success: false, error: message, resumable: false, retries };
      }
      retries += 1;
      if (retries >= maxAttempts) return { success: false, error: message, resumable: true, retries };
      const delay = computeBackupRetryDelayMs(retries);
      deps.onProgress?.({ phase: 'manifest', retryAttempt: retries, retryDelayMs: delay });
      await sleep(delay);
    } catch (error) {
      const message = errorMessage(error);
      if (!isChainBackupNetworkError(error)) {
        return { success: false, error: message, resumable: false, retries };
      }
      retries += 1;
      if (retries >= maxAttempts) return { success: false, error: message, resumable: true, retries };
      const delay = computeBackupRetryDelayMs(retries);
      deps.onProgress?.({ phase: 'manifest', retryAttempt: retries, retryDelayMs: delay });
      await sleep(delay);
    }
  }
}

export async function runChainBackup(deps: RunChainBackupDeps): Promise<ChainBackupResult> {
  const { db, metabotStore, userStore } = deps;
  const createPinFn = deps.createPinImpl ?? createPin;
  const syncBotsManifest = deps.syncBotsManifestImpl ?? syncUserBotsToMobile;
  const findSegmentPin = deps.findPublishedSegmentPinImpl ?? findPublishedSegmentPin;
  const fetchManifestState = deps.fetchManifestStateImpl ?? fetchChainBackupManifestState;
  const sleep = deps.sleep ?? defaultSleep;
  const maxAttempts = Math.max(1, Math.floor(deps.maxNetworkAttempts ?? DEFAULT_NETWORK_ATTEMPTS));
  const emit = (progress: ChainBackupProgress) => deps.onProgress?.(progress);

  const identity = userStore.get();
  if (!identity?.mnemonic || !identity.globalmetaid?.trim()) {
    return { success: false, bots: [], totalBytes: 0, totalCostSats: 0, error: 'USER_IDENTITY_MISSING' };
  }
  ensureChainBackupRunSchema(db);
  const backupKey = deriveBackupKey(identity.mnemonic, identity.globalmetaid.trim());
  const discovery = await syncDiscoveryWithRetry(deps, syncBotsManifest, maxAttempts, sleep);

  const bots = metabotStore
    .listMetabots()
    .filter((bot) => bot.metabot_type !== 'welcome' && (bot.globalmetaid ?? '').trim());
  const result: ChainBackupResult = {
    success: true,
    resumable: discovery.resumable,
    bots: [],
    totalBytes: 0,
    totalCostSats: 0,
    discoveryNetworkRetries: discovery.retries,
  };
  const feeRate = getGlobalFeeRate('mvc');

  for (let i = 0; i < bots.length; i += 1) {
    const bot: Metabot = bots[i];
    const botGid = (bot.globalmetaid ?? '').trim();
    const botResult: ChainBackupBotResult = {
      globalMetaId: botGid,
      name: bot.name,
      uploadedObjects: 0,
      skippedObjects: 0,
      segments: 0,
      resumedSegments: 0,
      networkRetries: 0,
      bytes: 0,
      costSats: 0,
    };
    result.bots.push(botResult);
    let run: ChainBackupRunRow | null = null;
    try {
      emit({ phase: 'extract', botName: bot.name, botIndex: i, botCount: bots.length });
      const wallet = metabotStore.getMetabotWalletByMetabotId(bot.id);
      const objects = extractBackupObjects(db, bot.id, wallet, {
        bot,
        includeShared: bot.metabot_type === 'twin',
      });
      const state = readChainBackupState(db, botGid);
      const alreadyUploaded = new Set<string>(parseStringArray(state?.uploaded_object_ids_json || '[]'));
      const previousSegments = normalizeSegmentRefs(
        botGid,
        state ? JSON.parse(state.segments_json || '[]') as ChainBackupSegmentRef[] : [],
      );
      const newObjects = objects.filter((obj) => !alreadyUploaded.has(obj.id));
      botResult.skippedObjects = objects.length - newObjects.length;
      const planHash = objectId({
        newObjectIds: newObjects.map((obj) => obj.id),
        previousSegments: previousSegments.map((ref) => ({
          pinId: ref.pinId,
          segment: ref.segment,
          segmentKey: ref.segmentKey,
          objectIds: ref.objectIds,
        })),
      });

      run = getActiveChainBackupRun(db, botGid, planHash)
        ?? createChainBackupRun(db, { botGlobalMetaId: botGid, planHash, totalSegments: 0 });
      const segments = packSegments(botGid, newObjects, Math.floor(run.created_at / 1000));
      run.total_segments = segments.length;
      run.last_error = null;
      saveChainBackupRun(db, run);
      deps.saveDb?.();

      const newSegmentRefs: ChainBackupSegmentRef[] = [];
      emit({
        phase: 'publish',
        botName: bot.name,
        botIndex: i,
        botCount: bots.length,
        segmentsDone: 0,
        segmentsTotal: segments.length,
        resumedSegments: 0,
      });

      for (let s = 0; s < segments.length; s += 1) {
        const packed = segments[s];
        let upload = getChainBackupSegmentUpload(db, botGid, packed.segmentKey);
        if (upload?.status === 'published' && upload.pin_id) {
          upload.run_id = run.run_id;
          saveChainBackupSegmentUpload(db, upload);
          newSegmentRefs.push(refFromUpload(upload));
          botResult.resumedSegments += 1;
        } else {
          const plaintextCreatedAt = upload?.plaintext_created_at ?? Number(packed.plaintext.createdAt);
          const plaintext = { ...packed.plaintext, createdAt: plaintextCreatedAt };
          const segmentHash = objectId(plaintext);
          upload = upload ?? {
            bot_globalmetaid: botGid,
            segment_key: packed.segmentKey,
            run_id: run.run_id,
            segment_hash: segmentHash,
            pin_id: null,
            status: 'pending',
            object_ids_json: JSON.stringify(packed.journalObjectIds),
            kinds_json: JSON.stringify([...new Set(packed.objects.map((obj) => obj.kind))]),
            plaintext_created_at: plaintextCreatedAt,
            bytes: 0,
            attempt_count: 0,
            last_error: null,
            created_at: Date.now(),
            updated_at: Date.now(),
          };
          upload.run_id = run.run_id;
          upload.segment_hash = segmentHash;
          upload.object_ids_json = JSON.stringify(packed.journalObjectIds);
          upload.kinds_json = JSON.stringify([...new Set(packed.objects.map((obj) => obj.kind))]);
          upload.plaintext_created_at = plaintextCreatedAt;
          saveChainBackupSegmentUpload(db, upload);
          deps.saveDb?.();

          let retries = 0;
          let reconcileMisses = 0;
          while (true) {
            try {
              if (upload.attempt_count > 0) {
                const existing = await findSegmentPin({
                  mvcAddress: bot.mvc_address,
                  botGlobalMetaId: botGid,
                  segmentKey: packed.segmentKey,
                  segmentHash,
                });
                if (existing) {
                  upload.status = 'published';
                  upload.pin_id = existing.pinId;
                  upload.last_error = null;
                  if (!upload.bytes) upload.bytes = Buffer.byteLength(buildObjectPinContent(backupKey, botGid, plaintext, packed.segmentKey), 'utf8');
                  saveChainBackupSegmentUpload(db, upload);
                  deps.saveDb?.();
                  newSegmentRefs.push(refFromUpload(upload));
                  botResult.resumedSegments += 1;
                  break;
                }
                reconcileMisses += 1;
                if (reconcileMisses < RECONCILE_MISS_CONFIRMATIONS) {
                  const delay = computeBackupRetryDelayMs(reconcileMisses);
                  emit({
                    phase: 'publish',
                    botName: bot.name,
                    botIndex: i,
                    botCount: bots.length,
                    segmentsDone: s,
                    segmentsTotal: segments.length,
                    retryAttempt: reconcileMisses,
                    retryDelayMs: delay,
                  });
                  await sleep(delay);
                  continue;
                }
              }

              upload.status = 'uploading';
              upload.attempt_count += 1;
              upload.last_error = null;
              saveChainBackupSegmentUpload(db, upload);
              deps.saveDb?.();
              const content = buildObjectPinContent(backupKey, botGid, plaintext, packed.segmentKey);
              const pin = await createPinFn(metabotStore, bot.id, {
                operation: 'create',
                path: CHAIN_BACKUP_OBJECT_PATH,
                encryption: '0',
                version: '1.0.0',
                contentType: 'application/json',
                payload: content,
              }, { feeRate, origin: 'internal:chain-backup' });
              upload.status = 'published';
              upload.pin_id = pin.pinId;
              upload.bytes = Buffer.byteLength(content, 'utf8');
              upload.last_error = null;
              saveChainBackupSegmentUpload(db, upload);
              deps.saveDb?.();
              newSegmentRefs.push(refFromUpload(upload));
              botResult.segments += 1;
              botResult.bytes += upload.bytes;
              botResult.costSats += pin.totalCost || 0;
              break;
            } catch (error) {
              const message = errorMessage(error);
              upload.status = 'pending';
              upload.last_error = message;
              saveChainBackupSegmentUpload(db, upload);
              deps.saveDb?.();
              if (!isChainBackupNetworkError(error)) throw error;
              retries += 1;
              botResult.networkRetries += 1;
              if (retries >= maxAttempts) throw new ChainBackupPausedError(message);
              const delay = computeBackupRetryDelayMs(retries);
              emit({
                phase: 'publish',
                botName: bot.name,
                botIndex: i,
                botCount: bots.length,
                segmentsDone: s,
                segmentsTotal: segments.length,
                retryAttempt: retries,
                retryDelayMs: delay,
              });
              await sleep(delay);
            }
          }
        }
        run.published_segments = newSegmentRefs.length;
        saveChainBackupRun(db, run);
        deps.saveDb?.();
        emit({
          phase: 'publish',
          botName: bot.name,
          botIndex: i,
          botCount: bots.length,
          segmentsDone: s + 1,
          segmentsTotal: segments.length,
          resumedSegments: botResult.resumedSegments,
        });
        if (s + 1 < segments.length) await sleep(500);
      }

      const allSegments = normalizeSegmentRefs(botGid, [...previousSegments, ...newSegmentRefs]);
      const manifestContent = buildManifestContent({
        botGlobalMetaId: botGid,
        botName: bot.name,
        segments: allSegments,
        updatedAt: Math.floor(run.created_at / 1000),
      });
      const expectedManifestHash = manifestHash(manifestContent);
      run.manifest_hash = expectedManifestHash;
      run.manifest_target_pinid = run.manifest_target_pinid ?? run.manifest_pinid ?? state?.manifest_pinid ?? null;
      run.published_segments = segments.length;
      saveChainBackupRun(db, run);
      deps.saveDb?.();
      emit({ phase: 'manifest', botName: bot.name, botIndex: i, botCount: bots.length });

      let manifestPinId = '';
      let manifestRetries = 0;
      let manifestReconcileMisses = 0;
      while (true) {
        try {
          if (run.manifest_attempts > 0) {
            const current = await fetchManifestState({
              mvcAddress: bot.mvc_address,
              botGlobalMetaId: botGid,
            });
            if (current && manifestHash(current.content) === expectedManifestHash) {
              manifestPinId = current.pinId;
              break;
            }
            manifestReconcileMisses += 1;
            if (manifestReconcileMisses < RECONCILE_MISS_CONFIRMATIONS) {
              const delay = computeBackupRetryDelayMs(manifestReconcileMisses);
              emit({
                phase: 'manifest',
                botName: bot.name,
                botIndex: i,
                botCount: bots.length,
                retryAttempt: manifestReconcileMisses,
                retryDelayMs: delay,
              });
              await sleep(delay);
              continue;
            }
            if (current) {
              run.manifest_target_pinid = current.pinId;
              saveChainBackupRun(db, run);
              deps.saveDb?.();
            }
          }

          run.manifest_attempts += 1;
          saveChainBackupRun(db, run);
          deps.saveDb?.();
          if (run.manifest_target_pinid) {
            const modified = await createPinFn(
              metabotStore,
              bot.id,
              buildModifyMetaidPayload({ targetPinId: run.manifest_target_pinid, payload: manifestContent }),
              { feeRate, origin: 'internal:chain-backup' },
            );
            manifestPinId = modified.pinId?.trim() || run.manifest_target_pinid;
            botResult.costSats += modified.totalCost || 0;
          } else {
            const created = await createPinFn(metabotStore, bot.id, {
              operation: 'create',
              path: CHAIN_BACKUP_MANIFEST_PATH,
              encryption: '0',
              version: '1.0.0',
              contentType: 'application/json',
              payload: manifestContent,
            }, { feeRate, origin: 'internal:chain-backup' });
            manifestPinId = created.pinId;
            botResult.costSats += created.totalCost || 0;
          }
          break;
        } catch (error) {
          const message = errorMessage(error);
          run.last_error = message;
          saveChainBackupRun(db, run);
          deps.saveDb?.();
          if (!isChainBackupNetworkError(error)) throw error;
          manifestRetries += 1;
          botResult.networkRetries += 1;
          if (manifestRetries >= maxAttempts) throw new ChainBackupPausedError(message);
          const delay = computeBackupRetryDelayMs(manifestRetries);
          emit({
            phase: 'manifest',
            botName: bot.name,
            botIndex: i,
            botCount: bots.length,
            retryAttempt: manifestRetries,
            retryDelayMs: delay,
          });
          await sleep(delay);
        }
      }

      run.manifest_pinid = manifestPinId;
      run.status = 'complete';
      run.last_error = null;
      saveChainBackupRun(db, run);
      writeChainBackupState(db, {
        botGlobalMetaId: botGid,
        manifestPinId,
        segments: allSegments,
        uploadedObjectIds: [
          ...alreadyUploaded,
          ...newObjects.filter((obj) => !alreadyUploaded.has(obj.id)).map((obj) => obj.id),
        ],
        lastBackupAt: Date.now(),
      });
      deps.saveDb?.();

      botResult.uploadedObjects = newObjects.length;
      botResult.manifestPinId = manifestPinId;
      result.totalBytes += botResult.bytes;
      result.totalCostSats += botResult.costSats;
    } catch (error) {
      const paused = error instanceof ChainBackupPausedError;
      botResult.error = paused ? 'BACKUP_NETWORK_PAUSED' : errorMessage(error);
      if (run) {
        run.last_error = botResult.error;
        saveChainBackupRun(db, run);
        deps.saveDb?.();
      }
      if (paused) result.resumable = true;
      result.success = false;
      emit({ phase: 'error', botName: bot.name, botIndex: i, botCount: bots.length, message: botResult.error });
    }
  }

  result.botsManifestSynced = discovery.success;
  result.botsManifestError = discovery.error;
  if (!discovery.success) {
    result.success = false;
    result.error = discovery.error ?? 'BOTS_MANIFEST_SYNC_FAILED';
    if (discovery.resumable) result.resumable = true;
  }
  emit({ phase: 'done', botCount: bots.length });
  return result;
}
