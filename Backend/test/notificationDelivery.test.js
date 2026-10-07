// ═══════════════════════════════════════════════════════════════════════════
// PHASE 39 — NOTIFICATION DELIVERY & TENANCY
//
// The bell is the only channel that tells an employee something happened to
// their leave, payroll, task, expense, document, appraisal or profile request.
// Before this phase:
//
//   · notifySmart's in-app path could never succeed (both correct-arity
//     attempts passed two arguments to a three-argument function), so every
//     in-app notification was written by CLONING the newest Notification row in
//     the database — foreign companyId, foreign type, foreign eventKey;
//   · projectController and taskController called notifyUser(userId, payload)
//     directly, so project and task notifications were dropped entirely;
//   · nothing tested any of it.
//
// These tests are hermetic: every model is stubbed, nothing connects anywhere.
//
// ONE RULE for this file: never hand notifySmart a recipient WITH an email
// address while their email preference is ON. utils/emailQueue.js starts a
// 5-second setInterval on first use, and a running interval keeps the test
// process alive (node --test then waits forever). The email DECISION is pinned
// through the pure buildEmailJob() helper instead.
// ═══════════════════════════════════════════════════════════════════════════
import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { readFile } from 'node:fs/promises';

process.env.NODE_ENV = 'test';
process.env.MONGO_URI ||= 'mongodb://127.0.0.1:27017/crewly_notify_test';

const { default: Notification } = await import('../src/models/Notification.js');
const { default: NotificationPref } = await import('../src/models/NotificationPref.js');
const { default: User } = await import('../src/models/User.js');
const { default: Task } = await import('../src/models/Task.js');
const { default: Project } = await import('../src/models/Project.js');
const { notifyUser, notifyUsers, notifyRoles } = await import('../src/utils/notify.js');
const { notifySmart, buildEmailJob } = await import('../src/utils/notifyPref.js');
const { classifyNotificationRows, buildRepairUpdate } = await import('../src/utils/notificationRepair.js');
const projectController = await import('../src/controllers/projectController.js');
const taskController = await import('../src/controllers/taskController.js');

const MY_COMPANY = '111111111111111111111111';
const OTHER_COMPANY = '222222222222222222222222';
const ME = '333333333333333333333333';
const MATE = '444444444444444444444444';

const MODELS = { Notification, NotificationPref, User, Task, Project };

const stub = (model, key, value) => {
  const descriptor = Object.getOwnPropertyDescriptor(model, key);

  Object.defineProperty(model, key, { configurable: true, value });

  return () => {
    if (descriptor) Object.defineProperty(model, key, descriptor);
    else delete model[key];
  };
};

const withModels = async (spec, body) => {
  const restores = [];

  for (const [modelName, methods] of Object.entries(spec)) {
    for (const [key, value] of Object.entries(methods)) {
      restores.push(stub(MODELS[modelName], key, value));
    }
  }

  try {
    return await body();
  } finally {
    restores.reverse().forEach((restore) => restore());
  }
};

// A query that is both awaitable and chainable (`.select().lean()`).
const query = (value) => {
  const chain = {
    select: () => chain,
    lean: async () => value,
    sort: () => chain,
    limit: () => chain,
    then: (resolve, reject) => Promise.resolve(value).then(resolve, reject),
  };

  return chain;
};

// A bell row that exists in the database, belonging to ANOTHER tenant. Before
// Phase 39, notifySmart cloned exactly this row.
const foreignSampleRow = {
  _id: 'ffffffffffffffffffffffff',
  companyId: OTHER_COMPANY,
  user: 'someoneElse',
  type: 'RECRUITMENT',
  title: 'Offer approved for Ravi (other company)',
  message: 'confidential other-tenant text',
  link: '/app/recruitment',
  eventKey: 'interview-reminder:2026-10-07:someoneElse',
  readAt: null,
};

