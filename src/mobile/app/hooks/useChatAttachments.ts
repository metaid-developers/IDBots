import { useCallback, useEffect, useRef, useState } from 'react';
import type { CoworkSessionController } from '@/services/coworkSessionController';
import type {
  PhoneFileSelectionErrorCode,
  PhoneFileSelectionOptions,
  PhoneFileSelectionResult,
  PhoneFileSelectionSource,
  PhoneUploadProgress,
} from '../../bridge/installShim';
import { getMobileElectron } from '../appBridge';
import { t } from '../../i18n';

export interface ChatUploadItem {
  id: string;
  requestId: string;
  fileIndex: number;
  sessionId: string | null;
  fileName: string;
  loaded: number;
  total: number;
  status: 'selecting' | 'uploading' | 'failed';
  errorCode: PhoneFileSelectionErrorCode | null;
}

export function uploadProgressPercent(item: Pick<ChatUploadItem, 'loaded' | 'total'>): number {
  if (item.total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((item.loaded / item.total) * 100)));
}

export function useChatAttachments(
  controller: CoworkSessionController | null,
  sessionId: string | null,
) {
  const [uploads, setUploads] = useState<ChatUploadItem[]>([]);
  const cancelled = useRef(new Set<string>());
  const mounted = useRef(true);
  const requestSequence = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const pickAttachments = useCallback(async (source: PhoneFileSelectionSource = 'files'): Promise<void> => {
    if (!controller) return;
    const owner = controller;
    const draftToken = owner.getDraftToken();
    const originatingSessionId = sessionId;
    const requestId = `mobile-upload-${++requestSequence.current}`;
    const isCancelled = (fileIndex: number) => cancelled.current.has(`${requestId}:${fileIndex}`);
    const update = (fileIndex: number, updateItem: (item: ChatUploadItem | null) => ChatUploadItem | null) => {
      if (!mounted.current) return;
      setUploads((current) => {
        const index = current.findIndex((item) => item.id === `${requestId}:${fileIndex}`);
        const next = updateItem(index >= 0 ? current[index] : null);
        if (index < 0) return next ? [...current, next] : current;
        if (!next) return current.filter((item) => item.id !== `${requestId}:${fileIndex}`);
        return current.map((item) => item.id === `${requestId}:${fileIndex}` ? next : item);
      });
    };
    const onUploadProgress = (progress: PhoneUploadProgress) => {
      if (!mounted.current || isCancelled(progress.fileIndex)) return;
      if (progress.path) {
        owner.addAttachments(draftToken, [{
          path: progress.path,
          name: progress.fileName,
          size: progress.fileSize,
          mime: progress.mime,
        }]);
        update(progress.fileIndex, () => null);
        return;
      }
      update(progress.fileIndex, (item) => ({
        id: `${requestId}:${progress.fileIndex}`,
        requestId,
        fileIndex: progress.fileIndex,
        sessionId: originatingSessionId,
        fileName: progress.fileName,
        loaded: progress.loaded,
        total: progress.total,
        status: 'uploading',
        errorCode: item?.errorCode ?? null,
      }));
    };

    update(-1, () => ({
      id: `${requestId}:-1`,
      requestId,
      fileIndex: -1,
      sessionId: originatingSessionId,
      fileName: '',
      loaded: 0,
      total: 0,
      status: 'selecting',
      errorCode: null,
    }));
    try {
      const selectFile = getMobileElectron().dialog.selectFile as unknown as (
        options: PhoneFileSelectionOptions,
      ) => Promise<PhoneFileSelectionResult>;
      const result = await selectFile({
        title: t('mobile.chat.addAttachment'),
        multi: true,
        source,
        onUploadProgress,
      });
      update(-1, () => null);
      if (!result.success && result.failedIndex !== undefined) {
        update(result.failedIndex, (item) => ({
          id: `${requestId}:${result.failedIndex}`,
          requestId,
          fileIndex: result.failedIndex!,
          sessionId: originatingSessionId,
          fileName: item?.fileName ?? '',
          loaded: item?.loaded ?? 0,
          total: item?.total ?? 0,
          status: 'failed',
          errorCode: result.errorCode ?? 'UPLOAD_FAILED',
        }));
      }
    } catch {
      update(-1, (item) => item
        ? { ...item, status: 'failed', errorCode: 'UPLOAD_FAILED' }
        : null);
    }
  }, [controller, sessionId]);

  const removeUpload = useCallback((item: ChatUploadItem): void => {
    cancelled.current.add(`${item.requestId}:${item.fileIndex}`);
    setUploads((current) => current.filter((candidate) => candidate.id !== item.id));
  }, []);

  const sessionUploads = uploads.filter((item) => item.sessionId === sessionId);
  return {
    uploads: sessionUploads,
    isUploading: sessionUploads.some((item) => item.status !== 'failed'),
    pickAttachments,
    removeUpload,
  };
}
