/**
 * Single-tap Mandate Confirmation Gate for FT Broker multi-step operations.
 *
 * Implements Contract C4.1 (`POST /api/idbots/commerce/ft-mandate-confirm`):
 * - Short-lived (default 5-minute TTL) in-memory mandateToken bound to a
 *   specific { metabotId, action, assetKey, rail, maxSpendAmount, lotCount }.
 * - Strict BigInt ceiling accounting so sweeping 5 lots or splitting/listing 10
 *   lots only prompts the owner once while blocking overspend, cross-asset
 *   privilege escalation, cross-bot reuse, and expired mandates.
 * - Defaults strictly to DENY on prompt timeout, user cancel, or missing UI.
 */

import crypto from 'crypto';

export type FtMandateAction = 'buy-sweep' | 'list-lots' | 'cancel';
export type FtMandateRail = 'btc-psbt' | 'mvc-tokensell' | 'me-escrow';

export interface FtMandateDraft {
  metabotId: number;
  action: FtMandateAction;
  assetKey: string;
  symbol: string;
  decimals?: number;
  rail: FtMandateRail;
  totalTokenDisplay: string;
  lotCount: number;
  maxSpendDisplay: string;
  /**
   * Exact non-negative integer string in the rail's settlement unit:
   * - `btc-psbt` / `mvc-tokensell` (`buy-sweep`): satoshis
   * - `me-escrow` (`buy-sweep`): milli-ME
   * - `list-lots` / `cancel`: base token units being listed/canceled (or `'0'`)
   */
  maxSpendAmount: string;
  estimatedGasDisplay: string;
  caVerified?: boolean;
  sessionId?: string;
}

export interface FtMandatePromptEvent {
  requestId: string;
  draft: FtMandateDraft;
  expiresAt: number;
  timeoutMs: number;
}

export interface FtMandateRecord {
  mandateToken: string;
  metabotId: number;
  action: FtMandateAction;
  assetKey: string;
  symbol: string;
  rail: FtMandateRail;
  maxSpendAmount: bigint;
  spentAmount: bigint;
  maxLots: number;
  usedLots: number;
  createdAt: number;
  expiresAt: number;
  revoked: boolean;
}

export interface FtMandateConfirmResult {
  confirmed: boolean;
  mandateToken?: string;
  expiresAt?: number;
  reason?: string;
}

export interface ConsumeFtMandateParams {
  mandateToken: string;
  metabotId: number;
  action: FtMandateAction | FtMandateAction[];
  assetKey: string;
  rail?: FtMandateRail;
  spendAmount?: string | number | bigint;
  lots?: number;
  nowMs?: number;
}

export interface ConsumeFtMandateResult {
  mandateToken: string;
  remainingSpendAmount: string;
  remainingLots: number;
  expiresAt: number;
}

export type FtMandatePromptHandler = (
  prompt: FtMandatePromptEvent,
) => Promise<{ approved: boolean; reason?: string }> | void;

export const DEFAULT_FT_MANDATE_TTL_MS = 5 * 60 * 1000;
export const DEFAULT_FT_PROMPT_TIMEOUT_MS = 120 * 1000;

const VALID_ACTIONS = new Set<FtMandateAction>(['buy-sweep', 'list-lots', 'cancel']);
const VALID_RAILS = new Set<FtMandateRail>(['btc-psbt', 'mvc-tokensell', 'me-escrow']);

export class FtMandateError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'FtMandateError';
    this.code = code;
  }
}

export function normalizeFtAssetKey(assetKey: unknown): string {
  const raw = typeof assetKey === 'string' ? assetKey.trim().toLowerCase() : '';
  if (!raw) {
    throw new FtMandateError('INVALID_ASSET_KEY', 'assetKey is required');
  }
  if (raw.startsWith('mrc20:')) {
    const mrc20Id = raw.slice('mrc20:'.length).trim();
    if (!mrc20Id || /\s/.test(mrc20Id)) {
      throw new FtMandateError('INVALID_ASSET_KEY', `Invalid MRC-20 assetKey: ${raw}`);
    }
    return `mrc20:${mrc20Id}`;
  }
  if (raw.startsWith('mvc-ft:')) {
    const rest = raw.slice('mvc-ft:'.length);
    const parts = rest.split(':');
    if (parts.length !== 2 || !parts[0]?.trim() || !parts[1]?.trim() || /\s/.test(rest)) {
      throw new FtMandateError(
        'INVALID_ASSET_KEY',
        `Invalid MVC FT assetKey (expected mvc-ft:<codehash>:<genesis>): ${raw}`,
      );
    }
    return `mvc-ft:${parts[0].trim()}:${parts[1].trim()}`;
  }
  throw new FtMandateError(
    'INVALID_ASSET_KEY',
    `Unsupported assetKey prefix (expected mrc20: or mvc-ft:): ${raw}`,
  );
}

