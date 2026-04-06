import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomBytes } from 'crypto';
import { spawn } from 'child_process';
import Module from 'module';
import { APP_NAME } from '../appConstants';
import {
  buildGigSquareServicePayload,
  type GigSquareLocalServiceMutationRecord,
  type GigSquareModifyDraft,
  type GigSquareServicePayload,
} from '../services/gigSquareServiceMutationService';
import {
  buildDelegationOrderPayload,
} from '../services/delegationOrderMessage';
import {
  buildRemoteSkillServiceUpsertStatement,
  isRemoteSkillServiceListSemanticMiss,
  parseRemoteSkillServiceRow,
  type ParsedRemoteSkillServiceRow,
  type RemoteSkillServicePage,
} from '../services/gigSquareRemoteServiceSync';
import { fetchJsonWithFallbackOnMiss } from '../services/localIndexerProxy';
import { HeartbeatPollingService, fetchHeartbeatFromChain } from '../services/heartbeatPollingService';
import { fetchLocalPresenceSnapshot } from '../services/p2pPresenceClient';
import { getP2PLocalBase } from '../services/p2pLocalEndpoint';
import { ProviderDiscoveryService } from '../services/providerDiscoveryService';
import { buildOrderPrompts } from '../services/orderPromptBuilder';
import { ServiceOrderStore } from '../serviceOrderStore';
import { ServiceOrderLifecycleService } from '../services/serviceOrderLifecycleService';
import { normalizeServiceRequestContract, type ServiceRequestContract } from './contracts';
import { MetabotDaemon } from './metabotDaemon';
import type { HostSessionAdapter, ProviderSessionResult, StartProviderSessionInput } from './hostSessionAdapter';
import { publishPortableService } from './servicePublishRuntime';
import { listCallablePortableServices, syncPortableServiceCatalog } from './serviceDiscoveryRuntime';
import { writePortableServiceRequest } from './serviceRequestRuntime';
import {
  buildProviderWakeUpEnvelope,
  normalizeProviderWakeUpEnvelope,
  type ProviderDeliveryEnvelope,
  type ProviderWakeUpEnvelope,
  type RequestWriteRecord,
} from './transportRuntime';

const GIG_SQUARE_SERVICE_PATH = '/protocols/skill-service';
const MANAPI_PIN_PATH_LIST_URL = 'https://manapi.metaid.io/pin/path/list';
const METABOT_RUNTIME_FIXTURE_STATE = 'METABOT_RUNTIME_FIXTURE_STATE';
const METABOT_RUNTIME_USER_DATA = 'METABOT_RUNTIME_USER_DATA';
const METABOT_RUNTIME_USE_DEFAULT_USER_DATA = 'METABOT_RUNTIME_USE_DEFAULT_USER_DATA';
const METABOT_PROVIDER_COMMAND = 'METABOT_PROVIDER_COMMAND';
const METABOT_PROVIDER_ARGS_JSON = 'METABOT_PROVIDER_ARGS_JSON';

export interface RuntimeExecutionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface RuntimeExecutionIO {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdinText?: string;
}

interface ParsedCliInput {
  command: string | null;
  options: Record<string, string | boolean>;
  positionals: string[];
}

interface FixturePinRecord {
  pinId: string;
  txids: string[];
  metabotId: number;
  path: string;
  payload: string;
}

interface FixtureRequestRecord {
  request: ServiceRequestContract;
  requestWrite: RequestWriteRecord;
  providerWakeUp: ProviderWakeUpEnvelope;
}

interface FixtureState {
  version: 1;
  nextSequence: number;
  pins: FixturePinRecord[];
  localServices: GigSquareLocalServiceMutationRecord[];
  remoteServiceItems: Record<string, unknown>[];
  mirroredServices: ParsedRemoteSkillServiceRow[];
  requests: FixtureRequestRecord[];
  deliveries: ProviderDeliveryEnvelope[];
  orders: Array<Record<string, unknown>>;
}

interface ResolvedServiceEntry {
  pinId: string;
  serviceName: string;
  displayName: string;
  description: string;
  providerSkill: string;
  providerGlobalMetaId: string;
  price: string;
  currency: string;
  paymentAddress: string;
  metabotId?: number | null;
  payloadJson?: string;
}

interface DefaultRuntimeContext {
  db: {
    exec(sql: string, params?: Array<string | number | null>): Array<{ columns: string[]; values: unknown[][] }>;
    run(sql: string, params?: Array<string | number | null>): void;
  };
  save: () => void;
  metabotStore: {
    getMetabotById(id: number): any;
    getMetabotByGlobalMetaId(globalMetaId: string): any;
  };
  createPin: (
    metabotId: number,
    pinInput: {
      operation: 'create';
      path: string;
      encryption: '0';
      version: '1.0.0';
      contentType: 'application/json';
      payload: string;
    },
  ) => Promise<{ pinId: string; txids: string[] }>;
  serviceOrderLifecycle: ServiceOrderLifecycleService;
}

const EMPTY_FIXTURE_STATE: FixtureState = {
  version: 1,
  nextSequence: 1,
  pins: [],
  localServices: [],
  remoteServiceItems: [],
  mirroredServices: [],
  requests: [],
  deliveries: [],
  orders: [],
};

let electronShimInstalled = false;
let electronShimEnv: NodeJS.ProcessEnv = process.env;

function toSafeString(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (value == null) return '';
  return String(value).trim();
}

function toSafeNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeCurrency(value: unknown): string {
  const normalized = toSafeString(value).toUpperCase();
  return normalized === 'MVC' ? 'SPACE' : (normalized || 'SPACE');
}

function normalizePaymentChain(value: unknown): 'mvc' | 'btc' | 'doge' {
  const normalized = toSafeString(value).toLowerCase();
  if (normalized === 'btc' || normalized === 'doge' || normalized === 'mvc') {
    return normalized;
  }
  if (normalized === 'space') return 'mvc';
  return 'mvc';
}

function sanitizeDbParams(params: unknown[]): Array<string | number | null> {
  return params.map((value) => {
    if (value == null) return null;
    if (typeof value === 'number' && Number.isNaN(value)) return null;
    return value as string | number | null;
  });
}

function buildJsonResult(data: unknown): RuntimeExecutionResult {
  return {
    exitCode: 0,
    stdout: `${JSON.stringify(data, null, 2)}\n`,
    stderr: '',
  };
}

function buildErrorResult(message: string): RuntimeExecutionResult {
  return {
    exitCode: 1,
    stdout: '',
    stderr: `${message}\n`,
  };
}

