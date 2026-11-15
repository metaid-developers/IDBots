import React from 'react';

/**
 * macOS mini traffic lights (owner ruling 2026-11-14, the WeChat-style route).
 *
 * The native lights' size is system-pinned — reposition options only ever
 * MOVED them — so main.ts hides the native buttons (titleBarStyle 'hidden' +
 * setWindowButtonVisibility(false) after creation) and this component draws
 * the WeChat-scale dots in their place: three 10px circles, the macOS
 * red/amber/green convention, 10px apart, riding the mid column's 52px top
 * strip (BotBrowserModeSwitch surface-header-top-gap, shared by BOTH faces)
 * with a 15px left inset. Vertically the dots center in the GAP between the
 * window content top (y=0) and the tray's border-top edge — owner gap-center
 * ruling 2026-11-15 08:21 (supersedes the 08:20 tray-center alignment): the
 * tray top sits at 52 + (52−37.5)/2 = 59.25 (band row 52px, tray h-10
 * rendered 37.5px at the 15px root), so the dot center must land at
 * 59.25 / 2 = 29.625; items-center alone would give 26, hence the
 * pt-[7.25px] offset (= (52−37.5)/2) on the strip's centering. The band row
 * and the tray keep their fd4e93d1 geometry untouched.
 *
 * The strip is a window-drag handle (surface-header carries `draggable`)
 * and the container repeats the annotation; each dot annotates `non-draggable`
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

/** Dot diameter, in px (owner bump 2026-11-15: 8 → 10; system lights pinned). */
export const MAC_LIGHT_DOT_PX = 10;
/** Dot-to-dot spacing, in px (scaled with the diameter, compact rhythm kept). */
export const MAC_LIGHT_DOT_GAP_PX = 10;
/** Left inset from the mid column's edge, in px (12 scaled by 10/8). */
export const MAC_LIGHT_INSET_PX = 15;

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
      className="draggable flex items-center pt-[7.25px] pl-[15px] gap-[10px]"
    >
      {dots.map((dot) => (
        <button
          key={dot.action}
          type="button"
          data-window-action={dot.action}
          aria-label={dot.label}
          title={dot.label}
          onClick={dot.activate}
          className="non-draggable h-[10px] w-[10px] rounded-full transition-opacity duration-150 hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-claude-accent/40"
          style={{ backgroundColor: dot.color }}
        />
      ))}
    </div>
  );
};

export default MacWindowLights;
