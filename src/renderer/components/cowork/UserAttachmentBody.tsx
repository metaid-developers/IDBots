// The display-side attachment pipeline for a user message — ONE copy.
//
// The composer writes every attachment into the submitted prompt as its own
// `附件路径: <path>` line, and that same text is what the model reads, so the
// line cannot be dropped from the stored body. Rendering instead splits the
// marker lines out at DISPLAY time: what remains renders as markdown, and the
// image files those markers named render as a thumbnail strip with the in-app
// lightbox.
//
// This module is the single implementation of that pipeline. It moved out of
// CoworkSessionDetail so the Bot Internet cowork panel (a deliberately minimal
// separate renderer) can render the same body: the main surface got the
// thumbnail fix and the panel kept leaking raw attachment paths, because the
// two surfaces each had their own idea of how a user body renders. Do not
// re-implement the splitter anywhere — import it from here.
//
// Display-only contract: the splitter is never wired into prompt composition.

import React, { useEffect, useMemo, useState } from 'react';
import MarkdownContent from '../MarkdownContent';
import CoworkImageLightbox from './CoworkImageLightbox';
import { mapWechatBracketCodesForDisplay } from '../chat/wechatEmojiDisplay';
import {
  LOCAL_IMAGE_PREVIEW_MAX_BYTES,
  getLocalImagePreviewEntry,
  hasSupportedImageExtension,
  loadLocalImagePreview,
  stripHashAndQuery,
} from '../../utils/localImage';
import {
  getPathBaseName,
  normalizeLocalPath,
  stripFileProtocol,
  type LocalFilePathResolver,
} from '../../utils/localPath';

/**
 * The attachment marker line the composer writes (`附件路径: <path>`), including
 * the historical aliases older transcripts may carry.
 */
export const USER_ATTACHMENT_MARKER_PATTERN =
  /^\s*(?:[-*]\s*)?(?:附件路径|附件文件|输入文件|input\s*file|attachment\s*(?:path|file))\s*[:：]\s*(.+?)\s*$/i;

/**
 * Split the attachment marker lines out of a user message body so the image
 * files they name can render as pictures instead of as raw paths.
 *
 * `body` keeps every line that is not an image attachment marker, and
 * `imagePaths` carries the image files those markers named, for
 * ImagePreviewStrip. A marker whose path is not a readable image stays in
 * `body` as text, so nothing is silently swallowed.
 */
export const splitUserAttachmentLines = (
  content: string,
  resolveLocalFilePath?: LocalFilePathResolver,
): { body: string; imagePaths: string[] } => {
  if (!content) return { body: content, imagePaths: [] };
  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  const kept: string[] = [];
  const imagePaths: string[] = [];
  for (const line of lines) {
    const marker = USER_ATTACHMENT_MARKER_PATTERN.exec(line);
    if (!marker) {
      kept.push(line);
      continue;
    }
    const pathText = marker[1].trim();
    const normalized = normalizeLocalPath(pathText);
    const isImage = hasSupportedImageExtension(stripHashAndQuery(pathText))
      || (normalized !== null && hasSupportedImageExtension(normalized.path));
    if (!isImage) {
      kept.push(line);
      continue;
    }
    const resolved = resolveLocalFilePath
      ? resolveLocalFilePath(pathText, pathText)
      : null;
    const absolute = (resolved ?? (normalized?.isAbsolute ? normalized.path : null))?.trim();
    if (!absolute) {
      kept.push(line);
      continue;
    }
    imagePaths.push(stripFileProtocol(stripHashAndQuery(absolute)));
  }
  // Collapse the blank line that separated the marker block from the rest.
  return { body: kept.join('\n').replace(/\n{3,}/g, '\n\n').trim(), imagePaths };
};

/**
 * A user message body, with any attachment marker lines rendered as pictures.
 *
 * Every user-message branch on every cowork surface (plain, reply-quote,
 * selection-quote, sidebar panel) renders its remaining body through this, so
 * an image attachment shows as a thumbnail no matter which surface or branch
 * the message takes. Display-only: the submitted prompt text is untouched.
 */
