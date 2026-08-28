import logger from '../../config/logger.js';
import { getBgvProvider } from './bgvProviderRegistry.js';

/**
 * Synchronous dispatcher for Phase 27.15.
 *
 * SUPERSEDED (Phase 28.6): case-level BGV execution now runs on the
 * reserved BGV queue via services/bgvQueueDispatcher.js +
 * workers/bgvProcessor.js (same provider registry, delayed polls,
 * Mongo claims). This synchronous shim is retained for reference /
 * tooling — the start flow no longer calls it.
 *
 * Potential future jobs:
 * BGV_START, BGV_VENDOR_SUBMIT, BGV_VENDOR_POLL,
 * BGV_REMINDER, BGV_RESULT_PROCESS, BGV_EMAIL
 */
export const dispatchBgvJob = async (jobName, payload = {}) => {
  const provider = getBgvProvider(payload.provider || 'INTERNAL');

  switch (jobName) {
    case 'BGV_START':
    case 'BGV_VENDOR_SUBMIT':
      return provider.submitCase(payload);
    case 'BGV_VENDOR_POLL':
      return provider.getStatus(payload);
    case 'BGV_RESULT_PROCESS':
      return provider.processWebhook(payload);
    default:
      logger.info(`[BGV dispatcher] no-op job ${jobName}`);
      return { accepted: true, mode: 'NOOP' };
  }
};
