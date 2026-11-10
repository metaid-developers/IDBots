/**
 * Swap ledger — the single source of truth for the MetaBot Avatar swap pilot
 * (PRD §5.7 state machine, prereview #9/#10 field requirements).
 *
 * Storage: a dedicated SQLite file (node:sqlite, standalone from the app so
 * the headless engine can run while IDBots is closed). All timestamps are ms
 * epoch UTC; the report layer converts for display.
 *
 * State machine (visible states per PRD §5.7, plus crash-recovery pending
 * states — a pending state means "broadcast, txid/pinId in hand, awaiting
 * chain confirmation"; recovery ALWAYS resumes from the recorded reference
 * and never re-broadcasts):
 *
 *   detected → claimed → mint_pending → minted → send_pending → sent
 *       → burn_pending → burned
 *   detected → rejected → refunded          (foreign album / duplicate index)
 *
 * Invariants enforced here (mechanical, prereview #1/#2/#9):
 *  - one ACTIVE row per tokenIndex (states mint_pending..sent block a second
 *    deposit of the same index; burned/rejected/refunded rows do not);
 *  - one row per deposit outpoint (UNIQUE) — a re-detected UTXO updates its
 *    row instead of duplicating;
 *  - legal-transition map: no state jumps, every transition leaves an audit
 *    trail in swap_events;
 *  - burn candidates = sent rows with a stable transferCount (set by caller);
 *    mid-flight rows can never enter a burn batch (prereview #10);
 *  - every insert/update writes one swap_events row (每步一条链证据的本地账).
 */

import { DatabaseSync } from 'node:sqlite';

export const LEDGER_STATES = Object.freeze([
  'detected',
  'claimed',
  'mint_pending',
  'minted',
  'send_pending',
  'sent',
  'burn_pending',
  'burned',
  'rejected',
  'refunded',
]);

/** Visible terminal/active partition used by the tokenIndex single-lock. */
const ACTIVE_STATES = Object.freeze(['detected', 'claimed', 'mint_pending', 'minted', 'send_pending', 'sent']);

const LEGAL_TRANSITIONS = Object.freeze({
  detected: ['claimed', 'rejected'],
  claimed: ['mint_pending', 'rejected'],
  mint_pending: ['minted', 'rejected'],
  minted: ['send_pending'],
  send_pending: ['sent'],
  sent: ['burn_pending'],
  burn_pending: ['burned'],
  rejected: ['refunded'],
  refunded: ['detected'],
  burned: [],
});

const SCHEMA = `
CREATE TABLE IF NOT EXISTS swap_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  genesis TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  token_index INTEGER NOT NULL,
  state TEXT NOT NULL,
  sensible_id TEXT,
  deposit_txid TEXT,
  deposit_vout INTEGER,
  deposit_outpoint TEXT UNIQUE,
  deposit_height INTEGER,
  detected_at INTEGER,
  claim_channel TEXT,
  claim_message_id TEXT,
  claimant_address TEXT,
  claimed_at INTEGER,
  item_path TEXT,
  mint_pin_id TEXT,
  mint_txids TEXT,
  dual_check_json TEXT,
  minted_at INTEGER,
  confirm_json TEXT,
  transfer_txid TEXT,
  transfer_count INTEGER,
  transfer_stable_since INTEGER,
  sent_at INTEGER,
  burn_batch_id TEXT,
  burn_txid TEXT,
  burned_at INTEGER,
  reject_reason TEXT,
  refund_txid TEXT,
  refunded_at INTEGER,
  fee_sats_json TEXT,
  notes TEXT,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ledger_token ON swap_ledger (genesis, token_index);
CREATE INDEX IF NOT EXISTS idx_ledger_state ON swap_ledger (state);
CREATE TABLE IF NOT EXISTS swap_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ledger_id INTEGER NOT NULL,
  event TEXT NOT NULL,
  from_state TEXT,
  to_state TEXT,
  evidence_json TEXT,
  at_ms INTEGER NOT NULL
);
`;

