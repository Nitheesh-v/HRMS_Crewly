// ─────────────────────────────────────────────────────────────
// Email delivery outbox service (28.3)
//
// Business operations call dispatchEmailDelivery AFTER their Mongo
// state is committed. The outbox guarantees:
//   1. the intent is persisted (PENDING) before the queue is touched
//   2. duplicate logical events collapse on a unique eventKey
//   3. queue failure marks FAILED_TO_QUEUE (reconciliation target)
//      — it NEVER rolls back business state and NEVER falls back
//      to an uncertain synchronous send
//   4. reconciliation re-enqueues stuck deliveries with the SAME
//      deterministic job id (email:<deliveryId>)
//
// Payloads and this document carry REFERENCES ONLY — no PII, no
// tokens, no rendered content.
// ─────────────────────────────────────────────────────────────
import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import EmailDelivery from '../models/EmailDelivery.js';
import { enqueueJob, getQueue, prepareJobSlot } from '../queues/queueFactory.js';
import {
  QUEUE_NAMES,
  JOB_NAMES,
  buildJobId,
  getEmailJobOptions,
  redactConnectionSecrets,
} from '../config/queueConfig.js';

const RECIPIENT_TYPES = new Set(['CANDIDATE', 'INTERVIEWER', 'EMPLOYEE', 'HR']);

const safeText = (error) =>
  redactConnectionSecrets(String(error?.message || 'unknown error')).slice(0, 200);

// Stable business identity of one logical event. Safe parts only
// (ids, versions, short codes) — the buildJobId rules apply:
// colon-joined, no spaces/control chars, bounded length.
export const buildEventKey = (...parts) => buildJobId(...parts);

// BullMQ custom job ids may NOT contain ':' (it uses colons as its
// key separator and rejects them). The delivery's Mongo id is
// globally unique, so this single-part hyphen id is deterministic
// and collision-free: email-<deliveryId>.
export const buildEmailJobId = (deliveryId) => buildJobId(`email-${deliveryId}`);

// Default enqueue — overridable in tests (dependency injection).
export const defaultEnqueueEmail = (jobName, payload, jobId) =>
  enqueueJob(QUEUE_NAMES.EMAIL, jobName, payload, {
    jobId,
    ...getEmailJobOptions(),
  });

// BullMQ NEVER re-creates an already-used jobId: adding a job whose
// id already exists returns the EXISTING job as a no-op. For a
// waiting/active job that is the dedupe we want; for a job that DIED
// (retries exhausted) it blocks recovery forever — the record sits
// in QUEUED while the dead job lingers in the failed set.
//
// So reconciliation prepares the slot: if the previous job with this
// id is FAILED, remove it so the same deterministic id can be
// re-added as a fresh job. Alive jobs are left untouched.
// Returns 'absent', 'failed-removed', or the observed live state.
// Exported for hermetic tests.
// Shared slot prep (queueFactory) — keeps the deterministic job id
// re-addable after a dead FAILED job without touching live jobs.
export const prepareEmailJobSlot = (queue, jobId) => prepareJobSlot(queue, jobId);

// Reconciliation enqueue: clears a dead previous job before adding.
export const defaultReconcileEnqueue = async (jobName, payload, jobId) => {
  const queue = getQueue(QUEUE_NAMES.EMAIL);
  await prepareEmailJobSlot(queue, jobId);
  return enqueueJob(QUEUE_NAMES.EMAIL, jobName, payload, {
    jobId,
    ...getEmailJobOptions(),
  });
};

const validateDispatchArgs = ({ jobName, eventType, eventKey, companyId, entityType, entityId, recipientType }) => {
  if (!jobName || !String(jobName).startsWith('email-')) {
    throw new Error('dispatchEmailDelivery: jobName must be an EMAIL_* job name');
  }
  if (!eventType || !eventKey) throw new Error('dispatchEmailDelivery: eventType and eventKey are required');
  if (!mongoose.isValidObjectId(companyId)) throw new Error('dispatchEmailDelivery: companyId is required');
  if (!entityType || !mongoose.isValidObjectId(entityId)) {
    throw new Error('dispatchEmailDelivery: entityType and entityId are required');
  }
  if (!RECIPIENT_TYPES.has(recipientType)) {
    throw new Error('dispatchEmailDelivery: recipientType must be CANDIDATE|INTERVIEWER|EMPLOYEE|HR');
  }
};

