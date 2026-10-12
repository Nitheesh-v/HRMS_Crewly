// ═══════════════════════════════════════════════════════════════════════════
// MEETINGS — controller laws (owner report: "editing was not working" and
// "the meeting link opens with localhost so it does not open")
//
// The Meetings feature shipped with ZERO tests. Everything in this file is a
// law that was true in the comments and false in the code:
//
//   · a link typed as `meet.google.com/abc` was stored verbatim, so the Join
//     anchor resolved it as a RELATIVE path against the app origin —
//     http://localhost:5173/meet.google.com/abc — and the meeting never opened;
//   · `notifyUser(companyId, user, payload)` was called with two arguments, so
//     the third destructured `undefined`, threw BEFORE notifyUser's own
//     try/catch, and the controller's catch swallowed it: no invite, update,
//     cancel or reminder notification has ever been delivered;
//   · `updateMeeting` skipped the validations `createMeeting` has, so an empty
//     title reached `save()` and came back as a Mongoose ValidationError — a
//     500 the UI can only show as "Could not save meeting";
//   · `type: 'COMPANY'` was hidden in the UI but accepted by the API, so a
//     MANAGER could broadcast a company-wide meeting by hand.
//
// Hermetic: every model call is stubbed, no Mongo, no Redis. The controller
// starts a 60s reminder interval at import time, so the scheduler flag is set
// BEFORE the import — otherwise the test process never drains.
// ═══════════════════════════════════════════════════════════════════════════
import assert from 'node:assert/strict';
import test from 'node:test';

process.env.NODE_ENV = 'test';
process.env.MONGO_URI ||= 'mongodb://127.0.0.1:27017/crewly_meetings_test';

global.__crewlyMeetingReminders = true;

const { default: Meeting } = await import('../src/models/Meeting.js');
const { default: User } = await import('../src/models/User.js');
const { default: Notification } = await import('../src/models/Notification.js');
const { parseMeetingLink } = await import('../src/utils/meetingLink.js');
const controller = await import('../src/controllers/meetingController.js');

const COMPANY = '111111111111111111111111';
const OTHER_COMPANY = '222222222222222222222222';
const ME = '333333333333333333333333';
const MATE = '444444444444444444444444';

const MODELS = { Meeting, User, Notification };

// ── stubbing helpers (the repo's pattern: Object.defineProperty on the static)
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

// Mongoose query chains: the controller awaits .populate().sort().limit() etc.
const chain = (rows) => {
  const query = {
    populate: () => query,
    sort: () => query,
    limit: () => query,
    select: () => query,
    lean: () => query,
    distinct: async () => rows.map((row) => row._id ?? row),
    then: (resolve, reject) => Promise.resolve(rows).then(resolve, reject),
  };

  return query;
};

