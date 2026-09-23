// PHASE 33.8-fix — hermetic pins for the REST→socket list-change nudge and
// the member-identity directory. No Mongo, no Redis, no HTTP, no live io.

import assert from 'node:assert/strict';
import test from 'node:test';

process.env.MONGO_URI ||= 'mongodb://127.0.0.1:27017/crewly_chat_nudge';
process.env.REDIS_ENABLED ||= 'false';

import {
  bindRealtimeNudge,
  unbindRealtimeNudge,
  notifyConversationsChanged,
} from '../src/socket/realtimeNudge.js';
import { buildMemberDirectory } from '../src/services/chat/chatReadService.js';

const makeIo = (calls) => ({
  to: (room) => ({
    emit: (event, payload) => calls.push({ room, event, payload }),
  }),
});

test('nudge is a no-op before bind and after unbind (realtime off = fine)', () => {
  unbindRealtimeNudge();
  assert.equal(notifyConversationsChanged(['1']), false, 'unbound -> false, never throws');

  const calls = [];
  bindRealtimeNudge(makeIo(calls));

  // Dedupes ids, skips nulls, targets personal rooms with a data-less event.
  assert.equal(notifyConversationsChanged(['1', '1', null, '2']), true);
  assert.deepEqual(calls, [
    { room: 'chat:user:1', event: 'chat:conversations:changed', payload: {} },
    { room: 'chat:user:2', event: 'chat:conversations:changed', payload: {} },
  ]);

  unbindRealtimeNudge();
  assert.equal(notifyConversationsChanged(['3']), false);
  assert.equal(calls.length, 2, 'nothing emits after unbind');
});

test('buildMemberDirectory dedupes member ids and returns slim identities only', async () => {
  const conversation = {
    members: [
      { userId: 'a1', role: 'MEMBER' },
      { userId: 'b2', role: 'MEMBER' },
      { userId: 'a1', role: 'ADMIN' },
    ],
  };

  let requested = null;
  const directory = await buildMemberDirectory([conversation], (ids) => {
    requested = [...ids].sort();
    return Promise.resolve([
      { _id: 'a1', name: 'Alice', email: 'a@x.test', avatarUrl: '', password: 'MUST_NOT_LEAK' },
      { _id: 'b2', name: 'Bob', email: 'b@x.test', avatarUrl: null },
    ]);
  });

  assert.deepEqual(requested, ['a1', 'b2'], 'ids are deduped before the lookup');
  assert.deepEqual(directory.get('a1'), { name: 'Alice', email: 'a@x.test', avatarUrl: '' });
  assert.deepEqual(directory.get('b2'), { name: 'Bob', email: 'b@x.test', avatarUrl: null });
  assert.ok(
    !('password' in (directory.get('a1') ?? {})),
    'directory values carry the slim projection only'
  );
});

test('buildMemberDirectory skips the lookup entirely when there are no members', async () => {
  let called = false;
  const directory = await buildMemberDirectory([{ members: [] }, {}], () => {
    called = true;
    return Promise.resolve([]);
  });

  assert.equal(called, false, 'no ids -> no query');
  assert.equal(directory.size, 0);
});
