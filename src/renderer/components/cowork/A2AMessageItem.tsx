import React, { useEffect, useState } from 'react';
import type { CoworkMessage } from '../../types/cowork';
import { ChevronDownIcon, ChevronRightIcon } from '@heroicons/react/24/outline';
import { getDefaultMetabotAvatarUrl } from '../../utils/rendererAssetPaths';
import MarkdownContent from '../MarkdownContent';

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
}

const formatTime = (timestamp: number): string => {
  const d = new Date(timestamp);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
};

const DEFAULT_METABOT_AVATAR = getDefaultMetabotAvatarUrl();
const DELIVERY_PREFIX = '[DELIVERY]';
const METAID_CONTENT_BASE = 'https://file.metaid.io/metafile-indexer/api/v1/files/content';
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
  fileName: string;
  kind: MetafilePreviewKind;
};

const parseDeliveryPayload = (content: string): DeliveryPayload | null => {
  const trimmed = String(content || '').trim();
  if (!trimmed.startsWith(DELIVERY_PREFIX)) {
    return null;
  }

  const jsonPart = trimmed.slice(DELIVERY_PREFIX.length).trim();
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

const normalizeMetafileCandidate = (candidate: string): string => {
  return String(candidate || '').trim().replace(/[),.;:!?]+$/, '');
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

  const sourceUrl = `${METAID_CONTENT_BASE}/${encodeURIComponent(pinId)}`;
  const fileName = extension ? `${pinId}${extension}` : pinId;

  return {
    uri: normalizedUri,
    pinId,
    extension,
    sourceUrl,
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

  const response = await fetch(item.sourceUrl);
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

const isRenderableAvatarSource = (value: string | null | undefined): boolean => {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized.startsWith('data:')
    || normalized.startsWith('http://')
    || normalized.startsWith('https://')
    || normalized.startsWith('blob:');
};

const Avatar: React.FC<{ src?: string | null; name?: string | null; size?: number }> = ({
  src,
  name,
  size = 32,
}) => (
  <img
    src={src || DEFAULT_METABOT_AVATAR}
    alt={name || ''}
    style={{ width: size, height: size }}
    className="rounded-full object-cover flex-shrink-0"
    onError={(e) => { (e.currentTarget as HTMLImageElement).src = DEFAULT_METABOT_AVATAR; }}
  />
);

const getA2AMarkdownClassName = (isLocal: boolean): string => {
  return isLocal
    ? 'max-w-none whitespace-normal break-words text-white [&_a]:text-inherit [&_a]:underline [&_h1]:my-0 [&_h1]:text-inherit [&_h2]:my-0 [&_h2]:text-inherit [&_h3]:my-0 [&_h3]:text-inherit [&_h4]:my-0 [&_h4]:text-inherit [&_h5]:my-0 [&_h5]:text-inherit [&_h6]:my-0 [&_h6]:text-inherit [&_p]:my-0 [&_p]:text-inherit [&_ul]:my-1 [&_ul]:text-inherit [&_ol]:my-1 [&_ol]:text-inherit [&_li]:text-inherit [&_strong]:text-inherit [&_em]:text-inherit [&_pre]:my-2 [&_blockquote]:my-1 [&_blockquote]:text-inherit'
    : 'max-w-none whitespace-normal break-words dark:text-claude-darkText text-claude-text [&_a]:text-inherit [&_a]:underline [&_h1]:my-0 [&_h1]:text-inherit [&_h2]:my-0 [&_h2]:text-inherit [&_h3]:my-0 [&_h3]:text-inherit [&_h4]:my-0 [&_h4]:text-inherit [&_h5]:my-0 [&_h5]:text-inherit [&_h6]:my-0 [&_h6]:text-inherit [&_p]:my-0 [&_p]:text-inherit [&_ul]:my-1 [&_ul]:text-inherit [&_ol]:my-1 [&_ol]:text-inherit [&_li]:text-inherit [&_strong]:text-inherit [&_em]:text-inherit [&_pre]:my-2 [&_blockquote]:my-1 [&_blockquote]:text-inherit';
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
  const [mediaSourceUrl, setMediaSourceUrl] = useState<string | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [loadedBytes, setLoadedBytes] = useState(0);
  const mediaType = getMetafileMimeType(item);

  useEffect(() => {
    let canceled = false;
    let objectUrl: string | null = null;

    setMediaSourceUrl(null);
    setStatus('loading');
    setLoadedBytes(0);

    const loadPreview = async () => {
      try {
        const previewUrl = await createMetafileMediaObjectUrl(item, (bytes) => {
          if (!canceled) {
            setLoadedBytes(bytes);
          }
        });
        if (canceled) {
          URL.revokeObjectURL(previewUrl);
          return;
        }
        objectUrl = previewUrl;
        setMediaSourceUrl(previewUrl);
        setStatus('ready');
      } catch (error) {
        if (canceled) {
          return;
        }
        console.error('Failed to load metafile media preview:', error);
        setMediaSourceUrl(item.sourceUrl);
        setStatus('error');
      }
    };

    void loadPreview();

    return () => {
      canceled = true;
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [item.uri, item.kind, item.sourceUrl, item.extension]);

  const loadingLabel = item.kind === 'video' ? '正在加载视频预览...' : '正在加载音频预览...';
  const errorLabel = item.kind === 'video'
    ? '视频预览加载失败，可先下载文件观看。'
    : '音频预览加载失败，可先下载文件收听。';
  const progressLabel = formatBytes(loadedBytes);

  if (item.kind === 'audio') {
    return (
      <>
        <audio controls preload="auto" className="w-full">
          {mediaSourceUrl && <source src={mediaSourceUrl} type={mediaType} />}
        </audio>
        {status === 'loading' && (
          <div className="mt-1 text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
            {loadingLabel}{progressLabel ? ` 已加载 ${progressLabel}` : ''}
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
      >
        {mediaSourceUrl && <source src={mediaSourceUrl} type={mediaType} />}
      </video>
      {status === 'loading' && (
        <div className="mt-1 text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
          {loadingLabel}{progressLabel ? ` 已加载 ${progressLabel}` : ''}
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

const MetafilePreviewCard: React.FC<{ item: ParsedMetafile }> = ({ item }) => {
  return (
    <div className="rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkBg/40 bg-claude-bg/60 p-2">
      {item.kind === 'image' && (
        <img
          src={item.sourceUrl}
          alt={item.fileName}
          className="w-full max-h-80 object-contain rounded-md"
          loading="lazy"
        />
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
          下载文件
        </button>
      </div>
    </div>
  );
};

const A2AMessageItem: React.FC<A2AMessageItemProps> = ({
  message,
  peerName,
  peerAvatar,
  metabotName,
  metabotAvatar,
}) => {
  // tool_use / tool_result: compact collapsible block (collapsed by default)
  if (message.type === 'tool_use' || message.type === 'tool_result') {
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
  // distinguish it from the actual on-chain reply.
  if (message.metadata?.isThinking) {
    return (
      <div className="px-4 py-1">
        <div className="ml-10 rounded-lg px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap break-words italic dark:text-claude-darkTextSecondary text-claude-textSecondary dark:bg-claude-darkSurface bg-claude-surface border dark:border-claude-darkBorder border-claude-border">
          {message.content}
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

  // Resolve display name and avatar.
  // For local sender: always use the session-level metabotName/metabotAvatar — never
  // message.metadata.senderAvatar, which stores the *peer's* avatar for incoming messages.
  // For peer sender: prefer session-level peerAvatar (already resolved to HTTPS) over
  // message-level senderAvatar (raw MetaWeb value, may be unresolved metafile:// URL).
  const fromName = isLocal
    ? (metabotName || 'MetaBot')
    : ((message.metadata?.senderName as string | undefined) || peerName || 'Peer');
  const senderAvatar = message.metadata?.senderAvatar as string | undefined;
  const fromAvatar = isLocal
    ? metabotAvatar
    : (isRenderableAvatarSource(peerAvatar) ? peerAvatar : senderAvatar);
  const deliveryPayload = parseDeliveryPayload(message.content);
  const deliveryResult = typeof deliveryPayload?.result === 'string'
    ? deliveryPayload.result.trim()
    : '';
  const shouldRenderDeliveryResult = deliveryResult.length > 0;
  const contentToRender = shouldRenderDeliveryResult ? deliveryResult : message.content;
  const metafileItems = extractMetafileItems(contentToRender);
  const markdownClassName = getA2AMarkdownClassName(isLocal);

  return (
    <div className={`flex items-end gap-2 px-4 py-1 ${isLocal ? 'flex-row-reverse' : 'flex-row'}`}>
      <Avatar src={fromAvatar} name={fromName} size={32} />
      <div className={`flex flex-col max-w-[70%] ${isLocal ? 'items-end' : 'items-start'}`}>
        <span className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary mb-0.5 px-1">
          {fromName}
        </span>
        <div
          className={`rounded-2xl px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap break-words ${
            isLocal
              ? 'bg-blue-500 text-white rounded-br-sm'
              : 'dark:bg-claude-darkSurface bg-claude-surface dark:text-claude-darkText text-claude-text rounded-bl-sm'
          }`}
        >
          <MarkdownContent content={contentToRender} className={markdownClassName} />
        </div>
        {metafileItems.length > 0 && (
          <div className="w-full mt-2 space-y-2">
            {metafileItems.map((item, index) => (
              <MetafilePreviewCard key={`${item.uri}-${index}`} item={item} />
            ))}
          </div>
        )}
        <span className="text-[10px] dark:text-claude-darkTextSecondary text-claude-textSecondary mt-0.5 px-1">
          {formatTime(message.timestamp)}
        </span>
      </div>
    </div>
  );
};

export default A2AMessageItem;
