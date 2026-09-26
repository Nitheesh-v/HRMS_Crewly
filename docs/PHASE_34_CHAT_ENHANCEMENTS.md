# Phase 34 — Chat Enhancements

This document is the running record of Phase 34. **One unit at a time**, each
unit shipped with its own tests, its own limitations and its own localhost
acceptance steps. Nothing in this file is a promise about a later unit: a unit
is described here only once its code exists in the repository.

## Unit map

| Unit | Scope | Status |
| --- | --- | --- |
| **34.1** | Message reactions (fixed icon/text set) | **IMPLEMENTED** (this document) |
| **34.2** | Threads (reply-to + thread root, thread REST list, socket reply, thread panel) | **IMPLEMENTED** (this document) |
| 34.3 | Mentions (`@user` autocomplete, server-validated `mentions[]`, in-app notifications only) | NOT BUILT YET |
| 34.4 | Search (conversation-scoped only) | NOT BUILT YET |
| 34.5 | Typing indicator (socket-only, ephemeral, never stored) | NOT BUILT YET |

Explicitly **out of scope for the whole phase**: presence, availability, last
seen, activity tracking, read receipts beyond the C1 cursor model, and any
tenant-wide search in v1. Reactions, threads and typing are never used as a
presence signal, and none of them is written to the audit trail.

---

## 34.1 Reactions

### Implemented changes

**Why a separate collection, not a subdocument.** A reaction is a
high-churn, low-value row: toggling is something a user does many times per
message. Growing a subdocument array inside `ChatMessage` would push the
message document toward the 16 MB ceiling for a popular message, would make
every message read carry reaction data, and would make "one row per user per
message" a hand-written uniqueness check instead of a database constraint. A
dedicated collection keeps the message document immutable after send, and the
uniqueness becomes an index.

- **Added `Backend/src/models/ChatMessageReaction.js`** — the storage law.
  - `CHAT_REACTION_TYPES = ['LIKE', 'HEART', 'LAUGH', 'THANKS']` — a fixed,
    closed vocabulary (also the mongoose `enum`). No free text, no free emoji,
    no client-invented type ever reaches storage.
  - Fields: `companyId`, `conversationId`, `messageId`, `userId`,
    `reactionType`. All `immutable: true` — a row is created or deleted, never
    repointed at another message or another user.
  - **One unique index**: `(companyId, messageId, userId, reactionType)`. This
    is the idempotency guarantee: two tabs racing the same click produce one
    row, and the loser gets a duplicate-key error that the service treats as
    success (the desired state is already true).
  - Caps: `CHAT_REACTION_MAX_PER_USER_PER_MESSAGE = 1` (a user holds at most
    one reaction per message — picking another type *replaces* the previous
    one), `CHAT_REACTION_MAX_PER_MESSAGE = 200` (a guard, see Limitations), and
    `CHAT_REACTION_SUMMARY_ROW_LIMIT = 5000` for any single summary read.
- **Added `Backend/src/services/chat/chatReactionService.js`** — the only
  write/read path (`reactToMessage`, `unreactFromMessage`, `summarizeReactions`,
  `toNeutralSummary`, `isReactionType`, `CHAT_REACTION_ACTIONS`).
  - Authority (`companyId`, `userId`) always comes from the authenticated
    principal, never from the payload.
  - Reuses `loadWritableConversation` (the same membership + tenant + disabled
    gate as send/edit/delete), then loads the message **inside that tenant and
    that conversation** and refuses a tombstone.
  - Idempotent: reacting twice with the same type writes nothing, broadcasts
    nothing, and answers with the current truth (`changed: false`). Unreacting
    what was never there is likewise a success no-op.
  - Replace semantics: with the per-user cap at 1, a different type deletes the
    previous row and inserts the new one, and reports `action: 'REPLACED'`.
  - Summary is viewer-aware (`{ type, count, mine }`) and type-ordered by the
    fixed vocabulary, so two callers cannot disagree about ordering.
- **Modified `Backend/src/socket/chatSocketHandlers.js`** — `chat:message:react`
  and `chat:message:unreact`, sharing one implementation (`runReaction`), one
  rate-limit action and one payload validator. Both services are injectable so
  the handler tests stay hermetic.
