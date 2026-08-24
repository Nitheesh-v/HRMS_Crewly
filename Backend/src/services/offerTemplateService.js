import OfferTemplate from '../models/OfferTemplate.js';
import ApiError from '../utils/ApiError.js';
import {
  DEFAULT_OFFER_TEMPLATE_CONTENT,
  OFFER_TEMPLATE_VARIABLES,
  extractOfferTemplateVariables,
} from '../utils/offerTemplateRenderer.js';

const duplicateMessage = (error) => {
  if (error?.code !== 11000) throw error;
  throw ApiError.conflict('An offer template with this name already exists');
};

const validateContent = (content) => {
  const parsed = extractOfferTemplateVariables(content);
  if (parsed.unknownVariables.length) {
    throw ApiError.badRequest('Template contains unsupported variables', parsed.unknownVariables);
  }
  return parsed;
};

export const ensureDefaultOfferTemplate = async ({ companyId, actorId }) => {
  const usableContent = { $type: 'string', $regex: /\S/ };
  const defaultFilter = {
    companyId,
    isDefault: true,
    isActive: true,
    content: usableContent,
  };
  const existing = await OfferTemplate.findOne(defaultFilter);
  if (existing) return existing;

  // Earlier development records may contain an active template without body
  // content. Preserve those records as inactive instead of letting Mongoose
  // validation prevent every offer-editor request for the tenant.
  await OfferTemplate.updateMany(
    {
      companyId,
      isActive: true,
      content: { $not: /\S/ },
    },
    {
      $set: {
        isActive: false,
        isDefault: false,
        defaultKey: null,
        updatedBy: actorId,
      },
    }
  );

  const active = await OfferTemplate.findOne({
    companyId,
    isActive: true,
    content: usableContent,
  }).sort({ createdAt: 1 });
  if (active) {
    active.isDefault = true;
    active.updatedBy = actorId;
    try {
      await active.save();
      return active;
    } catch (error) {
      if (error.code !== 11000) throw error;
      return OfferTemplate.findOne(defaultFilter);
    }
  }

  const parsed = validateContent(DEFAULT_OFFER_TEMPLATE_CONTENT);
  const fallbackNames = [
    'Standard Employment Offer',
    'Crewly Standard Employment Offer',
  ];

  for (const name of fallbackNames) {
    try {
      return await OfferTemplate.create({
        companyId,
        name,
        description: 'Crewly standard plain-text employment offer template.',
        content: DEFAULT_OFFER_TEMPLATE_CONTENT,
        variables: parsed.variables,
        isDefault: true,
        createdBy: actorId,
        updatedBy: actorId,
      });
    } catch (error) {
      if (error.code !== 11000) throw error;
      const concurrentDefault = await OfferTemplate.findOne(defaultFilter);
      if (concurrentDefault) return concurrentDefault;
    }
  }

  throw ApiError.conflict(
    'A valid default offer template could not be initialized; update the inactive template and try again'
  );
};

export const listOfferTemplates = async ({ companyId, actorId, includeInactive = false }) => {
  await ensureDefaultOfferTemplate({ companyId, actorId });
  const filter = { companyId };
  if (!includeInactive) filter.isActive = true;

  const templates = await OfferTemplate.find(filter)
    .select('-defaultKey')
    .sort({ isDefault: -1, name: 1 })
    .lean();

  return { templates, supportedVariables: OFFER_TEMPLATE_VARIABLES };
};

export const getOfferTemplate = async ({ companyId, templateId }) => {
  const template = await OfferTemplate.findOne({ _id: templateId, companyId })
    .select('-defaultKey')
    .lean();
  if (!template) throw ApiError.notFound('Offer template not found');
  return template;
};

