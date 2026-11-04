import { XMarkIcon } from '@heroicons/react/24/outline';
import type { useChat } from '../hooks/useChat';
import { uploadProgressPercent } from '../hooks/useChatAttachments';
import { t } from '../../i18n';

export default function ChatComposerAttachments({
  chat,
}: {
  chat: ReturnType<typeof useChat>;
}): JSX.Element | null {
  const attachments = chat.attachments ?? [];
  const uploads = chat.uploads ?? [];
  if (attachments.length === 0 && uploads.length === 0) return null;
  return (
    <div className="mb-2 space-y-2" aria-label={t('mobile.chat.attachments')} data-testid="chat-attachments">
      {attachments.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {attachments.map((attachment) => (
            <span
              key={attachment.path}
              className="twin-chip max-w-full gap-1 py-1 pl-2"
              data-testid="chat-attachment"
            >
              <span className="min-w-0 truncate">{attachment.name}</span>
              <button
                type="button"
                onClick={() => chat.removeAttachment(attachment.path)}
                aria-label={t('mobile.chat.removeAttachment', { name: attachment.name })}
                className="flex min-h-[44px] min-w-[44px] items-center justify-center text-[var(--text-secondary)] active:text-[var(--text-primary)]"
              >
                <XMarkIcon className="h-4 w-4" aria-hidden />
              </button>
            </span>
          ))}
        </div>
      ) : null}
      {chat.uploads.map((item) => {
        const name = item.fileName || t('mobile.chat.attachmentFallback');
        return (
          <div
            key={item.id}
            className="twin-notice flex min-h-[44px] items-center gap-2"
            data-testid="chat-upload"
            data-upload-status={item.status}
          >
            <div className="min-w-0 flex-1 text-xs text-[var(--text-secondary)]" role={item.status === 'failed' ? 'alert' : 'status'}>
              {item.status === 'selecting' ? <span>{t('mobile.chat.openingPicker')}</span> : null}
              {item.status === 'uploading' ? (
                <div className="flex items-center gap-2">
                  <progress className="h-1.5 min-w-0 flex-1" max={100} value={uploadProgressPercent(item)} aria-label={t('mobile.chat.uploadProgress', { name, percent: uploadProgressPercent(item) })} />
                  <span className="shrink-0">{uploadProgressPercent(item)}%</span>
                </div>
              ) : null}
              {item.status === 'failed' ? (
                <span className="text-red-600">{t(`mobile.chat.uploadError.${item.errorCode ?? 'UPLOAD_FAILED'}`, { name })}</span>
              ) : null}
            </div>
            <button
              type="button"
              onClick={() => chat.removeUpload(item)}
              aria-label={t('mobile.chat.removeUpload', { name })}
              className="flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center text-[var(--text-secondary)] active:text-[var(--text-primary)]"
            >
              <XMarkIcon className="h-4 w-4" aria-hidden />
            </button>
          </div>
        );
      })}
    </div>
  );
}
