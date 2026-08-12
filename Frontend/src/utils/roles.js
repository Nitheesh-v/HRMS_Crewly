export const ROLES = {
  SUPER_ADMIN: 'SUPER_ADMIN',
  COMPANY_ADMIN: 'COMPANY_ADMIN',
  HR_MANAGER: 'HR_MANAGER',
  MANAGER: 'MANAGER',
  TEAM_LEAD: 'TEAM_LEAD',
  EMPLOYEE: 'EMPLOYEE',
};

export const ALL_ROLES = Object.values(ROLES);

export const getDashboardPath = (role) => (role === ROLES.SUPER_ADMIN ? '/admin' : '/app');

// Mirrors the backend matrix — used to filter the role dropdown
export const CREATION_RIGHTS = {
  [ROLES.SUPER_ADMIN]: [],
  [ROLES.COMPANY_ADMIN]: [ROLES.HR_MANAGER, ROLES.MANAGER, ROLES.TEAM_LEAD, ROLES.EMPLOYEE],
  [ROLES.HR_MANAGER]: [ROLES.EMPLOYEE],
  [ROLES.MANAGER]: [ROLES.TEAM_LEAD, ROLES.EMPLOYEE],
  [ROLES.TEAM_LEAD]: [ROLES.EMPLOYEE],
  [ROLES.EMPLOYEE]: [],
};

export const ROLE_STYLES = {
  [ROLES.SUPER_ADMIN]: 'bg-crewly-orange/15 text-crewly-orange',
  [ROLES.COMPANY_ADMIN]: 'bg-crewly-green/15 text-crewly-green',
  [ROLES.HR_MANAGER]: 'bg-blue-400/15 text-blue-300',
  [ROLES.MANAGER]: 'bg-purple-400/15 text-purple-300',
  [ROLES.TEAM_LEAD]: 'bg-yellow-400/15 text-yellow-300',
  [ROLES.EMPLOYEE]: 'bg-white/10 text-crewly-dim',
};

export const roleLabel = (role) => role?.replace('_', ' ') || '';