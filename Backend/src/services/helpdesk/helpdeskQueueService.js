import ApiError from '../../utils/ApiError.js';
import HelpdeskAuthorizationFence from '../../models/HelpdeskAuthorizationFence.js';
import HelpdeskQueue from '../../models/HelpdeskQueue.js';
import User from '../../models/User.js';
import { runHelpdeskTransaction } from './helpdeskTransaction.js';
import {
  bumpHelpdeskAuthorizationFence,
  changedHelpdeskQueueFenceUserIds,
} from './helpdeskAuthorizationFence.js';
import {
  assertNoClientIdentity,
  helpdeskNameKey,
  normalizeHelpdeskName,
} from './helpdeskRules.js';
import { serializeHelpdeskQueue } from './helpdeskDto.js';

const QUEUE_INPUT_FIELDS = Object.freeze([
  'name',
  'description',
  'enabled',
  'categories',
  'agents',
  'managers',
  'confidentiality',
]);
const QUEUE_UPDATE_INPUT_FIELDS = Object.freeze([...QUEUE_INPUT_FIELDS, 'expectedVersion']);
const CATEGORY_INPUT_FIELDS = Object.freeze(['id', 'name', 'description', 'enabled']);
const CONFIDENTIALITY_INPUT_FIELDS = Object.freeze(['enabled', 'agentIds', 'reviewerIds']);
const OBJECT_ID = /^[a-f\d]{24}$/i;

const idString = (value) => {
  if (!value) return '';
  if (typeof value === 'object' && value._id) return String(value._id);
  return String(value);
};

const ensureCompanyId = (companyId) => {
  if (!companyId) throw ApiError.forbidden('A tenant is required');
};

const rejectUnknownFields = (input, allowed, label) => {
  for (const key of Object.keys(input || {})) {
    if (!allowed.includes(key)) {
      throw ApiError.badRequest(`Unsupported ${label} field: ${key}`);
    }
  }
};

const normalizeIdList = (value, field) => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw ApiError.badRequest(`${field} must be an array`);

  const normalized = value.map((item) => String(item || '').trim());
  if (normalized.some((id) => !OBJECT_ID.test(id))) {
    throw ApiError.badRequest(`${field} contains an invalid identifier`);
  }
  if (new Set(normalized.map((id) => id.toLowerCase())).size !== normalized.length) {
    throw ApiError.badRequest(`${field} must not contain duplicates`);
  }
  if (normalized.length > 500) {
    throw ApiError.badRequest(`${field} contains too many identifiers`);
  }
  return normalized;
};

const normalizeCategory = (category, { creating }) => {
  if (!category || typeof category !== 'object' || Array.isArray(category)) {
    throw ApiError.badRequest('Each category must be an object');
  }
  rejectUnknownFields(category, CATEGORY_INPUT_FIELDS, 'category');

  const name = normalizeHelpdeskName(category.name);
  const description = String(category.description || '').trim();
  if (name.length < 2 || name.length > 80) {
    throw ApiError.badRequest('Category names must be between 2 and 80 characters');
  }
  if (description.length > 240) {
    throw ApiError.badRequest('Category descriptions cannot exceed 240 characters');
  }
  if (category.enabled !== undefined && typeof category.enabled !== 'boolean') {
    throw ApiError.badRequest('Category enabled must be a boolean');
  }

  const id = category.id === undefined ? undefined : String(category.id).trim();
  if (id !== undefined && !OBJECT_ID.test(id)) {
    throw ApiError.badRequest('Category id must be a valid identifier');
  }
  if (creating && id !== undefined) {
    throw ApiError.badRequest('New queues cannot include category ids');
  }

  const isExistingCategory = id !== undefined;
  return {
    ...(id ? { id } : {}),
    name,
    nameKey: helpdeskNameKey(name),
    ...(!isExistingCategory || category.description !== undefined ? { description } : {}),
    ...(!isExistingCategory || category.enabled !== undefined ? { enabled: category.enabled !== false } : {}),
  };
};

const normalizeCategories = (value, { creating }) => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw ApiError.badRequest('categories must be an array');
  if (value.length > 100) throw ApiError.badRequest('A queue cannot have more than 100 categories');

  const categories = value.map((category) => normalizeCategory(category, { creating }));
  const keys = categories.map((category) => category.nameKey);
  if (new Set(keys).size !== keys.length) {
    throw ApiError.conflict('Category names must be unique within a queue');
  }
  const ids = categories.map((category) => category.id).filter(Boolean);
  if (new Set(ids.map((id) => id.toLowerCase())).size !== ids.length) {
    throw ApiError.badRequest('A category can only appear once');
  }
  return categories;
};

