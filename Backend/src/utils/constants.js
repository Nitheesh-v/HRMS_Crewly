export const ROLES = {
  SUPER_ADMIN: 'SUPER_ADMIN',
  PLATFORM_ADMIN: 'PLATFORM_ADMIN',
  // Phase 30.1.1 — Crewly-internal background-verification team.
  BGV_TEAM: 'BGV_TEAM',
SUPPORT_ADMIN: 'SUPPORT_ADMIN',
BILLING_ADMIN: 'BILLING_ADMIN',
  COMPANY_ADMIN: 'COMPANY_ADMIN',
  HR_MANAGER: 'HR_MANAGER',
  MANAGER: 'MANAGER',
  TEAM_LEAD: 'TEAM_LEAD',
  EMPLOYEE: 'EMPLOYEE',
};

// Phase 30.1.1 — roles allowed inside the Crewly super-admin portal.
// Single source of truth (superAdminAuth re-exports this; BGV check
// service imports THIS so it never drags env/JWT into hermetic tests).
export const PLATFORM_ROLES = [
  'SUPER_ADMIN',
  'PLATFORM_ADMIN',
  'SUPPORT_ADMIN',
  'BILLING_ADMIN',
  // BGV verification is executed by the Crewly team, never by
  // tenant companies. BGV_TEAM is that working role.
  'BGV_TEAM',
];

export const ROLE_LIST = Object.values(ROLES);

export const PLANS = { TRIAL: 'TRIAL', BASIC: 'BASIC', PRO: 'PRO', ENTERPRISE: 'ENTERPRISE' };

export const TRIAL_DAYS = 14;

export const SUPER_ADMIN_COMPANY_CODE = 'CREWLY';

export const CREATION_RIGHTS = {
  [ROLES.SUPER_ADMIN]: [],
  [ROLES.COMPANY_ADMIN]: [ROLES.HR_MANAGER, ROLES.MANAGER, ROLES.TEAM_LEAD, ROLES.EMPLOYEE],
  [ROLES.HR_MANAGER]: [ROLES.EMPLOYEE],
  [ROLES.MANAGER]: [ROLES.TEAM_LEAD, ROLES.EMPLOYEE],
  [ROLES.TEAM_LEAD]: [ROLES.EMPLOYEE],
  [ROLES.EMPLOYEE]: [],
};

export const WORK_START_TIME = '09:30';
export const LATE_GRACE_MINUTES = 15;
export const HALF_DAY_MINUTES = 4 * 60;

export const LEAVE_TYPES = {
  CASUAL: { label: 'Casual Leave', yearly: 12 },
  SICK:   { label: 'Sick Leave',   yearly: 6 },
  EARNED: { label: 'Earned Leave', yearly: 12 },
};

export const LEAVE_STATUS = ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'];

// ---- Phase 5: Projects & Tasks ----
export const PROJECT_STATUS = ['PLANNING', 'ACTIVE', 'ON_HOLD', 'COMPLETED', 'CANCELLED'];
export const TASK_STATUS = ['TODO', 'IN_PROGRESS', 'REVIEW', 'DONE'];
export const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH'];