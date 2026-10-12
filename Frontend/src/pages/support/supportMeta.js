// ============================================================
// 🎫 HELPDESK META — departments, statuses, formatters (Phase 38)
// Visual language mirrors the Figma "Help Center" exports;
// category codes are constrained by the existing SupportTicket schema.
// ============================================================
import { Banknote, Building2, Laptop, Users, Wallet } from 'lucide-react';

// Phase-38 support departments. `code` maps to SupportTicket.category enum.
export const DEPARTMENTS = [
  { code: 'IT', label: 'IT Support', blurb: 'Devices, access, software & network', Icon: Laptop },
  { code: 'HR', label: 'HR Support', blurb: 'People, policies & documents', Icon: Users },
  { code: 'OTHER', label: 'Finance Support', blurb: 'Reimbursements, PF, tax & general', Icon: Wallet },
  { code: 'PAYROLL', label: 'Payroll Support', blurb: 'Payslips, salary & corrections', Icon: Banknote },
  { code: 'FACILITIES', label: 'Administration Support', blurb: 'Facilities, assets & admin help', Icon: Building2 },
];

export const CATEGORY_LABELS = {
  IT: 'IT Support',
  HR: 'HR Support',
  OTHER: 'Finance & General',
  PAYROLL: 'Payroll',
  FACILITIES: 'Administration',
  LEAVE: 'Leave',
  ATTENDANCE: 'Attendance',
};

export const categoryLabel = (code) => CATEGORY_LABELS[code] || code;

export const STATUSES = [
  { code: 'OPEN', label: 'Open', badge: 'bg-crewly-orange/15 text-crewly-orange', dot: 'bg-crewly-orange' },
  { code: 'IN_PROGRESS', label: 'In progress', badge: 'bg-blue-500/15 text-blue-400', dot: 'bg-blue-400' },
  { code: 'WAITING_FOR_CUSTOMER', label: 'Waiting', badge: 'bg-amber-400/15 text-amber-300', dot: 'bg-amber-300' },
  { code: 'RESOLVED', label: 'Resolved', badge: 'bg-crewly-green/15 text-crewly-green', dot: 'bg-crewly-green' },
  { code: 'CLOSED', label: 'Closed', badge: 'bg-gray-500/15 text-gray-400', dot: 'bg-gray-400' },
];

export const statusMeta = (code) => STATUSES.find((s) => s.code === code) || STATUSES[0];

// statuses the backend PATCH endpoint accepts
export const HR_STATUSES = ['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'];

export const isOpen = (t) => t.status === 'OPEN' || t.status === 'IN_PROGRESS' || t.status === 'WAITING_FOR_CUSTOMER';

export const PRIORITY_LABELS = {
  LOW: 'Low priority',
  MEDIUM: 'Medium priority',
  HIGH: 'High priority',
  CRITICAL: 'Critical priority',
};

export const fmtDay = (v) =>
  new Date(v).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });

export const fmtTime = (v) =>
  new Date(v).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