function parseCliInput(argv: string[]): ParsedCliInput {
  const options: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  let command: string | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      if (!command) {
        command = token;
      } else {
        positionals.push(token);
      }
      continue;
    }

    const stripped = token.slice(2);
    const [rawKey, inlineValue] = stripped.split('=', 2);
    const nextToken = argv[index + 1];
    if (inlineValue !== undefined) {
      options[rawKey] = inlineValue;
      continue;
    }
    if (nextToken && !nextToken.startsWith('--')) {
      options[rawKey] = nextToken;
      index += 1;
      continue;
    }
    options[rawKey] = true;
  }

  return { command, options, positionals };
}

function getOptionString(options: Record<string, string | boolean>, key: string, fallback = ''): string {
  const value = options[key];
  if (typeof value === 'string') return value.trim();
  return fallback;
}

function getOptionBoolean(options: Record<string, string | boolean>, key: string): boolean {
  return options[key] === true;
}

function getOptionNumber(options: Record<string, string | boolean>, key: string, fallback = 0): number {
  const value = options[key];
  return typeof value === 'string' ? toSafeNumber(value, fallback) : fallback;
}

function buildHelpText(): string {
  return [
    'metabot-cli',
    '',
    'Commands:',
    '  publish-service   Publish one local service into the MetaWeb truth layer',
    '  list-services     Sync and list callable remote services',
    '  request-service   Write an order request and emit provider_wakeup',
    '  run-daemon        Describe the JSONL provider_wakeup/provider_delivery protocol',
    '',
    `Fixture mode: set ${METABOT_RUNTIME_FIXTURE_STATE}=/path/to/state.json`,
    `Default mode: set ${METABOT_RUNTIME_USER_DATA}=/path/to/IDBots/userData or pass --use-default-user-data`,
  ].join('\n');
}

