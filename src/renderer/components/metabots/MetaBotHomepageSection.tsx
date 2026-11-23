/**
 * Homepage source editor (Studio Linear Style B) for the Advanced tab.
 * Preserves all data-slot markers and inline control-row ordering for SSR layout tests.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowTopRightOnSquareIcon, GlobeAltIcon } from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import type { OwnerMetaAppRecord } from '../../types/metaAppOwner';
import {
  METABOT_BTN_FLAT_CLASS,
  METABOT_COMPACT_SELECT_CLASS,
  METABOT_GROUP_BOX_CLASS,
  METABOT_GROUP_LABEL_CLASS,
  METABOT_GROUP_LABEL_ROW_CLASS,
  METABOT_GROUP_NOTE_CLASS,
  METABOT_ROW_HINT_CLASS,
  METABOT_ROW_ICON_CLASS,
  METABOT_ROW_TITLE_CLASS,
} from './metaBotCardPresentation.js';

type HomepageMetaAppLoadStatus = 'idle' | 'loading' | 'loaded' | 'error';

const stripProtocolPrefix = (value: string, scheme: 'metaapp://' | 'metafile://') => {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';
  return trimmed.toLowerCase().startsWith(scheme)
    ? trimmed.slice(scheme.length).trim()
    : trimmed;
};

const protocolUriFromInput = (value: string, scheme: 'metaapp://' | 'metafile://') => {
  const ref = stripProtocolPrefix(value, scheme);
  return ref ? `${scheme}${ref}` : '';
};

const ownerMetaAppName = (record: OwnerMetaAppRecord) =>
  (record.appName || record.title || i18nService.t('metabotHomepageUntitledMetaApp')).trim();

export interface HomepageSectionValues {
  homepage_source: 'default' | 'metafile' | 'metaapp';
  homepage_metafile_uri: string;
  homepage_metafile_content_type: string;
  homepage_metaapp_pin: string;
}

export type HomepageSectionField = keyof HomepageSectionValues;

/** Compose the final homepage JSON string (or null) from current selection. Throws on invalid. */
export function composeHomepageForSave(values: HomepageSectionValues): string | null {
  if (values.homepage_source === 'default') return null;
  if (values.homepage_source === 'metafile') {
    const pin = stripProtocolPrefix(values.homepage_metafile_uri, 'metafile://');
    if (!pin) throw new Error(i18nService.t('metabotHomepageErrNoFile'));
    if (/\s/u.test(pin) || /:\/\//.test(pin)) {
      throw new Error(i18nService.t('metabotHomepageErrInvalidMetafilePin'));
    }
    const contentType = values.homepage_metafile_content_type.trim() || 'application/octet-stream';
    return JSON.stringify({ uri: `metafile://${pin}`, renderer: 'auto', contentType });
  }
  const stripped = stripProtocolPrefix(values.homepage_metaapp_pin, 'metaapp://');
  if (!stripped || /\s/u.test(stripped) || /:\/\//.test(stripped)) {
    throw new Error(i18nService.t('metabotHomepageErrInvalidPin'));
  }
  return JSON.stringify({ uri: `metaapp://${stripped}`, renderer: 'metaapp', contentType: 'application/vnd.metaapp' });
}

const homepageProtocolInputClass =
  'flex h-8 min-w-0 flex-1 items-center overflow-hidden rounded-[7px] border border-slate-900/[0.095] dark:border-white/[0.09] bg-[#f8fafc] dark:bg-[#131d2c] focus-within:border-claude-accent focus-within:ring-1 focus-within:ring-claude-accent';
const homepageProtocolPrefixClass =
  'flex h-full shrink-0 items-center border-r border-slate-900/[0.095] dark:border-white/[0.09] px-2 text-[11.5px] font-mono text-[#8c96a6] dark:text-[#64748b]';
const homepageProtocolFieldClass =
  'h-full min-w-0 flex-1 bg-transparent px-2 text-[12px] font-mono text-[#181d25] dark:text-[#f3f5f8] focus:outline-none';

interface MetaBotHomepageSectionProps {
  values: HomepageSectionValues;
  onChange: (field: HomepageSectionField, value: string) => void;
  /** Metabot id for homepage file upload / owner MetaApp listing. Null disables both. */
  metabotId?: number | null;
  /** Open the current Bot's default template homepage in Bot Browser. */
  onOpenDefaultHomepage?: () => void;
  /** Open a MetaApp homepage preview by its pin id (best-effort; browser may fail to resolve). */
  onPreviewMetaAppHomepage?: (pin: string) => Promise<boolean> | boolean;
  /** Open the MetaApps surface so the user can publish a MetaApp for this Bot. */
  onRequestMetaApps?: () => void;
  /** Scoped save button rendered cleanly inside the Homepage group footer. */
  saveAction?: React.ReactNode;
}

