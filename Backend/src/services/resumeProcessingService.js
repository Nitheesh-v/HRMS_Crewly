import crypto from 'node:crypto';
import Candidate from '../models/Candidate.js';
import CandidateHistory from '../models/CandidateHistory.js';
import CandidateResume from '../models/CandidateResume.js';
import ResumeParseResult from '../models/ResumeParseResult.js';
import ApiError from '../utils/ApiError.js';
import { recordAudit } from '../utils/securityauditService.js';
import { getStoredResumeBuffer } from './resumeStorageService.js';
import {
  ResumeExtractionError,
  extractResumeText,
} from './resumeTextExtractionService.js';
import {
  RESUME_PARSER_VERSION,
  parseResumeDeterministically,
} from './resumeDeterministicParser.js';
import { uniqueStrings } from './resumeNormalizationService.js';
import { dispatchATSMatching } from './atsDispatcher.js';

const MAX_ATTEMPTS = Math.min(
  20,
  Math.max(2, Number(process.env.RESUME_PARSE_MAX_ATTEMPTS) || 8)
);
const LEASE_MS = Math.min(
  30 * 60 * 1000,
  Math.max(60 * 1000, Number(process.env.RESUME_PARSE_LEASE_MS) || 5 * 60 * 1000)
);
const REPROCESS_COOLDOWN_MS = Math.min(
  60 * 60 * 1000,
  Math.max(
    15 * 1000,
    Number(process.env.RESUME_REPROCESS_COOLDOWN_MS) || 60 * 1000
  )
);
const MAX_FILE_BYTES = Math.min(
  10 * 1024 * 1024,
  Math.max(
    1024,
    (Number(process.env.MAX_RESUME_SIZE_MB) || 5) * 1024 * 1024
  )
);
const PROCESSABLE_STATUSES = ['PENDING', 'RETRY_PENDING'];
const REPROCESSABLE_STATUSES = [
  'COMPLETED',
  'FAILED',
  'UNSUPPORTED',
  'REVIEW_REQUIRED',
  'PARSED',
];

const candidateReferenceFilter = (candidateRef) =>
  /^[a-f\d]{24}$/i.test(String(candidateRef || ''))
    ? { _id: candidateRef }
    : { candidateCode: String(candidateRef || '').trim().toUpperCase() };

const lifecycleMetadata = ({
  parserVersion = RESUME_PARSER_VERSION,
  attempt = 0,
  status = '',
  failureCategory = '',
  warningCount = 0,
}) => ({
  parserVersion,
  attempt,
  ...(status ? { status } : {}),
  ...(failureCategory ? { failureCategory } : {}),
  ...(warningCount ? { warningCount } : {}),
});

const recordSystemLifecycle = async ({
  resume,
  action,
  status,
  attempt,
  failureCategory = '',
  warningCount = 0,
}) => {
  const metadata = lifecycleMetadata({
    attempt,
    status,
    failureCategory,
    warningCount,
  });

  await CandidateHistory.create({
    companyId: resume.companyId,
    candidate: resume.candidate,
    job: resume.job,
    action,
    source: 'RESUME_PARSER',
    actorType: 'SYSTEM',
    metadata,
    eventAt: new Date(),
  });

  await recordAudit({
    req: null,
    action,
    companyId: resume.companyId,
    actorName: 'Crewly resume processor',
    actorRole: 'SYSTEM',
    resource: 'CandidateResume',
    resourceId: resume._id,
    statusCode: status === 'FAILED' || status === 'UNSUPPORTED' ? 500 : 200,
    metadata,
    critical: true,
  });
};