- **Modified `Backend/src/socket/chatSocketValidators.js`** — `validateReactionPayload`:
  both ids must be valid ObjectIds, the type is trimmed, upper-cased and
  checked against the closed set **before** any database work.
- **Modified `Backend/src/services/chat/chatRateLimitService.js`** —
  `'message.react'` (10 s / 30), shared by react **and** unreact: one identity,
  one budget, so alternating the two events cannot double the allowance.
- **Modified `Backend/src/utils/chatErrors.js`** — `REACTION_LIMIT_REACHED`,
  the stable code the client sees when the per-message ceiling refuses a write.
- **Modified `Backend/src/services/chat/chatService.js`** —
  `sanitizeMessageForHistory(message, reactions)` now projects a `reactions`
  array, and `listMessages` fills it with **one** bounded query for the whole
  page (never one per message), skipping tombstoned rows entirely. A message
  nobody reacted to still carries `reactions: []`, so the renderer has exactly
  one shape to handle.
- **Frontend** — `MessageBubble` renders a reaction bar under the bubble plus a
  picker in the hover/touch action row; `MessageList` passes the handler
  through; `ReactionIcon` / `ReactionPicker` / `ReactionBar` are new
  components; `Frontend/src/utils/chatReactions.js` mirrors the vocabulary;
  `chatSlice` gained the `reactionsUpdated` projection; `chatSocketClient`
  gained `react` / `unreact` and the `chat:message:reactionsUpdated` listener.
- **Tests** — `Backend/test/chatReactions.test.js` (hermetic: real handlers +
  real service against in-memory model doubles) and the extended
  `Backend/test/chatHardening.test.js` gate pin.

### API + socket contracts

**Socket — client to server (ACK required).**

```jsonc
// emit -> chat:message:react   /   chat:message:unreact
{ "conversationId": "<id>", "messageId": "<id>", "reactionType": "LIKE" }
// reactionType is one of LIKE | HEART | LAUGH | THANKS (case-insensitive on
// the wire; the server stores the upper-case form). Anything else is refused
// with VALIDATION_ERROR before any database read.
```

```jsonc
// ACK (viewer-aware: this is the CALLER's own state)
{
  "ok": true,
  "data": {
    "messageId": "<id>",
    "reactions": [ { "type": "LIKE", "count": 2, "mine": true } ],
    "myReaction": "LIKE",     // null when the caller holds none
    "changed": true           // false = idempotent no-op, nothing broadcast
  }
}
```

Failure ACKs use the repository's existing stable socket codes:
`VALIDATION_ERROR`, `NOT_FOUND_OR_FORBIDDEN` (not a member, or another tenant),
`CONVERSATION_DISABLED`, `MESSAGE_DELETED`, `REACTION_LIMIT_REACHED`,
`RATE_LIMITED`, `UNAUTHORIZED`, `RETRYABLE`.

**Socket — server to room.**

```jsonc
// chat:message:reactionsUpdated  (one frame per change, sent to the
// conversation room only, only when something actually changed)
{
  "conversationId": "<id>",
  "messageId": "<id>",
  "reactions": [ { "type": "LIKE", "count": 2 } ],   // VIEWER-NEUTRAL: no `mine`
  "actorUserId": "<id>",                             // who added/removed what
  "action": "ADDED",                                 // ADDED | REMOVED | REPLACED
  "reactionType": "LIKE"
}
```

The broadcast is deliberately viewer-neutral — one frame cannot carry a
different `mine` per member. Each client derives `mine` from `actorUserId`
(and from its own ACK), which is exactly why the ACK is viewer-aware.

**REST.** No new endpoints. `GET /api/chat/conversations/:id/messages` items now
carry `reactions: [{ type, count, mine }]` (empty array when none), computed for
the requesting user.

### Security + tenancy rules

- **Tenant on every row.** `companyId` is written from the authenticated
  principal and every read filters on it; a reaction row can never be created
  or seen across tenants.
- **Membership before existence.** `loadWritableConversation` filters on
  `companyId` **and** `members.userId`, so a non-member — including a user from
  another tenant — receives `NOT_FOUND_OR_FORBIDDEN`. The same code is returned
  for "no such conversation" and "not yours", so reactions cannot be used as a
  membership or tenant probe.
