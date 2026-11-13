import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CoworkMessage } from '../../types/cowork';
import {
  ArrowDownTrayIcon,
  ArrowsPointingOutIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  DocumentDuplicateIcon,
  DocumentIcon,
  ShareIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import { getDefaultMetabotAvatarUrl } from '../../utils/rendererAssetPaths';
import { pickRenderableAvatarSource as pickSharedRenderableAvatarSource } from '../../utils/avatarSource';
import NftAvatarFrame from '../metabots/NftAvatarFrame';
import { parseNftAvatarReference } from '../metabots/nftAvatarPresentation.js';
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
  return String(candidate || '')
    .trim()
    .replace(/^[(<《【\[（]+/, '')
    .replace(/[),.;:!?，。；：！？）》】\]]+$/, '');
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
const METAID_FILE_INFO_BASE = 'https://file.metaid.io/metafile-indexer/api/v1/files';
const STRICT_METAFILE_PIN_ID_RE = /^[0-9a-f]{64}i0$/i;
const COMPAT_METAFILE_ID_RE = /^(?:[0-9a-f]{64}i\d+|[0-9a-f]{64})$/i;
const METAFILE_EXTRACT_RE = /metafile:\/\/([0-9a-f]{64}i0)(?:\.([a-z0-9]{1,16})(?![a-z0-9]))?(?![0-9a-z])/gi;
const NFT_CARD_FENCE_STRIP_RE = /```(?:nft-card-group|nft-collection-card|nft-card|nftcard|nft)\b[\s\S]*?```/gi;
const METAFILE_PREVIEW_MAX_BYTES = 20 * 1024 * 1024;
const METAFILE_METADATA_CACHE_MAX = 500;

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.gif', '.png', '.webp', '.bmp', '.svg', '.avif', '.ico']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.mov', '.m4v']);
const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.flac', '.ogg', '.m4a', '.aac', '.opus']);
const OTHER_KNOWN_EXTENSIONS = new Set([
  '.zip', '.7z', '.rar', '.tar', '.gz', '.tgz', '.bz2', '.xz',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.txt', '.md', '.csv', '.json', '.xml', '.html', '.htm',
  '.apk', '.ipa', '.dmg', '.pkg', '.exe', '.wasm', '.bin',
]);
const KNOWN_METAFILE_EXTENSIONS = new Set([
  ...IMAGE_EXTENSIONS,
  ...VIDEO_EXTENSIONS,
  ...AUDIO_EXTENSIONS,
  ...OTHER_KNOWN_EXTENSIONS,
]);
const MIME_TYPE_BY_EXTENSION = new Map<string, string>([
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
  ['.bmp', 'image/bmp'],
  ['.svg', 'image/svg+xml'],
  ['.avif', 'image/avif'],
  ['.ico', 'image/x-icon'],
  ['.mp4', 'video/mp4'],
  ['.webm', 'video/webm'],
  ['.mov', 'video/quicktime'],
  ['.m4v', 'video/x-m4v'],
  ['.mp3', 'audio/mpeg'],
  ['.wav', 'audio/wav'],
  ['.flac', 'audio/flac'],
  ['.ogg', 'audio/ogg'],
  ['.m4a', 'audio/mp4'],
  ['.aac', 'audio/aac'],
  ['.opus', 'audio/opus'],
]);
const EXTENSION_BY_MIME_TYPE = new Map<string, string>([
  ['image/jpeg', '.jpg'],
  ['image/jpg', '.jpg'],
  ['image/gif', '.gif'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
  ['image/bmp', '.bmp'],
  ['image/svg+xml', '.svg'],
  ['image/avif', '.avif'],
  ['image/x-icon', '.ico'],
  ['video/mp4', '.mp4'],
  ['video/webm', '.webm'],
  ['video/quicktime', '.mov'],
  ['video/x-m4v', '.m4v'],
  ['audio/mpeg', '.mp3'],
  ['audio/mp3', '.mp3'],
  ['audio/wav', '.wav'],
  ['audio/x-wav', '.wav'],
  ['audio/flac', '.flac'],
  ['audio/ogg', '.ogg'],
  ['audio/mp4', '.m4a'],
  ['audio/aac', '.aac'],
  ['audio/opus', '.opus'],
  ['application/zip', '.zip'],
  ['application/x-zip-compressed', '.zip'],
  ['application/pdf', '.pdf'],
  ['application/json', '.json'],
  ['text/plain', '.txt'],
  ['text/markdown', '.md'],
  ['text/html', '.html'],
]);

type DeliveryPayload = {
  result?: string;
};

export type MetafilePreviewKind = 'image' | 'video' | 'audio' | 'download';

export type ParsedMetafile = {
  uri: string;
  pinId: string;
  extension: string | null;
  mimeType?: string;
  fileSize?: number;
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

export const isStrictMetafilePinId = (value: string): boolean => (
  STRICT_METAFILE_PIN_ID_RE.test(String(value || '').trim())
);

const classifyMetafileKind = (
  extension: string | null,
  mimeType?: string,
  fileTypeHint?: string,
): MetafilePreviewKind => {
  const normalizedExt = extension ? extension.toLowerCase() : null;
  const normalizedMime = mimeType ? mimeType.toLowerCase() : '';
  const normalizedHint = fileTypeHint ? fileTypeHint.toLowerCase() : '';
  if (
    (normalizedExt && IMAGE_EXTENSIONS.has(normalizedExt))
    || normalizedMime.startsWith('image/')
    || normalizedHint === 'image'
  ) {
    return 'image';
  }
  if (
    (normalizedExt && VIDEO_EXTENSIONS.has(normalizedExt))
    || normalizedMime.startsWith('video/')
    || normalizedHint === 'video'
  ) {
    return 'video';
  }
  if (
    (normalizedExt && AUDIO_EXTENSIONS.has(normalizedExt))
    || normalizedMime.startsWith('audio/')
    || normalizedHint === 'audio'
  ) {
    return 'audio';
  }
  return 'download';
};

export const parseMetafileUri = (
  rawUri: string,
  options?: { strictPinId?: boolean },
): ParsedMetafile | null => {
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
  const candidateExt = hasExtension ? `.${basePart.slice(lastDotIndex + 1).toLowerCase()}` : null;
  const validExtension = candidateExt && KNOWN_METAFILE_EXTENSIONS.has(candidateExt) ? candidateExt : null;
  const pinId = validExtension
    ? basePart.slice(0, lastDotIndex)
    : (hasExtension ? '' : basePart);

  if (!pinId) {
    return null;
  }

  const idPattern = options?.strictPinId ? STRICT_METAFILE_PIN_ID_RE : COMPAT_METAFILE_ID_RE;
  if (!idPattern.test(pinId)) {
    return null;
  }

  const normalizedPinId = pinId.toLowerCase();
  const mimeType = validExtension ? MIME_TYPE_BY_EXTENSION.get(validExtension) : undefined;
  const kind = classifyMetafileKind(validExtension, mimeType);
  const encodedPinId = encodeURIComponent(normalizedPinId);
  const sourceUrl = `${METAID_ACCELERATE_CONTENT_BASE}/${encodedPinId}`;
  const fallbackUrl = `${METAID_CONTENT_BASE}/${encodedPinId}`;
  const fileName = validExtension ? `${normalizedPinId}${validExtension}` : normalizedPinId;
  const canonicalUri = `metafile://${normalizedPinId}${validExtension ?? ''}`;

  return {
    uri: canonicalUri,
    pinId: normalizedPinId,
    extension: validExtension,
    mimeType,
    sourceUrl,
    fallbackUrl,
    fileName,
    kind,
  };
};

export const extractMetafileItems = (content: string): ParsedMetafile[] => {
  const text = String(content || '');
  if (!text) {
    return [];
  }

  const strippedText = text.replace(NFT_CARD_FENCE_STRIP_RE, '\n');
  const entries: ParsedMetafile[] = [];
  const indexByPinId = new Map<string, number>();
  METAFILE_EXTRACT_RE.lastIndex = 0;

  for (const match of strippedText.matchAll(METAFILE_EXTRACT_RE)) {
    const rawPinId = match[1] || '';
    const rawExt = match[2] ? `.${match[2].toLowerCase()}` : null;
    const validExt = rawExt && KNOWN_METAFILE_EXTENSIONS.has(rawExt) ? rawExt : null;
    const candidateUri = `metafile://${rawPinId}${validExt ?? ''}`;
    const parsed = parseMetafileUri(candidateUri, { strictPinId: true });
    if (!parsed) {
      continue;
    }
    const existingIndex = indexByPinId.get(parsed.pinId);
    if (existingIndex !== undefined) {
      if (!entries[existingIndex]!.extension && parsed.extension) {
        entries[existingIndex] = parsed;
      }
      continue;
    }
    indexByPinId.set(parsed.pinId, entries.length);
    entries.push(parsed);
  }

  return entries;
};

const resolvedMetafileCache = new Map<string, ParsedMetafile>();
const inFlightMetafileResolutions = new Map<string, Promise<ParsedMetafile>>();

export const resetMetafileMetadataCacheForTests = (): void => {
  resolvedMetafileCache.clear();
  inFlightMetafileResolutions.clear();
};

const rememberResolvedMetafile = (pinId: string, value: ParsedMetafile): void => {
  if (resolvedMetafileCache.size >= METAFILE_METADATA_CACHE_MAX) {
    const oldest = resolvedMetafileCache.keys().next().value;
    if (oldest) resolvedMetafileCache.delete(oldest);
  }
  resolvedMetafileCache.set(pinId.toLowerCase(), value);
};

const sanitizeServerFileName = (rawName: unknown, pinId: string, ext: string | null): string => {
  const leaf = String(rawName || '')
    .split(/[\\/]/)
    .pop()
    ?.replace(/[\u0000-\u001f<>:"|?*]+/g, '')
    .trim() || '';
  if (leaf) {
    if (ext && !leaf.toLowerCase().endsWith(ext.toLowerCase())) {
      return `${leaf}${ext}`;
    }
    return leaf;
  }
  return ext ? `${pinId}${ext}` : pinId;
};

export const resolveMetafileMetadata = async (
  item: ParsedMetafile,
  fetchImpl?: typeof fetch,
): Promise<ParsedMetafile> => {
  if (item.extension) {
    return item;
  }
  const cacheKey = item.pinId.toLowerCase();
  const cached = resolvedMetafileCache.get(cacheKey);
  if (cached) {
    return cached;
  }
  const existingPromise = inFlightMetafileResolutions.get(cacheKey);
  if (existingPromise) {
    return existingPromise;
  }

  const doFetch = fetchImpl ?? (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : undefined);
  if (!doFetch) {
    return item;
  }

  const promise = (async (): Promise<ParsedMetafile> => {
    // 1. Lightweight indexer metadata lookup (~200B JSON, no file payload transfer).
    try {
      const infoUrl = `${METAID_FILE_INFO_BASE}/${encodeURIComponent(item.pinId)}`;
      const infoRes = await doFetch(infoUrl);
      if (infoRes.ok) {
        const json = await infoRes.json() as {
          code?: number;
          data?: {
            content_type?: string;
            file_type?: string;
            file_extension?: string;
            file_name?: string;
            file_size?: number;
          };
        };
        const data = json?.data;
        if (data && typeof data === 'object') {
          const mimeType = normalizeContentType(data.content_type ?? null);
          const rawExt = typeof data.file_extension === 'string' ? data.file_extension.trim().toLowerCase() : '';
          const normalizedExt = rawExt
            ? (rawExt.startsWith('.') ? rawExt : `.${rawExt}`)
            : (mimeType ? EXTENSION_BY_MIME_TYPE.get(mimeType.toLowerCase()) ?? null : null);
          const validExt = normalizedExt && KNOWN_METAFILE_EXTENSIONS.has(normalizedExt)
            ? normalizedExt
            : (mimeType ? EXTENSION_BY_MIME_TYPE.get(mimeType.toLowerCase()) ?? null : null);
          const kind = classifyMetafileKind(validExt, mimeType, data.file_type);
          const fileSize = typeof data.file_size === 'number' && Number.isFinite(data.file_size) && data.file_size > 0
            ? data.file_size
            : undefined;
          const resolved: ParsedMetafile = {
            ...item,
            extension: validExt,
            mimeType: mimeType || (validExt ? MIME_TYPE_BY_EXTENSION.get(validExt) : undefined),
            fileSize,
            fileName: sanitizeServerFileName(data.file_name, item.pinId, validExt),
            kind,
          };
          rememberResolvedMetafile(cacheKey, resolved);
          return resolved;
        }
      }
    } catch {
      // Fall back to HEAD probing below.
    }

    // 2. Fallback HEAD probe against accelerate / content endpoints.
    for (const probeUrl of [item.sourceUrl, item.fallbackUrl]) {
      try {
        const headRes = await doFetch(probeUrl, { method: 'HEAD' });
        if (!headRes.ok) continue;
        const mimeType = normalizeContentType(headRes.headers?.get?.('content-type') ?? null);
        if (!mimeType) continue;
        const inferredExt = EXTENSION_BY_MIME_TYPE.get(mimeType.toLowerCase()) ?? null;
        const rawLen = Number(headRes.headers?.get?.('content-length') || '');
        const fileSize = Number.isFinite(rawLen) && rawLen > 0 ? rawLen : undefined;
        const kind = classifyMetafileKind(inferredExt, mimeType);
        const resolved: ParsedMetafile = {
          ...item,
          extension: inferredExt,
          mimeType,
          fileSize,
          fileName: inferredExt ? `${item.pinId}${inferredExt}` : item.pinId,
          kind,
        };
        rememberResolvedMetafile(cacheKey, resolved);
        return resolved;
      } catch {
        // Try next candidate URL.
      }
    }

    return item;
  })().finally(() => {
    inFlightMetafileResolutions.delete(cacheKey);
  });

  inFlightMetafileResolutions.set(cacheKey, promise);
  return promise;
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
  if (item.mimeType) return item.mimeType;
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
    <NftAvatarFrame
      avatar={src}
      frameClassName="h-full w-full rounded-full"
      fallback={(
        <img
          src={DEFAULT_METABOT_AVATAR}
          alt={name || ''}
          className="h-full w-full rounded-full object-cover"
        />
      )}
      alt={name || ''}
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
        className="rounded-full flex-shrink-0 transition-shadow hover:ring-2 hover:ring-claude-accent/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-claude-accent/60"
      >
        {image}
      </button>
    );
  }

  return (
    <span style={{ width: size, height: size }} className="relative block flex-shrink-0">
      {image}
    </span>
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

const MetafileMediaPreview: React.FC<{
  item: ParsedMetafile;
  compact?: boolean;
  onZoom?: () => void;
}> = ({ item, compact = true, onZoom }) => {
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
      <div className="flex h-32 flex-col justify-center rounded-lg bg-black/5 px-2 dark:bg-white/5">
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
      </div>
    );
  }

  return (
    <div className="group relative">
      <video
        controls
        preload="auto"
        playsInline
        className={compact
          ? 'h-32 w-full rounded-lg bg-black object-contain'
          : 'max-h-[80vh] max-w-[90vw] rounded-lg bg-black object-contain'}
        onError={() => { void loadFallbackPreview(); }}
      >
        {mediaSourceUrl && <source src={mediaSourceUrl} type={mediaType} />}
      </video>
      {compact && onZoom && (
        <button
          type="button"
          onClick={onZoom}
          title={i18nService.t('a2aZoomPreview')}
          aria-label={i18nService.t('a2aZoomPreview')}
          data-metafile-zoom="video"
          className="absolute right-1.5 top-1.5 inline-flex h-6 w-6 items-center justify-center rounded-md bg-black/65 text-white opacity-85 transition-opacity hover:bg-black/85 hover:opacity-100"
        >
          <ArrowsPointingOutIcon className="h-3.5 w-3.5" />
        </button>
      )}
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
    </div>
  );
};

const MetafileImagePreview: React.FC<{
  item: ParsedMetafile;
  compact?: boolean;
  onZoom?: () => void;
}> = ({ item, compact = true, onZoom }) => {
  const [imageSourceUrl, setImageSourceUrl] = useState(item.sourceUrl);

  useEffect(() => {
    setImageSourceUrl(item.sourceUrl);
  }, [item.uri, item.sourceUrl]);

  const imgElement = (
    <img
      src={imageSourceUrl}
      alt={item.fileName}
      className={compact
        ? 'h-32 w-full rounded-lg bg-black/5 object-cover transition-transform duration-150 group-hover:scale-[1.02] dark:bg-white/5'
        : 'max-h-[82vh] max-w-[92vw] rounded-lg object-contain select-none'}
      loading="lazy"
      onError={() => {
        if (imageSourceUrl !== item.fallbackUrl) {
          setImageSourceUrl(item.fallbackUrl);
        }
      }}
    />
  );

  if (!compact || !onZoom) {
    return imgElement;
  }

  return (
    <div className="group relative overflow-hidden rounded-lg">
      <button
        type="button"
        onClick={onZoom}
        title={i18nService.t('a2aZoomPreview')}
        aria-label={i18nService.t('a2aZoomPreview')}
        data-metafile-zoom="image"
        className="block w-full cursor-zoom-in focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-claude-accent/60"
      >
        {imgElement}
      </button>
      <button
        type="button"
        onClick={onZoom}
        title={i18nService.t('a2aZoomPreview')}
        aria-label={i18nService.t('a2aZoomPreview')}
        className="pointer-events-none absolute right-1.5 top-1.5 inline-flex h-6 w-6 items-center justify-center rounded-md bg-black/60 text-white opacity-80 transition-opacity group-hover:opacity-100"
      >
        <ArrowsPointingOutIcon className="h-3.5 w-3.5" />
      </button>
    </div>
  );
};

const MetafileLightboxModal: React.FC<{
  items: ParsedMetafile[];
  activeIndex: number;
  onChangeIndex: (index: number) => void;
  onClose: () => void;
}> = ({ items, activeIndex, onChangeIndex, onClose }) => {
  const item = items[activeIndex];
  const hasMultiple = items.length > 1;

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      } else if (hasMultiple && event.key === 'ArrowLeft') {
        event.preventDefault();
        onChangeIndex((activeIndex - 1 + items.length) % items.length);
      } else if (hasMultiple && event.key === 'ArrowRight') {
        event.preventDefault();
        onChangeIndex((activeIndex + 1) % items.length);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeIndex, hasMultiple, items.length, onChangeIndex, onClose]);

  if (!item || typeof document === 'undefined' || !document.body) {
    return null;
  }

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      data-metafile-lightbox="true"
      onClick={onClose}
      className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black/85 p-4 backdrop-blur-xs"
    >
      <div className="absolute right-4 top-4 flex items-center gap-2">
        {hasMultiple && (
          <span className="rounded-full bg-white/15 px-2.5 py-1 font-mono text-xs text-white">
            {activeIndex + 1} / {items.length}
          </span>
        )}
        <button
          type="button"
          onClick={onClose}
          title={i18nService.t('a2aClosePreview')}
          aria-label={i18nService.t('a2aClosePreview')}
          className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-white/15 text-white transition-colors hover:bg-white/25"
        >
          <XMarkIcon className="h-5 w-5" />
        </button>
      </div>

      {hasMultiple && (
        <>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onChangeIndex((activeIndex - 1 + items.length) % items.length);
            }}
            title={i18nService.t('a2aPrevPreview')}
            aria-label={i18nService.t('a2aPrevPreview')}
            className="absolute left-4 top-1/2 -translate-y-1/2 inline-flex h-10 w-10 items-center justify-center rounded-full bg-white/15 text-white transition-colors hover:bg-white/25"
          >
            <ChevronLeftIcon className="h-5 w-5" />
          </button>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onChangeIndex((activeIndex + 1) % items.length);
            }}
            title={i18nService.t('a2aNextPreview')}
            aria-label={i18nService.t('a2aNextPreview')}
            className="absolute right-4 top-1/2 -translate-y-1/2 inline-flex h-10 w-10 items-center justify-center rounded-full bg-white/15 text-white transition-colors hover:bg-white/25"
          >
            <ChevronRightIcon className="h-5 w-5" />
          </button>
        </>
      )}

      <div
        onClick={(event) => event.stopPropagation()}
        className="flex max-h-[84vh] max-w-[92vw] items-center justify-center"
      >
        {item.kind === 'image' ? (
          <MetafileImagePreview item={item} compact={false} />
        ) : (
          <MetafileMediaPreview item={item} compact={false} />
        )}
      </div>

      <div
        onClick={(event) => event.stopPropagation()}
        className="mt-3 flex max-w-[92vw] flex-wrap items-center justify-center gap-3 rounded-xl bg-white/10 px-3.5 py-2 text-xs text-white"
      >
        <span className="max-w-[50vw] truncate font-mono opacity-90" title={item.pinId}>
          PINID: {item.pinId}
        </span>
        <button
          type="button"
          onClick={() => copyTextToClipboard(item.pinId)}
          title={i18nService.t('a2aCopyPinId')}
          aria-label={i18nService.t('a2aCopyPinId')}
          className="inline-flex h-6 w-6 items-center justify-center rounded bg-white/10 hover:bg-white/20"
        >
          <DocumentDuplicateIcon className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => { void triggerMetafileDownload(item); }}
          className="inline-flex items-center gap-1 rounded-md bg-white/20 px-3 py-1 text-xs font-medium text-white transition-colors hover:bg-white/30"
        >
          <ArrowDownTrayIcon className="h-3.5 w-3.5" />
          {i18nService.t('a2aDownloadFile')}
        </button>
      </div>
    </div>,
    document.body,
  );
};

