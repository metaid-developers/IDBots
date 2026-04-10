import { Database } from 'sql.js';
import { v4 as uuidv4 } from 'uuid';
import {
  computeOrderDeadlines,
  type ServiceOrderStatus,
} from './services/serviceOrderState';
import { parseGigSquareSettlementAsset } from './shared/gigSquareSettlementAsset.js';

interface ServiceOrderRow {
  id: string;
  role: string;
  local_metabot_id: number;
  counterparty_global_metaid: string;
  service_pin_id: string | null;
  service_name: string;
  payment_txid: string;
  payment_chain: string;
  payment_amount: string;
  payment_currency: string;
  settlement_kind: string;
  mrc20_ticker: string | null;
  mrc20_id: string | null;
  payment_commit_txid: string | null;
  order_message_pin_id: string | null;
  cowork_session_id: string | null;
  status: string;
  first_response_deadline_at: number;
  delivery_deadline_at: number;
  first_response_at: number | null;
  delivery_message_pin_id: string | null;
  delivered_at: number | null;
  failed_at: number | null;
  failure_reason: string | null;
  refund_request_pin_id: string | null;
  refund_finalize_pin_id: string | null;
  refund_txid: string | null;
  refund_requested_at: number | null;
  refund_completed_at: number | null;
  refund_apply_retry_count: number;
  next_retry_at: number | null;
  created_at: number;
  updated_at: number;
}

export type ServiceOrderRole = 'buyer' | 'seller';

