import React, { useEffect, useRef, useState } from 'react';
import type { CoworkMessage } from '../../types/cowork';
import { ChevronDownIcon, ChevronRightIcon, DocumentDuplicateIcon, ShareIcon } from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import { getDefaultMetabotAvatarUrl } from '../../utils/rendererAssetPaths';
import { pickRenderableAvatarSource as pickSharedRenderableAvatarSource } from '../../utils/avatarSource';
import MarkdownContent from '../MarkdownContent';
import FriendBadge from './FriendBadge';
import { mapWechatBracketCodesForDisplay } from '../chat/wechatEmojiDisplay';
import {
  messengerBubbleClassName,
  messengerColumnClassName,
  messengerMarkdownClassName,
  messengerMetaClassName,
  messengerNameClassName,
  messengerRowClassName,
  messengerTxidRowClassName,
} from '../chat/messengerBubble';
import { detectTradeActivity } from '../chat/tradeActivity';
import TradeActivityBadge from '../chat/TradeActivityBadge';
import {
  formatA2ATxidPreview,
  normalizeTxidCandidate,
  resolveA2AMessageTxid,
} from './a2aInternalMessageFilter';

export { formatA2ATxidPreview, resolveA2AMessageTxid };

const normalizeMetafileCandidate = (candidate: string): string => {
  return String(candidate || '').trim().replace(/[),.;:!?]+$/, '');
};

interface A2AMessageItemProps {
  message: CoworkMessage;
  /** Remote peer MetaBot name */
  peerName?: string | null;
  /** Remote peer MetaBot avatar data URL */
  peerAvatar?: string | null;
  /** Local MetaBot name */
  metabotName?: string | null;
  /** Local MetaBot avatar data URL */
  metabotAvatar?: string | null;
  /** Remote peer MetaBot GlobalMetaID */
  peerGlobalMetaId?: string | null;
  /** Local MetaBot GlobalMetaID */
  localGlobalMetaId?: string | null;
  /**
   * Flip the left/right layout: used when the peer is the local human owner,
   * so the owner's messages read on the right and the local bot's on the
   * left. Sender identity (name/avatar) is unaffected.
   */
  invertSides?: boolean;
  onOpenBotInBrowser?: (input: {
    globalMetaId: string;
    name?: string | null;
    avatar?: string | null;
  }) => void;
  canResendDigitalDelivery?: boolean;
  isResendingDigitalDelivery?: boolean;
  onResendDigitalDelivery?: (orderTxid: string) => void;
  /** Assistant mode hides raw thinking and tool-call chrome entirely. */
  isAssistantMode?: boolean;
  /**
   * S5 friend badge: true when the local bot and the session peer are
   * confirmed on-chain friends (mutual /follow, S4 pair-state source).
   * Renders a green chip beside the PEER's name only.
   */
  peerIsFriend?: boolean;
  /**
   * Session id of the A2A conversation — scope for the session-bound
   * hostStamp structural check (source-signing slice): a trade chip on an
   * A2A bubble requires the card's hostStamp to bind to THIS session.
   */
  sessionId?: string;
}

const formatTime = (timestamp: number): string => {
  const d = new Date(timestamp);
  const now = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const timeStr = `${hh}:${mm}`;

  if (d.getFullYear() < now.getFullYear()) {
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${month}-${day} ${timeStr}`;
  }

  const diffMs = now.getTime() - d.getTime();
  if (diffMs > 24 * 60 * 60 * 1000) {
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${month}-${day} ${timeStr}`;
  }

  return timeStr;
};