const MetafilePreviewCard: React.FC<{
  item: ParsedMetafile;
  onOpenLightbox?: (resolvedItem: ParsedMetafile) => void;
  onResolved?: (resolvedItem: ParsedMetafile) => void;
}> = ({ item, onOpenLightbox, onResolved }) => {
  const [resolvedItem, setResolvedItem] = useState<ParsedMetafile>(
    () => resolvedMetafileCache.get(item.pinId.toLowerCase()) ?? item,
  );

  useEffect(() => {
    let cancelled = false;
    const cached = resolvedMetafileCache.get(item.pinId.toLowerCase());
    if (cached) {
      setResolvedItem(cached);
      onResolved?.(cached);
      return () => { cancelled = true; };
    }
    setResolvedItem(item);
    if (!item.extension) {
      void resolveMetafileMetadata(item).then((next) => {
        if (cancelled) return;
        setResolvedItem(next);
        if (next !== item) {
          onResolved?.(next);
        }
      });
    }
    return () => {
      cancelled = true;
    };
  }, [item.uri, item.pinId, item.extension]);

  const isZoomable = resolvedItem.kind === 'image' || resolvedItem.kind === 'video';
  const handleZoom = isZoomable && onOpenLightbox
    ? () => onOpenLightbox(resolvedItem)
    : undefined;
  const extBadge = resolvedItem.extension
    ? resolvedItem.extension.slice(1).toUpperCase()
    : 'FILE';
  const sizeLabel = resolvedItem.fileSize ? formatBytes(resolvedItem.fileSize) : '';
  const cardWidthClass = resolvedItem.kind === 'audio'
    ? 'w-60 max-w-full'
    : 'w-48 sm:w-52 max-w-full';

  return (
    <div
      data-metafile-card={resolvedItem.pinId}
      data-metafile-kind={resolvedItem.kind}
      className={`${cardWidthClass} flex flex-col justify-between rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkBg/40 bg-claude-bg/60 p-2`}
    >
      {resolvedItem.kind === 'image' && (
        <MetafileImagePreview item={resolvedItem} compact onZoom={handleZoom} />
      )}
      {resolvedItem.kind === 'video' && (
        <MetafileMediaPreview item={resolvedItem} compact onZoom={handleZoom} />
      )}
      {resolvedItem.kind === 'audio' && (
        <MetafileMediaPreview item={resolvedItem} compact />
      )}
      {resolvedItem.kind === 'download' && (
        <div className="flex h-32 flex-col items-center justify-center gap-1.5 rounded-lg border dark:border-claude-darkBorder border-claude-border px-2.5 py-2 text-center dark:bg-claude-darkSurface bg-claude-surface">
          <div className="inline-flex items-center gap-1 rounded-md bg-claude-accent/10 px-2 py-0.5 font-mono text-[10px] font-semibold text-claude-accent">
            <DocumentIcon className="h-3.5 w-3.5" />
            <span>{extBadge}</span>
          </div>
          <div
            className="w-full truncate px-1 text-[11px] dark:text-claude-darkText text-claude-text"
            title={resolvedItem.fileName}
          >
            {resolvedItem.fileName}
          </div>
          {sizeLabel && (
            <div className="text-[10px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
              {sizeLabel}
            </div>
          )}
        </div>
      )}
      <div className="mt-2 flex items-center justify-between gap-1.5">
        <span
          className="min-w-0 flex-1 truncate font-mono text-[10px] dark:text-claude-darkTextSecondary text-claude-textSecondary"
          title={`PINID: ${resolvedItem.pinId}`}
        >
          PINID: {resolvedItem.pinId}
        </span>
        <div className="flex shrink-0 items-center gap-1">
          {isZoomable && handleZoom && (
            <button
              type="button"
              onClick={handleZoom}
              title={i18nService.t('a2aZoomPreview')}
              aria-label={i18nService.t('a2aZoomPreview')}
              className="inline-flex h-6 w-6 items-center justify-center rounded-md border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text hover:opacity-80 transition-opacity"
            >
              <ArrowsPointingOutIcon className="h-3.5 w-3.5" />
            </button>
          )}
          <button
            type="button"
            onClick={() => { void triggerMetafileDownload(resolvedItem); }}
            className="inline-flex items-center gap-1 rounded-md border dark:border-claude-darkBorder border-claude-border px-2 py-1 text-[11px] dark:text-claude-darkText text-claude-text hover:opacity-80 transition-opacity"
          >
            <ArrowDownTrayIcon className="h-3 w-3" />
            {i18nService.t('a2aDownloadFile')}
          </button>
        </div>
      </div>
    </div>
  );
};

