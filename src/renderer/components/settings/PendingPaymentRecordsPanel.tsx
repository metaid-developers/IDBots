/**
 * PendingPaymentRecordsPanel — the read side of「我已支付」(S3 fiat slice).
 *
 * PaymentCard writes one local record per order when the buyer says they
 * paid; before this panel nothing consumed those records. Here the seller
 * sees every record (order id / amount / memo / when / how long ago) and can
 * confirm receipt, which flips the same localStorage row to 'confirmed'.
 *
 * Boundary (deliberate, not a TODO): personal Alipay transfers expose no
 * callback API and the records never leave this device. The loop therefore
 * closes on a human confirmation *on the machine that holds the record* —
 * not on a platform reconciliation, and not across devices. Cross-device
 * delivery of the buyer's claim would be a transport feature, out of scope.
 */

import React, { useCallback, useState } from 'react';
import { CheckCircleIcon, InboxIcon } from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import { formatCentsToYuan } from '../chat/paymentCardSyntax';
import {
  confirmPendingPaymentRecord,
  listPendingPaymentRecords,
  paymentRecordElapsed,
  type PendingPaymentRecord,
  type StorageLike,
} from '../chat/paymentPendingRecords';

const fillTemplate = (key: string, token: string, value: string): string =>
  i18nService.t(key).replace(token, value);

const elapsedText = (recordedAt: number, now: number): string => {
  const elapsed = paymentRecordElapsed(recordedAt, now);
  if (elapsed.unit === 'minute' && elapsed.value === 0) {
    return i18nService.t('pendingRecordsAgeJustNow');
  }
  const unitToken = elapsed.unit === 'minute' ? 'Minutes' : elapsed.unit === 'hour' ? 'Hours' : 'Days';
  return fillTemplate(`pendingRecordsAge${unitToken}`, '{n}', String(elapsed.value));
};

const PendingPaymentRecordsPanel: React.FC<{
  /** Injectable for tests; omitted = the page's localStorage. */
  storage?: StorageLike | null;
  /** Injectable clock for deterministic "how long ago" rows. */
  now?: number;
}> = ({ storage, now }) => {
  const [records, setRecords] = useState<PendingPaymentRecord[]>(() => listPendingPaymentRecords(storage));
  const clock = now ?? Date.now();

  const handleConfirm = useCallback(
    (orderId: string) => {
      if (!confirmPendingPaymentRecord(orderId, storage)) return;
      setRecords(listPendingPaymentRecords(storage));
    },
    [storage],
  );

  return (
    <div data-pending-payment-panel="true" className="flex flex-col gap-3">
      <p className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
        {i18nService.t('pendingRecordsHint')}
      </p>

      {records.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed dark:border-claude-darkBorder border-claude-border px-4 py-8 text-center">
          <InboxIcon className="h-6 w-6 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
          <span className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
            {i18nService.t('pendingRecordsEmpty')}
          </span>
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {records.map((record) => {
            const confirmed = record.status === 'confirmed';
            return (
              <li
                key={record.orderId}
                data-pending-record="true"
                data-record-status={confirmed ? 'confirmed' : 'pending'}
                className="rounded-xl border dark:border-claude-darkBorder border-claude-border px-3 py-2.5"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-baseline gap-1.5">
                      <span className="text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
                        {i18nService.t('pendingRecordsAmountLabel')}
                      </span>
                      <span className="text-[16px] font-semibold dark:text-claude-darkText text-claude-text">
                        ¥{formatCentsToYuan(record.amountCents)}
                      </span>
                    </div>
                    <div className="mt-0.5 break-all font-mono text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
                      {record.orderId}
                    </div>
                    <div className="mt-1 text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
                      {fillTemplate('pendingRecordsMemoLabel', '{memo}', record.memo)} ·{' '}
                      {fillTemplate('pendingRecordsRecordedAt', '{time}', new Date(record.recordedAt).toLocaleString())}
                    </div>
                    <div className="mt-0.5 text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
                      {elapsedText(record.recordedAt, clock)}
                      {confirmed && record.confirmedAt != null
                        ? ` · ${fillTemplate('pendingRecordsConfirmedAt', '{time}', new Date(record.confirmedAt).toLocaleString())}`
                        : ''}
                    </div>
                  </div>
                  {confirmed ? (
                    <span className="flex shrink-0 items-center gap-1 rounded-md bg-emerald-500/10 px-2 py-1 text-[11px] text-emerald-600 dark:text-emerald-400">
                      <CheckCircleIcon className="h-3.5 w-3.5" />
                      {i18nService.t('pendingRecordsConfirmed')}
                    </span>
                  ) : (
                    <button
                      type="button"
                      data-confirm-payment={record.orderId}
                      onClick={() => handleConfirm(record.orderId)}
                      className="shrink-0 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-1.5 text-[12px] font-medium text-emerald-600 transition-colors hover:bg-emerald-500/20 dark:text-emerald-400"
                    >
                      {i18nService.t('pendingRecordsConfirm')}
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <p className="text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
        {i18nService.t('pendingRecordsLocalOnly')}
      </p>
    </div>
  );
};

export default PendingPaymentRecordsPanel;
