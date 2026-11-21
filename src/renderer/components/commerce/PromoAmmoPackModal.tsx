/**
 * PromoAmmoPackModal — the seller-side promo ammo pack (REQ-E-04). Renders a
 * canvas seed card (owner name, slogan, up to 3 featured items, QR pointing
 * at the invite-attribution landing link), PNG download / clipboard copy, and
 * the three compliant promo templates with one-click copy.
 *
 * Compliance red line: neither the poster nor any template here may promise
 * financial returns — the banned word list lives in
 * tests/commerceBannedWords.test.mjs, which scans this file. The angle is:
 * free 1:1 legacy upgrade, my AI runs the shop 24h, on-chain provenance. The
 * QR is hand-drawn with the zero-dependency qrEncoder; the poster never loads
 * remote images (the export canvas must stay untainted and work offline) —
 * item covers are drawn as deterministic gradient tiles with the item's
 * initials.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  buildFeaturedLine,
  buildPromoTemplates,
  tCommerce,
  type CommerceLang,
  type CommerceI18nKey,
} from './commercePromoI18n';
import { encodeQrMatrix } from './qrEncoder';
import type { OpenPromoPackParams } from './commerceBridgeContract';

export const INVITE_LANDING_BASE = 'https://idbots.ai/invite';

export interface PromoAmmoPackModalProps {
  params: OpenPromoPackParams;
  lang: CommerceLang;
  onClose(): void;
}

export const buildInviteAttributionUrl = (params: OpenPromoPackParams): string => {
  if (params.shopMetaAppPinId) {
    return `${INVITE_LANDING_BASE}?inviter=${encodeURIComponent(params.shopOwnerGlobalMetaId)}&shop=${encodeURIComponent(params.shopMetaAppPinId)}`;
  }
  return `metaid://${params.shopOwnerGlobalMetaId}`;
};

export const buildShopUri = (params: OpenPromoPackParams): string =>
  (params.shopMetaAppPinId ? `metaapp://${params.shopMetaAppPinId}` : `metaid://${params.shopOwnerGlobalMetaId}`);

const POSTER_W = 560;
const POSTER_H = 760;

/** Deterministic pastel gradient per item index (no remote images: export stays untainted + offline). */
const ITEM_TILE_COLORS: [string, string][] = [
  ['#4c6ef5', '#15aabf'],
  ['#9c36b5', '#e64980'],
  ['#f59f00', '#fd7e14'],
];

function drawRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawPosterCanvas(
  canvas: HTMLCanvasElement,
  params: OpenPromoPackParams,
  shopUri: string,
  texts: { title: string; caption: string; emptyHint: string },
): void {
  canvas.width = POSTER_W;
  canvas.height = POSTER_H;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  // Backdrop
  const bg = ctx.createLinearGradient(0, 0, POSTER_W, POSTER_H);
  bg.addColorStop(0, '#101226');
  bg.addColorStop(1, '#1d2145');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, POSTER_W, POSTER_H);

  // Header: owner name + slogan
  ctx.fillStyle = '#f8f9fa';
  ctx.font = 'bold 30px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
  ctx.fillText(params.shopOwnerName || params.shopOwnerGlobalMetaId.slice(0, 18), 36, 76);
  ctx.fillStyle = '#adb5bd';
  ctx.font = '17px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
  const slogan = params.shopSlogan || shopUri;
  ctx.fillText(slogan.length > 28 ? `${slogan.slice(0, 28)}…` : slogan, 36, 106);

  // Featured item tiles (up to 3)
  const items = params.featuredItems.slice(0, 3);
  if (!items.length) {
    ctx.fillStyle = '#868e96';
    ctx.font = '15px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.fillText(texts.emptyHint, 36, 170);
  }
  items.forEach((item, index) => {
    const tileY = 140 + index * 128;
    const [c1, c2] = ITEM_TILE_COLORS[index % ITEM_TILE_COLORS.length];
    const tile = ctx.createLinearGradient(36, tileY, 236, tileY + 108);
    tile.addColorStop(0, c1);
    tile.addColorStop(1, c2);
    ctx.fillStyle = tile;
    drawRoundedRect(ctx, 36, tileY, 200, 108, 14);
    ctx.fill();
    const initial = (item.itemName || item.itemPinId.slice(0, 2)).trim().slice(0, 2);
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.font = 'bold 34px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(initial || '◆', 136, tileY + 66);
    ctx.textAlign = 'left';

    ctx.fillStyle = '#f1f3f5';
    ctx.font = 'bold 18px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
    const name = item.itemName || `#${item.itemPinId.slice(0, 8)}…`;
    ctx.fillText(name.length > 22 ? `${name.slice(0, 22)}…` : name, 256, tileY + 34);
    ctx.fillStyle = '#ffd43b';
    ctx.font = 'bold 17px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
    let priceText = '';
    if (typeof item.priceMeMilli === 'number' && item.priceMeMilli >= 0) {
      priceText = `⚡ ${item.priceMeMilli % 1000 === 0 ? item.priceMeMilli / 1000 : (item.priceMeMilli / 1000).toFixed(2)} ME`;
    }
    if (typeof item.priceCnyCents === 'number' && item.priceCnyCents >= 0) {
      priceText += `${priceText ? '  ·  ' : ''}¥${(item.priceCnyCents / 100).toFixed(2)}`;
    }
    if (priceText) ctx.fillText(priceText, 256, tileY + 62);
    ctx.fillStyle = '#868e96';
    ctx.font = '12px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.fillText(item.itemPinId.slice(0, 18) + '…', 256, tileY + 86);
  });

  // QR + caption
  const qrSize = 150;
  const qrX = 36;
  const qrY = POSTER_H - qrSize - 66;
  ctx.fillStyle = '#f8f9fa';
  drawRoundedRect(ctx, qrX - 10, qrY - 10, qrSize + 20, qrSize + 20, 12);
  ctx.fill();
  try {
    const qr = encodeQrMatrix(buildInviteAttributionUrl(params), { ecLevel: 'M' });
    const scale = Math.floor(qrSize / qr.size);
    const offset = Math.floor((qrSize - scale * qr.size) / 2);
    ctx.fillStyle = '#101226';
    for (let y = 0; y < qr.size; y += 1) {
      for (let x = 0; x < qr.size; x += 1) {
        if (qr.modules[y][x]) {
          ctx.fillRect(qrX + offset + x * scale, qrY + offset + y * scale, scale, scale);
        }
      }
    }
  } catch {
    // URL overflow should not break the poster: leave the white plate.
  }
  ctx.fillStyle = '#adb5bd';
  ctx.font = '13px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
  ctx.fillText(texts.caption, qrX, qrY + qrSize + 26);

  // Footer: shop URI strip
  ctx.fillStyle = 'rgba(255,255,255,0.06)';
  ctx.fillRect(0, POSTER_H - 34, POSTER_W, 34);
  ctx.fillStyle = '#868e96';
  ctx.font = '12px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
  ctx.fillText(shopUri.length > 56 ? `${shopUri.slice(0, 56)}…` : shopUri, 36, POSTER_H - 13);
}

