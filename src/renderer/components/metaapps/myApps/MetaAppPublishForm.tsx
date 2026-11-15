import React, { useRef, useState } from 'react';
import { i18nService } from '../../../services/i18n';
import type { MetaAppManifestInput, OwnerMetaAppRecord } from '../../../types/metaAppOwner';

const RUNTIME_OPTIONS = ['browser', 'android', 'ios', 'windows', 'macOS', 'linux'] as const;
const CONTENT_TYPE_OPTIONS = [
  'application/zip', 'application/x-tar', 'application/x-7z-compressed', 'application/x-rar-compressed',
  'application/gzip', 'application/json', 'application/xml', 'text/plain', 'text/html', 'text/css',
  'application/javascript', 'application/pdf', 'image/jpeg', 'image/png', 'image/gif', 'image/svg+xml',
  'image/webp', 'video/mp4', 'video/webm', 'audio/mpeg', 'audio/wav', 'application/octet-stream',
];
const CODE_TYPE_OPTIONS = [
  'application/zip', 'application/x-tar', 'application/x-7z-compressed', 'application/x-rar-compressed',
  'application/gzip', 'application/json', 'application/xml', 'text/html', 'text/css', 'application/javascript',
];
const ASSET_FIELDS = [
  { name: 'content', multiple: false, image: false, labelKey: 'myAppsContent' },
  { name: 'icon', multiple: false, image: true, labelKey: 'myAppsIcon' },
  { name: 'coverImg', multiple: false, image: true, labelKey: 'myAppsCoverImg' },
  { name: 'introImgs', multiple: true, image: true, labelKey: 'myAppsIntroImgs' },
  { name: 'code', multiple: false, image: false, labelKey: 'myAppsCode' },
] as const;

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico', '.avif']);
const IMAGE_MIME_PREFIX = 'image/';

// Map a file (name + browser MIME) to a content/code-type option string, if a sensible one exists.
const detectTypeOption = (file: File, allowOctetStream: boolean): string => {
  const ext = '.' + (file.name.split('.').pop() || '').toLowerCase();
  const extToType: Record<string, string> = {
    '.zip': 'application/zip', '.tar': 'application/x-tar', '.7z': 'application/x-7z-compressed',
    '.rar': 'application/x-rar-compressed', '.gz': 'application/gzip', '.tgz': 'application/gzip',
    '.json': 'application/json', '.xml': 'application/xml', '.txt': 'text/plain',
    '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css',
    '.js': 'application/javascript', '.mjs': 'application/javascript',
    '.pdf': 'application/pdf', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
    '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp',
    '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
  };
  if (extToType[ext]) return extToType[ext];
  // Fall back to the browser-provided MIME type if it is one of the known options.
  const byMime = [...CONTENT_TYPE_OPTIONS].find((o) => o === file.type);
  if (byMime) return byMime;
  return allowOctetStream ? 'application/octet-stream' : '';
};

const isLikelyImage = (file: File): boolean => {
  if (file.type && file.type.startsWith(IMAGE_MIME_PREFIX)) return true;
  const ext = '.' + (file.name.split('.').pop() || '').toLowerCase();
  return IMAGE_EXTENSIONS.has(ext);
};

const sha256HexFromFile = async (file: File): Promise<string> => {
  if (!file || typeof file.arrayBuffer !== 'function') return '';
  const cryptoObj = (window as unknown as { crypto?: Crypto }).crypto;
  if (!cryptoObj?.subtle || typeof cryptoObj.subtle.digest !== 'function') return '';
  const buffer = await file.arrayBuffer();
  const digest = await cryptoObj.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

const bumpVersionValue = (value: string | undefined): string => {
  const text = (value || '').trim() || 'v1.0.0';
  const match = text.match(/^(.*?)(\d+)(\D*)$/u);
  if (!match) return `${text}.1`;
  return `${match[1]}${Number(match[2]) + 1}${match[3]}`;
};

const fileToBase64Body = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error('read failed'));
    reader.onload = () => {
      const result = String(reader.result || '');
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.readAsDataURL(file);
  });