const DEFAULT_METABOT_AVATAR = getDefaultMetabotAvatarUrl();
const DELIVERY_TAG_RE = /^\[DELIVERY(?::[0-9a-fA-F]{64})?\]/;
const ORDER_PROTOCOL_TAG_RE = /^\[(ORDER_STATUS|NeedsRating|ORDER_END)(?::[0-9a-fA-F]{64})?(?:\s+[A-Za-z0-9_-]+)?\]\s*/i;
const ORDER_PROTOCOL_TXID_TAG_RE = /^\[(?:ORDER_STATUS|DELIVERY|NeedsRating|ORDER_END):([0-9a-fA-F]{64})(?:\s+[A-Za-z0-9_-]+)?\]/i;
const METAID_CONTENT_BASE = 'https://file.metaid.io/metafile-indexer/api/v1/files/content';
const METAID_ACCELERATE_CONTENT_BASE = 'https://file.metaid.io/metafile-indexer/api/v1/files/accelerate/content';
const METAFILE_URI_REGEX = /metafile:\/\/[^\s<>"'`]+/gi;
const METAFILE_PREVIEW_MAX_BYTES = 20 * 1024 * 1024;

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.gif', '.png', '.webp', '.bmp', '.svg']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.mov']);
const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.flac']);
const MIME_TYPE_BY_EXTENSION = new Map<string, string>([
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
  ['.bmp', 'image/bmp'],
  ['.svg', 'image/svg+xml'],
  ['.mp4', 'video/mp4'],
  ['.webm', 'video/webm'],
  ['.mov', 'video/quicktime'],
  ['.mp3', 'audio/mpeg'],
  ['.wav', 'audio/wav'],
  ['.flac', 'audio/flac'],
]);

type DeliveryPayload = {
  result?: string;
};

type MetafilePreviewKind = 'image' | 'video' | 'audio' | 'download';

type ParsedMetafile = {
  uri: string;
  pinId: string;
  extension: string | null;
  sourceUrl: string;
  fallbackUrl: string;
  fileName: string;
  kind: MetafilePreviewKind;
};

const parseDeliveryPayload = (content: string): DeliveryPayload | null => {
  const trimmed = String(content || '').trim();
  const tagMatch = trimmed.match(DELIVERY_TAG_RE);
  if (!tagMatch) {
    return null;
  }

  const jsonPart = trimmed.slice(tagMatch[0].length).trim();
  if (!jsonPart) {
    return null;
  }

  try {
    const parsed = JSON.parse(jsonPart);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as DeliveryPayload;
  } catch {
    return null;
  }
};

const stripOrderProtocolTag = (content: string): string => (
  String(content || '').trim().replace(ORDER_PROTOCOL_TAG_RE, '').trim()
);

export const getA2AMessageOrderTxid = (message: CoworkMessage): string => {
  const metadata = message.metadata ?? {};
  const metadataCandidate = [
    metadata.orderTxid,
    metadata.orderMessageTxid,
  ].map(normalizeTxidCandidate).find(Boolean);
  if (metadataCandidate) {
    return metadataCandidate;
  }

  const tagMatch = String(message.content || '').trim().match(ORDER_PROTOCOL_TXID_TAG_RE);
  return normalizeTxidCandidate(tagMatch?.[1]);
};

export const shouldShowA2AResendDigitalDeliveryAction = (
  message: CoworkMessage,
  canResendDigitalDelivery?: boolean,
): boolean => {
  if (!canResendDigitalDelivery) return false;
  const metadata = message.metadata ?? {};
  return (
    metadata.orderDeliveryUploadNotice === true
    && metadata.direction === 'outgoing'
    && metadata.orderRole === 'seller'
    && Boolean(getA2AMessageOrderTxid(message))
  );
};

const copyTextToClipboard = (value: string): void => {
  if (!value || typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
    return;
  }
  void navigator.clipboard.writeText(value).catch(() => {});
};

