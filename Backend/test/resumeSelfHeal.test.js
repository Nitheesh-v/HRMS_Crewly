// ATS stall recovery — hermetic suite for the read-path self-heal.
//
// A PENDING parse intent whose BullMQ job was lost (degraded enqueue while
// Redis was down, worker started before the upload, worker restart gap)
// used to show "Waiting for resume parsing" forever: reprocess 409'd and
// the UI hid the recovery button. The poll now detects the stale intent,
// re-dispatches the deterministic job id (idempotent) and exposes
// reprocessAvailable so HR can unstick it manually.
//
// No MongoDB/Redis here: collaborators are injected.

import assert from 'node:assert/strict';
import test from 'node:test';

import { getCandidateParsedResume } from '../src/services/candidateInboxService.js';

const COMPANY = 'aaa111111111111111111111';
const CANDIDATE_ID = 'ccc333333333333333333333';
const RESUME_ID = 'rrr444444444444444444444';

const makeDeps = ({ parsingStatus, requestedAt, result = null, dispatchError = false }) => {
  const calls = [];
  const deps = {
    loadCandidate: async () => ({ _id: CANDIDATE_ID, candidateCode: 'CAN-000002' }),
    loadResume: async () => ({
      _id: RESUME_ID,
      parsingStatus,
      parserVersion: 'v3',
      parsingAttempts: 0,
      parsingRequestedAt: requestedAt,
      parsingStartedAt: null,
      parsingCompletedAt: null,
    }),
    loadResult: async () => result,
    dispatch: async (job) => {
      calls.push(job);
      if (dispatchError) throw new Error('queue unavailable');
      return { accepted: true, queued: true };
    },
  };
  return { deps, calls };
};

test('stale PENDING intent is re-dispatched on poll and reprocess opens up', async () => {
  const { deps, calls } = makeDeps({
    parsingStatus: 'PENDING',
    requestedAt: new Date(Date.now() - 5 * 60 * 1000), // 5 min old
  });
  const view = await getCandidateParsedResume({ companyId: COMPANY, candidateRef: 'CAN-000002', deps });
  assert.equal(calls.length, 1);
  assert.equal(String(calls[0].resumeId), RESUME_ID);
  assert.equal(view.stalePending, true);
  assert.equal(view.reprocessAvailable, true);
  assert.equal(view.status, 'PENDING');
});

test('fresh PENDING intent is NOT re-dispatched and stays waiting', async () => {
  const { deps, calls } = makeDeps({
    parsingStatus: 'PENDING',
    requestedAt: new Date(), // just enqueued
  });
  const view = await getCandidateParsedResume({ companyId: COMPANY, candidateRef: 'CAN-000002', deps });
  assert.equal(calls.length, 0);
  assert.equal(view.stalePending, false);
  assert.equal(view.reprocessAvailable, false);
});

test('COMPLETED parse does not dispatch and stays reprocessable', async () => {
  const { deps, calls } = makeDeps({
    parsingStatus: 'COMPLETED',
    requestedAt: new Date(Date.now() - 10 * 60 * 1000),
    result: { status: 'COMPLETED', parserVersion: 'v3', attemptCount: 1 },
  });
  const view = await getCandidateParsedResume({ companyId: COMPANY, candidateRef: 'CAN-000002', deps });
  assert.equal(calls.length, 0);
  assert.equal(view.status, 'COMPLETED');
  assert.equal(view.reprocessAvailable, true);
});

test('dispatch failure never breaks the poll (degraded mode preserved)', async () => {
  const { deps, calls } = makeDeps({
    parsingStatus: 'PENDING',
    requestedAt: new Date(Date.now() - 5 * 60 * 1000),
    dispatchError: true,
  });
  const view = await getCandidateParsedResume({ companyId: COMPANY, candidateRef: 'CAN-000002', deps });
  assert.equal(calls.length, 1);
  assert.equal(view.status, 'PENDING');
  assert.equal(view.reprocessAvailable, true);
});