interface MetaAppPublishFormProps {
  mode: 'publish' | 'edit';
  metabotId: number;
  metabotName?: string;
  record?: OwnerMetaAppRecord | null;
  submitting?: boolean;
  onSubmit: (manifest: MetaAppManifestInput) => void;
  onCancel: () => void;
  onUploadError?: (message: string) => void;
}

const MetaAppPublishForm: React.FC<MetaAppPublishFormProps> = ({
  mode, metabotId, metabotName, record, submitting, onSubmit, onCancel, onUploadError,
}) => {
  const t = (k: string) => i18nService.t(k);
  const isEdit = mode === 'edit';

  const [appName, setAppName] = useState(record?.appName || '');
  const [title, setTitle] = useState(record?.title || '');
  const [prompt, setPrompt] = useState(record?.prompt || '');
  const [intro, setIntro] = useState(record?.intro || '');
  const [tags, setTags] = useState((record?.tags || []).join(', '));
  const [icon, setIcon] = useState(record?.icon || '');
  const [coverImg, setCoverImg] = useState(record?.coverImg || '');
  const [introImgs, setIntroImgs] = useState<string[]>(record?.introImgs || []);
  const [content, setContent] = useState(record?.content || '');
  const [code, setCode] = useState(record?.code || '');
  const [contentHash, setContentHash] = useState(record?.contentHash || '');
  // The metafile:// source the contentHash was computed from (for display next to the hash field).
  const [contentSource, setContentSource] = useState(record?.content || '');
  const [runtime, setRuntime] = useState<string[]>(
    (record?.runtime ? String(record.runtime).split('/') : ['browser']).filter(Boolean),
  );
  const [version, setVersion] = useState(isEdit ? bumpVersionValue(record?.version) : (record?.version || 'v1.0.0'));
  const [contentType, setContentType] = useState(record?.contentType || 'application/zip');
  const [codeType, setCodeType] = useState(record?.codeType || '');
  const [indexFile, setIndexFile] = useState(record?.indexFile || 'index.html');
  const [metadata, setMetadata] = useState(record?.metadata ? JSON.stringify(record.metadata) : '');
  const [disabled, setDisabled] = useState<boolean>(!!record?.disabled);
  const [uploadingField, setUploadingField] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState('');
  const fileInputRefs = useRef<Record<string, HTMLInputElement | null>>({});

  const handleUpload = async (fieldName: string, files: FileList | null) => {
    if (!files || files.length === 0) return;
    const asset = ASSET_FIELDS.find((f) => f.name === fieldName);
    setUploadingField(fieldName);
    setUploadError('');
    try {
      // Validate image-only fields up front (icon/coverImg/introImgs must be images).
      if (asset?.image) {
        const nonImage = Array.from(files).find((f) => !isLikelyImage(f));
        if (nonImage) {
          const msg = (t('myAppsErrNotImage') || '"{{name}}" is not an image. icon/cover/intro images must be PNG, JPG, GIF, WebP, or SVG.')
            .replace('{{name}}', nonImage.name);
          setUploadError(msg);
          onUploadError?.(msg);
          return;
        }
      }

      const collected: string[] = [];
      let detectedContentType = '';
      let detectedCodeType = '';
      let contentHashValue = '';
      let contentSourceUri = '';
      for (const file of Array.from(files)) {
        const base64 = await fileToBase64Body(file);
        const res = await window.electron.idbots.uploadMetabotHomepageFile({
          metabotId,
          fileName: file.name,
          contentType: file.type || undefined,
          base64,
        });
        if (!res || !res.success || !res.metafileUri) {
          throw new Error(res?.error || 'Upload failed');
        }
        collected.push(res.metafileUri);

        if (fieldName === 'content') {
          // Auto-detect content type (allow octet-stream fallback) and compute SHA-256 hash.
          const detected = detectTypeOption(file, true);
          if (detected) detectedContentType = detected;
          contentSourceUri = res.metafileUri;
          const hash = await sha256HexFromFile(file);
          if (hash) contentHashValue = hash;
        } else if (fieldName === 'code') {
          // Auto-detect code type (no octet-stream fallback — code types are archive/text only).
          const detected = detectTypeOption(file, false);
          if (detected && CODE_TYPE_OPTIONS.includes(detected as never)) detectedCodeType = detected;
        }
      }

      if (asset?.multiple) {
        setIntroImgs((prev) => Array.from(new Set([...prev, ...collected])));
      } else if (fieldName === 'icon') setIcon(collected[0] || '');
      else if (fieldName === 'coverImg') setCoverImg(collected[0] || '');
      else if (fieldName === 'content') {
        setContent(collected[0] || '');
        if (detectedContentType) setContentType(detectedContentType);
        if (contentHashValue) setContentHash(contentHashValue);
        if (contentSourceUri) setContentSource(contentSourceUri);
      } else if (fieldName === 'code') {
        setCode(collected[0] || '');
        if (detectedCodeType) setCodeType(detectedCodeType);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Upload failed';
      // Show inline (visible inside the modal) and also bubble up to the tab notice.
      setUploadError(message);
      onUploadError?.(message);
    } finally {
      setUploadingField(null);
    }
  };

  const toggleRuntime = (value: string) => {
    setRuntime((prev) => (prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value]));
  };

  const handleSubmit = () => {
    let parsedMetadata: Record<string, unknown> | undefined;
    const metaText = metadata.trim();
    if (metaText) {
      try { parsedMetadata = JSON.parse(metaText); }
      catch { onUploadError?.(t('myAppsMetadataInvalid') || 'metadata must be valid JSON'); return; }
    }
    const manifest: MetaAppManifestInput = {
      appName: appName.trim(),
      title: title.trim() || appName.trim(),
      prompt: prompt.trim() || undefined,
      intro: intro.trim() || undefined,
      tags: tags.split(',').map((s) => s.trim()).filter(Boolean),
      icon: icon.trim() || undefined,
      coverImg: coverImg.trim() || undefined,
      introImgs,
      content: content.trim(),
      code: code.trim() || undefined,
      contentHash: contentHash.trim() || undefined,
      runtime,
      version: version.trim() || 'v1.0.0',
      contentType,
      codeType: codeType.trim() || undefined,
      indexFile: indexFile.trim() || 'index.html',
      metadata: parsedMetadata,
      disabled,
    };
    onSubmit(manifest);
  };

  const inputCls = 'w-full px-3 py-2 text-sm rounded-xl dark:bg-claude-darkSurface bg-claude-surface dark:text-claude-darkText text-claude-text border dark:border-claude-darkBorder border-claude-border focus:outline-none focus:ring-2 focus:ring-claude-accent';
  const labelCls = 'block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary mb-1';

  const renderAssetField = (field: typeof ASSET_FIELDS[number]) => {
    const value = field.name === 'icon' ? icon
      : field.name === 'coverImg' ? coverImg
      : field.name === 'content' ? content
      : field.name === 'code' ? code
      : introImgs.join(', ');
    return (
      <div key={field.name}>
        <label className={labelCls}>
          {t(field.labelKey) || field.name}
          {field.name === 'content'
            ? ` (${t('myAppsRequired') || 'required'})`
            : ` (${t('myAppsOptional') || 'optional'})`}
        </label>
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={value}
            onChange={(e) => {
              const v = e.target.value;
              if (field.name === 'icon') setIcon(v);
              else if (field.name === 'coverImg') setCoverImg(v);
              else if (field.name === 'content') setContent(v);
              else if (field.name === 'code') setCode(v);
              else setIntroImgs(v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);
            }}
            placeholder={field.image ? 'metafile://… or https://…' : 'metafile://…'}
            className={inputCls}
          />
          <input
            ref={(el) => { fileInputRefs.current[field.name] = el; }}
            type="file"
            multiple={field.multiple}
            className="hidden"
            onChange={(e) => handleUpload(field.name, e.target.files)}
          />
          <button
            type="button"
            onClick={() => fileInputRefs.current[field.name]?.click()}
            disabled={uploadingField === field.name}
            className="shrink-0 px-2.5 py-1.5 text-xs rounded-lg border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors disabled:opacity-50"
          >
            {uploadingField === field.name ? (t('myAppsUploading') || 'Uploading…') : (t('myAppsUpload') || 'Upload')}
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-full max-w-2xl mx-4 rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface shadow-xl flex flex-col max-h-[85vh]">
        <div className="flex items-center justify-between px-5 py-3 border-b dark:border-claude-darkBorder border-claude-border">
          <h3 className="text-base font-semibold dark:text-claude-darkText text-claude-text">
            {isEdit ? (t('myAppsEditTitle') || 'Edit MetaApp') : (t('myAppsPublishTitle') || 'Publish MetaApp')}
          </h3>
          <button type="button" onClick={onCancel} className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-claude-accent">
            {t('cancel') || 'Cancel'}
          </button>
        </div>

        <div className="px-5 py-4 overflow-y-auto space-y-4">
          {uploadError ? (
            <div className="rounded-lg border border-red-300 dark:border-red-800/60 bg-red-50 dark:bg-red-900/20 px-3 py-2 text-xs text-red-700 dark:text-red-300">
              <span className="font-medium">{t('myAppsUploadError') || 'Upload failed'}:</span> {uploadError}
              <button type="button" onClick={() => setUploadError('')} className="ml-2 underline">✕</button>
            </div>
          ) : null}
          {metabotName ? (
            <p className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
              {(t('myAppsPublishedBy') || 'Published by').replace('{{name}}', metabotName)}
            </p>
          ) : null}
          {isEdit && record?.version ? (
            <p className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
              {(t('myAppsPrevVersion') || 'Previous version')}: {record.version}
            </p>
          ) : null}

          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelCls}>{t('myAppsAppName') || 'App name'} *</label>
                <input value={appName} onChange={(e) => setAppName(e.target.value)} className={inputCls} />
              </div>
              <div>
                <label className={labelCls}>{t('myAppsTitle') || 'Title'} <span className="font-normal opacity-70">({t('myAppsOptional') || 'optional'})</span></label>
                <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={appName} className={inputCls} />
              </div>
            </div>
            <div>
              <label className={labelCls}>{t('myAppsPrompt') || 'Prompt'} <span className="font-normal opacity-70">({t('myAppsOptional') || 'optional'})</span></label>
              <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={2} className={inputCls} />
            </div>
            <div>
              <label className={labelCls}>{t('myAppsIntro') || 'Intro'} <span className="font-normal opacity-70">({t('myAppsOptional') || 'optional'})</span></label>
              <textarea value={intro} onChange={(e) => setIntro(e.target.value)} rows={2} className={inputCls} />
            </div>
            <div>
              <label className={labelCls}>{t('myAppsTags') || 'Tags'} <span className="font-normal opacity-70">({t('myAppsOptional') || 'optional'})</span></label>
              <input value={tags} onChange={(e) => setTags(e.target.value)} className={inputCls} placeholder={t('myAppsTagsPlaceholder') || 'e.g. game, tool, ai'} />
              <p className="mt-1 text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {t('myAppsTagsHint') || 'Separate multiple tags with commas. Example: game, productivity, ai'}
              </p>
            </div>
          </div>

          <div className="space-y-3">
            <p className="text-xs font-semibold uppercase tracking-wide dark:text-claude-darkTextSecondary text-claude-textSecondary">
              {t('myAppsAssets') || 'Assets'}
            </p>
            {ASSET_FIELDS.map(renderAssetField)}
          </div>

          <div className="space-y-3">
            <p className="text-xs font-semibold uppercase tracking-wide dark:text-claude-darkTextSecondary text-claude-textSecondary">
              {t('myAppsTechnical') || 'Technical'}
            </p>
            <div>
              <label className={labelCls}>{t('myAppsRuntime') || 'Runtime'}</label>
              <div className="flex flex-wrap gap-2">
                {RUNTIME_OPTIONS.map((opt) => (
                  <label key={opt} className="inline-flex items-center gap-1.5 text-sm dark:text-claude-darkText text-claude-text">
                    <input type="checkbox" checked={runtime.includes(opt)} onChange={() => toggleRuntime(opt)} />
                    {opt}
                  </label>
                ))}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelCls}>{t('myAppsVersion') || 'Version'} <span className="font-normal opacity-70">({t('myAppsOptional') || 'optional'})</span></label>
                <input value={version} onChange={(e) => setVersion(e.target.value)} className={inputCls} />
              </div>
              <div>
                <label className={labelCls}>{t('myAppsIndexFile') || 'Index file'} <span className="font-normal opacity-70">({t('myAppsOptional') || 'optional'})</span></label>
                <input value={indexFile} onChange={(e) => setIndexFile(e.target.value)} className={inputCls} />
              </div>
              <div>
                <label className={labelCls}>{t('myAppsContentType') || 'Content type'} <span className="font-normal opacity-70">({t('myAppsOptional') || 'optional'})</span></label>
                <select value={contentType} onChange={(e) => setContentType(e.target.value)} className={inputCls}>
                  {CONTENT_TYPE_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              </div>
              <div>
                <label className={labelCls}>{t('myAppsCodeType') || 'Code type'} <span className="font-normal opacity-70">({t('myAppsOptional') || 'optional'})</span></label>
                <select value={codeType} onChange={(e) => setCodeType(e.target.value)} className={inputCls}>
                  <option value="">—</option>
                  {CODE_TYPE_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              </div>
            </div>
            <div>
              <label className={labelCls}>{t('myAppsContentHash') || 'Content hash'} <span className="font-normal opacity-70">({t('myAppsOptional') || 'optional'})</span></label>
              <input value={contentHash} onChange={(e) => setContentHash(e.target.value)} className={inputCls} placeholder={t('myAppsContentHashPlaceholder') || 'auto-filled from uploaded content (SHA-256)'} />
              {contentSource ? (
                <p className="mt-1 text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary break-all">
                  {(t('myAppsContentHashSource') || 'Hash of')}: <code className="text-claude-accent">{contentSource}</code>
                </p>
              ) : null}
            </div>
            <div>
              <label className={labelCls}>{t('myAppsMetadata') || 'Metadata (JSON)'} <span className="font-normal opacity-70">({t('myAppsOptional') || 'optional'})</span></label>
              <textarea value={metadata} onChange={(e) => setMetadata(e.target.value)} rows={2} className={inputCls} />
            </div>
            <label className="inline-flex items-center gap-1.5 text-sm dark:text-claude-darkText text-claude-text">
              <input type="checkbox" checked={disabled} onChange={(e) => setDisabled(e.target.checked)} />
              {t('myAppsDisabled') || 'Disabled (not runnable)'}
            </label>
          </div>
        </div>

        <div className="px-5 py-3 border-t dark:border-claude-darkBorder border-claude-border flex justify-end gap-2">
          <button type="button" onClick={onCancel} disabled={submitting}
            className="px-4 py-2 text-sm rounded-[var(--rounded)] border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors">
            {t('cancel') || 'Cancel'}
          </button>
          <button type="button" onClick={handleSubmit} disabled={submitting || !appName.trim() || !content.trim()}
            className="btn-idchat-primary-filled text-sm font-medium disabled:cursor-not-allowed disabled:opacity-60">
            {submitting ? (t('myAppsSubmitting') || 'Submitting…') : (isEdit ? (t('save') || 'Save') : (t('publish') || 'Publish'))}
          </button>
        </div>
      </div>
    </div>
  );
};

export default MetaAppPublishForm;
