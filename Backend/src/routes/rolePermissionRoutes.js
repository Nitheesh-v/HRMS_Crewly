import { Router } from 'express';
import * as authNS from '../middlewares/authMiddleware.js';
import {
  tenantContext,
} from '../middlewares/tenantMiddleware.js';
import {
  requirePermission,
} from '../middlewares/permissionMiddleware.js';
import * as controller from '../controllers/rolePermissionController.js';

const protect =
  authNS.protect ||
  authNS.default?.protect ||
  authNS.default;

const router = Router();

// Reusable middleware array.
// Applied only to real RBAC endpoints—not globally.
const secured = [
  protect,
  tenantContext,
];

// Every tenant user can load their own permissions.
router.get(
  '/permissions/me',
  ...secured,
  controller.myPermissions
);

// Permission catalog.
router.get(
  '/permissions',
  ...secured,
  requirePermission(
    'SETTINGS_READ'
  ),
  controller.listPermissions
);

// Phase 29.1 RBAC update — payroll role templates (data, never seeded).
// Declared before /roles/:roleId so "templates" is not parsed as an id.
router.get(
  '/roles/templates',
  ...secured,
  requirePermission(
    'SETTINGS_READ'
  ),
  controller.getRoleTemplates
);

// Company roles.
router.get(
  '/roles',
  ...secured,
  requirePermission(
    'SETTINGS_READ'
  ),
  controller.listRoles
);

router.post(
  '/roles',
  ...secured,
  requirePermission(
    'SETTINGS_MANAGE'
  ),
  controller.createRole
);

router.get(
  '/roles/:roleId',
  ...secured,
  requirePermission(
    'SETTINGS_READ'
  ),
  controller.getRole
);

router.patch(
  '/roles/:roleId',
  ...secured,
  requirePermission(
    'SETTINGS_MANAGE'
  ),
  controller.updateRole
);

router.post(
  '/roles/:roleId/duplicate',
  ...secured,
  requirePermission(
    'SETTINGS_MANAGE'
  ),
  controller.duplicateRole
);

router.delete(
  '/roles/:roleId',
  ...secured,
  requirePermission(
    'SETTINGS_MANAGE'
  ),
  controller.deactivateRole
);

// Role permission matrix.
router.get(
  '/roles/:roleId/permissions',
  ...secured,
  requirePermission(
    'SETTINGS_READ'
  ),
  controller.getRole
);

router.put(
  '/roles/:roleId/permissions',
  ...secured,
  requirePermission(
    'SETTINGS_MANAGE'
  ),
  controller.updateRolePermissions
);

// User role assignment.
router.patch(
  '/users/:userId/role',
  ...secured,
  requirePermission(
    'USER_UPDATE'
  ),
  controller.assignUserRole
);

// Effective user permissions.
router.get(
  '/users/:userId/permissions',
  ...secured,
  requirePermission(
    'USER_READ'
  ),
  controller.userPermissions
);

// User-specific ALLOW/DENY overrides.
router.put(
  '/users/:userId/permissions',
  ...secured,
  requirePermission(
    'USER_UPDATE'
  ),
  controller.updateUserPermissions
);

export default router;

export {
  router as rolePermissionRoutes,
};