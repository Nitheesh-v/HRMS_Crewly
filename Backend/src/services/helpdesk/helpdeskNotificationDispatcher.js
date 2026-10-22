import logger from '../../config/logger.js';
import { notifyHelpdeskNotificationsChanged } from '../../socket/realtimeNudge.js';
import { helpdeskNotificationService } from './helpdeskNotificationService.js';

export const HELPDESK_NOTIFICATION_RECONCILE_INTERVAL_MS = 60 * 1000;

export const startHelpdeskNotificationDispatcher = ({
  service = helpdeskNotificationService({
    realtimePublisher: {
      notify: async ({ userIds } = {}) => notifyHelpdeskNotificationsChanged(userIds),
    },
  }),
  log = logger,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
} = {}) => {
  let running = false;
  let stopped = false;

  const run = async () => {
    if (running || stopped) return null;
    running = true;
    try {
      const result = await service.reconcilePendingNotifications({ limit: 100 });
      if (result.ticketsInspected || result.messagesInspected) {
        log.info(
          `[Helpdesk] notification recovery (tickets=${result.ticketsInspected}, ` +
            `messages=${result.messagesInspected}, delivered=${result.ticketEventsDelivered + result.messagesDelivered}, ` +
            `failed=${result.ticketEventsFailed + result.messagesFailed})`,
        );
      }
      return result;
    } catch (error) {
      log.warn(`[Helpdesk] notification recovery skipped (${String(error?.name || 'error')})`);
      return null;
    } finally {
      running = false;
    }
  };

  void run();
  const timer = setIntervalFn(() => void run(), HELPDESK_NOTIFICATION_RECONCILE_INTERVAL_MS);
  timer?.unref?.();

  return () => {
    stopped = true;
    if (timer) clearIntervalFn(timer);
  };
};
