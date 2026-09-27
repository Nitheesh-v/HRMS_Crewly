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
| **34.3** | Mentions (`@user` autocomplete, server-validated `mentions[]`, in-app notifications only) | **IMPLEMENTED** (this document) |
| **34.4** | Search (conversation-scoped only) | **IMPLEMENTED** (this document) |
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

### Presentation update (user instruction, 34.4)

34.1 shipped the four fixed types drawn with icon-font glyphs and the product
rule "no emojis in new UI". **The user asked for the real emojis**, so the
rendering changed and the rule underneath it did not:

- `Frontend/src/utils/chatReactions.js` now owns `CHAT_REACTION_EMOJI`
  (`LIKE 👍`, `HEART ❤️`, `LAUGH 😂`, `THANKS 🙏`) next to the labels, and
  `ReactionIcon` renders that character.
- The set is still **closed**: it is a mapping from a stored enum value to a
  character, and there is still **no free-emoji input** anywhere (no text field,
  no picker library, no `contenteditable`) — pinned by a test that asserts the
  reaction UI contains exactly the four declared glyphs and nothing else.
- Accessibility is unchanged: the glyph is decorative and the accessible name
  comes from the text label, which the picker still shows beside every emoji, so
  the meaning never depends on a font or on recognising a glyph.
- The stored data is untouched (`LIKE/HEART/LAUGH/THANKS`), so no migration and
  no API change.

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

## 34.3 Mentions

### Implemented changes

