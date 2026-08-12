import User from '../models/User.js';
import { ROLES } from './constants.js';

// All user ids under a manager (direct + indirect reports)
export const getSubtreeIds = async (companyId, managerId) => {
  const users = await User.find({ companyId, status: 'ACTIVE' }).select('_id reportingTo');
  const children = {};
  users.forEach((u) => {
    const parent = String(u.reportingTo || '');
    (children[parent] ||= []).push(String(u._id));
  });
  const result = [];
  const queue = [String(managerId)];
  while (queue.length) {
    const cur = queue.pop();
    (children[cur] || []).forEach((id) => {
      result.push(id);
      queue.push(id);
    });
  }
  return result;
};

// Which users may this requester manage?
// Admin/HR → whole company · Manager/TL → their subtree
export const resolveScopeIds = async (req) => {
  if ([ROLES.COMPANY_ADMIN, ROLES.HR_MANAGER].includes(req.user.role)) {
    const all = await User.find({ companyId: req.companyId, status: 'ACTIVE' }).select('_id');
    return all.map((u) => u._id);
  }
  return getSubtreeIds(req.companyId, req.user._id);
};