export const parseMetafileUri = (rawUri: string): ParsedMetafile | null => {
  const normalizedUri = normalizeMetafileCandidate(rawUri);
  if (!normalizedUri.toLowerCase().startsWith('metafile://')) {
    return null;
  }

  const withoutScheme = normalizedUri.slice('metafile://'.length).trim();
  if (!withoutScheme) {
    return null;
  }

  const basePart = withoutScheme.split(/[?#]/)[0] || '';
  if (!basePart) {
    return null;
  }

  const lastDotIndex = basePart.lastIndexOf('.');
  const hasExtension = lastDotIndex > 0 && lastDotIndex < basePart.length - 1;
  const pinId = hasExtension ? basePart.slice(0, lastDotIndex) : basePart;
  const extension = hasExtension ? `.${basePart.slice(lastDotIndex + 1).toLowerCase()}` : null;

  if (!pinId) {
    return null;
  }

  let kind: MetafilePreviewKind = 'download';
  if (extension && IMAGE_EXTENSIONS.has(extension)) {
    kind = 'image';
  } else if (extension && VIDEO_EXTENSIONS.has(extension)) {
    kind = 'video';
  } else if (extension && AUDIO_EXTENSIONS.has(extension)) {
    kind = 'audio';
  }

  const encodedPinId = encodeURIComponent(pinId);
  const sourceUrl = `${METAID_ACCELERATE_CONTENT_BASE}/${encodedPinId}`;
  const fallbackUrl = `${METAID_CONTENT_BASE}/${encodedPinId}`;
  const fileName = extension ? `${pinId}${extension}` : pinId;

  return {
    uri: normalizedUri,
    pinId,
    extension,
    sourceUrl,
    fallbackUrl,
    fileName,
    kind,
  };
};

const extractMetafileItems = (content: string): ParsedMetafile[] => {
  const text = String(content || '');
  if (!text) {
    return [];
  }

  const entries: ParsedMetafile[] = [];
  const seen = new Set<string>();
  const matches = text.match(METAFILE_URI_REGEX) || [];

  for (const match of matches) {
    const parsed = parseMetafileUri(match);
    if (!parsed || seen.has(parsed.uri)) {
      continue;
    }
    seen.add(parsed.uri);
    entries.push(parsed);
  }

  return entries;
};

export const triggerMetafileDownload = async (item: ParsedMetafile): Promise<void> => {
  const nativeDownload = typeof window !== 'undefined'
    ? window.electron?.cowork?.downloadMetafile
    : undefined;
  if (nativeDownload) {
    const result = await nativeDownload({
      url: item.sourceUrl,
      fallbackUrl: item.fallbackUrl,
      fileName: item.fileName || 'metafile',
    });
    if (!result.success && !result.canceled) {
      console.error('Failed to download metafile:', result.error);
    }
    return;
  }

  if (typeof document === 'undefined') {
    return;
  }
  const link = document.createElement('a');
  link.href = item.sourceUrl;
  link.download = item.fileName || 'metafile';
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  document.body.appendChild(link);
  link.click();
  link.remove();
};

const getMetafileMimeType = (item: ParsedMetafile): string | undefined => {
  return item.extension ? MIME_TYPE_BY_EXTENSION.get(item.extension) : undefined;
};

const normalizeContentType = (contentType: string | null): string | undefined => {
  const normalized = String(contentType || '').split(';')[0]?.trim();
  return normalized || undefined;
};

const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '';
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

export const createMetafileMediaObjectUrl = async (
  item: ParsedMetafile,
  onProgress?: (bytes: number) => void,
): Promise<string> => {
  if (item.kind !== 'video' && item.kind !== 'audio') {
    throw new Error('Only video and audio metafiles can be prepared for media preview');
  }

  const response = await fetch(item.fallbackUrl || item.sourceUrl);
  if (!response.ok) {
    throw new Error(`Preview fetch failed: ${response.status} ${response.statusText}`);
  }

  const mimeType = getMetafileMimeType(item)
    || normalizeContentType(response.headers.get('content-type'))
    || 'application/octet-stream';
  const chunks: BlobPart[] = [];
  let receivedBytes = 0;

  if (response.body?.getReader) {
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value) {
        continue;
      }
      receivedBytes += value.byteLength;
      if (receivedBytes > METAFILE_PREVIEW_MAX_BYTES) {
        throw new Error('Preview file exceeds the 20 MB delivery limit');
      }
      const chunk = new Uint8Array(value.byteLength);
      chunk.set(value);
      chunks.push(chunk.buffer as ArrayBuffer);
      onProgress?.(receivedBytes);
    }
  } else {
    const buffer = await response.arrayBuffer();
    receivedBytes = buffer.byteLength;
    if (receivedBytes > METAFILE_PREVIEW_MAX_BYTES) {
      throw new Error('Preview file exceeds the 20 MB delivery limit');
    }
    chunks.push(buffer);
    onProgress?.(receivedBytes);
  }

  if (receivedBytes <= 0) {
    throw new Error('Preview file is empty');
  }

  const blob = new Blob(chunks, { type: mimeType });
  return URL.createObjectURL(blob);
};

