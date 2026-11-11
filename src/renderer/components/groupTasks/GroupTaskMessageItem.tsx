import React, { useEffect, useState } from 'react';
import { DocumentDuplicateIcon } from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import { resolveMetaidAvatarSource } from '../../services/metabotInfoService';
import { getDefaultMetabotAvatarUrl } from '../../utils/rendererAssetPaths';
import { isRenderableAvatarSource as isSharedRenderableAvatarSource } from '../../utils/avatarSource';
import NftAvatarFrame from '../metabots/NftAvatarFrame';
import { parseNftAvatarReference } from '../metabots/nftAvatarPresentation.js';
import MarkdownContent from '../MarkdownContent';
import {
  messengerBubbleClassName,
  messengerColumnClassName,
  messengerMarkdownClassName,
  messengerMetaClassName,
  messengerRowClassName,
  messengerTxidRowClassName,
} from '../chat/messengerBubble';
import { mapWechatBracketCodesForDisplay } from '../chat/wechatEmojiDisplay';
import { detectTradeActivity } from '../chat/tradeActivity';
import TradeActivityBadge from '../chat/TradeActivityBadge';
import type { GroupChatTranscriptMessage } from '../../types/groupTask';
import { formatGroupTaskMessengerTime } from './groupTaskUtils';
import { openBotPageInBotBrowser } from './GroupTaskListMeta';

const DEFAULT_AVATAR = getDefaultMetabotAvatarUrl();
const TXID_RE = /^[0-9a-f]{64}$/i;

/** Module-level resolution cache so the 5s transcript polling never re-resolves. */
const avatarResolutionCache = new Map<string, string | null>();

const isRenderableAvatarSource = (value: string | null | undefined): boolean =>
  isSharedRenderableAvatarSource(value);

/**
 * Resolve a sender avatar to a renderable URL. Raw MetaWeb avatar values
 * (metafile:// refs, pin ids) go through the main-process resolver used by the
 * A2A views; anything unresolvable falls back to the default metabot avatar.
 */
function useSenderAvatar(message: GroupChatTranscriptMessage): string {
  const raw = message.senderAvatar?.trim() ?? '';
  const direct = parseNftAvatarReference(raw) ? raw : (isRenderableAvatarSource(raw) ? raw : null);
  const reference = direct ? null : (raw || message.senderGlobalMetaId?.trim() || null);
  const [resolved, setResolved] = useState<string | null>(
    reference ? avatarResolutionCache.get(reference) ?? null : null,
  );

  useEffect(() => {
    if (!reference) return;
    if (avatarResolutionCache.has(reference)) {
      setResolved(avatarResolutionCache.get(reference) ?? null);
      return;
    }
    let cancelled = false;
    resolveMetaidAvatarSource(reference)
      .then((url) => {
        avatarResolutionCache.set(reference, url);
        if (!cancelled) setResolved(url);
      })
      .catch(() => {
        avatarResolutionCache.set(reference, null);
      });
    return () => {
      cancelled = true;
    };
  }, [reference]);

  return direct ?? resolved ?? DEFAULT_AVATAR;
}

/** Full on-chain tx id for the message: explicit tx_id, else pinId minus its 'i0' output suffix. */
function resolveTxId(message: GroupChatTranscriptMessage): string | null {
  const explicit = message.txId?.trim();
  if (explicit) return explicit;
  const pin = message.pinId?.trim();
  if (!pin) return null;
  return pin.endsWith('i0') ? pin.slice(0, -2) : pin;
}

function formatTxidPreview(txId: string): string {
  const normalized = txId.trim().toLowerCase();
  if (TXID_RE.test(normalized) || normalized.length > 12) {
    return `${normalized.slice(0, 8)}....`;
  }
  return normalized;
}

const copyTextToClipboard = (value: string): void => {
  if (!value || typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
    return;
  }
  void navigator.clipboard.writeText(value).catch(() => {});
};

