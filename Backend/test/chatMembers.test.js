// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 34.6 — GROUP MEMBERSHIP (ADD / REMOVE / LEAVE) — HERMETIC.
//
//  No Redis, no Mongo, no HTTP. What is pinned here is the part of the
//  membership feature that is NOT already covered by chatConversations.test.js
//  (which owns the authorisation rules: admin-only add, admin-only remove of
//  others, self-removal allowed, cap, last-member and last-admin guards):
//
//    · a MUTATION answer leaves through the read projection, so it can never
//      hand the actor another member's read cursor (the C1 law) — and it DOES
//      carry the names the members panel needs
//    · the four mutating endpoints use that projection (source pin)
//    · removing someone takes their SOCKETS out of the conversation room, and
//      self-removal (leaving) does the same
//    · the eviction is skipped when nothing was removed
//    · the frontend speaks the same contract: two client methods, a members
//      modal, an admin gate, and a removed-while-open path that leaves the room
// ═══════════════════════════════════════════════════════════════════════════

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

process.env.MONGO_URI ||= 'mongodb://127.0.0.1:27017/crewly_chat_members';
process.env.REDIS_ENABLED ||= 'false';

import mongoose from 'mongoose';

import { projectConversationForActor } from '../src/services/chat/chatReadService.js';
import {
  bindRealtimeNudge,
  evictConversationMember,
  notifyConversationsChanged,
  unbindRealtimeNudge,
} from '../src/socket/realtimeNudge.js';
import { conversationRoom, userRoom } from '../src/utils/chatKeys.js';

const { ObjectId } = mongoose.Types;

const id = () => new ObjectId();

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..', '..');

const readSource = (relative) => fs.readFileSync(path.join(repo, relative), 'utf8');

const COMPANY = id();
const ADMIN = id();
const MEMBER = id();
const NEWCOMER = id();

const seedConversation = () => ({
  _id: id(),
  companyId: COMPANY,
  type: 'GROUP',
  title: 'Design',
  isDisabled: false,
  lastMessageSeq: 42,
  members: [
    // Every member carries the bookkeeping the projection must hide.
    { userId: ADMIN, role: 'ADMIN', joinedAt: new Date('2026-01-01'), joinedAtSeq: 0, lastReadSeq: 41 },
    { userId: MEMBER, role: 'MEMBER', joinedAt: new Date('2026-02-02'), joinedAtSeq: 12, lastReadSeq: 7 },
    { userId: NEWCOMER, role: 'MEMBER', joinedAt: new Date('2026-03-03'), joinedAtSeq: 40, lastReadSeq: 0 },
  ],
});

// ═══════════════════════════════════════════════════════════════════════════
//  1. THE PROJECTION
// ═══════════════════════════════════════════════════════════════════════════

test('a membership answer never carries another member cursor, and keeps the names', async () => {
  const conversation = seedConversation();

  const findUsers = async (ids) =>
    ids.map((userId) => ({
      _id: userId,
      name: `User ${String(userId).slice(-4)}`,
      email: null,
      avatarUrl: null,
    }));

  const projected = await projectConversationForActor(conversation, MEMBER, { findUsers });

  // Identity + shape survive: the client merges this row into its list.
  assert.equal(String(projected._id), String(conversation._id));
  assert.equal(projected.title, 'Design');
  assert.equal(projected.members.length, 3);

  for (const member of projected.members) {
    assert.equal(
      'lastReadSeq' in member,
      false,
      'no member cursor may leave a mutation response (C1)',
    );
    assert.equal('joinedAtSeq' in member, false, 'and no join cursor either');
    assert.ok('userId' in member && 'role' in member, 'but membership bookkeeping stays');
    assert.ok(member.user && member.user.name, 'and the directory name rides along');
  }

  // The caller's OWN cursor is a different thing: it is theirs and the UI needs
  // it (the unread arithmetic is per caller).
  assert.equal(projected.myLastReadSeq, 7);
  assert.equal(projected.lastMessageSeq, 42);
  assert.equal(typeof projected.unreadCount, 'number');
  assert.ok(projected.unreadCount >= 0);

  // The raw document must not be mutated by projecting it.
  assert.equal(conversation.members[1].lastReadSeq, 7, 'the input is untouched');
});

test('the projection is not a data leak in the other direction: null in, null out', async () => {
  assert.equal(await projectConversationForActor(null, MEMBER), null);
  assert.equal(await projectConversationForActor(undefined, MEMBER), null);
});

