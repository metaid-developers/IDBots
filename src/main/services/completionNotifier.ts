/**
 * Completion-state owner push — the active leg of the "deliveries must reach
 * the owner" root fix.
 *
 * Root cause covered here (2026-11-22 real case: four re-verified-green
 * deliveries sat silently in the Studio decision queue for hours): every
 * completion state already wrote its notification-center row, but the desktop
 * app had no consumer for those rows and the only active push channel
 * (Electron desktop notification) was wired exclusively to owner-asks. This
 * module is the push half of the fix; the notification-center row stays the
 * dedup arbiter (eventId PRIMARY KEY), and the desktop push fires ONLY on a
 * fresh insert so a replayed/duplicated event can never pop twice.
 *
 * The two policies mirror ownerAskNotifier on purpose (foreground = the
 * owner already has the app; the notification is a nudge whose click raises
 * the window — it never performs the acceptance itself). They are duplicated
 * rather than shared so the owner-ask semantics keep evolving independently:
 * this module must stay a pure "inform + jump" sink.
 */
import type { OwnerAskNotifierOptions } from './ownerAskNotifier';

export interface CompletionDesktopNotifyInput {
  title: string;
  body: string;
}

export type CompletionDesktopNotify = (input: CompletionDesktopNotifyInput) => void;

/**
 * Desktop-notification sink for completion states. Same dependency shape as
 * ownerAskNotifier so main.ts can feed both from the same Electron primitives.
 */
export function createCompletionNotifier(options: OwnerAskNotifierOptions): CompletionDesktopNotify {
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
          options.log?.('[CompletionNotify] failed to focus the app window:', error);
        }
      });
      handle.show();
    } catch (error) {
      options.log?.('[CompletionNotify] failed to show desktop notification:', error);
    }
  };
}

/**
 * The composition the whole fix hangs on: the row lands first (its eventId is
 * the PRIMARY-KEY dedup arbiter — the same role the orchestration_notifications
 * claim row plays for attempt terminals), and the desktop push rides ONLY a
 * fresh insert. Replayed or duplicated events return false from the store and
 * can never pop a second notification.
 *
 * `record` is a closure over the concrete NotificationService.record* method
 * (each owns its copy/eventId/type); `notification` carries the SAME zh/en copy
 * so the row and the popup always say the same thing.
 */
export function notifyOwnerCompletion(
  sink: {
    record: () => boolean;
    notifyDesktop: CompletionDesktopNotify;
  },
  notification: CompletionDesktopNotifyInput,
): boolean {
  const inserted = sink.record();
  if (inserted) {
    sink.notifyDesktop(notification);
  }
  return inserted;
}
