import { Router } from 'express';
import { createDocumentFileUpload } from '../middlewares/documentFilePolicy.js';
import { protect } from '../middlewares/authMiddleware.js';
import {
  tenantContext,
} from '../middlewares/tenantMiddleware.js';
import {
  checkSubscriptionStatus,
  checkWriteAccess,
  requireFeature,
} from '../middlewares/subscriptionAccess.js';
import {
  requireAnyPermission,
  requirePermission,
} from '../middlewares/permissionMiddleware.js';
import * as taskController from '../controllers/taskController.js';

const router = Router();

// Phase 32.8 — same 5 MB cap, now with the shared extension+MIME
// allowlist (previously ANY type was accepted).
const taskUpload = createDocumentFileUpload(5 * 1024 * 1024);

const uploadSingle = (
  req,
  res,
  next
) =>
  taskUpload.single('file')(
    req,
    res,
    (error) => {
      if (error) {
        return res
          .status(400)
          .json({
            statusCode: 400,
            success: false,

            message:
              error.code ===
              'LIMIT_FILE_SIZE'
                ? 'File too large (max 5MB)'
                : error.message,
          });
      }

      next();
    }
  );

router.use(
  protect,
  tenantContext,
  checkSubscriptionStatus,
  requireFeature('projects')
);

router.get(
  '/',
  requireAnyPermission([
    'TASK_READ',
    'TASK_READ_SELF',
  ]),
  taskController.listTasks
);

router.post(
  '/',
  checkWriteAccess,
  requirePermission(
    'TASK_CREATE'
  ),
  taskController.createTask
);

router.get(
  '/:id',
  requireAnyPermission([
    'TASK_READ',
    'TASK_READ_SELF',
  ]),
  taskController.getTask
);

router.put(
  '/:id',
  checkWriteAccess,
  requireAnyPermission([
    'TASK_UPDATE',
    'TASK_UPDATE_SELF',
  ]),
  taskController.updateTask
);

router.delete(
  '/:id',
  checkWriteAccess,
  requirePermission(
    'TASK_DELETE'
  ),
  taskController.deleteTask
);

router.patch(
  '/:id/status',
  checkWriteAccess,
  requireAnyPermission([
    'TASK_UPDATE',
    'TASK_UPDATE_SELF',
  ]),
  taskController.updateTaskStatus
);

router.post(
  '/:id/comments',
  checkWriteAccess,
  requireAnyPermission([
    'TASK_UPDATE',
    'TASK_UPDATE_SELF',
  ]),
  taskController.addComment
);

router.post(
  '/:id/attachments',
  checkWriteAccess,
  requireAnyPermission([
    'TASK_UPDATE',
    'TASK_UPDATE_SELF',
  ]),
  uploadSingle,
  taskController.uploadAttachment
);

// Phase 32.8 — gated attachment bytes (task-visibility checked inside the
// controller; a storage key/URL alone grants nothing).
router.get(
  '/:id/attachments/:attachmentId/file',
  requireAnyPermission([
    'TASK_READ',
    'TASK_READ_SELF',
  ]),
  taskController.getTaskAttachmentFile
);

router.delete(
  '/:id/attachments/:attachmentId',
  checkWriteAccess,
  requireAnyPermission([
    'TASK_UPDATE',
    'TASK_UPDATE_SELF',
  ]),
  taskController.deleteAttachment
);

export default router;

export {
  router as taskRoutes,
};