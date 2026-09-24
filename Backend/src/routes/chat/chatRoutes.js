// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 33.3 — CHAT CONVERSATION ROUTES (REST only, no socket events)
//
//  Middleware stack mirrors the repo's tenant-resource pattern
//  (projectRoutes.js): protect → tenantContext → checkSubscriptionStatus,
//  with checkWriteAccess on every mutating route.
//
//  AUTHORIZATION NOTE (deliberate, documented):
//    Conversation READS/writes stay free of requirePermission by design: chat
//    access is MEMBERSHIP, enforced Mongo-authoritatively in
//    services/chatService.js; the 33.9 catalogue entry (resource CHAT,
//    SYSTEM_PERMISSION_VERSION=37) covers moderation only, which is why the
//    three moderation routes at the bottom use requireAnyPermission. No
//    subscription feature is attached (unmapped resource = allowed), so the
//    gates stay checkSubscriptionStatus / checkWriteAccess.
// ═══════════════════════════════════════════════════════════════════════════

import { Router } from 'express';

import { protect } from '../../middlewares/authMiddleware.js';
import { tenantContext } from '../../middlewares/tenantMiddleware.js';
import {
  checkSubscriptionStatus,
  checkWriteAccess,
} from '../../middlewares/subscriptionAccess.js';
import * as chatController from '../../controllers/chat/chatController.js';
import {
  addMembersValidator,
  conversationIdParamValidator,
  createConversationValidator,
  disableConversationValidator,
  enableConversationValidator,
  listConversationsValidator,
  messageHistoryValidator,
  moderateDeleteValidator,
  readMarkerValidator,
  removeMemberValidator,
} from '../../validators/chat/chatValidators.js';
import { requireAnyPermission } from '../../middlewares/permissionMiddleware.js';

const router = Router();

router.use(protect, tenantContext, checkSubscriptionStatus);

router.post(
  '/conversations',
  checkWriteAccess,
  createConversationValidator,
  chatController.createConversation
);

router.get(
  '/conversations',
  listConversationsValidator,
  chatController.listMyConversations
);

router.get(
  '/conversations/:conversationId',
  conversationIdParamValidator,
  chatController.getConversation
);

// 33.4 — message history (read-only; send is 33.5, edit history 33.6).
router.get(
  '/conversations/:conversationId/messages',
  messageHistoryValidator,
  chatController.getMessages
);

router.post(
  '/conversations/:conversationId/members',
  checkWriteAccess,
  addMembersValidator,
  chatController.addMembers
);

router.delete(
  '/conversations/:conversationId/members/:userId',
  checkWriteAccess,
  removeMemberValidator,
  chatController.removeMember
);

// 33.7 — advance the caller's own C1 read cursor (monotonic, clamped).
// List/detail responses carry the per-caller count computed in the service.
router.post(
  '/conversations/:conversationId/read',
  checkWriteAccess,
  readMarkerValidator,
  chatController.updateReadMarker
);

// ═══════════════════════════════════════════════════════════════════════════
//  33.9 — MODERATION ROUTES (company-level)
//
//  These are the ONLY chat routes with requireAnyPermission: disabling a
//  conversation and tombstoning somebody else's message are company-level
//  powers, so the tenant-wide CHAT_MODERATE permission gates them (the
//  in-group ADMIN role is deliberately NOT enough — group admins moderate
//  their own group's membership, not other people's words).
//  Membership management above stays as 33.2 defined it (in-group ADMIN),
//  widened — never narrowed — by CHAT_GROUP_MANAGE inside the service.
// ═══════════════════════════════════════════════════════════════════════════

router.patch(
  '/conversations/:conversationId/disable',
  checkWriteAccess,
  requireAnyPermission(['CHAT_MODERATE']),
  disableConversationValidator,
  chatController.disableConversation
);

router.patch(
  '/conversations/:conversationId/enable',
  checkWriteAccess,
  requireAnyPermission(['CHAT_MODERATE']),
  enableConversationValidator,
  chatController.enableConversation
);

router.post(
  '/conversations/:conversationId/messages/:messageId/moderate-delete',
  checkWriteAccess,
  requireAnyPermission(['CHAT_MODERATE']),
  moderateDeleteValidator,
  chatController.moderateDeleteMessage
);

export default router;

export { router as chatRoutes };