- **Payload authority.** The client sends ids and a type. It cannot send a
  `companyId`, cannot react as somebody else, and cannot invent a type: the
  validator's closed set and the model's `enum` are the two gates.
- **Writes respect the lock.** A disabled conversation refuses reactions
  (history stays readable), exactly like send/edit/delete.
- **Deletion is final.** Reacting to a tombstone is refused
  (`MESSAGE_DELETED`) and the history projection never emits reactions for a
  tombstone, so a deleted message cannot be kept alive through reactions.
- **Abuse control.** The shared `'message.react'` budget (10 s / 30 per
  identity, Redis-backed, fails closed) covers both events; the per-message
  ceiling is the second guard. A limited request never reaches Mongo.
- **No content anywhere.** A reaction carries no text, is never editable, never
  logged, never written into a message preview, and never appears in the
  moderation audit trail (which stays ids + reason only).
- **Not presence.** Nothing in this unit records when a user was last active,
  whether they are online, or that they are typing.

### Limitations

- **The per-message ceiling is a guard, not a transaction.** The service counts
  after inserting and rolls its own row back when the count is over 200. Two
  simultaneous writers can sit one row over for a moment; nothing breaks, and
  the next unreact restores the bound. A transaction (or a counter document)
  would remove the window at the cost of a much heavier write path; that trade
  was made deliberately.
- **The summary read is bounded, not paginated.** `summarizeReactions` reads at
  most `CHAT_REACTION_SUMMARY_ROW_LIMIT` (5000) rows per call. On a page where
  more than 5000 reaction rows exist, some types could be undercounted. This is
  far beyond the practical ceiling (200 per message), and the row limit exists
  to keep one hostile conversation from turning a history read into a scan.
- **Socket-only writes.** Reactions require realtime. With `realtime unavailable`
  the picker still renders but the ACK comes back `FEATURE_UNAVAILABLE` and the
  notice explains it; there is no REST fallback in 34.1 (deliberate: the REST
  surface stays read-only for reactions).
- **No reaction on tombstones, no reaction while locked.** Both are refusals by
  design, and the UI hides the controls in those states.
- **No who-reacted list.** A reaction is a count plus "did I react". The
  identity of other reactors is not exposed in v1 — the broadcast tells clients
  who *acted* (needed to derive `mine`), but the UI does not display a list.
- **`mine` is per-viewer, so it is never in the room broadcast.** A client that
  misses a broadcast re-syncs on the next history read (the REST projection is
  authoritative).

### Localhost verification steps

Backend and frontend start commands (PowerShell, from the repository root):

```powershell
# Terminal 1 — API + socket server
cd Backend
npm run dev

# Terminal 2 — web app
cd Frontend
npm run dev
```

Then, signed in as a normal customer user with Redis available:

1. Open **Chat**, pick a conversation, and hover a message: a `+` reaction
   button appears next to edit/delete (on a touch/narrow window it is always
   visible).
2. Click `+` and pick **Like**. The pill appears under the bubble with count
   `1`, highlighted (this is your own reaction).
3. Click the same pill again: it disappears (count returns to 0 and the pill is
   removed). The picker still shows all four options.
4. React **Like**, then open the picker and pick **Heart**: the Like pill is
   replaced by a Heart pill — one user never holds two reactions on a message.
5. Open a second browser window as **another member** of the same conversation
   and react on the same message: your window updates within a second, the count
   increases, and the pill stays unhighlighted for them (their `mine`, not
   yours).
6. Have the second user react a second time with the same type: nothing is
   duplicated and nobody sees a second update.
7. **Reload the page**: reactions are still there, still highlighted correctly
   for you (this proves the REST history projection, not just the socket path).
8. **Tenant / membership check** — as a user who is *not* a member of that
   conversation (another tenant, or a colleague outside the room), confirm the
   conversation is not listed at all, and that the message history cannot be
   opened. Reactions inherit that same gate.
9. **Deleted message check** — delete one of your messages that has reactions:
   the row becomes the delete placeholder and the reaction bar disappears; the
   picker is gone for that row.
10. **Locked conversation check** — as a moderator, disable the conversation:
    history stays readable, reaction pills remain visible, and no picker is
    offered (the server refuses the write with `CONVERSATION_DISABLED` anyway).
