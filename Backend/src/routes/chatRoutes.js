// ═══════════════════════════════════════════════════════════════════════════
//  PHASE 33.3 — CHAT CONVERSATION ROUTES (REST only, no socket events)
//
//  Middleware stack mirrors the repo's tenant-resource pattern
//  (projectRoutes.js): protect → tenantContext → checkSubscriptionStatus,
//  with checkWriteAccess on every mutating route.
//
//  AUTHORIZATION NOTE (deliberate, documented):
//    No requirePermission(...) and no requireFeature(...) here. The
//    permission catalogue (SYSTEM_PERMISSION_VERSION=36) and the plan feature
//    map are strictly versioned and contain no CHAT entries; adding them is a
//    separate versioned unit. Tenant + membership + in-group ADMIN role are
//    enforced in services/chatService.js, and the subscription gate
//    (checkSubscriptionStatus / checkWriteAccess) still applies.
// ═══════════════════════════════════════════════════════════════════════════

import { Router } from 'express';

import { protect } from '../middlewares/authMiddleware.js';
import { tenantContext } from '../middlewares/tenantMiddleware.js';
import {
  checkSubscriptionStatus,
  checkWriteAccess,
} from '../middlewares/subscriptionAccess.js';
import * as chatController from '../controllers/chatController.js';
import {
  addMembersValidator,
  conversationIdParamValidator,
  createConversationValidator,
  listConversationsValidator,
  messageHistoryValidator,
  removeMemberValidator,
} from '../validators/chatValidators.js';

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

export default router;

export { router as chatRoutes };
