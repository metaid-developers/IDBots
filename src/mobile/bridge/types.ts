/**
 * Shared types for the mobile bridge (mock now, real gateway shim in T3).
 *
 * The mock bridge (REQ-E-8) backs `window.electron` with fixtures and timers
 * so the mobile UI and its Playwright suite can run without a tenant. The
 * real C2 gateway shim (T3) replaces the same `window.electron` surface, so
 * screens written against the mock need no changes.
 */

/** Connection lifecycle of the gateway client, mirrored into the UI banner. */
export type ConnectionState =
  | 'connecting'
  | 'online'
  | 'reconnecting'
  | 'offline'
  | 'upgrading';

export type IdbotsMobileOs = 'ios' | 'android' | 'web';

export type IdbotsMobileShell = 'pwa' | 'capacitor' | 'browser';

/** Client facts exposed next to `window.electron` (C2/REQ-E-3 shape). */
export interface IdbotsMobileInfo {
  isMobile: true;
  os: IdbotsMobileOs;
  shell: IdbotsMobileShell;
}

/**
 * C4 bundle types DERIVE from the real preload channel declarations in
 * src/renderer/types/electron.d.ts. Its interfaces are module-scoped (not
 * global), so they are reached through `Window['electron']` — never
 * hand-copied into a parallel definition. The last hand-copied set drifted
 * on `llm.unit`, the `createOrder` result fields, and `getOrder`'s missing
 * `gatewayParams`, breaking `tsc` as soon as WS-A's types landed.
 * (`mobile`/`gateway` helper channels get the same treatment in T3.)
 */
export type BundleChannelAPI = Window['electron']['bundle'];
export type BundlePlan = NonNullable<
  Awaited<ReturnType<BundleChannelAPI['getPlans']>>['plans']
>[number];
export type BundleMeters = NonNullable<Awaited<ReturnType<BundleChannelAPI['getMeters']>>['meters']>;

/**
 * IPC contract version the mock implements (generated from
 * src/mobile/generated/ipc-contract.json, contractVersion 1.0.0). The Me
 * screen's About section surfaces it next to the app version.
 */
export const CONTRACT_VERSION = '1.0.0';

/** Real channel namespaces the mock implements beyond `bundle`/`mobile`. */
export type ScheduledTasksChannelAPI = Window['electron']['scheduledTasks'];
export type MetabotChannelAPI = Window['electron']['metabot'];
export type SkillsChannelAPI = Window['electron']['skills'];
export type TrafficChannelAPI = Window['electron']['traffic'];

/** Fixture MetaBot row, derived from the real `metabot:list` payload. */
export type MockMetabot = NonNullable<Awaited<ReturnType<MetabotChannelAPI['list']>>['list']>[number];
export type MobileMetabot = MockMetabot & {
  chain_sync_state?: 'synced' | 'partial';
  chain_sync_pending_steps?: string[];
  subsidy_state?: 'unknown' | 'claimed' | 'failed';
  subsidy_error?: string | null;
};
export type MetabotCreateInput = Parameters<MetabotChannelAPI['create']>[0];
export type MetabotUpdateInput = Parameters<MetabotChannelAPI['update']>[1];
/**
 * Optional fallback-brain payload carried by the on-chain create channel
 * (`idbots.createMetaBotOnChain`) and the update channel; the metabot
 * fixture keeps mock parity with it.
 */
export interface MetabotFallbackInput {
  fallback_llm_id?: string | null;
  fallback_llm_provider?: string | null;
  fallback_llm_effort?: string | null;
}
/** Fixture skill row, derived from the real `skills:list` payload. */
export type MockSkill = NonNullable<Awaited<ReturnType<SkillsChannelAPI['list']>>['skills']>[number];
/** traffic:redeemCode success payload (TrafficRedeemCodeInfo). */
export type TrafficRedeemResult = NonNullable<Awaited<ReturnType<TrafficChannelAPI['redeemCode']>>['result']>;
/** traffic ledger row (TrafficLedgerEntryInfo) — A6 traffic page. */
export type TrafficLedgerEntryInfo = NonNullable<
  Awaited<ReturnType<TrafficChannelAPI['getLedger']>>['entries']
>[number];
/** traffic daily usage row (TrafficDailyUsageRowInfo) — A6 traffic page. */
export type TrafficDailyUsageRowInfo = NonNullable<
  Awaited<ReturnType<TrafficChannelAPI['getDailyUsage']>>['rows']
>[number];

/** Cowork session/message projections the chat screen hydrates from. */
export type CoworkChannelAPI = Window['electron']['cowork'];
export type CoworkSessionSummary = NonNullable<
  Awaited<ReturnType<CoworkChannelAPI['listSessions']>>['sessions']
