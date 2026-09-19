# Figma All — HRDashboard Parity Plan (one plan)

Date: 2026-09-19
Figma: HRDashboard — HR Management Dashboard UI Kit (Community 1460297082068217556), Visual Design Light/Dark 250+ screens, green primary #00C875 (emerald #3fb950 dark). Light tokens: bg #F5F7FB card #FFFFFF border #E6E9F0 text #121826.

Goal: make every core Crewly page look like figma, not just My Attendance. Attendance already rebuilt (breadcrumb + subtitle + header pill + 4 cards + blue banner + filter bar + 9-col table). Extend same system to all.

Repo-first: inspected style.css (green #10b981 → fix to #00C875), hooks/useTheme, ThemeToggle/FigmaThemePill, AppLayout/PublicLayout/SidebarNav already theme-aware, AttendancePage figma done, Landing public SaaS polished, DashboardPage/UsersPage still old layout but now inherit light cards.

One small plan:
1) Fix tokens: style.css green exact #00C875 light / #3fb950 dark, card shadow, header blur, aside white.
2) Create shared FigmaShell: components/figma/FigmaPageShell.jsx (breadcrumb, title+Manage, header right pill, 4 metric cards with icons, 6 stats variant, banner, filter row) + FigmaCard + FigmaTable wrappers to avoid duplication.
3) Rebuild core pages in figma style keeping real data:
   - Dashboard (Home) → 4 stats + progress + recent tables
   - People / Users → employee directory with avatar, role badge, 4 cards, searchable table
   - Recruitment (candidates/interviews) → pipeline cards + table
   - Payroll (payslips/inputs) → payroll cards + table
   - Tasks/Projects → kanban-lite cards + list table
   Each keeps existing API calls (api.get, permissionService) and guard, only visual shell changes.
4) Global table min-w fix (overflow-x-auto > table min-w-[640px]) already handled — keep.
No backend changes, no map vendor, Haversine authoritative stays.

Order: tokens → shell → Dashboard → Users → Recruitment → Payroll → Tasks. Build verify after each, single commit.