function parseNonNegativeBigInt(value: unknown, fieldName: string): bigint {
  if (typeof value === 'bigint') {
    if (value < 0n) {
      throw new FtMandateError('INVALID_AMOUNT', `${fieldName} must be non-negative`);
    }
    return value;
  }
  const text = String(value ?? '0').trim();
  if (!/^\d+$/.test(text)) {
    throw new FtMandateError('INVALID_AMOUNT', `${fieldName} must be a non-negative integer string`);
  }
  return BigInt(text);
}

export function validateFtMandateDraft(raw: Partial<FtMandateDraft> | null | undefined): FtMandateDraft {
  if (!raw || typeof raw !== 'object') {
    throw new FtMandateError('INVALID_DRAFT', 'Mandate draft must be an object');
  }
  const metabotId = Number(raw.metabotId);
  if (!Number.isInteger(metabotId) || metabotId <= 0) {
    throw new FtMandateError('INVALID_DRAFT', 'metabotId must be a positive integer');
  }
  const action = String(raw.action ?? '').trim() as FtMandateAction;
  if (!VALID_ACTIONS.has(action)) {
    throw new FtMandateError('INVALID_DRAFT', `Invalid mandate action: ${String(raw.action)}`);
  }
  const rail = String(raw.rail ?? '').trim() as FtMandateRail;
  if (!VALID_RAILS.has(rail)) {
    throw new FtMandateError('INVALID_DRAFT', `Invalid mandate rail: ${String(raw.rail)}`);
  }
  const assetKey = normalizeFtAssetKey(raw.assetKey);
  const symbol = String(raw.symbol ?? '').trim() || 'TOKEN';
  const lotCount = Number(raw.lotCount);
  if (!Number.isInteger(lotCount) || lotCount <= 0 || lotCount > 100) {
    throw new FtMandateError('INVALID_DRAFT', 'lotCount must be an integer between 1 and 100');
  }
  const maxSpendBigInt = parseNonNegativeBigInt(raw.maxSpendAmount ?? '0', 'maxSpendAmount');
  if (action === 'buy-sweep' && maxSpendBigInt <= 0n) {
    throw new FtMandateError('INVALID_DRAFT', 'maxSpendAmount must be > 0 for buy-sweep');
  }

  return {
    metabotId,
    action,
    assetKey,
    symbol,
    ...(raw.decimals !== undefined && Number.isInteger(Number(raw.decimals))
      ? { decimals: Number(raw.decimals) }
      : {}),
    rail,
    totalTokenDisplay: String(raw.totalTokenDisplay ?? '').trim() || `${lotCount} lots`,
    lotCount,
    maxSpendDisplay: String(raw.maxSpendDisplay ?? '').trim() || maxSpendBigInt.toString(),
    maxSpendAmount: maxSpendBigInt.toString(),
    estimatedGasDisplay: String(raw.estimatedGasDisplay ?? '').trim() || '-',
    caVerified: raw.caVerified === true,
    ...(typeof raw.sessionId === 'string' && raw.sessionId.trim()
      ? { sessionId: raw.sessionId.trim() }
      : {}),
  };
}

