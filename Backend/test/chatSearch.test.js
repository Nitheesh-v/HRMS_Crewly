// ============================================================
//  PHASE 34.4 — CONVERSATION-SCOPED SEARCH (HERMETIC).
//
//  No Mongo, no Redis. The REAL service, the REAL rules and the REAL validator
//  run against in-memory doubles of the ChatConversation / ChatMessage statics.
//
//  Pinned behaviour:
//    · membership is enforced before anything is searched; a non-member and a
//      user from ANOTHER TENANT both get NOT_FOUND_OR_FORBIDDEN (the same
//      answer as a conversation that does not exist, so search cannot probe)
//    · the query is bounded: < 2 chars refused, > 64 refused, both with the
//      rule and both BEFORE the database is touched
//    · regex metacharacters are LITERAL: "a+b?" matches that text and nothing
//      else, and a crafted ".*" cannot select the whole conversation
//    · tombstones are excluded, so a deleted message is not discoverable by its
//      old words
//    · only TEXT messages are searched
//    · pagination is cursor-by-seq, newest first, with a limit+1 probe and a
//      clamped page size (1..20, default 10)
//    · every query carries the tenant AND the conversation (a bug in the gate
//      still cannot cross a boundary)
//    · the snippet is bounded and centred on the match — the full body is never
//      echoed, and nothing on this path logs the term
//    · no text index exists on ChatMessage (the deliberate 34.4 decision)
// ============================================================

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

process.env.MONGO_URI ||= 'mongodb://127.0.0.1:27017/crewly_chat_search';
process.env.REDIS_ENABLED ||= 'false';

import mongoose from 'mongoose';

import ChatConversation from '../src/models/ChatConversation.js';
import ChatMessage from '../src/models/ChatMessage.js';
import {
  CHAT_SEARCH_LIMIT_DEFAULT,
  CHAT_SEARCH_LIMIT_MAX,
  CHAT_SEARCH_MAX_QUERY,
  CHAT_SEARCH_MIN_QUERY,
  CHAT_SEARCH_MESSAGES,
  CHAT_SEARCH_SNIPPET_MAX,
  buildSnippet,
  clampSearchLimit,
  escapeRegExp,
  normalizeSearchQuery,
} from '../src/utils/chatSearchRules.js';
import { searchConversationMessages } from '../src/services/chat/chatSearchService.js';
import { validateSendPayload } from '../src/socket/chatSocketValidators.js';
import { conversationIdParamValidator } from '../src/validators/chat/chatValidators.js';

const { ObjectId } = mongoose.Types;

const id = () => new ObjectId();
const same = (a, b) => String(a) === String(b);

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..', '..');

const readSource = (relative) => fs.readFileSync(path.join(repo, relative), 'utf8');

const COMPANY_A = id();
const COMPANY_B = id();
const ALICE = id();
const BOB = id();

// ── doubles ───────────────────────────────────────────────────────────────

const installFakes = ({ conversations = [], messages = [] }) => {
  const original = {
    convFindOne: ChatConversation.findOne,
    msgFind: ChatMessage.find,
  };

  const capture = { filters: [] };

  ChatConversation.findOne = (filter = {}) => ({
    lean: async () =>
      conversations.find((doc) => {
        if (filter._id && !same(doc._id, filter._id)) return false;
        if (filter.companyId && !same(doc.companyId, filter.companyId)) return false;
        const member = filter['members.userId'];
        if (member && !doc.members.some((m) => same(m.userId, member))) return false;
        return true;
      }) ?? null,
  });

  // The chainable shape the service uses:
  // find(filter).select(...).sort(...).limit(n).lean()
  ChatMessage.find = (filter = {}) => {
    capture.filters.push(filter);

    const query = {
      select: () => query,
      sort: (spec) => {
        query.sortSpec = spec;
        return query;
      },
      limit: (value) => {
        query.limitSpec = value;
        return query;
      },
      lean: async () => {
        let rows = messages.filter((doc) => {
          if (filter.companyId && !same(doc.companyId, filter.companyId)) return false;
          if (filter.conversationId && !same(doc.conversationId, filter.conversationId)) return false;
          if (filter.type && doc.type !== filter.type) return false;
          if (filter.deletedAt === null && doc.deletedAt) return false;
          if (filter.seq?.$lt !== undefined && !(doc.seq < filter.seq.$lt)) return false;

          if (filter.text?.$regex) {
            // The REAL regex the service built, evaluated with the same
            // case-insensitive flags Mongo would use — so the escaping law is
            // tested through the production code path, not a stub.
            const pattern = new RegExp(filter.text.$regex, filter.text.$options ?? '');

            if (!pattern.test(String(doc.text ?? ''))) return false;
          }

          return true;
        });

        if (query.sortSpec?.seq === -1) rows = [...rows].sort((a, b) => b.seq - a.seq);
        if (query.limitSpec !== undefined) rows = rows.slice(0, query.limitSpec);

        return rows.map((row) => ({ ...row }));
      },
    };

    return query;
  };

  return {
    capture,
    restore: () => {
      ChatConversation.findOne = original.convFindOne;
      ChatMessage.find = original.msgFind;
    },
  };
};

