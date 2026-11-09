import React from 'react';
import { ArrowTopRightOnSquareIcon } from '@heroicons/react/24/outline';
import { useUserProfileCopy } from './i18n';
import { openUserProfile } from './userProfileStore';

/**
 * The card that stands where Settings › 用户 used to render the account block.
 *
 * The block itself is not deleted and not re-implemented: it moved to the
 * standalone user page (`UserProfilePage`, opened from the header's top-left
 * avatar entry), where the very same `UserSettings` component is mounted. This
 * card keeps the Settings entry discoverable and hands the click over to that
 * page instead of showing a second copy of the panel — which is what "摘出不删
 * 不废" requires: one home for the data, no lost action, no duplicate form.
 */
const UserProfileMovedNotice: React.FC = () => {
  const copy = useUserProfileCopy();
  return (
    <div data-slot="settings-user-moved" className="rounded-xl border border-claude-border/60 px-4 py-4 dark:border-claude-darkBorder/60">
      <p className="text-sm font-medium dark:text-claude-darkText text-claude-text">{copy.settingsMovedTitle}</p>
      <p className="mt-1.5 text-xs leading-relaxed text-claude-textSecondary dark:text-claude-darkTextSecondary">
        {copy.settingsMovedBody}
      </p>
      <button
        type="button"
        onClick={() => openUserProfile()}
        className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-claude-border px-3 py-1.5 text-xs font-medium text-claude-text transition-colors hover:bg-claude-surfaceHover dark:border-claude-darkBorder dark:text-claude-darkText dark:hover:bg-claude-darkSurfaceHover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-claude-accent/40"
      >
        {copy.settingsMovedOpen}
        <ArrowTopRightOnSquareIcon className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </div>
  );
};

export default UserProfileMovedNotice;