export class SwapLedger {
  /**
   * @param {string} dbPath absolute path to the ledger sqlite file
   */
  constructor(dbPath) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.db.exec(SCHEMA);
  }

  close() {
    try {
      this.db.close();
    } catch {
      // tolerate double-close; never fail callers on cleanup
    }
  }

  #event(ledgerId, event, fromState, toState, evidence) {
    this.db.prepare(
      'INSERT INTO swap_events (ledger_id, event, from_state, to_state, evidence_json, at_ms) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(ledgerId, event, fromState ?? null, toState ?? null, evidence ? JSON.stringify(evidence) : null, Date.now());
  }

  rowById(id) {
    return this.db.prepare('SELECT * FROM swap_ledger WHERE id = ?').get(id) ?? null;
  }

  /** Active (non-terminal) row for a tokenIndex, if any — the single-lock. */
  activeRowByToken(genesis, tokenIndex) {
    return (
      this.db
        .prepare(
          `SELECT * FROM swap_ledger WHERE genesis = ? AND token_index = ? AND state IN (${ACTIVE_STATES.map(() => '?').join(',')}) ORDER BY id DESC LIMIT 1`,
        )
        .get(genesis, tokenIndex, ...ACTIVE_STATES) ?? null
    );
  }

  rowByOutpoint(outpoint) {
    return this.db.prepare('SELECT * FROM swap_ledger WHERE deposit_outpoint = ?').get(outpoint) ?? null;
  }

  /**
   * Record a newly detected deposit (engine vault poll). Returns
   * { row, created }. When the tokenIndex already has an ACTIVE row, the new
   * deposit is still recorded — but flagged rejected (duplicate index); the
   * caller decides refund handling. When the SAME outpoint is re-seen, the
   * existing row is refreshed (height/confirmations) instead of duplicated.
   */
  recordDetection({
    genesis,
    codeHash,
    tokenIndex,
    sensibleId = null,
    depositTxid,
    depositVout,
    depositHeight,
  }) {
    const outpoint = `${depositTxid}:${depositVout}`;
    const now = Date.now();
    const existing = this.rowByOutpoint(outpoint);
    if (existing) {
      this.db
        .prepare('UPDATE swap_ledger SET deposit_height = ?, updated_at = ? WHERE id = ?')
        .run(depositHeight ?? null, now, existing.id);
      return { row: this.rowById(existing.id), created: false };
    }

    const blocker = this.activeRowByToken(genesis, tokenIndex);
    const state = blocker ? 'rejected' : 'detected';
    const rejectReason = blocker
      ? `duplicate deposit while tokenIndex ${tokenIndex} is ${blocker.state} (ledger id ${blocker.id})`
      : null;
    const info = this.db
      .prepare(
        `INSERT INTO swap_ledger
          (genesis, code_hash, token_index, state, sensible_id, deposit_txid, deposit_vout, deposit_outpoint, deposit_height, detected_at, reject_reason, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        genesis,
        codeHash,
        tokenIndex,
        state,
        sensibleId,
        depositTxid,
        depositVout ?? null,
        outpoint,
        depositHeight ?? null,
        now,
        rejectReason,
        now,
      );
    const id = Number(info.lastInsertRowid);
    this.#event(id, blocker ? 'detect_rejected_duplicate' : 'detected', null, state, { outpoint, depositHeight });
    return { row: this.rowById(id), created: true };
  }

  /**
   * Claim a detected row (PRD §4b fallback flow / chat claim). Primary key
   * semantics per prereview #9: (genesis, tokenIndex) + claim message id.
   */
  claim(rowId, { channel, messageId, claimantAddress }) {
    return this.#transition(rowId, 'claimed', 'claim', {
      claim_channel: channel ?? null,
      claim_message_id: messageId ?? null,
      claimant_address: claimantAddress ?? null,
      claimed_at: Date.now(),
    });
  }

  /**
   * Mint broadcast succeeded (pinId in hand). Crash-recovery invariant: the
   * pinId is persisted BEFORE anything else happens downstream; recovery
   * resumes confirmations from this record and must never re-mint.
   */
  recordMintBroadcast(rowId, { itemPath, mintPinId, txids, dualCheck }) {
    return this.#transition(rowId, 'mint_pending', 'mint_broadcast', {
      item_path: itemPath ?? null,
      mint_pin_id: mintPinId ?? null,
      mint_txids: JSON.stringify(txids ?? []),
      dual_check_json: JSON.stringify(dualCheck ?? {}),
    });
  }

  /** §5.6 confirm pipeline passed (creatorMinted + createAddress + output fields). */
  recordMintConfirmed(rowId, confirm) {
    return this.#transition(rowId, 'minted', 'mint_confirmed', {
      confirm_json: JSON.stringify(confirm ?? {}),
      minted_at: Date.now(),
    });
  }

  /** Old-token transfer broadcast (发货). Caller supplies the txid. */
  recordTransferBroadcast(rowId, { transferTxid, feeSats }) {
    return this.#transition(rowId, 'send_pending', 'transfer_broadcast', {
      transfer_txid: transferTxid ?? null,
      fee_sats_json: feeSats ? JSON.stringify(feeSats) : null,
    });
  }

  /**
   * Transfer confirmed stable (transferCount unchanged across a caller-defined
   * stability window). Only rows reaching `sent` may later enter burn batches
   * (prereview #10 待烧名单口径).
   */
  recordTransferStable(rowId, { transferCount }) {
    return this.#transition(rowId, 'sent', 'transfer_stable', {
      transfer_count: transferCount ?? null,
      transfer_stable_since: Date.now(),
      sent_at: Date.now(),
    });
  }

  /**
   * Enter a burn batch (sent → burn_pending). Batch assembly is the only road
   * out of `sent`; the batch id is attached here so a mid-batch crash shows
   * exactly which batch a token belonged to (owner sign-off precedes this).
   */
  enterBurnBatch(rowId, batchId) {
    if (!batchId) throw new Error('enterBurnBatch requires a batch id');
    return this.#transition(rowId, 'burn_pending', 'enter_burn_batch', { burn_batch_id: batchId });
  }

  /** Burn broadcast landed (burn_pending → burned). */
  recordBurnBroadcast(rowId, { batchId, burnTxid, feeSats }) {
    const patch = {
      burn_batch_id: batchId ?? null,
      burn_txid: burnTxid ?? null,
      burned_at: Date.now(),
    };
    if (feeSats != null) {
      const row = this.rowById(rowId);
      let fees = {};
      try {
        fees = row?.fee_sats_json ? JSON.parse(row.fee_sats_json) : {};
      } catch {
        fees = {};
      }
      fees.burn = feeSats;
      patch.fee_sats_json = JSON.stringify(fees);
    }
    return this.#transition(rowId, 'burned', 'burn_broadcast', patch);
  }

  /** Foreign-album / unusable deposit. */
  reject(rowId, reason) {
    return this.#transition(rowId, 'rejected', 'reject', { reject_reason: reason ?? null });
  }

  /** Original-route refund; the refund txid is REQUIRED (prereview #9). */
  refund(rowId, { refundTxid, feeSats }) {
    if (!refundTxid || !/^[0-9a-f]{64}$/i.test(refundTxid)) {
      throw new Error(`refund requires a plain 64-hex refund txid, got: ${refundTxid}`);
    }
    return this.#transition(rowId, 'refunded', 'refund', {
      refund_txid: refundTxid,
      refunded_at: Date.now(),
      ...(feeSats != null ? { fee_sats_json: JSON.stringify({ refund: feeSats }) } : {}),
    });
  }

  /**
   * Crash recovery: a refunded row may be re-detected later (the user re-deposits
   * the same index after refund). This is the ONLY path back to detected.
   */
  redetectAfterRefund(rowId, { depositTxid, depositVout, depositHeight }) {
    const row = this.rowById(rowId);
    if (!row || row.state !== 'refunded') {
      throw new Error(`redetect requires a refunded row, id=${rowId} state=${row?.state}`);
    }
    const outpoint = `${depositTxid}:${depositVout}`;
    this.db
      .prepare(
        `UPDATE swap_ledger SET state = 'detected', deposit_txid = ?, deposit_vout = ?, deposit_outpoint = ?,
         deposit_height = ?, detected_at = ?, reject_reason = NULL, updated_at = ? WHERE id = ?`,
      )
      .run(depositTxid, depositVout ?? null, outpoint, depositHeight ?? null, Date.now(), Date.now(), rowId);
    this.#event(rowId, 'redetect_after_refund', 'refunded', 'detected', { outpoint });
    return this.rowById(rowId);
  }

  /**
   * THE single gate for every state change: legal-transition map + event row.
   * External code cannot jump states (crash recovery correctness depends on
   * this; prereview #2a).
   */
  #transition(rowId, toState, event, patch = {}) {
    const row = this.rowById(rowId);
    if (!row) throw new Error(`ledger row not found: ${rowId}`);
    const fromState = row.state;
    const legal = LEGAL_TRANSITIONS[fromState] ?? [];
    if (!legal.includes(toState)) {
      throw new Error(`illegal ledger transition ${fromState} -> ${toState} (row ${rowId})`);
    }
    const sets = Object.keys(patch);
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE swap_ledger SET ${sets.map((k) => `${k} = ?`).join(', ')}, state = ?, updated_at = ? WHERE id = ?`,
      )
      .run(...sets.map((k) => patch[k] ?? null), toState, now, rowId);
    this.#event(rowId, event, fromState, toState, patch);
    return this.rowById(rowId);
  }

  rowsByStates(states) {
    const list = states.length ? states : LEDGER_STATES;
    return this.db
      .prepare(`SELECT * FROM swap_ledger WHERE state IN (${list.map(() => '?').join(',')}) ORDER BY id`)
      .all(...list);
  }

  /** Burn candidates: sent + transferCount stable (prereview #10 口径). */
  burnCandidates() {
    return this.db
      .prepare(
        `SELECT * FROM swap_ledger WHERE state = 'sent' AND transfer_txid IS NOT NULL AND transfer_count IS NOT NULL ORDER BY id`,
      )
      .all();
  }

  /**
   * 三桶对账 (prereview #9/#12b): bucket reads are computed here from the
   * ledger; the external buckets (wallet-api vault count, MAN totalnum) are
   * fetched by the daily job and compared against these.
   */
  reconCounts() {
    const officialMinted = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM swap_ledger WHERE state IN ('minted','send_pending','sent','burned')
         AND mint_pin_id IS NOT NULL`,
      )
      .get().n;
    const sent = this.db.prepare(`SELECT COUNT(*) AS n FROM swap_ledger WHERE state IN ('sent','burn_pending','burned')`).get().n;
    const vaultHolding = this.db
      .prepare(`SELECT COUNT(*) AS n FROM swap_ledger WHERE state IN ('detected','claimed','mint_pending','minted','send_pending','sent','burn_pending')`)
      .get().n;
    const burned = this.db.prepare(`SELECT COUNT(*) AS n FROM swap_ledger WHERE state = 'burned'`).get().n;
    const rejected = this.db.prepare(`SELECT COUNT(*) AS n FROM swap_ledger WHERE state IN ('rejected','refunded')`).get().n;
    return { officialMinted, sent, vaultHolding, burned, rejected };
  }

  eventsFor(rowId) {
    return this.db.prepare('SELECT * FROM swap_events WHERE ledger_id = ? ORDER BY id').all(rowId);
  }
}