const pickRenderableAvatarSource = (...values: Array<string | null | undefined>): string | null =>
  pickSharedRenderableAvatarSource(...values);

const normalizeA2ABotGlobalMetaId = (value: unknown): string => (
  typeof value === 'string' ? value.trim() : ''
);

const Avatar: React.FC<{
  src?: string | null;
  name?: string | null;
  size?: number;
  browserGlobalMetaId?: string | null;
  onOpenInBrowser?: () => void;
}> = ({
  src,
  name,
  size = 32,
  browserGlobalMetaId,
  onOpenInBrowser,
}) => {
  const image = (
    <img
      src={src || DEFAULT_METABOT_AVATAR}
      alt={name || ''}
      className="h-full w-full rounded-full object-cover"
      onError={(e) => { (e.currentTarget as HTMLImageElement).src = DEFAULT_METABOT_AVATAR; }}
    />
  );

  if (browserGlobalMetaId && onOpenInBrowser) {
    const label = `Open ${name || 'Bot'} in Bot Browser`;
    return (
      <button
        type="button"
        data-browser-global-metaid={browserGlobalMetaId}
        aria-label={label}
        title={label}
        onClick={onOpenInBrowser}
        style={{ width: size, height: size }}
        className="rounded-full flex-shrink-0 overflow-hidden transition-shadow hover:ring-2 hover:ring-claude-accent/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-claude-accent/60"
      >
        {image}
      </button>
    );
  }

  return (
    <img
      src={src || DEFAULT_METABOT_AVATAR}
      alt={name || ''}
      style={{ width: size, height: size }}
      className="rounded-full object-cover flex-shrink-0"
      onError={(e) => { (e.currentTarget as HTMLImageElement).src = DEFAULT_METABOT_AVATAR; }}
    />
  );
};

/** Collapsible tool-call block — collapsed by default, compact single-line header */
const ToolCallBlock: React.FC<{ message: CoworkMessage }> = ({ message }) => {
  const [open, setOpen] = useState(false);
  const toolName = (message.metadata?.toolName as string | undefined) || message.content || 'tool';
  const toolInput = message.metadata?.toolInput;
  const toolResult = message.metadata?.toolResult as string | undefined;

  return (
    <div className="my-0.5 rounded-md border dark:border-claude-darkBorder border-claude-border overflow-hidden text-xs">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-1.5 px-2.5 py-1 dark:bg-claude-darkSurface bg-claude-surface dark:text-claude-darkTextSecondary text-claude-textSecondary hover:opacity-80 transition-opacity text-left"
      >
        {open ? (
          <ChevronDownIcon className="h-3 w-3 flex-shrink-0" />
        ) : (
          <ChevronRightIcon className="h-3 w-3 flex-shrink-0" />
        )}
        <span className="font-mono truncate">{toolName}</span>
      </button>
      {open && (
        <div className="px-3 py-2 dark:bg-claude-darkBg bg-claude-bg space-y-1">
          {toolInput !== undefined && (
            <pre className="whitespace-pre-wrap break-all dark:text-claude-darkTextSecondary text-claude-textSecondary">
              {JSON.stringify(toolInput, null, 2)}
            </pre>
          )}
          {toolResult !== undefined && (
            <pre className="whitespace-pre-wrap break-all dark:text-claude-darkText text-claude-text border-t dark:border-claude-darkBorder border-claude-border pt-1 mt-1">
              {toolResult}
            </pre>
          )}
        </div>
      )}
    </div>
  );
};

