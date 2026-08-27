import logger from '../../config/logger.js';
import { getBgvProvider } from './bgvProviderRegistry.js';

/**
 * Synchronous dispatcher for Phase 27.15.
 * Phase 28 can replace the body with BullMQ enqueue while keeping this API.
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