**Mentions are structured, never parsed.** The client sends USER IDS; the server
resolves them and derives the visible token. Name-based parsing would need a
name→user lookup (a directory-enumeration surface: "does a person called X work
here?") and would be ambiguous the moment two colleagues share a first name.
Everything stored is something the server verified.

- **Added `Backend/src/utils/chatMentionRules.js`** — the pure rules, shared by
  the socket validator and the service so the wire rules and the stored rules
  cannot drift: `CHAT_MENTION_MAX_PER_MESSAGE = 10`,
  `CHAT_MENTION_TOKEN_MAX = 120`, `mentionTokenFor(name)` (whitespace-collapsed
  `@Name`, bounded), `tokenAppearsInText(text, token)` (literal, case-sensitive)
  and `parseMentionIds(raw)` (absent → `[]`; otherwise a list of ≤ 10 valid
  ObjectIds, de-duplicated).
- **Added `Backend/src/services/chat/chatMentionService.js`**:
  - `resolveMentions` — ONE tenant-scoped query
    (`User.find({ _id: { $in: ids + actor }, companyId })`) that simultaneously
    proves existence, enforces the tenant, and fetches the names. An id that is
    unknown, from **another tenant**, or **not a member of this conversation**
    refuses the whole send with `VALIDATION_ERROR`; an id that resolves but whose
    `@Name` is **not visible in the body** is dropped (the visibility rule). No
    ids at all → no query, no behaviour change.
  - `notifyMentionedUsers` — the in-app fan-out described below.
- **Modified `Backend/src/models/ChatMessage.js`** — `mentions: [{ userId, token }]`
  (`_id: false`, `userId` required and refs `User`, `token` ≤ 120, default `[]`),
  and the tombstone hook now clears `mentions` with the text: a deleted message
  mentions nobody.
- **Modified `Backend/src/services/chat/chatMessageService.js`** — mentions are
  resolved **before** the write (on the already-loaded conversation), so a
  refused id writes nothing and notifies nobody; both `sendTextMessage` and
  `sendFileMessage` accept `mentionUserIds`; notifications fire **only** on a
  genuinely created message (`created: true`), after the insert.
- **Modified `Backend/src/utils/notify.js`** — additive `notifyUsers(companyId, userIds, payload)`
  (one `insertMany`, same never-throws law as `notifyUser`). `notifySmart` is
  **deliberately not used** here: it queues email.
- **Modified `Backend/src/socket/chatSocketValidators.js`** — `chat:message:send`
  and `chat:message:sendFile` accept an optional `mentions` list, shape-checked at
  the edge; a malformed value is refused before any database read.
- **Modified `Backend/src/socket/chatSocketHandlers.js`** — both send paths
  forward the ids, `toBroadcastMessage` projects `mentions: [{ userId, token }]`
  (same shape as the REST history projection), and a refused mention is answered
  with the **rule** (`VALIDATION_ERROR`), not with a retry hint.
- **Modified `Backend/src/services/chat/chatService.js`** — the history
  projection carries the same `mentions` rows.
- **Frontend** — `MentionAutocomplete` (suggestions = members of the active
  conversation, me excluded), `MentionText` (the body rendered as text nodes with
  the server's tokens tinted), `utils/chatMentions.js` (caret scan, insert,
  reconcile), and wiring through `MessageComposer` (both composers),
  `MessageBubble`, `MessageList`, `ThreadMessageList`, `ThreadPanel` and
  `ChatPage`.
- **Tests** — new hermetic `Backend/test/chatMentions.test.js` (18 tests) plus
  mention pins in `chatModels.test.js`.

### API + socket contracts

```jsonc
// emit -> chat:message:send   (chat:message:sendFile takes the same field)
{
  "conversationId": "<id>",
  "clientMessageId": "<key>",
  "text": "please review @Bob Iyer",
  "replyToMessageId": null,          // 34.2, unchanged
  "mentions": ["<userId>", "<userId>"]   // 34.3 — optional, ≤ 10, ids only
}
```

The ACK and the room broadcast carry the **stored** rows, and the REST history
projection carries exactly the same shape:

```jsonc
{
  "mentions": [ { "userId": "<id>", "token": "@Bob Iyer" } ]
}
```

`token` is the fragment the sender's autocomplete inserted — text the reader
already sees in the body, so it is not new disclosure. It is the highlight
authority: the UI never guesses a name. Refusals: `VALIDATION_ERROR` with the
rule in `message` for an unknown / other-tenant / non-member id or a malformed
list; the existing `CONVERSATION_DISABLED`, `NOT_FOUND_OR_FORBIDDEN`,
`RATE_LIMITED`, `RETRYABLE` are unchanged. Mentions ride the existing
`message.send` budget — no new limit action, no new socket event, no new REST
endpoint.

### Security + tenancy rules

- **Membership is the denominator.** You can only mention a member of the
  conversation you are writing into. Mentioning someone who cannot read the
  message would notify them about something they can never open.
- **Tenant isolation.** The lookup filters by `companyId` and `_id` together, so
  a foreign id behaves exactly like a missing one: the send is refused and
  nothing is written. A mention cannot be used to probe another tenant.
- **Visibility.** A mention is stored (and can therefore notify) only when its
  token is really in the body — no invisible pings, no notification about text
  that does not address you.
- **Bounded.** ≤ 10 mentions per message, enforced at the edge **and** in the
  service, with duplicates collapsed.
- **No user document leaks.** The wire shape is exactly `{ userId, token }`;
  names are not re-broadcast as profile objects, and the client resolves names
  from the member list it already has.
- **Notifications are private and internal.** In-app only (`utils/notify.js`,
  never the email path), the actor is excluded, one batch per message, and the
  payload contains **no message text** — not even the token. Best-effort: a
  notification failure can never fail a send.
- **No surveillance.** Nothing records who read a mention, when, or whether they
  followed it. A mention is an event about a message, never an observation of a
  person.

### Notification behaviour (in-app only)

| Field | Value |
| --- | --- |
| `type` | `CHAT` |
| `title` | `You were mentioned in chat` |
| `message` | `<actor name> mentioned you in "<conversation title>"` (or `a direct message` / `a conversation`) |
| `link` | `/app/chat/<conversationId>` — opens the conversation |
| recipients | every stored mention, **excluding the sender** |
| delivery | one `insertMany` per message, best-effort, only for a genuinely created message |
| email | **none** — `notifySmart` is deliberately avoided in this unit |

### Limitations

- **No index on `mentions.userId` in 34.3.** Nothing reads by mention yet, and a
  fifth multikey index on `ChatMessage` would tax every message write for a query
  that does not exist. When a "my mentions" surface ships, add
  `{ companyId: 1, conversationId: 1, 'mentions.userId': 1, createdAt: -1 }` and
  measure before and after. (This is deliberate, not an oversight.)
- **Names, not handles.** The token is `@` + display name, so a name with spaces
  is one token and two people with the same name produce the same visible token
  — the *stored* rows stay unambiguous (each has its own `userId`), and "mentions
  you" is decided by id, so a collision is cosmetic only.
- **Renames are not retroactive.** A message keeps the token it was sent with. If
  a person is renamed later, the old message still highlights the old spelling
  and the person's user id still resolves for notifications.
- **A stale pick is dropped, not fixed.** If the text no longer contains the
  token (deleted before sending, or the name changed between load and send), the
  mention is dropped and the message still sends. The sender sees the truth in
  the ACK/broadcast rather than an error they cannot act on.
- **Directory-wide mentions are impossible by design.** The autocomplete lists
  conversation members only; a company directory picker is not part of 34.3 and
  would need its own permission review.
- **No mention of a non-member, ever.** Not even by hand-crafting a socket
  payload: the server refuses it.
- **Typing an `@Name` manually does not create a mention.** Only a picked
  suggestion is sent as a mention id; plain text stays plain text (it is not
  highlighted and notifies nobody). That is the honest behaviour of a structured
  mention system.
- **Mentions in a FILE message** work when the caption carries the token; a file
  with no caption has no body to mention anyone in.

### Localhost verification steps

```powershell
# Terminal 1 — API + socket server
cd Backend
npm run dev

# Terminal 2 — web app
cd Frontend
npm run dev
```

Signed in as a normal customer user, in a conversation with at least two members:

1. In the composer type `@`: a suggestion list appears with the conversation's
   members (you are not listed).
2. Keep typing letters — the list filters by name. `ArrowUp`/`ArrowDown` move the
   highlight, `Enter` or `Tab` picks, `Escape` closes.
3. Pick a name: `@Name ` is inserted and the caret lands after it. Press `Enter`
   — while the list is open `Enter` picks instead of sending.
4. Send the message: the mention is **tinted** in the bubble, and in a second
   browser window signed in as the mentioned person the **bell count rises**
   within its polling interval.
5. Open the bell (or Notifications): the entry reads "You were mentioned in
   chat" / "<your name> mentioned you in "<conversation>"" and clicking it opens
   the conversation. Confirm the notification shows **no message text**.
6. React/refresh: the highlight survives a page reload (it comes from the stored
   rows, not from socket state).
7. **Invisible-mention check** — type `@`, pick a name, then **delete the token**
   before sending: the message sends normally and nobody is notified (the pick is
   reconciled away, and the server drops non-visible mentions regardless).
8. **Self-mention check** — mention yourself: the token is highlighted, and you
   receive **no** notification for it.
9. **Non-member check (Postman/socket)** — from the browser console or a socket
   client, send `chat:message:send` with `mentions: ["<a user id who is not in
   this conversation>"]`: the ACK is
   `VALIDATION_ERROR` / "You can only mention people who are in this
   conversation." and no message is written.
10. **Cross-tenant check** — repeat with an id from another company (or a random
    ObjectId): the same refusal, with nothing created. Neither case reveals
    whether the id exists.
11. **Cap check** — try to pick more than 10 people: the list says a message can
    mention at most 10, and a hand-crafted payload with 11 ids is refused at the
    edge.
12. **Thread check** — mention someone from inside a thread reply: the mention is
    highlighted in the panel row and the notification opens the conversation.
13. **Locked conversation check** — as a moderator, disable the conversation:
    mentions cannot be sent (the whole send is refused like any other write),
    while history keeps its highlights.
14. **FILE check** — attach a file, type a caption containing a picked mention,
    and send: the caption is highlighted and the mentioned person is notified.

---

## 34.4 Search

### Implemented changes

**Conversation-scoped, bounded, tombstone-safe.** Search answers one question:
"where in THIS conversation did somebody say this?" It is not a tenant-wide
search, it does not search attachments, and it cannot see a deleted message —
the tombstone *is* the redaction.

- **Added `Backend/src/utils/chatSearchRules.js`** — the pure rules: query
  normalization (whitespace collapsed, trimmed), the bounds
  (`CHAT_SEARCH_MIN_QUERY = 2`, `CHAT_SEARCH_MAX_QUERY = 64`), the page clamp
  (`CHAT_SEARCH_LIMIT_DEFAULT = 10`, `CHAT_SEARCH_LIMIT_MAX = 20`),
  `escapeRegExp` and `buildSnippet`.
- **Added `Backend/src/services/chat/chatSearchService.js`** — the read path:
  its own membership+tenant gate (conversation loaded with
  `companyId` + `members.userId`; disabled conversations stay searchable because
  search is a *read*), the escaped literal regex, `type: 'TEXT'` and
  `deletedAt: null`, a `seq < cursor` window, `sort({ seq: -1 })`, a `limit + 1`
  probe and a bounded snippet per row.
- **Modified `Backend/src/validators/chat/chatValidators.js`** — `searchMessagesValidator`
  (id rule, `q` required and length-bounded from the shared constants, cursor ≥ 1,
  limit 1..20).
- **Modified `Backend/src/routes/chat/chatRoutes.js` + `controllers/chat/chatController.js`** —
  `GET /conversations/:conversationId/search` with its own rate bucket and a
  thin controller using the house comment convention. A non-member, another
  tenant and a missing conversation all become the **same 404**.
- **Modified `Backend/src/services/chat/chatRateLimitService.js` + `utils/chatObservability.js`** —
  a `message.search` budget (60/min per identity, its own bucket) and the
  matching log action.
- **Modified `Backend/src/models/ChatMessage.js`** — the 34.4 index decision is
  documented next to the indexes it affects (see §Index decision).
- **Frontend** — `ConversationSearchBar` (input, match count, close),
  `ConversationSearchResults` (sender, marked snippet, time, "reply" marker,
  load more, explicit empty/loading/error states), `chatService.searchMessages`,
  a `search` slice with `searchStarted/searchLoaded/searchMoreLoaded/searchFailed/searchCleared`,
  a header toggle in `ChatPage`, a 300 ms debounce, and the **jump** view
  (`jumpLoaded` + banner + scroll-to-target in `MessageList`).
- **Tests** — new hermetic `Backend/test/chatSearch.test.js` (17 tests); the
  34.1 emoji pin was inverted (see above) rather than deleted.

**Post-verification fix (first localhost run).** The UI rendered but every
search answered *"The search could not be completed."* Two real defects, both in
the client, both now fixed and pinned:

1. **Wrong page size.** `ChatPage` passed its history `PAGE_SIZE` (30) to the
   search endpoint, whose validator refuses anything above 20 — so the request
   was a 400 before it ever reached the database. The page now has its own
   `SEARCH_PAGE_SIZE = 20`, and a test reads that constant out of the page and
   asserts it is inside the server's bound and used by *both* search calls (the
   first page and "load more"). The server keeps refusing over-sized pages
   rather than silently trimming them.
