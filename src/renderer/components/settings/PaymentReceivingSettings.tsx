/**
 * PaymentReceivingSettings — 用户设置 · 收款信息 (S3 fiat slice 1).
 *
 * The owner configures how they receive Alipay money: a receiving-code link
 * (must be an https://qr.alipay.com/ code — variant C and the degrade card
 * both read it), an optional QR image (decoded in-place with jsQR so an
 * unreadable image is never stored), and an optional PID / display name.
 *
 * Storage contract (design doc 02): the whole form is encrypted with an
 * HKDF-derived, purpose-isolated key in the main process and stored in a
 * single local ciphertext row. Nothing here ever goes on-chain, and plain
 * values never enter logs. The renderer only round-trips the owner's own
 * form through the paymentInfo IPC; main re-validates every save.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import jsQR from 'jsqr';
import { PhotoIcon, TrashIcon } from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';

interface ReceivingFormState {
  payeeDisplayName: string;
  alipayPid: string;
  qrContent: string;
  qrImageDataUrl: string;
}

const EMPTY_FORM: ReceivingFormState = {
  payeeDisplayName: '',
  alipayPid: '',
  qrContent: '',
  qrImageDataUrl: '',
};

const ALIPAY_QR_PREFIX = 'https://qr.alipay.com/';
const ALIPAY_PID_RE = /^2088\d{12}$/;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

const inputClass = 'block w-full rounded-lg dark:bg-claude-darkSurface/80 bg-claude-surface/80 dark:border-claude-darkBorder/60 border-claude-border/60 border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 text-sm transition-colors';
const labelClass = 'block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary';
const hintClass = 'text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary';

/** Decode a QR image (data URL) to its content via canvas + jsQR. */
async function decodeQrFromDataUrl(dataUrl: string): Promise<string | null> {
  const image = new Image();
  const loaded = await new Promise<boolean>((resolve) => {
    image.onload = () => resolve(true);
    image.onerror = () => resolve(false);
    image.src = dataUrl;
  });
  if (!loaded) return null;
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(image, 0, 0);
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const decoded = jsQR(pixels.data, pixels.width, pixels.height);
  return decoded?.data?.trim() ?? null;
}