const flush = async (rounds = 6) => {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

const meetingDoc = (over = {}) => ({
  _id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
  title: 'Standup',
  description: '',
  type: 'TEAM',
  company: COMPANY,
  department: null,
  participants: [ME, MATE],
  createdBy: ME,
  startAt: new Date('2026-10-08T04:00:00.000Z'),
  endAt: new Date('2026-10-08T05:00:00.000Z'),
  link: '',
  recurrence: 'NONE',
  recurrenceEnd: null,
  reminderMinutes: 15,
  reminderSent: false,
  status: 'SCHEDULED',
  saves: 0,
  async save() {
    this.saves += 1;
    return this;
  },
  ...over,
});

// Calls an asyncHandler-wrapped controller and waits for the ONE answer it
// gives: res.json(...) on the happy path, next(error) on the unhappy one.
const call = async (handler, req) => {
  let body = null;
  let error = null;
  let settle;
  const answered = new Promise((resolve) => {
    settle = resolve;
  });

  const res = {
    status() {
      return this;
    },
    json(payload) {
      body = payload;
      settle();
      return this;
    },
  };

  handler(req, res, (nextError) => {
    error = nextError;
    settle();
  });

  await answered;
  await flush();

  return {
    status: error?.statusCode ?? body?.statusCode ?? null,
    message: error?.message ?? body?.message ?? '',
    body,
    error,
  };
};

const baseMeeting = (over = {}) => ({
  user: { _id: ME, role: 'COMPANY_ADMIN' },
  companyId: COMPANY,
  ...over,
});

const updateBody = (over = {}) => ({
  params: { id: 'aaaaaaaaaaaaaaaaaaaaaaaa' },
  body: { title: 'Standup', ...over },
});

// ── the parser ─────────────────────────────────────────────────────────────

test('a scheme-less link becomes https instead of a relative path', () => {
  assert.deepEqual(parseMeetingLink('meet.google.com/abc-defg-hij'), {
    link: 'https://meet.google.com/abc-defg-hij',
    error: null,
  });
  assert.equal(parseMeetingLink('zoom.us/j/9876543210').link, 'https://zoom.us/j/9876543210');
  assert.equal(parseMeetingLink('teams.microsoft.com/l/meetup-join/x').link, 'https://teams.microsoft.com/l/meetup-join/x');
});

test('an explicit http(s) link is kept as the organizer typed it', () => {
  assert.equal(parseMeetingLink('https://meet.google.com/abc').link, 'https://meet.google.com/abc');
  assert.equal(parseMeetingLink('http://zoom.us/j/1').link, 'http://zoom.us/j/1');
});

test('a link that can execute or hand off to an app is refused', () => {
  for (const raw of [
    'javascript:alert(document.cookie)',
    'JaVaScRiPt:alert(1)',
    'data:text/html;base64,PHNjcmlwdD4=',
    'vbscript:msgbox(1)',
    'file:///C:/secrets.txt',
    'zoommtg://zoom.us/join?confno=1',
    'mailto:someone@example.com',
  ]) {
    const parsed = parseMeetingLink(raw);

    assert.equal(parsed.link, '', raw);
    assert.match(parsed.error, /http\(s\)/, raw);
  }
});

test('blank stays blank, nonsense is reported as incomplete', () => {
  assert.deepEqual(parseMeetingLink(''), { link: '', error: null });
  assert.deepEqual(parseMeetingLink('   '), { link: '', error: null });
  assert.deepEqual(parseMeetingLink(undefined), { link: '', error: null });

  assert.equal(parseMeetingLink('https://').link, '');
  assert.match(parseMeetingLink('https://').error, /incomplete/i);
  assert.equal(parseMeetingLink('not a link').link, '');
  assert.equal(parseMeetingLink('meeting-room-1').link, '');
});

// ── create ─────────────────────────────────────────────────────────────────

test('create stores the normalised link, never the raw text', async () => {
  const created = [];

  await withModels(
    {
      Meeting: { create: async (doc) => { created.push(doc); return meetingDoc(doc); } },
      User: { countDocuments: async (filter) => filter._id.$in.length },
      Notification: { create: async (doc) => doc },
    },
    async () => {
      const answer = await call(controller.createMeeting, baseMeeting({
        body: {
          title: 'Sprint review',
          type: 'PRIVATE',
          startAt: '2026-10-09T04:00:00.000Z',
          endAt: '2026-10-09T05:00:00.000Z',
          participantIds: [ME, MATE],
          link: 'meet.google.com/abc-defg-hij',
        },
      }));

      assert.equal(answer.status, 201);
    },
  );

  assert.equal(created.length, 1);
  assert.equal(created[0].link, 'https://meet.google.com/abc-defg-hij');
});

test('create refuses an unsafe link with 400 and writes nothing', async () => {
  let createCalls = 0;

  await withModels(
    {
      Meeting: { create: async (doc) => { createCalls += 1; return meetingDoc(doc); } },
      User: { countDocuments: async (filter) => filter._id.$in.length },
    },
    async () => {
      const answer = await call(controller.createMeeting, baseMeeting({
        body: {
          title: 'Bait',
          type: 'PRIVATE',
          startAt: '2026-10-09T04:00:00.000Z',
          endAt: '2026-10-09T05:00:00.000Z',
          participantIds: [ME],
          link: 'javascript:alert(1)',
        },
      }));

      assert.equal(answer.status, 400);
      assert.match(answer.message, /http\(s\)/);
    },
  );

  assert.equal(createCalls, 0);
});

test('a Manager cannot schedule a company-wide meeting through the API', async () => {
  let createCalls = 0;

  await withModels(
    {
      Meeting: { create: async (doc) => { createCalls += 1; return meetingDoc(doc); } },
      User: { countDocuments: async (filter) => filter._id.$in.length },
    },
    async () => {
      const answer = await call(controller.createMeeting, baseMeeting({
        user: { _id: ME, role: 'MANAGER', department: 'dept1' },
        body: {
          title: 'All hands (not mine to call)',
          type: 'COMPANY',
          startAt: '2026-10-09T04:00:00.000Z',
          endAt: '2026-10-09T05:00:00.000Z',
          participantIds: [ME],
        },
      }));

      assert.equal(answer.status, 403);
      assert.match(answer.message, /Company Admin/);
    },
  );

  assert.equal(createCalls, 0);
});

test('create rejects an unknown type or repeat option', async () => {
  await withModels(
    {
      Meeting: { create: async (doc) => meetingDoc(doc) },
      User: { countDocuments: async (filter) => filter._id.$in.length },
    },
    async () => {
      const bodied = (extra) => baseMeeting({
        body: {
          title: 'X',
          startAt: '2026-10-09T04:00:00.000Z',
          endAt: '2026-10-09T05:00:00.000Z',
          participantIds: [ME],
          ...extra,
        },
      });

      assert.equal((await call(controller.createMeeting, bodied({ type: 'EVERYONE' }))).status, 400);
      assert.equal((await call(controller.createMeeting, bodied({ recurrence: 'FORTNIGHTLY' }))).status, 400);
    },
  );
});

test('create notifications are created for the TENANT, not with a user id as the company', async () => {
  const notifications = [];

  await withModels(
    {
      Meeting: { create: async (doc) => meetingDoc(doc) },
      User: { countDocuments: async (filter) => filter._id.$in.length },
      Notification: { create: async (doc) => { notifications.push(doc); return doc; } },
    },
    async () => {
      const answer = await call(controller.createMeeting, baseMeeting({
        body: {
          title: 'Invite everyone',
          type: 'PRIVATE',
          startAt: '2026-10-09T04:00:00.000Z',
          endAt: '2026-10-09T05:00:00.000Z',
          participantIds: [ME, MATE],
        },
      }));

      assert.equal(answer.status, 201);
    },
  );

  assert.equal(notifications.length, 1, 'exactly one invite (the organizer is not notified)');
  assert.equal(notifications[0].companyId, COMPANY);
  assert.equal(notifications[0].user, MATE);
  assert.match(notifications[0].title, /Meeting invite/);
  assert.equal(notifications[0].link, '/app/meetings');
});

// ── update ─────────────────────────────────────────────────────────────────

test('update refuses an empty title with 400 instead of failing at save()', async () => {
  const doc = meetingDoc();

  await withModels({ Meeting: { findOne: async () => doc } }, async () => {
    const answer = await call(controller.updateMeeting, baseMeeting(updateBody({ title: '   ' })));

    assert.equal(answer.status, 400);
    assert.match(answer.message, /title is required/i);
  });

  assert.equal(doc.saves, 0, 'nothing was written');
});

test('update trims a real title and saves once', async () => {
  const doc = meetingDoc();

  await withModels(
    {
      Meeting: { findOne: async () => doc },
      User: { find: () => chain([]) },
      Notification: { create: async (d) => d },
    },
    async () => {
      const answer = await call(controller.updateMeeting, baseMeeting(updateBody({ title: '  Standup v2  ' })));

      assert.equal(answer.status, 200);
    },
  );

  assert.equal(doc.title, 'Standup v2');
  assert.equal(doc.saves, 1);
});

test('update normalises the link and refuses an unsafe one', async () => {
  const doc = meetingDoc();

  await withModels(
    {
      Meeting: { findOne: async () => doc },
      User: { find: () => chain([]) },
      Notification: { create: async (d) => d },
    },
    async () => {
      const ok = await call(controller.updateMeeting, baseMeeting(updateBody({ link: 'meet.google.com/new-link' })));

      assert.equal(ok.status, 200);
      assert.equal(doc.link, 'https://meet.google.com/new-link');

      const bad = await call(controller.updateMeeting, baseMeeting(updateBody({ link: 'javascript:alert(1)' })));

      assert.equal(bad.status, 400);
      assert.equal(doc.link, 'https://meet.google.com/new-link', 'the previous link survives a refused edit');
    },
  );
});

test('update clears the link when the organizer empties the field', async () => {
  const doc = meetingDoc({ link: 'https://meet.google.com/old' });

  await withModels(
    {
      Meeting: { findOne: async () => doc },
      User: { find: () => chain([]) },
      Notification: { create: async (d) => d },
    },
    async () => {
      const answer = await call(controller.updateMeeting, baseMeeting(updateBody({ link: '' })));

      assert.equal(answer.status, 200);
      assert.equal(doc.link, '');
    },
  );
});

test('update rejects a non-array participant list with 400, not a TypeError 500', async () => {
  const doc = meetingDoc();

  await withModels({ Meeting: { findOne: async () => doc } }, async () => {
    const answer = await call(controller.updateMeeting, baseMeeting(updateBody({ participantIds: 'everyone' })));

    assert.equal(answer.status, 400);
    assert.match(answer.message, /list of employees/i);
  });

  assert.equal(doc.saves, 0);
});

test('update rejects participants outside the tenant and absurd reminder values', async () => {
  const doc = meetingDoc();

  await withModels(
    {
      Meeting: { findOne: async () => doc },
      // ONE of the two requested ids belongs to this company.
      User: { countDocuments: async () => 1 },
    },
    async () => {
      const foreign = await call(controller.updateMeeting, baseMeeting(updateBody({ participantIds: [ME, 'foreign'] })));

      assert.equal(foreign.status, 400);
      assert.match(foreign.message, /belong to your company/);
    },
  );

  assert.equal(doc.participants.includes('foreign'), false);

  await withModels(
    {
      Meeting: { findOne: async () => meetingDoc() },
      User: { find: () => chain([]) },
    },
    async () => {
      assert.equal((await call(controller.updateMeeting, baseMeeting(updateBody({ reminderMinutes: 99999 })))).status, 400);
      assert.equal((await call(controller.updateMeeting, baseMeeting(updateBody({ reminderMinutes: -5 })))).status, 400);
    },
  );
});

test('a Manager cannot promote a meeting to company-wide by editing it', async () => {
  const doc = meetingDoc({ type: 'TEAM', createdBy: ME });

  await withModels({ Meeting: { findOne: async () => doc } }, async () => {
    const answer = await call(controller.updateMeeting, baseMeeting({
      user: { _id: ME, role: 'MANAGER', department: 'dept1' },
      ...updateBody({ type: 'COMPANY' }),
    }));

    assert.equal(answer.status, 403);
    assert.match(answer.message, /Company Admin/);
  });

  assert.equal(doc.type, 'TEAM', 'the type never changed');
  assert.equal(doc.saves, 0);
});

test('switching a private meeting to TEAM adds the organizer\u2019s team', async () => {
  const doc = meetingDoc({ type: 'PRIVATE', participants: [ME], createdBy: ME });

  await withModels(
    {
      Meeting: { findOne: async () => doc },
      // getSubtreeIds: MATE reports to ME.
      User: {
        find: () => chain([
          { _id: ME, reportingTo: null },
          { _id: MATE, reportingTo: ME },
        ]),
      },
      Notification: { create: async (d) => d },
    },
    async () => {
      const answer = await call(controller.updateMeeting, baseMeeting(updateBody({ type: 'TEAM' })));

      assert.equal(answer.status, 200);
    },
  );

  assert.equal(doc.type, 'TEAM');
  assert.deepEqual(doc.participants.map(String).sort(), [ME, MATE].sort());
});

test('update re-arms the reminder and clears a stale repeat-until when repeating stops', async () => {
  const doc = meetingDoc({
    recurrence: 'WEEKLY',
    recurrenceEnd: new Date('2026-12-01T00:00:00.000Z'),
    reminderSent: true,
  });

  await withModels(
    {
      Meeting: { findOne: async () => doc },
      User: { find: () => chain([]) },
      Notification: { create: async (d) => d },
    },
    async () => {
      const answer = await call(controller.updateMeeting, baseMeeting(updateBody({
        startAt: '2026-10-15T04:00:00.000Z',
        endAt: '2026-10-15T05:00:00.000Z',
        recurrence: 'NONE',
      })));

      assert.equal(answer.status, 200);
    },
  );

  assert.equal(doc.reminderSent, false);
  assert.equal(doc.recurrence, 'NONE');
  assert.equal(doc.recurrenceEnd, null);
  assert.equal(doc.startAt.toISOString(), '2026-10-15T04:00:00.000Z');
});

test('update rejects an end time before the start time', async () => {
  const doc = meetingDoc();

  await withModels({ Meeting: { findOne: async () => doc } }, async () => {
    const answer = await call(controller.updateMeeting, baseMeeting(updateBody({
      startAt: '2026-10-15T05:00:00.000Z',
      endAt: '2026-10-15T04:00:00.000Z',
    })));

    assert.equal(answer.status, 400);
    assert.match(answer.message, /End time must be after start time/);
  });

  assert.equal(doc.saves, 0);
});

test('only the organizer or a Company Admin may edit — and the read is tenant-scoped', async () => {
  const queries = [];

  await withModels(
    {
      Meeting: {
        findOne: async (filter) => {
          queries.push(filter);
          // Another company's meeting simply is not there.
          return null;
        },
      },
    },
    async () => {
      const answer = await call(controller.updateMeeting, baseMeeting({
        user: { _id: MATE, role: 'MANAGER', department: 'dept1' },
        ...updateBody(),
      }));

      assert.equal(answer.status, 404);
    },
  );

  assert.equal(queries.length, 1);
  assert.equal(String(queries[0].company), COMPANY, 'the lookup carries the caller\u2019s tenant');
  assert.equal(String(queries[0]._id), 'aaaaaaaaaaaaaaaaaaaaaaaa');
});

test('a non-organizer inside the tenant is refused with 403', async () => {
  await withModels(
    { Meeting: { findOne: async () => meetingDoc({ createdBy: ME }) } },
    async () => {
      const answer = await call(controller.updateMeeting, baseMeeting({
        user: { _id: MATE, role: 'MANAGER', department: 'dept1' },
        ...updateBody(),
      }));

      assert.equal(answer.status, 403);
      assert.match(answer.message, /organizer or company admin/);
    },
  );
});

test('update notifications also carry the tenant', async () => {
  const notifications = [];
  const doc = meetingDoc({ company: COMPANY });

  await withModels(
    {
      Meeting: { findOne: async () => doc },
      User: { find: () => chain([]) },
      Notification: { create: async (payload) => { notifications.push(payload); return payload; } },
    },
    async () => {
      const answer = await call(controller.updateMeeting, baseMeeting(updateBody({ title: 'Moved' })));

      assert.equal(answer.status, 200);
    },
  );

  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].companyId, COMPANY);
  assert.equal(notifications[0].user, MATE);
  assert.match(notifications[0].title, /Meeting updated/);
});