const seedConversation = ({ companyId = COMPANY_A, members } = {}) => ({
  _id: id(),
  companyId,
  type: 'GROUP',
  title: 'Design',
  members: members ?? [{ userId: ALICE }, { userId: BOB }],
  lastMessageSeq: 0,
  isDisabled: false,
});

const seedMessage = ({ conversation, seq, text, sender = ALICE, type = 'TEXT', deletedAt = null }) => ({
  _id: id(),
  companyId: conversation.companyId,
  conversationId: conversation._id,
  senderUserId: sender,
  seq,
  clientMessageId: `seed-${seq}`,
  type,
  text,
  attachments: [],
  editVersion: 0,
  replyToMessageId: null,
  threadRootMessageId: null,
  mentions: [],
  deletedAt,
  createdAt: new Date(2026, 0, 1, 12, seq),
});

// ══════════════════════════════════════════════════════════════════════════
// 1. The pure rules
// ══════════════════════════════════════════════════════════════════════════

test('the query is bounded before anything else: min 2, max 64, whitespace collapsed', () => {
  assert.equal(normalizeSearchQuery('a').ok, false);
  assert.equal(normalizeSearchQuery('a').message, CHAT_SEARCH_MESSAGES.TOO_SHORT);
  assert.equal(normalizeSearchQuery('  ').ok, false, 'whitespace is not a search');
  assert.equal(normalizeSearchQuery('x'.repeat(CHAT_SEARCH_MAX_QUERY + 1)).ok, false);
  assert.equal(
    normalizeSearchQuery('x'.repeat(CHAT_SEARCH_MAX_QUERY + 1)).message,
    CHAT_SEARCH_MESSAGES.TOO_LONG
  );

  const ok = normalizeSearchQuery('  sprint   review ');

  assert.equal(ok.ok, true);
  assert.equal(ok.q, 'sprint review', 'internal runs collapse, edges trim');
  assert.equal(normalizeSearchQuery('ab').ok, true, 'two characters is the floor');
});

test('the page size is clamped: 1..20, default 10, junk means default', () => {
  assert.equal(clampSearchLimit(undefined), CHAT_SEARCH_LIMIT_DEFAULT);
  assert.equal(clampSearchLimit(0), CHAT_SEARCH_LIMIT_DEFAULT);
  assert.equal(clampSearchLimit('nonsense'), CHAT_SEARCH_LIMIT_DEFAULT);
  assert.equal(clampSearchLimit(1), 1);
  assert.equal(clampSearchLimit(7), 7);
  assert.equal(clampSearchLimit(500), CHAT_SEARCH_LIMIT_MAX);
});

test('every regex metacharacter is escaped — the query can only match literally', () => {
  assert.equal(escapeRegExp('a+b?'), 'a\\+b\\?');
  assert.equal(escapeRegExp('.*'), '\\.\\*');
  assert.equal(escapeRegExp('(x)[y]{2}|z^$'), '\\(x\\)\\[y\\]\\{2\\}\\|z\\^\\$');
  assert.equal(escapeRegExp('plain text'), 'plain text');

  // The proof that matters: the escaped pattern is literal.
  assert.equal(new RegExp(escapeRegExp('a+b?')).test('a+b?'), true);
  assert.equal(new RegExp(escapeRegExp('a+b?')).test('aaab'), false, 'not a quantifier any more');
  assert.equal(new RegExp(escapeRegExp('.*')).test('aaaa'), false, 'not a wildcard any more');
});

