import { useState } from 'react';
import { t } from '../../i18n';
import { getMobileElectron } from '../appBridge';
import { useMeters } from '../hooks/useMeters';
import { formatBytes } from '../format';
import { BottomSheet } from './BottomSheet';

/**
 * Redeem-code button + sheet, extracted from the old flat MeScreen so the
 * primary balance card and the traffic page can share ONE redeem channel
 * (IA-PLAN §3.5: the redeem flow itself is unchanged, only remounted).
 */
export function RedeemButton(): JSX.Element {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState('');
  const [feedback, setFeedback] = useState<{ ok: boolean; message: string } | null>(null);
  const { meters, reload } = useMeters();

  const submit = async () => {
    const result = await getMobileElectron().traffic.redeemCode({ code });
    if (result?.success && result.result) {
      setFeedback({ ok: true, message: t('mobile.me.redeemSuccess', { amount: formatBytes(result.result.trafficBytes) }) });
      await reload();
      setCode('');
    } else {
      setFeedback({ ok: false, message: t('mobile.me.redeemError') });
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="twin-button twin-button-secondary flex-1"
      >
        {t('mobile.me.redeemEntry')}
      </button>
      {open ? (
        <BottomSheet title={t('mobile.me.redeemTitle')} onClose={() => setOpen(false)}>
          <div className="flex flex-col gap-3">
            <input
              value={code}
              onChange={(event) => setCode(event.target.value)}
              placeholder={t('mobile.me.redeemPlaceholder')}
              aria-label={t('mobile.me.redeemPlaceholder')}
              className="twin-input"
            />
            {feedback ? (
              <p className={`twin-notice ${feedback.ok ? 'twin-notice-success' : 'twin-notice-error'}`}>{feedback.message}</p>
            ) : null}
            <p className="text-xs text-[var(--text-secondary)]">
              {`${t('mobile.me.trafficLabel')}: ${meters?.traffic ? formatBytes(meters.traffic.balanceBytes) : '—'}`}
            </p>
            <button
              type="button"
              onClick={() => void submit()}
              disabled={!code.trim()}
              className="twin-button twin-button-primary"
            >
              {t('mobile.me.redeemSubmit')}
            </button>
          </div>
        </BottomSheet>
      ) : null}
    </>
  );
}