const normalizeQueueInput = (input = {}, { creating }) => {
  assertNoClientIdentity(input);
  rejectUnknownFields(input, creating ? QUEUE_INPUT_FIELDS : QUEUE_UPDATE_INPUT_FIELDS, 'queue');

  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw ApiError.badRequest('Queue details must be an object');
  }
  if (!creating && !Object.keys(input).some((field) => field !== 'expectedVersion')) {
    throw ApiError.badRequest('Supply at least one queue setting');
  }

  const patch = {};
  if (!creating) {
    if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 0 || input.expectedVersion > 1_000_000_000) {
      throw ApiError.badRequest('expectedVersion must be a non-negative integer');
    }
    patch.expectedVersion = input.expectedVersion;
  }
  if (input.name !== undefined) {
    const name = normalizeHelpdeskName(input.name);
    if (name.length < 2 || name.length > 80) {
      throw ApiError.badRequest('Queue names must be between 2 and 80 characters');
    }
    patch.name = name;
    patch.nameKey = helpdeskNameKey(name);
  } else if (creating) {
    throw ApiError.badRequest('Queue name is required');
  }

  if (input.description !== undefined) {
    const description = String(input.description || '').trim();
    if (description.length > 500) {
      throw ApiError.badRequest('Queue description cannot exceed 500 characters');
    }
    patch.description = description;
  }
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== 'boolean') throw ApiError.badRequest('enabled must be a boolean');
    patch.enabled = input.enabled;
  }
  const categories = normalizeCategories(input.categories, { creating });
  if (categories !== undefined) patch.categories = categories;

  const agents = normalizeIdList(input.agents, 'agents');
  const managers = normalizeIdList(input.managers, 'managers');
  if (agents !== undefined) patch.agents = agents;
  if (managers !== undefined) patch.managers = managers;

  if (input.confidentiality !== undefined) {
    const settings = input.confidentiality;
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      throw ApiError.badRequest('confidentiality must be an object');
    }
    rejectUnknownFields(settings, CONFIDENTIALITY_INPUT_FIELDS, 'confidentiality');
    const confidentiality = {};
    if (settings.enabled !== undefined) {
      if (typeof settings.enabled !== 'boolean') {
        throw ApiError.badRequest('confidentiality.enabled must be a boolean');
      }
      confidentiality.enabled = settings.enabled;
    } else if (creating) {
      confidentiality.enabled = false;
    }
    const agentIds = normalizeIdList(settings.agentIds, 'confidentiality.agentIds');
    const reviewerIds = normalizeIdList(settings.reviewerIds, 'confidentiality.reviewerIds');
    if (agentIds !== undefined) confidentiality.agentIds = agentIds;
    if (reviewerIds !== undefined) confidentiality.reviewerIds = reviewerIds;
    if (creating) {
      confidentiality.agentIds ??= [];
      confidentiality.reviewerIds ??= [];
    }
    patch.confidentiality = confidentiality;
  } else if (creating) {
    patch.confidentiality = { enabled: false, agentIds: [], reviewerIds: [] };
  }

  if (creating) {
    patch.description ??= '';
    patch.enabled ??= true;
    patch.categories ??= [];
    patch.agents ??= [];
    patch.managers ??= [];
  }

  return patch;
};

const duplicateKeyError = (error) => error?.code === 11000;