function loadFixtureState(filePath: string): FixtureState {
  if (!fs.existsSync(filePath)) {
    return { ...EMPTY_FIXTURE_STATE };
  }
  let raw: Partial<FixtureState>;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<FixtureState>;
  } catch (error) {
    throw new Error(
      `Failed to read fixture state ${filePath}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  return {
    version: 1,
    nextSequence: Math.max(1, Math.trunc(toSafeNumber(raw.nextSequence, 1))),
    pins: Array.isArray(raw.pins) ? raw.pins as FixturePinRecord[] : [],
    localServices: Array.isArray(raw.localServices) ? raw.localServices as GigSquareLocalServiceMutationRecord[] : [],
    remoteServiceItems: Array.isArray(raw.remoteServiceItems) ? raw.remoteServiceItems as Record<string, unknown>[] : [],
    mirroredServices: Array.isArray(raw.mirroredServices) ? raw.mirroredServices as ParsedRemoteSkillServiceRow[] : [],
    requests: Array.isArray(raw.requests) ? raw.requests as FixtureRequestRecord[] : [],
    deliveries: Array.isArray(raw.deliveries) ? raw.deliveries as ProviderDeliveryEnvelope[] : [],
    orders: Array.isArray(raw.orders) ? raw.orders as Array<Record<string, unknown>> : [],
  };
}

function saveFixtureState(filePath: string, state: FixtureState): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2));
}

function allocateFixtureTxid(state: FixtureState): string {
  const txid = state.nextSequence.toString(16).padStart(64, '0').slice(-64);
  state.nextSequence += 1;
  return txid;
}

function appendOrReplaceByKey<T, K extends keyof T>(items: T[], key: K, nextItem: T): T[] {
  const nextKey = String((nextItem as Record<string, unknown>)[String(key)] ?? '');
  const existingIndex = items.findIndex((item) => (
    String((item as Record<string, unknown>)[String(key)] ?? '') === nextKey
  ));
  if (existingIndex >= 0) {
    const clone = items.slice();
    clone[existingIndex] = nextItem;
    return clone;
  }
  return [...items, nextItem];
}

function buildFixtureRemoteServiceItem(
  pinId: string,
  payload: GigSquareServicePayload,
  providerGlobalMetaId: string,
): Record<string, unknown> {
  return {
    id: pinId,
    status: 1,
    operation: 'create',
    timestamp: Date.now(),
    metaid: providerGlobalMetaId || `fixture-metaid-${pinId}`,
    globalMetaId: providerGlobalMetaId,
    address: payload.paymentAddress || `fixture-address-${pinId}`,
    createAddress: payload.paymentAddress || `fixture-address-${pinId}`,
    contentSummary: payload,
  };
}

function resolveFixtureServiceEntry(state: FixtureState, servicePinId: string): ResolvedServiceEntry | null {
  const normalizedPinId = toSafeString(servicePinId);
  const local = state.localServices.find((item) => {
    return [
      toSafeString(item.id),
      toSafeString(item.pinId),
      toSafeString(item.sourceServicePinId),
      toSafeString(item.currentPinId),
    ].includes(normalizedPinId);
  });
  if (local) {
    const payload = (() => {
      try {
        return JSON.parse(local.payloadJson) as GigSquareServicePayload;
      } catch {
        return null;
      }
    })();
    return {
      pinId: normalizedPinId,
      serviceName: toSafeString(local.serviceName),
      displayName: toSafeString(local.displayName),
      description: toSafeString(local.description),
      providerSkill: toSafeString(local.providerSkill),
      providerGlobalMetaId: toSafeString(local.providerGlobalMetaId),
      price: toSafeString(local.price) || '0',
      currency: normalizeCurrency(local.currency),
      paymentAddress: toSafeString(payload?.paymentAddress),
      metabotId: local.metabotId,
      payloadJson: local.payloadJson,
    };
  }

  const remote = state.mirroredServices.find((item) => {
    return [
      toSafeString(item.id),
      toSafeString(item.pinId),
      toSafeString(item.sourceServicePinId),
    ].includes(normalizedPinId);
  });
  if (!remote) return null;
  return {
    pinId: normalizedPinId,
    serviceName: toSafeString(remote.serviceName),
    displayName: toSafeString(remote.displayName),
    description: toSafeString(remote.description),
    providerSkill: toSafeString(remote.providerSkill),
    providerGlobalMetaId: toSafeString(remote.providerGlobalMetaId),
    price: toSafeString(remote.price) || '0',
    currency: normalizeCurrency(remote.currency),
    paymentAddress: toSafeString(remote.paymentAddress),
    metabotId: null,
  };
}

async function withFixtureState<T>(
  filePath: string,
  callback: (state: FixtureState) => Promise<T>,
): Promise<T> {
  const state = loadFixtureState(filePath);
  const result = await callback(state);
  saveFixtureState(filePath, state);
  return result;
}

function resolveRepoRoot(): string {
  return path.resolve(__dirname, '../..');
}

function resolvePlatformUserDataPath(): string {
  const home = os.homedir();
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', APP_NAME);
  }
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), APP_NAME);
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), APP_NAME);
}

function resolveNodeUserDataPath(env: NodeJS.ProcessEnv): string {
  const override = toSafeString(env[METABOT_RUNTIME_USER_DATA]);
  if (override) return path.resolve(override);
  if (toSafeString(env[METABOT_RUNTIME_USE_DEFAULT_USER_DATA]) === '1') {
    return resolvePlatformUserDataPath();
  }
  throw new Error(
    `Default mode requires ${METABOT_RUNTIME_USER_DATA} or ${METABOT_RUNTIME_USE_DEFAULT_USER_DATA}=1`
  );
}

function installElectronShim(env: NodeJS.ProcessEnv): void {
  electronShimEnv = env;
  if (electronShimInstalled) return;
  const moduleCompat = Module as unknown as {
    _load: (request: string, parent: unknown, isMain: boolean) => unknown;
  };
  const originalLoad = moduleCompat._load;
  const repoRoot = resolveRepoRoot();
  const electronEntry = (() => {
    try {
      return require('electron');
    } catch {
      return process.execPath;
    }
  })();
  const electronBinary = typeof electronEntry === 'string' ? electronEntry : process.execPath;

  moduleCompat._load = function patchedLoad(request: string, parent: unknown, isMain: boolean): unknown {
    if (request === 'electron') {
      return {
        app: {
          isPackaged: false,
          getAppPath: () => repoRoot,
          getPath: (key: string) => {
            if (key === 'userData') return resolveNodeUserDataPath(electronShimEnv);
            if (key === 'exe') return electronBinary;
            if (key === 'temp') return os.tmpdir();
            return resolveNodeUserDataPath(electronShimEnv);
          },
        },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  electronShimInstalled = true;
}

async function createDefaultRuntimeContext(env: NodeJS.ProcessEnv): Promise<DefaultRuntimeContext> {
  installElectronShim(env);
  const userDataPath = resolveNodeUserDataPath(env);
  const { SqliteStore } = require('../sqliteStore') as {
    SqliteStore: {
      create(pathOverride?: string): Promise<{
        getDatabase(): DefaultRuntimeContext['db'];
        getSaveFunction(): () => void;
      }>;
    };
  };
  const { MetabotStore } = require('../metabotStore') as {
    MetabotStore: new (
      db: DefaultRuntimeContext['db'],
      save: () => void,
    ) => DefaultRuntimeContext['metabotStore'];
  };
  const { createPin } = require('../services/metaidCore') as {
    createPin: (
      metabotStore: DefaultRuntimeContext['metabotStore'],
      metabotId: number,
      pinInput: {
        operation: 'create';
        path: string;
        encryption: '0';
        version: '1.0.0';
        contentType: 'application/json';
        payload: string;
      },
    ) => Promise<{ pinId: string; txids: string[] }>;
  };

  const sqliteStore = await SqliteStore.create(userDataPath);
  const db = sqliteStore.getDatabase();
  const save = sqliteStore.getSaveFunction();
  const metabotStore = new MetabotStore(db, save);
  const serviceOrderStore = new ServiceOrderStore(db as never, save);
  const serviceOrderLifecycle = new ServiceOrderLifecycleService(serviceOrderStore, {
    resolveLocalMetabotGlobalMetaId: (localMetabotId) => (
      metabotStore.getMetabotById(localMetabotId)?.globalmetaid ?? null
    ),
  });

  ensureGigSquareSchema(db, save);

  return {
    db,
    save,
    metabotStore,
    createPin: (metabotId, pinInput) => createPin(metabotStore, metabotId, pinInput),
    serviceOrderLifecycle,
  };
}

function buildDefaultRuntimeEnv(
  env: NodeJS.ProcessEnv,
  options: Record<string, string | boolean>,
): NodeJS.ProcessEnv {
  const nextEnv = { ...env };
  const userDataPath = getOptionString(options, 'user-data');
  if (userDataPath) {
    nextEnv[METABOT_RUNTIME_USER_DATA] = path.resolve(userDataPath);
  }
  if (getOptionBoolean(options, 'use-default-user-data')) {
    nextEnv[METABOT_RUNTIME_USE_DEFAULT_USER_DATA] = '1';
  }
  return nextEnv;
}

function ensureGigSquareSchema(
  db: DefaultRuntimeContext['db'],
  save: () => void,
): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS gig_square_services (
      id TEXT PRIMARY KEY,
      pin_id TEXT NOT NULL,
      source_service_pin_id TEXT,
      current_pin_id TEXT,
      txid TEXT NOT NULL,
      metabot_id INTEGER NOT NULL,
      provider_global_metaid TEXT NOT NULL,
      provider_skill TEXT NOT NULL,
      service_name TEXT NOT NULL,
      display_name TEXT NOT NULL,
      description TEXT NOT NULL,
      service_icon TEXT,
      price TEXT NOT NULL,
      currency TEXT NOT NULL,
      skill_document TEXT,
      input_type TEXT NOT NULL,
      output_type TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      revoked_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  const columnsResult = db.exec('PRAGMA table_info(gig_square_services)');
  const columns = (columnsResult[0]?.values ?? []).map((row) => String(row[1]));
  if (!columns.includes('source_service_pin_id')) {
    db.run('ALTER TABLE gig_square_services ADD COLUMN source_service_pin_id TEXT');
  }
  if (!columns.includes('current_pin_id')) {
    db.run('ALTER TABLE gig_square_services ADD COLUMN current_pin_id TEXT');
  }
  if (!columns.includes('revoked_at')) {
    db.run('ALTER TABLE gig_square_services ADD COLUMN revoked_at INTEGER');
  }
  db.run(`
    UPDATE gig_square_services
    SET source_service_pin_id = COALESCE(NULLIF(TRIM(source_service_pin_id), ''), pin_id, id)
    WHERE source_service_pin_id IS NULL OR TRIM(source_service_pin_id) = ''
  `);
  db.run(`
    UPDATE gig_square_services
    SET current_pin_id = COALESCE(NULLIF(TRIM(current_pin_id), ''), pin_id, id)
    WHERE current_pin_id IS NULL OR TRIM(current_pin_id) = ''
  `);
  save();
}

function upsertGigSquareLocalServiceRow(
  db: DefaultRuntimeContext['db'],
  save: () => void,
  row: GigSquareLocalServiceMutationRecord,
): void {
  ensureGigSquareSchema(db, save);
  const now = row.updatedAt || Date.now();
  db.run(`
    INSERT INTO gig_square_services (
      id, pin_id, source_service_pin_id, current_pin_id, txid, metabot_id, provider_global_metaid, provider_skill,
      service_name, display_name, description, service_icon, price, currency,
      skill_document, input_type, output_type, endpoint, payload_json, revoked_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      pin_id = excluded.pin_id,
      source_service_pin_id = excluded.source_service_pin_id,
      current_pin_id = excluded.current_pin_id,
      txid = excluded.txid,
      metabot_id = excluded.metabot_id,
      provider_global_metaid = excluded.provider_global_metaid,
      provider_skill = excluded.provider_skill,
      service_name = excluded.service_name,
      display_name = excluded.display_name,
      description = excluded.description,
      service_icon = excluded.service_icon,
      price = excluded.price,
      currency = excluded.currency,
      skill_document = excluded.skill_document,
      input_type = excluded.input_type,
      output_type = excluded.output_type,
      endpoint = excluded.endpoint,
      payload_json = excluded.payload_json,
      revoked_at = excluded.revoked_at,
      updated_at = excluded.updated_at
  `, sanitizeDbParams([
    row.id,
    row.pinId,
    row.sourceServicePinId || row.pinId,
    row.currentPinId || row.pinId,
    row.txid,
    row.metabotId,
    row.providerGlobalMetaId,
    row.providerSkill,
    row.serviceName,
    row.displayName,
    row.description,
    row.serviceIcon,
    row.price,
    row.currency,
    row.skillDocument,
    row.inputType,
    row.outputType,
    row.endpoint,
    row.payloadJson,
    row.revokedAt,
    now,
    now,
  ]));
  save();
}

function listRemoteServicesFromDb(db: DefaultRuntimeContext['db']): ParsedRemoteSkillServiceRow[] {
  const result = db.exec(`
    SELECT id, pin_id, source_service_pin_id, status, operation, path, original_id, available,
           metaid, global_metaid, address, create_address, payment_address, service_name, display_name,
           description, price, currency, avatar, service_icon, provider_meta_bot, provider_skill,
           input_type, output_type, endpoint, content_summary_json, updated_at, rating_avg, rating_count
    FROM remote_skill_service
    ORDER BY updated_at DESC
  `);
  if (!result[0]?.values?.length) return [];
  const columns = result[0].columns;
  return result[0].values.map((values) => {
    const row: Record<string, unknown> = {};
    columns.forEach((column, index) => {
      row[column] = values[index];
    });
    return parseRemoteSkillServiceRow(row);
  });
}

function upsertRemoteServiceRow(
  db: DefaultRuntimeContext['db'],
  save: () => void,
  row: ParsedRemoteSkillServiceRow,
): void {
  const statement = buildRemoteSkillServiceUpsertStatement(row);
  db.run(statement.sql, sanitizeDbParams(statement.params));
  save();
}

function findLocalServiceEntry(
  db: DefaultRuntimeContext['db'],
  servicePinId: string,
): ResolvedServiceEntry | null {
  ensureGigSquareSchema(db, () => {});
  const result = db.exec(`
    SELECT id, pin_id, source_service_pin_id, current_pin_id, metabot_id, provider_global_metaid, provider_skill,
           service_name, display_name, description, price, currency, payload_json
    FROM gig_square_services
    WHERE id = ? OR pin_id = ? OR source_service_pin_id = ? OR current_pin_id = ?
    ORDER BY updated_at DESC
    LIMIT 1
  `, sanitizeDbParams([
    servicePinId,
    servicePinId,
    servicePinId,
    servicePinId,
  ]));
  if (!result[0]?.values?.length) return null;
  const columns = result[0].columns;
  const row = result[0].values[0];
  const raw = columns.reduce<Record<string, unknown>>((acc, column, index) => {
    acc[column] = row[index];
    return acc;
  }, {});
  const payload = (() => {
    try {
      return JSON.parse(String(raw.payload_json || '{}')) as GigSquareServicePayload;
    } catch {
      return null;
    }
  })();
  return {
    pinId: toSafeString(raw.current_pin_id) || toSafeString(raw.pin_id) || servicePinId,
    serviceName: toSafeString(raw.service_name),
    displayName: toSafeString(raw.display_name),
    description: toSafeString(raw.description),
    providerSkill: toSafeString(raw.provider_skill),
    providerGlobalMetaId: toSafeString(raw.provider_global_metaid),
    price: toSafeString(raw.price) || '0',
    currency: normalizeCurrency(raw.currency),
    paymentAddress: toSafeString(payload?.paymentAddress),
    metabotId: Math.trunc(toSafeNumber(raw.metabot_id)),
    payloadJson: toSafeString(raw.payload_json),
  };
}

function findRemoteServiceEntry(
  db: DefaultRuntimeContext['db'],
  servicePinId: string,
): ResolvedServiceEntry | null {
  const service = listRemoteServicesFromDb(db).find((item) => {
    return [
      toSafeString(item.id),
      toSafeString(item.pinId),
      toSafeString(item.sourceServicePinId),
    ].includes(toSafeString(servicePinId));
  });
  if (!service) return null;
  return {
    pinId: toSafeString(service.pinId),
    serviceName: toSafeString(service.serviceName),
    displayName: toSafeString(service.displayName),
    description: toSafeString(service.description),
    providerSkill: toSafeString(service.providerSkill),
    providerGlobalMetaId: toSafeString(service.providerGlobalMetaId),
    price: toSafeString(service.price) || '0',
    currency: normalizeCurrency(service.currency),
    paymentAddress: toSafeString(service.paymentAddress),
    metabotId: null,
  };
}

function resolveDefaultServiceEntry(
  db: DefaultRuntimeContext['db'],
  servicePinId: string,
): ResolvedServiceEntry | null {
  return findLocalServiceEntry(db, servicePinId) || findRemoteServiceEntry(db, servicePinId);
}

function buildServiceFetchPage(pageSize: number): (cursor?: string) => Promise<RemoteSkillServicePage> {
  return async (cursor?: string) => {
    const url = new URL(MANAPI_PIN_PATH_LIST_URL);
    url.searchParams.set('path', GIG_SQUARE_SERVICE_PATH);
    url.searchParams.set('size', String(pageSize));
    if (cursor) url.searchParams.set('cursor', cursor);
    const localPath = `/api/pin/path/list${url.search}`;
    const response = await fetchJsonWithFallbackOnMiss(
      localPath,
      url.toString(),
      isRemoteSkillServiceListSemanticMiss,
    );
    if (!response.ok) {
      throw new Error(`Remote service sync failed with status ${response.status}`);
    }
    const json = await response.json() as { data?: { list?: unknown; nextCursor?: unknown } };
    return {
      list: Array.isArray(json?.data?.list) ? json.data.list as Record<string, unknown>[] : [],
      nextCursor: typeof json?.data?.nextCursor === 'string' ? json.data.nextCursor : null,
    };
  };
}

async function buildRealDiscoverySnapshot(services: ParsedRemoteSkillServiceRow[]): Promise<{
  availableServices: Array<Record<string, unknown>>;
}> {
  const heartbeat = new HeartbeatPollingService({
    fetchHeartbeat: fetchHeartbeatFromChain,
  });
  const discovery = new ProviderDiscoveryService({
    heartbeat,
    fetchPresence: () => fetchLocalPresenceSnapshot(getP2PLocalBase()),
  });

  try {
    discovery.startPolling(() => services);
    await discovery.refreshNow();
    return discovery.getDiscoverySnapshot();
  } finally {
    discovery.dispose();
  }
}

function buildServiceDraft(options: Record<string, string | boolean>): GigSquareModifyDraft {
  return {
    serviceName: getOptionString(options, 'service-name'),
    displayName: getOptionString(options, 'display-name'),
    description: getOptionString(options, 'description'),
    providerSkill: getOptionString(options, 'provider-skill'),
    price: getOptionString(options, 'price', '0'),
    currency: normalizeCurrency(getOptionString(options, 'currency', 'SPACE')),
    outputType: getOptionString(options, 'output-type', 'text'),
    serviceIconUri: getOptionString(options, 'service-icon', '') || null,
  };
}

function resolveMetabotPaymentAddress(metabot: any, currency: string): string {
  const normalizedCurrency = normalizeCurrency(currency);
  if (normalizedCurrency === 'BTC') return toSafeString(metabot?.btc_address);
  if (normalizedCurrency === 'DOGE') return toSafeString(metabot?.doge_address);
  return toSafeString(metabot?.mvc_address);
}

async function handlePublishService(
  parsed: ParsedCliInput,
  io: RuntimeExecutionIO,
): Promise<RuntimeExecutionResult> {
  const fixturePath = toSafeString(io.env?.[METABOT_RUNTIME_FIXTURE_STATE]);
  const metabotId = Math.trunc(getOptionNumber(parsed.options, 'metabot-id', 0));
  if (!metabotId) return buildErrorResult('publish-service requires --metabot-id');

  if (fixturePath) {
    const result = await withFixtureState(fixturePath, async (state) => {
      const publishResult = await publishPortableService({
        metabotId,
        providerGlobalMetaId: getOptionString(parsed.options, 'provider-global-metaid'),
        paymentAddress: getOptionString(parsed.options, 'payment-address'),
        serviceDraft: buildServiceDraft(parsed.options),
        deps: {
          buildGigSquareServicePayload,
          createPin: async (_store, localMetabotId, pinInput) => {
            const txid = allocateFixtureTxid(state);
            const pinId = `${txid}i0`;
            state.pins.push({
              pinId,
              txids: [txid],
              metabotId: localMetabotId,
              path: pinInput.path,
              payload: String(pinInput.payload),
            });
            return { pinId, txids: [txid] };
          },
          insertLocalServiceRow: (row) => {
            state.localServices = appendOrReplaceByKey(state.localServices, 'id', row);
          },
          scheduleRemoteSync: () => {},
        },
      });

      const payload = JSON.parse(publishResult.payloadJson) as GigSquareServicePayload;
      const remoteItem = buildFixtureRemoteServiceItem(
        publishResult.pinId,
        payload,
        getOptionString(parsed.options, 'provider-global-metaid'),
      );
      state.remoteServiceItems = appendOrReplaceByKey(state.remoteServiceItems, 'id', remoteItem);

      return publishResult;
    });

    return buildJsonResult({
      pinId: result.pinId,
      txids: result.txids,
    });
  }

  const runtimeEnv = buildDefaultRuntimeEnv(io.env ?? process.env, parsed.options);
  const context = await createDefaultRuntimeContext(runtimeEnv);
  const metabot = context.metabotStore.getMetabotById(metabotId);
  if (!metabot) return buildErrorResult(`MetaBot ${metabotId} not found`);

  const providerGlobalMetaId = getOptionString(parsed.options, 'provider-global-metaid')
    || toSafeString(metabot.globalmetaid);
  const currency = normalizeCurrency(getOptionString(parsed.options, 'currency', 'SPACE'));
  const paymentAddress = getOptionString(parsed.options, 'payment-address')
    || resolveMetabotPaymentAddress(metabot, currency);

  const result = await publishPortableService({
    metabotId,
    providerGlobalMetaId,
    paymentAddress,
    serviceDraft: buildServiceDraft(parsed.options),
    deps: {
      buildGigSquareServicePayload,
      createPin: async (_store, localMetabotId, pinInput) => context.createPin(localMetabotId, pinInput),
      insertLocalServiceRow: (row) => upsertGigSquareLocalServiceRow(context.db, context.save, row),
      scheduleRemoteSync: () => {},
    },
  });

  return buildJsonResult({
    pinId: result.pinId,
    txids: result.txids,
  });
}

async function handleListServices(
  parsed: ParsedCliInput,
  io: RuntimeExecutionIO,
): Promise<RuntimeExecutionResult> {
  const fixturePath = toSafeString(io.env?.[METABOT_RUNTIME_FIXTURE_STATE]);
  const pageSize = Math.max(1, Math.trunc(getOptionNumber(parsed.options, 'page-size', 20)));
  const maxPages = Math.max(1, Math.trunc(getOptionNumber(parsed.options, 'max-pages', 20)));

  if (fixturePath) {
    const services = await withFixtureState(fixturePath, async (state) => {
      const fetchPage = async (cursor?: string): Promise<RemoteSkillServicePage> => {
        const offset = cursor ? Math.max(0, Math.trunc(toSafeNumber(cursor, 0))) : 0;
        const list = state.remoteServiceItems.slice(offset, offset + pageSize);
        const nextOffset = offset + list.length;
        return {
          list,
          nextCursor: nextOffset < state.remoteServiceItems.length ? String(nextOffset) : null,
        };
      };

      await syncPortableServiceCatalog({
        pageSize,
        maxPages,
        fetchPage,
        upsertMirroredService: (row) => {
          state.mirroredServices = appendOrReplaceByKey(state.mirroredServices, 'id', row);
        },
      });

      return listCallablePortableServices({
        pageSize,
        maxPages,
        fetchPage,
        upsertMirroredService: (row) => {
          state.mirroredServices = appendOrReplaceByKey(state.mirroredServices, 'id', row);
        },
        listMirroredServices: () => state.mirroredServices,
        providerDiscovery: {
          getDiscoverySnapshot: () => ({
            availableServices: state.remoteServiceItems.map((item) => {
              const summary = (item.contentSummary ?? {}) as Record<string, unknown>;
              return {
                pinId: toSafeString(item.id),
                providerGlobalMetaId: toSafeString(item.globalMetaId),
                providerAddress: toSafeString(item.address || item.createAddress),
                serviceName: toSafeString(summary.serviceName || summary.displayName),
              };
            }),
          }),
        },
      });
    });

    return buildJsonResult({ services });
  }

  const runtimeEnv = buildDefaultRuntimeEnv(io.env ?? process.env, parsed.options);
  const context = await createDefaultRuntimeContext(runtimeEnv);
  const fetchPage = buildServiceFetchPage(pageSize);

  await syncPortableServiceCatalog({
    pageSize,
    maxPages,
    fetchPage,
    upsertMirroredService: (row) => upsertRemoteServiceRow(context.db, context.save, row),
  });

  const syncedServices = listRemoteServicesFromDb(context.db);
  const discoverySnapshot = await buildRealDiscoverySnapshot(syncedServices);
  const services = await listCallablePortableServices({
    pageSize,
    maxPages,
    fetchPage,
    upsertMirroredService: (row) => upsertRemoteServiceRow(context.db, context.save, row),
    listMirroredServices: () => listRemoteServicesFromDb(context.db),
    providerDiscovery: {
      getDiscoverySnapshot: () => discoverySnapshot,
    },
  });

  return buildJsonResult({ services });
}

async function handleRequestService(
  parsed: ParsedCliInput,
  io: RuntimeExecutionIO,
): Promise<RuntimeExecutionResult> {
  const fixturePath = toSafeString(io.env?.[METABOT_RUNTIME_FIXTURE_STATE]);
  const metabotId = Math.trunc(getOptionNumber(parsed.options, 'metabot-id', 0));
  const servicePinId = getOptionString(parsed.options, 'service-pin-id');
  if (!metabotId) return buildErrorResult('request-service requires --metabot-id');
  if (!servicePinId) return buildErrorResult('request-service requires --service-pin-id');

  const requestId = getOptionString(parsed.options, 'request-id') || randomBytes(8).toString('hex');
  const requesterSessionId = getOptionString(parsed.options, 'requester-session-id') || requestId;
  const requesterConversationId = getOptionString(parsed.options, 'requester-conversation-id') || null;
  const requesterGlobalMetaId = getOptionString(parsed.options, 'requester-global-metaid');
  const explicitPrice = getOptionString(parsed.options, 'price');
  const explicitCurrency = getOptionString(parsed.options, 'currency');
  const paymentTxid = getOptionString(parsed.options, 'payment-txid') || null;
  const orderReferenceId = getOptionString(parsed.options, 'order-reference-id') || null;
  const paymentChain = normalizePaymentChain(
    getOptionString(parsed.options, 'payment-chain') || explicitCurrency,
  );

  if (fixturePath) {
    const payload = await withFixtureState(fixturePath, async (state) => {
      const service = resolveFixtureServiceEntry(state, servicePinId);
      if (!service) throw new Error(`Fixture service ${servicePinId} not found`);

      const request = normalizeServiceRequestContract({
        correlation: {
          requestId,
          requesterSessionId,
          requesterConversationId,
        },
        servicePinId,
        requesterGlobalMetaId,
        price: explicitPrice || service.price,
        currency: normalizeCurrency(explicitCurrency || service.currency),
        paymentProof: {
          txid: paymentTxid,
          chain: paymentTxid ? paymentChain : null,
          amount: explicitPrice || service.price,
          currency: normalizeCurrency(explicitCurrency || service.currency),
          orderMessage: '',
          orderMessagePinId: null,
        },
        userTask: getOptionString(parsed.options, 'user-task'),
        taskContext: getOptionString(parsed.options, 'task-context'),
      });

      const result = await writePortableServiceRequest({
        metabotId,
        request,
        paymentTxid,
        orderReferenceId,
        counterpartyGlobalMetaId: service.providerGlobalMetaId,
        serviceName: service.serviceName,
        providerSkill: service.providerSkill,
        paymentChain,
        coworkSessionId: requesterSessionId,
        trace: {
          createBuyerOrder: (input) => {
            const order = {
              id: `buyer-order-${state.orders.length + 1}`,
              role: 'buyer',
              ...input,
            };
            state.orders.push(order);
            return order;
          },
        },
        deps: {
          buildDelegationOrderPayload,
          createPin: async (_store, localMetabotId, pinInput) => {
            const txid = allocateFixtureTxid(state);
            const pinId = `${txid}i0`;
            state.pins.push({
              pinId,
              txids: [txid],
              metabotId: localMetabotId,
              path: pinInput.path,
              payload: String(pinInput.payload),
            });
            return { pinId, txids: [txid] };
          },
        },
      });

      const providerWakeUp = buildProviderWakeUpEnvelope({
        request: result.request,
        requestWrite: result.requestWrite,
      });
      state.requests.push({
        request: result.request,
        requestWrite: result.requestWrite,
        providerWakeUp,
      });
      return {
        request_write: result.requestWrite,
        provider_wakeup: providerWakeUp,
      };
    });

    return buildJsonResult(payload);
  }

  const runtimeEnv = buildDefaultRuntimeEnv(io.env ?? process.env, parsed.options);
  const context = await createDefaultRuntimeContext(runtimeEnv);
  const service = resolveDefaultServiceEntry(context.db, servicePinId);
  if (!service) return buildErrorResult(`Service ${servicePinId} not found`);

  const request = normalizeServiceRequestContract({
    correlation: {
      requestId,
      requesterSessionId,
      requesterConversationId,
    },
    servicePinId,
    requesterGlobalMetaId,
    price: explicitPrice || service.price,
    currency: normalizeCurrency(explicitCurrency || service.currency),
    paymentProof: {
      txid: paymentTxid,
      chain: paymentTxid ? paymentChain : null,
      amount: explicitPrice || service.price,
      currency: normalizeCurrency(explicitCurrency || service.currency),
      orderMessage: '',
      orderMessagePinId: null,
    },
    userTask: getOptionString(parsed.options, 'user-task'),
    taskContext: getOptionString(parsed.options, 'task-context'),
  });

  const result = await writePortableServiceRequest({
    metabotId,
    request,
    paymentTxid,
    orderReferenceId,
    counterpartyGlobalMetaId: service.providerGlobalMetaId,
    serviceName: service.serviceName,
    providerSkill: service.providerSkill,
    paymentChain,
    coworkSessionId: requesterSessionId,
    trace: {
      createBuyerOrder: (input) => context.serviceOrderLifecycle.createBuyerOrder(input),
    },
    deps: {
      buildDelegationOrderPayload,
      createPin: async (_store, localMetabotId, pinInput) => context.createPin(localMetabotId, pinInput),
    },
  });
  const providerWakeUp = buildProviderWakeUpEnvelope({
    request: result.request,
    requestWrite: result.requestWrite,
  });

  return buildJsonResult({
    request_write: result.requestWrite,
    provider_wakeup: providerWakeUp,
  });
}

function parseProviderArgsJson(env: NodeJS.ProcessEnv): string[] {
  const raw = toSafeString(env[METABOT_PROVIDER_ARGS_JSON]);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new Error(`${METABOT_PROVIDER_ARGS_JSON} must be a JSON array`);
    }
    return parsed.map((item) => String(item));
  } catch {
    throw new Error(`Invalid ${METABOT_PROVIDER_ARGS_JSON}`);
  }
}

function createExternalCommandHostAdapter(env: NodeJS.ProcessEnv): HostSessionAdapter {
  const command = toSafeString(env[METABOT_PROVIDER_COMMAND]);
  if (!command) {
    throw new Error(`Default daemon mode requires ${METABOT_PROVIDER_COMMAND}`);
  }

  const commandArgs = parseProviderArgsJson(env);
  const pending = new Map<string, Promise<ProviderSessionResult>>();

  const runProviderCommand = (input: StartProviderSessionInput, sessionId: string): Promise<ProviderSessionResult> => (
    new Promise((resolve, reject) => {
      const child = spawn(command, commandArgs, {
        cwd: resolveRepoRoot(),
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(stderr.trim() || stdout.trim() || `Provider host exited with code ${code}`));
          return;
        }
        const trimmedStdout = stdout.trim();
        if (!trimmedStdout) {
          resolve({ sessionId, text: '' });
          return;
        }
        const lastLine = trimmedStdout.split('\n').filter(Boolean).pop() || '';
        try {
          const parsed = JSON.parse(lastLine) as {
            text?: unknown;
            attachments?: unknown;
            ratingInvite?: unknown;
          };
          resolve({
            sessionId,
            text: typeof parsed.text === 'string' ? parsed.text : '',
            attachments: Array.isArray(parsed.attachments) ? parsed.attachments.map(String) : [],
            ratingInvite: typeof parsed.ratingInvite === 'string' ? parsed.ratingInvite : '',
          });
        } catch {
          resolve({ sessionId, text: trimmedStdout });
        }
      });

      child.stdin.write(JSON.stringify({
        type: 'provider_session',
        sessionId,
        input,
      }));
      child.stdin.end();
    })
  );

  return {
    async startProviderSession(input) {
      const sessionId = randomBytes(8).toString('hex');
      pending.set(sessionId, runProviderCommand(input, sessionId));
      return { sessionId };
    },
    async waitForProviderResult(sessionId) {
      const pendingResult = pending.get(sessionId);
      if (!pendingResult) {
        throw new Error(`Provider session ${sessionId} not found`);
      }
      pending.delete(sessionId);
      return pendingResult;
    },
  };
}

function createSmokeHostAdapter(): HostSessionAdapter {
  const pending = new Map<string, StartProviderSessionInput>();
  return {
    async startProviderSession(input) {
      const sessionId = `smoke-session-${pending.size + 1}`;
      pending.set(sessionId, input);
      return { sessionId };
    },
    async waitForProviderResult(sessionId) {
      const input = pending.get(sessionId);
      if (!input) {
        throw new Error(`Smoke session ${sessionId} not found`);
      }
      pending.delete(sessionId);
      return {
        sessionId,
        text: `Smoke delivery: ${input.userTask || input.taskContext || input.servicePinId}`,
      };
    },
  };
}

function parseJsonlLines(stdinText: string | undefined): Array<Record<string, unknown>> {
  return String(stdinText || '')
    .split(/\r?\n/)
    .map((line, index) => ({
      index,
      value: line.trim(),
    }))
    .filter((entry) => Boolean(entry.value))
    .map((entry) => {
      try {
        return JSON.parse(entry.value) as Record<string, unknown>;
      } catch (error) {
        throw new Error(
          `Invalid JSONL at line ${entry.index + 1}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    });
}