const PaymentReceivingSettings: React.FC = () => {
  const [loading, setLoading] = useState(true);
  const [hasIdentity, setHasIdentity] = useState(true);
  const [form, setForm] = useState<ReceivingFormState>(EMPTY_FORM);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [clearArmed, setClearArmed] = useState(false);
  const imageInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const result = await window.electron.paymentInfo.get();
      if (!result?.success) {
        if (result?.error === 'USER_IDENTITY_MISSING') {
          setHasIdentity(false);
        } else {
          setError(i18nService.t('paymentInfoLoadFailed'));
        }
        setForm(EMPTY_FORM);
        setUpdatedAt(null);
        return;
      }
      setHasIdentity(true);
      setForm({
        payeeDisplayName: result.info?.payeeDisplayName ?? '',
        alipayPid: result.info?.alipayPid ?? '',
        qrContent: result.info?.qrContent ?? '',
        qrImageDataUrl: result.info?.qrImageDataUrl ?? '',
      });
      setUpdatedAt(result.updatedAt ?? null);
    } catch {
      setError(i18nService.t('paymentInfoLoadFailed'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const patchForm = useCallback((patch: Partial<ReceivingFormState>) => {
    setForm((prev) => ({ ...prev, ...patch }));
    setError('');
    setSavedAt(null);
    setClearArmed(false);
  }, []);

  const handleImageChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!/^image\/(png|jpe?g|webp)$/.test(file.type) || file.size > MAX_IMAGE_BYTES) {
      setError(i18nService.t('paymentInfoQrImageHint'));
      return;
    }
    const dataUrl = await new Promise<string | null>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(file);
    });
    if (!dataUrl) {
      setError(i18nService.t('paymentInfoQrImageInvalid'));
      return;
    }
    const decoded = await decodeQrFromDataUrl(dataUrl);
    if (!decoded || !decoded.startsWith(ALIPAY_QR_PREFIX)) {
      // 上传即解析，不存解不开的图 (design doc 02 §2).
      setError(i18nService.t('paymentInfoQrImageInvalid'));
      return;
    }
    patchForm({ qrImageDataUrl: dataUrl, qrContent: decoded });
    setSavedAt(null);
  }, [patchForm]);

  const handleSave = useCallback(async () => {
    setError('');
    const qrContent = form.qrContent.trim();
    const alipayPid = form.alipayPid.trim();
    if (qrContent && !qrContent.startsWith(ALIPAY_QR_PREFIX)) {
      setError(i18nService.t('paymentInfoQrLinkInvalid'));
      return;
    }
    if (alipayPid && !ALIPAY_PID_RE.test(alipayPid)) {
      setError(i18nService.t('paymentInfoPidInvalid'));
      return;
    }
    if (!qrContent && !alipayPid) {
      setError(i18nService.t('paymentInfoChannelRequired'));
      return;
    }
    setSaving(true);
    try {
      const result = await window.electron.paymentInfo.save({
        info: {
          payeeDisplayName: form.payeeDisplayName.trim() || undefined,
          alipayPid: alipayPid || undefined,
          qrContent: qrContent || undefined,
          qrImageDataUrl: form.qrImageDataUrl || undefined,
        },
      });
      if (!result?.success) {
        setError(result?.error === 'USER_IDENTITY_MISSING'
          ? i18nService.t('paymentInfoNoIdentity')
          : i18nService.t('paymentInfoSaveFailed'));
        return;
      }
      setUpdatedAt(result.updatedAt ?? Date.now());
      setSavedAt(Date.now());
      setClearArmed(false);
    } catch {
      setError(i18nService.t('paymentInfoSaveFailed'));
    } finally {
      setSaving(false);
    }
  }, [form]);

  const handleClear = useCallback(async () => {
    if (!clearArmed) {
      setClearArmed(true);
      return;
    }
    setSaving(true);
    setError('');
    try {
      const result = await window.electron.paymentInfo.clear();
      if (!result?.success) {
        setError(i18nService.t('paymentInfoSaveFailed'));
        return;
      }
      setForm(EMPTY_FORM);
      setUpdatedAt(null);
      setSavedAt(null);
      setClearArmed(false);
    } catch {
      setError(i18nService.t('paymentInfoSaveFailed'));
    } finally {
      setSaving(false);
    }
  }, [clearArmed]);

  return (
    <div className="rounded-xl border dark:border-claude-darkBorder border-claude-border px-4 py-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium dark:text-claude-darkText text-claude-text">
            {i18nService.t('paymentInfoTitle')}
          </p>
          <p className="mt-1 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
            {i18nService.t('paymentInfoDescription')}
          </p>
        </div>
        <span className="shrink-0 rounded-md bg-emerald-500/10 px-2 py-0.5 text-[11px] text-emerald-600 dark:text-emerald-400">
          {i18nService.t('paymentInfoNeverOnChain')}
        </span>
      </div>

      {loading ? (
        <p className={hintClass}>{i18nService.t('loading')}</p>
      ) : !hasIdentity ? (
        <p className={hintClass}>{i18nService.t('paymentInfoNoIdentity')}</p>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className={labelClass}>{i18nService.t('paymentInfoDisplayName')}</label>
              <input
                type="text"
                value={form.payeeDisplayName}
                onChange={(e) => patchForm({ payeeDisplayName: e.target.value })}
                placeholder={i18nService.t('paymentInfoDisplayNamePlaceholder')}
                className={`${inputClass} mt-1`}
                maxLength={32}
              />
            </div>
            <div>
              <label className={labelClass}>{i18nService.t('paymentInfoPid')}</label>
              <input
                type="text"
                value={form.alipayPid}
                onChange={(e) => patchForm({ alipayPid: e.target.value })}
                placeholder="2088xxxxxxxxxxxx"
                className={`${inputClass} mt-1 font-mono`}
                maxLength={16}
              />
              <p className={`${hintClass} mt-1`}>{i18nService.t('paymentInfoPidHint')}</p>
            </div>
          </div>

          <div>
            <label className={labelClass}>{i18nService.t('paymentInfoQrLink')}</label>
            <input
              type="text"
              value={form.qrContent}
              onChange={(e) => patchForm({ qrContent: e.target.value })}
              placeholder="https://qr.alipay.com/…"
              className={`${inputClass} mt-1 font-mono text-xs`}
              maxLength={512}
            />
            <p className={`${hintClass} mt-1`}>{i18nService.t('paymentInfoQrLinkHint')}</p>
          </div>

          <div>
            <label className={labelClass}>{i18nService.t('paymentInfoQrImage')}</label>
            <div className="mt-1 flex items-center gap-3">
              {form.qrImageDataUrl ? (
                <img
                  src={form.qrImageDataUrl}
                  alt=""
                  className="h-14 w-14 rounded-lg border dark:border-claude-darkBorder border-claude-border object-cover"
                />
              ) : (
                <div className="flex h-14 w-14 items-center justify-center rounded-lg border dark:border-claude-darkBorder border-claude-border">
                  <PhotoIcon className="h-6 w-6 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
                </div>
              )}
              <input
                ref={imageInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="hidden"
                onChange={(e) => { void handleImageChange(e); }}
              />
              <button
                type="button"
                onClick={() => imageInputRef.current?.click()}
                disabled={saving}
                className="px-3 py-1.5 text-xs font-medium rounded-xl border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors disabled:opacity-50"
              >
                {i18nService.t('paymentInfoQrImagePick')}
              </button>
              <p className={hintClass}>{i18nService.t('paymentInfoQrImageHint')}</p>
            </div>
          </div>

          {error && (
            <div className="text-xs text-red-500 bg-red-500/10 px-3 py-2 rounded-lg">{error}</div>
          )}
          {(savedAt || updatedAt) && (
            <p className={hintClass}>
              {savedAt
                ? i18nService.t('paymentInfoSaved')
                : i18nService.t('paymentInfoUpdatedAt').replace(
                  '{time}',
                  new Date(updatedAt as number).toLocaleString(),
                )}
            </p>
          )}

          <div className="flex items-center justify-end gap-3 pt-1">
            <button
              type="button"
              onClick={() => { void handleClear(); }}
              disabled={saving || (!updatedAt && !form.qrContent && !form.alipayPid && !form.qrImageDataUrl)}
              className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium rounded-xl border border-red-500/40 text-red-500 hover:bg-red-500/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <TrashIcon className="h-3.5 w-3.5" />
              {clearArmed ? i18nService.t('paymentInfoClearConfirm') : i18nService.t('paymentInfoClear')}
            </button>
            <button
              type="button"
              onClick={() => { void handleSave(); }}
              disabled={saving}
              className="px-4 py-1.5 text-xs font-medium rounded-xl bg-claude-accent text-white hover:opacity-90 transition-opacity disabled:opacity-50"
            >
              {saving ? i18nService.t('paymentInfoSaving') : i18nService.t('paymentInfoSave')}
            </button>
          </div>
        </>
      )}
    </div>
  );
};

export default PaymentReceivingSettings;