>[number];
export type CoworkSessionDetail = NonNullable<Awaited<ReturnType<CoworkChannelAPI['getSession']>>['session']>;
export type CoworkMessageView = CoworkSessionDetail['messages'][number];

/**
 * Scheduled-task shapes come from the desktop renderer types
 * (src/renderer/types/scheduledTask.ts) rather than electron.d.ts, where the
 * namespace is typed as `any`. Importing keeps the mock aligned with the
 * create/update contract the desktop TaskForm builds.
 */
export type {
  ScheduledTask,
  ScheduledTaskInput,
  ScheduledTaskMemoryAccess,
  ScheduledTaskRun,
  Schedule,
} from '../../renderer/types/scheduledTask';

/**
 * The mock's stored order: the C4 `createOrder` payload plus its own
 * bookkeeping. `getOrder` projections must stay assignable to
 * `BundleOrderStatusInfo` (no `gatewayParams` in status polling; paidAt and
 * creditedAt are numbers once set, absent before — never null).
 */
export type MockBundleOrder = NonNullable<
  Awaited<ReturnType<BundleChannelAPI['createOrder']>>['order']
> & {
  /** 1 created, 2 paid, 3 credited, 4 closed (C4 status codes). */
  status: number;
  paidAt?: number;
  creditedAt?: number;
  createdAt: number;
};

/**
 * Pending tool-permission request as returned by `mobile:permission:listPending`
 * (`mobile.listPendingPermissions` on the wire).
 */
export interface PendingPermissionRequest {
  sessionId: string;
  request: {
    sessionId: string;
    toolName: string;
    toolInput: Record<string, unknown>;
    requestId: string;
    toolUseId: string | null;
  };
  createdAt: number;
}

/**
 * `mobile.*` helper channels, aligned verbatim with the generated IPC contract
 * (src/mobile/generated/ipc-contract.json → `mobile.listPendingPermissions`,
 * `mobile.getBootstrapStatus`) and the preload typings in
 * src/renderer/types/electron.d.ts, so the mock and the real gateway shim
 * expose the same surface.
 */
export interface MobileChannelAPI {
  listPendingPermissions: () => Promise<PendingPermissionRequest[] | { success: false; error: string }>;
  getBootstrapStatus: () => Promise<Record<string, unknown> | { success: false; error: string }>;
}

/**
 * The full mock surface: the desktop `IElectronAPI` (referenced through the
 * global declaration in src/renderer/types/electron.d.ts, which already
 * includes `bundle`) plus the mock's `mobile` helper channels.
 */
export type MockElectronAPI = Window['electron'] & {
  mobile: MobileChannelAPI;
};

/** Offline rejection handed to invokes made while the mock is "disconnected". */
export interface OfflineError extends Error {
  code: 'OFFLINE';
  retryable: true;
}

export type MobileMockCoworkStreamChannel =
  | 'message'
  | 'messageUpdate'
  | 'permission'
  | 'permissionResolved'
  | 'complete'
  | 'error'
  | 'sessionTitle';

/** Controls the mock exposes to the demo page and the tests. */
export interface MobileMockControl {
  /** Flips connection state online -> reconnecting -> online over the blackout delay. */
  simulateReconnect: () => void;
  getConnectionState: () => ConnectionState;
  /** URLs passed to shell:openExternal while http(s) (for test assertions). */
  getOpenedUrls: () => string[];
  emitCoworkStream: (channel: MobileMockCoworkStreamChannel, payload: unknown) => void;
  /** S9 ME points demo: flip the mock subscription between free and active. */
  setMeSubscribed?: (value: boolean) => void;
}

/** Timer/scenario knobs; tests shrink these to keep the suite fast. */
export interface MockBridgeOptions {
  /** Delay between streamed reply tokens. Default 40 ms. */
  streamTokenIntervalMs?: number;
  /** Order goes from status 1 (created) to 3 (credited) after this delay. Default 10 s. */
  orderCompleteDelayMs?: number;
  /** How long simulateReconnect() stays disconnected. Default 3 s. */
  reconnectBlackoutMs?: number;
  /** The scheduled-task demo run fires this long after bridge creation. Default 15 s. */
  scheduledRunDelayMs?: number;
  /** scheduledTasks.runManually completes its run after this delay. Default 4 s. */
  manualRunDelayMs?: number;
  /** System locale behind appInfo.getSystemLocale. Default: detected. */
  systemLocale?: string;
}

export interface MobileMockBridge {
  electron: MockElectronAPI;
  connection: {
    getState: () => ConnectionState;
    onChange: (callback: (state: ConnectionState) => void) => () => void;
  };
  control: MobileMockControl;
  /** Tears down pending timers; call in tests to avoid open handles. */
  destroy: () => void;
}
