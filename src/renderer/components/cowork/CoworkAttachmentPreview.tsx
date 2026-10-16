import React, { useEffect, useState } from 'react';
import { PaperClipIcon, PhotoIcon, XMarkIcon } from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import {
  getLocalImagePreviewEntry,
  hasSupportedImageExtension,
  loadLocalImagePreview,
  type LocalImagePreviewEntry,
} from '../../utils/localImage';

/** Structural twin of the composer's local attachment shape (path + name). */
export type CoworkAttachmentItem = { path: string; name: string };

interface CoworkAttachmentPreviewProps {
  attachment: CoworkAttachmentItem;
  /** Mirrors the composer's `disabled || isStreaming` gate for the remove button. */
  removeDisabled: boolean;
  onRemove: (path: string) => void;
}

const PILL_REMOVE_CLASS = 'ml-0.5 rounded-full p-0.5 hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover';
const THUMB_REMOVE_CLASS = 'rounded-full bg-black/55 p-0.5 text-white hover:bg-black/75';

/**
 * One attachment chip in the composer. Non-image files keep the filename pill
 * (paperclip + name); image files render as a rounded 64px thumbnail instead,
 * so a pasted screenshot reads as a picture rather than as "image-….png".
 *
 * The thumbnail never degrades to an empty box: while the preview is still
 * being read it shows a placeholder tile, and a failed read falls back to the
 * filename pill.
 */
const CoworkAttachmentPreview: React.FC<CoworkAttachmentPreviewProps> = ({
  attachment,
  removeDisabled,
  onRemove,
}) => {
  const isImage = hasSupportedImageExtension(attachment.path);
  const [preview, setPreview] = useState<LocalImagePreviewEntry | undefined>(
    () => (isImage ? getLocalImagePreviewEntry(attachment.path) : undefined),
  );

  useEffect(() => {
    if (!hasSupportedImageExtension(attachment.path)) return;
    const cached = getLocalImagePreviewEntry(attachment.path);
    if (cached) {
      setPreview(cached);
      return;
    }
    let cancelled = false;
    void loadLocalImagePreview(attachment.path).then((entry) => {
      if (!cancelled) setPreview(entry);
    });
    return () => {
      cancelled = true;
    };
  }, [attachment.path]);

  const renderRemoveButton = (className: string) => (
    <button
      type="button"
      onClick={() => onRemove(attachment.path)}
      disabled={removeDisabled}
      className={className}
      aria-label={i18nService.t('coworkAttachmentRemove')}
      title={i18nService.t('coworkAttachmentRemove')}
    >
      <XMarkIcon className="h-3 w-3" />
    </button>
  );

  const pill = (
    <div
      className="inline-flex items-center gap-1.5 rounded-full border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface px-2.5 py-1 text-xs dark:text-claude-darkText text-claude-text max-w-full"
      title={attachment.path}
    >
      <PaperClipIcon className="h-3.5 w-3.5 flex-shrink-0" />
      <span className="truncate max-w-[180px]">{attachment.name}</span>
      {renderRemoveButton(PILL_REMOVE_CLASS)}
    </div>
  );

  if (!isImage) {
    return pill;
  }

  if (preview?.status === 'ready') {
    return (
      <div
        className="relative h-16 w-16 flex-shrink-0 overflow-hidden rounded-lg border dark:border-claude-darkBorder border-claude-border"
        title={attachment.path}
      >
        <img src={preview.dataUrl} alt="" className="h-full w-full object-cover" />
        <span className="absolute right-0.5 top-0.5">
          {renderRemoveButton(THUMB_REMOVE_CLASS)}
        </span>
      </div>
    );
  }

  if (preview?.status === 'error') {
    return pill;
  }

  return (
    <div
      className="flex h-16 w-16 flex-shrink-0 items-center justify-center rounded-lg border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface"
      title={attachment.path}
      aria-label={i18nService.t('coworkAttachmentImageLoading')}
    >
      <PhotoIcon className="h-5 w-5 animate-pulse dark:text-claude-darkTextSecondary text-claude-textSecondary" />
    </div>
  );
};

export default CoworkAttachmentPreview;
