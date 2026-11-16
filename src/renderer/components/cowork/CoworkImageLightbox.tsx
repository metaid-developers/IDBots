/**
 * A minimal in-app image lightbox: click a thumbnail to see it large, click
 * anywhere (or press Escape) to close.
 *
 * Both the composer's pending attachment and the sent message's image strip
 * open images here, so a picture always previews the same way — inside the app,
 * never by shelling out to the OS viewer. It renders nothing when no image is
 * open, so callers can mount it unconditionally.
 */

import React, { useEffect } from 'react';
import { XMarkIcon } from '@heroicons/react/24/outline';

interface CoworkImageLightboxProps {
  /** The data URL (or any src) to show large; null closes the lightbox. */
  src: string | null;
  /** Called when the owner dismisses it (backdrop click or Escape). */
  onClose: () => void;
  /** Optional caption, e.g. the file's base name. */
  caption?: string;
}

const CoworkImageLightbox: React.FC<CoworkImageLightboxProps> = ({ src, onClose, caption }) => {
  useEffect(() => {
    if (!src) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [src, onClose]);

  if (!src) return null;

  return (
    <div
      data-cowork-image-lightbox="true"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6 cursor-zoom-out"
    >
      <button
        type="button"
        onClick={onClose}
        aria-label="Close"
        title="Close"
        className="absolute right-4 top-4 rounded-[var(--shape-radius-md)] bg-black/50 p-1.5 text-white transition-colors hover:bg-black/70"
      >
        <XMarkIcon className="h-5 w-5" />
      </button>
      <img
        src={src}
        alt={caption ?? ''}
        onClick={(event) => event.stopPropagation()}
        className="max-h-full max-w-full rounded-lg object-contain shadow-elevated cursor-default"
      />
      {caption ? (
        <div className="absolute bottom-4 left-0 right-0 text-center text-xs text-white/80 truncate px-6">
          {caption}
        </div>
      ) : null}
    </div>
  );
};

export default CoworkImageLightbox;
