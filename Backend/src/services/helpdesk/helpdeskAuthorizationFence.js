import HelpdeskAuthorizationFence from '../../models/HelpdeskAuthorizationFence.js';

const idString = (value) => {
  if (!value) return '';
  if (typeof value === 'object' && value._id) return String(value._id);
  return String(value);
};

const duplicateKeyOnly = (error) => {
  if (error?.code === 11000) return true;
  const errors = error?.writeErrors
    || error?.result?.getWriteErrors?.()
    || error?.result?.writeErrors;
  return Array.isArray(errors) && errors.length > 0
    && errors.every((row) => row?.code === 11000);
};

const fenceConflictError = (cause) => {
  const error = new Error('Helpdesk authorization fence conflicted during a transaction', { cause });
  error.name = 'HelpdeskFenceConflictError';
  error.helpdeskTransientTransactionError = true;
  return error;
};

const membershipSet = (values = []) => new Map(
  values.map((value) => [idString(value).toLowerCase(), idString(value)]).filter(([key]) => key),
);

const addAll = (target, values) => {
  for (const [key, value] of membershipSet(values)) target.set(key, value);
};

const hasSameMembers = (left, right) => {
  const leftSet = membershipSet(left);
  const rightSet = membershipSet(right);
  return leftSet.size === rightSet.size && [...leftSet.keys()].every((key) => rightSet.has(key));
};

export const changedHelpdeskQueueFenceUserIds = ({ current, next } = {}) => {
  const affected = new Map();
  const memberships = [
    ['agents', current?.agents, next?.agents],
    ['managers', current?.managers, next?.managers],
    ['confidentialAgents', current?.confidentiality?.agentIds, next?.confidentiality?.agentIds],
  ];

  for (const [, previousValues, nextValues] of memberships) {
    if (hasSameMembers(previousValues, nextValues)) continue;
    addAll(affected, previousValues);
    addAll(affected, nextValues);
  }

  if ((current?.confidentiality?.enabled === true) !== (next?.confidentiality?.enabled === true)) {
    addAll(affected, [
      ...(current?.agents || []),
      ...(current?.managers || []),
      ...(current?.confidentiality?.agentIds || []),
      ...(next?.agents || []),
      ...(next?.managers || []),
      ...(next?.confidentiality?.agentIds || []),
    ]);
  }

  return [...affected.values()];
};

export const bumpHelpdeskAuthorizationFence = async ({
  FenceModel = HelpdeskAuthorizationFence,
  companyId,
  queueId,
  userIds = [],
  session,
} = {}) => {
  const uniqueUsers = [...new Map(
    userIds.map((userId) => [idString(userId).toLowerCase(), userId]).filter(([key]) => key),
  ).values()];
  if (!companyId || !queueId || !uniqueUsers.length) return;

  const operations = uniqueUsers.map((userId) => ({
    updateOne: {
      filter: { companyId, queueId, userId },
      update: {
        $inc: { writeVersion: 1 },
        $setOnInsert: { companyId, queueId, userId },
      },
      upsert: true,
    },
  }));

  try {
    await FenceModel.bulkWrite(operations, {
      ordered: true,
      ...(session ? { session } : {}),
    });
  } catch (error) {
    // Two transactions may both create a principal's first fence row. The
    // unique-index winner forces the other whole transaction to re-authorize.
    if (duplicateKeyOnly(error)) throw fenceConflictError(error);
    throw error;
  }
};

export const _test = { duplicateKeyOnly, fenceConflictError, hasSameMembers, membershipSet };
