/**
 * Bottom-left version block — the ONE update control surface (owner order
 * 2026-11-21 17:46, restoring the 17:25 module and superseding the 17:29
 * in-Settings sub-panel).
 *
 * The block shows the running version; a 6 px red dot marks a known update.
 * Clicking it opens a popover that carries everything:
 *   - the current status line (same resolver as the Settings row),
 *   - the whats-new highlights (3 items + expand, when a changelog exists),
 *   - 「现在更新」/「立即安装」 when an update is waiting,
 *   - the manual 「检查更新」 action (checking / up-to-date / found),
 *   - the 「自动检查更新」 switch.
 *
 * Settings' General row is a STATUS row only; it opens this same popover, so
 * the app never grows a third duplicated control surface. All controls read
 * the one App-owned state, which is why toggling here or checking here updates
 * the Settings row (and vice versa) without any extra wiring.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { i18nService } from '../../services/i18n';
import type { UpdateCheckResult } from '../../services/appUpdateCheck';
import type { ChangeLogEntry } from '../../services/appUpdate';
import type { UpdateStatus } from '../../services/softwareUpdateStatus';
import { formatUpdateStatus, selectChangeLogPreview } from '../../services/softwareUpdateStatus';

const PANEL_WIDTH = 288;
const PANEL_GAP = 8;

interface RailUpdateModuleProps {
  /** Shared status descriptor (same one the Settings row prints). */
  status: UpdateStatus;
  /** Red dot: an update is known and not yet handed to the installer. */
  showDot: boolean;
  autoCheckUpdates: boolean;
  onToggleAutoCheckUpdates: (enabled: boolean) => void;
  onCheckForUpdate: () => Promise<UpdateCheckResult>;
  /** Opens the existing update modal (立即更新 / 暂不 or install/restart). */
  onOpenUpdate: () => void;
  /** Language-resolved changelog of the known update, when there is one. */
  changeLog?: ChangeLogEntry | null;
  /** Controlled open state: the Settings status row opens this same popover. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const RailUpdateModule: React.FC<RailUpdateModuleProps> = ({
  status,
  showDot,
  autoCheckUpdates,
  onToggleAutoCheckUpdates,
  onCheckForUpdate,
  onOpenUpdate,
  changeLog = null,
  open,
  onOpenChange,
}) => {
  const [version, setVersion] = useState('');
  const [checking, setChecking] = useState(false);
  const [showAllHighlights, setShowAllHighlights] = useState(false);
  const [panelPos, setPanelPos] = useState<{ left: number; bottom: number } | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    window.electron.appInfo.getVersion()
      .then((current) => {
        if (!cancelled) setVersion(current);
      })
      .catch(() => {
        // The version label is informational; a failed read leaves the placeholder.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Position the popover above the block every time it opens — including when
  // the Settings row opened it (the button is always visible at bottom-left).
  useEffect(() => {
    if (!open) return;
    const button = wrapperRef.current?.querySelector('button');
    const rect = button?.getBoundingClientRect();
    if (!rect) {
      setPanelPos({ left: PANEL_GAP, bottom: PANEL_GAP });
      return;
    }
    setPanelPos({
      left: Math.min(
        Math.max(PANEL_GAP, rect.right + PANEL_GAP),
        window.innerWidth - PANEL_WIDTH - PANEL_GAP,
      ),
      bottom: Math.max(PANEL_GAP, window.innerHeight - rect.bottom),
    });
  }, [open]);

  // Outside click / Escape close the popover (the controlled owner decides).
  useEffect(() => {
    if (!open) return;
    const handleMouseDown = (event: MouseEvent) => {
      if (
        wrapperRef.current
        && event.target instanceof Node
        && wrapperRef.current.contains(event.target)
      ) {
        return;
      }
      onOpenChange(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onOpenChange(false);
    };
    document.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open, onOpenChange]);

  const handleCheck = useCallback(async () => {
    if (checking) return;
    setChecking(true);
    try {
      await onCheckForUpdate();
    } finally {
      setChecking(false);
    }
  }, [checking, onCheckForUpdate]);

  const statusText = formatUpdateStatus(status, version, (key) => i18nService.t(key));
  const allHighlights = (changeLog?.content ?? []).filter((item) => item.trim().length > 0);
  const highlights = selectChangeLogPreview(allHighlights, 3);
  const readyToInstall = status.kind === 'ready' || status.kind === 'restart-ready';
  const canUpdateNow = status.kind === 'found' || readyToInstall;

  const openUpdateModal = () => {
    onOpenChange(false);
    onOpenUpdate();
  };

  return (
    <div ref={wrapperRef} className="non-draggable relative flex flex-col items-center">
      <button
        type="button"
        data-slot="rail-update-module"
        onClick={() => onOpenChange(!open)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={i18nService.t('softwareUpdate')}
        title={`${i18nService.t('softwareUpdate')}${version ? ` · v${version}` : ''}`}
        className="relative inline-flex items-center justify-center rounded-md px-1 py-0.5 text-[10px] leading-none tabular-nums dark:text-claude-darkTextSecondary/80 text-claude-textSecondary/80 hover:text-claude-text dark:hover:text-claude-darkText transition-colors"
      >
        <span data-slot="rail-update-version">{version ? `v${version}` : 'v—'}</span>
        {showDot && (
          <span
            data-slot="rail-update-dot"
            role="img"
            aria-label={i18nService.t('softwareUpdateDotLabel')}
            className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-red-500 dark:bg-red-400"
          />
        )}
      </button>

      {open && panelPos && (
        <div
          data-slot="rail-update-panel"
          role="dialog"
          aria-label={i18nService.t('softwareUpdate')}
          className="fixed z-50 rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface shadow-lg p-3"
          style={{ left: panelPos.left, bottom: panelPos.bottom, width: PANEL_WIDTH }}
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold dark:text-claude-darkText text-claude-text">
              {i18nService.t('softwareUpdate')}
            </span>
            <span className="text-[11px] tabular-nums dark:text-claude-darkTextSecondary text-claude-textSecondary">
              {version ? `v${version}` : ''}
            </span>
          </div>

          <p
            data-slot="rail-update-status"
            className="mt-2 text-xs leading-snug dark:text-claude-darkTextSecondary text-claude-textSecondary"
          >
            {statusText}
          </p>

          {changeLog && (changeLog.title || highlights.visible.length > 0) && (
            <div data-slot="rail-update-highlights" className="mt-3">
              <p className="text-xs font-medium dark:text-claude-darkText text-claude-text">
                {changeLog.title || i18nService.t('softwareUpdateHighlights')}
              </p>
              <ul className="mt-1.5 space-y-1">
                {(showAllHighlights ? allHighlights : highlights.visible).map((item, index) => (
                  <li
                    key={`${index}-${item.slice(0, 12)}`}
                    className="flex items-start gap-1.5 text-[11px] leading-snug dark:text-claude-darkTextSecondary text-claude-textSecondary"
                  >
                    <span className="mt-1.5 h-1 w-1 flex-shrink-0 rounded-full bg-claude-accent/60" />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
              {highlights.hiddenCount > 0 && (
                <button
                  type="button"
                  data-slot="rail-update-highlights-toggle"
                  onClick={() => setShowAllHighlights((current) => !current)}
                  className="mt-1.5 text-[11px] text-claude-accent hover:underline"
                >
                  {showAllHighlights
                    ? i18nService.t('softwareUpdateShowLess')
                    : i18nService.t('softwareUpdateShowAll').replace('{count}', String(highlights.hiddenCount))}
                </button>
              )}
            </div>
          )}

          {canUpdateNow && (
            <button
              type="button"
              data-slot="rail-update-now"
              onClick={openUpdateModal}
              className="mt-3 w-full btn-idchat-primary-filled text-xs py-1.5"
            >
              {readyToInstall ? i18nService.t('updateInstallNow') : i18nService.t('softwareUpdateNow')}
            </button>
          )}

          <button
            type="button"
            data-slot="rail-update-check"
            onClick={() => void handleCheck()}
            disabled={checking}
            className={`mt-2 w-full px-3 py-1.5 text-xs inline-flex items-center justify-center rounded-[var(--shape-radius-md)] border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors ${
              checking ? 'opacity-50 cursor-not-allowed' : ''
            }`}
          >
            {checking ? i18nService.t('checkingForUpdates') : i18nService.t('checkForUpdates')}
          </button>

          <div className="mt-3 flex items-center justify-between gap-2">
            <span className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
              {i18nService.t('softwareUpdateAutoTitle')}
            </span>
            <button
              type="button"
              role="switch"
              data-slot="rail-update-auto-toggle"
              aria-checked={autoCheckUpdates}
              aria-label={i18nService.t('softwareUpdateAutoTitle')}
              onClick={() => onToggleAutoCheckUpdates(!autoCheckUpdates)}
              className={`relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors ${
                autoCheckUpdates ? 'bg-claude-accent' : 'bg-gray-300 dark:bg-gray-600'
              }`}
            >
              <span
                className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                  autoCheckUpdates ? 'translate-x-5' : 'translate-x-0.5'
                }`}
              />
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default RailUpdateModule;
