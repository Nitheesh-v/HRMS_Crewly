// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 33.5 — CHAT SOCKET ROOM NAMING
//
//  Single source of truth for Socket.IO room keys so the server (join/send/
//  broadcast) and any future consumer can never drift apart.
//
//  Rooms are logical Socket.IO channels fanned out across replicas by the
//  33.1 Redis adapter. A conversation's ObjectId is globally unique, so
//  `chat:conv:<id>` is already collision-free across tenants; the companyId
//  and user rooms exist for future targeted (non-survey) fan-out and are
//  kept here so the vocabulary stays in one place.
//
//  These are INTERNAL channel names only. They are never sent to clients in
//  a way that leaks topology, and they never carry tokens, Redis ids or job
//  ids.
// ═══════════════════════════════════════════════════════════════════════════

export const conversationRoom = (conversationId) =>
  `chat:conv:${String(conversationId)}`;

export const companyRoom = (companyId) => `chat:company:${String(companyId)}`;

export const userRoom = (userId) => `chat:user:${String(userId)}`;