async function handleDaemonSmoke(io: RuntimeExecutionIO): Promise<RuntimeExecutionResult> {
  const fixturePath = toSafeString(io.env?.[METABOT_RUNTIME_FIXTURE_STATE]);
  if (!fixturePath) {
    return buildErrorResult(`--smoke requires ${METABOT_RUNTIME_FIXTURE_STATE}`);
  }

  const wakeUps = parseJsonlLines(io.stdinText);
  const outputLines = await withFixtureState(fixturePath, async (state) => {
    const deliveries: string[] = [];
    for (const wakeUp of wakeUps) {
      const request = normalizeProviderWakeUpEnvelope(wakeUp);
      const service = resolveFixtureServiceEntry(state, request.servicePinId);
      if (!service) {
        throw new Error(`Fixture provider service ${request.servicePinId} not found`);
      }

      const prompts = buildOrderPrompts({
        plaintext: request.paymentProof.orderMessage,
        source: 'metaweb_private',
        metabotName: service.displayName || service.serviceName || 'Fixture MetaBot',
        skillId: request.servicePinId,
        skillName: service.providerSkill,
        peerName: request.requesterGlobalMetaId,
      });

      const daemon = new MetabotDaemon({
        verifyPortablePaymentEligibility: async ({ request: portableRequest }) => ({
          executable: true,
          reason: portableRequest.executionMode === 'free' ? 'free_order_no_payment_required' : 'verified_smoke',
          payment: {
            paid: true,
            txid: portableRequest.paymentProof.txid,
            reason: portableRequest.executionMode === 'free' ? 'free_order_no_payment_required' : 'verified_smoke',
            chain: portableRequest.paymentProof.chain || normalizePaymentChain(portableRequest.currency),
            amountSats: portableRequest.executionMode === 'free' ? 0 : 1,
          },
          orderSkillId: portableRequest.servicePinId || null,
          orderReferenceId: portableRequest.paymentProof.txid,
        }),
      });

      const result = await daemon.handleWakeUp({
        request,
        providerContext: {
          metabotId: service.metabotId || 1,
          metabotStore: {} as never,
          source: 'metaweb_private',
          counterpartyGlobalMetaId: request.requesterGlobalMetaId,
          serviceName: service.serviceName,
          paymentTxid: request.paymentProof.txid,
          paymentChain: request.paymentProof.chain,
          paymentAmount: request.price,
          paymentCurrency: request.currency,
          orderMessagePinId: request.paymentProof.orderMessagePinId,
          prompt: prompts.userPrompt,
          systemPrompt: prompts.systemPrompt,
          store: state as never,
          createPin: async (_store, localMetabotId, pinInput) => {
            const txid = allocateFixtureTxid(state);
            const pinId = `${txid}i0`;
            state.pins.push({
              pinId,
              txids: [txid],
              metabotId: localMetabotId,
              path: pinInput.path,
              payload: String(pinInput.payload),
            });
            return { pinId, txids: [txid] };
          },
        },
        hostAdapter: createSmokeHostAdapter(),
      });

      if (!result.providerDelivery) {
        throw new Error(`Smoke daemon did not emit provider_delivery for ${request.correlation.requestId}`);
      }
      state.deliveries.push(result.providerDelivery);
      deliveries.push(JSON.stringify(result.providerDelivery));
    }
    return deliveries;
  });

  return {
    exitCode: 0,
    stdout: outputLines.length ? `${outputLines.join('\n')}\n` : '',
    stderr: '',
  };
}

