import { Router } from 'express';
import multer from 'multer';
import { protect } from '../middlewares/authMiddleware.js';
import { tenantContext } from '../middlewares/tenantMiddleware.js';
import * as taskController from '../controllers/taskController.js';

const router = Router();

// --- local, self-contained upload for task attachments (5MB, memory -> Cloudinary) ---
const taskUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

const uploadSingle = (req, res, next) =>
  taskUpload.single('file')(req, res, (err) => {
    if (err) {
      return res.status(400).json({
        success: false,
        message: err.code === 'LIMIT_FILE_SIZE' ? 'File too large (max 5MB)' : err.message,
      });
    }
    next();
  });

router.use(protect, tenantContext);

router.route('/')
  .get(taskController.listTasks)
  .post(taskController.createTask);

router.patch('/:id/status', taskController.updateTaskStatus);
router.post('/:id/comments', taskController.addComment);
router.post('/:id/attachments', uploadSingle, taskController.uploadAttachment);
router.delete('/:id/attachments/:attachmentId', taskController.deleteAttachment);

router.route('/:id')
  .get(taskController.getTask)
  .put(taskController.updateTask)
  .delete(taskController.deleteTask);

export default router;
export { router as taskRoutes };