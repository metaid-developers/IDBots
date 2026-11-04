/**
 * escrowOrderStore — local persistence for S3 generalized escrow orders
 * (first-round runtime slice over the pure escrowOrderStateMachine).
 *
 * Storage contract (mirrors the machine's serialization note): the
 * `escrow_orders` table keeps one row per order; `payload` is the FULL
 * EscrowOrder JSON document (timeline, reminders, disputes, extension fields
 * included) and is the ONLY source of truth for machine behavior. The
 * id/kind/state/state_entered_at columns are mirrors for cheap queries and
 * list filtering — never edit them separately from the document.
 *
 * Table creation lives in SqliteStore.initializeTables (idempotent
 * CREATE TABLE IF NOT EXISTS — Database Upgrade Safety: an upgraded install
 * gets the empty table before any escrow tool runs, and no existing user
 * data is touched). This class only reads/writes rows.
 *
 * The store is deliberately dumb: all state-machine semantics (transitions,
 * gates, proofs, deadlines) stay in escrowOrderStateMachine.ts. Callers
 * apply a transition there, then persist the returned document with update().
 */

import type { SqliteDatabase as Database } from '../sqliteTypes';
import type {
  EscrowGoodsKind,
  EscrowOrder,
  EscrowState,
} from '../libs/escrowOrderStateMachine';

/** One escrow_orders row (payload parsed back into the order document). */
export interface EscrowOrderRow {
  id: string;
  /** Local MetaBot that CREATED the order (not necessarily a party). */
  metabotId: number;
  kind: EscrowGoodsKind;
  state: EscrowState;
  stateEnteredAt: number;
  payload: EscrowOrder;
  createdAt: number;
  updatedAt: number;
}

interface EscrowOrdersRawRow {
  id: string;
  metabot_id: number;
  kind: string;
  state: string;
  state_entered_at: number;
  payload: string;
  created_at: number;
  updated_at: number;
}

