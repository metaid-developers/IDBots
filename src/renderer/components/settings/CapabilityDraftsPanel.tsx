import React from 'react';
import { i18nService } from '../../services/i18n';

/**
 * Capability drafts list (memory/persona audit P1): the bot's dream-distilled
 * technique candidates with their verdict state — pending (draft), validated,
 * rejected — plus validation score, injection count, procedure-promotion mark
 * and the first-validation date. Read-only presentation: the periodic
 * re-review and the retention cleanup are nightly automations
 * (dreamService / memoryHygieneService), so this panel offers NO action
 * buttons. Data arrives through the dream:listCapabilityDrafts IPC.
 */

export interface CapabilityDraftItem {
  id: number;
  dreamDate: string;
  title: string;
  status: 'draft' | 'validated' | 'rejected' | string;
  validationScore: number | null;
  timesInjected: number;
  promotedAt: number | null;
  promotedProcedureId: string | null;
  validatedAt: number | null;
}

const STATUS_GROUPS: Array<{ status: 'validated' | 'draft' | 'rejected'; labelKey: string; badgeClass: string }> = [
  {
    status: 'validated',
    labelKey: 'capabilityDraftsStatusValidated',
    badgeClass: 'text-emerald-600 border-emerald-300 dark:text-emerald-400 dark:border-emerald-500/40',
  },
  {
    status: 'draft',
    labelKey: 'capabilityDraftsStatusDraft',
    badgeClass: 'text-amber-600 border-amber-300 dark:text-amber-400 dark:border-amber-500/40',
  },
  {
    status: 'rejected',
    labelKey: 'capabilityDraftsStatusRejected',
    badgeClass: 'dark:text-claude-darkTextSecondary text-claude-textSecondary dark:border-claude-darkBorder border-claude-border',
  },
];

function statusGroupOf(status: string): (typeof STATUS_GROUPS)[number] {
  return STATUS_GROUPS.find((group) => group.status === status) ?? STATUS_GROUPS[1];
}

function DraftRow({ draft }: { draft: CapabilityDraftItem }): React.ReactElement {
  const group = statusGroupOf(draft.status);
  const promoted = draft.promotedProcedureId != null;
  return (
    <div className="px-3 py-2 text-xs">
      <div className="flex items-start gap-2">
        <span className="flex-1 min-w-0 font-medium dark:text-claude-darkText text-claude-text break-words">
          {draft.title}
        </span>
        <span className={`rounded-full border px-2 py-0.5 flex-shrink-0 ${group.badgeClass}`}>
          {i18nService.t(group.labelKey)}
        </span>
        {promoted && (
          <span className="rounded-full border px-2 py-0.5 flex-shrink-0 text-sky-600 border-sky-300 dark:text-sky-400 dark:border-sky-500/40">
            {i18nService.t('capabilityDraftsPromoted')}
          </span>
        )}
      </div>
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 dark:text-claude-darkTextSecondary text-claude-textSecondary">
        {draft.validationScore != null && (
          <span>{`${i18nService.t('capabilityDraftsScore')}: ${draft.validationScore.toFixed(2)}`}</span>
        )}
        <span>{`${i18nService.t('capabilityDraftsInjections')}: ${draft.timesInjected}`}</span>
        {draft.validatedAt != null && (
          <span>{`${i18nService.t('capabilityDraftsValidatedAt')}: ${new Date(draft.validatedAt).toLocaleDateString()}`}</span>
        )}
      </div>
    </div>
  );
}

export default function CapabilityDraftsPanel(props: {
  drafts: CapabilityDraftItem[];
  loading?: boolean;
}): React.ReactElement {
  const { drafts, loading } = props;
  return (
    <div className="rounded-lg border dark:border-claude-darkBorder border-claude-border">
      <div className="px-3 py-2 border-b dark:border-claude-darkBorder border-claude-border">
        <div className="text-xs font-medium dark:text-claude-darkText text-claude-text">
          {i18nService.t('capabilityDraftsTitle')}
          {drafts.length > 0 ? ` (${drafts.length})` : ''}
        </div>
        <div className="mt-0.5 text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
          {i18nService.t('capabilityDraftsHint')}
        </div>
      </div>
      {loading ? (
        <div className="px-3 py-3 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">{i18nService.t('loading')}</div>
      ) : drafts.length === 0 ? (
        <div className="px-3 py-3 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">{i18nService.t('capabilityDraftsEmpty')}</div>
      ) : (
        <div className="max-h-[320px] overflow-auto">
          {STATUS_GROUPS.map((group) => {
            const entries = drafts.filter((draft) => statusGroupOf(draft.status) === group);
            if (entries.length === 0) return null;
            return (
              <div key={group.status}>
                <div className="px-3 py-1.5 text-[11px] font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary dark:bg-claude-darkSurfaceHover bg-claude-surfaceHover">
                  {`${i18nService.t(group.labelKey)} (${entries.length})`}
                </div>
                <div className="divide-y dark:divide-claude-darkBorder divide-claude-border">
                  {entries.map((draft) => (
                    <DraftRow key={draft.id} draft={draft} />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