interface PendingPromptState {
  resolve: (decision: { approved: boolean; reason?: string }) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class FtMandateGate {
  private readonly mandates = new Map<string, FtMandateRecord>();
  private readonly pendingPrompts = new Map<string, PendingPromptState>();
  private promptEmitter: ((event: FtMandatePromptEvent) => boolean | Promise<boolean>) | null = null;
  private directApprover:
    | ((event: FtMandatePromptEvent) => Promise<{ approved: boolean; reason?: string }>)
    | null = null;

  /**
   * Wire a UI broadcast emitter (e.g. BrowserWindow `ftTrade:mandatePrompt`).
   * The emitter returns `true` if at least one active renderer window received
   * the prompt; if `false`, confirmation immediately denies by default.
   */
  setPromptEmitter(
    emitter: ((event: FtMandatePromptEvent) => boolean | Promise<boolean>) | null,
  ): void {
    this.promptEmitter = emitter;
  }

  /**
   * Optional direct approver hook (primarily for deterministic integration tests).
   */
  setDirectApprover(
    approver: ((event: FtMandatePromptEvent) => Promise<{ approved: boolean; reason?: string }>) | null,
  ): void {
    this.directApprover = approver;
  }

  /**
   * Resolve a pending UI prompt from `ipcMain.handle('ftTrade:mandateRespond')`.
   */
  resolvePrompt(requestId: string, approved: boolean, reason?: string): boolean {
    const key = String(requestId || '').trim();
    const pending = this.pendingPrompts.get(key);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this.pendingPrompts.delete(key);
    pending.resolve({ approved: approved === true, reason });
    return true;
  }

  async requestMandate(
    rawDraft: Partial<FtMandateDraft>,
    options?: {
      ttlMs?: number;
      promptTimeoutMs?: number;
      nowMs?: number;
    },
  ): Promise<FtMandateConfirmResult> {
    const draft = validateFtMandateDraft(rawDraft);
    const now = options?.nowMs ?? Date.now();
    const ttlMs =
      options?.ttlMs && options.ttlMs > 0 ? options.ttlMs : DEFAULT_FT_MANDATE_TTL_MS;
    const promptTimeoutMs =
      options?.promptTimeoutMs && options.promptTimeoutMs > 0
        ? options.promptTimeoutMs
        : DEFAULT_FT_PROMPT_TIMEOUT_MS;

    this.pruneExpired(now);

    const requestId = `ftreq_${crypto.randomBytes(12).toString('hex')}`;
    const promptEvent: FtMandatePromptEvent = {
      requestId,
      draft,
      expiresAt: now + promptTimeoutMs,
      timeoutMs: promptTimeoutMs,
    };

    const decision = await this.awaitOwnerDecision(promptEvent, promptTimeoutMs);
    if (!decision.approved) {
      return {
        confirmed: false,
        reason: decision.reason || 'denied_by_owner',
      };
    }

    const issuedAt = options?.nowMs ?? Date.now();
    const expiresAt = issuedAt + ttlMs;
    const mandateToken = `ftm_${crypto.randomBytes(18).toString('hex')}`;
    const record: FtMandateRecord = {
      mandateToken,
      metabotId: draft.metabotId,
      action: draft.action,
      assetKey: draft.assetKey,
      symbol: draft.symbol,
      rail: draft.rail,
      maxSpendAmount: BigInt(draft.maxSpendAmount),
      spentAmount: 0n,
      maxLots: draft.lotCount,
      usedLots: 0,
      createdAt: issuedAt,
      expiresAt,
      revoked: false,
    };
    this.mandates.set(mandateToken, record);

    return {
      confirmed: true,
      mandateToken,
      expiresAt,
    };
  }

  private async awaitOwnerDecision(
    promptEvent: FtMandatePromptEvent,
    timeoutMs: number,
  ): Promise<{ approved: boolean; reason?: string }> {
    if (this.directApprover) {
      let timer: ReturnType<typeof setTimeout> | null = null;
      try {
        const timeoutPromise = new Promise<{ approved: boolean; reason?: string }>((resolve) => {
          timer = setTimeout(() => {
            resolve({ approved: false, reason: 'timeout_denied' });
          }, timeoutMs);
        });
        const res = await Promise.race([this.directApprover(promptEvent), timeoutPromise]);
        return { approved: res?.approved === true, reason: res?.reason };
      } catch {
        return { approved: false, reason: 'approver_error_denied' };
      } finally {
        if (timer) clearTimeout(timer);
      }
    }

    if (!this.promptEmitter) {
      return { approved: false, reason: 'prompt_unavailable_denied' };
    }

    return new Promise<{ approved: boolean; reason?: string }>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingPrompts.delete(promptEvent.requestId);
        resolve({ approved: false, reason: 'timeout_denied' });
      }, timeoutMs);

      this.pendingPrompts.set(promptEvent.requestId, { resolve, timer });

