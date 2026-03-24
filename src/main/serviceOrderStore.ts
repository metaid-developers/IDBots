import { Database } from 'sql.js';
import { v4 as uuidv4 } from 'uuid';
import {
  computeOrderDeadlines,
  type ServiceOrderStatus,
} from './services/serviceOrderState';

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
  orderMessagePinId?: string | null;
  coworkSessionId?: string | null;
  status?: ServiceOrderStatus;
  now?: number;
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
    payment_chain TEXT NOT NULL,
    payment_amount TEXT NOT NULL,
    payment_currency TEXT NOT NULL,
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
    try {
      this.db.run(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_service_orders_dedupe_payment
        ON service_orders(local_metabot_id, role, payment_txid);
      `);
    } catch (error) {
      console.warn('Failed to create service_orders unique dedupe index:', error);
    }
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
          payment_txid, payment_chain, payment_amount, payment_currency, order_message_pin_id, cowork_session_id,
          status, first_response_deadline_at, delivery_deadline_at, first_response_at, delivery_message_pin_id,
          delivered_at, failed_at, failure_reason, refund_request_pin_id, refund_finalize_pin_id, refund_txid,
          refund_requested_at, refund_completed_at, refund_apply_retry_count, next_retry_at, created_at, updated_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL, ?, ?
        );
      `, [
        id,
        input.role,
        input.localMetabotId,
        input.counterpartyGlobalMetaid,
        input.servicePinId ?? null,
        input.serviceName,
        input.paymentTxid,
        input.paymentChain ?? 'mvc',
        input.paymentAmount,
        input.paymentCurrency ?? 'MVC',
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
}
