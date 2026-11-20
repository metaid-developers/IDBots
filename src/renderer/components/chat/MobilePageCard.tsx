import React, { useMemo } from 'react';
import { ArrowTopRightOnSquareIcon, ClockIcon } from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import {
  mobilePageCardExpiryLabel,
  isMobilePageCardExpired,
  openMobilePageCard,
  type MobilePageCardData,
} from './mobilePageCardSyntax';

/**
 * `mobile-page-card` renderer — a bot hosted a page on the tenant gateway and
 * sent this card; tapping it opens the page.
 *
 * Two deliberate choices, both consequences of the mobile shell contract:
 *
 *  1. The card is a REAL anchor (`href` = same-origin `/pages/<token>/`), so
 *     the WebView's own navigation performs the open with the user gesture
 *     intact and cookie auth applies. On the mobile shell a same-origin URL
 *     stays inside the app's WebView (`NativeShellWebViewClient` returns false
 *     for trusted remotes) — that IS the in-app browser. `installShim.ts`
 *     (~L227) records the failure this avoids: a `window.open` after any
 *     `await` loses the gesture and is popup-blocked on phones. The URL is
 *     already resolved at render time, so the click handler can hand it to
 *     `window.open` synchronously and fall back to the anchor's own
 *     same-tab navigation when the browser refuses the popup.
 *  2. An expired grant renders a clearly disabled card. The gateway answers
 *     404 from the expiry instant on, and a live-looking button that fails is
 *     worse than an honest "expired".
 *
 * Desktop: the fence reaches desktop chat surfaces too, where the card is a
 * plain same-origin link; the renderer adds no desktop behavior of its own.
 */
export default function MobilePageCard({ data }: { data: MobilePageCardData }): JSX.Element {
  const expired = useMemo(() => isMobilePageCardExpired(data), [data]);
  const expiryLabel = useMemo(() => mobilePageCardExpiryLabel(data), [data]);

  const open = (event: React.MouseEvent<HTMLAnchorElement>): void => {
    // Synchronous by design: nothing awaits before the navigation.
    const win = typeof window !== 'undefined' ? window : undefined;
    if (!win) {
      if (expired) event.preventDefault();
      return;
    }
    event.preventDefault();
    openMobilePageCard(data, {
      open: (url, target, features) => win.open(url, target, features),
      assign: (url) => win.location.assign(url),
    });
  };

  return (
    <div
      className={`my-[16px] rounded-[12px] border border-claude-border dark:border-claude-darkBorder overflow-hidden ${expired ? 'opacity-60' : ''}`}
      data-mobile-page-card
      data-mobile-page-expired={expired ? 'true' : 'false'}
      data-mobile-page-url={data.url}
    >
      <div className="dark:bg-claude-darkSurfaceMuted bg-claude-surfaceMuted px-[14px] py-[9px] text-[11px] leading-[18px] dark:text-claude-darkTextSecondary text-claude-textSecondary font-medium flex items-center justify-between">
        <span>{i18nService.t('mobilePageCardHeader')}</span>
        <span className="inline-flex items-center gap-1" data-mobile-page-expiry>
          <ClockIcon className="h-3.5 w-3.5" aria-hidden />
          {expired ? i18nService.t('mobilePageCardExpired') : expiryLabel}
        </span>
      </div>
      <div className="p-[14px] flex flex-col gap-2">
        <p className="text-[14px] leading-[20px] font-semibold text-claude-text dark:text-claude-darkText break-words" data-mobile-page-title>
          {data.title}
        </p>
        {data.description ? (
          <p className="text-[12px] leading-[18px] dark:text-claude-darkTextSecondary text-claude-textSecondary break-words" data-mobile-page-description>
            {data.description}
          </p>
        ) : null}
        {expired ? (
          <p className="text-[12px] leading-[18px] text-red-600" role="alert" data-mobile-page-expired-notice>
            {i18nService.t('mobilePageCardExpiredBody')}
          </p>
        ) : (
          <a
            href={data.url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={open}
            className="inline-flex items-center gap-1 text-[13px] leading-[18px] text-claude-accent hover:text-claude-accentHover underline decoration-claude-accent/50 hover:decoration-claude-accent transition-colors"
            data-mobile-page-open
          >
            <ArrowTopRightOnSquareIcon className="h-3.5 w-3.5" aria-hidden />
            {i18nService.t('mobilePageCardOpen')}
          </a>
        )}
      </div>
    </div>
  );
}
