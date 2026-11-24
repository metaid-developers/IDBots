import React, { useEffect } from 'react';
import { i18nService } from '../../services/i18n';
import { subscribeFloatwinYield } from '../../utils/floatwinRegistry';
import type { ProcessHubViewState } from '../../utils/processCenter';
import ProcessCenterPanel from './ProcessCenterPanel';

/**
 * 进程中心浮窗壳 (floatwin shell) — owner approval 2026-11-24 17:23 (M1=B, M2=A).
 *
 * SAME MECHANISM as Settings, THREE deliberate deviations (floatwin-outline §1.2):
 *
 *  1. 退场纪律 — the backdrop click does NOT close. This is a workbench, not a
 *     one-shot dialog; one stray click must not cost the tab / fold / scroll
 *     state. The exit is explicit: Esc + the top-right close button (+ yielding
 *     to another floatwin, which the registry handles).
 *  2. 形状归属 — the corner radius rides the v2 token (10px, `--shape-radius-md`)
 *     instead of copying Settings' 16px `rounded-2xl`, which would invent a
 *     fifth radius outside the 12/10/8/4 family.
 *  3. 让位 — if another floatwin opens (Settings), this one closes itself so two
 *     z-50 overlays are never on screen together.
 *
 * Geometry is the SAME as Settings — 900 × 80vh, centred, shadow-modal,
 * `modal-content` scale-in 0.2s over a `modal-backdrop` fade-in — i.e. zero new
 * numbers, and the panel inside is the untouched ProcessCenterPanel.
 */

export interface ProcessCenterFloatwinProps {
  onClose: () => void;
  onOpenProcess: (sessionId: string) => void;
  viewStateRef?: React.MutableRefObject<ProcessHubViewState>;
}

const ProcessCenterFloatwin: React.FC<ProcessCenterFloatwinProps> = ({
  onClose,
  onOpenProcess,
  viewStateRef,
}) => {
  // Esc is the floatwin's keyboard exit (Settings' shell has none — a workbench
  // surface is long-lived, so it needs one).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  // 让位: another floatwin opening closes this one (M1=B / process-hub §1.2).
  useEffect(() => subscribeFloatwinYield('process-center', onClose), [onClose]);

  return (
    <div
      data-testid="process-floatwin-backdrop"
      data-floatwin-backdrop-close="false"
      className="non-draggable fixed inset-0 z-50 modal-backdrop flex items-center justify-center"
      // NO onClick: 背板点击不关闭 is the ruling, not an omission.
    >
      <div
        data-testid="process-floatwin"
        data-floatwin-geometry="900x80vh"
        data-floatwin-radius="var(--shape-radius-md)"
        role="dialog"
        aria-modal="true"
        aria-label={i18nService.t('processCenterTitle')}
        className="flex h-[80vh] w-[900px] max-w-[calc(100vw-48px)] flex-col overflow-hidden rounded-[var(--shape-radius-md)] border border-claude-border bg-claude-bg shadow-modal modal-content dark:border-claude-darkBorder dark:bg-claude-darkBg"
      >
        <ProcessCenterPanel
          onOpenProcess={onOpenProcess}
          viewStateRef={viewStateRef}
          onRequestClose={onClose}
        />
      </div>
    </div>
  );
};

export default ProcessCenterFloatwin;
