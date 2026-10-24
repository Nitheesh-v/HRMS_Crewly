import logger from '../../config/logger.js';
import { helpdeskTicketService } from './helpdeskTicketService.js';

export const HELPDESK_AUTO_CLOSE_RECONCILE_INTERVAL_MS = 60 * 1000;

export const startHelpdeskAutoCloseDispatcher = ({
  service = helpdeskTicketService(),
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
      const result = await service.reconcileDueAutoClosures({ limit: 100 });
      if (result.inspected) {
        log.info(
          `[Worker] Helpdesk auto-closure (inspected=${result.inspected}, ` +
            `closed=${result.closed}, skipped=${result.skipped}, failed=${result.failed})`,
        );
      }
      return result;
    } catch (error) {
      log.warn(`[Worker] Helpdesk auto-closure skipped (${String(error?.name || 'error')})`);
      return null;
    } finally {
      running = false;
    }
  };

  void run();
  const timer = setIntervalFn(() => void run(), HELPDESK_AUTO_CLOSE_RECONCILE_INTERVAL_MS);
  timer?.unref?.();

  return () => {
    stopped = true;
    if (timer) clearIntervalFn(timer);
  };
};
