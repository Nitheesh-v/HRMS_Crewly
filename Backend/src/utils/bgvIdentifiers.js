import TenantSequence from '../models/TenantSequence.js';

const nextSequence = async (companyId, key) => {
  let sequence;
  try {
    sequence = await TenantSequence.findOneAndUpdate(
      { companyId, key },
      {
        $inc: { value: 1 },
        $setOnInsert: { companyId, key },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  } catch (error) {
    if (error.code !== 11000) throw error;
    sequence = await TenantSequence.findOneAndUpdate(
      { companyId, key },
      { $inc: { value: 1 } },
      { new: true }
    );
  }
  return sequence.value;
};

export const nextBgvCaseCode = async (companyId) => {
  const value = await nextSequence(companyId, 'BGV_CASE');
  return `BGV-${String(value).padStart(6, '0')}`;
};

// Phase 30.3 — paid BGV order reference, same tenant sequence convention.
export const nextBgvOrderCode = async (companyId) => {
  const value = await nextSequence(companyId, 'BGV_ORDER');
  return `BGVORD-${String(value).padStart(6, '0')}`;
};

// Phase 30.10 — final BGV report reference, same TenantSequence convention.
// Readable, unique per tenant, collision-safe — never Date.now/Math.random.
export const nextBgvReportCode = async (companyId) => {
  const value = await nextSequence(companyId, 'BGV_REPORT');
  return `BGVRPT-${String(value).padStart(6, '0')}`;
};
