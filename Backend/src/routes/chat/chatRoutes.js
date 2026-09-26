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
  attachmentIdParamValidator,
  conversationIdParamValidator,
  createConversationValidator,
  disableConversationValidator,
  enableConversationValidator,
  listConversationsValidator,
  messageHistoryValidator,
  moderateDeleteValidator,
  readMarkerValidator,
  removeMemberValidator,
  uploadAttachmentValidator,
} from '../../validators/chat/chatValidators.js';
import { createDocumentFileUpload } from '../../middlewares/documentFilePolicy.js';
import {
  CHAT_ATTACHMENT_FIELD,
  CHAT_ATTACHMENT_MAX_BYTES,
  CHAT_ATTACHMENT_MESSAGES,
  isMultipartRequest,
} from '../../utils/chatFileRules.js';
import ApiError from '../../utils/ApiError.js';
import { requireAnyPermission } from '../../middlewares/permissionMiddleware.js';
// 33.11 — abuse controls. Identity comes from the authenticated request
// (companyId + userId), never from the payload; the budget is shared across
// instances through the 32.4 store and degrades to a bounded per-process
// bucket (never unlimited) when Redis is down.
import { chatRestLimiters } from '../../services/chat/chatRateLimitService.js';

const router = Router();

router.use(protect, tenantContext, checkSubscriptionStatus);

router.post(
  '/conversations',
  chatRestLimiters['conversation.create'],
  checkWriteAccess,
  createConversationValidator,
  chatController.createConversation
);

router.get(
  '/conversations',
  chatRestLimiters['conversation.list'],
  listConversationsValidator,
  chatController.listMyConversations
);

router.get(
  '/conversations/:conversationId',
  chatRestLimiters['conversation.detail'],
  conversationIdParamValidator,
  chatController.getConversation
);

// 33.4 — message history (read-only; send is 33.5, edit history 33.6).
router.get(
  '/conversations/:conversationId/messages',
  chatRestLimiters['message.history'],
  messageHistoryValidator,
  chatController.getMessages
);

router.post(
  '/conversations/:conversationId/members',
  chatRestLimiters['conversation.members.add'],
  checkWriteAccess,
  addMembersValidator,
  chatController.addMembers
);

router.delete(
  '/conversations/:conversationId/members/:userId',
  chatRestLimiters['conversation.members.remove'],
  checkWriteAccess,
  removeMemberValidator,
  chatController.removeMember
);

// 33.7 — advance the caller's own C1 read cursor (monotonic, clamped).
// List/detail responses carry the per-caller count computed in the service.
router.post(
  '/conversations/:conversationId/read',
  chatRestLimiters['message.read'],
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
  chatRestLimiters['conversation.moderateState'],
  checkWriteAccess,
  requireAnyPermission(['CHAT_MODERATE']),
  disableConversationValidator,
  chatController.disableConversation
);

router.patch(
  '/conversations/:conversationId/enable',
  chatRestLimiters['conversation.moderateState'],
  checkWriteAccess,
  requireAnyPermission(['CHAT_MODERATE']),
  enableConversationValidator,
  chatController.enableConversation
);

router.post(
  '/conversations/:conversationId/messages/:messageId/moderate-delete',
  chatRestLimiters['message.moderateDelete'],
  checkWriteAccess,
  requireAnyPermission(['CHAT_MODERATE']),
  moderateDeleteValidator,
  chatController.moderateDeleteMessage
);

// ═══════════════════════════════════════════════════════════════════════════
//  33.10 — ATTACHMENTS (private storage; auth-gated delivery)
//
//  The upload reuses the repo's shared file policy (PDF/JPG/JPEG/PNG/WEBP
//  with an extension+MIME cross-check) and its 10 MB document cap — no new
//  policy, no new limit. Membership is NOT checked here: the service resolves
//  it from Mongo so the answer is authoritative (and the uploader learns
//  nothing about conversations they are not in).
//
//  The download is the ONLY way bytes leave the system: it proves tenant +
//  membership first, then returns a bounded signed URL (or streams a dev-local
//  file) with Cache-Control private,no-store,max-age=0.
// ═══════════════════════════════════════════════════════════════════════════

// Size/type violations MUST be 400s, never 500s — the same mapping every
// other uploader in the repo uses (selfServiceRoutes / taskRoutes /
// uploadMiddleware.wrap). The policy message already names the allowlist.
const chatAttachmentUpload = (req, res, next) => {
  // Shape first: a JSON body can never carry a file, and multer would answer
  // with a misleading "a file is required". Name the real mistake instead.
  if (!isMultipartRequest(req)) {
    next(ApiError.badRequest(CHAT_ATTACHMENT_MESSAGES.NOT_MULTIPART));
    return;
  }

  createDocumentFileUpload(CHAT_ATTACHMENT_MAX_BYTES)
    .single(CHAT_ATTACHMENT_FIELD)(req, res, (error) => {
      if (error) {
        error.statusCode = 400;
        if (error.code === 'LIMIT_FILE_SIZE') {
          error.message = CHAT_ATTACHMENT_MESSAGES.TOO_LARGE;
        }
      }
      next(error);
    });
};

router.post(
  '/conversations/:conversationId/attachments',
  chatRestLimiters['attachment.upload'],
  checkWriteAccess,
  chatAttachmentUpload,
  uploadAttachmentValidator,
  chatController.uploadAttachment
);

router.get(
  '/attachments/:attachmentId/download',
  chatRestLimiters['attachment.download'],
  attachmentIdParamValidator,
  chatController.downloadAttachment
);

export default router;

export { router as chatRoutes };