const rowToOrder = (row: EscrowOrdersRawRow): EscrowOrderRow | null => {
  let payload: EscrowOrder;
  try {
    payload = JSON.parse(row.payload) as EscrowOrder;
  } catch {
    // A corrupted document must never crash a list scan — skip the row.
    return null;
  }
  return {
    id: row.id,
    metabotId: Number(row.metabot_id),
    kind: row.kind as EscrowGoodsKind,
    state: row.state as EscrowState,
    stateEnteredAt: Number(row.state_entered_at),
    payload,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
};

export class EscrowOrderStore {
  private db: Database;
  private saveDb: () => void;

  constructor(db: Database, saveDb: () => void) {
    this.db = db;
    this.saveDb = saveDb;
  }

  /**
   * Insert a freshly created order document (state CREATED). The creator's
   * local metabot id is the indexed owner column; refuses duplicate ids.
   */
  create(order: EscrowOrder, metabotId: number): EscrowOrderRow {
    const now = Date.now();
    this.db.run(
      `INSERT INTO escrow_orders
         (id, metabot_id, kind, state, state_entered_at, payload, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        order.orderId,
        metabotId,
        order.goodsKind,
        order.state,
        order.stateEnteredAt,
        JSON.stringify(order),
        now,
        now,
      ],
    );
    this.saveDb();
    return this.getOrThrow(order.orderId);
  }

  /** One order by id, or null when unknown. */
  get(id: string): EscrowOrderRow | null {
    const rows = this.db.exec(
      'SELECT id, metabot_id, kind, state, state_entered_at, payload, created_at, updated_at FROM escrow_orders WHERE id = ? LIMIT 1',
      [id],
    );
    const raw = rows[0]?.values?.[0];
    if (!raw) return null;
    const [rowId, metabotId, kind, state, stateEnteredAt, payload, createdAt, updatedAt] = raw;
    return rowToOrder({
      id: String(rowId),
      metabot_id: Number(metabotId),
      kind: String(kind),
      state: String(state),
      state_entered_at: Number(stateEnteredAt),
      payload: String(payload),
      created_at: Number(createdAt),
      updated_at: Number(updatedAt),
    });
  }

  private getOrThrow(id: string): EscrowOrderRow {
    const row = this.get(id);
    if (!row) throw new Error(`escrow order ${id} disappeared right after write`);
    return row;
  }

  /** Orders CREATED by the given local MetaBot (newest write first). */
  listByCreator(metabotId: number): EscrowOrderRow[] {
    const rows = this.db.exec(
      `SELECT id, metabot_id, kind, state, state_entered_at, payload, created_at, updated_at
         FROM escrow_orders WHERE metabot_id = ? ORDER BY updated_at DESC`,
      [metabotId],
    );
    return (rows[0]?.values ?? []).map((raw) => rowToOrder({
      id: String(raw[0]),
      metabot_id: Number(raw[1]),
      kind: String(raw[2]),
      state: String(raw[3]),
      state_entered_at: Number(raw[4]),
      payload: String(raw[5]),
      created_at: Number(raw[6]),
      updated_at: Number(raw[7]),
    })).filter((row): row is EscrowOrderRow => row !== null);
  }

  /**
   * Orders where one of the given identity strings is a PARTY (seller /
   * buyer / escrowAgent in the order document's roles). Identities are the
   * exact strings roles were written with — the MVC address first, plus any
   * alias the tool layer recorded (metabot id as string, MetaID). Optional
   * state filter narrows to an explicit state list; party scan runs in JS
   * over the creator-indexed candidates so no LIKE escaping is involved.
   */
  listByParticipant(identities: string[], states?: EscrowState[]): EscrowOrderRow[] {
    const wanted = identities.map((identity) => String(identity ?? '').trim()).filter(Boolean);
    if (!wanted.length) return [];
    const rows = this.db.exec(
      `SELECT id, metabot_id, kind, state, state_entered_at, payload, created_at, updated_at
         FROM escrow_orders ORDER BY updated_at DESC`,
    );
    const out: EscrowOrderRow[] = [];
    for (const raw of rows[0]?.values ?? []) {
      const parsed = rowToOrder({
        id: String(raw[0]),
        metabot_id: Number(raw[1]),
        kind: String(raw[2]),
        state: String(raw[3]),
        state_entered_at: Number(raw[4]),
        payload: String(raw[5]),
        created_at: Number(raw[6]),
        updated_at: Number(raw[7]),
      });
      if (!parsed) continue;
      const roles = parsed.payload.roles ?? ({} as EscrowOrder['roles']);
      const isParty = wanted.includes(String(roles.seller ?? ''))
        || wanted.includes(String(roles.buyer ?? ''))
        || wanted.includes(String(roles.escrowAgent ?? ''));
      if (!isParty) continue;
      if (states && !states.includes(parsed.payload.state)) continue;
      out.push(parsed);
    }
    return out;
  }

  /**
   * Whole-document replace: persist the NEW EscrowOrder returned by
   * applyEscrowTransition. Mirrors state/state_entered_at into their columns
   * and bumps updated_at; created_at and the creator column are immutable.
   */
  update(order: EscrowOrder): EscrowOrderRow {
    const now = Date.now();
    const result = this.db.exec(
      'SELECT metabot_id, created_at FROM escrow_orders WHERE id = ? LIMIT 1',
      [order.orderId],
    );
    const existing = result[0]?.values?.[0];
    if (!existing) {
      throw new Error(`escrow order ${order.orderId} does not exist — nothing to update`);
    }
    this.db.run(
      `UPDATE escrow_orders
         SET kind = ?, state = ?, state_entered_at = ?, payload = ?, updated_at = ?
       WHERE id = ?`,
      [
        order.goodsKind,
        order.state,
        order.stateEnteredAt,
        JSON.stringify(order),
        now,
        order.orderId,
      ],
    );
    this.saveDb();
    return this.getOrThrow(order.orderId);
  }
}
