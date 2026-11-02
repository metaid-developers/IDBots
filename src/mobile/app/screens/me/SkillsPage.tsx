import { t } from '../../../i18n';
import { useSkills } from '../../hooks/useSkills';
import { Switch } from '../../components/Switch';
import { SecondaryPageShell } from './SecondaryPageShell';

/**
 * skills secondary page (IA-PLAN v1 §4.6): installed-skills toggles only.
 * The official/community marketplace is deliberately NOT built this cycle
 * (IA-PLAN §3.6 + owner Q3: deferred); the gray footer note says so.
 */
export function SkillsPage(props: { onBack: () => void }): JSX.Element {
  const { skills, setEnabled } = useSkills();
  return (
    <SecondaryPageShell title={t('mobile.me.entry.skills')} onBack={props.onBack} testId="me-page-skills">
      <div className="twin-panel twin-panel-padded">
        {skills.length === 0 ? (
          <p className="py-4 text-center text-sm text-[var(--text-secondary)]" data-testid="skills-empty">
            {t('mobile.me.skillsEmpty')}
          </p>
        ) : (
          skills.map((skill) => (
            <div
              key={skill.id}
              data-testid={`skills-row-${skill.id}`}
              className="twin-list-row"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-[15px] text-[var(--text-primary)]">{skill.name}</p>
                {skill.description ? (
                  <p className="truncate text-xs text-[var(--text-secondary)]">{skill.description}</p>
                ) : null}
              </div>
              <Switch
                checked={skill.enabled}
                onChange={(checked) => void setEnabled(skill.id, checked)}
                label={`${skill.name} · ${t('mobile.tasks.enabled')}`}
              />
            </div>
          ))
        )}
      </div>
      <p className="px-1 text-xs text-[var(--text-secondary)]">{t('mobile.me.skillsMarketNote')}</p>
    </SecondaryPageShell>
  );
}
