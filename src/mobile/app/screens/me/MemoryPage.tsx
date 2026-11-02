import { t } from '../../../i18n';
import { useMemorySettings } from '../../hooks/useMemorySettings';
import { Switch } from '../../components/Switch';
import { SecondaryPageShell } from './SecondaryPageShell';

const MEMORY_ROWS = [
  { field: 'memoryEnabled' as const, labelKey: 'mobile.me.memoryEnabled' },
  { field: 'memoryImplicitUpdateEnabled' as const, labelKey: 'mobile.me.memoryImplicitUpdate' },
  { field: 'memoryLlmJudgeEnabled' as const, labelKey: 'mobile.me.memoryLlmJudge' },
];

/**
 * memory secondary page (IA-PLAN v1 §4.7): the three global switches only.
 * Instant-save semantics are preserved from the old flat SettingsSection
 * (IA-PLAN §2.5 rule 1); the advanced policy area stays desktop-only (§3.4).
 */
export function MemoryPage(props: { onBack: () => void }): JSX.Element {
  const memory = useMemorySettings();
  return (
    <SecondaryPageShell title={t('mobile.me.entry.memory')} onBack={props.onBack} testId="me-page-memory">
      <p className="px-1 text-xs leading-5 text-[var(--text-secondary)]">{t('mobile.me.memoryIntro')}</p>
      <div className="twin-panel twin-panel-padded">
        {memory.loading ? <p className="py-2 text-sm text-[var(--text-secondary)]">{t('mobile.common.loading')}</p> : null}
        {MEMORY_ROWS.map((row) => (
          <div
            key={row.field}
            data-testid={`memory-row-${row.field}`}
            className="twin-list-row"
          >
            <span className="text-sm text-[var(--text-primary)]">{t(row.labelKey)}</span>
            <Switch
              checked={memory.config?.[row.field] ?? false}
              disabled={memory.loading || !memory.config || memory.saving !== null}
              onChange={(checked) => void memory.setEnabled(row.field, checked)}
              label={t(row.labelKey)}
            />
          </div>
        ))}
        {memory.error ? (
          <div className="mt-2 flex items-center justify-between gap-2">
            <p className="text-xs text-red-600">{memory.error}</p>
            <button
              type="button"
              onClick={() => void memory.reload()}
              className="min-h-[44px] px-2 text-xs text-[var(--text-primary)]"
            >
              {t('mobile.common.retry')}
            </button>
          </div>
        ) : null}
        {memory.saved ? (
          <p aria-live="polite" className="mt-2 text-xs text-emerald-600">{t('mobile.me.settingsSaved')}</p>
        ) : null}
      </div>
    </SecondaryPageShell>
  );
}
