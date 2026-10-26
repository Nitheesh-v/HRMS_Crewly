export const ROLES = {
  SUPER_ADMIN: 'SUPER_ADMIN',
  PLATFORM_ADMIN: 'PLATFORM_ADMIN',
SUPPORT_ADMIN: 'SUPPORT_ADMIN',
BILLING_ADMIN: 'BILLING_ADMIN',
  COMPANY_ADMIN: 'COMPANY_ADMIN',
  HR_MANAGER: 'HR_MANAGER',
  MANAGER: 'MANAGER',
  TEAM_LEAD: 'TEAM_LEAD',
  EMPLOYEE: 'EMPLOYEE',
};

export const ALL_ROLES = Object.values(ROLES);

export const PLATFORM_ROLES = [
  ROLES.SUPER_ADMIN,
  ROLES.PLATFORM_ADMIN,
  ROLES.SUPPORT_ADMIN,
  ROLES.BILLING_ADMIN,
];

export const getDashboardPath = (role) =>
  PLATFORM_ROLES.includes(role)
    ? '/super-admin/dashboard'
    : '/app';

// Mirrors the backend matrix — used to filter the role dropdown
export const CREATION_RIGHTS = {
  [ROLES.SUPER_ADMIN]: [],
  [ROLES.COMPANY_ADMIN]: [ROLES.HR_MANAGER, ROLES.MANAGER, ROLES.TEAM_LEAD, ROLES.EMPLOYEE],
  [ROLES.HR_MANAGER]: [ROLES.EMPLOYEE],
  [ROLES.MANAGER]: [ROLES.TEAM_LEAD, ROLES.EMPLOYEE],
  [ROLES.TEAM_LEAD]: [ROLES.EMPLOYEE],
  [ROLES.EMPLOYEE]: [],
};

// One tone per role, all cut from the app palette: gold, olive, clay, pale
// lime and sage. Blue and purple chips were the last cold colours in the app,
// and next to the cream/sage surfaces they read as a second product. Each chip
// is a tint with a legible ink on it in both themes (see docs/THEME.md).
export const ROLE_STYLES = {
  [ROLES.SUPER_ADMIN]: 'bg-crewly-orange/20 text-crewly-orange',
  [ROLES.COMPANY_ADMIN]: 'bg-crewly-green/15 text-crewly-green',
  [ROLES.HR_MANAGER]: 'bg-crewly-accent/20 text-crewly-text',
  [ROLES.MANAGER]: 'bg-crewly-selected text-crewly-selected-text',
  [ROLES.TEAM_LEAD]: 'bg-crewly-orange/15 text-crewly-orange',
  [ROLES.EMPLOYEE]: 'bg-crewly-inset-strong text-crewly-dim',
};

export const roleLabel = (role) => role?.replace('_', ' ') || '';