/**
 * 「待核验」panel — the read side of「我已支付」(S3 fiat defect: records were
 * write-only; nothing listed them and the seller had no way to confirm).
 *
 * Server-rendered (no DOM), same harness as the other renderer suites. These
 * tests pin: rows carry order id / amount / memo / record time, a legacy row
 * without a status still renders as pending, a confirmed row renders its
 * badge instead of the confirm button, and the empty state exists. The
 * confirm WRITE itself is covered at module level in paymentPendingRecords
 * (this suite cannot click a button); the source wiring below pins that the
 * button calls that module function and re-reads storage.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import PendingPaymentRecordsPanel from '../src/renderer/components/settings/PendingPaymentRecordsPanel';
import { PENDING_PAYMENT_STORAGE_KEY } from '../src/renderer/components/chat/paymentPendingRecords';

const repoRoot = path.resolve(import.meta.dirname, '..');
const NOW = 1_800_000_000_000;

function createFakeStorage(seed: unknown) {
  const map = new Map<string, string>();
  if (seed !== undefined) map.set(PENDING_PAYMENT_STORAGE_KEY, JSON.stringify(seed));
  return {
    getItem: (key: string) => (map.has(key) ? map.get(key)! : null),
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  };
}

describe('PendingPaymentRecordsPanel — 待核验收款列表', () => {
  it('renders legacy (status-less) records as pending, with amount / memo / age', () => {
    const storage = createFakeStorage([
      { orderId: 'S3-LEGACY-0001', amountCents: 1234, memo: 'S3-LEGACY-0001', recordedAt: NOW - 5 * 60_000 },
    ]);
    const html = renderToStaticMarkup(React.createElement(PendingPaymentRecordsPanel, { storage, now: NOW }));

    assert.match(html, /data-pending-payment-panel="true"/);
    assert.match(html, /data-pending-record="true"/);
    assert.match(html, /data-record-status="pending"/);
    assert.match(html, /S3-LEGACY-0001/);
    assert.match(html, /¥12\.34/);
    assert.match(html, /Memo S3-LEGACY-0001/);
    assert.match(html, /5 min ago/);
    assert.match(html, /data-confirm-payment="S3-LEGACY-0001"/);
    assert.match(html, /Confirm received/);
  });

  it('renders a confirmed record with its badge and no confirm button', () => {
    const storage = createFakeStorage([
      {
        orderId: 'S3-DONE-0001',
        amountCents: 100,
        memo: 'S3-DONE-0001',
        recordedAt: NOW - 3 * 3_600_000,
        status: 'confirmed',
        confirmedAt: NOW - 60_000,
      },
    ]);
    const html = renderToStaticMarkup(React.createElement(PendingPaymentRecordsPanel, { storage, now: NOW }));

    assert.match(html, /data-record-status="confirmed"/);
    assert.match(html, /Payment confirmed/);
    assert.match(html, /3 h ago/);
    assert.doesNotMatch(html, /data-confirm-payment/);
    assert.doesNotMatch(html, /Confirm received/);
  });

  it('shows the empty state when there is nothing to verify', () => {
    const storage = createFakeStorage(undefined);
    const html = renderToStaticMarkup(React.createElement(PendingPaymentRecordsPanel, { storage, now: NOW }));

    assert.match(html, /No payment records waiting for confirmation/);
    assert.doesNotMatch(html, /data-pending-record="true"/);
  });

  it('is wired into the receiving-settings modal as a tab', () => {
    const settingsSource = fs.readFileSync(
      path.join(repoRoot, 'src/renderer/components/settings/PaymentReceivingSettings.tsx'),
      'utf8',
    );
    assert.match(settingsSource, /import PendingPaymentRecordsPanel from '\.\/PendingPaymentRecordsPanel';/);
    assert.match(settingsSource, /\{ key: 'pending', labelKey: 'paymentSettingsTabPending' \}/);
    assert.match(settingsSource, /state\.activeTab === 'pending' \? <PendingPaymentRecordsPanel \/> : null/);
  });

  it('the confirm button calls the persistence module and re-reads storage', () => {
    const panelSource = fs.readFileSync(
      path.join(repoRoot, 'src/renderer/components/settings/PendingPaymentRecordsPanel.tsx'),
      'utf8',
    );
    assert.match(panelSource, /confirmPendingPaymentRecord\(orderId, storage\)/);
    assert.match(panelSource, /setRecords\(listPendingPaymentRecords\(storage\)\)/);
    assert.match(panelSource, /data-confirm-payment=\{record\.orderId\}/);
  });
});