2. **The error text was unreachable.** `api.js` rejects with `normalizeError()` —
   a plain `Error` whose `.message` holds the server's words and whose
   `.response` does **not** exist. Every `err?.response?.data?.message` read in
   the page therefore fell through to its generic fallback, which is how a 400
   about the page size arrived as a sentence about the search. One
   `chatErrorMessage(err, fallback)` helper now reads both shapes and is used by
   every error path on the page (a test asserts the raw read is gone).
3. **A failure is no longer a dead end.** The panel shows the server's own
   message with a **Try again** button. Retrying is explicit by design: the
   automatic path still refuses to re-ask the same term, so a refusing endpoint
   cannot be turned into a request loop by a timer.

### Endpoint contract

```
GET /api/chat/conversations/:conversationId/search?q=<term>&cursor=<seq>&limit=<n>
```

- **`q` is required**, 2..64 characters after normalization (internal whitespace
  collapses, edges trim). Below 2 the result set is not a result set; above 64
  it is a paste, not a search.
- `cursor` is a message `seq` (same contract as history and threads). `limit` is
  validated at the edge to 1..20 (default 10) and clamped again inside the
  service as a second line of defence, so an internal caller cannot widen it.
  The web app asks for **20** per search page (history and threads keep their own
  30) — the client never exceeds the contract, and the server never silently
  trims what it was asked for.