// Idempotent outbox dispatch. Returns:
//   { delivery, queued, duplicate, error? }
// Operational queue failures NEVER throw — they land in the result
// and on the delivery record (FAILED_TO_QUEUE).
export const dispatchEmailDelivery = async ({
  jobName,
  eventType,
  eventKey,
  companyId,
  entityType,
  entityId,
  recipientType,
  recipientReference = null,
  payload = {},
  DeliveryModel = EmailDelivery,
  enqueue = defaultEnqueueEmail,
}) => {
  validateDispatchArgs({ jobName, eventType, eventKey, companyId, entityType, entityId, recipientType });

  // 1) Duplicate logical event? The unique eventKey collapses it.
  //    Scoped by companyId: a cross-tenant eventKey collision must
  //    never return another tenant's record.
  const existing = await DeliveryModel.findOne({ eventKey, companyId }).catch(() => null);
  if (existing) {
    return {
      delivery: existing,
      queued: ['QUEUED', 'PROCESSING'].includes(existing.status),
      duplicate: true,
    };
  }

  // 2) Persist the intent FIRST (PENDING), then touch Redis.
  const correlationId = randomUUID();
  let delivery;
  try {
    delivery = await DeliveryModel.create({
      companyId,
      jobName,
      eventType,
      eventKey,
      entityType,
      entityId,
      recipientType,
      recipientReference: recipientReference ?? null,
      status: 'PENDING',
    });
  } catch (error) {
    if (error?.code === 11000) {
      const raced = await DeliveryModel.findOne({ eventKey, companyId });
      if (raced) return { delivery: raced, queued: ['QUEUED', 'PROCESSING'].includes(raced.status), duplicate: true };
    }
    throw error;
  }

  // The job payload carries REFERENCES ONLY plus the identity fields
  // the worker validator requires (deliveryId, correlationId,
  // companyId). eventType stays on the delivery record — it is not
  // part of the job payload contract.
  const recordPayload = {
    ...payload,
    companyId,
    deliveryId: String(delivery._id),
    correlationId,
  };
  await DeliveryModel.updateOne({ _id: delivery._id }, { $set: { payload: recordPayload } }).catch(() => {});

  // 3) Enqueue with a deterministic job id (no email/token inside).
  const jobId = buildEmailJobId(delivery._id);
  try {
    const job = await enqueue(jobName, recordPayload, jobId);
    await DeliveryModel.updateOne(
      { _id: delivery._id, status: 'PENDING' },
      { $set: { status: 'QUEUED', queueJobId: String(job?.id || jobId), queuedAt: new Date() } }
    ).catch(() => {});
    return { delivery, queued: true, duplicate: false };
  } catch (error) {
    // Redis/queue failure: business state is already committed and
    // stays committed. The delivery becomes a reconciliation target.
    await DeliveryModel.updateOne(
      { _id: delivery._id, status: 'PENDING' },
      {
        $set: {
          status: 'FAILED_TO_QUEUE',
          lastFailureCategory: 'QUEUE_UNAVAILABLE',
        },
      }
    ).catch(() => {});
    const failed = await DeliveryModel.findOne({ _id: delivery._id, companyId }).catch(() => delivery);
    return { delivery: failed, queued: false, duplicate: false, error: safeText(error) };
  }
};

// Never-throwing wrapper for business services: an email side
// effect must never break the business operation. Returns
// { queued, delivery, error? } instead of throwing.
export const requestEmailDelivery = async (args) => {
  try {
    return await dispatchEmailDelivery(args);
  } catch (error) {
    return { queued: false, delivery: null, error: safeText(error) };
  }
};

// Atomic worker claim. Returns the delivery when claimed, or null
// when it is already terminal (SENT/FAILED/STALE) — a duplicate or
// replayed job then skips safely.
export const claimEmailDelivery = async (deliveryId, companyId, { DeliveryModel = EmailDelivery } = {}) => {
  if (!mongoose.isValidObjectId(deliveryId) || !mongoose.isValidObjectId(companyId)) return null;
  return DeliveryModel.findOneAndUpdate(
    {
      _id: deliveryId,
      companyId,
      status: { $in: ['PENDING', 'QUEUED', 'PROCESSING'] },
    },
    { $set: { status: 'PROCESSING', processingAt: new Date() }, $inc: { attemptCount: 1 } },
    { returnDocument: 'after' }
  );
};

// Terminal update. SENT is final and can never be overwritten;
// FAILED/STALE are final for the delivery's lifetime.
export const markEmailDelivery = async (deliveryId, companyId, update, { DeliveryModel = EmailDelivery } = {}) => {
  if (!mongoose.isValidObjectId(deliveryId) || !mongoose.isValidObjectId(companyId)) return null;
  const fields = { ...update };
  if (fields.status === 'SENT') fields.sentAt = new Date();
  if (fields.status === 'FAILED') fields.failedAt = new Date();
  if (fields.status === 'STALE') fields.failedAt = new Date();
  return DeliveryModel.findOneAndUpdate(
    { _id: deliveryId, companyId, status: { $nin: ['SENT', 'FAILED', 'STALE'] } },
    { $set: fields }
  );
};

// Reconciliation core: re-enqueue stuck deliveries with their
// original deterministic job id. Scans:
//   - PENDING         (created, enqueue never confirmed)
//   - FAILED_TO_QUEUE (enqueue failed, e.g. Redis was down)
//   - QUEUED          (stale: the job can DIE in Redis — retries
//                      exhausted while Mongo was unreachable, worker
//                      crash — leaving the record stuck in QUEUED
//                      forever). Re-adding the same deterministic
//                      job id is safe: if the original job is still
//                      alive, BullMQ's job-id dedupe makes it a no-op.
// The 60s min-age keeps this from touching healthy in-flight jobs.
export const reconcileStuckEmailDeliveries = async ({
  minAgeMs = 60000,
  limit = 100,
  DeliveryModel = EmailDelivery,
  enqueue = defaultReconcileEnqueue,
} = {}) => {
  const cutoff = new Date(Date.now() - minAgeMs);
  const stuck = await DeliveryModel.find({
    status: { $in: ['PENDING', 'FAILED_TO_QUEUE', 'QUEUED'] },
    createdAt: { $lt: cutoff },
  })
    .limit(limit)
    .lean();

  const results = [];
  for (const delivery of stuck) {
    const jobId = buildEmailJobId(delivery._id);
    try {
      const job = await enqueue(delivery.jobName, delivery.payload || {}, jobId);
      await DeliveryModel.updateOne(
        { _id: delivery._id, status: { $in: ['PENDING', 'FAILED_TO_QUEUE'] } },
        {
          $set: {
            status: 'QUEUED',
            queueJobId: String(job?.id || jobId),
            queuedAt: new Date(),
          },
        }
      );
      results.push({ deliveryId: String(delivery._id), requeued: true });
    } catch (error) {
      results.push({ deliveryId: String(delivery._id), requeued: false, error: safeText(error) });
    }
  }

  return {
    scanned: stuck.length,
    requeued: results.filter((r) => r.requeued).length,
    results,
  };
};
