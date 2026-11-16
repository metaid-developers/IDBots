import React, { useCallback, useRef, useState } from 'react';
import { i18nService } from '../../services/i18n';
import type { AppUpdateDownloadProgress } from '../../services/appUpdate';
import { formatBytes } from './format';

/** 悬停面板宽度（与 fixed 定位计算保持一致） */
const HOVER_PANEL_WIDTH = 280;
/** 悬停面板距按钮的垂直间距 */
const HOVER_PANEL_OFFSET = 8;
/** 估算面板高度，用于底部空间不足时向上翻转 */
const HOVER_PANEL_ESTIMATED_HEIGHT = 300;

interface AppUpdateBadgeProps {
  latestVersion: string;
  onClick: () => void;
  /** 自定义徽章文案（如 macOS 静默安装完成后的「更新已就绪」），缺省为「有新版本」 */
  label?: string;
  /** 非空时徽章显示后台下载进度（断点续传时显示「继续下载」） */
  progress?: AppUpdateDownloadProgress | null;
  /** error 时以警示色展示（如静默下载失败，提示将自动重试） */
  tone?: 'default' | 'error';
  /** 悬停时以浮层面板展示的内容（如当前语言的更新说明）；不传则不显示 */
  hoverPanel?: React.ReactNode;
}

const AppUpdateBadge: React.FC<AppUpdateBadgeProps> = ({
  latestVersion,
  onClick,
  label,
  progress,
  tone = 'default',
  hoverPanel,
}) => {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [panelPos, setPanelPos] = useState<{ x: number; y: number } | null>(null);

  const showPanel = useCallback(() => {
    if (!wrapperRef.current) return;
    const rect = wrapperRef.current.getBoundingClientRect();
    const padding = 8;
    const x = Math.min(
      Math.max(padding, rect.right - HOVER_PANEL_WIDTH),
      window.innerWidth - HOVER_PANEL_WIDTH - padding,
    );
    // 按钮位于侧边栏顶部，优先向下展开；底部空间不足时向上翻转
    const fitsBelow = rect.bottom + HOVER_PANEL_OFFSET + HOVER_PANEL_ESTIMATED_HEIGHT <= window.innerHeight - padding;
    const y = fitsBelow ? rect.bottom + HOVER_PANEL_OFFSET : rect.top - HOVER_PANEL_OFFSET - HOVER_PANEL_ESTIMATED_HEIGHT;
    setPanelPos({ x, y });
  }, []);

  const hidePanel = useCallback(() => {
    setPanelPos(null);
  }, []);

  const handleClick = () => {
    // 点击仍执行更新动作（打开更新弹窗），同时收起悬停面板
    hidePanel();
    onClick();
  };

  const percent = progress?.percent !== undefined && Number.isFinite(progress.percent)
    ? Math.round(progress.percent * 100)
    : undefined;
  const bytesDetail = progress
    ? progress.total !== undefined
      ? `${formatBytes(progress.received)} / ${formatBytes(progress.total)}`
      : formatBytes(progress.received)
    : '';

  let text: string;
  let title: string;
  if (progress) {
    const base = progress.resumed ? i18nService.t('updateResumingPill') : i18nService.t('updateDownloadingPill');
    text = percent !== undefined ? `${base} ${percent}%` : base;
    title = bytesDetail ? `${text} · ${bytesDetail}` : `${text} ${latestVersion}`;
  } else if (tone === 'error') {
    text = label ?? i18nService.t('updateDownloadFailedPill');
    title = `${i18nService.t('updateDownloadFailedTitle')} ${latestVersion}`;
  } else {
    text = label ?? i18nService.t('updateAvailablePill');
    title = `${text} ${latestVersion}`;
  }

  const isError = tone === 'error';
  const className = isError
    ? 'non-draggable inline-flex items-center gap-1.5 rounded-[var(--shape-radius-md)] border border-red-500/30 bg-red-500/12 px-3 py-1 text-xs font-medium text-red-600 hover:bg-red-500/18 dark:text-red-400 transition-colors'
    : 'non-draggable inline-flex items-center gap-1.5 rounded-[var(--shape-radius-md)] border border-emerald-500/30 bg-emerald-500/12 px-3 py-1 text-xs font-medium text-emerald-600 hover:bg-emerald-500/18 dark:text-emerald-400 transition-colors';

  return (
    // 面板作为 wrapper 的 DOM 子节点（fixed 定位），鼠标在按钮与面板间移动不会触发 leave。
    // 徽章位于侧边栏顶部的 .draggable 区域内；wrapper 自身必须显式声明 non-draggable，
    // 否则 Electron 的拖拽区域会吞掉 mouseenter/mouseleave，悬停面板永远不会出现。
    <div ref={wrapperRef} className="non-draggable relative inline-block" onMouseEnter={showPanel} onMouseLeave={hidePanel}>
      <button
        type="button"
        onClick={handleClick}
        className={className}
        title={title}
        aria-label={title}
      >
        <span className={`h-1.5 w-1.5 rounded-full ${isError ? 'bg-red-500 dark:bg-red-400' : 'bg-emerald-500 dark:bg-emerald-400'}`} />
        <span>{text}</span>
      </button>

      {panelPos && hoverPanel && (
        <div
          className="fixed z-50 rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface shadow-lg overflow-hidden"
          style={{ left: panelPos.x, top: panelPos.y, width: HOVER_PANEL_WIDTH }}
          role="tooltip"
        >
          {hoverPanel}
        </div>
      )}
    </div>
  );
};

export default AppUpdateBadge;