11. **Rate-limit check** — toggle reactions on one message about 30 times
    within ten seconds: after the budget is spent the UI shows the rate-limit
    message and no further rows are written. Wait ten seconds and try again —
    it works.
12. **Realtime-down check** — stop Redis (or the API) and retry a reaction: the
    UI reports that realtime is unavailable instead of pretending the reaction
    was saved. Restart it and use the banner's Retry, then confirm reactions
    work again.

---

## 34.2 Threads

### Implemented changes

**Why two fields and not a second collection.** A thread here is a QUERY, not a
document: the root carries `threadRootMessageId = null`, every reply carries the
root's id there and its immediate parent in `replyToMessageId`. There is no
children array to grow, no reply counter to drift, and no tree to balance — a
thread can never fork deeper than two levels, because replying to a reply keeps
the ORIGINAL root. That is the whole storage story: two nullable ObjectIds and
one compound index.

- **Modified `Backend/src/models/ChatMessage.js`** — `replyToMessageId` and
  `threadRootMessageId` (both `ObjectId` refs to `ChatMessage`, `default: null`,
  `immutable: true`) plus the index
  `{ companyId: 1, conversationId: 1, threadRootMessageId: 1, seq: -1 }`.
  Existing indexes are untouched and nothing is synced at runtime — indexes stay
  schema-declared only.
- **Added `Backend/src/services/chat/chatThreadService.js`** — the read path and
  the reply resolver:
  - `resolveReplyTarget` — the parent must be a message of THIS tenant and THIS
    conversation; anything else is `null`, which the caller reports as
    `NOT_FOUND_OR_FORBIDDEN`. A reply can therefore never be used as an
    existence probe.
  - `toReplyPreview` — the bounded hint (`messageId`, `senderUserId`, `snippet`,
    `deletedAt`). The snippet is truncated to 120 characters and is **null** for
    a tombstoned or body-less parent, so a preview can never resurrect deleted
    text.
  - `summarizeThreadCounts` — reply counts for a page in ONE aggregation.
  - `loadReplyPreviews` — every parent referenced by a page in ONE query.
  - `listThreadMessages` — the read gate (tenant + membership, and deliberately
    NOT an `isDisabled` check: the lock law keeps history readable), the root
    lookup, the **root redirect** (asking for a reply opens the thread it
    belongs to) and the pagination (cursor by `seq`, newest first, `limit + 1`
    probe, clamp 1..50).
- **Modified `Backend/src/services/chat/chatMessageService.js`** — the parent is
  resolved BEFORE anything is written; the stored message gets
  `replyToMessageId = parent._id` and
  `threadRootMessageId = parent.threadRootMessageId ?? parent._id`; the write
  returns the bounded preview so the ACK can show it. Both `sendTextMessage` and
  `sendFileMessage` accept the optional target (a FILE reply would otherwise
  silently lose its context). The idempotency pre-check and the E11000
  convergence path are untouched, and a retry re-resolves its preview instead of
  writing anything.
- **Modified `Backend/src/services/chat/chatService.js`** — `listMessages` now
  projects `replyToMessageId`, `threadRootMessageId`, `replyTo` and
  `threadReplyCount` for a page, using the two bounded lookups above (skipped
  entirely when the page has no replies). Added `getThread`, the read facade
  that runs the thread service and projects the root + items exactly like a
  history page — reactions included.
- **Modified `Backend/src/socket/chatSocketValidators.js`** — `validateSendPayload`
  and `validateSendFilePayload` accept an optional `replyToMessageId`, which
  must be a valid ObjectId when present (absent/null/`''` mean "not a reply").
- **Modified `Backend/src/socket/chatSocketHandlers.js`** — both send paths
  forward the target, and the shared `toBroadcastMessage(message, replyTo)`
  projection now carries `replyToMessageId`, `threadRootMessageId` and `replyTo`
  on both the `chat:message:created` broadcast and the sender's ACK.
- **Modified `Backend/src/services/chat/chatRateLimitService.js` +
  `Backend/src/utils/chatObservability.js`** — a `thread.history` REST budget
  (60/min, its own bucket, so a hot thread cannot starve history) and the
  matching log action.
