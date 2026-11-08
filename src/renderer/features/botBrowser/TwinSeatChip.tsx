import React from 'react';
import TwinBadge from '../../components/metabots/TwinBadge';
import { i18nService } from '../../services/i18n';

/**
 * Identity + seat control for the Bot Internet co-work panel footer.
 *
 * Draft state: the chip is the appointment control (owner ruling 2026-11-08)
 * — clicking it opens the seat menu listing every local bot; the acting Twin
 * row is disabled and carries the Twin badge. Live state: the chip is a fixed
 * identity label — an acting transcript never changes actors mid-flight, and
 * legacy sessions keep showing the bot they were started with.
 *
 * The component is intentionally presentational: the appointment sequence,
 * rollback and toast text live in twinSeatAppointment.ts so they can be
 * covered by mock-IPC unit tests instead of clicking the real roster.
 */

export interface TwinSeatChipBot {
  id: number;
  name: string;
  avatar: string | null;
  metabot_type: string;
  role?: string;
}

interface TwinSeatChipProps {
  /** The bot the footer currently shows (acting Twin, or a legacy session bot). */
  chipMetabot: TwinSeatChipBot;
  /** Every local bot, in roster order. */
  roster: readonly TwinSeatChipBot[];
  /** Live session => display-only chip. */
  live: boolean;
  /** An appointment write is in flight; chip and menu rows are disabled. */
  busy: boolean;
  menuOpen: boolean;
  onToggleMenu: () => void;
  onAppoint: (bot: TwinSeatChipBot) => void;
}

const ChipIdentity: React.FC<{ metabot: TwinSeatChipBot }> = ({ metabot }) => (
  <>
    {metabot.avatar && (metabot.avatar.startsWith('data:') || metabot.avatar.startsWith('http')) ? (
      <img src={metabot.avatar} alt="" className="h-5 w-5 rounded-md object-cover flex-shrink-0" />
    ) : (
      <div className="h-5 w-5 rounded-md dark:bg-claude-darkSurfaceHover bg-claude-surfaceHover flex items-center justify-center flex-shrink-0">
        <span className="text-[8px] font-semibold dark:text-claude-darkText text-claude-text uppercase">
          {metabot.name.slice(0, 2) || '?'}
        </span>
      </div>
    )}
    <span className="truncate text-xs font-medium dark:text-claude-darkText text-claude-text">
      {metabot.name}
    </span>
  </>
);

const TwinSeatChip: React.FC<TwinSeatChipProps> = ({
  chipMetabot,
  roster,
  live,
  busy,
  menuOpen,
  onToggleMenu,
  onAppoint,
}) => (
  <div className="relative flex min-w-0 max-w-[60%] items-center gap-1.5">
    {live ? (
      <div className="flex min-w-0 items-center gap-1.5" title={chipMetabot.name}>
        <ChipIdentity metabot={chipMetabot} />
        {chipMetabot.metabot_type === 'twin' && <TwinBadge className="shrink-0" />}
      </div>
    ) : (
      <>
        <button
          type="button"
          disabled={busy}
          aria-label={i18nService.t('botInternetTwinSeatChip')}
          title={i18nService.t('botInternetTwinSeatChip')}
          aria-expanded={menuOpen}
          aria-haspopup="menu"
          onClick={onToggleMenu}
          className="flex min-w-0 items-center gap-1.5 rounded-md px-0.5 py-0.5 transition-colors hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover disabled:opacity-60"
        >
          <ChipIdentity metabot={chipMetabot} />
          {chipMetabot.metabot_type === 'twin' && <TwinBadge className="shrink-0" />}
          <svg viewBox="0 0 12 12" aria-hidden className="h-3 w-3 shrink-0 dark:text-claude-darkTextSecondary text-claude-textSecondary">
            <path d="M2 7.5 6 3.5l4 4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        {menuOpen && (
          <div
            role="menu"
            className="absolute bottom-full left-0 z-40 mb-2 w-72 rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface p-2 shadow-lg"
          >
            <p className="px-1 pb-1 text-xs font-medium dark:text-claude-darkText text-claude-text">
              {i18nService.t('botInternetTwinSeatTitle')}
            </p>
            <div className="max-h-52 overflow-y-auto">
              {roster.map((metabot) => {
                const isActing = metabot.metabot_type === 'twin';
                return (
                  <button
                    key={metabot.id}
                    type="button"
                    role="menuitem"
                    disabled={busy || isActing}
                    onClick={() => onAppoint(metabot)}
                    className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors ${
                      isActing
                        ? 'dark:bg-claude-darkSurfaceHover bg-claude-surfaceHover dark:text-claude-darkText text-claude-text'
                        : 'dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover hover:text-claude-text dark:hover:text-claude-darkText'
                    } disabled:cursor-default disabled:opacity-70`}
                  >
                    <span className="h-5 w-5 shrink-0">
                      {metabot.avatar && (metabot.avatar.startsWith('data:') || metabot.avatar.startsWith('http')) ? (
                        <img src={metabot.avatar} alt="" className="h-5 w-5 rounded-md object-cover" />
                      ) : (
                        <span className="flex h-5 w-5 items-center justify-center rounded-md dark:bg-claude-darkSurfaceHover bg-claude-surfaceHover">
                          <span className="text-[8px] font-semibold uppercase dark:text-claude-darkText text-claude-text">
                            {metabot.name.slice(0, 2) || '?'}
                          </span>
                        </span>
                      )}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-medium">{metabot.name}</span>
                    {metabot.role && (
                      <span className="min-w-0 max-w-[45%] truncate text-[10px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
                        {metabot.role}
                      </span>
                    )}
                    {isActing && <TwinBadge className="shrink-0" />}
                  </button>
                );
              })}
            </div>
            <p className="px-1 pt-1 text-[10px] leading-4 dark:text-claude-darkTextSecondary text-claude-textSecondary">
              {i18nService.t('botInternetTwinSeatHint')}
            </p>
          </div>
        )}
      </>
    )}
  </div>
);

export default TwinSeatChip;
