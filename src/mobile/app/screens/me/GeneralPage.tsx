import { t } from '../../../i18n';
import type { MobileLanguage } from '../../../i18n';
import { useSettings } from '../../hooks/useSettings';
import { SecondaryPageShell } from './SecondaryPageShell';

function Segmented<T extends string>(props: {
  value: T;
  options: Array<{ value: T; labelKey: string }>;
  onChange: (value: T) => void;
  disabled?: boolean;
}): JSX.Element {
  return (
    <div className="twin-segmented">
      {props.options.map((option) => (
        <button
          key={option.value}
          type="button"
          disabled={props.disabled}
          aria-pressed={props.value === option.value}
          onClick={() => props.onChange(option.value)}
          className="twin-segment"
        >
          {t(option.labelKey)}
        </button>
      ))}
    </div>
  );
}

/**
 * general secondary page (IA-PLAN v1 §4.8): language + theme, ported
 * verbatim from the old flat SettingsSection (instant-save, three-state
 * save feedback). Desktop's chat-experience mode / auto-launch / sleep /
 * experimental switches stay out of the mobile scope (§3.2).
 */
export function GeneralPage(props: { onBack: () => void }): JSX.Element {
  const { language, theme, saveState, changeLanguage, changeTheme } = useSettings();
  return (
    <SecondaryPageShell title={t('mobile.me.entry.general')} onBack={props.onBack} testId="me-page-general">
      <div className="twin-panel twin-panel-padded">
        <p className="mb-2 text-xs font-medium uppercase text-[var(--text-secondary)]">{t('mobile.me.languageLabel')}</p>
        <Segmented<MobileLanguage>
          value={language}
          options={[
            { value: 'zh', labelKey: 'mobile.me.languageZh' },
            { value: 'en', labelKey: 'mobile.me.languageEn' },
          ]}
          disabled={saveState.status === 'saving'}
          onChange={(value) => void changeLanguage(value)}
        />
        <p className="mb-2 mt-4 text-xs font-medium uppercase text-[var(--text-secondary)]">{t('mobile.me.themeLabel')}</p>
        <Segmented<'light' | 'dark' | 'system'>
          value={theme}
          options={[
            { value: 'light', labelKey: 'mobile.me.themeLight' },
            { value: 'dark', labelKey: 'mobile.me.themeDark' },
            { value: 'system', labelKey: 'mobile.me.themeSystem' },
          ]}
          disabled={saveState.status === 'saving'}
          onChange={(value) => void changeTheme(value)}
        />
        {saveState.status !== 'idle' ? (
          <p
            aria-live="polite"
            data-testid="general-save-state"
            className={`mt-2 text-xs ${saveState.status === 'error' ? 'text-red-600' : 'text-[var(--text-secondary)]'}`}
          >
            {t(`mobile.me.settings${saveState.status === 'saving' ? 'Saving' : saveState.status === 'saved' ? 'Saved' : 'SaveFailed'}`)}
          </p>
        ) : null}
      </div>
    </SecondaryPageShell>
  );
}