- **Modified `Backend/src/validators/chat/chatValidators.js`,
  `src/routes/chat/chatRoutes.js`, `src/controllers/chat/chatController.js`** —
  the new endpoint, its validator and its controller with the house comment
  convention.
- **Frontend** — `ThreadPanel` (drawer/column), `ThreadMessageList` (compact
  rows), `ReplyContextPill`; `MessageBubble` gained a Reply action, the reply
  hint above a reply, and a "View thread (n)" affordance; `MessageComposer` takes
  a `replyPill` slot; `chatSlice` holds threads keyed by root id and feeds them
  from `messageCreated`/`threadMessageDeleted`; `chatService.getThread` is the
  REST call; `ChatPage` owns the reply target and the open thread and uses ONE
  `sendMessage` for both composers.
- **Tests** — new hermetic `Backend/test/chatThreads.test.js` (18 tests) plus
  extended model pins in `chatModels.test.js` (thread index, field rules, and
  `ChatMessageReaction` — the 34.1 model — added to the pinned map) and extended
  fakes in `chatHistory.test.js`.

### API + socket contracts

**REST — one thread page.**

```
GET /api/chat/conversations/:conversationId/threads/:rootMessageId?cursor=<seq>&limit=<n>
```

- `:rootMessageId` may be the root OR any reply in that thread: the server
  resolves the effective root, so one thread has exactly one view.
- `cursor` is a message `seq` (same contract as history), `limit` is clamped
  1..50 (default 20).
- 404 `NOT_FOUND_OR_FORBIDDEN` for a non-member, another tenant, a message from
  another conversation, or an id that does not exist — one indistinguishable
  refusal.

```jsonc
{
  "message": "Thread fetched",
  "data": {
    "conversationId": "<id>",
    "root": { /* the same message shape as history, with threadReplyCount */ },
    "items": [ /* replies, newest first, same shape as history */ ],
    "nextCursor": 42,
    "hasMore": true
  },
  "meta": { "limit": 20 }
}
```

A projected message now carries:

```jsonc
{
  "replyToMessageId": null,        // the immediate parent, null at top level
  "threadRootMessageId": null,     // the thread it belongs to
  "replyTo": {                     // bounded hint, null when not a reply
    "messageId": "<id>", "senderUserId": "<id>",
    "snippet": "first 120 chars of the parent, or null if deleted",
    "deletedAt": null
  },
  "threadReplyCount": 3,           // replies in the thread this message ROOTS
  "reactions": [ { "type": "LIKE", "count": 2, "mine": true } ]
}
```

**Socket — send an answer.**

```jsonc
// emit -> chat:message:send   (chat:message:sendFile takes the same field)
{ "conversationId": "<id>", "clientMessageId": "<key>", "text": "…",
  "replyToMessageId": "<id or null>" }
```

`replyToMessageId` is optional; a malformed value is refused at the edge with
`VALIDATION_ERROR` before any database read. The ACK and the room broadcast both
carry the three thread fields, so no client has to refetch to learn where a
message belongs. Refusals: `NOT_FOUND_OR_FORBIDDEN` (parent missing, other
tenant or other conversation), `CONVERSATION_DISABLED` (a reply is a write),
plus the existing `RATE_LIMITED` / `RETRYABLE` / `UNAUTHORIZED`.

### Security + tenancy rules

- **Tenant on the row, tenant on the query.** Both new fields are written from a
  parent resolved with `companyId` AND `conversationId`; every read filters the
  same way. A reply pointing across a boundary cannot exist.
- **No existence leak.** A non-member, another tenant, a parent in another room
  and a nonexistent id all produce the SAME `NOT_FOUND_OR_FORBIDDEN`, on both the
  REST and the socket surface.
- **Authority unchanged.** `companyId`/`userId` still come only from
  `req.companyId`/`req.user` (REST) and `socket.data` (socket). The client sends
  one optional id and never a tenant.
- **Reads respect the lock law.** A disabled conversation stays readable as a
  thread (it is history); replying is a write and is refused exactly like
  sending, editing and deleting.
- **Tombstones stay tombstones.** A deleted root or reply keeps its row, loses
  its text, shows a neutral placeholder in the panel, and can never reappear in
  a reply hint — the snippet is null server-side.