async function handleDaemonDefault(
  parsed: ParsedCliInput,
  io: RuntimeExecutionIO,
): Promise<RuntimeExecutionResult> {
  const wakeUps = parseJsonlLines(io.stdinText);
  if (!wakeUps.length) {
    return buildErrorResult('metabot-daemon expects provider_wakeup JSONL on stdin');
  }

  const runtimeEnv = buildDefaultRuntimeEnv(io.env ?? process.env, parsed.options);
  const context = await createDefaultRuntimeContext(runtimeEnv);
  const hostAdapter = createExternalCommandHostAdapter(runtimeEnv);
  const daemon = new MetabotDaemon();
  const outputLines: string[] = [];

  for (const wakeUp of wakeUps) {
    const request = normalizeProviderWakeUpEnvelope(wakeUp);
    const service = findLocalServiceEntry(context.db, request.servicePinId)
      || resolveDefaultServiceEntry(context.db, request.servicePinId);
    const fallbackMetabotId = Math.trunc(getOptionNumber(parsed.options, 'metabot-id', 0));
    const metabotId = service?.metabotId || fallbackMetabotId;
    if (!metabotId) {
      throw new Error(`Cannot resolve provider metabot for service ${request.servicePinId}`);
    }
    const metabot = context.metabotStore.getMetabotById(metabotId);
    if (!metabot) {
      throw new Error(`Provider MetaBot ${metabotId} not found`);
    }

    const prompts = buildOrderPrompts({
      plaintext: request.paymentProof.orderMessage,
      source: 'metaweb_private',
      metabotName: toSafeString(metabot.name) || `MetaBot ${metabotId}`,
      skillId: request.servicePinId,
      skillName: service?.providerSkill || service?.serviceName || request.servicePinId,
      peerName: request.requesterGlobalMetaId,
    });

    const result = await daemon.handleWakeUp({
      request,
      providerContext: {
        metabotId,
        metabotStore: context.metabotStore as never,
        source: 'metaweb_private',
        counterpartyGlobalMetaId: request.requesterGlobalMetaId,
        serviceName: service?.serviceName || request.servicePinId,
        paymentTxid: request.paymentProof.txid,
        paymentChain: request.paymentProof.chain,
        paymentAmount: request.price,
        paymentCurrency: request.currency,
        orderMessagePinId: request.paymentProof.orderMessagePinId,
        prompt: prompts.userPrompt,
        systemPrompt: prompts.systemPrompt,
        serviceOrderLifecycle: context.serviceOrderLifecycle,
        store: context.metabotStore as never,
        createPin: async (_store, localMetabotId, pinInput) => context.createPin(localMetabotId, pinInput),
      },
      hostAdapter,
    });

    if (!result.providerDelivery) {
      throw new Error(`Request ${request.correlation.requestId} was not executable: ${result.execution.reason}`);
    }
    outputLines.push(JSON.stringify(result.providerDelivery));
  }

  return {
    exitCode: 0,
    stdout: `${outputLines.join('\n')}\n`,
    stderr: '',
  };
}

