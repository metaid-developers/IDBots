import React from 'react';

/**
 * macOS mini traffic lights (owner ruling 2026-11-14, the WeChat-style route).
 *
 * The native lights' size is system-pinned — reposition options only ever
 * MOVED them — so main.ts hides the native buttons (titleBarStyle 'hidden' +
 * setWindowButtonVisibility(false) after creation) and this component draws
 * the WeChat-scale dots in their place: three 8px circles, the macOS
 * red/amber/green convention, 8px apart, riding the mid column's 52px top
 * strip (BotBrowserModeSwitch surface-header-top-gap, shared by BOTH faces)
 * with the same 12px left-inset rhythm the native reposition used relative
 * to its column edge.
 *
 * The strip is a window-drag handle (surface-header carries `draggable`) and
 * the container repeats the annotation; each dot annotates `non-draggable`
 * so the three clicks stay clicks (Blink subtracts annotated subtrees from
 * the drag region — the same mechanism UserProfilePage relies on).
 *
 * Clicks ride the EXISTING window-control IPC surface, no new channels:
 * preload `window.close/minimize/toggleMaximize` → the `window-close` /
 * `window-minimize` / `window-maximize` send channels → the ipcMain.on
 * handlers in main.ts (already allowlisted + contract-tested). "Zoom" is the
 * macOS green-dot semantic; the bridge verb is toggleMaximize.
 *
 * Non-darwin platforms render nothing — the Windows/Linux titlebar chrome
 * (WindowTitleBar) and the native titlebar behavior stay untouched.
 */

/** Dot diameter, in px (WeChat scale; system lights cannot be resized). */
export const MAC_LIGHT_DOT_PX = 8;
/** Dot-to-dot spacing, in px (compact WeChat rhythm). */
export const MAC_LIGHT_DOT_GAP_PX = 8;
/** Left inset from the mid column's edge, in px (the old reposition rhythm). */
export const MAC_LIGHT_INSET_PX = 12;

/** macOS convention dot colors (red / amber / green). */
export const MAC_LIGHT_DOT_COLORS = {
  close: '#FF5F57',
  minimize: '#FEBC2E',
  zoom: '#28C840',
} as const;

export type MacWindowAction = 'close' | 'minimize' | 'zoom';

interface MacWindowLightsProps {
  /**
   * Test override for the platform probe. At runtime the platform comes from
   * the electron bridge (`window.electron.platform`), guarded for Node
   * renders exactly like the switch's own top-gap probe.
   */
  platform?: string;
}

const resolvePlatform = (override?: string): string | undefined => {
  if (override !== undefined) return override;
  if (typeof window === 'undefined') return undefined;
  return window.electron?.platform;
};

const MacWindowLights: React.FC<MacWindowLightsProps> = ({ platform }) => {
  if (resolvePlatform(platform) !== 'darwin') return null;

  const dots: Array<{
    action: MacWindowAction;
    label: string;
    color: string;
    activate: () => void;
  }> = [
    {
      action: 'close',
      label: 'Close',
      color: MAC_LIGHT_DOT_COLORS.close,
      activate: () => window.electron.window.close(),
    },
    {
      action: 'minimize',
      label: 'Minimize',
      color: MAC_LIGHT_DOT_COLORS.minimize,
      activate: () => window.electron.window.minimize(),
    },
    {
      action: 'zoom',
      label: 'Zoom',
      color: MAC_LIGHT_DOT_COLORS.zoom,
      activate: () => window.electron.window.toggleMaximize(),
    },
  ];

  return (
    <div
      data-slot="mac-window-lights"
      className="draggable flex items-center pl-[12px] gap-[8px]"
    >
      {dots.map((dot) => (
        <button
          key={dot.action}
          type="button"
          data-window-action={dot.action}
          aria-label={dot.label}
          title={dot.label}
          onClick={dot.activate}
          className="non-draggable h-[8px] w-[8px] rounded-full transition-opacity duration-150 hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-claude-accent/40"
          style={{ backgroundColor: dot.color }}
        />
      ))}
    </div>
  );
};

export default MacWindowLights;
