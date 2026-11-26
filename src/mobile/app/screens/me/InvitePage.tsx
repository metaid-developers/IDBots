import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { mobileI18n, t } from '../../../i18n';
import { copyTextToClipboard } from '../../../login/inAppBrowser';
import { BottomSheet } from '../../components/BottomSheet';
import {
  claimMeWeeklyRefill,
  ensureMeOverview,
  generateMeInvite,
  meFromMilli,
  refreshMeInviteStatus,
  useMeStore,
  type MobileMeInviteStatus,
} from '../../me/mePointsStore';
import { SecondaryPageShell } from './SecondaryPageShell';

export type InvitePosterTheme = 'warm' | 'dark';

export const INVITE_LANDING_ORIGIN = 'https://idbots.world';

export function buildInviteShareUrl(code: string): string {
  return `${INVITE_LANDING_ORIGIN}/?invite=${encodeURIComponent(code.trim())}`;
}

type InviteCodeEntry = MobileMeInviteStatus['codes'][number];

export function isInviteCodeUsable(code: InviteCodeEntry): boolean {
  return code.status === 1 && code.usedCount < code.maxUses;
}

export function selectPrimaryInviteCode(codes: readonly InviteCodeEntry[]): InviteCodeEntry | null {
  if (codes.length === 0) return null;
  const usable = codes.find((entry) => isInviteCodeUsable(entry));
  return usable ?? codes[0] ?? null;
}

export function countUsableInviteCodes(codes: readonly InviteCodeEntry[]): number {
  return codes.filter((entry) => isInviteCodeUsable(entry)).length;
}

export function sortInviteCodes(codes: readonly InviteCodeEntry[]): InviteCodeEntry[] {
  return [...codes].sort((a, b) => {
    const aUsable = isInviteCodeUsable(a) ? 0 : 1;
    const bUsable = isInviteCodeUsable(b) ? 0 : 1;
    if (aUsable !== bUsable) return aUsable - bUsable;
    return (b.createdAt || 0) - (a.createdAt || 0);
  });
}

function resolveCodeBadgeKey(code: InviteCodeEntry): string {
  if (code.status !== 1) return 'mobile.me.invite.badgeDisabled';
  if (code.usedCount < code.maxUses) {
    return code.maxUses === 1 ? 'mobile.me.invite.badgeSingleAvailable' : 'mobile.me.invite.badgeAvailable';
  }
  if (code.activatedCount > 0) return 'mobile.me.invite.badgeActivated';
  return 'mobile.me.invite.badgeUsed';
}

function resolveGrantPlanLabel(defaultGrant: MobileMeInviteStatus['defaultGrant'] | undefined): string {
  if (!defaultGrant) return 'ID.Student';
  const lang = mobileI18n.getLanguage();
  if (lang === 'en') {
    return defaultGrant.planNameEn || defaultGrant.planName || 'ID.Student';
  }
  return defaultGrant.planName || defaultGrant.planNameEn || 'ID.Student';
}

function formatNum(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value);
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
  fill: boolean,
  stroke: boolean,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
  if (fill) ctx.fill();
  if (stroke) ctx.stroke();
}