- **Filters:** `companyId`, `conversationId`, `type: 'TEXT'`, `deletedAt: null`,
  `text` matching an **escaped, case-insensitive** literal, `seq < cursor`.
- **Order:** `seq desc` (newest first), with a `limit + 1` probe for `hasMore`.

```jsonc
{
  "message": "Search results fetched",
  "data": {
    "conversationId": "<id>",
    "q": "sprint review",
    "items": [
      {
        "_id": "<id>",
        "seq": 42,
        "senderUserId": "<id>",
        "textSnippet": "…the sprint review notes…",   // bounded, centred on the match
        "createdAt": "2026-09-27T06:30:00.000Z",
        "threadRootMessageId": null,                  // set when the hit is a reply
        "replyToMessageId": null
      }
    ],
    "nextCursor": 21,
    "hasMore": true
  },
  "meta": { "limit": 10 }
}
```

Refusals: `400` with the rule for a query outside the bounds (validated at the
edge, so a bad query never reaches the database), and `404` for a conversation
the caller may not read — **identical** to a conversation that does not exist, so
search cannot be used to discover which rooms exist.

### Membership + tenancy guarantees

- **Gate first:** the conversation is loaded with `companyId` **and**
  `members.userId`, before any message query runs. A non-member — including a
  user from another tenant — produces `NOT_FOUND_OR_FORBIDDEN` → 404.
- **Two layers:** the message query itself also carries `companyId` and
  `conversationId`, so even a bug in the gate cannot cross a tenant boundary or
  reach another room.
- **The lock does not hide history:** a disabled conversation is still
  searchable (search is a read; the 33.9 law keeps history readable). Sending
  remains refused as always.
- **Deleted messages are invisible to search** — filtered in the query, not by
  the caller, so no code path can forget.