const MetafileMediaPreview: React.FC<{ item: ParsedMetafile }> = ({ item }) => {
  const [mediaSourceUrl, setMediaSourceUrl] = useState<string | null>(item.sourceUrl);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('ready');
  const [loadedBytes, setLoadedBytes] = useState(0);
  const objectUrlRef = useRef<string | null>(null);
  const mediaType = getMetafileMimeType(item);

  useEffect(() => {
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }

    setMediaSourceUrl(item.sourceUrl);
    setStatus('ready');
    setLoadedBytes(0);

    return () => {
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = null;
      }
    };
  }, [item.uri, item.kind, item.sourceUrl]);

  const loadFallbackPreview = async () => {
    if (status === 'loading' || mediaSourceUrl !== item.sourceUrl) {
      setStatus('error');
      return;
    }

    setStatus('loading');
    setLoadedBytes(0);
    try {
      const previewUrl = await createMetafileMediaObjectUrl(item, setLoadedBytes);
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
      }
      objectUrlRef.current = previewUrl;
      setMediaSourceUrl(previewUrl);
      setStatus('ready');
    } catch (error) {
      console.error('Failed to load metafile media fallback preview:', error);
      setStatus('error');
    }
  };

  const loadingLabel = item.kind === 'video'
    ? i18nService.t('a2aMediaLoadingVideo')
    : i18nService.t('a2aMediaLoadingAudio');
  const errorLabel = item.kind === 'video'
    ? i18nService.t('a2aMediaLoadFailedVideo')
    : i18nService.t('a2aMediaLoadFailedAudio');
  const progressLabel = formatBytes(loadedBytes);
  const loadedLabel = progressLabel
    ? i18nService.t('a2aMediaLoadedBytes').replace('{size}', progressLabel)
    : '';

  if (item.kind === 'audio') {
    return (
      <>
        <audio
          controls
          preload="auto"
          className="w-full"
          onError={() => { void loadFallbackPreview(); }}
        >
          {mediaSourceUrl && <source src={mediaSourceUrl} type={mediaType} />}
        </audio>
        {status === 'loading' && (
          <div className="mt-1 text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
            {loadingLabel}{loadedLabel ? ` ${loadedLabel}` : ''}
          </div>
        )}
        {status === 'error' && (
          <div className="mt-1 text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
            {errorLabel}
          </div>
        )}
      </>
    );
  }

  return (
    <>
      <video
        controls
        preload="auto"
        playsInline
        className="w-full max-h-80 rounded-md bg-black"
        onError={() => { void loadFallbackPreview(); }}
      >
        {mediaSourceUrl && <source src={mediaSourceUrl} type={mediaType} />}
      </video>
      {status === 'loading' && (
        <div className="mt-1 text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
          {loadingLabel}{loadedLabel ? ` ${loadedLabel}` : ''}
        </div>
      )}
      {status === 'error' && (
        <div className="mt-1 text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
          {errorLabel}
        </div>
      )}
    </>
  );
};

const MetafileImagePreview: React.FC<{ item: ParsedMetafile }> = ({ item }) => {
  const [imageSourceUrl, setImageSourceUrl] = useState(item.sourceUrl);

  useEffect(() => {
    setImageSourceUrl(item.sourceUrl);
  }, [item.uri, item.sourceUrl]);

  return (
    <img
      src={imageSourceUrl}
      alt={item.fileName}
      className="w-full max-h-80 object-contain rounded-md"
      loading="lazy"
      onError={() => {
        if (imageSourceUrl !== item.fallbackUrl) {
          setImageSourceUrl(item.fallbackUrl);
        }
      }}
    />
  );
};

