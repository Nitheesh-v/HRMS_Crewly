import logger from '../../config/logger.js';
import { getRealtimeGateway } from '../../infrastructure/realtime/realtimeGateway.js';
import { notifyHelpdeskNotificationsChanged } from '../../socket/realtimeNudge.js';
import { helpdeskNotificationService } from './helpdeskNotificationService.js';

export const HELPDESK_NOTIFICATION_RECONCILE_INTERVAL_MS = 60 * 1000;
const OBJECT_ID = /^[a-f\d]{24}$/i;

export const publishHelpdeskNotificationNudge = async ({
  companyId,
  userIds = [],
  gateway = getRealtimeGateway(),
  socketNudge = notifyHelpdeskNotificationsChanged,
} = {}) => {
  const tenantId = String(companyId || '');
  if (!OBJECT_ID.test(tenantId) || !Array.isArray(userIds)) return [];

  const recipients = [...new Set(userIds
    .map((value) => String(value?._id ?? value ?? ''))
    .filter((value) => OBJECT_ID.test(value)))];
  if (!recipients.length) return [];

  const results = await Promise.allSettled(recipients.map((userId) => gateway.publish({
    type: 'helpdesk:notifications:changed',
    companyId: tenantId,
    userId,
    payload: {},
  })));

  // Keep the already-shipped Socket.IO invalidation seam for its current
  // consumers; the single app-session SSE channel is the bell's shared path.
  try {
    socketNudge(recipients);
  } catch {
    // Mongo notification rows are durable; both transports are best-effort.
  }

  return results;
};

export const startHelpdeskNotificationDispatcher = ({
  service = helpdeskNotificationService({
    realtimePublisher: {
      notify: publishHelpdeskNotificationNudge,
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
