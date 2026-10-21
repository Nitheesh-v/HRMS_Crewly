import crypto from 'node:crypto';
import mongoose from 'mongoose';

import HelpdeskAttachment from '../../models/HelpdeskAttachment.js';
import HelpdeskAuthorizationFence from '../../models/HelpdeskAuthorizationFence.js';
import HelpdeskMessage from '../../models/HelpdeskMessage.js';
import HelpdeskQueue from '../../models/HelpdeskQueue.js';
import HelpdeskTicket from '../../models/HelpdeskTicket.js';
import User from '../../models/User.js';
import logger from '../../config/logger.js';
import ApiError from '../../utils/ApiError.js';
import { SUPPORT_TICKET_KIND } from '../../utils/supportTicketKinds.js';
import { helpdeskTenantConfigService } from './helpdeskTenantConfigService.js';
import { helpdeskSlaService } from './helpdeskSlaService.js';
import { bumpHelpdeskAuthorizationFence } from './helpdeskAuthorizationFence.js';
import { runHelpdeskTransaction } from './helpdeskTransaction.js';
import {
  canReadHelpdeskTicket,
  hasConfidentialHelpdeskAgentAccess,
  idString,
  isHelpdeskQueueStaff,
} from './helpdeskAccess.js';
import {
  assertHelpdeskAttachmentStorageKey,
  assertAllowedHelpdeskAttachment,
} from './helpdeskFileRules.js';
import {
  HELPDESK_MESSAGE_ACTIVE_STATUSES,
  encodeHelpdeskMessageCursor,
  normalizeHelpdeskMessageBody,
  normalizeHelpdeskMessageHistoryQuery,
  normalizeHelpdeskMessageType,
} from './helpdeskRules.js';
import {
  destroyHelpdeskAttachment,
  planHelpdeskAttachmentStorage,
  resolveHelpdeskAttachmentDelivery,
  storeHelpdeskAttachment,
} from './helpdeskAttachmentStorage.js';

const TICKET_NUMBER = /^HD-\d{6,}$/;
const HELPDESK_ATTACHMENT_RECOVERY_GRACE_MS = 30 * 60 * 1000;
const MESSAGE_PROJECTION =
  '_id companyId ticketId authorUserId sequence publicSequence messageType body attachmentId createdAt';
const ATTACHMENT_METADATA_PROJECTION =
  '_id messageId originalFileName mimeType sizeBytes scanStatus createdAt';

const plain = (value) =>
  value && typeof value.toObject === 'function' ? value.toObject() : value;

const ensureContextIds = ({ companyId, actorId }) => {
  if (!companyId) throw ApiError.forbidden('A tenant is required.');
  if (!actorId) throw ApiError.unauthorized('An authenticated user is required.');
};

const assertEligibleState = (ticket) => {
  if (!HELPDESK_MESSAGE_ACTIVE_STATUSES.includes(String(ticket?.status || '').toLowerCase())) {
    throw ApiError.conflict('This Helpdesk ticket is not accepting messages.');
  }
};

