// PHASE 33.8 — CHAT HUB REST CLIENT
// Wraps the 33.3/33.4/33.7 backend contracts. The axios instance (api.js)
// attaches the tenant Bearer token; no secret lives here.
//
// IMPORTANT — response unwrapping: the api.js response interceptor already
// unwraps once. Endpoints whose body carries `meta` come back as
// { message, data, meta }; endpoints without `meta` come back as `data`
// itself. Every method below normalizes to a clean shape so pages never
// guess levels again.

import api from './api.js';

const withMeta = (res) => ({
  data: res?.data ?? res,
  meta: res?.meta ?? {},
});

const bare = (res) =>
  res && typeof res === 'object' && 'data' in res ? res.data : res;

const chatService = {
  // -> { conversations, nextCursor, hasMore, limit }
  listConversations: async ({ cursor, limit } = {}) => {
    const params = {};
    if (cursor) params.cursor = cursor;
    if (limit) params.limit = limit;

    const { data, meta } = withMeta(await api.get('/chat/conversations', { params }));

    return {
      conversations: data?.conversations ?? [],
      nextCursor: meta.nextCursor ?? data?.nextCursor ?? null,
      hasMore: meta.hasMore ?? data?.hasMore ?? false,
      limit: meta.limit ?? data?.limit,
    };
  },

  // -> { conversation, created }
  createConversation: async (payload) => bare(await api.post('/chat/conversations', payload)),

  // -> { conversation }
  getConversation: async (conversationId) =>
    bare(await api.get(`/chat/conversations/${conversationId}`)),

  // 34.2 — one thread page. Same cursor contract as history, one extra param.
  // -> { root, items, nextCursor, hasMore }
  getThread: async (conversationId, rootMessageId, { cursor, limit } = {}) => {
    const params = {};
    if (cursor) params.cursor = cursor;
    if (limit) params.limit = limit;

    const { data, meta } = withMeta(
      await api.get(`/chat/conversations/${conversationId}/threads/${rootMessageId}`, { params })
    );

    return {
      root: data?.root ?? null,
      items: data?.items ?? [],
      nextCursor: data?.nextCursor ?? meta.nextCursor ?? null,
      hasMore: data?.hasMore ?? meta.hasMore ?? false,
    };
  },

  // -> { items, nextCursor, hasMore }
  getMessages: async (conversationId, { cursor, limit } = {}) => {
    const params = {};
    if (cursor) params.cursor = cursor;
    if (limit) params.limit = limit;

    const { data, meta } = withMeta(
      await api.get(`/chat/conversations/${conversationId}/messages`, { params })
    );

    return {
      items: data?.items ?? [],
      nextCursor: data?.nextCursor ?? meta.nextCursor ?? null,
      hasMore: data?.hasMore ?? meta.hasMore ?? false,
    };
  },

  // -> { conversationId, myLastReadSeq, lastMessageSeq, unreadCount }
  markRead: async (conversationId, lastReadSeq) =>
    bare(await api.post(`/chat/conversations/${conversationId}/read`, { lastReadSeq })),

  // ── 33.9 moderation (CHAT_MODERATE holders only; the backend refuses
  // everyone else with 403, so these are safe to expose to all clients).
  // -> { conversation, changed }
  disableConversation: async (conversationId, reason = null) =>
    bare(await api.patch(`/chat/conversations/${conversationId}/disable`, { reason })),

  enableConversation: async (conversationId) =>
    bare(await api.patch(`/chat/conversations/${conversationId}/enable`)),

  // -> { conversationId, messageId, deletedAt, changed }
  moderateDelete: async (conversationId, messageId, reason = null) =>
    bare(
      await api.post(
        `/chat/conversations/${conversationId}/messages/${messageId}/moderate-delete`,
        { reason }
      )
    ),

  // ── 33.10 attachments ──────────────────────────────────────────────────
  // Upload is REST (multipart); the FILE message itself goes over the socket
  // (chatRealtime.sendFile) so it rides the same seq/idempotency path as text.
  // -> { attachment: { _id, fileName, mimeType, sizeBytes, scanState, createdAt } }
  uploadAttachment: async (conversationId, file) => {
    const form = new FormData();
    form.append('file', file);

    // The shared axios instance defaults to Content-Type: application/json and
    // axios serializes a FormData body to JSON when that header survives — the
    // server then sees a JSON body with no file. Every uploader in this repo
    // therefore states multipart/form-data explicitly (docsService.js).
    const response = await api.post(
      `/chat/conversations/${conversationId}/attachments`,
      form,
      { headers: { 'Content-Type': 'multipart/form-data' } }
    );

    return bare(response);
  },

  // The ONLY way to fetch bytes: the gated endpoint streams them through the
  // API (Bearer token), so membership is re-checked on every download and no
  // provider URL or storage key ever reaches the browser.
  // -> Blob
  downloadAttachment: async (attachmentId) => {
    const response = await api.get(`/chat/attachments/${attachmentId}/download`, {
      responseType: 'blob',
    });

    return response instanceof Blob ? response : response?.data ?? response;
  },
};

export default chatService;