export const PromoAmmoPackModal: React.FC<PromoAmmoPackModalProps> = ({ params, lang, onClose }) => {
  const t = (key: CommerceI18nKey) => tCommerce(key, lang);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [status, setStatus] = useState('');

  const shopUri = useMemo(() => buildShopUri(params), [params]);
  const templates = useMemo(
    () => buildPromoTemplates({
      ownerName: params.shopOwnerName,
      ownerGlobalMetaId: params.shopOwnerGlobalMetaId,
      shopUri,
      featuredLine: buildFeaturedLine(params.featuredItems, lang),
    }, lang),
    [params, shopUri, lang],
  );

  useEffect(() => {
    if (canvasRef.current) {
      drawPosterCanvas(canvasRef.current, params, shopUri, {
        title: t('commercePromoPoster'),
        caption: t('commercePromoQrCaption'),
        emptyHint: t('commercePromoNoItems'),
      });
    }
  }, [params, shopUri, t]);

  const downloadPng = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    try {
      const dataUrl = canvas.toDataURL('image/png');
      const link = document.createElement('a');
      link.href = dataUrl;
      link.download = `promo-${params.shopOwnerGlobalMetaId.slice(0, 12)}.png`;
      link.click();
      setStatus('');
    } catch {
      setStatus(t('commercePromoPosterFailed'));
    }
  }, [params.shopOwnerGlobalMetaId, t]);

  const copyImage = useCallback(async () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    try {
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!blob || typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) {
        throw new Error('clipboard unavailable');
      }
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      setStatus(t('commercePromoCopied'));
    } catch {
      setStatus(t('commercePromoClipboardFailed'));
    }
  }, [t]);

  const copyText = useCallback(async (text: string, key: CommerceI18nKey) => {
    try {
      await navigator.clipboard.writeText(text);
      setStatus(`${t(key)} · ${t('commercePromoCopied')}`);
    } catch {
      setStatus(t('commercePromoClipboardFailed'));
    }
  }, [t]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-auto bg-black/40 p-4" role="dialog" aria-modal="true" aria-label={t('commercePromoTitle')}>
      <div className="my-4 w-full max-w-[680px] rounded-xl border p-5 shadow-lg dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface" data-promo-ammo-pack-modal>
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm font-semibold dark:text-claude-darkText text-claude-text">{t('commercePromoTitle')}</div>
            <div className="mt-0.5 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">{t('commercePromoIntro')}</div>
          </div>
          <button
            type="button"
            className="inline-flex shrink-0 items-center justify-center rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover"
            onClick={onClose}
          >
            {t('commercePromoClose')}
          </button>
        </div>

        <div className="mt-4 flex flex-col items-center gap-2 rounded-xl border p-3 dark:border-claude-darkBorder border-claude-border">
          <canvas ref={canvasRef} className="max-h-[420px] w-auto max-w-full rounded-lg" data-promo-poster-canvas />
          <div className="flex gap-2">
            <button
              type="button"
              className="inline-flex items-center justify-center rounded-lg bg-claude-accent px-3 py-1.5 text-xs font-medium text-claude-accentInk transition-colors hover:bg-claude-accentHover"
              onClick={downloadPng}
              data-promo-download-button
            >
              {t('commercePromoDownload')}
            </button>
            <button
              type="button"
              className="inline-flex items-center justify-center rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover"
              onClick={copyImage}
              data-promo-copy-image-button
            >
              {t('commercePromoCopyImage')}
            </button>
          </div>
          {status && <div className="text-xs text-claude-accent" role="status">{status}</div>}
        </div>

        <div className="mt-4">
          <div className="text-xs font-semibold dark:text-claude-darkText text-claude-text">{t('commercePromoTemplates')}</div>
          <div className="mt-2 space-y-2">
            {templates.map((template) => (
              <div key={template.key} className="rounded-lg border p-2.5 dark:border-claude-darkBorder border-claude-border" data-promo-template={template.key}>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">{t(template.key)}</span>
                  <button
                    type="button"
                    className="shrink-0 rounded-md bg-claude-accent/10 px-2 py-1 text-[11px] font-medium text-claude-accent transition-colors hover:bg-claude-accent/20"
                    onClick={() => copyText(template.text, template.key)}
                  >
                    {t('commercePromoCopied').split(' ')[0]} ⧉
                  </button>
                </div>
                <p className="mt-1.5 whitespace-pre-wrap break-words text-[11px] leading-4 dark:text-claude-darkTextSecondary text-claude-textSecondary">{template.text}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

export default PromoAmmoPackModal;
