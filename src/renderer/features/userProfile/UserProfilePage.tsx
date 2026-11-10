import React, { Suspense, useEffect } from 'react';
import { ArrowLeftIcon } from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import MePurchaseFlow from '../../components/me/MePurchaseFlow';
import { useUserProfileCopy } from './i18n';
import {
  closeUserProfile,
  closeUserProfilePlansPage,
  getUserProfileOpen,
  getUserProfilePlansPage,
  openUserProfilePlansPage,
  subscribeUserProfileOpen,
  subscribeUserProfilePlansPage,
} from './userProfileStore';

/**
 * The user page OVERLAY SHELL (owner ruling 2026-11-09 10:05, D line).
 *
 * Deliberately light: the page body — the identity header, the ME credits panel
 * and the 1 350-line `UserSettings` account block — is behind `React.lazy`, so
 * mounting the top-left avatar entry on the shell does not drag the account
 * block into the initial bundle. (Settings is lazy in App.tsx for exactly this
 * reason; this page must not undo it.)
 *
 * The overlay is mounted by whichever face is on screen (Sidebar.tsx on
 * BotWorks, HomeSidebar.tsx on Studio). App.tsx is untouched, so the Bot
 * Browser keep-alive pane is never unmounted by opening or closing the page.
 *
 * 页面嵌套定版 (2026-11-09): the card is a TWO-LEVEL page, not a card plus a
 * second floating modal. Level 1 is 「我的」; clicking 「开通/升级套餐」 (or
 * 「充值」) swaps the very same card body to the plans flow (`MePurchaseFlow`
 * chrome='embedded' — same container size, same radius, same back bar), and
 * the back bar + Escape return to level 1. Only the level-1 back button closes
 * the card (back to wherever the entry lives). MePurchaseFlow already rides
 * the main bundle through App.tsx, so importing it here adds no chunk weight.
 */
const UserProfilePageBody = React.lazy(() => import('./UserProfilePageBody'));

const UserProfilePage: React.FC = () => {
  const copy = useUserProfileCopy();
  // Page chrome needs only the open flag; the body subscribes to the identity.
  const open = React.useSyncExternalStore(subscribeUserProfileOpen, getUserProfileOpen, getUserProfileOpen);
  // Level-2 plans page state (null = level-1 「我的」 body).
  const plansPage = React.useSyncExternalStore(subscribeUserProfilePlansPage, getUserProfilePlansPage, getUserProfilePlansPage);

  useEffect(() => {
    if (!open) return undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        // Level 2 backs into level 1 first; level 1 closes the card.
        if (getUserProfilePlansPage()) {
          closeUserProfilePlansPage();
        } else {
          closeUserProfile();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open]);

  if (!open) return null;

  const onPlans = plansPage !== null;
  const plansTitle = plansPage === 'topup' ? i18nService.t('mePurchaseTopupTitle') : i18nService.t('mePurchaseTitle');

  return (
    <div
      data-slot="user-profile-page"
      role="dialog"
      aria-modal="true"
      aria-label={onPlans ? plansTitle : copy.title}
      // non-draggable is load-bearing (hot-zone fix 2026-11-09): the face
      // chrome beneath (BotBrowserModeSwitch surface-header) is a window-drag
      // handle whose drag region reaches the card's top-left header. Blink's
      // draggable-region pass only sees elements carrying an app-region
      // annotation, so the un-annotated overlay/card never subtracted from it
      // and real clicks on the ← glyph center dragged the window instead of
      // pressing the button (verified: mouse-down+move at the glyph center
      // moved the window +60px). Annotating the overlay subtracts the whole
      // viewport from every underlying drag rect while the modal is open.
      className="non-draggable fixed inset-0 z-[120] flex items-stretch justify-center bg-black/40 backdrop-blur-sm"
      onClick={closeUserProfile}
    >
      <div
        className="non-draggable relative flex h-full w-full flex-col overflow-hidden dark:bg-claude-darkSurface bg-claude-surface sm:m-6 sm:h-[calc(100vh-3rem)] sm:max-w-3xl sm:rounded-2xl sm:border sm:border-claude-border/60 sm:shadow-2xl sm:dark:border-claude-darkBorder/60"
        onClick={(event) => event.stopPropagation()}
      >
        <header
          data-slot="user-profile-header"
          data-level={onPlans ? 'plans' : 'mine'}
          className="flex shrink-0 items-center gap-3 border-b border-claude-border/60 px-5 py-4 dark:border-claude-darkBorder/60"
        >
          {/* 返回按钮常显常可点 (owner ruling 2026-11-09): the resting state
              already renders as a visible, clickable button (border + inset
              fill); hover only deepens the fill — it never reveals or enables
              the control. The full h-8 w-8 box is the hit area (≥ the 16px
              glyph), so a click anywhere inside it lands on the button. */}
          <button
            type="button"
            onClick={onPlans ? closeUserProfilePlansPage : closeUserProfile}
            aria-label={copy.close}
            title={copy.close}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-claude-border bg-claude-surfaceInset text-claude-textSecondary transition-colors hover:bg-claude-surfaceHover hover:text-claude-text dark:border-claude-darkBorder dark:bg-claude-darkSurfaceInset dark:text-claude-darkTextSecondary dark:hover:bg-claude-darkSurfaceHover dark:hover:text-claude-darkText focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-claude-accent/40"
          >
            <ArrowLeftIcon className="h-4 w-4" />
          </button>
          <h2 className="min-w-0 truncate text-sm font-semibold dark:text-claude-darkText text-claude-text">
            {onPlans ? plansTitle : copy.title}
          </h2>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
          {/* Level swap inside ONE card (same container, same chrome): the fade
              replays per level via the key — a light in-card page transition,
              not a modal stacking on top of another modal. */}
          {onPlans ? (
            <div key={`plans-${plansPage}`} data-slot="user-profile-plans-level" className="animate-fade-in-up">
              <MePurchaseFlow
                open
                chrome="embedded"
                section={plansPage}
                onSectionChange={openUserProfilePlansPage}
                onClose={closeUserProfilePlansPage}
              />
            </div>
          ) : (
            <div key="mine" data-slot="user-profile-mine-level" className="animate-fade-in-up">
              <Suspense
                fallback={
                  <p data-slot="user-profile-loading" className="text-xs text-claude-textSecondary dark:text-claude-darkTextSecondary">
                    {copy.loading}
                  </p>
                }
              >
                <UserProfilePageBody />
              </Suspense>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default UserProfilePage;
