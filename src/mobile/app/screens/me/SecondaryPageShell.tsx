import type { ReactNode } from 'react';
import { ArrowLeftIcon } from '@heroicons/react/24/outline';
import { t } from '../../../i18n';

/**
 * Shared skeleton for every Me secondary page (IA-PLAN v1 §4.2):
 * 44px top bar with a 44x44 back button + centered title, scrollable
 * `px-4` content, bottom safe-area padding. Save semantics differ per page
 * (instant-save vs explicit save button) and live in the pages themselves.
 */
export function SecondaryPageShell(props: {
  title: string;
  onBack: () => void;
  /** Optional right-aligned header action (e.g. the bots page's create). */
  action?: ReactNode;
  testId?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="twin-page" data-testid={props.testId ?? 'me-secondary-page'}>
      <div className="twin-topbar relative shrink-0">
        <button
          type="button"
          onClick={props.onBack}
          aria-label={t('mobile.me.back')}
          data-testid="me-secondary-back"
          className="twin-icon-button"
        >
          <ArrowLeftIcon className="h-5 w-5" aria-hidden />
        </button>
        <h1 className="twin-title-small pointer-events-none absolute left-1/2 -translate-x-1/2">
          {props.title}
        </h1>
        {props.action ? <div className="absolute right-2 flex items-center">{props.action}</div> : null}
      </div>
      <div className="twin-scroll space-y-3 px-4 py-3 pb-[max(env(safe-area-inset-bottom),12px)]">
        {props.children}
      </div>
    </div>
  );
}
