import mongoose from 'mongoose';
import env from './env.js';
import logger from './logger.js';
import HelpdeskAuthorizationFence from '../models/HelpdeskAuthorizationFence.js';

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

const connectDB = async () => {
  try {
    mongoose.set('strictQuery', true);

    const conn = await mongoose.connect(env.MONGO_URI, {
      serverSelectionTimeoutMS: 10000,
    });

    await ensureHelpdeskAuthorizationFenceIndex();
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