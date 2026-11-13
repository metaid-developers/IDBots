import React, { useEffect, useState } from 'react';
import { i18nService } from '../../services/i18n';
import { getDefaultMetabotAvatarUrl } from '../../utils/rendererAssetPaths';
import { toRenderableAvatarSource } from '../../utils/avatarSource';
import NftAvatarFrame from '../../components/metabots/NftAvatarFrame';
import { parseNftAvatarReference } from '../../components/metabots/nftAvatarPresentation.js';
import {
  buildPanelDelegationStatusCopy,
  type PanelOpenDelegation,
} from './panelDelegationStatus';

const DEFAULT_BOT_AVATAR = getDefaultMetabotAvatarUrl();

/** Elapsed label refresh cadence — minute-granularity copy needs no more. */
const TICK_INTERVAL_MS = 30_000;

/**
 * Idle-session worker status row (C2): sits at the reply position where the
 * streaming indicator would be, reusing its visual language — the session
 * bot-avatar ring slot now carries the WORKER's avatar, line 1 names the
 * work in progress, line 2 promises the twin's review on return. When the
 * worker's own session id is known the whole row opens it in BotWorks.
 */
export const PanelDelegationStatusRow: React.FC<{
  delegations: readonly PanelOpenDelegation[];
  /** Session bot name for the "will check it and report" second line. */
  twinName?: string | null;
  /** Opens the worker session in BotWorks; absent = the row is not clickable. */
  onOpenWorkerSession?: (workerSessionId: string) => void;
}> = ({ delegations, twinName = null, onOpenWorkerSession }) => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), TICK_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, []);

  const copy = buildPanelDelegationStatusCopy(delegations, twinName, i18nService.getLanguage(), now);
  if (!copy) return null;

  const rawAvatar = copy.primary.workerAvatar ?? null;
  const avatarSrc = parseNftAvatarReference(rawAvatar)
    ? rawAvatar
    : (toRenderableAvatarSource(rawAvatar) ?? DEFAULT_BOT_AVATAR);
  const workerSessionId = copy.primary.workerSessionId ?? null;
  const clickable = Boolean(workerSessionId && onOpenWorkerSession);

  const body = (
    <>
      <div className="assistant-activity-avatar-ring relative h-8 w-8 shrink-0">
        <NftAvatarFrame
          avatar={avatarSrc}
          frameClassName="h-8 w-8 rounded-full"
          fallback={<img src={DEFAULT_BOT_AVATAR} alt="" className="h-8 w-8 rounded-full object-cover" />}
        />
      </div>
      <span className="min-w-0">
        <span className="assistant-status-shimmer dark:text-claude-darkText text-claude-text block truncate text-sm">
          {copy.line1}
        </span>
        <span className="mt-0.5 block truncate text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
          {copy.line2}
        </span>
      </span>
    </>
  );

  const rowClassName = `flex items-start gap-2.5 pt-2 pb-1 ${clickable ? 'w-full cursor-pointer rounded-lg text-left hover:bg-claude-surfaceHover/60 dark:hover:bg-claude-darkSurfaceHover/60' : ''}`;
  if (clickable && workerSessionId && onOpenWorkerSession) {
    return (
      <button
        type="button"
        onClick={() => onOpenWorkerSession(workerSessionId)}
        className={rowClassName}
        title={copy.primary.title}
        data-activity="delegation-waiting"
      >
        {body}
      </button>
    );
  }
  return (
    <div className={rowClassName} role="status" aria-live="polite" data-activity="delegation-waiting">
      {body}
    </div>
  );
};
