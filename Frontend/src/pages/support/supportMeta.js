// ============================================================
// 🎫 HELPDESK META — Phase 38
// HD palette sampled pixel-exact from the Figma desktop-dark
// exports (15/129/130/131/132) so the helpdesk renders like the
// design images inside the existing Crewly shell.
// ============================================================
import { Banknote, Building2, Laptop, Users, Wallet } from 'lucide-react';

// Sampled Figma dark-theme values (google_drive exports, 2026-10-12)
export const HD = {
  page: '#121828',   // canvas behind content
  panel: '#202938',  // cards / panes / sidebar in Figma
  panel2: '#192231', // inset rows, inputs, table head
  border: '#2a3444', // visible borders
  divider: '#222b3a',// hairlines between rows/panes
  green: '#16ad66',  // primary accent (pill, buttons, circles)
  greenSoft: 'rgba(22,173,102,0.12)',
  dim: '#8b94a3',    // secondary text
  text: '#ffffff',
  sent: '#f5fcfc',   // own message bubble
  sentInk: '#16202e',
  recv: '#394251',   // other side bubble
  recvInk: '#e8edf5',
  red: '#ef4444',
};

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
  { code: 'OPEN', label: 'Open', badge: 'bg-[#ffb020]/15 text-[#ffb020]' },
  { code: 'IN_PROGRESS', label: 'In progress', badge: 'bg-[#4c9aff]/15 text-[#7ab8ff]' },
  { code: 'WAITING_FOR_CUSTOMER', label: 'Waiting', badge: 'bg-[#f5d90a]/10 text-[#e8d44d]' },
  { code: 'RESOLVED', label: 'Resolved', badge: 'bg-[#16ad66]/15 text-[#3dd68c]' },
  { code: 'CLOSED', label: 'Closed', badge: 'bg-[#8b94a3]/15 text-[#8b94a3]' },
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
