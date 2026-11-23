import { useState } from 'react';
import { t } from '../../../i18n';
import type { MobileBotInput } from '../../hooks/useMetabots';
import { useMetabots, type BotOperationResult } from '../../hooks/useMetabots';
import type { EditorBrainOption } from '../../components/BotEditorForm';
import { BotEditorForm } from '../../components/BotEditorForm';
import { SecondaryPageShell } from './SecondaryPageShell';

/**
 * botEdit third-level page (IA-PLAN v1 §2.1/§4.5): the full desktop-aligned
 * editor (A5 form) pushed as a page instead of a sheet. Explicit save; the
 * dirty flag is surfaced to the Me screen so back navigation asks before
 * discarding (§2.5 rule 2).
 */
export function BotEditPage(props: {
  botId: number | null;
  onBack: () => void;
  onSaved: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  onOpenSession?: (sessionId: string) => Promise<boolean>;
  onOpenSubscribe?: () => void;
  initialTab?: import('../../components/BotEditorForm').EditorTabKey;
  initialSurfRunId?: string;
}): JSX.Element {
  const manager = useMetabots();
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<BotOperationResult | null>(null);
  const bot = props.botId === null ? null : manager.bots.find((entry) => entry.id === props.botId) ?? null;

  const brainOptions: EditorBrainOption[] = manager.modelGroups.flatMap((group) => group.models.map((model) => ({
    providerKey: group.id,
    modelId: model.id,
    label: `${group.name} · ${model.name}`,
  })));

  return (
    <SecondaryPageShell title={t('mobile.me.botEdit')} onBack={props.onBack} testId="me-page-bot-edit">
      {manager.loading && !bot ? (
        <p className="py-6 text-center text-sm text-[var(--text-secondary)]">{t('mobile.common.loading')}</p>
      ) : null}
      {!manager.loading && !bot ? (
        <p className="py-6 text-center text-sm text-[var(--text-secondary)]">{t('mobile.me.botsMissing')}</p>
      ) : null}
      {bot ? (
        <BotEditorForm
          key={bot.id}
          state={{ bot, busy, outcome }}
          brainOptions={brainOptions}
          skills={manager.skills}
          catalogError={manager.catalogError}
          getBalance={manager.getBotBalance}
          onDirtyChange={props.onDirtyChange}
          automationActions={manager}
          onOpenSession={props.onOpenSession}
          onOpenSubscribe={props.onOpenSubscribe}
          initialTab={props.initialTab}
          initialSurfRunId={props.initialSurfRunId}
          onClose={props.onBack}
          onSave={async (input: MobileBotInput) => {
            setBusy(true);
            setOutcome(null);
            const result = await manager.updateBot(bot.id, input);
            if (result.state === 'synced') {
              props.onDirtyChange?.(false);
              setBusy(false);
              props.onSaved();
              return;
            }
            setBusy(false);
            setOutcome(result);
          }}
        />
      ) : null}
    </SecondaryPageShell>
  );
}