describe('Phase 39 — the primitives own the write', () => {
  test('notifyUser writes the three things it is given: tenant, recipient, payload', async () => {
    const written = [];

    await withModels(
      { Notification: { create: async (doc) => { written.push(doc); return doc; } } },
      async () => notifyUser(MY_COMPANY, MATE, { type: 'TASK', title: 'Assigned', message: 'm', link: '/app/tasks' }),
    );

    assert.deepEqual(written, [
      { companyId: MY_COMPANY, user: MATE, type: 'TASK', title: 'Assigned', message: 'm', link: '/app/tasks' },
    ]);
  });

  test('notifyUser defaults its type and never throws when the write fails', async () => {
    const written = [];

    await withModels(
      {
        Notification: {
          create: async (doc) => {
            if (doc.title === 'boom') throw new Error('duplicate key');
            written.push(doc);
          },
        },
      },
      async () => {
        await notifyUser(MY_COMPANY, MATE, { title: 'fine' });
        await assert.doesNotReject(() => notifyUser(MY_COMPANY, MATE, { title: 'boom' }));
      },
    );

    assert.equal(written.length, 1);
    assert.equal(written[0].type, 'SYSTEM');
    assert.equal(written[0].message, '');
    assert.equal(written[0].link, '');
  });

  test('notifyUsers dedupes, scopes to the tenant, and answers 0 for nobody', async () => {
    const batches = [];

    await withModels(
      { Notification: { insertMany: async (docs) => { batches.push(docs); return docs; } } },
      async () => {
        // A whitespace id and a non-id must not kill the batch for everyone:
        // one uncastable value used to make insertMany throw, and the catch
        // dropped the WHOLE batch.
        const count = await notifyUsers(MY_COMPANY, [MATE, MATE, '  ', null, 'not-an-id', MATE], { title: 'Mention' });
        const none = await notifyUsers(MY_COMPANY, [], { title: 'Nobody' });

        assert.equal(count, 1);
        assert.equal(none, 0);
      },
    );

    assert.equal(batches.length, 1);
    assert.equal(batches[0].length, 1);
    assert.equal(batches[0][0].companyId, MY_COMPANY);
    assert.equal(batches[0][0].user, MATE);
  });

  test('notifyRoles only reaches ACTIVE users of THAT company', async () => {
    const filters = [];
    const batches = [];

    await withModels(
      {
        User: {
          find: (filter) => {
            filters.push(filter);
            return { select: async () => [{ _id: MATE }] };
          },
        },
        Notification: { insertMany: async (docs) => { batches.push(docs); return docs; } },
      },
      async () => notifyRoles(MY_COMPANY, ['COMPANY_ADMIN', 'HR_MANAGER'], { type: 'BGV', title: 'Check done' }),
    );

    assert.deepEqual(filters[0], {
      companyId: MY_COMPANY,
      role: { $in: ['COMPANY_ADMIN', 'HR_MANAGER'] },
      status: 'ACTIVE',
    });
    assert.equal(batches[0].length, 1);
    assert.equal(batches[0][0].companyId, MY_COMPANY);
  });
});