function buildRunDaemonDescription(): RuntimeExecutionResult {
  return {
    exitCode: 0,
    stdout: [
      'metabot-daemon JSONL contract',
      '',
      'stdin : provider_wakeup JSONL',
      'stdout: provider_delivery JSONL',
      '',
      `Default mode requires ${METABOT_PROVIDER_COMMAND} and real IDBots local state.`,
      `Fixture smoke mode requires ${METABOT_RUNTIME_FIXTURE_STATE} and --smoke on scripts/metabot-daemon.mjs.`,
      '',
    ].join('\n'),
    stderr: '',
  };
}

export async function runMetabotCli(
  argv: string[],
  io: RuntimeExecutionIO = {},
): Promise<RuntimeExecutionResult> {
  const parsed = parseCliInput(argv);
  if (!parsed.command || parsed.command === '--help' || parsed.command === 'help' || getOptionBoolean(parsed.options, 'help')) {
    return {
      exitCode: 0,
      stdout: `${buildHelpText()}\n`,
      stderr: '',
    };
  }

  try {
    switch (parsed.command) {
      case 'publish-service':
        return await handlePublishService(parsed, io);
      case 'list-services':
        return await handleListServices(parsed, io);
      case 'request-service':
        return await handleRequestService(parsed, io);
      case 'run-daemon':
        return buildRunDaemonDescription();
      default:
        return buildErrorResult(`Unknown metabot-cli command: ${parsed.command}`);
    }
  } catch (error) {
    return buildErrorResult(error instanceof Error ? error.message : String(error));
  }
}

export async function runMetabotDaemon(
  argv: string[],
  io: RuntimeExecutionIO = {},
): Promise<RuntimeExecutionResult> {
  const parsed = parseCliInput(argv);
  try {
    if (getOptionBoolean(parsed.options, 'smoke')) {
      return await handleDaemonSmoke(io);
    }
    return await handleDaemonDefault(parsed, io);
  } catch (error) {
    return buildErrorResult(error instanceof Error ? error.message : String(error));
  }
}
