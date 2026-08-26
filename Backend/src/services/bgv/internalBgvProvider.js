/**
 * Internal BGV provider — fully usable without external vendor.
 * Phase 28 can add vendor adapters behind the same interface:
 *   submitCase / getStatus / processWebhook
 */
export const INTERNAL_BGV_PROVIDER = {
  key: 'INTERNAL',

  submitCase: async ({ caseRecord, checks }) => ({
    accepted: true,
    providerReference: `INTERNAL:${caseRecord.caseCode}`,
    mode: 'INTERNAL',
    checkCount: checks.length,
  }),

  getStatus: async ({ caseRecord }) => ({
    provider: 'INTERNAL',
    status: caseRecord.status,
    overallOutcome: caseRecord.overallOutcome || '',
  }),

  processWebhook: async () => {
    const error = new Error('Internal BGV provider does not accept webhooks');
    error.statusCode = 400;
    throw error;
  },
};

export default INTERNAL_BGV_PROVIDER;
