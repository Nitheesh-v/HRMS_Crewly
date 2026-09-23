// PHASE 33.8 — CHAT HUB REST CLIENT
// Wraps the 33.3/33.4/33.7 backend contracts. The axios instance (api.js)
// attaches the tenant Bearer token; no secret lives here.

import api from './api.js';

// ApiResponse body: { statusCode, message, data, meta? }
const body = (res) => res?.data ?? res;

const chatService = {
  listConversations: async ({ cursor, limit } = {}) => {
    const params = {};
    if (cursor) params.cursor = cursor;
    if (limit) params.limit = limit;
    return body(await api.get('/chat/conversations', { params }));
  },

  createConversation: async (payload) => body(await api.post('/chat/conversations', payload)),

  getConversation: async (conversationId) =>
    body(await api.get(`/chat/conversations/${conversationId}`)),

  getMessages: async (conversationId, { cursor, limit } = {}) => {
    const params = {};
    if (cursor) params.cursor = cursor;
    if (limit) params.limit = limit;
    return body(await api.get(`/chat/conversations/${conversationId}/messages`, { params }));
  },

  markRead: async (conversationId, lastReadSeq) =>
    body(await api.post(`/chat/conversations/${conversationId}/read`, { lastReadSeq })),
};

export default chatService;
