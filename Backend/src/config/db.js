import mongoose from 'mongoose';
import env from './env.js';
import logger from './logger.js';
import HelpdeskAuthorizationFence from '../models/HelpdeskAuthorizationFence.js';
import HelpdeskTicket from '../models/HelpdeskTicket.js';
import HelpdeskTicketLifecycleEvent from '../models/HelpdeskTicketLifecycleEvent.js';

const ensureHelpdeskAuthorizationFenceIndex = async () => {
  // Keep the write path disabled at boot unless Mongo confirms the unique
  // compound key that makes the membership fence a shared serialization point.
  await HelpdeskAuthorizationFence.init();
  const cursor = HelpdeskAuthorizationFence.collection.listIndexes();
  const indexes = typeof cursor?.toArray === 'function' ? await cursor.toArray() : await cursor;
  const fenceIndex = (indexes || []).find((index) =>
    index.name === 'helpdesk_authorization_fence_unique'
      && index.unique === true
      && index.key?.companyId === 1
      && index.key?.queueId === 1
      && index.key?.userId === 1
      && Object.keys(index.key || {}).length === 3,
  );
  if (!fenceIndex) {
    throw new Error('Required Helpdesk authorization fence index is not available');
  }
};

const ensureHelpdeskLifecycleIndexes = async () => {
  await HelpdeskTicket.collection.createIndex(
    { autoCloseAt: 1, companyId: 1, _id: 1 },
    {
      name: 'helpdesk_ticket_auto_close_due',
      partialFilterExpression: {
        ticketKind: 'HELPDESK',
        status: 'resolved',
        autoCloseAt: { $type: 'date' },
      },
    },
  );
  await HelpdeskTicketLifecycleEvent.collection.createIndex(
    { companyId: 1, ticketId: 1, sequence: 1 },
    { unique: true, name: 'helpdesk_ticket_lifecycle_sequence_unique' },
  );
  await HelpdeskTicketLifecycleEvent.collection.createIndex(
    { companyId: 1, ticketId: 1, occurredAt: -1, sequence: -1 },
    { name: 'helpdesk_ticket_lifecycle_history' },
  );

  const ticketCursor = HelpdeskTicket.collection.listIndexes();
  const ticketIndexes = typeof ticketCursor?.toArray === 'function'
    ? await ticketCursor.toArray()
    : await ticketCursor;
  const lifecycleCursor = HelpdeskTicketLifecycleEvent.collection.listIndexes();
  const lifecycleIndexes = typeof lifecycleCursor?.toArray === 'function'
    ? await lifecycleCursor.toArray()
    : await lifecycleCursor;
  const keyMatches = (index, expected) =>
    JSON.stringify(Object.entries(index?.key || {})) === JSON.stringify(Object.entries(expected));
  const autoCloseIndex = (ticketIndexes || []).find((index) =>
    index.name === 'helpdesk_ticket_auto_close_due'
      && keyMatches(index, { autoCloseAt: 1, companyId: 1, _id: 1 }),
  );
  const sequenceIndex = (lifecycleIndexes || []).find((index) =>
    index.name === 'helpdesk_ticket_lifecycle_sequence_unique'
      && index.unique === true
      && keyMatches(index, { companyId: 1, ticketId: 1, sequence: 1 }),
  );
  const historyIndex = (lifecycleIndexes || []).find((index) =>
    index.name === 'helpdesk_ticket_lifecycle_history'
      && keyMatches(index, { companyId: 1, ticketId: 1, occurredAt: -1, sequence: -1 }),
  );
  if (!autoCloseIndex || !sequenceIndex || !historyIndex) {
    throw new Error('Required Helpdesk lifecycle indexes are not available');
  }
};

const connectDB = async () => {
  try {
    mongoose.set('strictQuery', true);

    const conn = await mongoose.connect(env.MONGO_URI, {
      serverSelectionTimeoutMS: 10000,
    });

    await ensureHelpdeskAuthorizationFenceIndex();
    await ensureHelpdeskLifecycleIndexes();
    logger.info(`✅ MongoDB connected: ${conn.connection.host}/${conn.connection.name}`);
  } catch (error) {
    logger.error(`❌ MongoDB connection failed: ${error.message}`);
    process.exit(1);
  }
};

mongoose.connection.on('disconnected', () => {
  logger.warn('⚠️  MongoDB disconnected');
});

mongoose.connection.on('error', (err) => {
  logger.error(`MongoDB error: ${err.message}`);
});

export default connectDB;