const MetafilePreviewCard: React.FC<{ item: ParsedMetafile }> = ({ item }) => {
  return (
    <div className="rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkBg/40 bg-claude-bg/60 p-2">
      {item.kind === 'image' && (
        <MetafileImagePreview item={item} />
      )}
      {item.kind === 'video' && (
        <MetafileMediaPreview item={item} />
      )}
      {item.kind === 'audio' && (
        <MetafileMediaPreview item={item} />
      )}
      {item.kind === 'download' && (
        <div className="rounded-md border dark:border-claude-darkBorder border-claude-border px-2.5 py-2 text-xs break-all dark:text-claude-darkText text-claude-text dark:bg-claude-darkSurface bg-claude-surface">
          {item.fileName}
        </div>
      )}
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <span className="min-w-0 text-[11px] break-all dark:text-claude-darkTextSecondary text-claude-textSecondary">
          PINID: {item.pinId}
        </span>
        <button
          type="button"
          onClick={() => { void triggerMetafileDownload(item); }}
          className="inline-flex items-center rounded-md border dark:border-claude-darkBorder border-claude-border px-3 py-1.5 text-xs dark:text-claude-darkText text-claude-text hover:opacity-80 transition-opacity"
        >
          {i18nService.t('a2aDownloadFile')}
        </button>
      </div>
    </div>
  );
};

const ResendDigitalDeliveryButton: React.FC<{
  orderTxid: string;
  isResending?: boolean;
  onResend: (orderTxid: string) => void;
}> = ({
  orderTxid,
  isResending = false,
  onResend,
}) => (
  <button
    type="button"
    data-order-txid={orderTxid}
    onClick={() => onResend(orderTxid)}
    disabled={isResending}
    className="mt-1 inline-flex h-7 items-center gap-1 rounded-md border border-blue-500/30 px-2.5 text-[11px] font-medium text-blue-600 transition-colors hover:bg-blue-500/10 disabled:cursor-not-allowed disabled:opacity-60 dark:text-blue-400"
  >
    <ShareIcon className="h-3.5 w-3.5" />
    {isResending ? i18nService.t('a2aResendingDigitalDelivery') : i18nService.t('a2aResendDigitalDelivery')}
  </button>
);

