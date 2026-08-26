import INTERNAL_BGV_PROVIDER from './internalBgvProvider.js';
import ApiError from '../../utils/ApiError.js';

const PROVIDERS = new Map([[INTERNAL_BGV_PROVIDER.key, INTERNAL_BGV_PROVIDER]]);

/**
 * Phase 28 readiness:
 * BGV Service → dispatcher/worker → getBgvProvider(key) → vendor adapter
 */
export const getBgvProvider = (key = 'INTERNAL') => {
  const provider = PROVIDERS.get(String(key || 'INTERNAL').toUpperCase());
  if (!provider) {
    throw ApiError.badRequest('Background verification provider is not configured');
  }
  return provider;
};

export const listBgvProviders = () =>
  [...PROVIDERS.keys()].map((key) => ({
    key,
    mode: key === 'INTERNAL' ? 'INTERNAL' : 'EXTERNAL',
  }));