export const UserMessageBody: React.FC<{
  content: string;
  resolveLocalFilePath?: LocalFilePathResolver;
}> = ({ content, resolveLocalFilePath }) => {
  const { body, imagePaths } = useMemo(
    () => splitUserAttachmentLines(content, resolveLocalFilePath),
    [content, resolveLocalFilePath],
  );
  return (
    <>
      {body ? (
        // Display-time WeChat bracket-code mapping (user bubbles only — the
        // same display-only contract as the messenger surfaces); the stored
        // transcript text stays verbatim. emojiImages: catalog emoji render
        // as bundled Twemoji artwork (display-only swap).
        <MarkdownContent
          content={mapWechatBracketCodesForDisplay(body)}
          className="max-w-none whitespace-pre-wrap [overflow-wrap:anywhere]"
          emojiImages
        />
      ) : null}
      {imagePaths.length > 0 && <ImagePreviewStrip imagePaths={imagePaths} inline />}
    </>
  );
};

/** Seed the first paint from the module cache: a cached thumbnail never flashes. */
const readCachedPreviews = (imagePaths: string[]): Record<string, string> => {
  const cachedPreviews: Record<string, string> = {};
  for (const imagePath of imagePaths) {
    const cached = getLocalImagePreviewEntry(imagePath);
    if (cached?.status === 'ready') {
      cachedPreviews[imagePath] = cached.dataUrl;
    }
  }
  return cachedPreviews;
};

export const ImagePreviewStrip: React.FC<{ imagePaths: string[]; inline?: boolean }> = ({ imagePaths, inline = false }) => {
  const [previewData, setPreviewData] = useState<Record<string, string>>(() => readCachedPreviews(imagePaths));

  useEffect(() => {
    let cancelled = false;

    setPreviewData(readCachedPreviews(imagePaths));

    const pendingPaths = imagePaths.filter((imagePath) => !getLocalImagePreviewEntry(imagePath));
    if (pendingPaths.length === 0) {
      return () => {
        cancelled = true;
      };
    }

    pendingPaths.forEach((imagePath) => {
      void loadLocalImagePreview(imagePath, LOCAL_IMAGE_PREVIEW_MAX_BYTES).then((entry) => {
        if (cancelled || entry.status !== 'ready') return;
        setPreviewData((prev) => (
          prev[imagePath]
            ? prev
            : { ...prev, [imagePath]: entry.dataUrl }
        ));
      });
    });

    return () => {
      cancelled = true;
    };
  }, [imagePaths]);

  const visiblePaths = imagePaths.filter((imagePath) => typeof previewData[imagePath] === 'string');

  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const [lightboxCaption, setLightboxCaption] = useState<string | undefined>(undefined);

  if (visiblePaths.length === 0) return null;

  return (
    <>
      <div className={inline ? 'mt-2 flex flex-wrap gap-2' : 'ml-4 mt-2 flex flex-wrap gap-2'}>
        {visiblePaths.map((imagePath) => (
          <button
            key={imagePath}
            type="button"
            title={getPathBaseName(imagePath)}
            onClick={() => {
              setLightboxCaption(getPathBaseName(imagePath));
              setLightboxSrc(previewData[imagePath]);
            }}
            className="group rounded-lg border dark:border-claude-darkBorder border-claude-border overflow-hidden dark:bg-claude-darkSurface bg-claude-surface hover:border-claude-accent transition-colors cursor-zoom-in"
          >
            <img
              src={previewData[imagePath]}
              alt={getPathBaseName(imagePath)}
              className="h-24 w-24 object-cover"
              loading="lazy"
            />
            <div className="px-1.5 py-1 text-[10px] leading-4 dark:text-claude-darkTextSecondary text-claude-textSecondary max-w-24 truncate text-left">
              {getPathBaseName(imagePath)}
            </div>
          </button>
        ))}
      </div>
      <CoworkImageLightbox
        src={lightboxSrc}
        caption={lightboxCaption}
        onClose={() => setLightboxSrc(null)}
      />
    </>
  );
};