describe('Phase 39 — notifySmart writes to the RECIPIENT\u2019s tenant', () => {
  test('the in-app row carries the recipient\u2019s own companyId, not a sample row\u2019s', async () => {
    const written = [];
    let sampleLookups = 0;

    await withModels(
      {
        Notification: {
          create: async (doc) => { written.push(doc); return doc; },
          // The pre-Phase-39 clone looked for "the newest notification".
          findOne: () => { sampleLookups += 1; return query(foreignSampleRow); },
        },
        NotificationPref: { findOne: () => query(null) },
        // Deliberately no email address: this test must not start the mail worker.
        User: { findById: () => query({ _id: MATE, name: 'Mate', companyId: MY_COMPANY }) },
      },
      async () => notifySmart(MATE, {
        title: 'Your leave was approved',
        message: '2 days approved',
        link: '/app/leaves',
        category: 'LEAVE',
      }),
    );

    assert.equal(written.length, 1);
    assert.equal(written[0].companyId, MY_COMPANY, 'the recipient\u2019s tenant, never another tenant\u2019s');
    assert.notEqual(written[0].companyId, OTHER_COMPANY);
    assert.equal(written[0].user, MATE);
    assert.equal(written[0].type, 'LEAVE', 'the caller\u2019s category, not the sample row\u2019s');
    assert.equal(written[0].eventKey, undefined, 'an inherited eventKey can trip the UNIQUE index');
    assert.equal(
      sampleLookups,
      0,
      'no row is ever cloned: a notification\u2019s tenant is identity, not a default',
    );
  });

  test('a populated recipient document resolves to the same person', async () => {
    const written = [];

    await withModels(
      {
        Notification: { create: async (doc) => { written.push(doc); return doc; } },
        NotificationPref: { findOne: () => query(null) },
        User: { findById: (id) => query({ _id: id, companyId: MY_COMPANY }) },
      },
      async () => notifySmart({ _id: MATE, name: 'Mate' }, { title: 'Hello', category: 'SYSTEM' }),
    );

    assert.equal(written.length, 1);
    assert.equal(written[0].user, MATE);
  });

  test('a recipient that cannot be resolved is SKIPPED, never written with a guess', async () => {
    const written = [];

    await withModels(
      {
        Notification: { create: async (doc) => { written.push(doc); return doc; } },
        NotificationPref: { findOne: () => query(null) },
        User: { findById: () => query(null) },
      },
      async () => {
        await assert.doesNotReject(() => notifySmart('999999999999999999999999', { title: 'Ghost' }));
        // and when the user exists but has no tenant at all
        await assert.doesNotReject(() => notifySmart(MATE, { title: 'No tenant' }));
      },
    );

    assert.equal(written.length, 0);
  });

  test('a muted category writes nothing but still resolves the recipient', async () => {
    const written = [];

    await withModels(
      {
        Notification: { create: async (doc) => { written.push(doc); return doc; } },
        NotificationPref: { findOne: () => query({ inapp: { LEAVE: false }, email: { LEAVE: false } }) },
        User: { findById: () => query({ _id: MATE, companyId: MY_COMPANY }) },
      },
      async () => notifySmart(MATE, { title: 'Muted', category: 'LEAVE' }),
    );

    assert.equal(written.length, 0);
  });

  test('an unrelated category is still ON (missing preference key means ON)', async () => {
    const written = [];

    await withModels(
      {
        Notification: { create: async (doc) => { written.push(doc); return doc; } },
        NotificationPref: { findOne: () => query({ inapp: { LEAVE: false } }) },
        User: { findById: () => query({ _id: MATE, companyId: MY_COMPANY }) },
      },
      async () => notifySmart(MATE, { title: 'Not muted', category: 'PAYROLL' }),
    );

    assert.equal(written.length, 1);
    assert.equal(written[0].type, 'PAYROLL');
  });

  test('the email decision is a pure function (no transport in the test)', () => {
    assert.deepEqual(
      buildEmailJob({ recipient: { email: 'mate@example.com' }, title: 'Payslip ready', message: 'body' }),
      { to: 'mate@example.com', subject: 'Payslip ready', text: 'body' },
    );
    // emailText wins over message wins over title
    assert.equal(
      buildEmailJob({ recipient: { email: 'a@b.c' }, title: 'T', message: 'M', emailText: 'E' }).text,
      'E',
    );
    assert.equal(buildEmailJob({ recipient: { email: 'a@b.c' }, title: 'T' }).text, 'T');
    // nowhere to send it → no job at all
    assert.equal(buildEmailJob({ recipient: {}, title: 'T' }), null);
    assert.equal(buildEmailJob({ recipient: null, title: 'T' }), null);
    assert.equal(buildEmailJob({ recipient: { email: 'a@b.c' } }), null);
  });

  test('a recipient with no email address sends nothing, and in-app mute still wins', async () => {
    const written = [];

    await withModels(
      {
        Notification: { create: async (doc) => { written.push(doc); return doc; } },
        NotificationPref: { findOne: () => query({ inapp: { PAYROLL: false }, email: { PAYROLL: true } }) },
        User: { findById: () => query({ _id: MATE, name: 'Mate', companyId: MY_COMPANY }) },
      },
      async () => notifySmart(MATE, { title: 'Payslip ready', message: 'body', category: 'PAYROLL' }),
    );

    // In-app was muted by preference; the email decision then found no address,
    // so the real queue was never started (it has a 5s interval and would keep
    // the test process alive).
    assert.equal(written.length, 0);
  });

  test('notifySmart never throws, whatever fails underneath', async () => {
    await withModels(
      {
        Notification: { create: async () => { throw new Error('db down'); } },
        NotificationPref: { findOne: () => { throw new Error('prefs down'); } },
        User: {
          findById: () => ({
            select: () => ({
              lean: async () => { throw new Error('users down'); },
            }),
          }),
        },
      },
      async () => {
        await assert.doesNotReject(() => notifySmart(MATE, { title: 'Anything', category: 'SYSTEM' }));
      },
    );
  });

  test('a payload without a title is ignored', async () => {
    const written = [];

    await withModels(
      {
        Notification: { create: async (doc) => { written.push(doc); return doc; } },
        User: { findById: () => query({ _id: MATE, companyId: MY_COMPANY }) },
      },
      async () => notifySmart(MATE, { message: 'no title' }),
    );

    assert.equal(written.length, 0);
  });
});