test('the snippet is bounded and centred on the match, without echoing the body', () => {
  const long = `${'x'.repeat(400)}FINDME${'y'.repeat(400)}`;
  const snippet = buildSnippet(long, 'findme');

  assert.ok(snippet.includes('FINDME'), 'the match is in the snippet (case-insensitively)');
  assert.ok(snippet.length <= CHAT_SEARCH_SNIPPET_MAX + 2, 'bounded, ellipses included');
  assert.equal(snippet.startsWith('…'), true, 'the cut before the match is admitted');
  assert.equal(snippet.endsWith('…'), true, 'and so is the cut after it');

  // A short body is returned as-is (no fake ellipses).
  assert.equal(buildSnippet('sprint review', 'review'), 'sprint review');
  assert.equal(buildSnippet('', 'review'), '');
});

// ══════════════════════════════════════════════════════════════════════════
// 2. Membership + tenant
// ══════════════════════════════════════════════════════════════════════════

test('a non-member cannot search, and the refusal is identical to a missing conversation', async () => {
  const conversation = seedConversation({ members: [{ userId: ALICE }] });
  const fake = installFakes({
    conversations: [conversation],
    messages: [seedMessage({ conversation, seq: 1, text: 'the sprint review notes' })],
  });

  try {
    const stranger = await searchConversationMessages({
      companyId: COMPANY_A,
      userId: BOB,
      conversationId: conversation._id,
      q: 'sprint',
    });

    assert.equal(stranger.ok, false);
    assert.equal(stranger.code, 'NOT_FOUND_OR_FORBIDDEN');
    assert.equal(fake.capture.filters.length, 0, 'no message query runs for a non-member');

    const missing = await searchConversationMessages({
      companyId: COMPANY_A,
      userId: ALICE,
      conversationId: id(),
      q: 'sprint',
    });

    assert.equal(missing.code, 'NOT_FOUND_OR_FORBIDDEN', 'same answer, so ids cannot be probed');
  } finally {
    fake.restore();
  }
});

test('another tenant cannot search, even with a perfectly valid conversation id', async () => {
  const conversation = seedConversation({ members: [{ userId: ALICE }, { userId: BOB }] });
  const fake = installFakes({
    conversations: [conversation],
    messages: [seedMessage({ conversation, seq: 1, text: 'the sprint review notes' })],
  });

  try {
    const crossTenant = await searchConversationMessages({
      companyId: COMPANY_B,
      userId: BOB,
      conversationId: conversation._id,
      q: 'sprint',
    });

    assert.equal(crossTenant.ok, false);
    assert.equal(crossTenant.code, 'NOT_FOUND_OR_FORBIDDEN');
    assert.equal(fake.capture.filters.length, 0, 'nothing is searched across tenants');
  } finally {
    fake.restore();
  }
});