const MetafileGallery: React.FC<{
  items: ParsedMetafile[];
  alignEnd: boolean;
}> = ({ items, alignEnd }) => {
  const [resolvedMap, setResolvedMap] = useState<Record<string, ParsedMetafile>>({});
  const [lightboxPinId, setLightboxPinId] = useState<string | null>(null);

  const mergedItems = items.map((item) => (
    resolvedMap[item.pinId] ?? resolvedMetafileCache.get(item.pinId) ?? item
  ));
  const zoomableItems = mergedItems.filter((entry) => entry.kind === 'image' || entry.kind === 'video');
  const activeLightboxIndex = lightboxPinId
    ? zoomableItems.findIndex((entry) => entry.pinId === lightboxPinId)
    : -1;

  return (
    <>
      <div
        data-metafile-gallery="true"
        className={`mt-2 flex max-w-full flex-wrap gap-2 ${alignEnd ? 'justify-end' : 'justify-start'}`}
      >
        {items.map((item, index) => (
          <MetafilePreviewCard
            key={`${item.pinId}-${index}`}
            item={item}
            onResolved={(resolved) => {
              setResolvedMap((prev) => (
                prev[resolved.pinId] === resolved ? prev : { ...prev, [resolved.pinId]: resolved }
              ));
            }}
            onOpenLightbox={(target) => {
              setResolvedMap((prev) => (
                prev[target.pinId] === target ? prev : { ...prev, [target.pinId]: target }
              ));
              setLightboxPinId(target.pinId);
            }}
          />
        ))}
      </div>
      {activeLightboxIndex >= 0 && (
        <MetafileLightboxModal
          items={zoomableItems}
          activeIndex={activeLightboxIndex}
          onChangeIndex={(nextIdx) => {
            const next = zoomableItems[nextIdx];
            if (next) setLightboxPinId(next.pinId);
          }}
          onClose={() => setLightboxPinId(null)}
        />
      )}
    </>
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
  const rawFromAvatar = isLocal ? metabotAvatar : (peerAvatar || senderAvatar);
  const fromAvatar = parseNftAvatarReference(rawFromAvatar)
    ? rawFromAvatar
    : isLocal
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
          <MetafileGallery items={metafileItems} alignEnd={displayRight} />
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