function loadImageElement(src: string): Promise<HTMLImageElement | null> {
  if (typeof Image === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

async function renderInvitePosterCanvas(
  canvas: HTMLCanvasElement,
  options: {
    theme: InvitePosterTheme;
    code: string;
    days: number;
    plan: string;
    inviteUrl: string;
  },
): Promise<void> {
  const dpr = 2;
  const w = 256;
  const h = 368;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.save();
  ctx.scale(dpr, dpr);

  const isWarm = options.theme === 'warm';
  const qrDataUrl = await QRCode.toDataURL(options.inviteUrl, {
    margin: 1,
    width: 160,
    color: isWarm
      ? { dark: '#171817', light: '#FFFDF8' }
      : { dark: '#111112', light: '#F4F3EF' },
  }).catch(() => null);

  const [qrImg, logoImg] = await Promise.all([
    qrDataUrl ? loadImageElement(qrDataUrl) : Promise.resolve(null),
    loadImageElement('/icon-192.png'),
  ]);

  if (isWarm) {
    ctx.fillStyle = '#F4F0E8';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = '#D8D2C7';
    ctx.lineWidth = 1;
    ctx.strokeRect(10, 10, w - 20, h - 20);

    ctx.fillStyle = '#9B581E';
    ctx.font = '600 9.5px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillText(t('mobile.me.invite.posterWarmKicker'), 24, 34);

    ctx.fillStyle = '#171817';
    ctx.font = '700 18px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.fillText(t('mobile.me.invite.posterWarmLine1'), 24, 66);
    ctx.fillText(t('mobile.me.invite.posterWarmLine2'), 24, 92);

    ctx.fillStyle = '#FFFDF8';
    roundRect(ctx, 24, 114, w - 48, 78, 12, true, false);
    ctx.strokeStyle = '#DFD8CA';
    roundRect(ctx, 24, 114, w - 48, 78, 12, false, true);

    ctx.fillStyle = '#74746D';
    ctx.font = '500 10px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.fillText(t('mobile.me.invite.posterWarmPerk', { days: options.days, plan: options.plan }), 36, 136);

    ctx.fillStyle = '#171817';
    ctx.font = '700 20px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillText(options.code, 36, 170);

    if (qrImg) {
      ctx.fillStyle = '#FFFDF8';
      roundRect(ctx, 24, 268, 72, 72, 8, true, false);
      ctx.drawImage(qrImg, 26, 270, 68, 68);
    }
    ctx.fillStyle = '#171817';
    ctx.font = '600 12px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.fillText(t('mobile.me.invite.posterWarmScan'), 106, 300);
    ctx.fillStyle = '#74746D';
    ctx.font = '500 11px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillText(t('mobile.me.invite.posterDomain'), 106, 320);
  } else {
    const grad = ctx.createLinearGradient(0, 0, w, h);
    grad.addColorStop(0, '#1C1D22');
    grad.addColorStop(1, '#101114');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);

    ctx.strokeStyle = 'rgba(255, 220, 81, 0.32)';
    ctx.lineWidth = 1;
    roundRect(ctx, 12, 12, w - 24, h - 24, 14, false, true);

    ctx.fillStyle = '#FFDC51';
    ctx.font = '700 10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillText(t('mobile.me.invite.posterDarkKicker'), 24, 38);

    ctx.fillStyle = '#F4F3EF';
    ctx.font = '700 17px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.fillText(t('mobile.me.invite.posterDarkLine1'), 24, 68);

    ctx.fillStyle = 'rgba(255, 220, 81, 0.08)';
    roundRect(ctx, 24, 96, w - 48, 96, 12, true, false);
    ctx.strokeStyle = 'rgba(255, 220, 81, 0.35)';
    roundRect(ctx, 24, 96, w - 48, 96, 12, false, true);

    ctx.fillStyle = '#FFDC51';
    ctx.font = '700 21px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillText(options.code, 36, 138);

    ctx.fillStyle = '#AAA9A4';
    ctx.font = '500 10.5px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.fillText(t('mobile.me.invite.posterDarkPerk', { days: options.days, plan: options.plan }), 36, 168);

    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.16)';
    ctx.beginPath();
    ctx.moveTo(24, 236);
    ctx.lineTo(w - 24, 236);
    ctx.stroke();
    ctx.setLineDash([]);

    if (qrImg) {
      ctx.fillStyle = '#F4F3EF';
      roundRect(ctx, 24, 264, 72, 72, 8, true, false);
      ctx.drawImage(qrImg, 26, 266, 68, 68);
    }
    ctx.fillStyle = '#F4F3EF';
    ctx.font = '600 12px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.fillText(t('mobile.me.invite.posterDarkScan'), 108, 296);
    ctx.fillStyle = '#FFDC51';
    ctx.font = '500 11px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillText(t('mobile.me.invite.posterDomain'), 108, 318);
  }

  if (logoImg) {
    ctx.save();
    roundRect(ctx, w - 60, 22, 36, 36, 9, false, false);
    ctx.clip();
    ctx.drawImage(logoImg, w - 60, 22, 36, 36);
    ctx.restore();
  }

  ctx.restore();
}

