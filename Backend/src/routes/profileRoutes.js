// ============================================================
// 👤 PROFILE ROUTES — /api/profile (protect only — works for
// tenant users AND super admin, no tenantContext needed here)
// ============================================================
import express from 'express';
import * as authMwNS from '../middlewares/authMiddleware.js';
import * as profileControllerNS from '../controllers/profileController.js';
import { avatarUpload } from '../middlewares/uploadMiddleware.js';

const mergeExports = (ns) => ({
  ...ns,
  ...(ns.default && typeof ns.default === 'object' ? ns.default : {}),
});

const { protect } = mergeExports(authMwNS);
const profileController = mergeExports(profileControllerNS);

const router = express.Router();
router.use(protect);

router.get('/me', profileController.getMyProfile);
router.put('/me', profileController.updateMyProfile);
router.post('/avatar', avatarUpload, profileController.uploadAvatar);
router.delete('/avatar', profileController.removeAvatar);

export default router;