const ensureParseResult = async ({ resume, status, now }) =>
  ResumeParseResult.findOneAndUpdate(
    {
      companyId: resume.companyId,
      resume: resume._id,
      parserVersion: RESUME_PARSER_VERSION,
    },
    {
      $setOnInsert: {
        companyId: resume.companyId,
        candidate: resume.candidate,
        resume: resume._id,
        source: 'RESUME_PARSER',
        parserVersion: RESUME_PARSER_VERSION,
        requestedAt: resume.parsingRequestedAt || now,
      },
      $set: {
        status,
        startedAt: now,
        completedAt: null,
        failedAt: null,
        failureCategory: 'NONE',
        safeErrorMessage: '',
        processingLeaseId: resume.processingLeaseId,
        processingLeaseExpiresAt: resume.processingLeaseExpiresAt,
      },
      $inc: { attemptCount: 1 },
    },
    { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
  );

// retryable = the failure is TRANSIENT (storage/infrastructure). The
// worker keeps RETRY_PENDING state and lets BullMQ back off + retry;
// terminal content errors (corrupt, password protected, unsupported,
// parser crash) fail fast and only manual reprocess re-enters.
const safeFailure = (error, stage) => {
  if (error instanceof ResumeExtractionError) {
    return {
      category: error.category,
      message: error.safeMessage,
      status:
        error.category === 'UNSUPPORTED_FORMAT' ? 'UNSUPPORTED' : 'FAILED',
      retryable: false,
    };
  }

  if (error instanceof ApiError) {
    if (error.statusCode === 413) {
      return {
        category: 'RESOURCE_LIMIT',
        message: 'The stored resume exceeds the processing safety limit.',
        status: 'FAILED',
        retryable: false,
      };
    }

    return {
      category: 'STORAGE_UNAVAILABLE',
      message: 'The original resume is temporarily unavailable for processing.',
      status: 'FAILED',
      retryable: true,
    };
  }

  return {
    category: stage === 'PERSISTENCE' ? 'PERSISTENCE_FAILED' : 'PARSER_FAILED',
    message:
      stage === 'PERSISTENCE'
        ? 'The parsed resume could not be saved. Reprocessing can be requested.'
        : 'The resume parser could not complete this document.',
    status: 'FAILED',
    retryable: stage === 'PERSISTENCE',
  };
};

// Retryable transient failure with attempts remaining: clear the
// lease and keep RETRY_PENDING so the next attempt (BullMQ backoff,
// or worker recovery) can claim it. Deliberately NO history/audit
// row — retries must not spam the candidate timeline.
const persistRetryPending = async ({
  resume,
  parseResultId,
  failure,
  startedAt,
}) => {
  const now = new Date();
  const duration = Math.max(0, now.getTime() - startedAt.getTime());

  const updates = [
    CandidateResume.updateOne(
      {
        _id: resume._id,
        companyId: resume.companyId,
        candidate: resume.candidate,
        processingLeaseId: resume.processingLeaseId,
      },
      {
        $set: {
          parsingStatus: 'RETRY_PENDING',
          processingLeaseId: '',
          processingLeaseExpiresAt: null,
        },
      }
    ),
  ];

  if (parseResultId) {
    updates.push(
      ResumeParseResult.updateOne(
        {
          _id: parseResultId,
          companyId: resume.companyId,
          processingLeaseId: resume.processingLeaseId,
        },
        {
          $set: {
            status: 'RETRY_PENDING',
            completedAt: null,
            failureCategory: failure.category,
            safeErrorMessage: failure.message,
            processingLeaseId: '',
            processingLeaseExpiresAt: null,
            'processingMetadata.processingDurationMs': duration,
          },
        }
      )
    );
  }

  await Promise.all(updates);
};

const persistFailure = async ({ resume, parseResultId, failure, startedAt }) => {
  const now = new Date();
  const duration = Math.max(0, now.getTime() - startedAt.getTime());

  await Promise.all([
    CandidateResume.updateOne(
      {
        _id: resume._id,
        companyId: resume.companyId,
        candidate: resume.candidate,
        processingLeaseId: resume.processingLeaseId,
      },
      {
        $set: {
          parsingStatus: failure.status,
          parsingCompletedAt: now,
          processingLeaseId: '',
          processingLeaseExpiresAt: null,
        },
      }
    ),
    ResumeParseResult.updateOne(
      {
        _id: parseResultId,
        companyId: resume.companyId,
        processingLeaseId: resume.processingLeaseId,
      },
      {
        $set: {
          status: failure.status,
          failedAt: now,
          completedAt: null,
          failureCategory: failure.category,
          safeErrorMessage: failure.message,
          processingLeaseId: '',
          processingLeaseExpiresAt: null,
          'processingMetadata.processingDurationMs': duration,
        },
      }
    ),
  ]);

  await recordSystemLifecycle({
    resume,
    action: 'RESUME_PARSE_FAILED',
    status: failure.status,
    attempt: resume.parsingAttempts,
    failureCategory: failure.category,
  });
};

// Worker entry (28.4): the BullMQ adapter calls this; the atomic
// Mongo claim below is the single-flight guarantee (at-least-once
// deliveries all lose except the claim winner).
//   finalAttempt — the worker passes true when BullMQ has no more
//     attempts left; retryable failures then fail terminally.
//   dispatchATS  — DI seam (tests); default is the real BullMQ
//     dispatcher from atsDispatcher.
export const processResumeJob = async ({
  companyId,
  candidateId,
  resumeId,
  finalAttempt = false,
  dispatchATS = dispatchATSMatching,
}) => {
  const now = new Date();
  const leaseId = crypto.randomUUID();
  const leaseExpiresAt = new Date(now.getTime() + LEASE_MS);
  const resume = await CandidateResume.findOneAndUpdate(
    {
      _id: resumeId,
      companyId,
      candidate: candidateId,
      status: 'UPLOADED',
      scanStatus: { $ne: 'REJECTED' },
      parsingStatus: { $in: PROCESSABLE_STATUSES },
      parsingAttempts: { $lt: MAX_ATTEMPTS },
    },
    {
      $set: {
        parsingStatus: 'PROCESSING',
        parserVersion: RESUME_PARSER_VERSION,
        parsingStartedAt: now,
        parsingCompletedAt: null,
        processingLeaseId: leaseId,
        processingLeaseExpiresAt: leaseExpiresAt,
      },
      $inc: { parsingAttempts: 1 },
    },
    {
      returnDocument: 'after',
      select:
        '+storageKey +processingLeaseId +processingLeaseExpiresAt companyId candidate job storageProvider mimeType fileSize status parsingStatus parsingAttempts parsingRequestedAt',
    }
  ).lean();

  if (!resume) return { accepted: false, reason: 'NOT_PROCESSABLE' };

  let parseResult;
  let stage = 'PERSISTENCE';
  const startedAt = new Date();

  try {
    parseResult = await ensureParseResult({
      resume,
      status: 'PROCESSING',
      now: startedAt,
    });

    await recordSystemLifecycle({
      resume,
      action: 'RESUME_PARSE_STARTED',
      status: 'PROCESSING',
      attempt: resume.parsingAttempts,
    });

    stage = 'EXTRACTION';
    const buffer = await getStoredResumeBuffer({
      storageProvider: resume.storageProvider,
      storageKey: resume.storageKey,
      maximumBytes: Math.min(MAX_FILE_BYTES, resume.fileSize || MAX_FILE_BYTES),
    });
    const extraction = await extractResumeText({
      buffer,
      mimeType: resume.mimeType,
    });

    stage = 'PARSER';
    const parsed = extraction.reviewRequired
      ? {
          structuredData: {},
          warnings: [],
          extractionConfidence: {
            overall: extraction.confidence,
            textExtraction: extraction.confidence,
            sectionDetection: 0,
            dateNormalization: 0,
          },
        }
      : parseResumeDeterministically({
          rawText: extraction.rawText,
          extraction,
        });
    const resultStatus = extraction.reviewRequired
      ? 'REVIEW_REQUIRED'
      : 'COMPLETED';
    const warnings = uniqueStrings(
      [...(extraction.warnings || []), ...(parsed.warnings || [])],
      50,
      300
    );
    const completedAt = new Date();
    const duration = Math.max(0, completedAt.getTime() - startedAt.getTime());

    stage = 'PERSISTENCE';
    await Promise.all([
      ResumeParseResult.updateOne(
        {
          _id: parseResult._id,
          companyId: resume.companyId,
          processingLeaseId: resume.processingLeaseId,
        },
        {
          $set: {
            status: resultStatus,
            rawText: extraction.rawText,
            structuredData: parsed.structuredData,
            warnings,
            extractionConfidence: parsed.extractionConfidence,
            extractorVersion: extraction.extractorVersion,
            completedAt,
            failedAt: null,
            failureCategory:
              resultStatus === 'REVIEW_REQUIRED'
                ? 'NO_EXTRACTABLE_TEXT'
                : 'NONE',
            safeErrorMessage: '',
            processingLeaseId: '',
            processingLeaseExpiresAt: null,
            processingMetadata: {
              mimeType: resume.mimeType,
              inputBytes: buffer.length,
              expandedBytes: extraction.expandedBytes || 0,
              extractedCharacters: extraction.rawText.length,
              pageCount: extraction.pageCount || 0,
              processedPageCount: extraction.processedPageCount || 0,
              processingDurationMs: duration,
            },
          },
        }
      ),
      CandidateResume.updateOne(
        {
          _id: resume._id,
          companyId: resume.companyId,
          candidate: resume.candidate,
          processingLeaseId: resume.processingLeaseId,
        },
        {
          $set: {
            parsingStatus: resultStatus,
            parsingCompletedAt: completedAt,
            processingLeaseId: '',
            processingLeaseExpiresAt: null,
          },
        }
      ),
    ]);

    await recordSystemLifecycle({
      resume,
      action: 'RESUME_PARSED',
      status: resultStatus,
      attempt: resume.parsingAttempts,
      warningCount: warnings.length,
    });

    if (resultStatus === 'COMPLETED') {
      // Chain AFTER the parse commit: a crash here leaves "COMPLETED
      // parse + no ATSResult", which ATS recovery re-derives (§37).
      dispatchATS({
        companyId: resume.companyId,
        candidateId: resume.candidate,
        jobId: resume.job,
        resumeId: resume._id,
        parseResultId: parseResult._id,
        trigger: 'RESUME_PARSED',
        requestEpoch: completedAt,
      });
    }

    return { accepted: true, status: resultStatus };
  } catch (error) {
    const failure = safeFailure(error, stage);

    if (failure.retryable && !finalAttempt) {
      // Transient (storage/persistence) failure with attempts left:
      // keep RETRY_PENDING (no history spam), release the lease, and
      // let the worker signal BullMQ to back off + retry.
      try {
        await persistRetryPending({
          resume,
          parseResultId: parseResult?._id,
          failure,
          startedAt,
        });
      } catch {
        // Lease will expire; recovery reclaims. Never throw here —
        // the caller maps the retryable outcome for BullMQ.
      }
      return { accepted: true, status: 'RETRY_PENDING', retryable: true };
    }

    if (parseResult?._id) {
      try {
        await persistFailure({
          resume,
          parseResultId: parseResult._id,
          failure,
          startedAt,
        });
      } catch {
        await CandidateResume.updateOne(
          { _id: resume._id, companyId: resume.companyId },
          {
            $set: {
              parsingStatus: 'FAILED',
              parsingCompletedAt: new Date(),
              processingLeaseId: '',
              processingLeaseExpiresAt: null,
            },
          }
        ).catch(() => {});
      }
    } else {
      await CandidateResume.updateOne(
        { _id: resume._id, companyId: resume.companyId },
        {
          $set: {
            parsingStatus: failure.status,
            parsingCompletedAt: new Date(),
            processingLeaseId: '',
            processingLeaseExpiresAt: null,
          },
        }
      ).catch(() => {});
    }

    return { accepted: true, status: failure.status };
  }
};

export const requestResumeReprocess = async ({
  companyId,
  candidateRef,
  actorId,
}) => {
  const candidate = await Candidate.findOne({
    companyId,
    ...candidateReferenceFilter(candidateRef),
  })
    .select('_id candidateCode job')
    .lean();

  if (!candidate) throw ApiError.notFound('Candidate not found');

  const currentResume = await CandidateResume.findOne({
    companyId,
    candidate: candidate._id,
    status: 'UPLOADED',
  })
    .select(
      '_id job scanStatus parsingStatus parsingAttempts parsingRequestedAt lastReprocessRequestedAt'
    )
    .lean();

  if (!currentResume || currentResume.scanStatus === 'REJECTED') {
    throw ApiError.notFound('Resume not found');
  }

  if (['PENDING', 'RETRY_PENDING', 'PROCESSING'].includes(currentResume.parsingStatus)) {
    throw new ApiError(409, 'Resume processing is already pending or in progress');
  }

  if (currentResume.parsingAttempts >= MAX_ATTEMPTS) {
    throw new ApiError(
      409,
      'The resume has reached the reprocessing attempt limit. Contact an administrator.'
    );
  }

  const now = new Date();
  const cooldownBoundary = new Date(now.getTime() - REPROCESS_COOLDOWN_MS);

  if (
    currentResume.lastReprocessRequestedAt &&
    currentResume.lastReprocessRequestedAt > cooldownBoundary
  ) {
    throw new ApiError(429, 'Please wait before requesting resume reprocessing again');
  }

  const resume = await CandidateResume.findOneAndUpdate(
    {
      _id: currentResume._id,
      companyId,
      candidate: candidate._id,
      scanStatus: { $ne: 'REJECTED' },
      parsingStatus: { $in: REPROCESSABLE_STATUSES },
      parsingAttempts: { $lt: MAX_ATTEMPTS },
      $or: [
        { lastReprocessRequestedAt: { $lte: cooldownBoundary } },
        { lastReprocessRequestedAt: null },
        { lastReprocessRequestedAt: { $exists: false } },
      ],
    },
    {
      $set: {
        parsingStatus: 'RETRY_PENDING',
        parserVersion: RESUME_PARSER_VERSION,
        parsingRequestedAt: now,
        lastReprocessRequestedAt: now,
        parsingStartedAt: null,
        processingLeaseId: '',
        processingLeaseExpiresAt: null,
      },
    },
    { returnDocument: 'after' }
  ).lean();

  if (!resume) {
    throw new ApiError(409, 'Resume reprocessing could not be scheduled');
  }

  await ResumeParseResult.updateOne(
    {
      companyId,
      resume: resume._id,
      parserVersion: RESUME_PARSER_VERSION,
    },
    {
      $setOnInsert: {
        companyId,
        candidate: candidate._id,
        resume: resume._id,
        source: 'RESUME_PARSER',
        parserVersion: RESUME_PARSER_VERSION,
      },
      $set: {
        status: 'RETRY_PENDING',
        requestedAt: now,
        nextRetryAllowedAt: new Date(now.getTime() + REPROCESS_COOLDOWN_MS),
        failureCategory: 'NONE',
        safeErrorMessage: '',
      },
    },
    { upsert: true, setDefaultsOnInsert: true }
  );

  await CandidateHistory.create({
    companyId,
    candidate: candidate._id,
    job: resume.job || candidate.job,
    action: 'RESUME_REPROCESS_REQUESTED',
    source: 'RESUME_PARSER',
    actorType: 'TENANT_USER',
    actor: actorId,
    metadata: lifecycleMetadata({
      status: 'RETRY_PENDING',
      attempt: resume.parsingAttempts,
    }),
    eventAt: now,
  });

  return {
    candidate,
    resume,
    parserVersion: RESUME_PARSER_VERSION,
    status: 'RETRY_PENDING',
  };
};

export const resumeProcessingConfiguration = {
  parserVersion: RESUME_PARSER_VERSION,
  maxAttempts: MAX_ATTEMPTS,
  leaseMs: LEASE_MS,
  cooldownMs: REPROCESS_COOLDOWN_MS,
};
