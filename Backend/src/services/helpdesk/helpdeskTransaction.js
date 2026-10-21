import mongoose from 'mongoose';

import ApiError from '../../utils/ApiError.js';

const DEFAULT_TRANSACTION_ATTEMPTS = 3;
const DEFAULT_COMMIT_ATTEMPTS = 3;

const hasLabel = (error, label) => {
  try {
    if (typeof error?.hasErrorLabel === 'function' && error.hasErrorLabel(label)) return true;
  } catch {
    // Fall through to the driver's public errorLabels array.
  }
  return Array.isArray(error?.errorLabels) && error.errorLabels.includes(label);
};

const isTransientTransactionError = (error) =>
  error?.helpdeskTransientTransactionError === true
  || hasLabel(error, 'TransientTransactionError')
  || [112, 251].includes(Number(error?.code));

const isUnknownCommitResult = (error) => hasLabel(error, 'UnknownTransactionCommitResult');

const unavailable = (message, cause) => {
  const error = ApiError.unavailable(message);
  if (cause) error.cause = cause;
  return error;
};

const unknownCommitOutcome = (cause) => {
  const error = unavailable('The Helpdesk write outcome could not be confirmed.', cause);
  error.commitOutcomeUnknown = true;
  return error;
};

const transientRetryError = (cause) => {
  const error = new Error('Helpdesk transaction must be retried', { cause });
  error.helpdeskTransientTransactionError = true;
  return error;
};

const safelyAbort = async (session) => {
  try {
    if (typeof session?.inTransaction !== 'function' || session.inTransaction()) {
      await session?.abortTransaction?.();
    }
  } catch {
    // Work errors happen before commit. Aborting is best-effort; this function
    // never retries after a commit outcome became uncertain.
  }
};

const safelyEnd = async (session) => {
  try {
    await session?.endSession?.();
  } catch {
    // Session disposal must not hide the transaction result.
  }
};

export const runHelpdeskTransaction = async (
  work,
  {
    startSession = () => mongoose.startSession(),
    maxAttempts = DEFAULT_TRANSACTION_ATTEMPTS,
    maxCommitAttempts = DEFAULT_COMMIT_ATTEMPTS,
  } = {},
) => {
  const transactionAttempts = Math.max(1, Math.min(5, Number(maxAttempts) || DEFAULT_TRANSACTION_ATTEMPTS));
  const commitAttempts = Math.max(1, Math.min(5, Number(maxCommitAttempts) || DEFAULT_COMMIT_ATTEMPTS));
  if (typeof work !== 'function') throw new TypeError('A Helpdesk transaction callback is required');

  for (let attempt = 0; attempt < transactionAttempts; attempt += 1) {
    let session;
    let transactionStarted = false;
    try {
      session = await startSession();
      session.startTransaction({
        readConcern: { level: 'snapshot' },
        writeConcern: { w: 'majority' },
        readPreference: 'primary',
      });
      transactionStarted = true;

      // The callback re-reads authorization on every attempt. Only transient
      // transaction conflicts rerun it; uncertain commits never do.
      const result = await work(session, attempt);
      let committed = false;
      for (let commitAttempt = 0; commitAttempt < commitAttempts; commitAttempt += 1) {
        try {
          await session.commitTransaction();
          committed = true;
          break;
        } catch (error) {
          if (isUnknownCommitResult(error)) {
            if (commitAttempt + 1 < commitAttempts) continue;
            throw unknownCommitOutcome(error);
          }
          if (isTransientTransactionError(error)) throw transientRetryError(error);
          // A network or unlabelled commit error may have committed. Be
          // conservative: do not re-run the callback or issue another write.
          throw unknownCommitOutcome(error);
        }
      }

      if (!committed) throw unknownCommitOutcome();
      return result;
    } catch (error) {
      if (error?.commitOutcomeUnknown === true) throw error;

      await safelyAbort(session);
      if (isTransientTransactionError(error) && attempt + 1 < transactionAttempts) continue;
      if (error?.statusCode) throw error;
      throw unavailable('The Helpdesk transaction could not be completed.', error);
    } finally {
      if (transactionStarted || session) await safelyEnd(session);
    }
  }

  throw unavailable('The Helpdesk transaction could not be completed.');
};

export const _test = {
  DEFAULT_COMMIT_ATTEMPTS,
  DEFAULT_TRANSACTION_ATTEMPTS,
  hasLabel,
  isTransientTransactionError,
  isUnknownCommitResult,
};
