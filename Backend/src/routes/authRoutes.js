import { Router } from 'express';
import { registerCompany, login, getMe } from '../controllers/authController.js';
import { registerCompanyValidator, loginValidator, validate } from  "../validators/authValidator.js"
import { protect } from '../middlewares/authMiddleware.js';
import { tenantContext } from '../middlewares/tenantMiddleware.js';

const router = Router();

router.post('/register-company', registerCompanyValidator, validate, registerCompany);
router.post('/login', loginValidator, validate, login);
router.get('/me', protect, tenantContext, getMe);

export default router;