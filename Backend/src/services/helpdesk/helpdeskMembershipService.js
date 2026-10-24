import ApiError from '../../utils/ApiError.js';
import { boundedSearchTerm } from '../../utils/searchInput.js';
import HelpdeskQueue from '../../models/HelpdeskQueue.js';
import User from '../../models/User.js';

export const HELPDESK_MEMBER_SEARCH_MIN_LENGTH = 2;
export const HELPDESK_MEMBER_SEARCH_MAX_LENGTH = 60;
export const HELPDESK_MEMBER_SEARCH_DEFAULT_LIMIT = 20;
export const HELPDESK_MEMBER_SEARCH_MAX_LIMIT = 50;
export const HELPDESK_MEMBER_SEARCH_MAX_PAGE = 10_000;
export const HELPDESK_QUEUE_MEMBER_MAX_RESOLUTION_IDS = 2_000;

const OBJECT_ID = /^[a-f\d]{24}$/i;

const idString = (value) => {
  if (!value) return '';
  if (typeof value === 'object' && value._id) return String(value._id);
  return String(value);
};

const ensureCompanyId = (companyId) => {
  if (!companyId) throw ApiError.forbidden('A tenant is required');
};

const parseInteger = (value, field, { fallback, minimum, maximum }) => {
  if (value === undefined || value === null || value === '') return fallback;
  const raw = String(value);
  if (!/^\d+$/.test(raw)) throw ApiError.badRequest(`${field} must be an integer`);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw ApiError.badRequest(`${field} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
};

export const normalizeHelpdeskMembershipSearch = ({ search, page, limit } = {}) => {
  if (typeof search !== 'string') {
    throw ApiError.badRequest('Enter at least two characters to search company employees');
  }
  const normalizedSearch = search.trim();
  if (
    normalizedSearch.length < HELPDESK_MEMBER_SEARCH_MIN_LENGTH
    || normalizedSearch.length > HELPDESK_MEMBER_SEARCH_MAX_LENGTH
  ) {
    throw ApiError.badRequest(
      `Search must be ${HELPDESK_MEMBER_SEARCH_MIN_LENGTH}–${HELPDESK_MEMBER_SEARCH_MAX_LENGTH} characters`,
    );
  }

  const normalizedPage = parseInteger(page, 'page', {
    fallback: 1,
    minimum: 1,
    maximum: HELPDESK_MEMBER_SEARCH_MAX_PAGE,
  });
  const normalizedLimit = parseInteger(limit, 'limit', {
    fallback: HELPDESK_MEMBER_SEARCH_DEFAULT_LIMIT,
    minimum: 1,
    maximum: HELPDESK_MEMBER_SEARCH_MAX_LIMIT,
  });

  return {
    term: boundedSearchTerm(normalizedSearch, HELPDESK_MEMBER_SEARCH_MAX_LENGTH),
    page: normalizedPage,
    limit: normalizedLimit,
    skip: (normalizedPage - 1) * normalizedLimit,
  };
};

const departmentNameOf = (department) => {
  if (!department || typeof department !== 'object') return '';
  return String(department.name || '').trim();
};

const userMemberDto = (user) => {
  const setupPending = user.accountSetupRequired === true;
  const active = user.status === 'ACTIVE';
  return {
    id: idString(user._id),
    name: String(user.name || '').trim() || 'Employee name unavailable',
    employeeCode: String(user.employeeCode || '').trim(),
    workEmail: String(user.email || '').trim(),
    department: departmentNameOf(user.department),
    employmentStatus: active ? 'ACTIVE' : 'INACTIVE',
    accountSetupRequired: setupPending,
    displayStatus: !active ? 'Inactive' : setupPending ? 'Account setup pending' : 'Active',
    eligible: active && !setupPending,
    unavailable: false,
  };
};

const unavailableMemberDto = (id) => ({
  id: idString(id),
  name: 'Unavailable member',
  employeeCode: '',
  workEmail: '',
  department: '',
  employmentStatus: 'UNAVAILABLE',
  accountSetupRequired: false,
  displayStatus: 'Unavailable',
  eligible: false,
  unavailable: true,
});

const memberIdsOf = (queue) => ({
  agents: (queue?.agents || []).map(idString).filter(Boolean),
  managers: (queue?.managers || []).map(idString).filter(Boolean),
  confidentialAgents: (queue?.confidentiality?.agentIds || []).map(idString).filter(Boolean),
  confidentialReviewers: (queue?.confidentiality?.reviewerIds || []).map(idString).filter(Boolean),
});

export const helpdeskMembershipService = (deps = {}) => {
  const UserModel = deps.UserModel || User;
  const QueueModel = deps.QueueModel || HelpdeskQueue;

  const searchCandidates = async ({ companyId, search, page, limit } = {}) => {
    ensureCompanyId(companyId);
    const normalized = normalizeHelpdeskMembershipSearch({ search, page, limit });
    const filter = {
      companyId,
      status: 'ACTIVE',
      accountSetupRequired: { $ne: true },
      $or: [
        { name: { $regex: normalized.term, $options: 'i' } },
        { employeeCode: { $regex: normalized.term, $options: 'i' } },
        { email: { $regex: normalized.term, $options: 'i' } },
      ],
    };

    const candidateQuery = UserModel.find(filter)
      .select('_id name employeeCode email department status accountSetupRequired')
      .populate({ path: 'department', select: 'name', match: { companyId } })
      .sort({ name: 1, _id: 1 })
      .skip(normalized.skip)
      .limit(normalized.limit)
      .lean();
    const [users, total] = await Promise.all([
      candidateQuery,
      UserModel.countDocuments(filter),
    ]);

    return {
      candidates: (users || []).map(userMemberDto),
      meta: {
        page: normalized.page,
        limit: normalized.limit,
        pages: Math.max(1, Math.ceil(total / normalized.limit)),
        total,
      },
    };
  };

  const getQueueMembership = async ({ companyId, queueId } = {}) => {
    ensureCompanyId(companyId);
    if (!OBJECT_ID.test(String(queueId || ''))) throw ApiError.notFound('Helpdesk queue not found');

    const queue = await QueueModel.findOne({ _id: queueId, companyId })
      .select('agents managers confidentiality __v')
      .lean();
    if (!queue) throw ApiError.notFound('Helpdesk queue not found');

    const idsByRole = memberIdsOf(queue);
    const allIds = [...new Set(Object.values(idsByRole).flat().map((id) => id.toLowerCase()))];
    if (allIds.length > HELPDESK_QUEUE_MEMBER_MAX_RESOLUTION_IDS) {
      throw ApiError.unavailable('Queue membership is too large to resolve safely.');
    }

    let users = [];
    if (allIds.length) {
      users = await UserModel.find({ companyId, _id: { $in: allIds } })
        .select('_id name employeeCode email department status accountSetupRequired')
        .populate({ path: 'department', select: 'name', match: { companyId } })
        .lean();
    }
    const userById = new Map((users || []).map((user) => [idString(user._id).toLowerCase(), user]));
    const resolveList = (ids) => ids.map((id) => {
      const user = userById.get(id.toLowerCase());
      return user ? userMemberDto(user) : unavailableMemberDto(id);
    });

    return {
      version: Number.isSafeInteger(Number(queue.__v)) ? Number(queue.__v) : 0,
      agents: resolveList(idsByRole.agents),
      managers: resolveList(idsByRole.managers),
      confidentialAgents: resolveList(idsByRole.confidentialAgents),
      confidentialReviewers: resolveList(idsByRole.confidentialReviewers),
    };
  };

  return { searchCandidates, getQueueMembership };
};
