// PHASE 33.8 — CHAT HUB CLIENT STATE (C1 read cursor model)
//
// Normalized by conversationId. Messages are stored ASCENDING by seq for
// rendering; the 33.4 API returns newest-first and the page reverses it.
// Optimistic sends live in `pending` keyed by clientMessageId until the
// chat:message:created broadcast (or a failure ACK) resolves them.
//
// PRIVACY: nothing here ever stores another member's read cursor — the
// backend projects only the caller's own cursor (33.7).

import { createSlice } from '@reduxjs/toolkit';

const initialState = {
  // idle | connected | unavailable  (unavailable = realtime banner, REST still works)
  realtimeStatus: 'idle',
  conversations: [],
  conversationsStatus: 'idle', // idle | loading | ready | error
  conversationsError: '',
  // 33.8-fix: a data-less socket nudge said the list changed server-side;
  // ChatPage refetches once when it sees this flag.
  conversationsStale: false,
  activeId: null,
  byId: {},    // conversationId -> { items, nextCursor, hasMore, status, error }
  pending: {}, // conversationId -> [{ clientMessageId, text, status }]
};

const emptyBucket = () => ({
  items: [],
  nextCursor: null,
  hasMore: false,
  status: 'idle',
  error: '',
});

const bucket = (state, conversationId) => {
  if (!state.byId[conversationId]) state.byId[conversationId] = emptyBucket();
  return state.byId[conversationId];
};

const insertAscending = (items, message) => {
  if (items.some((entry) => String(entry._id) === String(message._id))) return items;
  if (items.some((entry) => entry.seq === message.seq)) return items;
  return [...items, message].sort((a, b) => a.seq - b.seq);
};

const touchConversation = (state, { conversationId, message }) => {
  const conversation = state.conversations.find(
    (entry) => String(entry._id) === String(conversationId)
  );

  if (!conversation) return;

  conversation.lastMessageSeq = Math.max(
    conversation.lastMessageSeq ?? 0,
    message?.seq ?? 0
  );
  conversation.lastMessageAt = message?.createdAt ?? conversation.lastMessageAt;
  if (message && !message.deletedAt && message.text) {
    conversation.lastMessagePreview = String(message.text).slice(0, 200);
  }

  if (String(state.activeId) !== String(conversationId)) {
    conversation.unreadCount = (conversation.unreadCount ?? 0) + 1;
  }
};

