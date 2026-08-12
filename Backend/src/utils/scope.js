// ============================================================
// 🔒 SCOPE UTIL (Phase 10) — who may see WHICH users
// COMPANY_ADMIN / HR_MANAGER → null (whole company, no limit)
// MANAGER      → everyone in their department
// TEAM_LEAD    → their direct reports (+ themselves)
// EMPLOYEE     → themselves only
// ============================================================
import * as UserNS from '../models/User.js';

const pickModel = (ns) => (typeof ns.default === 'function' ? ns.default : ns.default || ns);
const User = pickModel(UserNS);

const FULL_ACCESS = ['COMPANY_ADMIN', 'HR_MANAGER'];

/** @returns array of userIds the requester may see, or null = unrestricted */
export const getScopedUserIds = async (req) => {
  const role = req.user?.role;
  if (FULL_ACCESS.includes(role)) return null;

  const companyId = req.companyId;

  if (role === 'MANAGER') {
    if (!req.user.department) return [req.user._id]; // no dept → self only
    return User.find({ companyId, department: req.user.department }).distinct('_id');
  }

  if (role === 'TEAM_LEAD') {
    return User.find({
      companyId,
      $or: [{ reportingTo: req.user._id }, { _id: req.user._id }],
    }).distinct('_id');
  }

  return [req.user._id]; // EMPLOYEE
};

/** @returns `{ $in: ids }` to merge into a mongo filter, or undefined if unrestricted */
export const scopedUserFilter = async (req) => {
  const ids = await getScopedUserIds(req);
  return ids ? { $in: ids } : undefined;
};

export default { getScopedUserIds, scopedUserFilter };