- **The term never reaches a log.** No `console`/logger call exists on the
  search path (pinned by a test), the controller's errors carry the rule and not
  the term, and the response echoes the normalized term back to its author only.
- **Bounded:** ≤ 20 rows per request, own 60/min per-identity budget, escapes
  applied to the pattern before Mongo sees it.

### Index decision (why no text index)

Search filters `{ companyId, conversationId, type, deletedAt, text: <escaped> }`
with a `seq` range and sorts by `seq desc` — the exact shape the existing
`(companyId, conversationId, seq: -1)` history index already serves. Mongo
allows **one** text index per collection and it cannot do substring matching
("rev" would not find "review"), so a text index would tax every message write
to speed up a query shape nobody asked for. **No index was added.** If a real
deployment ever measures a slow search, the documented escalation is a compound
*filter* index `{ companyId: 1, conversationId: 1, type: 1, deletedAt: 1, seq: -1 }`,
measured before and after — never a text index.

### Limitations

- **Conversation-scoped only.** There is no "search all conversations" in v1:
  that needs its own permission story (which rooms may a role see?), its own
  ranking and its own leak review. The bar says "Search in this conversation" so
  the product does not imply otherwise.
- **Substring, not relevance.** An escaped regex scan answers "contains",
  case-insensitively. There is no stemming ("reviews" ≠ "review"), no ranking
  and no fuzzy matching — deliberate, since ranking would need the index this
  unit refused to add.
- **Text messages only.** A FILE caption is a body, but the row is a FILE
  message and is not searched; attachment *content* is never searchable (the
  bytes live in private storage and are not indexed).
- **Deleted messages never appear**, including while they still occupy a `seq`.
- **`q` is echoed back** in the response (to the caller who typed it) and is
  never logged or stored. There is no search history anywhere.
- **Jump shows a window, not the tail.** Clicking a result loads one page that
  *ends* at that message and shows a banner with **Back to latest** — the reader
  is told they are not at the live end, instead of the app pretending the
  missing newer messages do not exist.
- **The debounce is client-side (300 ms)** and the floor is 2 characters on both
  sides: a server refusal is never used as a rate limiter for typing.
- **A failed search waits for the reader.** No timer re-asks a term that already
  failed; the panel shows the server's message plus **Try again**.

### Localhost verification steps

```powershell
# Terminal 1 — API + socket server
cd Backend
npm run dev

# Terminal 2 — web app
cd Frontend
npm run dev
```

1. Open a conversation with known messages and click the **search icon** in the
   header: the bar appears with the hint that typing two characters searches this
   conversation only.
2. Type a word you know is in a message: after a short pause, matches appear with
   sender name, the term marked inside the snippet, and the timestamp.
3. **Deleted check** — delete a message that contains the word, then search for it
   again: the deleted message never appears (its text is gone, and it is filtered
   even if a stale row existed).
4. **FILE check** — attach a file with a caption containing the word and search:
   the caption is not returned (search is TEXT-only).
5. Type a single character: the panel says at least two characters are needed and
   no request is sent.
5b. **Failure path** — stop the backend, search for a word, and confirm the panel
   shows a real message (not a silent blank) with a **Try again** button; restart
   the backend, press **Try again**, and the matches appear.
6. Type `a+b?` (or any symbols): the search returns only messages containing that
   literal text — no error, and no "match everything" behaviour. A lone `.*`
   returns the messages containing the literal `.*` (usually none).
7. Click a **result far up the history**: the window loads around that message, the
   message is ringed and scrolled into view, and the banner says
   "Showing the messages around your search result — not the latest." Press
   **Back to latest** and confirm the live tail comes back.
8. Click a result that was **already on screen**: it is scrolled to and marked
   without any reload.
9. Load more: with many matches, **Load more matches** appends the next page with
   no duplicates and no gap (cursor by `seq`).
10. **Non-member/other-tenant check (Postman):** call the endpoint with a token
    from a user who is not a member of that conversation, then with another
    tenant's token, then with a random conversation id — all three must return
    404 with the same body.
11. **Bounds check (Postman):** `q=` (empty), `q=a` (one char) and a 65-character
    `q` must each return 400 with the rule; `limit=500` must come back with a
    clamped page (max 20).
12. **Reactions check (the newest change):** hover a message, open the picker and
    confirm the four options now show real emojis (thumbs up, heart, laughing
    face, folded hands) with their text labels, and that pills under a message
    show the emoji with the count.

---

*Unit 34.5 is not described here yet: this document gains a section per unit,
written when that unit is built. No later unit is in progress while 34.4 is
awaiting localhost acceptance.*