test('the query itself is tenant AND conversation scoped, and only TEXT bodies are searched', async () => {
  const conversation = seedConversation({});
  const fake = installFakes({
    conversations: [conversation],
    messages: [
      seedMessage({ conversation, seq: 1, text: 'sprint review' }),
      // A FILE caption is a body, but the UI calls this a message type of its
      // own — search stays on TEXT.
      seedMessage({ conversation, seq: 2, text: 'sprint attachment note', type: 'FILE' }),
      // A tombstone keeps its position but must never be found.
      seedMessage({ conversation, seq: 3, text: null, deletedAt: new Date() }),
    ],
  });

  try {
    const result = await searchConversationMessages({
      companyId: COMPANY_A,
      userId: ALICE,
      conversationId: conversation._id,
      q: 'sprint',
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.items.map((row) => row.seq), [1], 'only the live TEXT message');

    const filter = fake.capture.filters.at(-1);

    assert.equal(String(filter.companyId), String(COMPANY_A), 'tenant in the query');
    assert.equal(String(filter.conversationId), String(conversation._id), 'conversation in the query');
    assert.equal(filter.type, 'TEXT');
    assert.equal(filter.deletedAt, null, 'tombstones are excluded by the query, not by the caller');
    assert.equal(filter.text.$options, 'i', 'case-insensitive');
  } finally {
    fake.restore();
  }
});

// ══════════════════════════════════════════════════════════════════════════
// 3. Bounds + pagination
// ══════════════════════════════════════════════════════════════════════════

test('a query that breaks the bounds is refused before the database is touched', async () => {
  const conversation = seedConversation({});
  const fake = installFakes({ conversations: [conversation], messages: [] });

  try {
    for (const [bad, why] of [['a', 'too short'], ['x'.repeat(65), 'too long']]) {
      const result = await searchConversationMessages({
        companyId: COMPANY_A,
        userId: ALICE,
        conversationId: conversation._id,
        q: bad,
      });

      assert.equal(result.ok, false, `${why} must be refused`);
      assert.equal(result.code, 'VALIDATION_ERROR');
      assert.equal(fake.capture.filters.length, 0, `${why}: no query ran`);
    }
  } finally {
    fake.restore();
  }
});

test('the page size is clamped and the search probes with limit+1', async () => {
  const conversation = seedConversation({});
  const messages = Array.from({ length: 30 }, (_, index) =>
    seedMessage({ conversation, seq: index + 1, text: `sprint item ${index + 1}` })
  );

  const fake = installFakes({ conversations: [conversation], messages });

  try {
    const huge = await searchConversationMessages({
      companyId: COMPANY_A,
      userId: ALICE,
      conversationId: conversation._id,
      q: 'sprint',
      limit: 500,
    });

    assert.equal(huge.limit, CHAT_SEARCH_LIMIT_MAX, 'a huge limit is clamped, never honoured');
    assert.equal(huge.items.length, CHAT_SEARCH_LIMIT_MAX);
    assert.equal(huge.hasMore, true);

    const defaulted = await searchConversationMessages({
      companyId: COMPANY_A,
      userId: ALICE,
      conversationId: conversation._id,
      q: 'sprint',
    });

    assert.equal(defaulted.limit, CHAT_SEARCH_LIMIT_DEFAULT);
    assert.equal(defaulted.items.length, CHAT_SEARCH_LIMIT_DEFAULT);
  } finally {
    fake.restore();
  }
});

test('a cursor walks strictly older matches, with a correct nextCursor and no overlap', async () => {
  const conversation = seedConversation({});
  const messages = Array.from({ length: 9 }, (_, index) =>
    seedMessage({ conversation, seq: index + 1, text: `sprint ${index + 1}` })
  ).concat([seedMessage({ conversation, seq: 50, text: 'unrelated' })]);

  const fake = installFakes({ conversations: [conversation], messages });

  try {
    const page1 = await searchConversationMessages({
      companyId: COMPANY_A,
      userId: ALICE,
      conversationId: conversation._id,
      q: 'sprint',
      limit: 4,
    });

    assert.deepEqual(page1.items.map((row) => row.seq), [9, 8, 7, 6], 'newest first');
    assert.equal(page1.hasMore, true);
    assert.equal(page1.nextCursor, 6);

    const page2 = await searchConversationMessages({
      companyId: COMPANY_A,
      userId: ALICE,
      conversationId: conversation._id,
      q: 'sprint',
      limit: 4,
      cursor: page1.nextCursor,
    });

    assert.deepEqual(page2.items.map((row) => row.seq), [5, 4, 3, 2], 'strictly older, no overlap');
    assert.equal(page2.hasMore, true);
    assert.equal(page2.nextCursor, 2);

    const page3 = await searchConversationMessages({
      companyId: COMPANY_A,
      userId: ALICE,
      conversationId: conversation._id,
      q: 'sprint',
      limit: 4,
      cursor: page2.nextCursor,
    });

    assert.deepEqual(page3.items.map((row) => row.seq), [1]);
    assert.equal(page3.hasMore, false);
    assert.equal(page3.nextCursor, null, 'the end of the results says so');
  } finally {
    fake.restore();
  }
});

test('an escaped query is literal end to end: "a+b?" finds that text and a wildcard finds nothing', async () => {
  const conversation = seedConversation({});
  const messages = [
    seedMessage({ conversation, seq: 1, text: 'the formula a+b? is odd' }),
    seedMessage({ conversation, seq: 2, text: 'aaab looks similar but is different' }),
    seedMessage({ conversation, seq: 3, text: 'nothing to see here' }),
  ];

  const fake = installFakes({ conversations: [conversation], messages });

  try {
    const literal = await searchConversationMessages({
      companyId: COMPANY_A,
      userId: ALICE,
      conversationId: conversation._id,
      q: 'a+b?',
    });

    assert.deepEqual(literal.items.map((row) => row.seq), [1], 'matched literally, not as a pattern');

    // A crafted regex cannot be used to select an entire conversation.
    const wildcard = await searchConversationMessages({
      companyId: COMPANY_A,
      userId: ALICE,
      conversationId: conversation._id,
      q: '.*',
    });

    assert.deepEqual(wildcard.items, [], 'the wildcard searched for the literal text ".*"');

    // …and a pattern-ish query cannot throw its way into a 500.
    const odd = await searchConversationMessages({
      companyId: COMPANY_A,
      userId: ALICE,
      conversationId: conversation._id,
      q: '(((',
    });

    assert.equal(odd.ok, true);
    assert.deepEqual(odd.items, []);
  } finally {
    fake.restore();
  }
});

test('a disabled conversation is still searchable (search is a read, and the lock law keeps history readable)', async () => {
  const conversation = { ...seedConversation({}), isDisabled: true };
  const fake = installFakes({
    conversations: [conversation],
    messages: [seedMessage({ conversation, seq: 1, text: 'sprint review' })],
  });

  try {
    const result = await searchConversationMessages({
      companyId: COMPANY_A,
      userId: ALICE,
      conversationId: conversation._id,
      q: 'sprint',
    });

    assert.equal(result.ok, true);
    assert.equal(result.items.length, 1);
  } finally {
    fake.restore();
  }
});

// ══════════════════════════════════════════════════════════════════════════
// 4. Pins that keep the contract honest
// ══════════════════════════════════════════════════════════════════════════

test('the search path never logs the term', () => {
  const service = readSource('Backend/src/services/chat/chatSearchService.js');
  const controller = readSource('Backend/src/controllers/chat/chatController.js');
  const rules = readSource('Backend/src/utils/chatSearchRules.js');

  for (const [name, source] of [
    ['the search service', service],
    ['the rules module', rules],
  ]) {
    assert.equal(/console\./.test(source), false, `${name} must not write to the console`);
    assert.equal(/logger\./.test(source), false, `${name} must not log anything`);
  }

  const handler = controller.slice(
    controller.indexOf('export const searchMessages'),
    controller.indexOf('export const addMembers')
  );

  assert.ok(handler.length > 0, 'the handler exists');
  assert.equal(/logger|console\./.test(handler), false, 'the controller logs nothing on this path');

  // The term travels as a VALUE only: it is never interpolated into a message,
  // a path, or an error string.
  assert.equal(handler.includes('${q}'), false, 'the term is never string-interpolated');
  assert.equal(
    /throw new[^;]*\bq\b/.test(handler.replace(/q, cursor, limit/g, 'q')),
    false,
    'no thrown error carries the term'
  );
  assert.match(handler, /q: result\.q/, 'the response echoes the NORMALIZED term from the service');
});

test('no text index exists on ChatMessage, and the escalation path is documented', () => {
  const indexes = ChatMessage.schema.indexes();
  const keys = indexes.map(([spec]) => Object.keys(spec));

  assert.equal(
    keys.some((entry) => entry.includes('$**') || entry.includes('text')),
    false,
    'no text index in 34.4'
  );

  const source = readSource('Backend/src/models/ChatMessage.js');

  assert.match(
    source,
    /34\.4/,
    'the model explains the search decision next to the indexes it affects'
  );
  assert.match(
    readSource('Backend/src/services/chat/chatSearchService.js'),
    /WHY REGEX AND NOT \$text/,
    'the justification lives with the code that made the choice'
  );
});

test('the validator bounds the term at the edge, and the route carries its own budget', () => {
  const validators = readSource('Backend/src/validators/chat/chatValidators.js');

  assert.match(validators, /searchMessagesValidator/, 'the chain exists');
  assert.match(validators, /CHAT_SEARCH_MIN_QUERY/, 'the floor comes from the shared rules');
  assert.match(validators, /CHAT_SEARCH_MAX_QUERY/, 'so does the ceiling');

  const routes = readSource('Backend/src/routes/chat/chatRoutes.js');

  assert.match(routes, /'\/conversations\/:conversationId\/search'/, 'the endpoint is mounted');
  assert.match(routes, /chatRestLimiters\['message\.search'\]/, 'with its own rate bucket');

  // The limiter is registered BEFORE the controller, like every other route.
  const limiterAt = routes.indexOf("chatRestLimiters['message.search']");
  const controllerAt = routes.indexOf('chatController.searchMessages');

  assert.ok(limiterAt > 0 && controllerAt > limiterAt, 'limiter before controller');

  // The id validator used by the search chain is the shared conversation one.
  assert.ok(Array.isArray(conversationIdParamValidator), 'the shared id rule still exists');

  // And a normal send still validates exactly as before (no accidental coupling).
  assert.equal(
    validateSendPayload({ conversationId: String(id()), clientMessageId: 'c1', text: 'hi' }).ok,
    true
  );
});