- **No surveillance.** Opening a thread writes nothing. There is no per-thread
  cursor, no follower list, no "seen by", and the read model stays C1 (the
  per-member `lastReadSeq` on the conversation, unchanged by this unit).
- **Abuse control.** The thread page is rate-limited per `companyId:userId`
  (`thread.history`, 60/min) through the shared store, which still fails closed
  when Redis is down.

### Limitations

- **Two levels only.** Replying to a reply answers the original thread; there is
  no nested tree, no "reply to a reply to a reply" chain — by design, because the
  UI can render one flat list and nobody has to reason about depth.
- **Panel replies answer the ROOT.** The thread panel's composer always answers
  the root message (the pill above the composer says so). Replying to a specific
  message is done from the main view's "Reply" action.
- **No per-thread unread state.** Replies count toward the conversation's
  existing C1 unread behaviour; a thread has no badge of its own. Adding one
  would be a read-model change, and this unit does not touch C1.
- **No edit/delete inside the panel.** Thread rows are read-only (no edit, no
  delete, no reaction picker); reaction pills show what the thread says. The
  panel is a focused read, and moderation stays where its rules and confirmations
  already live.
- **Three bounded queries per history page.** Reactions, reply hints and thread
  counts are each resolved in ONE query for the whole page (≤ 50 ids), skipped
  when the page has no replies. A conversation with no threads costs exactly what
  it cost before this unit.
- **A deleted parent cannot be answered back into existence.** Replying to a
  tombstone is allowed (a moderator removal must not freeze a thread) and its
  hint shows "deleted message" — the text itself is gone for good.
- **`threadReplyCount` is derived, not stored.** It is computed per page, so it
  is always consistent with the rows that exist and can never be a stale
  denormalized number.
- **Realtime append, not realtime ordering guarantees.** A reply arriving while
  the panel is open is inserted by `seq` like any other message; a client that
  misses the broadcast re-reads the thread page, which is the authority.

### Localhost verification steps

```powershell
# Terminal 1 — API + socket server
cd Backend
npm run dev

# Terminal 2 — web app
cd Frontend
npm run dev
```

Signed in as a normal customer user with Redis available:

1. Hover a message → the action row now shows a **Reply** arrow (touch/narrow
   windows show it always). Click it: the composer shows "Replying to <name>:
   <snippet>" with an ✕.
2. Send a message: it appears with the reply hint above the bubble, and the room
   shows it in realtime in a second window.
3. Cancel the reply target with the ✕ and send another message: it is a normal
   top-level message with no hint.
4. Click **View thread (1)** under the message you answered: the panel opens
   beside the conversation (full screen on a phone) showing the root message, the
   reply, and a composer.
5. Type in the panel's composer and send: the reply appears in the panel, and in
   the OTHER window the main conversation also grows a new row with its own hint.
6. Reply inside the panel, then click **Reply** on that same reply from the main
   view and send: the new message lands in the SAME thread (the panel shows it),
   not in a second one.
7. Open a thread with more replies than one page and press **Load older replies**:
   older rows appear above, without duplicates.
8. Delete one of the replies you wrote: it becomes a placeholder in the panel too,
   and any reply that answered it says "deleted message" instead of its text.
9. Delete a message that has replies: the thread stays open and can still be
   replied to — only the text is gone.
10. **Non-member / other-tenant check** — with Postman, call
    `GET /api/chat/conversations/<conversationId>/threads/<rootMessageId>` as a
    user who is not a member of that conversation, then as a user from another
    tenant: both must return 404 with `NOT_FOUND_OR_FORBIDDEN`, identical to a
    random id.
11. **Cross-conversation check** — as a member, call the same endpoint with a
    `rootMessageId` from a DIFFERENT conversation you also belong to: 404, same
    body.
12. **Lock check** — as a moderator, disable the conversation: the thread still
    opens and reads (history stays readable), while the panel's composer and the
    main composer both refuse to send.
13. **Realtime-down check** — stop Redis or the API and open a thread: the panel
    still loads over REST (history is REST-served) and the banner explains that
    realtime is unavailable. Restart, press Retry, and reply in the thread.

---

*Units 34.3 – 34.5 are not described here yet: this document gains a section per
unit, written when that unit is built. No later unit is in progress while 34.2 is
awaiting localhost acceptance.*