const RoleBadge: React.FC<{ className: string; children: React.ReactNode; title?: string }> = ({
  className,
  children,
  title,
}) => (
  <span
    title={title}
    className={`shrink-0 rounded px-1 py-px text-[10px] font-medium leading-tight ${className}`}
  >
    {children}
  </span>
);

/**
 * P0-1: fold over-long [DELIVERABLE] lines (eleven's long delivery was
 * truncated in the group log). Only lines carrying the protocol tag count;
 * plain long prose is never folded.
 */
const DELIVERABLE_FOLD_THRESHOLD = 200;

function hasLongDeliverableLine(content: string): boolean {
  return content.split('\n').some(
    (line) => /\[DELIVERABLE\]/i.test(line) && line.trim().length > DELIVERABLE_FOLD_THRESHOLD,
  );
}

function longDeliverableSummary(content: string): string {
  const lines = content.split('\n');
  const longLines = lines.filter(
    (line) => /\[DELIVERABLE\]/i.test(line) && line.trim().length > DELIVERABLE_FOLD_THRESHOLD,
  );
  const totalChars = longLines.reduce((sum, line) => sum + line.trim().length, 0);
  return `${longLines.length} [DELIVERABLE] line(s), ${totalChars} chars`;
}

/**
 * P12 (v1.1): the host-posted acceptance summary is a long checklist.
 * Detect it by the language-neutral notice prefix (or the pre-i18n Chinese
 * opening) so the transcript can fold it by default.
 */
function isAcceptanceSummaryMessage(content: string): boolean {
  const text = content.trimStart();
  if (text.startsWith('[GROUP_TASK_NOTICE:review_summary]')) return true;
  return text.startsWith('📦 任务「') && text.includes('已进入验收阶段');
}

interface GroupTaskMessageItemProps {
  message: GroupChatTranscriptMessage;
  /**
   * P13 (v1.1): sender display name resolved from the task's member roster by
   * senderGlobalMetaId. Wins over the chain nickname, which can carry a
   * runtime identity name ("claude bot") instead of the worker's registered
   * name. Optional — callers without a roster fall back to message.senderName.
   */
  senderDisplayName?: string;
  isChairSender: boolean;
  isOwnerSender: boolean;
  /** Sender is a remote member who joined via OpenTeam (matched by globalmetaid). */
  isRemoteSender?: boolean;
  /** Sender is one of this machine's own bots (OpenTeam invitee transcript). */
  isOwnBotSender?: boolean;
  /** Briefly highlight this row (e.g. when jumped to from an integrity event). */
  highlight?: boolean;
  /**
   * R5: the message this one replies to (resolved by replyPin from the loaded
   * transcript). null = replyPin set but target not in the loaded window (the
   * bar still shows and clicking jumps/loads it). undefined = no replyPin.
   */
  replyTarget?: { senderName: string; preview: string } | null;
  /** R5: jump to (and load if needed) the replied-to message. */
  onJumpToReply?: (pinId: string) => void;
}