test('every mutating conversation endpoint projects its answer', () => {
  // addMembers / removeMember / disable / enable all answered with the raw
  // document before 34.6. One source pin covers all four: each response body
  // must go through projectForActor, and the raw conversations may only be
  // used internally (the nudge needs the member ids before projection).
  const controller = readSource('Backend/src/controllers/chat/chatController.js');

  const uses = controller.match(/conversation: await projectForActor\(/g) ?? [];

  assert.equal(
    uses.length,
    4,
    'add / remove / disable / enable must each project their conversation',
  );

  assert.ok(
    !/conversation: (conversation|result\.conversation),/.test(controller),
    'no endpoint may return the raw conversation any more',
  );

  // The nudge still resolves member ids from the RAW row, before projection:
  // it targets personal rooms and needs nothing private to do it.
  assert.match(controller, /memberIdsOf\(result\.conversation\)/);
});

// ═══════════════════════════════════════════════════════════════════════════
//  2. THE EVICTION
// ═══════════════════════════════════════════════════════════════════════════

const installIo = () => {
  const calls = [];

  const io = {
    in: (room) => ({
      socketsLeave: (other) => {
        calls.push({ room, other });
      },
    }),
    to: (room) => ({
      emit: (event) => {
        calls.push({ room, event });
      },
    }),
  };

  bindRealtimeNudge(io);

  return { calls, restore: () => unbindRealtimeNudge() };
};

test('a removed member is taken out of the conversation room', () => {
  const { calls, restore } = installIo();

  try {
    const conversationId = String(id());
    const removedUserId = String(MEMBER);

    assert.equal(evictConversationMember(conversationId, removedUserId), true);

    assert.deepEqual(calls, [
      {
        // Their personal room is the selector...
        room: userRoom(removedUserId),
        // ...and the conversation room is what they lose.
        other: conversationRoom(conversationId),
      },
    ]);

    // The eviction is scoped to THAT user's sockets: it must never be a
    // room-wide operation that could drop everyone.
    assert.ok(!calls.some((call) => call.room === conversationRoom(conversationId)));
  } finally {
    restore();
  }
});

test('the removal endpoint evicts exactly when somebody was really removed', () => {
  const controller = readSource('Backend/src/controllers/chat/chatController.js');

  // Guarded by `removed`, and fed the id the SERVICE resolved (never the raw
  // path parameter) so a refusal or a no-op cannot evict anybody.
  assert.match(
    controller,
    /if \(removed\) evictConversationMember\(conversationId, removed\);/,
    'eviction rides the service verdict',
  );

  assert.match(
    controller,
    /if \(removed\) notifyConversationsChanged\(\[removedUserId\]\);/,
    'the list nudge is unchanged',
  );
});

test('eviction is a no-op without a live socket server, never a throw', () => {
  unbindRealtimeNudge();

  assert.equal(evictConversationMember(String(id()), String(MEMBER)), false);
  assert.equal(notifyConversationsChanged([String(MEMBER)]), false);
  // Garbage in, still no throw: a REST request must succeed even if the ids
  // are unusable.
  assert.equal(evictConversationMember(null, null), false);
});

test('the nudge and the eviction share one io reference, bound by the socket server', () => {
  const nudge = readSource('Backend/src/socket/realtimeNudge.js');

  assert.match(nudge, /export const bindRealtimeNudge/);
  assert.match(nudge, /export const unbindRealtimeNudge/);
  // 34.6 — the multi-instance limit is DOCUMENTED, not assumed away.
  assert.match(nudge, /redis-adapter does not fan it out across nodes/i);
});

// ═══════════════════════════════════════════════════════════════════════════
//  3. THE FRONTEND CONTRACT
// ═══════════════════════════════════════════════════════════════════════════

test('the chat client speaks both membership routes', () => {
  const client = readSource('Frontend/src/services/chatService.js');

  assert.match(client, /addMembers: async \(conversationId, memberUserIds\)/, 'add exists');
  assert.match(client, /removeMember: async \(conversationId, userId\)/, 'remove exists');
  assert.match(client, /api\.post\(`\/chat\/conversations\/\$\{conversationId\}\/members`/, 'POST route');
  assert.match(
    client,
    /api\.delete\(`\/chat\/conversations\/\$\{conversationId\}\/members\/\$\{userId\}`/,
    'DELETE route',
  );
});

test('the members panel is a group surface with an admin gate and a self path', () => {
  const modal = readSource('Frontend/src/components/chat/GroupMembersModal.jsx');
  const page = readSource('Frontend/src/pages/chat/ChatPage.jsx');

  assert.ok(modal.includes('Add people'), 'the panel can add');
  assert.ok(modal.includes('Leave group'), 'and anyone can leave');
  assert.ok(modal.includes("role === 'ADMIN'"), 'the panel knows who is an admin');

  // The UI only hides what the server would refuse; the server keeps deciding.
  assert.ok(page.includes('GroupMembersModal'), 'the page renders the panel');
  assert.ok(page.includes('handleAddMembers') && page.includes('handleRemoveMember'));
  assert.ok(page.includes('handleLeaveGroup'));

  // It must never hardcode the server's cap: the refusal message is the truth.
  assert.ok(!/50\s*members/.test(modal), 'the member cap is not duplicated in the UI');
});

test('the panel ships no emoji, no console and no raw HTML', () => {
  const modal = readSource('Frontend/src/components/chat/GroupMembersModal.jsx');

  assert.deepEqual(
    modal.match(/\p{Extended_Pictographic}/gu) ?? [],
    [],
    'no emoji in new UI (34.4 lifted this for the REACTION surface only)',
  );
  assert.ok(!/console\./.test(modal), 'the chat surface never logs');
  assert.ok(!/dangerouslySetInnerHTML/.test(modal), 'React escaping is the law');
});

test('a member who is removed while reading loses the room, not just the row', () => {
  const page = readSource('Frontend/src/pages/chat/ChatPage.jsx');
  const slice = readSource('Frontend/src/redux/slices/chatSlice.js');

  // The client half of the eviction: when the refetched list no longer holds
  // the open conversation, the page leaves the socket room and drops the state
  // it was rendering. Without this a removed user keeps an open, live window.
  assert.ok(page.includes('conversationDropped'), 'the page reacts to being dropped');
  assert.ok(
    /no longer a member/i.test(page),
    'and says so in words the reader can act on',
  );
  assert.ok(slice.includes('conversationDropped:'), 'the slice owns the drop');
  assert.ok(
    slice.includes("delete state.search") || slice.includes('delete state.threads'),
    'dropping clears the conversation-scoped state too',
  );
});