// ── cancel + visibility ────────────────────────────────────────────────────

test('cancelling notifies the participants for the tenant and keeps the reason', async () => {
  const notifications = [];
  const doc = meetingDoc({ company: COMPANY });

  await withModels(
    {
      Meeting: { findOne: async () => doc },
      Notification: { create: async (payload) => { notifications.push(payload); return payload; } },
    },
    async () => {
      const answer = await call(controller.cancelMeeting, baseMeeting({
        params: { id: 'aaaaaaaaaaaaaaaaaaaaaaaa' },
        body: { reason: 'Room double-booked' },
      }));

      assert.equal(answer.status, 200);
      assert.equal(answer.body.data.status, 'CANCELLED');
    },
  );

  assert.equal(doc.cancelReason, 'Room double-booked');
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].companyId, COMPANY);
  assert.match(notifications[0].message, /Room double-booked/);
});

test('the calendar query is tenant-scoped and expanded into occurrences', async () => {
  const queries = [];

  const weekly = meetingDoc({
    recurrence: 'WEEKLY',
    startAt: new Date('2026-10-05T04:00:00.000Z'),
    endAt: new Date('2026-10-05T05:00:00.000Z'),
    recurrenceEnd: new Date('2026-11-30T00:00:00.000Z'),
  });

  await withModels(
    { Meeting: { find: (filter) => { queries.push(filter); return chain([weekly]); } } },
    async () => {
      const answer = await call(controller.listMeetings, {
        user: { _id: ME, role: 'MANAGER', department: 'dept1' },
        companyId: COMPANY,
        query: { from: '2026-10-01T00:00:00.000Z', to: '2026-10-31T00:00:00.000Z' },
      });

      assert.equal(answer.status, 200);

      const occurrences = answer.body.data;

      assert.ok(occurrences.length >= 4, 'a weekly meeting yields several occurrences in a month');
      occurrences.forEach((occurrence) => {
        assert.ok(occurrence.occStart && occurrence.occEnd, 'every occurrence carries its own window');
        assert.equal(String(occurrence.company), COMPANY);
      });
    },
  );

  assert.equal(queries.length, 1);

  const filter = queries[0];

  assert.equal(String(filter.$and[0].company), COMPANY, 'always this tenant');
  assert.notEqual(String(filter.$and[0].company), OTHER_COMPANY);

  const or = filter.$and[0].$or;

  assert.ok(or.some((clause) => clause.type === 'COMPANY'), 'company-wide meetings are visible');
  assert.ok(or.some((clause) => String(clause.createdBy) === ME), 'own meetings are visible');
  assert.ok(or.some((clause) => String(clause.participants) === ME), 'invited meetings are visible');
  assert.equal(String(filter.$and[1].status), 'SCHEDULED', 'cancelled meetings never reach the calendar');
});
