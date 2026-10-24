import HelpdeskTenantConfig, {
  HELPDESK_TENANT_DEFAULTS,
} from '../../models/HelpdeskTenantConfig.js';
import ApiError from '../../utils/ApiError.js';
import { serializeHelpdeskConfig } from './helpdeskDto.js';
import { HELPDESK_PRIORITIES } from './helpdeskRules.js';
import {
  HELPDESK_AUTO_CLOSE_DELAY_MAX_HOURS,
  HELPDESK_AUTO_CLOSE_DELAY_MIN_HOURS,
  HELPDESK_REOPEN_WINDOW_MAX_HOURS,
  HELPDESK_REOPEN_WINDOW_MIN_HOURS,
} from './helpdeskLifecycleRules.js';

const CONFIG_FIELDS = Object.freeze([
  'enabled',
  'allowEmployeeTickets',
  'attachmentsEnabled',
  'confidentialTicketsEnabled',
  'defaultPriority',
  'allowEmployeeReopen',
  'reopenWindowHours',
  'autoCloseEnabled',
  'autoCloseDelayHours',
]);

const ensureCompanyId = (companyId) => {
  if (!companyId) throw ApiError.forbidden('A tenant is required');
};

const validateConfigPatch = (input = {}) => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw ApiError.badRequest('Helpdesk settings must be an object');
  }
  const keys = Object.keys(input);
  if (!keys.length) throw ApiError.badRequest('Supply at least one Helpdesk setting');

  const unknown = keys.filter((key) => !CONFIG_FIELDS.includes(key));
  if (unknown.length) {
    throw ApiError.badRequest(`Unsupported Helpdesk setting: ${unknown[0]}`);
  }

  const patch = {};
  for (const field of ['enabled', 'allowEmployeeTickets', 'attachmentsEnabled', 'confidentialTicketsEnabled', 'allowEmployeeReopen', 'autoCloseEnabled']) {
    if (input[field] === undefined) continue;
    if (typeof input[field] !== 'boolean') {
      throw ApiError.badRequest(`${field} must be a boolean`);
    }
    patch[field] = input[field];
  }

  if (input.defaultPriority !== undefined) {
    const priority = String(input.defaultPriority || '').trim().toLowerCase();
    if (!HELPDESK_PRIORITIES.includes(priority)) {
      throw ApiError.badRequest('defaultPriority is not supported');
    }
    patch.defaultPriority = priority;
  }

  for (const [field, minimum, maximum] of [
    ['reopenWindowHours', HELPDESK_REOPEN_WINDOW_MIN_HOURS, HELPDESK_REOPEN_WINDOW_MAX_HOURS],
    ['autoCloseDelayHours', HELPDESK_AUTO_CLOSE_DELAY_MIN_HOURS, HELPDESK_AUTO_CLOSE_DELAY_MAX_HOURS],
  ]) {
    if (input[field] === undefined) continue;
    if (!Number.isInteger(input[field]) || input[field] < minimum || input[field] > maximum) {
      throw ApiError.badRequest(`${field} must be an integer from ${minimum} to ${maximum}`);
    }
    patch[field] = input[field];
  }

  return patch;
};

export const helpdeskTenantConfigService = (deps = {}) => {
  const ConfigModel = deps.ConfigModel || HelpdeskTenantConfig;

  const safeUpsert = async (filter, update, options) => {
    try {
      return await ConfigModel.findOneAndUpdate(filter, update, options);
    } catch (error) {
      if (error?.code !== 11000) throw error;
      return ConfigModel.findOneAndUpdate(
        filter,
        { $set: update.$set || {} },
        { ...options, upsert: false },
      );
    }
  };

  const readConfig = async ({ companyId, session } = {}) => {
    ensureCompanyId(companyId);

    try {
      let query = ConfigModel.findOne({ companyId });
      if (session && typeof query?.session === 'function') query = query.session(session);
      if (typeof query?.lean === 'function') query = query.lean();
      const config = await query;
      const plainConfig = typeof config?.toObject === 'function' ? config.toObject() : config;
      return serializeHelpdeskConfig({ ...HELPDESK_TENANT_DEFAULTS, ...(plainConfig || {}) });
    } catch (error) {
      if (error?.statusCode || session) throw error;
      throw ApiError.unavailable('Helpdesk configuration is unavailable');
    }
  };

  const getConfig = async ({ companyId }) => {
    ensureCompanyId(companyId);

    try {
      const config = await safeUpsert(
        { companyId },
        { $setOnInsert: { companyId } },
        {
          upsert: true,
          returnDocument: 'after',
          setDefaultsOnInsert: true,
        },
      );

      if (!config) throw new Error('missing config after upsert');
      const plainConfig = typeof config.toObject === 'function' ? config.toObject() : config;
      return serializeHelpdeskConfig({ ...HELPDESK_TENANT_DEFAULTS, ...plainConfig });
    } catch {
      throw ApiError.unavailable('Helpdesk configuration is unavailable');
    }
  };

  const updateConfig = async ({ companyId, actorId, input = {} }) => {
    ensureCompanyId(companyId);
    const patch = validateConfigPatch(input);

    try {
      const config = await safeUpsert(
        { companyId },
        {
          $set: { ...patch, updatedBy: actorId || null },
          $setOnInsert: { companyId },
        },
        {
          upsert: true,
          returnDocument: 'after',
          setDefaultsOnInsert: true,
          runValidators: true,
        },
      );

      if (!config) throw new Error('missing config after update');
      const plainConfig = typeof config.toObject === 'function' ? config.toObject() : config;
      return serializeHelpdeskConfig({ ...HELPDESK_TENANT_DEFAULTS, ...plainConfig });
    } catch (error) {
      if (error?.statusCode) throw error;
      throw ApiError.unavailable('Helpdesk configuration could not be saved');
    }
  };

  return { readConfig, getConfig, updateConfig };
};

export const HELPDESK_CONFIG_FIELDS = CONFIG_FIELDS;
export const _test = { validateConfigPatch };