export const helpdeskConversationService = (deps = {}) => {
  const TicketModel = deps.TicketModel || HelpdeskTicket;
  const QueueModel = deps.QueueModel || HelpdeskQueue;
  const FenceModel = deps.FenceModel || HelpdeskAuthorizationFence;
  const transactionRunner = deps.transactionRunner || runHelpdeskTransaction;
  // Staging acceptance uses the production authorization/transaction path but
  // must not enqueue user-facing notifications for disposable fixtures.
  const notificationIntentsEnabled = deps.notificationIntentsEnabled !== false;
  const MessageModel = deps.MessageModel || HelpdeskMessage;
  const AttachmentModel = deps.AttachmentModel || HelpdeskAttachment;
  const UserModel = deps.UserModel || User;
  const configService = deps.configService || helpdeskTenantConfigService({
    ConfigModel: deps.ConfigModel,
  });
  const slaService = deps.slaService || helpdeskSlaService({
    TicketModel,
    QueueModel,
    UserModel,
    MessageModel,
    PolicyModel: deps.PolicyModel,
    holidayReader: deps.holidayReader,
    now: deps.now,
    notificationIntentsEnabled,
  });
  const storeAttachment = deps.storeAttachment || storeHelpdeskAttachment;
  const planAttachmentStorage = deps.planAttachmentStorage || planHelpdeskAttachmentStorage;
  const destroyAttachment = deps.destroyAttachment || destroyHelpdeskAttachment;
  const deliverAttachment = deps.deliverAttachment || resolveHelpdeskAttachmentDelivery;
  const ObjectId = deps.ObjectId || mongoose.Types.ObjectId;
  const now = deps.now || (() => Date.now());

  const queryOne = async (modelQuery, projection = null, session = null) => {
    try {
      let query = modelQuery;
      if (session && typeof query?.session === 'function') query = query.session(session);
      if (projection && typeof query?.select === 'function') query = query.select(projection);
      if (typeof query?.lean === 'function') query = query.lean();
      return await query;
    } catch (error) {
      if (error?.statusCode || session) throw error;
      throw ApiError.unavailable('Helpdesk conversation data is temporarily unavailable.');
    }
  };

  const queryMany = async (modelQuery, { projection, sort, limit } = {}) => {
    try {
      let query = modelQuery;
      if (projection && typeof query?.select === 'function') query = query.select(projection);
      if (sort && typeof query?.sort === 'function') query = query.sort(sort);
      if (Number.isInteger(limit) && typeof query?.limit === 'function') query = query.limit(limit);
      if (typeof query?.lean === 'function') query = query.lean();
      return await query;
    } catch (error) {
      if (error?.statusCode) throw error;
      throw ApiError.unavailable('Helpdesk conversation data is temporarily unavailable.');
    }
  };

  const loadTicketContext = async ({ companyId, ticketNumber }, session = null) => {
    if (!TICKET_NUMBER.test(String(ticketNumber || ''))) {
      throw ApiError.notFound('Helpdesk ticket not found.');
    }
    const ticket = await queryOne(
      TicketModel.findOne({
        companyId,
        ticketKind: SUPPORT_TICKET_KIND.HELPDESK,
        ticketNumber,
      }),
      '_id companyId user queueId ticketNumber status isConfidential lastMessageSequence lastPublicMessageSequence',
      session,
    );
    if (!ticket) throw ApiError.notFound('Helpdesk ticket not found.');

    const queue = await queryOne(
      QueueModel.findOne({ _id: ticket.queueId, companyId }),
      '_id companyId agents managers confidentiality',
      session,
    );
    if (!queue) throw ApiError.notFound('Helpdesk ticket not found.');
    return { ticket, queue };
  };

  const authorizeReadContext = ({ ticket, queue, actorId, canReadOwn, canReadQueue }) => {
    const requester = idString(ticket.user) === idString(actorId);
    if (requester) {
      if (canReadOwn !== true) throw ApiError.notFound('Helpdesk ticket not found.');
      // Even a user who is also queue staff receives the employee-safe surface
      // for their own ticket; internal notes are never selected for them.
      return { audience: 'requester' };
    }

    if (!canReadHelpdeskTicket({
      ticket,
      queue,
      viewerId: actorId,
      access: { canReadOwn: false, canReadQueue },
    })) {
      throw ApiError.notFound('Helpdesk ticket not found.');
    }
    return {
      // Confidentiality reviewers may inspect ticket history under the existing
      // read boundary, but internal notes remain limited to actual queue staff.
      audience: isHelpdeskQueueStaff({ queue, actorId }) ? 'staff' : 'reviewer',
    };
  };

  const authorizeWriteContext = ({
    ticket,
    queue,
    actorId,
    messageType,
    canReadOwn,
    canReadQueue,
    canManage,
  }) => {
    const requester = idString(ticket.user) === idString(actorId);
    if (requester) {
      if (canReadOwn !== true) throw ApiError.notFound('Helpdesk ticket not found.');
      if (messageType !== 'PUBLIC') {
        throw ApiError.forbidden('Internal notes are only available to Helpdesk staff.');
      }
      return { audience: 'requester' };
    }

    const readable = canReadHelpdeskTicket({
      ticket,
      queue,
      viewerId: actorId,
      access: { canReadOwn: false, canReadQueue },
    });
    if (!readable || !isHelpdeskQueueStaff({ queue, actorId })) {
      // Reviewers are readers, not ticket mutators. Preserve the same
      // non-enumerating response used by the existing agent operations.
      throw ApiError.notFound('Helpdesk ticket not found.');
    }
    if (
      ticket.isConfidential === true
      && !hasConfidentialHelpdeskAgentAccess({ queue, actorId })
    ) {
      throw ApiError.notFound('Helpdesk ticket not found.');
    }
    if (canManage !== true) {
      throw ApiError.forbidden('You do not have permission to post Helpdesk messages.');
    }
    return { audience: 'staff' };
  };

  const loadReadableContext = async (input) => {
    ensureContextIds(input);
    const context = await loadTicketContext(input);
    const access = authorizeReadContext({ ...context, ...input });
    return { ...context, ...access };
  };

  const loadWritableContext = async (input, messageType, session = null) => {
    ensureContextIds(input);
    const context = await loadTicketContext(input, session);
    const access = authorizeWriteContext({ ...context, ...input, messageType });
    assertEligibleState(context.ticket);
    return { ...context, ...access };
  };

  const allocateSequence = async ({ context, companyId, ticketNumber, messageType, input, session }) => {
    const filter = {
      _id: context.ticket._id,
      companyId,
      ticketKind: SUPPORT_TICKET_KIND.HELPDESK,
      ticketNumber,
      queueId: context.ticket.queueId,
      user: context.ticket.user,
      isConfidential: context.ticket.isConfidential === true ? true : { $ne: true },
      status: { $in: HELPDESK_MESSAGE_ACTIVE_STATUSES },
    };
    const increment = { lastMessageSequence: 1 };
    if (messageType === 'PUBLIC') increment.lastPublicMessageSequence = 1;

    let query = TicketModel.findOneAndUpdate(
      filter,
      { $inc: increment },
      {
        returnDocument: 'after',
        runValidators: true,
        projection: { _id: 1, lastMessageSequence: 1, lastPublicMessageSequence: 1 },
        ...(session ? { session } : {}),
      },
    );
    if (typeof query?.lean === 'function') query = query.lean();
    const updated = await query;

    if (!updated) {
      // Re-evaluate authorization in the same snapshot before returning a
      // state conflict, preserving non-enumerating transfer/confidentiality behavior.
      const latest = await loadWritableContext(input, messageType, session);
      assertEligibleState(latest.ticket);
      throw ApiError.conflict('The ticket changed while the message was being saved. Refresh and try again.');
    }

    const sequence = Number(updated.lastMessageSequence);
    const publicSequence = messageType === 'PUBLIC'
      ? Number(updated.lastPublicMessageSequence)
      : undefined;
    if (!Number.isSafeInteger(sequence) || sequence < 1
      || (messageType === 'PUBLIC' && (!Number.isSafeInteger(publicSequence) || publicSequence < 1))) {
      throw ApiError.unavailable('The Helpdesk message could not be ordered safely.');
    }
    return { sequence, publicSequence };
  };

  const loadAuthorNames = async ({ companyId, rows }) => {
    const authorIds = [...new Set(rows.map((row) => idString(row.authorUserId)).filter(Boolean))];
    if (!authorIds.length) return new Map();
    const users = await queryMany(
      UserModel.find({ companyId, _id: { $in: authorIds } }),
      { projection: '_id name' },
    );
    return new Map((users || []).map((user) => [idString(user._id), String(user.name || '').slice(0, 60)]));
  };

  const serializeMessage = ({ row, authorName, ticket, attachment = null }) => ({
    id: idString(row._id),
    messageType: String(row.messageType || 'PUBLIC').toLowerCase(),
    body: row.body || null,
    author: {
      type: idString(ticket.user) === idString(row.authorUserId) ? 'requester' : 'support',
      displayName: authorName || null,
    },
    createdAt: row.createdAt || null,
    attachments: attachment
      ? [{
          attachmentId: idString(attachment._id),
          fileName: attachment.originalFileName,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes,
        }]
      : [],
  });

  const listMessages = async ({
    companyId,
    actorId,
    ticketNumber,
    canReadOwn = false,
    canReadQueue = false,
    query = {},
  } = {}) => {
    ensureContextIds({ companyId, actorId });
    const { ticket, audience } = await loadReadableContext({
      companyId,
      actorId,
      ticketNumber,
      canReadOwn,
      canReadQueue,
    });
    const options = normalizeHelpdeskMessageHistoryQuery(query);
    const sequenceField = audience === 'staff' ? 'sequence' : 'publicSequence';
    const filter = {
      companyId,
      ticketId: ticket._id,
      ...(audience !== 'staff' ? { messageType: 'PUBLIC' } : {}),
      ...(options.cursorSequence ? { [sequenceField]: { $lt: options.cursorSequence } } : {}),
    };

    const rows = await queryMany(
      MessageModel.find(filter),
      {
        projection: MESSAGE_PROJECTION,
        sort: { [sequenceField]: -1, _id: -1 },
        limit: options.limit + 1,
      },
    );
    const visibleRows = audience !== 'staff'
      ? (rows || []).filter((row) => row.messageType === 'PUBLIC')
      : (rows || []);
    const hasMore = visibleRows.length > options.limit;
    const pageRows = visibleRows.slice(0, options.limit);

    const attachmentIds = pageRows.map((row) => row.attachmentId).filter(Boolean);
    let attachments = [];
    if (attachmentIds.length) {
      attachments = await queryMany(
        AttachmentModel.find({
          _id: { $in: attachmentIds },
          companyId,
          ticketId: ticket._id,
          messageId: { $in: pageRows.map((row) => row._id) },
          persistenceStatus: 'ACTIVE',
          cleanupRequired: { $ne: true },
        }),
        { projection: ATTACHMENT_METADATA_PROJECTION },
      );
    }
    const attachmentById = new Map((attachments || []).map((attachment) => [
      idString(attachment._id),
      attachment,
    ]));
    if (pageRows.some((row) => row.attachmentId && !attachmentById.has(idString(row.attachmentId)))) {
      throw ApiError.unavailable('Helpdesk attachment metadata is temporarily unavailable.');
    }
    const authorNames = await loadAuthorNames({ companyId, rows: pageRows });
    const messages = pageRows.map((row) => serializeMessage({
      row,
      ticket,
      authorName: authorNames.get(idString(row.authorUserId)),
      attachment: row.attachmentId ? attachmentById.get(idString(row.attachmentId)) ?? null : null,
    }));
    const lastRow = pageRows.at(-1);
    const nextCursor = hasMore && lastRow
      ? encodeHelpdeskMessageCursor(Number(lastRow[sequenceField]))
      : null;

    return {
      messages,
      meta: { limit: options.limit, hasMore, nextCursor },
    };
  };

  const resolveMessageAfterAmbiguousWrite = async ({ messageId, companyId, ticketId, actorId }) => {
    try {
      const row = await queryOne(
        MessageModel.findOne({ _id: messageId, companyId, ticketId, authorUserId: actorId }),
        MESSAGE_PROJECTION,
      );
      return row ? { state: 'found', row } : { state: 'missing', row: null };
    } catch {
      // A failed verification is not evidence that the original write failed.
      // Callers must preserve linked storage while the Mongo outcome is unknown.
      return { state: 'unknown', row: null };
    }
  };

  const displayNameForNewMessage = (value) => {
    if (typeof value !== 'string') return null;
    const safe = value.trim().replace(/[\u0000-\u001f\u007f-\u009f]/g, '').slice(0, 60);
    return safe || null;
  };

  const notificationFieldsForMessage = (messageType) => {
    if (!notificationIntentsEnabled || messageType !== 'PUBLIC') {
      return { notificationState: 'NOT_REQUIRED' };
    }
    return {
      notificationState: 'PENDING',
      notificationAttemptCount: 0,
      notificationNextAttemptAt: new Date(now()),
      notificationLeaseUntil: null,
    };
  };

  const readTenantConfigInTransaction = async ({ companyId, session }) => {
    if (typeof configService.readConfig === 'function') {
      return configService.readConfig({ companyId, session });
    }
    return configService.getConfig({ companyId });
  };

  const persistMessageInTransaction = async ({
    input,
    body,
    messageType,
    messageId,
    attachmentId = null,
    attachmentPersistence = null,
    onContext = () => {},
  }) => transactionRunner(async (session) => {
    const context = await loadWritableContext(input, messageType, session);
    onContext(context);

    if (attachmentPersistence) {
      const config = await readTenantConfigInTransaction({ companyId: input.companyId, session });
      if (config.attachmentsEnabled !== true) {
        throw ApiError.forbidden('Helpdesk attachments are not enabled for this tenant.');
      }
      if (idString(context.ticket._id) !== idString(attachmentPersistence.ticketId)) {
        throw ApiError.notFound('Helpdesk ticket not found.');
      }
    }

    if (context.audience === 'staff') {
      await bumpHelpdeskAuthorizationFence({
        FenceModel,
        companyId: input.companyId,
        queueId: context.queue._id,
        userIds: [input.actorId],
        session,
      });
    }

    const sequence = await allocateSequence({
      context,
      companyId: input.companyId,
      ticketNumber: input.ticketNumber,
      messageType,
      input,
      session,
    });
    const payload = {
      _id: messageId,
      companyId: input.companyId,
      ticketId: context.ticket._id,
      authorUserId: input.actorId,
      sequence: sequence.sequence,
      ...(sequence.publicSequence ? { publicSequence: sequence.publicSequence } : {}),
      messageType,
      body,
      attachmentId,
      ...notificationFieldsForMessage(messageType),
    };
    const created = await MessageModel.create([payload], { session });
    const row = plain(Array.isArray(created) ? created[0] : created);
    if (!row) throw ApiError.unavailable('The Helpdesk message could not be saved.');

    if (attachmentPersistence) {
      const activated = await AttachmentModel.updateOne(
        attachmentPersistence.filter,
        { $set: { persistenceStatus: 'ACTIVE', cleanupRequired: false } },
        { session },
      );
      if (
        activated?.acknowledged === false
        || activated?.matchedCount === 0
        || activated?.n === 0
      ) {
        throw ApiError.unavailable('Attachment persistence could not be confirmed.');
      }
    }

    return { context, row };
  });

  const persistTextMessage = async ({
    companyId,
    actorId,
    actorDisplayName,
    ticketNumber,
    body,
    messageType,
    canReadOwn,
    canReadQueue,
    canManage,
  }) => {
    const messageId = new ObjectId();
    const input = {
      companyId,
      actorId,
      ticketNumber,
      canReadOwn,
      canReadQueue,
      canManage,
    };
    let transactionContext = null;
    let persisted;
    try {
      persisted = await persistMessageInTransaction({
        input,
        body,
        messageType,
        messageId,
        onContext: (context) => { transactionContext = context; },
      });
    } catch (error) {
      if (error?.commitOutcomeUnknown !== true) throw error;
      const outcome = await resolveMessageAfterAmbiguousWrite({
        messageId,
        companyId,
        ticketId: transactionContext?.ticket?._id,
        actorId,
      });
      if (outcome.state !== 'found') {
        throw ApiError.unavailable('Helpdesk message persistence could not be confirmed.');
      }
      persisted = { context: transactionContext, row: outcome.row };
    }

    const { context, row } = persisted;
    if (messageType === 'PUBLIC' && context.audience === 'staff') {
      await slaService.persistFirstResponse({
        companyId,
        ticketId: context.ticket._id,
        createdAt: row?.createdAt || new Date(now()),
      });
    }

    return serializeMessage({
      row,
      ticket: context.ticket,
      authorName: displayNameForNewMessage(actorDisplayName),
    });
  };

  const createMessage = async (input = {}) => {
    const messageType = normalizeHelpdeskMessageType(input.messageType);
    const body = normalizeHelpdeskMessageBody(input.body);
    return persistTextMessage({ ...input, body, messageType });
  };

  const resolvePersistedAttachment = async ({
    attachmentId, _id, companyId, ticketId, messageId, uploadedByUserId,
  }) => {
    try {
      const row = await queryOne(
        AttachmentModel.findOne({
          _id: attachmentId || _id,
          companyId,
          ticketId,
          messageId,
          ...(uploadedByUserId ? { uploadedByUserId } : {}),
        }),
        '_id',
      );
      return row ? { state: 'found', row } : { state: 'missing', row: null };
    } catch {
      return { state: 'unknown', row: null };
    }
  };

  const writeCleanupMarker = async ({ attachmentPayload, attachmentPersisted }) => {
    const scoped = {
      _id: attachmentPayload._id,
      companyId: attachmentPayload.companyId,
      ticketId: attachmentPayload.ticketId,
      messageId: attachmentPayload.messageId,
      uploadedByUserId: attachmentPayload.uploadedByUserId,
    };
    try {
      if (attachmentPersisted) {
        await AttachmentModel.updateOne(scoped, {
          $set: { cleanupRequired: true, persistenceStatus: 'CLEANUP_REQUIRED' },
        });
        return true;
      }
      const existing = await resolvePersistedAttachment(scoped);
      if (existing.state === 'found') {
        await AttachmentModel.updateOne(scoped, {
          $set: { cleanupRequired: true, persistenceStatus: 'CLEANUP_REQUIRED' },
        });
        return true;
      }
      if (existing.state === 'unknown') return false;
      await AttachmentModel.create({
        ...attachmentPayload,
        cleanupRequired: true,
        persistenceStatus: 'CLEANUP_REQUIRED',
      });
      return true;
    } catch {
      // A simultaneous Mongo outage can prevent the recovery marker. The
      // provider key remains private and is reconstructable from these IDs.
      return false;
    }
  };

  const compensateAttachmentWrite = async ({
    stored,
    attachmentPayload,
    attachmentPersisted,
  }) => {
    if (!stored) return;
    let removed = false;
    try {
      removed = await destroyAttachment({
        storageProvider: stored.storageProvider,
        storageKey: stored.storageKey,
        companyId: attachmentPayload.companyId,
        ticketId: attachmentPayload.ticketId,
      }) === true;
    } catch {
      removed = false;
    }

    if (removed) {
      try {
        await AttachmentModel.deleteOne({
          _id: attachmentPayload._id,
          companyId: attachmentPayload.companyId,
          ticketId: attachmentPayload.ticketId,
          messageId: attachmentPayload.messageId,
          uploadedByUserId: attachmentPayload.uploadedByUserId,
        });
      } catch {
        await writeCleanupMarker({ attachmentPayload, attachmentPersisted: true });
      }
      return;
    }

    await writeCleanupMarker({ attachmentPayload, attachmentPersisted });
    logger.warn('helpdesk.attachment.cleanup_pending', {
      companyId: String(attachmentPayload.companyId),
      ticketId: String(attachmentPayload.ticketId),
      attachmentId: String(attachmentPayload._id),
    });
  };

  const assertAttachmentWriteAllowed = async (input = {}) => {
    await loadWritableContext(input, 'PUBLIC');
    const config = await configService.getConfig({ companyId: input.companyId });
    if (config.attachmentsEnabled !== true) {
      throw ApiError.forbidden('Helpdesk attachments are not enabled for this tenant.');
    }
    return true;
  };

  const createMessageWithAttachment = async (input = {}) => {
    const messageType = normalizeHelpdeskMessageType(input.messageType);
    const body = normalizeHelpdeskMessageBody(input.body, { allowEmpty: true });
    const fileInfo = assertAllowedHelpdeskAttachment({
      originalName: input.file?.originalname,
      mimeType: input.file?.mimetype,
      buffer: input.file?.buffer,
    });
    const initialContext = await loadWritableContext(input, messageType);
    const config = await configService.getConfig({ companyId: input.companyId });
    if (config.attachmentsEnabled !== true) {
      throw ApiError.forbidden('Helpdesk attachments are not enabled for this tenant.');
    }

    const attachmentId = new ObjectId();
    const messageId = new ObjectId();
    const ticketId = initialContext.ticket._id;
    const storagePlan = planAttachmentStorage({
      companyId: input.companyId,
      ticketId,
      attachmentId,
    });
    let stored = null;
    let attachmentPersisted = false;
    let attachmentPayload = {
      _id: attachmentId,
      companyId: input.companyId,
      ticketId,
      messageId,
      uploadedByUserId: input.actorId,
      storageProvider: storagePlan.storageProvider,
      storageKey: storagePlan.storageKey,
      checksumSha256: crypto.createHash('sha256').update(input.file.buffer).digest('hex'),
      originalFileName: fileInfo.originalFileName,
      mimeType: fileInfo.mimeType,
      sizeBytes: fileInfo.sizeBytes,
      scanStatus: 'NOT_CONFIGURED',
      persistenceStatus: 'UPLOADING',
      cleanupRequired: false,
    };
    let attachmentWriteState = 'not_attempted';
    let messageWriteState = 'not_attempted';

    const attachmentScope = () => ({
      _id: attachmentId,
      companyId: input.companyId,
      ticketId: attachmentPayload.ticketId,
      messageId,
      uploadedByUserId: input.actorId,
    });
    const logRecovery = (event) => logger.warn(event, {
      companyId: String(input.companyId),
      ticketId: String(attachmentPayload.ticketId),
      attachmentId: String(attachmentId),
      messageId: String(messageId),
    });

    try {
      // Persist a private, non-deliverable upload intent before provider I/O.
      // If the process or provider response is lost, the deterministic key and
      // tenant/ticket-scoped row let the worker reconcile without public URLs.
      attachmentWriteState = 'attempted';
      try {
        await AttachmentModel.create(attachmentPayload);
        attachmentPersisted = true;
        attachmentWriteState = 'committed';
      } catch (error) {
        const outcome = await resolvePersistedAttachment({
          attachmentId,
          companyId: input.companyId,
          ticketId,
          messageId,
          uploadedByUserId: input.actorId,
        });
        if (outcome.state === 'found') {
          attachmentPersisted = true;
          attachmentWriteState = 'committed';
        } else if (outcome.state === 'unknown') {
          attachmentWriteState = 'unknown';
          throw ApiError.unavailable('Attachment persistence could not be confirmed.');
        } else {
          attachmentWriteState = 'missing';
          throw error;
        }
      }

      stored = await storeAttachment({
        buffer: input.file.buffer,
        companyId: input.companyId,
        ticketId,
        attachmentId,
        storageProvider: storagePlan.storageProvider,
        storageKey: storagePlan.storageKey,
      });
      assertHelpdeskAttachmentStorageKey({
        storageProvider: stored?.storageProvider,
        storageKey: stored?.storageKey,
        companyId: input.companyId,
        ticketId,
      });
      if (
        stored.storageProvider !== storagePlan.storageProvider
        || stored.storageKey !== storagePlan.storageKey
      ) {
        throw ApiError.unavailable('Secure file storage is temporarily unavailable.');
      }
      const uploadedState = await AttachmentModel.updateOne(
        { ...attachmentScope(), persistenceStatus: 'UPLOADING', cleanupRequired: { $ne: true } },
        { $set: { persistenceStatus: 'PENDING' } },
      );
      if (
        uploadedState?.acknowledged === false
        || uploadedState?.matchedCount === 0
        || uploadedState?.n === 0
      ) {
        throw ApiError.unavailable('Attachment persistence could not be confirmed.');
      }

      // The provider upload remains outside Mongo. This transaction re-reads
      // current authorization and tenant configuration, allocates both message
      // counters, inserts the message, and activates its private metadata atomically.
      let transactionContext = null;
      let persisted;
      messageWriteState = 'attempted';
      try {
        persisted = await persistMessageInTransaction({
          input,
          body,
          messageType,
          messageId,
          attachmentId,
          attachmentPersistence: {
            ticketId: attachmentPayload.ticketId,
            filter: {
              ...attachmentScope(),
              persistenceStatus: 'PENDING',
              cleanupRequired: { $ne: true },
            },
          },
          onContext: (context) => { transactionContext = context; },
        });
        messageWriteState = 'committed';
      } catch (error) {
        if (error?.commitOutcomeUnknown !== true) throw error;
        const outcome = await resolveMessageAfterAmbiguousWrite({
          messageId,
          companyId: input.companyId,
          ticketId: transactionContext?.ticket?._id || attachmentPayload.ticketId,
          actorId: input.actorId,
        });
        if (outcome.state === 'found') {
          persisted = { context: transactionContext || initialContext, row: outcome.row };
          messageWriteState = 'committed';
        } else {
          // A missing read after an unknown commit is not proof of abort. Keep
          // both private bytes and metadata for the existing reconciler.
          messageWriteState = 'unknown';
          throw ApiError.unavailable('Helpdesk message persistence could not be confirmed.');
        }
      }

      attachmentPayload = { ...attachmentPayload, ticketId: persisted.context.ticket._id };
      if (messageType === 'PUBLIC' && persisted.context.audience === 'staff') {
        await slaService.persistFirstResponse({
          companyId: input.companyId,
          ticketId: persisted.context.ticket._id,
          createdAt: persisted.row?.createdAt || new Date(now()),
        });
      }

      return serializeMessage({
        row: persisted.row,
        ticket: persisted.context.ticket,
        authorName: displayNameForNewMessage(input.actorDisplayName),
        attachment: {
          _id: attachmentId,
          originalFileName: fileInfo.originalFileName,
          mimeType: fileInfo.mimeType,
          sizeBytes: fileInfo.sizeBytes,
        },
      });
    } catch (error) {
      if (attachmentPersisted && attachmentPayload) {
        if (
          attachmentWriteState === 'unknown'
          || messageWriteState === 'unknown'
          || messageWriteState === 'committed'
          || !stored
        ) {
          // Never delete bytes while Mongo may have committed the referencing
          // message. The bounded reconciler resolves uncertain/pending metadata
          // against the message row and removes only confirmed orphans.
          logRecovery('helpdesk.attachment.reconciliation_pending');
        } else if (stored) {
          await compensateAttachmentWrite({ stored, attachmentPayload, attachmentPersisted });
        }
      } else if (stored) {
        // Defensive fallback for an unexpected metadata-construction failure.
        try {
          const removed = await destroyAttachment({
            storageProvider: stored.storageProvider,
            storageKey: stored.storageKey,
            companyId: input.companyId,
            ticketId,
          });
          if (removed !== true) logRecovery('helpdesk.attachment.cleanup_pending');
        } catch {
          logRecovery('helpdesk.attachment.cleanup_pending');
        }
      }
      if (error?.statusCode) throw error;
      throw ApiError.unavailable('The Helpdesk message could not be saved.');
    }
  };

  const reconcileAttachmentPersistence = async ({ companyId, attachmentId, ticketId, uploadedByUserId } = {}) => {
    if (!companyId) throw ApiError.forbidden('A tenant is required.');
    if (!ticketId || !uploadedByUserId) throw ApiError.badRequest('Attachment recovery scope is invalid.');
    if (!/^[a-f\d]{24}$/i.test(String(attachmentId || ''))) {
      throw ApiError.badRequest('attachmentId is invalid.');
    }
    const attachment = await queryOne(
      AttachmentModel.findOne({
        _id: attachmentId,
        companyId,
        ticketId,
        uploadedByUserId,
        $or: [
          { persistenceStatus: 'UPLOADING' },
          { persistenceStatus: 'PENDING' },
          { persistenceStatus: 'CLEANUP_REQUIRED' },
          { cleanupRequired: true },
        ],
      }),
      '_id companyId ticketId messageId uploadedByUserId storageProvider createdAt +persistenceStatus +cleanupRequired +storageKey +checksumSha256',
    );
    if (!attachment) return { status: 'not_pending' };

    const scope = {
      _id: attachment._id,
      companyId,
      ticketId: attachment.ticketId,
      messageId: attachment.messageId,
      uploadedByUserId: attachment.uploadedByUserId,
    };
    const cleanup = async () => {
      const removed = await destroyAttachment({
        storageProvider: attachment.storageProvider,
        storageKey: attachment.storageKey,
        companyId,
        ticketId: attachment.ticketId,
      });
      if (removed === true) {
        try {
          await AttachmentModel.deleteOne(scope);
          return { status: 'removed' };
        } catch {
          await writeCleanupMarker({ attachmentPayload: attachment, attachmentPersisted: true });
          return { status: 'cleanup_pending' };
        }
      }
      await writeCleanupMarker({ attachmentPayload: attachment, attachmentPersisted: true });
      logger.warn('helpdesk.attachment.cleanup_pending', {
        companyId: String(companyId),
        ticketId: String(attachment.ticketId),
        attachmentId: String(attachment._id),
      });
      return { status: 'cleanup_pending' };
    };

    if (attachment.persistenceStatus === 'CLEANUP_REQUIRED' || attachment.cleanupRequired === true) {
      return cleanup();
    }

    const message = await queryOne(
      MessageModel.findOne({
        _id: attachment.messageId,
        companyId,
        ticketId: attachment.ticketId,
        authorUserId: uploadedByUserId,
        attachmentId: attachment._id,
      }),
      '_id companyId ticketId authorUserId attachmentId',
    );
    if (!message) return cleanup();
    if (idString(message.authorUserId) !== idString(attachment.uploadedByUserId)) {
      logger.warn('helpdesk.attachment.reconciliation_mismatch', {
        companyId: String(companyId),
        ticketId: String(attachment.ticketId),
        attachmentId: String(attachment._id),
      });
      return { status: 'manual_review' };
    }

    const activation = await AttachmentModel.updateOne(
      { ...scope, persistenceStatus: { $in: ['UPLOADING', 'PENDING'] }, cleanupRequired: { $ne: true } },
      { $set: { persistenceStatus: 'ACTIVE', cleanupRequired: false } },
    );
    if (activation?.acknowledged === false || activation?.matchedCount === 0 || activation?.n === 0) {
      return { status: 'pending' };
    }
    return { status: 'activated' };
  };

  const reconcilePendingAttachments = async ({ companyId, limit = 25 } = {}) => {
    if (!companyId) throw ApiError.forbidden('A tenant is required.');
    const boundedLimit = Number.isInteger(Number(limit))
      ? Math.min(50, Math.max(1, Number(limit)))
      : 25;
    const cutoff = new Date(now() - HELPDESK_ATTACHMENT_RECOVERY_GRACE_MS);
    const rows = await queryMany(
      AttachmentModel.find({
        companyId,
        createdAt: { $lte: cutoff },
        $or: [
          { persistenceStatus: 'UPLOADING' },
          { persistenceStatus: 'PENDING' },
          { persistenceStatus: 'CLEANUP_REQUIRED' },
          { cleanupRequired: true },
        ],
      }),
      {
        projection: '_id ticketId uploadedByUserId',
        sort: { createdAt: 1, _id: 1 },
        limit: boundedLimit,
      },
    );
    const summary = { inspected: 0, activated: 0, removed: 0, cleanupPending: 0, manualReview: 0 };
    for (const row of rows || []) {
      summary.inspected += 1;
      const result = await reconcileAttachmentPersistence({
        companyId,
        attachmentId: row._id,
        ticketId: row.ticketId,
        uploadedByUserId: row.uploadedByUserId,
      });
      if (result.status === 'activated') summary.activated += 1;
      if (result.status === 'removed') summary.removed += 1;
      if (result.status === 'cleanup_pending' || result.status === 'pending') summary.cleanupPending += 1;
      if (result.status === 'manual_review') summary.manualReview += 1;
    }
    return summary;
  };

  const authorizeAttachmentDownload = async ({
    companyId,
    actorId,
    ticketNumber,
    attachmentId,
    canReadOwn = false,
    canReadQueue = false,
  } = {}) => {
    ensureContextIds({ companyId, actorId });
    const { ticket, queue } = await loadTicketContext({ companyId, ticketNumber });
    const { audience } = authorizeReadContext({ ticket, queue, actorId, canReadOwn, canReadQueue });

    let attachment;
    try {
      attachment = await queryOne(
        AttachmentModel.findOne({
          _id: attachmentId,
          companyId,
          ticketId: ticket._id,
          persistenceStatus: 'ACTIVE',
          cleanupRequired: { $ne: true },
        }),
        '_id companyId ticketId messageId uploadedByUserId storageProvider originalFileName mimeType sizeBytes scanStatus createdAt +cleanupRequired +persistenceStatus +storageKey +checksumSha256',
      );
    } catch (error) {
      if (error?.statusCode) throw error;
      throw ApiError.unavailable('Helpdesk attachment access is temporarily unavailable.');
    }
    if (
      !attachment
      || attachment.cleanupRequired === true
      || attachment.persistenceStatus !== 'ACTIVE'
    ) {
      throw ApiError.notFound('File not found.');
    }

    const message = await queryOne(
      MessageModel.findOne({
        _id: attachment.messageId,
        companyId,
        ticketId: ticket._id,
        authorUserId: attachment.uploadedByUserId,
        attachmentId: attachment._id,
        ...(audience !== 'staff' ? { messageType: 'PUBLIC' } : {}),
      }),
      '_id companyId ticketId authorUserId messageType attachmentId',
    );
    if (!message || idString(message.authorUserId) !== idString(attachment.uploadedByUserId)) {
      throw ApiError.notFound('File not found.');
    }

    // A storage key is useful only after all database ownership and visibility
    // checks above have succeeded.
    assertHelpdeskAttachmentStorageKey({
      storageProvider: attachment.storageProvider,
      storageKey: attachment.storageKey,
      companyId,
      ticketId: ticket._id,
    });
    return { ...attachment, ticketNumber: ticket.ticketNumber, audience };
  };

  return {
    listMessages,
    createMessage,
    assertAttachmentWriteAllowed,
    createMessageWithAttachment,
    authorizeAttachmentDownload,
    resolveAttachmentDelivery: (attachment) => deliverAttachment({ attachment }),
    reconcileAttachmentPersistence,
    reconcilePendingAttachments,
  };
};
