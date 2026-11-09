import React, { useEffect } from 'react';
import { UserCircleIcon } from '@heroicons/react/24/outline';
import NftAvatarFrame from '../../components/metabots/NftAvatarFrame';
import UserSettings from '../../components/user/UserSettings';
import MeCreditsPanel from './MeCreditsPanel';
import { useUserProfileCopy } from './i18n';
import {
  getUserProfileIdentity,
  refreshUserProfileIdentity,
  subscribeUserProfileIdentity,
} from './userProfileStore';
import { readTwinDailyMessage, resolveSessionFallbackMessage } from './twinDailyMessageService';

/**
 * The BODY of the user page (owner ruling 2026-11-09 10:05, D line).
 *
 * Kept apart from the overlay shell (`UserProfilePage.tsx`) on purpose: this
 * module statically imports the 1 350-line `UserSettings` account block and the
 * ME credits panel, and those must NOT ride the initial app bundle. The shell
 * is light and lazily pulls this file in when the page is first opened — the
 * same reason `Settings` itself sits behind `React.lazy` in App.tsx.
 *
 * What the page carries:
 *  1. the identity header — the local user's avatar through the shared
 *     `NftAvatarFrame` public export (plain data/http avatar unchanged, the NFT
 *     frame + certified badge when the stored value is `nft://mrc721/…`) and
 *     the name, both FOLLOWING the account block below (the block owns the
 *     writes; `app:metabots-changed` re-reads the identity) — the wallet
 *     address line is retired and its place is the twin 每日寄语 slot
 *     (身份卡批单 2026-11-09, `twinDailyMessageService`);
 *  2. the ME credits panel — the sidebar footer's balance + the 「我的 ME 积分」
 *     popover content, in-page instead of in a popover (`MeCreditsPanel`);
 *  3. the account block extracted from Settings — the SAME `UserSettings`
 *     component, mounted unchanged, so create / import / mnemonic backup /
 *     profile / switch account / logout and their chain-backup prompts are all
 *     still here with their original IPC calls. Nothing was re-implemented.
 */
const UserProfilePageBody: React.FC = () => {
  const copy = useUserProfileCopy();
  const snapshot = React.useSyncExternalStore(
    subscribeUserProfileIdentity,
    getUserProfileIdentity,
    getUserProfileIdentity,
  );

  // The daily-note slot: today's twin-written note when the field carries one,
  // otherwise the session-stable random fallback line. Read ONCE per mount —
  // the pick must stay identical across re-renders of the same session.
  const dailyMessage = React.useMemo(() => {
    const stored = readTwinDailyMessage();
    return stored?.text ?? resolveSessionFallbackMessage();
  }, []);

  // While the page is open, keep the identity header in step with the account
  // block below it. The block owns the writes; these are the only signals it
  // emits that can move the identity (a chain restore re-reads the roster) plus
  // the window regaining focus. No polling.
  useEffect(() => {
    void refreshUserProfileIdentity();
    const handleRefresh = () => {
      void refreshUserProfileIdentity();
    };
    window.addEventListener('app:metabots-changed', handleRefresh);
    window.addEventListener('focus', handleRefresh);
    return () => {
      window.removeEventListener('app:metabots-changed', handleRefresh);
      window.removeEventListener('focus', handleRefresh);
    };
  }, []);

  const identity = snapshot.identity;
  const name = (identity?.name || '').trim();
  const initial = (name || copy.unnamed).trim().charAt(0).toUpperCase();

  return (
    <>
      {/* Identity header — the avatar goes through the shared frame export. */}
      <div data-slot="user-profile-identity" className="flex items-center gap-4">
        <NftAvatarFrame
          avatar={identity?.avatar ?? null}
          frameClassName="h-16 w-16 rounded-2xl"
          imgClassName="border dark:border-claude-darkBorder border-claude-border"
          fallback={
            snapshot.loaded && !identity ? (
              <span
                aria-hidden="true"
                className="inline-flex h-16 w-16 items-center justify-center rounded-2xl border border-dashed border-claude-border text-lg font-medium text-claude-textSecondary dark:border-claude-darkBorder dark:text-claude-darkTextSecondary"
              >
                {initial}
              </span>
            ) : (
              <UserCircleIcon
                aria-hidden="true"
                className="h-16 w-16 dark:text-claude-darkTextSecondary text-claude-textSecondary"
              />
            )
          }
          alt={name || copy.unnamed}
        />
        <div className="min-w-0">
          <p data-slot="user-profile-name" className="truncate text-base font-semibold dark:text-claude-darkText text-claude-text">
            {!snapshot.loaded
              ? copy.loading
              : identity
                ? name || copy.unnamed
                : copy.noIdentity}
          </p>
          <div
            data-slot="user-profile-daily-message"
            title={dailyMessage}
            className="mt-0.5 min-w-0"
          >
            <p className="text-[10px] font-medium tracking-wide text-claude-textSecondary dark:text-claude-darkTextSecondary">
              {copy.dailyMessageLabel}
            </p>
            <p className="mt-0.5 truncate text-[11px] leading-relaxed text-claude-textSecondary dark:text-claude-darkTextSecondary">
              {dailyMessage}
            </p>
          </div>
          {snapshot.error ? (
            <p className="mt-0.5 text-[11px] text-amber-600 dark:text-amber-400">{copy.identityLoadFailed}</p>
          ) : null}
        </div>
      </div>

      <div className="mt-6">
        <MeCreditsPanel />
      </div>

      <section data-slot="user-profile-account" className="mt-8">
        <h3 className="text-sm font-semibold dark:text-claude-darkText text-claude-text">{copy.accountSectionTitle}</h3>
        <p className="mt-1 text-[11px] leading-relaxed text-claude-textSecondary dark:text-claude-darkTextSecondary">
          {copy.accountSectionHint}
        </p>
        <div className="mt-3 rounded-2xl border border-claude-border/60 p-4 dark:border-claude-darkBorder/60">
          <UserSettings />
        </div>
      </section>
    </>
  );
};

export default UserProfilePageBody;
