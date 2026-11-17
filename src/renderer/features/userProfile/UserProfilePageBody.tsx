import React, { useEffect } from 'react';
import UserSettings from '../../components/user/UserSettings';
import MeCreditsPanel from './MeCreditsPanel';
import { useUserProfileCopy } from './i18n';
import {
  getUserProfileIdentity,
  refreshUserProfileIdentity,
  subscribeUserProfileIdentity,
} from './userProfileStore';

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
 *     `NftAvatarFrame` public export (plain data/http avatar unchanged, a subtle
 *     verified-NFT badge, or the certified-collection frame) and
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

  
  return (
    <>
      {/* Identity header removed (owner ruling 2026-11-15 23:16): the name
          now lives only in the 用户资料 card; identity errors still surface
          inline here. */}
      <div data-slot="user-profile-identity-errors">
          {snapshot.error ? (
            <p className="mt-0.5 text-[11px] text-amber-600 dark:text-amber-400">{copy.identityLoadFailed}</p>
          ) : null}
      </div>

      {/* The dead mt-8 residue left with the identity header (owner ruling
          2026-11-18): the ME block now sits directly on the scroll container's
          py-5, symmetric with the left/right inset. */}
      <MeCreditsPanel />

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