export interface ServiceOrderRecord {
  id: string;
  role: ServiceOrderRole;
  localMetabotId: number;
  counterpartyGlobalMetaid: string;
  servicePinId: string | null;
  serviceName: string;
  paymentTxid: string;
  paymentChain: string;
  paymentAmount: string;
  paymentCurrency: string;
  settlementKind: 'native' | 'mrc20';
  mrc20Ticker: string | null;
  mrc20Id: string | null;
  paymentCommitTxid: string | null;
  orderMessagePinId: string | null;
  coworkSessionId: string | null;
  status: ServiceOrderStatus;
  firstResponseDeadlineAt: number;
  deliveryDeadlineAt: number;
  firstResponseAt: number | null;
  deliveryMessagePinId: string | null;
  deliveredAt: number | null;
  failedAt: number | null;
  failureReason: string | null;
  refundRequestPinId: string | null;
  refundFinalizePinId: string | null;
  refundTxid: string | null;
  refundRequestedAt: number | null;
  refundCompletedAt: number | null;
  refundApplyRetryCount: number;
  nextRetryAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface ServiceOrderSessionSummary {
  role: ServiceOrderRole;
  status: ServiceOrderStatus;
  failureReason: string | null;
  refundRequestPinId: string | null;
  refundTxid: string | null;
}

export interface ServiceOrderProviderRefundRiskRecord {
  providerGlobalMetaId: string;
  oldestRefundRequestedAt: number;
  unresolvedRefundCount: number;
}

export interface ServiceOrderCreateInput {
  role: ServiceOrderRole;
  localMetabotId: number;
  counterpartyGlobalMetaid: string;
  servicePinId?: string | null;
  serviceName: string;
  paymentTxid: string;
  paymentChain?: string;
  paymentAmount: string;
  paymentCurrency?: string;
  settlementKind?: string;
  mrc20Ticker?: string;
  mrc20Id?: string;
  paymentCommitTxid?: string;
  orderMessagePinId?: string | null;
  coworkSessionId?: string | null;
  status?: ServiceOrderStatus;
  now?: number;
}

export interface ServiceOrderLookupByPaymentInput {
  role: ServiceOrderRole;
  localMetabotId: number;
  counterpartyGlobalMetaid: string;
  paymentTxid: string;
}

interface MarkRefundRequestRetryInput {
  attemptedAt: number;
  nextRetryAt: number;
}

function normalizePaymentChain(chain: string | undefined): string {
  const normalized = (chain || 'mvc').trim().toLowerCase();
  if (normalized === 'btc' || normalized === 'doge' || normalized === 'mvc') return normalized;
  return 'mvc';
}

function inferPaymentChainFromCurrency(currency: string | undefined): string {
  const normalized = String(currency || '').trim().toUpperCase();
  if (normalized === 'BTC') return 'btc';
  if (normalized === 'DOGE') return 'doge';
  return 'mvc';
}

function derivePaymentCurrency(chain: string): string {
  if (chain === 'btc') return 'BTC';
  if (chain === 'doge') return 'DOGE';
  return 'SPACE';
}

function normalizeOptionalText(value: unknown): string | null {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized || null;
}

function resolveStructuredSettlement(input: {
  paymentChain?: string;
  paymentCurrency?: string;
  settlementKind?: string;
  mrc20Ticker?: string;
  mrc20Id?: string;
}) {
  const hintedPaymentChain = input.paymentChain
    ? normalizePaymentChain(input.paymentChain)
    : inferPaymentChainFromCurrency(input.paymentCurrency);
  const settlement = parseGigSquareSettlementAsset({
    paymentCurrency: normalizeOptionalText(input.paymentCurrency) || derivePaymentCurrency(hintedPaymentChain),
    settlementKind: normalizeOptionalText(input.settlementKind),
    mrc20Ticker: normalizeOptionalText(input.mrc20Ticker),
    mrc20Id: normalizeOptionalText(input.mrc20Id),
  });

  if (settlement.settlementKind === 'mrc20') {
    return {
      paymentChain: 'btc',
      paymentCurrency: settlement.protocolCurrency,
      settlementKind: 'mrc20' as const,
      mrc20Ticker: settlement.mrc20Ticker,
      mrc20Id: settlement.mrc20Id,
    };
  }

  const paymentChain = hintedPaymentChain;
  return {
    paymentChain,
    paymentCurrency: derivePaymentCurrency(paymentChain),
    settlementKind: 'native' as const,
    mrc20Ticker: null,
    mrc20Id: null,
  };
}

function listTableColumns(db: Database, tableName: string): string[] {
  const result = db.exec(`PRAGMA table_info(${tableName});`);
  if (!result[0]?.values) return [];
  return result[0].values.map((row) => String(row[1] || ''));
}

const SERVICE_ORDER_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS service_orders (
    id TEXT PRIMARY KEY,
    role TEXT NOT NULL CHECK (role IN ('buyer', 'seller')),
    local_metabot_id INTEGER NOT NULL,
    counterparty_global_metaid TEXT NOT NULL,
    service_pin_id TEXT,
    service_name TEXT NOT NULL,
    payment_txid TEXT NOT NULL,
    payment_chain TEXT NOT NULL CHECK (payment_chain IN ('mvc', 'btc', 'doge')),
    payment_amount TEXT NOT NULL,
    payment_currency TEXT NOT NULL,
    settlement_kind TEXT NOT NULL DEFAULT 'native' CHECK (settlement_kind IN ('native', 'mrc20')),
    mrc20_ticker TEXT,
    mrc20_id TEXT,
    payment_commit_txid TEXT,
    order_message_pin_id TEXT,
    cowork_session_id TEXT,
    status TEXT NOT NULL CHECK (status IN ('awaiting_first_response', 'in_progress', 'completed', 'failed', 'refund_pending', 'refunded')),
    first_response_deadline_at INTEGER NOT NULL,
    delivery_deadline_at INTEGER NOT NULL,
    first_response_at INTEGER,
    delivery_message_pin_id TEXT,
    delivered_at INTEGER,
    failed_at INTEGER,
    failure_reason TEXT,
    refund_request_pin_id TEXT,
    refund_finalize_pin_id TEXT,
    refund_txid TEXT,
    refund_requested_at INTEGER,
    refund_completed_at INTEGER,
    refund_apply_retry_count INTEGER NOT NULL DEFAULT 0,
    next_retry_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
`;

export class ServiceOrderStore {
  private db: Database;
  private saveDb: () => void;

  constructor(db: Database, saveDb: () => void) {
    this.db = db;
    this.saveDb = saveDb;
    this.ensureSchema();
  }

  private ensureSchema(): void {
    this.migrateLegacyServiceOrdersTable();
    this.db.run(SERVICE_ORDER_TABLE_SQL);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_service_orders_status_updated_at
      ON service_orders(status, updated_at DESC);
    `);
    this.db.run(`
      CREATE TRIGGER IF NOT EXISTS trg_service_orders_role_insert
      BEFORE INSERT ON service_orders
      WHEN NEW.role NOT IN ('buyer', 'seller')
      BEGIN
        SELECT RAISE(ABORT, 'Invalid service_orders.role');
      END;
    `);
    this.db.run(`
      CREATE TRIGGER IF NOT EXISTS trg_service_orders_role_update
      BEFORE UPDATE OF role ON service_orders
      WHEN NEW.role NOT IN ('buyer', 'seller')
      BEGIN
        SELECT RAISE(ABORT, 'Invalid service_orders.role');
      END;
    `);
    this.db.run(`
      CREATE TRIGGER IF NOT EXISTS trg_service_orders_status_insert
      BEFORE INSERT ON service_orders
      WHEN NEW.status NOT IN ('awaiting_first_response', 'in_progress', 'completed', 'failed', 'refund_pending', 'refunded')
      BEGIN
        SELECT RAISE(ABORT, 'Invalid service_orders.status');
      END;
    `);
    this.db.run(`
      CREATE TRIGGER IF NOT EXISTS trg_service_orders_status_update
      BEFORE UPDATE OF status ON service_orders
      WHEN NEW.status NOT IN ('awaiting_first_response', 'in_progress', 'completed', 'failed', 'refund_pending', 'refunded')
      BEGIN
        SELECT RAISE(ABORT, 'Invalid service_orders.status');
      END;
    `);
    this.db.run(`
      CREATE TRIGGER IF NOT EXISTS trg_service_orders_payment_chain_insert
      BEFORE INSERT ON service_orders
      WHEN NEW.payment_chain NOT IN ('mvc', 'btc', 'doge')
      BEGIN
        SELECT RAISE(ABORT, 'Invalid service_orders.payment_chain');
      END;
    `);
    this.db.run(`
      CREATE TRIGGER IF NOT EXISTS trg_service_orders_payment_chain_update
      BEFORE UPDATE OF payment_chain ON service_orders
      WHEN NEW.payment_chain NOT IN ('mvc', 'btc', 'doge')
      BEGIN
        SELECT RAISE(ABORT, 'Invalid service_orders.payment_chain');
      END;
    `);
    this.db.run(`
      CREATE TRIGGER IF NOT EXISTS trg_service_orders_payment_currency_insert
      BEFORE INSERT ON service_orders
      WHEN NOT (
        (NEW.settlement_kind = 'native' AND NEW.payment_currency IN ('SPACE', 'BTC', 'DOGE'))
        OR (
          NEW.settlement_kind = 'mrc20'
          AND NEW.payment_chain = 'btc'
          AND NEW.mrc20_ticker IS NOT NULL
          AND trim(NEW.mrc20_ticker) <> ''
          AND NEW.mrc20_id IS NOT NULL
          AND trim(NEW.mrc20_id) <> ''
          AND NEW.payment_currency = upper(trim(NEW.mrc20_ticker)) || '-MRC20'
        )
      )
      BEGIN
        SELECT RAISE(ABORT, 'Invalid service_orders.payment_currency');
      END;
    `);
    this.db.run(`
      CREATE TRIGGER IF NOT EXISTS trg_service_orders_payment_currency_update
      BEFORE UPDATE OF payment_currency ON service_orders
      WHEN NOT (
        (NEW.settlement_kind = 'native' AND NEW.payment_currency IN ('SPACE', 'BTC', 'DOGE'))
        OR (
          NEW.settlement_kind = 'mrc20'
          AND NEW.payment_chain = 'btc'
          AND NEW.mrc20_ticker IS NOT NULL
          AND trim(NEW.mrc20_ticker) <> ''
          AND NEW.mrc20_id IS NOT NULL
          AND trim(NEW.mrc20_id) <> ''
          AND NEW.payment_currency = upper(trim(NEW.mrc20_ticker)) || '-MRC20'
        )
      )
      BEGIN
        SELECT RAISE(ABORT, 'Invalid service_orders.payment_currency');
      END;
    `);
    this.remediateLegacyServiceOrderRows();
    this.remediateDuplicatePaymentRows();
    this.db.run(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_service_orders_dedupe_payment
      ON service_orders(local_metabot_id, role, payment_txid);
    `);
  }

  private migrateLegacyServiceOrdersTable(): void {
    const columns = listTableColumns(this.db, 'service_orders');
    if (columns.length === 0) return;
    if (
      columns.includes('settlement_kind')
      && columns.includes('mrc20_ticker')
      && columns.includes('mrc20_id')
      && columns.includes('payment_commit_txid')
    ) {
      return;
    }

    this.db.run('BEGIN TRANSACTION;');
    try {
      this.db.run('ALTER TABLE service_orders RENAME TO service_orders_legacy_mrc20_migration;');
      this.db.run(SERVICE_ORDER_TABLE_SQL);
      this.db.run(`
        INSERT INTO service_orders (
          id, role, local_metabot_id, counterparty_global_metaid, service_pin_id, service_name,
          payment_txid, payment_chain, payment_amount, payment_currency, settlement_kind,
          mrc20_ticker, mrc20_id, payment_commit_txid, order_message_pin_id, cowork_session_id,
          status, first_response_deadline_at, delivery_deadline_at, first_response_at,
          delivery_message_pin_id, delivered_at, failed_at, failure_reason, refund_request_pin_id,
          refund_finalize_pin_id, refund_txid, refund_requested_at, refund_completed_at,
          refund_apply_retry_count, next_retry_at, created_at, updated_at
        )
        SELECT
          id,
          role,
          local_metabot_id,
          counterparty_global_metaid,
          service_pin_id,
          service_name,
          payment_txid,
          CASE
            WHEN lower(trim(payment_chain)) IN ('mvc', 'btc', 'doge') THEN lower(trim(payment_chain))
            WHEN upper(trim(payment_currency)) = 'BTC' THEN 'btc'
            WHEN upper(trim(payment_currency)) = 'DOGE' THEN 'doge'
            ELSE 'mvc'
          END,
          payment_amount,
          CASE
            WHEN lower(trim(payment_chain)) = 'btc' OR upper(trim(payment_currency)) = 'BTC' THEN 'BTC'
            WHEN lower(trim(payment_chain)) = 'doge' OR upper(trim(payment_currency)) = 'DOGE' THEN 'DOGE'
            ELSE 'SPACE'
          END,
          'native',
          NULL,
          NULL,
          NULL,
          order_message_pin_id,
          cowork_session_id,
          status,
          first_response_deadline_at,
          delivery_deadline_at,
          first_response_at,
          delivery_message_pin_id,
          delivered_at,
          failed_at,
          failure_reason,
          refund_request_pin_id,
          refund_finalize_pin_id,
          refund_txid,
          refund_requested_at,
          refund_completed_at,
          refund_apply_retry_count,
          next_retry_at,
          created_at,
          updated_at
        FROM service_orders_legacy_mrc20_migration;
      `);
      this.db.run('DROP TABLE service_orders_legacy_mrc20_migration;');
      this.db.run('COMMIT;');
    } catch (error) {
      this.db.run('ROLLBACK;');
      throw error;
    }
  }

  private remediateLegacyServiceOrderRows(): void {
    this.db.run(`
      UPDATE service_orders
      SET settlement_kind = lower(trim(settlement_kind))
      WHERE settlement_kind IS NOT NULL;
    `);
    this.db.run(`
      UPDATE service_orders
      SET settlement_kind = 'native'
      WHERE settlement_kind NOT IN ('native', 'mrc20')
         OR settlement_kind IS NULL
         OR trim(settlement_kind) = '';
    `);
    this.db.run(`
      UPDATE service_orders
      SET payment_chain = lower(trim(payment_chain))
      WHERE payment_chain IS NOT NULL;
    `);
    this.db.run(`
      UPDATE service_orders
      SET payment_chain = 'btc'
      WHERE settlement_kind = 'mrc20';
    `);
    this.db.run(`
      UPDATE service_orders
      SET payment_chain = 'mvc'
      WHERE settlement_kind <> 'mrc20'
        AND payment_chain NOT IN ('mvc', 'btc', 'doge');
    `);
    this.db.run(`
      UPDATE service_orders
      SET payment_currency = upper(trim(payment_currency))
      WHERE payment_currency IS NOT NULL;
    `);
    this.db.run(`
      UPDATE service_orders
      SET mrc20_ticker = upper(trim(
        COALESCE(
          NULLIF(mrc20_ticker, ''),
          CASE
            WHEN upper(trim(payment_currency)) LIKE '%-MRC20'
              THEN substr(upper(trim(payment_currency)), 1, length(upper(trim(payment_currency))) - 6)
            ELSE ''
          END
        )
      ))
      WHERE settlement_kind = 'mrc20';
    `);
    this.db.run(`
      UPDATE service_orders
      SET payment_currency = CASE
        WHEN settlement_kind = 'mrc20' AND trim(COALESCE(mrc20_ticker, '')) <> ''
          THEN upper(trim(mrc20_ticker)) || '-MRC20'
        WHEN payment_chain = 'btc' THEN 'BTC'
        WHEN payment_chain = 'doge' THEN 'DOGE'
        ELSE 'SPACE'
      END;
    `);
    this.db.run(`
      UPDATE service_orders
      SET mrc20_ticker = NULL,
          mrc20_id = NULL,
          payment_commit_txid = NULL
      WHERE settlement_kind <> 'mrc20';
    `);
    this.db.run(`
      UPDATE service_orders
      SET payment_currency = CASE
        WHEN payment_chain = 'btc' THEN 'BTC'
        WHEN payment_chain = 'doge' THEN 'DOGE'
        ELSE 'SPACE'
      END
      WHERE settlement_kind <> 'mrc20'
        AND (payment_currency NOT IN ('SPACE', 'BTC', 'DOGE')
          OR (payment_chain = 'mvc' AND payment_currency = 'MVC'));
    `);
  }

  private remediateDuplicatePaymentRows(): void {
    this.db.run(`
      WITH ranked AS (
        SELECT
          rowid,
          ROW_NUMBER() OVER (
            PARTITION BY local_metabot_id, role, payment_txid
            ORDER BY updated_at DESC, created_at DESC, id DESC
          ) AS rank_in_group
        FROM service_orders
      )
      DELETE FROM service_orders
      WHERE rowid IN (
        SELECT rowid FROM ranked WHERE rank_in_group > 1
      );
    `);
  }

  private getOne<T>(sql: string, params: (string | number | null)[] = []): T | undefined {
    const result = this.db.exec(sql, params);
    if (!result[0]?.values[0]) return undefined;
    const columns = result[0].columns;
    const values = result[0].values[0];
    const row: Record<string, unknown> = {};
    columns.forEach((column, index) => {
      row[column] = values[index];
    });
    return row as T;
  }

  private getAll<T>(sql: string, params: (string | number | null)[] = []): T[] {
    const result = this.db.exec(sql, params);
    if (!result[0]?.values) return [];
    const columns = result[0].columns;
    return result[0].values.map((values) => {
      const row: Record<string, unknown> = {};
      columns.forEach((column, index) => {
        row[column] = values[index];
      });
      return row as T;
    });
  }

  private mapRow(row: ServiceOrderRow): ServiceOrderRecord {
    return {
      id: row.id,
      role: row.role as ServiceOrderRole,
      localMetabotId: row.local_metabot_id,
      counterpartyGlobalMetaid: row.counterparty_global_metaid,
      servicePinId: row.service_pin_id,
      serviceName: row.service_name,
      paymentTxid: row.payment_txid,
      paymentChain: row.payment_chain,
      paymentAmount: row.payment_amount,
      paymentCurrency: row.payment_currency,
      settlementKind: row.settlement_kind === 'mrc20' ? 'mrc20' : 'native',
      mrc20Ticker: row.mrc20_ticker,
      mrc20Id: row.mrc20_id,
      paymentCommitTxid: row.payment_commit_txid,
      orderMessagePinId: row.order_message_pin_id,
      coworkSessionId: row.cowork_session_id,
      status: row.status as ServiceOrderStatus,
      firstResponseDeadlineAt: row.first_response_deadline_at,
      deliveryDeadlineAt: row.delivery_deadline_at,
      firstResponseAt: row.first_response_at,
      deliveryMessagePinId: row.delivery_message_pin_id,
      deliveredAt: row.delivered_at,
      failedAt: row.failed_at,
      failureReason: row.failure_reason,
      refundRequestPinId: row.refund_request_pin_id,
      refundFinalizePinId: row.refund_finalize_pin_id,
      refundTxid: row.refund_txid,
      refundRequestedAt: row.refund_requested_at,
      refundCompletedAt: row.refund_completed_at,
      refundApplyRetryCount: row.refund_apply_retry_count,
      nextRetryAt: row.next_retry_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  createOrder(input: ServiceOrderCreateInput): ServiceOrderRecord {
    const now = input.now ?? Date.now();
    const deadlines = computeOrderDeadlines(now);
    const settlement = resolveStructuredSettlement({
      paymentChain: input.paymentChain,
      paymentCurrency: input.paymentCurrency,
      settlementKind: input.settlementKind,
      mrc20Ticker: input.mrc20Ticker,
      mrc20Id: input.mrc20Id,
    });
    const paymentCommitTxid = settlement.settlementKind === 'mrc20'
      ? normalizeOptionalText(input.paymentCommitTxid)
      : null;
    const existing = this.getOne<ServiceOrderRow>(
      `SELECT * FROM service_orders WHERE local_metabot_id = ? AND role = ? AND payment_txid = ? LIMIT 1`,
      [input.localMetabotId, input.role, input.paymentTxid]
    );
    if (existing) return this.mapRow(existing);
    const id = uuidv4();

    try {
      this.db.run(`
        INSERT INTO service_orders (
          id, role, local_metabot_id, counterparty_global_metaid, service_pin_id, service_name,
          payment_txid, payment_chain, payment_amount, payment_currency, settlement_kind,
          mrc20_ticker, mrc20_id, payment_commit_txid, order_message_pin_id, cowork_session_id,
          status, first_response_deadline_at, delivery_deadline_at, first_response_at, delivery_message_pin_id,
          delivered_at, failed_at, failure_reason, refund_request_pin_id, refund_finalize_pin_id, refund_txid,
          refund_requested_at, refund_completed_at, refund_apply_retry_count, next_retry_at, created_at, updated_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL, ?, ?
        );
      `, [
        id,
        input.role,
        input.localMetabotId,
        input.counterpartyGlobalMetaid,
        input.servicePinId ?? null,
        input.serviceName,
        input.paymentTxid,
        settlement.paymentChain,
        input.paymentAmount,
        settlement.paymentCurrency,
        settlement.settlementKind,
        settlement.mrc20Ticker,
        settlement.mrc20Id,
        paymentCommitTxid,
        input.orderMessagePinId ?? null,
        input.coworkSessionId ?? null,
        input.status ?? 'awaiting_first_response',
        deadlines.firstResponseDeadlineAt,
        deadlines.deliveryDeadlineAt,
        now,
        now,
      ]);
    } catch (error) {
      const raced = this.getOne<ServiceOrderRow>(
        `SELECT * FROM service_orders WHERE local_metabot_id = ? AND role = ? AND payment_txid = ? LIMIT 1`,
        [input.localMetabotId, input.role, input.paymentTxid]
      );
      if (raced) return this.mapRow(raced);
      throw error;
    }

    this.saveDb();
    return this.getOrderById(id)!;
  }

  getOrderById(id: string): ServiceOrderRecord | null {
    const row = this.getOne<ServiceOrderRow>('SELECT * FROM service_orders WHERE id = ?', [id]);
    return row ? this.mapRow(row) : null;
  }

  listOrdersByRole(role: ServiceOrderRole): ServiceOrderRecord[] {
    return this.getAll<ServiceOrderRow>(
      'SELECT * FROM service_orders WHERE role = ? ORDER BY created_at DESC',
      [role]
    ).map((row) => this.mapRow(row));
  }

  listOrdersByPaymentTxid(paymentTxid: string): ServiceOrderRecord[] {
    return this.getAll<ServiceOrderRow>(`
      SELECT *
      FROM service_orders
      WHERE payment_txid = ?
      ORDER BY updated_at DESC, created_at DESC
    `, [paymentTxid]).map((row) => this.mapRow(row));
  }

  getSessionSummary(coworkSessionId: string): ServiceOrderSessionSummary | null {
    const row = this.getOne<ServiceOrderRow>(`
      SELECT *
      FROM service_orders
      WHERE cowork_session_id = ?
      ORDER BY updated_at DESC, created_at DESC
      LIMIT 1
    `, [coworkSessionId]);
    if (!row) return null;

    return {
      role: row.role as ServiceOrderRole,
      status: row.status as ServiceOrderStatus,
      failureReason: row.failure_reason,
      refundRequestPinId: row.refund_request_pin_id,
      refundTxid: row.refund_txid,
    };
  }

  findLatestOrderBySessionId(coworkSessionId: string): ServiceOrderRecord | null {
    const row = this.getOne<ServiceOrderRow>(`
      SELECT *
      FROM service_orders
      WHERE cowork_session_id = ?
      ORDER BY updated_at DESC, created_at DESC
      LIMIT 1
    `, [coworkSessionId]);
    return row ? this.mapRow(row) : null;
  }

  listOrdersByStatuses(
    role: ServiceOrderRole,
    statuses: ServiceOrderStatus[]
  ): ServiceOrderRecord[] {
    if (statuses.length === 0) return [];
    const placeholders = statuses.map(() => '?').join(', ');
    return this.getAll<ServiceOrderRow>(`
      SELECT *
      FROM service_orders
      WHERE role = ?
        AND status IN (${placeholders})
      ORDER BY updated_at DESC, created_at DESC
    `, [role, ...statuses]).map((row) => this.mapRow(row));
  }

  listRefundRequestRetryCandidates(
    role: ServiceOrderRole,
    now: number
  ): ServiceOrderRecord[] {
    return this.getAll<ServiceOrderRow>(`
      SELECT *
      FROM service_orders
      WHERE role = ?
        AND status = 'failed'
        AND refund_request_pin_id IS NULL
        AND (next_retry_at IS NULL OR next_retry_at <= ?)
      ORDER BY updated_at DESC, created_at DESC
    `, [role, now]).map((row) => this.mapRow(row));
  }

  findOrderByPayment(input: ServiceOrderLookupByPaymentInput): ServiceOrderRecord | null {
    const row = this.getOne<ServiceOrderRow>(`
      SELECT *
      FROM service_orders
      WHERE role = ?
        AND local_metabot_id = ?
        AND counterparty_global_metaid = ?
        AND payment_txid = ?
      LIMIT 1
    `, [
      input.role,
      input.localMetabotId,
      input.counterpartyGlobalMetaid,
      input.paymentTxid,
    ]);
    return row ? this.mapRow(row) : null;
  }

  findLatestOpenOrderForPair(
    role: ServiceOrderRole,
    localMetabotId: number,
    counterpartyGlobalMetaid: string
  ): ServiceOrderRecord | null {
    const row = this.getOne<ServiceOrderRow>(`
      SELECT *
      FROM service_orders
      WHERE role = ?
        AND local_metabot_id = ?
        AND counterparty_global_metaid = ?
        AND status NOT IN ('completed', 'refunded')
      ORDER BY updated_at DESC, created_at DESC, id DESC
      LIMIT 1
    `, [role, localMetabotId, counterpartyGlobalMetaid]);
    return row ? this.mapRow(row) : null;
  }

  findByRefundRequestPinId(refundRequestPinId: string): ServiceOrderRecord | null {
    const row = this.getOne<ServiceOrderRow>(`
      SELECT *
      FROM service_orders
      WHERE refund_request_pin_id = ?
      LIMIT 1
    `, [refundRequestPinId]);
    return row ? this.mapRow(row) : null;
  }

  listByRefundRequestPinId(refundRequestPinId: string): ServiceOrderRecord[] {
    return this.getAll<ServiceOrderRow>(`
      SELECT *
      FROM service_orders
      WHERE refund_request_pin_id = ?
      ORDER BY updated_at DESC, created_at DESC
    `, [refundRequestPinId]).map((row) => this.mapRow(row));
  }

  listProviderRefundRisks(): ServiceOrderProviderRefundRiskRecord[] {
    return this.getAll<{
      provider_global_metaid: string;
      oldest_refund_requested_at: number;
      unresolved_refund_count: number;
    }>(`
      SELECT
        counterparty_global_metaid AS provider_global_metaid,
        MIN(refund_requested_at) AS oldest_refund_requested_at,
        COUNT(*) AS unresolved_refund_count
      FROM service_orders
      WHERE role = 'buyer'
        AND refund_request_pin_id IS NOT NULL
        AND refund_completed_at IS NULL
      GROUP BY counterparty_global_metaid
      ORDER BY oldest_refund_requested_at ASC
    `).map((row) => ({
      providerGlobalMetaId: row.provider_global_metaid,
      oldestRefundRequestedAt: Number(row.oldest_refund_requested_at),
      unresolvedRefundCount: Number(row.unresolved_refund_count),
    }));
  }

  markFirstResponseReceived(orderId: string, receivedAt: number): ServiceOrderRecord | null {
    const order = this.getOrderById(orderId);
    if (!order) return null;
    if (order.status !== 'awaiting_first_response' && order.status !== 'in_progress') {
      return order;
    }

    this.db.run(`
      UPDATE service_orders
      SET
        status = CASE
          WHEN status = 'awaiting_first_response' THEN 'in_progress'
          ELSE status
        END,
        first_response_at = COALESCE(first_response_at, ?),
        updated_at = ?
      WHERE id = ?
    `, [receivedAt, receivedAt, orderId]);
    this.saveDb();
    return this.getOrderById(orderId);
  }

  markDelivered(
    orderId: string,
    input: {
      deliveryMessagePinId: string | null;
      deliveredAt: number;
    }
  ): ServiceOrderRecord | null {
    const order = this.getOrderById(orderId);
    if (!order) return null;
    if (order.status === 'failed' || order.status === 'refund_pending' || order.status === 'refunded') {
      return order;
    }

    this.db.run(`
      UPDATE service_orders
      SET
        status = 'completed',
        first_response_at = COALESCE(first_response_at, ?),
        delivery_message_pin_id = COALESCE(?, delivery_message_pin_id),
        delivered_at = ?,
        updated_at = ?
      WHERE id = ?
    `, [
      input.deliveredAt,
      input.deliveryMessagePinId,
      input.deliveredAt,
      input.deliveredAt,
      orderId,
    ]);
    this.saveDb();
    return this.getOrderById(orderId);
  }

  markFailed(orderId: string, failureReason: string, failedAt: number): ServiceOrderRecord | null {
    const order = this.getOrderById(orderId);
    if (!order) return null;
    if (order.status === 'refund_pending' || order.status === 'refunded') {
      return order;
    }

    this.db.run(`
      UPDATE service_orders
      SET
        status = 'failed',
        failed_at = COALESCE(failed_at, ?),
        failure_reason = COALESCE(failure_reason, ?),
        updated_at = ?
      WHERE id = ?
    `, [failedAt, failureReason, failedAt, orderId]);
    this.saveDb();
    return this.getOrderById(orderId);
  }

  markRefundPending(
    orderId: string,
    refundRequestPinId: string | null,
    requestedAt: number
  ): ServiceOrderRecord | null {
    const order = this.getOrderById(orderId);
    if (!order) return null;
    if (order.status === 'refunded') {
      return order;
    }

    this.db.run(`
      UPDATE service_orders
      SET
        status = 'refund_pending',
        refund_request_pin_id = COALESCE(?, refund_request_pin_id),
        refund_requested_at = COALESCE(refund_requested_at, ?),
        next_retry_at = NULL,
        updated_at = ?
      WHERE id = ?
    `, [refundRequestPinId, requestedAt, requestedAt, orderId]);
    this.saveDb();
    return this.getOrderById(orderId);
  }

  markRefundRequestRetry(
    orderId: string,
    input: MarkRefundRequestRetryInput
  ): ServiceOrderRecord | null {
    const order = this.getOrderById(orderId);
    if (!order) return null;
    if (order.status === 'refund_pending' || order.status === 'refunded') {
      return order;
    }

    this.db.run(`
      UPDATE service_orders
      SET
        refund_apply_retry_count = refund_apply_retry_count + 1,
        next_retry_at = ?,
        updated_at = ?
      WHERE id = ?
    `, [input.nextRetryAt, input.attemptedAt, orderId]);
    this.saveDb();
    return this.getOrderById(orderId);
  }

  markRefunded(
    orderId: string,
    input: {
      refundTxid: string;
      refundFinalizePinId: string;
      refundCompletedAt: number;
    }
  ): ServiceOrderRecord | null {
    const order = this.getOrderById(orderId);
    if (!order) return null;
    if (order.status === 'refunded') {
      return order;
    }

    this.db.run(`
      UPDATE service_orders
      SET
        status = 'refunded',
        refund_txid = ?,
        refund_finalize_pin_id = ?,
        refund_completed_at = ?,
        next_retry_at = NULL,
        updated_at = ?
      WHERE id = ?
    `, [
      input.refundTxid,
      input.refundFinalizePinId,
      input.refundCompletedAt,
      input.refundCompletedAt,
      orderId,
    ]);
    this.saveDb();
    return this.getOrderById(orderId);
  }

  markRefundedLocally(
    orderId: string,
    input: {
      resolvedAt: number;
      failureReason?: string | null;
    }
  ): ServiceOrderRecord | null {
    const order = this.getOrderById(orderId);
    if (!order) return null;
    if (order.status === 'refunded') {
      return order;
    }

    const failureReason = String(input.failureReason || '').trim();
    this.db.run(`
      UPDATE service_orders
      SET
        status = 'refunded',
        failed_at = COALESCE(failed_at, ?),
        failure_reason = CASE
          WHEN COALESCE(failure_reason, '') = '' AND ? <> '' THEN ?
          ELSE failure_reason
        END,
        refund_requested_at = COALESCE(refund_requested_at, ?),
        refund_completed_at = COALESCE(refund_completed_at, ?),
        next_retry_at = NULL,
        updated_at = ?
      WHERE id = ?
    `, [
      input.resolvedAt,
      failureReason,
      failureReason,
      input.resolvedAt,
      input.resolvedAt,
      input.resolvedAt,
      orderId,
    ]);
    this.saveDb();
    return this.getOrderById(orderId);
  }

  setCoworkSessionId(orderId: string, coworkSessionId: string): ServiceOrderRecord | null {
    const order = this.getOrderById(orderId);
    if (!order) return null;
    const normalizedSessionId = String(coworkSessionId || '').trim();
    if (!normalizedSessionId) {
      return order;
    }
    if (order.coworkSessionId === normalizedSessionId) {
      return order;
    }

    this.db.run(`
      UPDATE service_orders
      SET
        cowork_session_id = ?,
        updated_at = ?
      WHERE id = ?
    `, [
      normalizedSessionId,
      Date.now(),
      orderId,
    ]);
    this.saveDb();
    return this.getOrderById(orderId);
  }

  repairOrderServiceReference(
    orderId: string,
    input: {
      servicePinId: string;
      serviceName?: string | null;
    }
  ): ServiceOrderRecord | null {
    const order = this.getOrderById(orderId);
    if (!order) return null;

    const normalizedServicePinId = String(input.servicePinId || '').trim();
    if (!normalizedServicePinId) {
      return order;
    }

    const normalizedServiceName = String(input.serviceName || '').trim();
    if (
      order.servicePinId === normalizedServicePinId
      && (!normalizedServiceName || order.serviceName === normalizedServiceName)
    ) {
      return order;
    }

    this.db.run(`
      UPDATE service_orders
      SET
        service_pin_id = ?,
        service_name = CASE
          WHEN ? <> '' THEN ?
          ELSE service_name
        END
      WHERE id = ?
    `, [
      normalizedServicePinId,
      normalizedServiceName,
      normalizedServiceName,
      orderId,
    ]);
    this.saveDb();
    return this.getOrderById(orderId);
  }

  recordRefundTransfer(
    orderId: string,
    input: {
      refundTxid: string;
      recordedAt: number;
    }
  ): ServiceOrderRecord | null {
    const order = this.getOrderById(orderId);
    if (!order) return null;
    if (order.status === 'refunded') {
      return order;
    }
    if (order.refundTxid) {
      return order;
    }

    this.db.run(`
      UPDATE service_orders
      SET
        refund_txid = ?,
        updated_at = ?
      WHERE id = ?
    `, [
      input.refundTxid,
      input.recordedAt,
      orderId,
    ]);
    this.saveDb();
    return this.getOrderById(orderId);
  }
}
