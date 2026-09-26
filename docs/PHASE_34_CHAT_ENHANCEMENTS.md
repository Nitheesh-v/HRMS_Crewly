# Phase 34 — Chat Enhancements

This document is the running record of Phase 34. **One unit at a time**, each
unit shipped with its own tests, its own limitations and its own localhost
acceptance steps. Nothing in this file is a promise about a later unit: a unit
is described here only once its code exists in the repository.

## Unit map

| Unit | Scope | Status |
| --- | --- | --- |
| **34.1** | Message reactions (fixed icon/text set) | **IMPLEMENTED** (this document) |
| 34.2 | Threads (reply-to + thread root, thread REST list, socket reply, thread panel) | NOT BUILT YET |
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

*Units 34.2 – 34.5 are not described here yet: this document gains a section per
unit, written when that unit is built. No later unit is in progress while 34.1
is awaiting localhost acceptance.*
