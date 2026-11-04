/**
 * Desktop-notification sink for pending owner questions (see
 * pendingOwnerAskBridge). Dependency-light on purpose: main.ts injects the
 * Electron primitives, tests inject fakes, and this module owns the two
 * policies that make the push honest:
 *
 *   1. Foreground = the in-app CoworkPermissionOverlay already has the seat.
 *      Pushing a system notification on top of a visible card would be the
 *      "double popup" the task forbids, so it is skipped while the app window
 *      is visible AND focused.
 *   2. The notification is only a nudge: clicking it raises the same window
 *      and leaves the answer to the existing AskUserQuestion card. It creates
 *      no second dialog and never answers anything by itself.
 */
import type { OwnerAskNotify } from './pendingOwnerAskBridge';

export interface OwnerAskNotificationHandle {
  on(event: 'click', listener: () => void): void;
  show(): void;
}

export interface OwnerAskNotifierOptions {
  /** Electron Notification.isSupported(); false on hosts without a notifier. */
  isSupported: () => boolean;
  /** True when the app window is visible and focused (owner already has the card). */
  isWindowForeground: () => boolean;
  createNotification: (input: { title: string; body: string }) => OwnerAskNotificationHandle;
  /** Raise/focus the app window on notification click. */
  showWindow: () => void;
  log?: (message: string, error?: unknown) => void;
}

export function createOwnerAskNotifier(options: OwnerAskNotifierOptions): OwnerAskNotify {
  return (notification) => {
    try {
      if (!options.isSupported()) return;
      if (options.isWindowForeground()) return;
      const handle = options.createNotification({
        title: notification.title,
        body: notification.body,
      });
      handle.on('click', () => {
        try {
          options.showWindow();
        } catch (error) {
          options.log?.('[OwnerAsk] failed to focus the app window:', error);
        }
      });
      handle.show();
    } catch (error) {
      options.log?.('[OwnerAsk] failed to show desktop notification:', error);
    }
  };
}
