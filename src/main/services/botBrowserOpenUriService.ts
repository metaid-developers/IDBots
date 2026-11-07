/**
 * Shared helper to deliver a Bot Browser open-uri request to all live renderer
 * windows and focus the first one. Used by the MetaID RPC server and by the
 * cowork Agent's bot_browser_* tools.
 */

import { BrowserWindow } from 'electron';
import { broadcastToRenderers } from '../ipc/broadcast';

export type BotBrowserOpenUriInput = {
  uri: string;
  actorId?: string | null;
  /** Display label for the newly created tab (newTab opens only). */
  label?: string;
  newTab?: boolean;
};

export function sendBotBrowserOpenUri(input: BotBrowserOpenUriInput): void {
  const windows = BrowserWindow.getAllWindows();
  const liveWindows = windows.filter(
    (win) => !win.isDestroyed() && !win.webContents.isDestroyed(),
  );

  broadcastToRenderers('botBrowser:openUri', input);

  const firstWindow = windows.find((win) => !win.isDestroyed());
  if (firstWindow) {
    if (firstWindow.isMinimized()) firstWindow.restore();
    if (!firstWindow.isVisible()) firstWindow.show();
    firstWindow.focus();
  }

  if (liveWindows.length === 0) {
    throw new Error('No IDBots window is available to open Bot Browser');
  }
}
