import React from 'react';
import { i18nService } from '../../services/i18n';
import type { BotBrowserSurfaceMode } from './types';

interface BotBrowserModeSwitchProps {
  mode: BotBrowserSurfaceMode;
  onSelectHome: () => void;
  onSelectBrowser: () => void;
}

/**
 * The ONE surface switcher, restored to the IDBots baseline segmented form
 * (owner ruling 2026-11-08 22:19, image A: the baseline left-sidebar control;
 * source reference `git show 91e2cfd43:src/renderer/features/botBrowser/BotBrowserModeSwitch.tsx`).
 *
 * Two equal cells in one bordered tray, the current surface filled with the
 * yellow primary capsule (`btn-idchat-primary-filled`), the other transparent.
 * Text only — no logo, no icons, no menu. Labels are the finalized surface
 * names (BotHub | BotWorks), and the group's accessible name spells both, so
 * assistive tech hears the new vocabulary too.
 *
 * Both faces mount this same component in the same place: directly below the
 * traffic-light strip, spanning the first content column. Switching semantics
 * are untouched: the buttons still call onSelectBrowser / onSelectHome and
 * expose their state through aria-pressed.
 */
const tabClass = (active: boolean) => [
  'non-draggable inline-flex h-8 min-w-0 items-center justify-center rounded-md px-2 text-xs font-medium leading-none transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-claude-accent/40',
  active
    ? 'btn-idchat-primary-filled still'
    : 'text-claude-textSecondary hover:bg-claude-surfaceHover/70 hover:text-claude-text dark:text-claude-darkTextSecondary dark:hover:bg-claude-darkSurfaceHover/70 dark:hover:text-claude-darkText',
].join(' ');

const BotBrowserModeSwitch: React.FC<BotBrowserModeSwitchProps> = ({
  mode,
  onSelectHome,
  onSelectBrowser,
}) => {
  const browserLabel = i18nService.t('botInternet');
  const homeLabel = i18nService.t('botHome');
  return (
    <div data-slot="bot-browser-mode-bar" className="w-full">
      <div
        data-slot="bot-browser-mode-segments"
        role="group"
        aria-label={`${i18nService.t('surfaceSwitcherLabel')}: ${browserLabel} / ${homeLabel}`}
        className="non-draggable grid w-full grid-cols-2 gap-1 rounded-lg border border-claude-border/70 bg-claude-bg/80 p-1 dark:border-claude-darkBorder/70 dark:bg-claude-darkBg/80"
      >
        <button
          type="button"
          data-slot="surface-switch-option"
          data-surface="browser"
          aria-pressed={mode === 'browser'}
          className={tabClass(mode === 'browser')}
          onClick={onSelectBrowser}
        >
          {browserLabel}
        </button>
        <button
          type="button"
          data-slot="surface-switch-option"
          data-surface="home"
          aria-pressed={mode === 'home'}
          className={tabClass(mode === 'home')}
          onClick={onSelectHome}
        >
          {homeLabel}
        </button>
      </div>
    </div>
  );
};

export default BotBrowserModeSwitch;
