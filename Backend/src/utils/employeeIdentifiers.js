import TenantSequence from '../models/TenantSequence.js';
import User from '../models/User.js';

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

export const nextEmployeeCode = async (companyId, preferred = '') => {
  const manual = String(preferred || '').trim().toUpperCase().slice(0, 20);
  if (manual) {
    const taken = await User.exists({ companyId, employeeCode: manual });
    if (taken) {
      const error = new Error('Employee code is already in use');
      error.statusCode = 409;
      throw error;
    }
    return manual;
  }

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const value = await nextSequence(companyId, 'EMPLOYEE');
    const code = `EMP-${String(value).padStart(4, '0')}`;
    const taken = await User.exists({ companyId, employeeCode: code });
    if (!taken) return code;
  }

  const error = new Error('Employee code could not be generated safely');
  error.statusCode = 500;
  throw error;
};