export const createOfferTemplate = async ({ companyId, actorId, payload }) => {
  const parsed = validateContent(payload.content);
  const previousDefault = payload.isDefault
    ? await OfferTemplate.findOne({ companyId, isDefault: true, isActive: true }).lean()
    : null;

  if (payload.isDefault) {
    await OfferTemplate.updateMany(
      { companyId, isDefault: true },
      { $set: { isDefault: false, defaultKey: null, updatedBy: actorId } }
    );
  }

  try {
    return await OfferTemplate.create({
      companyId,
      name: payload.name,
      description: payload.description || '',
      content: payload.content,
      variables: parsed.variables,
      isDefault: Boolean(payload.isDefault),
      isActive: true,
      createdBy: actorId,
      updatedBy: actorId,
    });
  } catch (error) {
    if (previousDefault) {
      await OfferTemplate.updateOne(
        { _id: previousDefault._id, companyId, isActive: true },
        { $set: { isDefault: true, defaultKey: 'DEFAULT', updatedBy: previousDefault.updatedBy } }
      ).catch(() => {});
    }
    return duplicateMessage(error);
  }
};

export const updateOfferTemplate = async ({ companyId, actorId, templateId, payload }) => {
  const template = await OfferTemplate.findOne({ _id: templateId, companyId });
  if (!template) throw ApiError.notFound('Offer template not found');
  const original = template.toObject();

  const content = payload.content ?? template.content;
  const parsed = validateContent(content);
  const removesCurrentDefault =
    template.isDefault &&
    (payload.isDefault === false || payload.isActive === false);
  const replacementDefault = removesCurrentDefault
    ? await OfferTemplate.findOne({
        companyId,
        _id: { $ne: template._id },
        isActive: true,
      }).sort({ createdAt: 1 })
    : null;

  if (removesCurrentDefault && !replacementDefault) {
    throw ApiError.badRequest(
      'Create another active template before removing the current default'
    );
  }

  const previousDefault = payload.isDefault === true
    ? await OfferTemplate.findOne({
        companyId,
        _id: { $ne: template._id },
        isDefault: true,
        isActive: true,
      }).lean()
    : null;
  if (payload.isDefault === true) {
    await OfferTemplate.updateMany(
      { companyId, _id: { $ne: template._id }, isDefault: true },
      { $set: { isDefault: false, defaultKey: null, updatedBy: actorId } }
    );
  }

  const contentChanged = content !== template.content;
  template.name = payload.name ?? template.name;
  template.description = payload.description ?? template.description;
  template.content = content;
  template.variables = parsed.variables;
  template.isDefault = payload.isDefault ?? template.isDefault;
  template.isActive = payload.isActive ?? template.isActive;
  if (!template.isActive) template.isDefault = false;
  if (contentChanged) template.version += 1;
  template.updatedBy = actorId;

  let currentSaved = false;
  try {
    const saved = await template.save();
    currentSaved = true;
    if (replacementDefault) {
      replacementDefault.isDefault = true;
      replacementDefault.updatedBy = actorId;
      await replacementDefault.save();
    }
    return saved;
  } catch (error) {
    if (currentSaved) {
      await OfferTemplate.updateOne(
        { _id: template._id, companyId },
        {
          $set: {
            name: original.name,
            description: original.description,
            content: original.content,
            variables: original.variables,
            version: original.version,
            isActive: original.isActive,
            isDefault: original.isDefault,
            defaultKey: original.isActive && original.isDefault ? 'DEFAULT' : null,
            updatedBy: original.updatedBy,
          },
        }
      ).catch(() => {});
    }
    if (previousDefault) {
      await OfferTemplate.updateOne(
        { _id: previousDefault._id, companyId, isActive: true },
        { $set: { isDefault: true, defaultKey: 'DEFAULT', updatedBy: previousDefault.updatedBy } }
      ).catch(() => {});
    }
    return duplicateMessage(error);
  }
};

export const deactivateOfferTemplate = async ({ companyId, actorId, templateId }) =>
  updateOfferTemplate({
    companyId,
    actorId,
    templateId,
    payload: { isActive: false, isDefault: false },
  });