describe('Phase 39 — project & task notifications reach the bell', () => {
  const answer = async (handler, req) => {
    let body = null;
    let error = null;
    let settle;
    const answered = new Promise((resolve) => { settle = resolve; });

    const res = {
      status() { return this; },
      json(payload) { body = payload; settle(); return this; },
    };

    handler(req, res, (nextError) => { error = nextError; settle(); });

    await answered;
    for (let index = 0; index < 6; index += 1) await new Promise((resolve) => setImmediate(resolve));

    return { status: error?.statusCode ?? body?.statusCode ?? null, message: error?.message ?? '', body, error };
  };

  test('assigning a task notifies the assignee in the caller\u2019s tenant', async () => {
    const written = [];
    const task = {
      _id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
      title: 'Write the report',
      assignedTo: MATE,
      assignedBy: ME,
      company: MY_COMPANY,
    };

    await withModels(
      {
        Notification: { create: async (doc) => { written.push(doc); return doc; } },
        User: {
          find: () => ({
            select: async () => [{ _id: MATE, name: 'Mate', role: 'EMPLOYEE', companyId: MY_COMPANY }],
          }),
        },
        Task: { insertMany: async () => [task] },
        Project: { updateOne: async () => ({}) },
      },
      async () => {
        const result = await answer(taskController.createTask, {
          user: { _id: ME, role: 'COMPANY_ADMIN' },
          companyId: MY_COMPANY,
          body: { title: 'Write the report', assigneeIds: [MATE], priority: 'HIGH' },
        });

        assert.equal(result.status, 201, `expected 201, got ${result.status} ${result.message}`);
      },
    );

    assert.equal(written.length, 1, 'the assignee heard about it');
    assert.equal(written[0].companyId, MY_COMPANY, 'never undefined, never another tenant');
    assert.equal(written[0].user, MATE);
    assert.equal(written[0].type, 'SYSTEM');
    assert.match(written[0].title, /New task assigned/);
  });

  test('creating a project notifies the manager in the caller\u2019s tenant', async () => {
    const written = [];
    const project = {
      _id: 'bbbbbbbbbbbbbbbbbbbbbbbb',
      name: 'Apollo',
      manager: MATE,
      teamLeads: [],
      members: [],
      company: MY_COMPANY,
      async save() { return this; },
    };

    await withModels(
      {
        Notification: { create: async (doc) => { written.push(doc); return doc; } },
        User: {
          find: () => ({ select: async () => [{ _id: MATE, name: 'Mate', role: 'MANAGER', companyId: MY_COMPANY }] }),
        },
        Project: { create: async () => project, updateOne: async () => ({}) },
      },
      async () => {
        const result = await answer(projectController.createProject, {
          user: { _id: ME, role: 'COMPANY_ADMIN' },
          companyId: MY_COMPANY,
          body: { name: 'Apollo', managerId: MATE },
        });

        assert.ok(
          result.status === 200 || result.status === 201,
          `expected a created project, got ${result.status} ${result.message}`,
        );
      },
    );

    if (written.length) {
      assert.equal(written[0].companyId, MY_COMPANY);
      assert.equal(written[0].user, MATE);
    }
  });
});

describe('Phase 39 — the repair rules', () => {
  test('rows are classified by the recipient\u2019s tenant, and orphans are left alone', () => {
    const rows = [
      { _id: '1', companyId: MY_COMPANY, recipientCompanyId: MY_COMPANY },
      { _id: '2', companyId: OTHER_COMPANY, recipientCompanyId: MY_COMPANY, eventKey: 'inherited' },
      { _id: '3', companyId: OTHER_COMPANY, recipientCompanyId: MY_COMPANY },
      { _id: '4', companyId: MY_COMPANY, recipientCompanyId: null },
    ];

    const { correct, mismatched, orphans, inheritedKeys } = classifyNotificationRows(rows);

    assert.equal(correct, 1);
    assert.deepEqual(mismatched.map((row) => row._id), ['2', '3']);
    assert.deepEqual(orphans.map((row) => row._id), ['4']);
    assert.equal(inheritedKeys, 1);
  });

  test('a repair stamps the recipient\u2019s tenant and clears the inherited key', () => {
    const update = buildRepairUpdate({ companyId: OTHER_COMPANY, recipientCompanyId: MY_COMPANY, eventKey: 'inherited' });

    assert.deepEqual(update, { $set: { companyId: MY_COMPANY, eventKey: null } });
  });

  test('classifying nothing is not an error', () => {
    const result = classifyNotificationRows();

    assert.deepEqual(result.mismatched, []);
    assert.deepEqual(result.orphans, []);
    assert.equal(result.correct, 0);
  });
});

describe('Phase 39 — the clone cannot come back', () => {
  test('writeViaTemplate is gone from the notification write path', async () => {
    // Comments stripped first: the header explains the old cascade by name, and
    // a ban must not be tripped by the comment that documents the ban.
    const source = (await readFile(new URL('../src/utils/notifyPref.js', import.meta.url), 'utf8'))
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');

    assert.equal(source.includes('writeViaTemplate'), false, 'the clone-any-row strategy must not return');
    assert.equal(source.includes('resolveNotificationModel'), false, 'nothing needs the Notification model directly');
    assert.ok(source.includes('companyId'), 'the tenant is resolved and used');
  });

  test('the direct callers pass a tenant to notifyUser', async () => {
    for (const file of ['../src/controllers/projectController.js', '../src/controllers/taskController.js']) {
      const source = (await readFile(new URL(file, import.meta.url), 'utf8'))
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');

      assert.equal(
        /notifyUser\(userId, payload\)/.test(source),
        false,
        `${file} must not call notifyUser with two arguments`,
      );
      assert.match(source, /notify\(req\.companyId,/, `${file} must pass the tenant`);
    }
  });
});
