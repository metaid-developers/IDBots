import test from 'node:test';
import assert from 'node:assert/strict';

import { freshDb, seedUserAndTenant } from './helpers.js';
import { recordBundleOrderCredit } from '../src/services/bundleOrderCredit.js';
import { HttpError } from '../src/http.js';

/**
 * Payment-success credit trigger (payment credit channel, NEW capability —
 * no C2/C3 contract change). When a bundle order is observed PAID/CREDITED
 * (client voucher / upstream C4 status), recordBundleOrderCredit turns that
 * one observation into exactly one credit_ledger row — source 'bundle-order',
 * reference_key = the upstream orderId. The HTTP admin surface itself
 * (bearer-token 401/404 shapes) is covered in the credit route tests; this
 * file pins the trigger semantics: one paid order → one ledger row, a
 * replayed payment notification never double-credits.
 */

const PAID_ORDER = {
  orderId: 'bo_1h2j3k4l5m',
  planId: 'bundle_basic_cny',
  payAmount: '19.90',
  payCurrency: 'CNY',
  trafficBytes: 104857600,
};

function seededDb() {
  const db = freshDb();
  seedUserAndTenant(db, {
    userId: 'u_credit',
    phone: '+8613900000100',
    tenantId: 't_credit',
    status: 'active',
  });
  return db;
}

function ledgerRows(db: import('better-sqlite3').Database): { id: number; user_id: string; bytes_total: number; source: string; reference_key: string | null }[] {
  return db
    .prepare('SELECT id, user_id, bytes_total, source, reference_key FROM credit_ledger ORDER BY id')
    .all() as never;
}

test('one paid bundle order triggers exactly one credit row with the orderId as reference', () => {
  const db = seededDb();
  const result = recordBundleOrderCredit(
    { db },
    { userId: 'u_credit', order: PAID_ORDER },
    'ops-yuan',
  );

  assert.equal(result.duplicate, false);
  assert.equal(result.source, 'bundle-order');
  assert.equal(result.referenceKey, 'bo_1h2j3k4l5m');
  assert.equal(result.bytes, 104857600);
  assert.equal(result.userId, 'u_credit');
  assert.equal(result.actor, 'admin:ops-yuan');
  assert.match(result.reason, /bundle order bo_1h2j3k4l5m paid 19\.90 CNY/);
  assert.match(result.reason, /plan bundle_basic_cny/);

  const rows = ledgerRows(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, 'bundle-order');
  assert.equal(rows[0].reference_key, 'bo_1h2j3k4l5m');
  assert.equal(rows[0].bytes_total, 104857600);

  // One paired audit_log row for the grant (actor/admin convention).
  const audits = db
    .prepare("SELECT actor, target FROM audit_log WHERE action = 'credit.grant'")
    .all() as { actor: string; target: string }[];
  assert.equal(audits.length, 1);
  assert.equal(audits[0].actor, 'admin:ops-yuan');
  assert.equal(audits[0].target, 'u_credit');
});

test('replaying the payment-success observation never credits twice', () => {
  const db = seededDb();
  const first = recordBundleOrderCredit({ db }, { userId: 'u_credit', order: PAID_ORDER }, 'ops-yuan');
  const replay = recordBundleOrderCredit({ db }, { userId: 'u_credit', order: PAID_ORDER }, 'ops-yuan');

  assert.equal(replay.duplicate, true);
  assert.equal(replay.creditId, first.creditId);

  const rows = ledgerRows(db);
  assert.equal(rows.length, 1, 'a replayed notification is a no-op on the ledger');
  const audits = db
    .prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'credit.grant'")
    .get() as { n: number };
  assert.equal(audits.n, 1);
});

test('a different orderId still grants — the ledger keys on the upstream order id, not the user', () => {
  const db = seededDb();
  recordBundleOrderCredit({ db }, { userId: 'u_credit', order: PAID_ORDER }, 'ops-yuan');
  const second = recordBundleOrderCredit(
    { db },
    { userId: 'u_credit', order: { ...PAID_ORDER, orderId: 'bo_zz9x8y7w6v' } },
    'ops-yuan',
  );

  assert.equal(second.duplicate, false);
  assert.notEqual(second.creditId, ledgerRows(db)[0].id);
  assert.equal(ledgerRows(db).length, 2);
});

test('a paid order without its upstream orderId is refused (no idempotency key, no grant)', () => {
  const db = seededDb();
  assert.throws(
    () =>
      recordBundleOrderCredit(
        { db },
        { userId: 'u_credit', order: { ...PAID_ORDER, orderId: '   ' } },
        'ops-yuan',
      ),
    (err: unknown) =>
      err instanceof HttpError && err.status === 400 && err.code === 'MISSING_ORDER_ID',
  );
  assert.equal(ledgerRows(db).length, 0);
});