export const MetaBotHomepageSection: React.FC<MetaBotHomepageSectionProps> = ({
  values,
  onChange,
  metabotId,
  onOpenDefaultHomepage,
  onPreviewMetaAppHomepage,
  onRequestMetaApps,
  saveAction,
}) => {
  const homepageFileInputRef = useRef<HTMLInputElement>(null);
  const homepageMetaAppsRequestIdRef = useRef(0);
  const [homepageUploading, setHomepageUploading] = useState(false);
  const [homepageUploadError, setHomepageUploadError] = useState('');
  const [homepageMetaAppPickerOpen, setHomepageMetaAppPickerOpen] = useState(false);
  const [homepageMetaAppLoadStatus, setHomepageMetaAppLoadStatus] = useState<HomepageMetaAppLoadStatus>('idle');
  const [homepageMetaAppLoadError, setHomepageMetaAppLoadError] = useState('');
  const [homepageMetaAppRecords, setHomepageMetaAppRecords] = useState<OwnerMetaAppRecord[]>([]);

  useEffect(() => {
    homepageMetaAppsRequestIdRef.current += 1;
    setHomepageMetaAppPickerOpen(false);
    setHomepageMetaAppLoadStatus('idle');
    setHomepageMetaAppLoadError('');
    setHomepageMetaAppRecords([]);
  }, [metabotId]);

  const handleChange = (field: HomepageSectionField, value: string) => {
    onChange(field, value);
  };

  const handleHomepageSourceChange = (source: HomepageSectionValues['homepage_source']) => {
    handleChange('homepage_source', source);
    setHomepageMetaAppPickerOpen(false);
    setHomepageUploadError('');
  };

  const handleHomepageFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || metabotId == null) return;
    setHomepageUploading(true);
    setHomepageUploadError('');
    try {
      const reader = new FileReader();
      const base64 = await new Promise<string>((resolve, reject) => {
        reader.onload = () => {
          const result = String(reader.result || '');
          const m = /^data:[^;]+;base64,(.+)$/.exec(result);
          resolve(m ? m[1] : '');
        };
        reader.onerror = () => reject(new Error('read failed'));
        reader.readAsDataURL(file);
      });
      if (!base64) throw new Error('empty');
      const res = await window.electron.idbots.uploadMetabotHomepageFile({
        metabotId,
        fileName: file.name,
        contentType: file.type || undefined,
        base64,
      });
      if (!res.success || !res.metafileUri) {
        throw new Error(res.error || i18nService.t('metabotSaveFailed'));
      }
      handleChange('homepage_metafile_uri', res.metafileUri);
      handleChange('homepage_metafile_content_type', res.contentType || file.type || '');
      handleChange('homepage_source', 'metafile');
    } catch (err) {
      setHomepageUploadError(err instanceof Error ? err.message : String(err));
    } finally {
      setHomepageUploading(false);
      e.target.value = '';
    }
  };

  const loadHomepageMetaApps = useCallback(async () => {
    if (metabotId == null) {
      setHomepageMetaAppLoadStatus('loaded');
      setHomepageMetaAppRecords([]);
      return;
    }
    const requestId = ++homepageMetaAppsRequestIdRef.current;
    setHomepageMetaAppLoadStatus('loading');
    setHomepageMetaAppLoadError('');
    try {
      const result = await window.electron.metaappOwner.list({ metabotId, size: 24 });
      if (requestId !== homepageMetaAppsRequestIdRef.current) return;
      if (!result.success) {
        throw new Error(result.error || i18nService.t('metabotHomepageMetaAppsLoadFailed'));
      }
      setHomepageMetaAppRecords((result.records || []).filter((record) => Boolean(record.pinId)));
      setHomepageMetaAppLoadStatus('loaded');
    } catch (err) {
      if (requestId !== homepageMetaAppsRequestIdRef.current) return;
      setHomepageMetaAppRecords([]);
      setHomepageMetaAppLoadStatus('error');
      setHomepageMetaAppLoadError(err instanceof Error ? err.message : String(err));
    }
  }, [metabotId]);

  const openHomepageMetaAppPicker = () => {
    setHomepageMetaAppPickerOpen(true);
    void loadHomepageMetaApps();
  };

  const handleChooseHomepageMetaApp = (record: OwnerMetaAppRecord) => {
    handleChange('homepage_metaapp_pin', record.pinId);
    setHomepageMetaAppPickerOpen(false);
    setHomepageMetaAppLoadError('');
  };

  const homepageMetafilePin = stripProtocolPrefix(values.homepage_metafile_uri, 'metafile://');
  const homepageMetaAppPin = stripProtocolPrefix(values.homepage_metaapp_pin, 'metaapp://');

  return (
    <div>
      <div className={METABOT_GROUP_LABEL_ROW_CLASS}>
        <span className={METABOT_GROUP_LABEL_CLASS}>{i18nService.t('metabotHomepage')}</span>
        <span className={METABOT_GROUP_NOTE_CLASS}>{i18nService.t('metabotGroupHomepageNote')}</span>
      </div>

      <div className={METABOT_GROUP_BOX_CLASS}>
        <div className="px-4 py-3.5 flex flex-col gap-3">
          <div className="flex items-start gap-2.5">
            <GlobeAltIcon className={METABOT_ROW_ICON_CLASS} aria-hidden />
            <div className="min-w-0 flex-1">
              <label htmlFor="metabot-homepage" className={METABOT_ROW_TITLE_CLASS}>
                {i18nService.t('metabotHomepageSourceTitle')}
              </label>
            </div>
          </div>

          <div
            data-slot="metabot-homepage-control-row"
            className="flex min-w-0 flex-wrap sm:flex-nowrap items-center gap-2 sm:pl-[28px]"
          >
            <select
              id="metabot-homepage"
              value={values.homepage_source}
              onChange={(e) => handleHomepageSourceChange(e.target.value as HomepageSectionValues['homepage_source'])}
              className={`${METABOT_COMPACT_SELECT_CLASS} w-[8.75rem] shrink-0`}
            >
              <option value="default">{i18nService.t('metabotHomepageDefault')}</option>
              <option value="metafile">{i18nService.t('metabotHomepageMetafile')}</option>
              <option value="metaapp">{i18nService.t('metabotHomepageMetaapp')}</option>
            </select>

            {values.homepage_source === 'default' && (
              <div className="min-w-0 flex-1 flex items-center justify-between gap-2">
                <span className="text-[12px] text-[#5a6577] dark:text-[#94a3b8] truncate">
                  {i18nService.t('metabotHomepageDefaultDesc')}
                </span>
                {onOpenDefaultHomepage && (
                  <button
                    type="button"
                    data-slot="metabot-homepage-view"
                    onClick={onOpenDefaultHomepage}
                    className={METABOT_BTN_FLAT_CLASS}
                    title={i18nService.t('metabotHomepageView')}
                  >
                    <span>{i18nService.t('metabotHomepageView')}</span>
                    <ArrowTopRightOnSquareIcon className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            )}

            {values.homepage_source === 'metafile' && (
              <div className="min-w-0 flex-1 flex items-center gap-2">
                <input
                  ref={homepageFileInputRef}
                  type="file"
                  className="hidden"
                  onChange={handleHomepageFileChange}
                />
                <label className={homepageProtocolInputClass}>
                  <span className={homepageProtocolPrefixClass}>metafile://</span>
                  <input
                    type="text"
                    data-slot="metabot-homepage-metafile-pin"
                    value={homepageMetafilePin}
                    onChange={(e) => handleChange('homepage_metafile_uri', protocolUriFromInput(e.target.value, 'metafile://'))}
                    placeholder={i18nService.t('metabotHomepageMetafilePinPlaceholder')}
                    className={homepageProtocolFieldClass}
                  />
                </label>
                <button
                  type="button"
                  data-slot="metabot-homepage-metafile-upload"
                  onClick={() => homepageFileInputRef.current?.click()}
                  disabled={homepageUploading || metabotId == null}
                  className={METABOT_BTN_FLAT_CLASS}
                  title={metabotId == null ? i18nService.t('metabotHomepageMetafileDisabledHint') : undefined}
                >
                  {homepageUploading ? i18nService.t('metabotHomepageUploading') : i18nService.t('metabotHomepageMetafileUpload')}
                </button>
                {homepageUploadError && (
                  <p className="min-w-0 truncate text-xs text-red-500">{homepageUploadError}</p>
                )}
              </div>
            )}

            {values.homepage_source === 'metaapp' && (
              <div className="min-w-0 flex-1 flex items-center gap-2">
                <label className={homepageProtocolInputClass}>
                  <span className={homepageProtocolPrefixClass}>metaapp://</span>
                  <input
                    type="text"
                    data-slot="metabot-homepage-metaapp-pin"
                    value={homepageMetaAppPin}
                    onChange={(e) => handleChange('homepage_metaapp_pin', stripProtocolPrefix(e.target.value, 'metaapp://'))}
                    placeholder={i18nService.t('metabotHomepageMetaappPinPlaceholder')}
                    className={homepageProtocolFieldClass}
                  />
                </label>
                <div className="relative shrink-0">
                  <button
                    type="button"
                    data-slot="metabot-homepage-metaapp-select"
                    onClick={openHomepageMetaAppPicker}
                    disabled={metabotId == null}
                    aria-haspopup="dialog"
                    aria-expanded={homepageMetaAppPickerOpen}
                    className={METABOT_BTN_FLAT_CLASS}
                  >
                    {i18nService.t('metabotHomepageMetaappSelect')}
                  </button>
                  {homepageMetaAppPickerOpen && (
                    <div
                      data-slot="metabot-homepage-metaapp-picker"
                      role="dialog"
                      aria-label={i18nService.t('metabotHomepageMetaappSelect')}
                      className="absolute right-0 top-full z-30 mt-2 w-[min(24rem,calc(100vw-3rem))] overflow-hidden rounded-[10px] border border-slate-900/[0.12] dark:border-white/[0.12] dark:bg-[#182538] bg-white shadow-xl"
                    >
                      {homepageMetaAppLoadStatus === 'loading' && (
                        <div className="px-3 py-3 text-xs text-[#5a6577] dark:text-[#94a3b8]">
                          {i18nService.t('metabotHomepageLoadingMetaApps')}
                        </div>
                      )}
                      {homepageMetaAppLoadStatus === 'error' && (
                        <div className="flex flex-col gap-2 px-3 py-3 text-xs">
                          <p className="font-medium text-red-500 dark:text-red-400">
                            {i18nService.t('metabotHomepageMetaAppsLoadFailed')}
                          </p>
                          <p className="break-words text-[#5a6577] dark:text-[#94a3b8]">
                            {homepageMetaAppLoadError}
                          </p>
                          <button
                            type="button"
                            onClick={() => void loadHomepageMetaApps()}
                            className={METABOT_BTN_FLAT_CLASS}
                          >
                            {i18nService.t('retry')}
                          </button>
                        </div>
                      )}
                      {homepageMetaAppLoadStatus === 'loaded' && homepageMetaAppRecords.length === 0 && (
                        <div className="flex flex-col gap-2 px-3 py-3 text-xs text-[#5a6577] dark:text-[#94a3b8]">
                          <p className="font-semibold text-[#181d25] dark:text-[#f3f5f8]">
                            {i18nService.t('metabotHomepageNoMetaAppsTitle')}
                          </p>
                          <p>{i18nService.t('metabotHomepageNoMetaAppsMessage')}</p>
                          {onRequestMetaApps && (
                            <button
                              type="button"
                              onClick={onRequestMetaApps}
                              className="btn-idchat-primary-filled px-3 py-1.5 text-xs self-start"
                            >
                              {i18nService.t('metabotHomepageCreateMetaApp')}
                            </button>
                          )}
                        </div>
                      )}
                      {homepageMetaAppLoadStatus === 'loaded' && homepageMetaAppRecords.length > 0 && (
                        <div className="max-h-72 overflow-y-auto py-1">
                          {homepageMetaAppRecords.map((record) => (
                            <button
                              key={record.pinId}
                              type="button"
                              onClick={() => handleChooseHomepageMetaApp(record)}
                              className="flex w-full min-w-0 items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-[#eef1f5] dark:hover:bg-white/[0.06]"
                            >
                              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[6px] bg-[#eef1f5] dark:bg-white/[0.06] text-[11px] font-bold text-[#181d25] dark:text-[#f3f5f8]">
                                {ownerMetaAppName(record).slice(0, 2).toUpperCase()}
                              </span>
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-[12.5px] font-semibold text-[#181d25] dark:text-[#f3f5f8]">
                                  {ownerMetaAppName(record)}
                                </span>
                                <code className="block truncate text-[11px] text-[#8c96a6] dark:text-[#64748b]">
                                  {record.pinId}
                                </code>
                              </span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
                {onPreviewMetaAppHomepage && (
                  <button
                    type="button"
                    data-slot="metabot-homepage-metaapp-preview"
                    onClick={() => {
                      const pin = stripProtocolPrefix(values.homepage_metaapp_pin, 'metaapp://');
                      if (pin) void onPreviewMetaAppHomepage(pin);
                    }}
                    disabled={!homepageMetaAppPin}
                    className={METABOT_BTN_FLAT_CLASS}
                  >
                    {i18nService.t('metabotHomepageMetaappPreview')}
                  </button>
                )}
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 sm:pl-[28px]">
            <p data-slot="metabot-homepage-hint" className={`${METABOT_ROW_HINT_CLASS} !mt-0`}>
              {i18nService.t('metabotHomepageHint')}
            </p>
            {saveAction}
          </div>
        </div>
      </div>
    </div>
  );
};

export default MetaBotHomepageSection;