const A2AMessageItem: React.FC<A2AMessageItemProps> = ({
  message,
  peerName,
  peerAvatar,
  metabotName,
  metabotAvatar,
  peerGlobalMetaId,
  localGlobalMetaId,
  invertSides = false,
  onOpenBotInBrowser,
  canResendDigitalDelivery = false,
  isResendingDigitalDelivery = false,
  onResendDigitalDelivery,
  isAssistantMode = false,
  peerIsFriend = false,
  sessionId = undefined,
}) => {
  // tool_use / tool_result: compact collapsible block (collapsed by default)
  if (message.type === 'tool_use' || message.type === 'tool_result') {
    // Assistant mode hides tool-call chrome entirely (render-only filtering).
    if (isAssistantMode) return null;
    return (
      <div className="px-4 py-0.5">
        <ToolCallBlock message={message} />
      </div>
    );
  }

  // system messages: subtle center label
  if (message.type === 'system') {
    return (
      <div className="px-4 py-1 flex justify-center">
        <span className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary italic">
          {message.content}
        </span>
      </div>
    );
  }

  // Thinking messages: internal reasoning, not sent on-chain.
  // Shown as a subtle indented block (no avatar, no bubble) so observers can
  // distinguish it from the actual on-chain reply. Assistant mode hides raw
  // reasoning entirely.
  if (message.metadata?.isThinking) {
    if (isAssistantMode) return null;
    return (
      <div className="px-4 py-1">
        <div className="ml-10 rounded-lg px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap break-words italic dark:text-claude-darkTextSecondary text-claude-textSecondary dark:bg-claude-darkSurface bg-claude-surface border dark:border-claude-darkBorder border-claude-border">
          {message.content}
        </div>
      </div>
    );
  }

  const txid = resolveA2AMessageTxid(message);
  const resendOrderTxid = getA2AMessageOrderTxid(message);
  const shouldRenderResendAction = (
    Boolean(onResendDigitalDelivery)
    && shouldShowA2AResendDigitalDeliveryAction(message, canResendDigitalDelivery)
  );
  const renderResendAction = () => (
    shouldRenderResendAction && onResendDigitalDelivery ? (
      <ResendDigitalDeliveryButton
        orderTxid={resendOrderTxid}
        isResending={isResendingDigitalDelivery}
        onResend={onResendDigitalDelivery}
      />
    ) : null
  );

  if (!txid) {
    // Non-chain fallback rendering. Conversational internal states are filtered
    // out upstream (shouldHideA2AInternalMessage), so only local notices that
    // must stay actionable — e.g. order-flow status with the resend action —
    // reach this branch. Rendered as a plain notice without any bubble chrome.
    const internalContent = stripOrderProtocolTag(message.content);
    return (
      <div className="px-4 py-1 flex justify-center">
        <div className="max-w-[76%] px-3 py-1.5 text-xs leading-relaxed whitespace-pre-wrap break-words dark:text-claude-darkTextSecondary text-claude-textSecondary">
          <div>{internalContent}</div>
          {renderResendAction()}
          <div className="mt-0.5 text-[10px] opacity-70">{formatTime(message.timestamp)}</div>
        </div>
      </div>
    );
  }

  // user = incoming from peer MetaBot (left side)
  // assistant = outgoing from local MetaBot (right side)
  // direction in metadata takes priority over type for display direction
  const isLocal = message.metadata?.direction !== undefined
    ? message.metadata.direction === 'outgoing'
    : message.type === 'assistant';
  // Layout side: normally the local bot reads on the right. When the peer is
  // the local human owner (invertSides), the sides flip so the owner's
  // messages read on the right. Sender identity (name/avatar below) stays
  // keyed on isLocal either way.
  const displayRight = invertSides ? !isLocal : isLocal;

  // Resolve display name and avatar.
  // For local sender: always use the session-level metabotName/metabotAvatar — never
  // message.metadata.senderAvatar, which stores the *peer's* avatar for incoming messages.
  // For peer sender: prefer the session-level peerName/peerAvatar over the message-level
  // senderName/senderAvatar snapshot. Session-level values are refreshed from the peer's
  // latest on-chain profile (a2aPeerProfileRefresh, triggered on session open and on
  // incoming messages), whereas senderName/senderAvatar are captured once from the socket
  // payload at ingest time — they lag behind a peer rename and the indexer may resolve
  // historical names. Name and avatar share the same precedence; the snapshot is only a
  // fallback (senderAvatar is the raw MetaWeb value, possibly an unresolved metafile:// URL).
  const fromName = isLocal
    ? (metabotName || 'MetaBot')
    : ((peerName || (message.metadata?.senderName as string | undefined)) || 'Peer');
  const senderAvatar = message.metadata?.senderAvatar as string | undefined;
  const fromAvatar = isLocal
    ? pickRenderableAvatarSource(metabotAvatar)
    : pickRenderableAvatarSource(peerAvatar, senderAvatar);
  const fromGlobalMetaId = isLocal
    ? normalizeA2ABotGlobalMetaId(localGlobalMetaId)
    : (
      normalizeA2ABotGlobalMetaId(message.metadata?.senderGlobalMetaId)
      || normalizeA2ABotGlobalMetaId(peerGlobalMetaId)
    );
  const handleOpenSenderInBrowser = fromGlobalMetaId && onOpenBotInBrowser
    ? () => onOpenBotInBrowser({
      globalMetaId: fromGlobalMetaId,
      name: fromName,
      avatar: fromAvatar,
    })
    : undefined;
  const deliveryPayload = parseDeliveryPayload(message.content);
  const deliveryResult = typeof deliveryPayload?.result === 'string'
    ? deliveryPayload.result.trim()
    : '';
  const shouldRenderDeliveryResult = deliveryResult.length > 0;
  const contentToRender = shouldRenderDeliveryResult
    ? deliveryResult
    : stripOrderProtocolTag(message.content);
  // S4 chat trade marker: the message announces an NFT trade (nft-card
  // fence with a trade action) → a trade chip rides the meta row, same
  // family as the session-list trade icon. The p2p chip needs a hostStamp
  // bound to THIS A2A session (source-signing slice).
  const tradeActivity = detectTradeActivity(contentToRender, { sessionId });
  const metafileItems = extractMetafileItems(contentToRender);
  const markdownClassName = messengerMarkdownClassName(displayRight);
  const txidPreview = formatA2ATxidPreview(txid);

  return (
    <div className={messengerRowClassName(displayRight)}>
      <Avatar
        src={fromAvatar}
        name={fromName}
        size={32}
        browserGlobalMetaId={fromGlobalMetaId}
        onOpenInBrowser={handleOpenSenderInBrowser}
      />
      <div className={messengerColumnClassName(displayRight)}>
        <span className={messengerNameClassName}>
          {fromName}
          {peerIsFriend && !isLocal && <FriendBadge className="ml-1 align-middle" />}
        </span>
        {/* data-message-id mounts the innermost transcript anchor: the turn
            navigator scrolls to the outermost same-id wrapper (the row, set in
            CoworkSessionDetail's A2A branch) but rings the innermost one, so
            the highlight hugs the bubble instead of drawing a rule across the
            full row width. */}
        <div className={messengerBubbleClassName(displayRight)} data-message-id={message.id}>
          {/* Display-time WeChat bracket-code mapping; the raw message
              (copy, delivery parsing, chain data) is untouched. emojiImages:
              catalog emoji render as bundled Twemoji artwork (display-only). */}
          <MarkdownContent content={mapWechatBracketCodesForDisplay(contentToRender)} className={markdownClassName} emojiImages />
        </div>
        {metafileItems.length > 0 && (
          <div className="w-full mt-2 space-y-2">
            {metafileItems.map((item, index) => (
              <MetafilePreviewCard key={`${item.uri}-${index}`} item={item} />
            ))}
          </div>
        )}
        {txidPreview ? (
          // Meta row: time and txid share one line (two-space gap via gap-1 +
          // ml-1); formats unchanged, copy button stays beside the txid.
          <div className={messengerTxidRowClassName(displayRight)}>
            {tradeActivity && <TradeActivityBadge kind={tradeActivity.kind} variant="chip" />}
            <span>{formatTime(message.timestamp)}</span>
            <span className="ml-1 font-mono">txid: {txidPreview}</span>
            <button
              type="button"
              onClick={() => copyTextToClipboard(txid)}
              className="inline-flex h-4 w-4 items-center justify-center rounded text-current hover:bg-black/10 dark:hover:bg-white/10"
              title="Copy txid"
              aria-label="Copy txid"
            >
              <DocumentDuplicateIcon className="h-3 w-3" />
            </button>
          </div>
        ) : (
          <span className={messengerMetaClassName}>
            {tradeActivity && (
              // Trade chip on the bare-time meta row (same slot, no txid).
              <TradeActivityBadge kind={tradeActivity.kind} variant="chip" className="mr-1" />
            )}
            {formatTime(message.timestamp)}
          </span>
        )}
        {renderResendAction()}
      </div>
    </div>
  );
};

export default A2AMessageItem;