const chatSlice = createSlice({
  name: 'chat',
  initialState,
  reducers: {
    realtimeStatusSet: (state, action) => {
      state.realtimeStatus = action.payload;
    },

    conversationsLoading: (state) => {
      state.conversationsStatus = 'loading';
      state.conversationsError = '';
    },

    conversationsLoaded: (state, action) => {
      state.conversations = action.payload;
      state.conversationsStatus = 'ready';
      state.conversationsStale = false;
    },

    conversationsNudged: (state) => {
      state.conversationsStale = true;
    },

    conversationsFailed: (state, action) => {
      state.conversationsStatus = 'error';
      state.conversationsError = action.payload;
    },

    conversationAdded: (state, action) => {
      const exists = state.conversations.some(
        (entry) => String(entry._id) === String(action.payload._id)
      );
      if (!exists) state.conversations = [action.payload, ...state.conversations];
    },

    // 33.9 — a moderation result (lock / unlock) merges into the existing
    // list row so the C1 unread fields and the member projection survive.
    conversationUpdated: (state, action) => {
      const payload = action.payload;
      if (!payload?._id) return;

      const index = state.conversations.findIndex(
        (entry) => String(entry._id) === String(payload._id)
      );

      if (index === -1) return;

      state.conversations[index] = { ...state.conversations[index], ...payload };
    },

    setActive: (state, action) => {
      state.activeId = action.payload;
    },

    messagesLoading: (state, action) => {
      bucket(state, action.payload).status = 'loading';
    },

    messagesLoaded: (state, action) => {
      const { conversationId, items, nextCursor, hasMore } = action.payload;
      const entry = bucket(state, conversationId);
      entry.items = [...items].sort((a, b) => a.seq - b.seq);
      entry.nextCursor = nextCursor;
      entry.hasMore = hasMore;
      entry.status = 'ready';
      entry.error = '';
    },

    messagesFailed: (state, action) => {
      const { conversationId, error } = action.payload;
      const entry = bucket(state, conversationId);
      entry.status = 'error';
      entry.error = error;
    },

    olderLoaded: (state, action) => {
      const { conversationId, items, nextCursor, hasMore } = action.payload;
      const entry = bucket(state, conversationId);
      const known = new Set(entry.items.map((m) => String(m._id)));
      const fresh = items.filter((m) => !known.has(String(m._id)));
      entry.items = [...fresh, ...entry.items].sort((a, b) => a.seq - b.seq);
      entry.nextCursor = nextCursor;
      entry.hasMore = hasMore;
      entry.status = 'ready';
    },

    pendingAdd: (state, action) => {
      const { conversationId, entry } = action.payload;
      const list = state.pending[conversationId] ?? [];
      if (!list.some((p) => p.clientMessageId === entry.clientMessageId)) {
        state.pending[conversationId] = [...list, entry];
      }
    },

    pendingFail: (state, action) => {
      const { conversationId, clientMessageId } = action.payload;
      state.pending[conversationId] = (state.pending[conversationId] ?? [])
        .filter((p) => p.clientMessageId !== clientMessageId);
    },

    messageCreated: (state, action) => {
      const { conversationId, message } = action.payload;
      if (!message) return;
      const entry = bucket(state, conversationId);
      entry.items = insertAscending(entry.items, message);

      // The created broadcast resolves the optimistic pending row.
      if (message.clientMessageId) {
        state.pending[conversationId] = (state.pending[conversationId] ?? [])
          .filter((p) => p.clientMessageId !== message.clientMessageId);
      }

      touchConversation(state, { conversationId, message });
    },

    messageUpdated: (state, action) => {
      const { conversationId, messageId, newText, editedAt, editVersion } = action.payload;
      const entry = bucket(state, conversationId);
      entry.items = entry.items.map((m) =>
        String(m._id) === String(messageId)
          ? { ...m, text: newText, editedAt, editVersion }
          : m
      );
    },

    messageDeleted: (state, action) => {
      // 33.9: deletedByUserId is kept so the bubble can tell a self-delete
      // from a moderator removal (never the original text).
      const { conversationId, messageId, deletedAt, deletedByUserId } = action.payload;
      const entry = bucket(state, conversationId);
      entry.items = entry.items.map((m) =>
        String(m._id) === String(messageId)
          ? { ...m, deletedAt, deletedByUserId: deletedByUserId ?? m.deletedByUserId, text: null }
          : m
      );
    },

    // 34.1 — reactions as a projection on the message, never as a separate
    // store: the bubble renders `message.reactions` and nothing else.
    //
    // TWO SOURCES, ONE SHAPE.
    //   · REST history (viewerAware: true) — the server already computed `mine`
    //     against the caller, so it is copied through as-is.
    //   · the room broadcast (viewerAware: false) — the payload is deliberately
    //     VIEWER-NEUTRAL ({type,count} + who acted), because one frame cannot
    //     carry a different `mine` per member. `mine` is therefore derived here:
    //     when the actor is me, ONLY the acted type is mine (the per-user cap is
    //     one, so an ADD replaces my previous type and a REMOVE clears it);
    //     when the actor is somebody else, my existing flags are preserved —
    //     their reaction never changes what I hold.
    reactionsUpdated: (state, action) => {
      const {
        conversationId,
        messageId,
        reactions = [],
        viewerAware = false,
        actorUserId = null,
        action: change = null,
        reactionType = null,
        myReaction = null,
        meId = null,
      } = action.payload;

      const entry = bucket(state, conversationId);
      const mineTheActor = Boolean(meId && actorUserId && String(meId) === String(actorUserId));

      entry.items = entry.items.map((message) => {
        if (String(message._id) !== String(messageId)) return message;

        const previous = message.reactions ?? [];

        const next = (Array.isArray(reactions) ? reactions : []).map((reaction) => {
          if (viewerAware) {
            return {
              type: reaction.type,
              count: reaction.count,
              mine: Boolean(reaction.mine ?? String(reaction.type) === String(myReaction)),
            };
          }

          if (mineTheActor) {
            return {
              type: reaction.type,
              count: reaction.count,
              mine: String(reaction.type) === String(reactionType) && change !== 'REMOVED',
            };
          }

          const before = previous.find((item) => item.type === reaction.type);

          return { type: reaction.type, count: reaction.count, mine: Boolean(before?.mine) };
        });

        return { ...message, reactions: next };
      });
    },

    readUpToApplied: (state, action) => {
      const { conversationId, myLastReadSeq, unreadCount } = action.payload;
      const conversation = state.conversations.find(
        (entry) => String(entry._id) === String(conversationId)
      );
      if (conversation) {
        conversation.myLastReadSeq = myLastReadSeq;
        conversation.unreadCount = unreadCount;
      }
    },
  },
});

export const {
  realtimeStatusSet,
  conversationsLoading,
  conversationsLoaded,
  conversationsNudged,
  conversationsFailed,
  conversationAdded,
  conversationUpdated,
  setActive,
  messagesLoading,
  messagesLoaded,
  messagesFailed,
  olderLoaded,
  pendingAdd,
  pendingFail,
  messageCreated,
  messageUpdated,
  messageDeleted,
  reactionsUpdated,
  readUpToApplied,
} = chatSlice.actions;

export default chatSlice.reducer;