const GroupTaskMessageItem = React.memo(({
  message,
  senderDisplayName,
  isChairSender,
  isOwnerSender,
  isRemoteSender,
  isOwnBotSender,
  highlight,
  replyTarget,
  onJumpToReply,
}: GroupTaskMessageItemProps) => {
  // Round-4 attribution: the chain-signature GlobalMetaID is the ONLY identity
  // source. A message whose sender is neither a task member nor the owner is
  // flagged SUSPECT — never attributed by senderName.
  const isSuspectSender = message.senderSuspect === true;
  const isOutgoing = Boolean(isOwnerSender || isOwnBotSender);
  const senderName = senderDisplayName?.trim() || message.senderName?.trim() || 'Unknown';
  const timestamp = formatGroupTaskMessengerTime(message.chainTimestamp);
  const avatarSrc = useSenderAvatar(message);
  const senderGlobalMetaId = message.senderGlobalMetaId?.trim() || null;
  const senderBrowserLabel = i18nService.t('groupTasksOpenBotInBrowser').replace('{name}', senderName);
  const txId = resolveTxId(message);
  const txidPreview = txId ? formatTxidPreview(txId) : '';
  const rawContent = message.content ?? '';
  // S4 chat trade marker: the message announces an NFT trade (nft-card fence
  // with a trade action) → a trade chip rides the sender badge row (escrow
  // activity concentrates in group transcripts).
  const tradeActivity = detectTradeActivity(rawContent);
  const longDeliverable = hasLongDeliverableLine(rawContent);
  const acceptanceSummaryFold = isAcceptanceSummaryMessage(rawContent);
  const [deliverableExpanded, setDeliverableExpanded] = useState(false);
  const markdownClassName = messengerMarkdownClassName(isOutgoing);
  const foldLabelClass = isOutgoing
    ? 'text-white'
    : 'dark:text-claude-darkText text-claude-text';
  const collapseClass = isOutgoing
    ? 'mt-1 text-xs text-white/80 hover:underline'
    : 'mt-1 text-xs text-claude-textSecondary dark:text-claude-darkTextSecondary/70 hover:underline';
  const replyClass = isOutgoing
    ? 'mb-1.5 flex w-full max-w-full items-center gap-1 rounded-lg border-l-2 border-white/40 bg-white/10 px-2 py-1 text-left text-[11px] leading-4 text-white/85 hover:bg-white/15 transition-colors'
    : 'mb-1.5 flex w-full max-w-full items-center gap-1 rounded-lg border-l-2 border-claude-accent/50 bg-black/[0.03] dark:bg-white/[0.04] px-2 py-1 text-left text-[11px] leading-4 text-claude-textSecondary dark:text-claude-darkTextSecondary/80 hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors';

  return (
    <div
      data-pin-id={message.pinId ?? undefined}
      data-outgoing={isOutgoing ? 'true' : 'false'}
      className={`${messengerRowClassName(isOutgoing)} transition-colors ${
        highlight ? 'rounded-lg bg-claude-accent/5 ring-2 ring-claude-accent/60' : ''
      }`}
    >
      {senderGlobalMetaId ? (
        <button
          type="button"
          data-browser-global-metaid={senderGlobalMetaId}
          aria-label={senderBrowserLabel}
          title={senderBrowserLabel}
          onClick={(event) => {
            event.stopPropagation();
            event.preventDefault();
            openBotPageInBotBrowser(senderGlobalMetaId);
          }}
          className="rounded-full flex-shrink-0 transition-shadow hover:ring-2 hover:ring-claude-accent/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-claude-accent/60"
        >
          <NftAvatarFrame
            avatar={avatarSrc}
            frameClassName="h-8 w-8 rounded-full"
            fallback={<img src={DEFAULT_AVATAR} alt={senderName} className="h-8 w-8 rounded-full object-cover" />}
            alt={senderName}
          />
        </button>
      ) : (
        <NftAvatarFrame
          avatar={avatarSrc}
          frameClassName="h-8 w-8 rounded-full"
          fallback={<img src={DEFAULT_AVATAR} alt={senderName} className="h-8 w-8 rounded-full object-cover" />}
          alt={senderName}
        />
      )}

      <div className={messengerColumnClassName(isOutgoing)}>
        <div className={`mb-0.5 flex max-w-full flex-wrap items-center gap-1 px-1 ${isOutgoing ? 'flex-row-reverse' : 'flex-row'}`}>
          <span className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary truncate">
            {senderName}
          </span>
          {isSuspectSender && (
            <RoleBadge
              className="bg-amber-500/15 text-amber-600 dark:text-amber-400"
              title="Sender GlobalMetaID is not a task member — not attributed by display name"
            >
              SUSPECT
            </RoleBadge>
          )}
          {isChairSender && (
            <RoleBadge className="bg-claude-accent/15 text-claude-accent">
              {i18nService.t('groupTasksChairBadge')}
            </RoleBadge>
          )}
          {isOwnerSender && (
            <RoleBadge className="bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
              {i18nService.t('groupTasksOwnerBadge')}
            </RoleBadge>
          )}
          {isRemoteSender && (
            <RoleBadge className="bg-green-500/15 text-green-600 dark:text-green-400">
              {i18nService.t('groupTasksRemoteBadge')}
            </RoleBadge>
          )}
          {isOwnBotSender && (
            <RoleBadge className="bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
              {i18nService.t('openTeamCollabOwnBotBadge')}
            </RoleBadge>
          )}
          {tradeActivity && (
            <TradeActivityBadge kind={tradeActivity.kind} variant="chip" />
          )}
        </div>

        <div className={messengerBubbleClassName(isOutgoing)}>
          {message.replyPin && (
            <button
              type="button"
              onClick={() => onJumpToReply?.(message.replyPin!)}
              className={replyClass}
              title={message.replyPin}
            >
              <span className={`shrink-0 ${isOutgoing ? 'text-white/90' : 'text-claude-accent'}`}>↩</span>
              <span className="truncate">
                {replyTarget
                  ? `${i18nService.t('groupTasksReplyTo')} ${replyTarget.senderName}: ${replyTarget.preview || i18nService.t('groupTasksReplyEmpty')}`
                  : `${i18nService.t('groupTasksReplyTo')} ${i18nService.t('groupTasksReplyNotLoaded')}`}
              </span>
            </button>
          )}
          {acceptanceSummaryFold && !deliverableExpanded ? (
            <button
              type="button"
              onClick={() => setDeliverableExpanded(true)}
              className={`block w-full text-left text-sm ${foldLabelClass}`}
              title="Click to expand the full acceptance checklist"
            >
              <span className="inline-flex items-center gap-1.5 rounded bg-emerald-500/10 px-2 py-1 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                {i18nService.t('groupTasksAcceptanceFolded')} ({rawContent.length} chars)
              </span>
            </button>
          ) : longDeliverable && !deliverableExpanded ? (
            <button
              type="button"
              onClick={() => setDeliverableExpanded(true)}
              className={`block w-full text-left text-sm ${foldLabelClass}`}
              title="Click to expand the full delivery"
            >
              <span className="inline-flex items-center gap-1.5 rounded bg-amber-500/10 px-2 py-1 text-xs font-medium text-amber-600 dark:text-amber-400">
                Folded: {longDeliverableSummary(rawContent)} — click to expand
              </span>
            </button>
          ) : (
            // Display-time WeChat bracket-code mapping; raw transcript text
            // (fold labels, copying, chain data) stays untouched. emojiImages:
            // catalog emoji render as bundled Twemoji artwork (display-only).
            <MarkdownContent content={mapWechatBracketCodesForDisplay(rawContent)} className={markdownClassName} emojiImages />
          )}
          {(longDeliverable || acceptanceSummaryFold) && deliverableExpanded && (
            <button
              type="button"
              onClick={() => setDeliverableExpanded(false)}
              className={collapseClass}
            >
              {acceptanceSummaryFold
                ? i18nService.t('groupTasksAcceptanceCollapse')
                : 'Collapse long delivery'}
            </button>
          )}
        </div>

        {txidPreview && txId ? (
          // Meta row: time and txid share one line (two-space gap via gap-1 +
          // ml-1); formats unchanged, copy button stays beside the txid.
          <div className={messengerTxidRowClassName(isOutgoing)}>
            {timestamp && <span>{timestamp}</span>}
            <span className="ml-1 font-mono">txid: {txidPreview}</span>
            <button
              type="button"
              onClick={() => copyTextToClipboard(txId)}
              className="inline-flex h-4 w-4 items-center justify-center rounded text-current hover:bg-black/10 dark:hover:bg-white/10"
              title={i18nService.t('groupTasksCopyTxid')}
              aria-label={i18nService.t('groupTasksCopyTxid')}
            >
              <DocumentDuplicateIcon className="h-3 w-3" />
            </button>
          </div>
        ) : (
          timestamp && (
            <span className={messengerMetaClassName}>
              {timestamp}
            </span>
          )
        )}
      </div>
    </div>
  );
});

export default GroupTaskMessageItem;