export function InvitePage(props: {
  onBack: () => void;
  onOpenSubscribe: () => void;
}): JSX.Element {
  const me = useMeStore();
  const status = me.inviteStatus;
  const [generating, setGenerating] = useState(false);
  const [claimingRefill, setClaimingRefill] = useState(false);
  const [refillSheetOpen, setRefillSheetOpen] = useState(false);
  const [posterOpen, setPosterOpen] = useState(false);
  const [posterTheme, setPosterTheme] = useState<InvitePosterTheme>('warm');
  const [selectedCodeValue, setSelectedCodeValue] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const feedbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const showFeedback = useCallback((kind: 'ok' | 'err', text: string) => {
    setFeedback({ kind, text });
    if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
    feedbackTimer.current = setTimeout(() => setFeedback(null), 2600);
  }, []);

  useEffect(() => {
    ensureMeOverview();
    void refreshMeInviteStatus();
    return () => {
      if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
    };
  }, []);

  const orderedCodes = useMemo(
    () => (status ? sortInviteCodes(status.codes) : []),
    [status],
  );
  const primaryCode = useMemo(
    () => (status ? selectPrimaryInviteCode(orderedCodes) : null),
    [status, orderedCodes],
  );
  const activeCode = useMemo(() => {
    if (!status) return null;
    if (selectedCodeValue) {
      const matched = status.codes.find((entry) => entry.code === selectedCodeValue);
      if (matched) return matched;
    }
    return primaryCode;
  }, [status, selectedCodeValue, primaryCode]);
  const usableCount = useMemo(
    () => (status ? countUsableInviteCodes(status.codes) : 0),
    [status],
  );
  const allInvitees = useMemo(() => {
    if (!status) return [];
    return status.codes
      .flatMap((entry) => entry.invitees.map((inv) => ({ ...inv, code: entry.code })))
      .sort((a, b) => (b.reservedAt || 0) - (a.reservedAt || 0));
  }, [status]);

  const grantDays = status?.defaultGrant?.periodDays && status.defaultGrant.periodDays > 0
    ? status.defaultGrant.periodDays
    : 14;
  const grantPlan = resolveGrantPlanLabel(status?.defaultGrant);
  const shareUrl = activeCode ? buildInviteShareUrl(activeCode.code) : '';

  useEffect(() => {
    if (!posterOpen || !activeCode || !canvasRef.current) return;
    void renderInvitePosterCanvas(canvasRef.current, {
      theme: posterTheme,
      code: activeCode.code,
      days: grantDays,
      plan: grantPlan,
      inviteUrl: shareUrl,
    });
  }, [posterOpen, posterTheme, activeCode, grantDays, grantPlan, shareUrl]);

  const handleCopy = async (value: string, successKey: string) => {
    const ok = await copyTextToClipboard(value);
    showFeedback(ok ? 'ok' : 'err', t(ok ? successKey : 'mobile.me.invite.copyFailed'));
  };

  const handleGenerate = async () => {
    if (generating) return;
    const prevCodes = new Set((status?.codes ?? []).map((entry) => entry.code));
    setGenerating(true);
    const res = await generateMeInvite();
    setGenerating(false);
    if (res.success) {
      const created = res.inviteStatus.codes.find((entry) => !prevCodes.has(entry.code))
        ?? selectPrimaryInviteCode(sortInviteCodes(res.inviteStatus.codes));
      if (created) setSelectedCodeValue(created.code);
    } else {
      const errMsg = 'error' in res && res.error ? res.error : t('mobile.common.error');
      showFeedback('err', errMsg);
    }
  };

  const weeklyGrant = me.balance?.weeklyGrant ?? status?.refill?.weeklyGrant;
  const noWeeklyGrant = !weeklyGrant || weeklyGrant.amountMilli <= 0;
  const weeklyAlreadyFull = Boolean(
    weeklyGrant && weeklyGrant.amountMilli > 0 && weeklyGrant.remainingMilli >= weeklyGrant.amountMilli,
  );

  const handleConfirmRefill = async () => {
    if (claimingRefill || noWeeklyGrant || weeklyAlreadyFull) return;
    setClaimingRefill(true);
    const res = await claimMeWeeklyRefill();
    setClaimingRefill(false);
    if (res.success) {
      setRefillSheetOpen(false);
      showFeedback(
        'ok',
        t('mobile.me.invite.refillSuccess', { me: formatNum(meFromMilli(res.refill.afterRemainingMilli)) }),
      );
    } else {
      const errMsg = 'error' in res && res.error ? res.error : t('mobile.common.error');
      showFeedback('err', errMsg);
    }
  };

  const handleSaveAndSharePoster = async () => {
    const canvas = canvasRef.current;
    if (!canvas || !activeCode) return;
    const filename = `idbots-invite-${activeCode.code}.png`;
    try {
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (blob && typeof File !== 'undefined' && typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
        const file = new File([blob], filename, { type: 'image/png' });
        const canShareFiles = typeof navigator.canShare === 'function' ? navigator.canShare({ files: [file] }) : false;
        if (canShareFiles) {
          await navigator.share({ files: [file], title: 'IDBots', text: shareUrl });
          return;
        }
      }
      const dataUrl = canvas.toDataURL('image/png');
      const link = document.createElement('a');
      link.href = dataUrl;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      showFeedback('ok', t('mobile.me.invite.posterSaved'));
    } catch {
      // Share dismissal or restricted webview download: copy link as safe fallback.
      await handleCopy(shareUrl, 'mobile.me.invite.linkCopied');
    }
  };

  const renderRefillCard = (info: MobileMeInviteStatus) => {
    const availableCount = info.refill.availableCount;
    const ready = availableCount > 0;
    return (
      <section
        data-testid="invite-refill-card"
        className={`twin-panel twin-panel-padded flex items-center justify-between gap-3 ${
          ready ? 'border-[rgba(255,220,81,0.5)]' : 'opacity-85'
        }`}
      >
        <div className="min-w-0 flex-1">
          <p className="twin-list-title">
            {ready
              ? t('mobile.me.invite.refillTitleReady', { count: availableCount })
              : t('mobile.me.invite.refillTitle')}
          </p>
          <p className="mt-0.5 text-xs text-[var(--text-secondary)]">
            {t(ready ? 'mobile.me.invite.refillSubReady' : 'mobile.me.invite.refillSubLocked')}
          </p>
        </div>
        {ready ? (
          <button
            type="button"
            data-testid="invite-claim-refill-open"
            onClick={() => setRefillSheetOpen(true)}
            className="twin-button twin-button-primary twin-button-small shrink-0 rounded-full px-3.5"
          >
            {t('mobile.me.invite.refillAction')}
          </button>
        ) : (
          <span className="shrink-0 text-xs text-[var(--text-secondary)]" data-testid="invite-refill-pending">
            {t('mobile.me.invite.refillPendingTag')}
          </span>
        )}
      </section>
    );
  };

  return (
    <SecondaryPageShell title={t('mobile.me.invite.title')} onBack={props.onBack} testId="me-page-invite">
      {feedback ? (
        <div
          role="status"
          data-testid="invite-feedback"
          className={`twin-notice ${feedback.kind === 'err' ? 'twin-notice-error' : ''}`}
        >
          {feedback.text}
        </div>
      ) : null}

      {me.inviteLoading && !status ? (
        <p className="py-8 text-center text-sm text-[var(--text-secondary)]">{t('mobile.common.loading')}</p>
      ) : null}

      {!me.inviteLoading && !status ? (
        <div className="twin-panel twin-panel-padded space-y-3" data-testid="invite-unavailable">
          <p className="text-sm text-[var(--text-secondary)]">
            {me.inviteError || t('mobile.me.invite.unavailable')}
          </p>
          <button
            type="button"
            onClick={() => void refreshMeInviteStatus()}
            className="twin-button twin-button-secondary twin-button-full"
          >
            {t('mobile.common.retry')}
          </button>
        </div>
      ) : null}

      {status && status.eligible ? (
        <>
          <section className="twin-panel twin-panel-padded space-y-3.5" data-testid="invite-code-card">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold text-[var(--text-secondary)]">
                {t('mobile.me.invite.codeCardTitle')}
              </span>
              {activeCode ? (
                <span
                  data-testid="invite-code-badge"
                  className="rounded-full bg-[var(--bg-hover)] px-2.5 py-0.5 text-[11px] font-semibold text-[var(--text-primary)]"
                >
                  {t(resolveCodeBadgeKey(activeCode))}
                </span>
              ) : null}
            </div>

            {status.totalQuota > 0 || usableCount > 0 || status.remainingQuota > 0 ? (
              <p
                data-testid="invite-quota-summary"
                className="rounded-lg bg-[var(--bg-hover)] px-3 py-1.5 text-xs font-medium text-[var(--text-secondary)]"
              >
                {t('mobile.me.invite.quotaSummary', {
                  total: status.totalQuota,
                  usable: usableCount,
                  remaining: Math.max(0, status.remainingQuota),
                })}
              </p>
            ) : null}

            {activeCode ? (
              <>
                <div className="flex items-center justify-between gap-3 rounded-xl border border-[var(--border-color)] bg-[var(--bg-hover)] px-3.5 py-3">
                  <span
                    data-testid="invite-code-value"
                    className="select-all font-mono text-xl font-bold tracking-wider text-[var(--text-primary)]"
                  >
                    {activeCode.code}
                  </span>
                  <button
                    type="button"
                    data-testid="invite-copy-code"
                    onClick={() => void handleCopy(activeCode.code, 'mobile.me.invite.codeCopied')}
                    className="twin-button twin-button-secondary twin-button-small shrink-0"
                  >
                    {t('mobile.me.invite.copyCode')}
                  </button>
                </div>

                <p className="text-xs text-[var(--text-secondary)]" data-testid="invite-perk-note">
                  {t('mobile.me.invite.perkNote', { days: grantDays, plan: grantPlan })}
                </p>

                <div className="grid grid-cols-2 gap-2.5">
                  <button
                    type="button"
                    data-testid="invite-copy-link"
                    onClick={() => void handleCopy(shareUrl, 'mobile.me.invite.linkCopied')}
                    className="twin-button twin-button-secondary"
                  >
                    {t('mobile.me.invite.copyLink')}
                  </button>
                  <button
                    type="button"
                    data-testid="invite-open-poster"
                    onClick={() => setPosterOpen(true)}
                    className="twin-button twin-button-primary"
                  >
                    {t('mobile.me.invite.openPoster')}
                  </button>
                </div>

                {status.remainingQuota > 0 && status.issueEnabled ? (
                  <button
                    type="button"
                    data-testid="invite-generate-next-btn"
                    disabled={generating}
                    onClick={() => void handleGenerate()}
                    className="twin-button twin-button-secondary twin-button-full"
                  >
                    {generating
                      ? t('mobile.me.invite.generating')
                      : t('mobile.me.invite.generateNextCode', { count: status.remainingQuota })}
                  </button>
                ) : usableCount === 0 && status.issueEnabled ? (
                  <p data-testid="invite-quota-exhausted" className="text-center text-xs text-[var(--text-secondary)]">
                    {t('mobile.me.invite.quotaExhausted')}
                  </p>
                ) : null}
              </>
            ) : (
              <>
                <p className="text-xs text-[var(--text-secondary)]" data-testid="invite-perk-note">
                  {t('mobile.me.invite.perkNote', { days: grantDays, plan: grantPlan })}
                </p>
                {status.remainingQuota > 0 && status.issueEnabled ? (
                  <button
                    type="button"
                    data-testid="invite-generate-btn"
                    disabled={generating}
                    onClick={() => void handleGenerate()}
                    className="twin-button twin-button-primary twin-button-full"
                  >
                    {t(generating ? 'mobile.me.invite.generating' : 'mobile.me.invite.generateCode')}
                  </button>
                ) : null}
              </>
            )}
          </section>

          {orderedCodes.length > 1 ? (
            <section className="twin-panel twin-panel-padded space-y-2.5" data-testid="invite-code-list">
              <h3 className="text-xs font-semibold text-[var(--text-secondary)]">
                {t('mobile.me.invite.codesListTitle', { count: orderedCodes.length })}
              </h3>
              <div className="divide-y divide-[var(--border-color)]">
                {orderedCodes.map((entry) => {
                  const usable = isInviteCodeUsable(entry);
                  const selected = activeCode?.code === entry.code;
                  const entryShareUrl = buildInviteShareUrl(entry.code);
                  return (
                    <div
                      key={entry.code}
                      data-testid={`invite-code-item-${entry.code}`}
                      className="flex items-center justify-between gap-2 py-2.5"
                    >
                      <button
                        type="button"
                        onClick={() => setSelectedCodeValue(entry.code)}
                        className="min-w-0 flex-1 text-left"
                      >
                        <div className="flex items-center gap-1.5">
                          <span
                            className={`font-mono text-sm font-semibold ${
                              usable ? 'text-[var(--text-primary)]' : 'text-[var(--text-secondary)] line-through'
                            }`}
                          >
                            {entry.code}
                          </span>
                          {selected ? (
                            <span className="rounded-full bg-[rgba(255,220,81,0.22)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--text-primary)]">
                              {t('mobile.me.invite.codeCurrentTag')}
                            </span>
                          ) : null}
                        </div>
                        <p className="mt-0.5 text-[11px] text-[var(--text-secondary)]">
                          {t(resolveCodeBadgeKey(entry))}
                        </p>
                      </button>
                      <div className="flex shrink-0 items-center gap-1.5">
                        <button
                          type="button"
                          data-testid={`invite-list-copy-${entry.code}`}
                          onClick={() => void handleCopy(entry.code, 'mobile.me.invite.codeCopied')}
                          className="twin-button twin-button-secondary twin-button-small px-2.5 text-xs"
                        >
                          {t('mobile.me.invite.copyCode')}
                        </button>
                        <button
                          type="button"
                          data-testid={`invite-list-link-${entry.code}`}
                          onClick={() => void handleCopy(entryShareUrl, 'mobile.me.invite.linkCopied')}
                          className="twin-button twin-button-secondary twin-button-small px-2.5 text-xs"
                        >
                          {t('mobile.me.invite.copyLink')}
                        </button>
                        <button
                          type="button"
                          data-testid={`invite-list-poster-${entry.code}`}
                          onClick={() => {
                            setSelectedCodeValue(entry.code);
                            setPosterOpen(true);
                          }}
                          className="twin-button twin-button-primary twin-button-small px-2.5 text-xs"
                        >
                          {t('mobile.me.invite.codePosterShort')}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          ) : null}

          {renderRefillCard(status)}
        </>
      ) : null}

      {status && !status.eligible ? (
        <>
          <section className="twin-panel twin-panel-padded space-y-3.5" data-testid="invite-locked-card">
            <div className="flex items-center justify-between gap-2">
              <h2 className="twin-list-title">{t('mobile.me.invite.lockedTitle')}</h2>
              <span className="rounded-full bg-[rgba(255,220,81,0.18)] px-2.5 py-0.5 text-[11px] font-semibold text-[var(--text-primary)]">
                {t('mobile.me.invite.lockedTag')}
              </span>
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <span className="text-[var(--text-secondary)]">{t('mobile.me.invite.progressAgeLabel')}</span>
                <strong className="font-semibold text-[var(--text-primary)]" data-testid="invite-progress-age">
                  {t('mobile.me.invite.progressAgeValue', {
                    current: status.progress.accountAgeDays,
                    target: status.progress.requiredAgeDays,
                  })}
                </strong>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-[var(--bg-hover)]">
                <div
                  className="h-full rounded-full bg-[var(--color-primary)] transition-all"
                  style={{
                    width: `${Math.min(
                      100,
                      Math.round(
                        (status.progress.accountAgeDays / Math.max(1, status.progress.requiredAgeDays)) * 100,
                      ),
                    )}%`,
                  }}
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <span className="text-[var(--text-secondary)]">{t('mobile.me.invite.progressSpentLabel')}</span>
                <strong className="font-semibold text-[var(--text-primary)]" data-testid="invite-progress-spent">
                  {t('mobile.me.invite.progressSpentValue', {
                    current: formatNum(meFromMilli(status.progress.totalSpentMilli)),
                    target: formatNum(meFromMilli(status.progress.requiredSpentMilli)),
                  })}
                </strong>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-[var(--bg-hover)]">
                <div
                  className="h-full rounded-full bg-[var(--color-primary)] transition-all"
                  style={{
                    width: `${Math.min(
                      100,
                      Math.round(
                        (status.progress.totalSpentMilli / Math.max(1, status.progress.requiredSpentMilli)) * 100,
                      ),
                    )}%`,
                  }}
                />
              </div>
            </div>

            <p className="text-xs text-[var(--text-secondary)]" data-testid="invite-locked-hint">
              {t(
                status.progress.isTrialSubscription
                  ? 'mobile.me.invite.lockedTrialHint'
                  : 'mobile.me.invite.lockedHint',
              )}
            </p>

            {status.progress.paidBypassEnabled ? (
              <button
                type="button"
                data-testid="invite-locked-subscribe"
                onClick={props.onOpenSubscribe}
                className="twin-button twin-button-primary twin-button-full"
              >
                {t('mobile.me.invite.lockedSubscribeCta')}
              </button>
            ) : null}
          </section>

          {status.refill.availableCount > 0 ? renderRefillCard(status) : null}
        </>
      ) : null}

      {allInvitees.length > 0 ? (
        <section className="twin-panel twin-panel-padded space-y-2.5" data-testid="invite-history-card">
          <h3 className="text-xs font-semibold text-[var(--text-secondary)]">
            {t('mobile.me.invite.historyTitle')}
          </h3>
          <div className="divide-y divide-[var(--border-color)]">
            {allInvitees.map((inv, idx) => {
              const activated = inv.status >= 2 || Boolean(inv.activatedAt);
              return (
                <div key={`${inv.code}-${inv.reservedAt}-${idx}`} className="flex items-center justify-between gap-2 py-2 text-xs">
                  <span className="font-mono text-[var(--text-primary)]">
                    {inv.phoneMasked || t('mobile.me.invite.inviteeFallback')}
                  </span>
                  <span className={activated ? 'font-medium text-emerald-600' : 'text-[var(--text-secondary)]'}>
                    {t(activated ? 'mobile.me.invite.inviteeActivated' : 'mobile.me.invite.inviteeRegistered')}
                  </span>
                </div>
              );
            })}
          </div>
        </section>
      ) : null}

      {refillSheetOpen ? (
        <BottomSheet title={t('mobile.me.invite.refillSheetTitle')} onClose={() => setRefillSheetOpen(false)}>
          <div className="space-y-3.5" data-testid="invite-refill-sheet">
            <div className="rounded-xl border border-[var(--border-color)] bg-[var(--bg-hover)] p-3.5 space-y-2">
              <div className="flex items-center justify-between text-xs text-[var(--text-secondary)]">
                <span>{t('mobile.me.invite.refillCurrentLabel')}</span>
                <span className="font-mono font-semibold text-[var(--text-primary)]">
                  {weeklyGrant ? `${formatNum(meFromMilli(weeklyGrant.remainingMilli))} ME` : '0 ME'}
                </span>
              </div>
              <div className="flex items-center justify-between text-sm font-bold text-[var(--text-primary)]">
                <span>{t('mobile.me.invite.refillAfterLabel')}</span>
                <span className="font-mono text-emerald-600">
                  {weeklyGrant ? `${formatNum(meFromMilli(weeklyGrant.amountMilli))} ME` : '0 ME'}
                </span>
              </div>
            </div>

            {noWeeklyGrant ? (
              <p className="text-xs text-amber-600" data-testid="invite-refill-warning">
                {t('mobile.me.invite.refillNoGrant')}
              </p>
            ) : weeklyAlreadyFull ? (
              <p className="text-xs text-amber-600" data-testid="invite-refill-warning">
                {t('mobile.me.invite.refillAlreadyFull')}
              </p>
            ) : null}

            <div className="grid grid-cols-2 gap-2.5">
              <button
                type="button"
                onClick={() => setRefillSheetOpen(false)}
                className="twin-button twin-button-secondary"
              >
                {t('mobile.me.invite.refillLater')}
              </button>
              <button
                type="button"
                data-testid="invite-claim-refill-confirm"
                disabled={claimingRefill || noWeeklyGrant || weeklyAlreadyFull}
                onClick={() => void handleConfirmRefill()}
                className="twin-button twin-button-primary"
              >
                {t(claimingRefill ? 'mobile.me.invite.refillClaiming' : 'mobile.me.invite.refillConfirm')}
              </button>
            </div>
          </div>
        </BottomSheet>
      ) : null}

      {posterOpen && activeCode ? (
        <BottomSheet title={t('mobile.me.invite.posterSheetTitle')} onClose={() => setPosterOpen(false)}>
          <div className="space-y-3.5" data-testid="invite-poster-sheet">
            <div className="twin-segmented">
              <button
                type="button"
                data-testid="invite-poster-theme-warm"
                aria-pressed={posterTheme === 'warm'}
                onClick={() => setPosterTheme('warm')}
                className="twin-segment"
              >
                {t('mobile.me.invite.posterThemeWarm')}
              </button>
              <button
                type="button"
                data-testid="invite-poster-theme-dark"
                aria-pressed={posterTheme === 'dark'}
                onClick={() => setPosterTheme('dark')}
                className="twin-segment"
              >
                {t('mobile.me.invite.posterThemeDark')}
              </button>
            </div>

            <div className="flex justify-center py-1">
              <canvas
                ref={canvasRef}
                data-testid="invite-poster-canvas"
                className="h-[368px] w-[256px] rounded-[18px] shadow-xl"
              />
            </div>

            <div className="grid grid-cols-2 gap-2.5">
              <button
                type="button"
                data-testid="invite-poster-copy-link"
                onClick={() => void handleCopy(shareUrl, 'mobile.me.invite.linkCopied')}
                className="twin-button twin-button-secondary"
              >
                {t('mobile.me.invite.posterCopyLink')}
              </button>
              <button
                type="button"
                data-testid="invite-poster-save-share"
                onClick={() => void handleSaveAndSharePoster()}
                className="twin-button twin-button-primary"
              >
                {t('mobile.me.invite.posterSaveShare')}
              </button>
            </div>
          </div>
        </BottomSheet>
      ) : null}
    </SecondaryPageShell>
  );
}