      Promise.resolve(this.promptEmitter!(promptEvent))
        .then((delivered) => {
          if (!delivered && this.pendingPrompts.has(promptEvent.requestId)) {
            clearTimeout(timer);
            this.pendingPrompts.delete(promptEvent.requestId);
            resolve({ approved: false, reason: 'no_renderer_window_denied' });
          }
        })
        .catch(() => {
          if (this.pendingPrompts.has(promptEvent.requestId)) {
            clearTimeout(timer);
            this.pendingPrompts.delete(promptEvent.requestId);
            resolve({ approved: false, reason: 'emit_error_denied' });
          }
        });
    });
  }

  /**
   * Validate a mandate without deducting budget (e.g. pre-flight check or
   * multi-step split followed by list-lots where split checks authorization
   * and list-lots consumes lot count).
   */
  verifyMandate(params: Omit<ConsumeFtMandateParams, 'spendAmount' | 'lots'>): FtMandateRecord {
    const token = String(params.mandateToken ?? '').trim();
    if (!token) {
      throw new FtMandateError('MANDATE_REQUIRED', 'mandateToken is required');
    }
    const record = this.mandates.get(token);
    if (!record) {
      throw new FtMandateError('MANDATE_NOT_FOUND', 'Unknown or expired mandateToken');
    }
    if (record.revoked) {
      throw new FtMandateError('MANDATE_REVOKED', 'mandateToken has been revoked');
    }
    const now = params.nowMs ?? Date.now();
    if (now >= record.expiresAt) {
      this.mandates.delete(token);
      throw new FtMandateError('MANDATE_EXPIRED', 'mandateToken has expired');
    }
    if (record.metabotId !== Number(params.metabotId)) {
      throw new FtMandateError(
        'MANDATE_METABOT_MISMATCH',
        `mandateToken belongs to metabotId ${record.metabotId}, not ${params.metabotId}`,
      );
    }
    const allowedActions = Array.isArray(params.action) ? params.action : [params.action];
    if (!allowedActions.includes(record.action)) {
      throw new FtMandateError(
        'MANDATE_ACTION_MISMATCH',
        `mandateToken action '${record.action}' cannot authorize '${allowedActions.join('|')}'`,
      );
    }
    const requestedAssetKey = normalizeFtAssetKey(params.assetKey);
    if (record.assetKey !== requestedAssetKey) {
      throw new FtMandateError(
        'MANDATE_ASSET_MISMATCH',
        `mandateToken asset '${record.assetKey}' cannot authorize '${requestedAssetKey}'`,
      );
    }
    if (params.rail && record.rail !== params.rail) {
      throw new FtMandateError(
        'MANDATE_RAIL_MISMATCH',
        `mandateToken rail '${record.rail}' cannot authorize '${params.rail}'`,
      );
    }
    return record;
  }

  /**
   * Atomically verify mandate scope and deduct spendAmount / lot count.
   */
  consumeMandate(params: ConsumeFtMandateParams): ConsumeFtMandateResult {
    const record = this.verifyMandate(params);
    const spend = parseNonNegativeBigInt(params.spendAmount ?? 0n, 'spendAmount');
    const lots = params.lots === undefined ? 1 : Number(params.lots);
    if (!Number.isInteger(lots) || lots < 0) {
      throw new FtMandateError('INVALID_LOTS', 'lots must be a non-negative integer');
    }

    if (record.usedLots + lots > record.maxLots) {
      throw new FtMandateError(
        'MANDATE_LOT_LIMIT_EXCEEDED',
        `Mandate lot limit exceeded (${record.usedLots + lots} > ${record.maxLots})`,
      );
    }

    if (record.spentAmount + spend > record.maxSpendAmount) {
      throw new FtMandateError(
        'MANDATE_BUDGET_EXCEEDED',
        `Mandate spend ceiling exceeded (${(record.spentAmount + spend).toString()} > ${record.maxSpendAmount.toString()})`,
      );
    }

    record.spentAmount += spend;
    record.usedLots += lots;

    return {
      mandateToken: record.mandateToken,
      remainingSpendAmount: (record.maxSpendAmount - record.spentAmount).toString(),
      remainingLots: record.maxLots - record.usedLots,
      expiresAt: record.expiresAt,
    };
  }

  /**
   * Restore budget/lots if a pre-sign verification or network call aborts
   * before any chain broadcast or escrow lock occurred.
   */
  rollbackMandate(mandateToken: string, spendAmount: string | number | bigint = 0n, lots = 1): void {
    const record = this.mandates.get(String(mandateToken || '').trim());
    if (!record) return;
    const spend = parseNonNegativeBigInt(spendAmount, 'spendAmount');
    record.spentAmount = record.spentAmount > spend ? record.spentAmount - spend : 0n;
    if (Number.isInteger(lots) && lots > 0) {
      record.usedLots = Math.max(0, record.usedLots - lots);
    }
  }

  revokeMandate(mandateToken: string): boolean {
    const record = this.mandates.get(String(mandateToken || '').trim());
    if (!record) return false;
    record.revoked = true;
    this.mandates.delete(record.mandateToken);
    return true;
  }

  getMandateSnapshot(mandateToken: string): Omit<FtMandateRecord, 'maxSpendAmount' | 'spentAmount'> & {
    maxSpendAmount: string;
    spentAmount: string;
  } | null {
    const record = this.mandates.get(String(mandateToken || '').trim());
    if (!record) return null;
    return {
      ...record,
      maxSpendAmount: record.maxSpendAmount.toString(),
      spentAmount: record.spentAmount.toString(),
    };
  }

  pruneExpired(nowMs = Date.now()): void {
    for (const [token, record] of this.mandates.entries()) {
      if (record.revoked || nowMs >= record.expiresAt) {
        this.mandates.delete(token);
      }
    }
  }

  resetForTesting(): void {
    for (const pending of this.pendingPrompts.values()) {
      clearTimeout(pending.timer);
      pending.resolve({ approved: false, reason: 'reset' });
    }
    this.pendingPrompts.clear();
    this.mandates.clear();
    this.promptEmitter = null;
    this.directApprover = null;
  }
}

export const defaultFtMandateGate = new FtMandateGate();