export const helpdeskQueueService = (deps = {}) => {
  const QueueModel = deps.QueueModel || HelpdeskQueue;
  const UserModel = deps.UserModel || User;
  const FenceModel = deps.FenceModel || HelpdeskAuthorizationFence;
  const transactionRunner = deps.transactionRunner || runHelpdeskTransaction;

  const validateUsers = async (companyId, ids, session = null) => {
    const uniqueIds = [...new Set(ids.map((id) => id.toLowerCase()))];
    if (!uniqueIds.length) return;

    let query = UserModel.find({
      companyId,
      status: 'ACTIVE',
      accountSetupRequired: { $ne: true },
      _id: { $in: uniqueIds },
    });
    if (session && typeof query?.session === 'function') query = query.session(session);
    const found = await query.select('_id').lean();
    const foundIds = new Set((found || []).map((user) => idString(user._id).toLowerCase()));
    if (foundIds.size !== uniqueIds.length || uniqueIds.some((id) => !foundIds.has(id))) {
      throw ApiError.badRequest('Queue members must have active accounts with completed setup in this tenant');
    }
  };

  const assertMembershipConfiguration = async (companyId, patch, current = null, session = null) => {
    const agents = patch.agents ?? (current?.agents || []).map(idString);
    const managers = patch.managers ?? (current?.managers || []).map(idString);
    const confidentiality = {
      enabled: patch.confidentiality?.enabled ?? current?.confidentiality?.enabled ?? false,
      agentIds: patch.confidentiality?.agentIds
        ?? (current?.confidentiality?.agentIds || []).map(idString),
      reviewerIds: patch.confidentiality?.reviewerIds
        ?? (current?.confidentiality?.reviewerIds || []).map(idString),
    };

    const allIds = [...agents, ...managers, ...confidentiality.agentIds, ...confidentiality.reviewerIds];
    await validateUsers(companyId, allIds, session);

    const agentSet = new Set(agents.map((id) => id.toLowerCase()));
    if (confidentiality.agentIds.some((id) => !agentSet.has(id.toLowerCase()))) {
      throw ApiError.badRequest('Confidential queue agents must also be queue agents');
    }
  };

  const mergeCategories = (currentCategories, incomingCategories) => {
    if (incomingCategories === undefined) return currentCategories;
    const byId = new Map((currentCategories || []).map((category) => [idString(category._id).toLowerCase(), category]));
    const seenIds = new Set();
    const merged = [...(currentCategories || [])].map((category) => ({
      _id: category._id,
      name: category.name,
      nameKey: category.nameKey || helpdeskNameKey(category.name),
      description: category.description || '',
      enabled: category.enabled !== false,
    }));

    for (const category of incomingCategories) {
      if (!category.id) {
        if (merged.some((existing) => (existing.nameKey || helpdeskNameKey(existing.name)) === category.nameKey)) {
          throw ApiError.conflict('Category names must be unique within a queue');
        }
        merged.push({
          name: category.name,
          nameKey: category.nameKey,
          description: category.description || '',
          enabled: category.enabled !== false,
        });
        continue;
      }

      const key = category.id.toLowerCase();
      const existing = byId.get(key);
      if (!existing) throw ApiError.badRequest('Category does not belong to this queue');
      if (seenIds.has(key)) throw ApiError.badRequest('A category can only be updated once');
      seenIds.add(key);

      const existingIndex = merged.findIndex((item) => idString(item._id).toLowerCase() === key);
      if (existingIndex >= 0) {
        merged[existingIndex] = {
          ...merged[existingIndex],
          name: category.name,
          nameKey: category.nameKey,
          ...(category.description !== undefined ? { description: category.description } : {}),
          ...(category.enabled !== undefined ? { enabled: category.enabled } : {}),
        };
      }
    }

    const keys = merged.map((category) => category.nameKey || helpdeskNameKey(category.name));
    if (new Set(keys).size !== keys.length) {
      throw ApiError.conflict('Category names must be unique within a queue');
    }
    return merged;
  };

  const createQueue = async ({ companyId, actorId, input = {} }) => {
    ensureCompanyId(companyId);
    const patch = normalizeQueueInput(input, { creating: true });
    await assertMembershipConfiguration(companyId, patch);

    const existing = await QueueModel.findOne({ companyId, nameKey: patch.nameKey }).select('_id').lean();
    if (existing) throw ApiError.conflict('A queue with this name already exists');

    try {
      const queue = await QueueModel.create({
        ...patch,
        companyId,
        createdBy: actorId || null,
        updatedBy: actorId || null,
      });
      return serializeHelpdeskQueue(queue, { administrative: true, includeDisabledCategories: true });
    } catch (error) {
      if (duplicateKeyError(error)) throw ApiError.conflict('A queue with this name already exists');
      throw error;
    }
  };

  const listQueues = async ({ companyId, includeDisabled = false, administrative = false } = {}) => {
    ensureCompanyId(companyId);
    const filter = { companyId };
    if (!includeDisabled) filter.enabled = true;
    const queues = await QueueModel.find(filter).sort({ nameKey: 1, _id: 1 }).lean();
    return (queues || []).map((queue) => serializeHelpdeskQueue(queue, {
      administrative,
      includeDisabledCategories: administrative,
    }));
  };

  const getQueue = async ({ companyId, queueId, includeDisabled = false, administrative = false } = {}) => {
    ensureCompanyId(companyId);
    if (!OBJECT_ID.test(String(queueId || ''))) throw ApiError.notFound('Helpdesk queue not found');
    const queue = await QueueModel.findOne({ _id: queueId, companyId }).lean();
    if (!queue || (!includeDisabled && queue.enabled === false)) {
      throw ApiError.notFound('Helpdesk queue not found');
    }
    return serializeHelpdeskQueue(queue, {
      administrative,
      includeDisabledCategories: administrative,
    });
  };

  const updateQueue = async ({ companyId, actorId, queueId, input = {} }) => {
    ensureCompanyId(companyId);
    if (!OBJECT_ID.test(String(queueId || ''))) throw ApiError.notFound('Helpdesk queue not found');
    const normalizedPatch = normalizeQueueInput(input, { creating: false });
    const expectedVersion = normalizedPatch.expectedVersion;
    const patch = { ...normalizedPatch };
    delete patch.expectedVersion;

    try {
      const updatedQueue = await transactionRunner(async (session) => {
        let queueQuery = QueueModel.findOne({ _id: queueId, companyId });
        if (session && typeof queueQuery?.session === 'function') queueQuery = queueQuery.session(session);
        const queue = await queueQuery;
        if (!queue) throw ApiError.notFound('Helpdesk queue not found');
        const currentVersion = Number.isSafeInteger(Number(queue.__v)) ? Number(queue.__v) : 0;
        if (currentVersion !== expectedVersion) {
          throw ApiError.conflict('Queue changed while you were editing it. Refresh and review before saving.');
        }

        const nextNameKey = patch.nameKey || queue.nameKey;
        if (patch.nameKey) {
          let duplicateQuery = QueueModel.findOne({
            companyId,
            nameKey: nextNameKey,
            _id: { $ne: queue._id },
          });
          if (session && typeof duplicateQuery?.session === 'function') duplicateQuery = duplicateQuery.session(session);
          const duplicate = await duplicateQuery.select('_id').lean();
          if (duplicate) throw ApiError.conflict('A queue with this name already exists');
        }

        await assertMembershipConfiguration(companyId, patch, queue, session);
        const nextMembership = {
          agents: patch.agents ?? (queue.agents || []).map(idString),
          managers: patch.managers ?? (queue.managers || []).map(idString),
          confidentiality: {
            enabled: patch.confidentiality?.enabled ?? queue.confidentiality?.enabled ?? false,
            agentIds: patch.confidentiality?.agentIds
              ?? (queue.confidentiality?.agentIds || []).map(idString),
            reviewerIds: patch.confidentiality?.reviewerIds
              ?? (queue.confidentiality?.reviewerIds || []).map(idString),
          },
        };
        const changedPrincipals = changedHelpdeskQueueFenceUserIds({
          current: queue,
          next: nextMembership,
        });
        await bumpHelpdeskAuthorizationFence({
          FenceModel,
          companyId,
          queueId: queue._id,
          userIds: changedPrincipals,
          session,
        });

        const categories = patch.categories === undefined
          ? undefined
          : mergeCategories(queue.categories, patch.categories);
        for (const [key, value] of Object.entries(patch)) {
          if (key !== 'confidentiality' && key !== 'categories') queue[key] = value;
        }
        if (categories !== undefined) queue.categories = categories;
        if (patch.confidentiality !== undefined) {
          queue.confidentiality = nextMembership.confidentiality;
        }
        queue.updatedBy = actorId || null;
        try {
          await queue.save({ session });
        } catch (error) {
          if (error?.name === 'VersionError') {
            throw ApiError.conflict('Queue changed while you were editing it. Refresh and review before saving.');
          }
          throw error;
        }
        return queue;
      });
      return serializeHelpdeskQueue(updatedQueue, { administrative: true, includeDisabledCategories: true });
    } catch (error) {
      const causeChain = [];
      for (let current = error; current && causeChain.length < 5; current = current.cause) {
        causeChain.push(current);
      }
      const fenceConflict = causeChain.some((cause) => cause?.name === 'HelpdeskFenceConflictError');
      const versionConflict = causeChain.some((cause) => cause?.name === 'VersionError');
      const duplicate = !fenceConflict && !versionConflict && causeChain.some(duplicateKeyError);
      if (versionConflict) {
        throw ApiError.conflict('Queue changed while you were editing it. Refresh and review before saving.');
      }
      if (duplicate) throw ApiError.conflict('A queue with this name already exists');
      throw error;
    }
  };

  const getQueueForTicket = async ({ companyId, queueId }) => {
    ensureCompanyId(companyId);
    if (!OBJECT_ID.test(String(queueId || ''))) return null;
    return QueueModel.findOne({ _id: queueId, companyId }).lean();
  };

  const listAvailableQueues = async ({ companyId } = {}) => listQueues({ companyId, includeDisabled: false, administrative: false });

  return {
    createQueue,
    listQueues,
    listAvailableQueues,
    getQueue,
    updateQueue,
    getQueueForTicket,
  };
};

export const _test = {
  normalizeQueueInput,
  normalizeCategories,
  normalizeCategory,
};
