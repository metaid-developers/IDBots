import { useEffect, useState } from 'react';
import MarkdownContent from '@/components/MarkdownContent';
import { useLocalFileUrl } from '@/hooks/useLocalFileUrl';
import { artifactFilename, artifactKind, shareArtifactUrl } from '../artifacts';
import { useArtifactText } from '../hooks/useArtifactText';
import { BottomSheet } from './BottomSheet';
import { getNativeAdapter } from '../../native/nativeAdapter';
import { t } from '../../i18n';

export default function MobileArtifactPreview({ path, onClose }: { path: string; onClose: () => void }): JSX.Element {
  const filename = artifactFilename(path);
  const kind = artifactKind(path);
  const inline = useLocalFileUrl(path, { disposition: 'inline' });
  const download = useLocalFileUrl(path, { disposition: 'attachment' });
  const document = useArtifactText(kind, inline.url);
  const [imageFailed, setImageFailed] = useState(false);
  const [shareState, setShareState] = useState<'shared' | 'copied' | 'failed' | null>(null);
  useEffect(() => setImageFailed(false), [path, inline.url]);
  useEffect(() => setShareState(null), [path, download.url]);

  const share = async (): Promise<void> => {
    if (!download.url) return;
    setShareState(null);
    try {
      const result = await shareArtifactUrl(download.url, filename, window.location.origin, {
        share: async (data) => {
          const adapter = getNativeAdapter();
          if (adapter.getCapabilities().share) {
            const outcome = await adapter.shareArtifact({ url: data.url, filename: data.title });
            if (outcome === 'cancelled') throw Object.assign(new Error('Share cancelled'), { name: 'AbortError' });
            return;
          }
          if (typeof navigator.share === 'function') {
            await navigator.share(data);
            return;
          }
          throw new Error('Sharing is unavailable');
        },
        copy: navigator.clipboard?.writeText ? navigator.clipboard.writeText.bind(navigator.clipboard) : undefined,
      });
      if (result !== 'cancelled') setShareState(result);
    } catch {
      setShareState('failed');
    }
  };
  const loading = inline.loading || (kind === 'markdown' && document.loading);
  const failed = inline.error || document.error || imageFailed;

  return (
    <BottomSheet title={filename} onClose={onClose}>
      <div data-testid="artifact-preview" data-artifact-kind={kind}>
        <div className="mb-3 flex flex-wrap gap-2">
          <a
            href={download.url ?? undefined}
            download={filename}
            onClick={(event) => { if (!download.url) event.preventDefault(); }}
            aria-disabled={!download.url}
            data-testid="artifact-download"
            className={`twin-button twin-button-primary ${download.url ? '' : 'opacity-40'}`}
          >
            {t('mobile.artifact.download')}
          </a>
          <button
            type="button"
            onClick={() => void share()}
            disabled={!download.url}
            data-testid="artifact-share"
            className="twin-button twin-button-secondary"
          >
            {t('mobile.artifact.share')}
          </button>
          {kind !== 'other' ? (
            <a
              href={inline.url ?? undefined}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(event) => { if (!inline.url) event.preventDefault(); }}
              aria-disabled={!inline.url}
              data-testid="artifact-open-new-tab"
              className={`twin-button twin-button-secondary ${inline.url ? '' : 'opacity-40'}`}
            >
              {t('mobile.artifact.openNewTab')}
            </a>
          ) : null}
        </div>
        {shareState ? (
          <p className={`mb-2 text-xs ${shareState === 'failed' ? 'text-red-600' : 'text-[var(--text-secondary)]'}`} role="status">
            {t(`mobile.artifact.${shareState === 'failed' ? 'shareFailed' : shareState === 'shared' ? 'shareSucceeded' : 'linkCopied'}`)}
          </p>
        ) : null}
        {loading ? <p className="py-6 text-center text-sm text-[var(--text-secondary)]">{t('mobile.artifact.loading')}</p> : null}
        {!loading && failed ? (
          <p className="twin-notice twin-notice-error" role="alert">{t('mobile.artifact.previewFailed')}</p>
        ) : null}
        {!loading && !failed && kind === 'image' && inline.url ? (
          <img
            src={inline.url}
            alt={filename}
            onError={() => setImageFailed(true)}
            data-testid="artifact-image"
            className="mx-auto max-h-[60dvh] max-w-full rounded-lg object-contain"
          />
        ) : null}
        {!loading && !failed && kind === 'pdf' && inline.url ? (
          <iframe
            src={inline.url}
            title={t('mobile.artifact.pdfTitle', { name: filename })}
            data-testid="artifact-pdf"
            className="h-[60dvh] w-full rounded-lg border border-[var(--border-color)] bg-white"
          />
        ) : null}
        {!loading && !failed && kind === 'markdown' && document.text !== null ? (
          <div data-testid="artifact-markdown" className="max-h-[60dvh] overflow-y-auto rounded-lg bg-[var(--bg-main)] p-3">
            <MarkdownContent content={document.text} compact />
          </div>
        ) : null}
        {!loading && !failed && kind === 'html' && inline.url ? (
          <iframe
            src={inline.url}
            title={filename}
            data-testid="artifact-html"
            className="h-[60dvh] w-full rounded-lg border border-[var(--border-color)] bg-white"
          />
        ) : null}
        {kind === 'other' ? (
          <p className="py-4 text-sm text-[var(--text-secondary)]">{t('mobile.artifact.otherBody')}</p>
        ) : null}
        {download.error ? <p className="mt-2 text-xs text-red-600" role="alert">{t('mobile.artifact.downloadFailed')}</p> : null}
      </div>
    </BottomSheet>
  );
}
