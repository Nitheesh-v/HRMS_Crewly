/* eslint-disable react-hooks/set-state-in-effect */
import { useEffect, useMemo, useState } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import {
  BarChart3,
  Bell,
  BellRing,
  Building2,
  CalendarClock,
  CalendarDays,
  CalendarOff,
  CalendarRange,
  CheckCircle2,
  ChevronDown,
  ChevronsLeft,
  ChevronsRight,
  ClipboardList,
  Clock,
  CreditCard,
  DoorOpen,
  FileText,
  Files,
  FolderOpen,
  GitBranch,
  KeyRound,
  LayoutDashboard,
  LayoutList,
  Layers,
  LifeBuoy,
  ListTodo,
  LockKeyhole,
  Megaphone,
  MessageCircle,
  Monitor,
  MoreHorizontal,
  Network,
  PartyPopper,
  ReceiptText,
  ScrollText,
  Search,
  Settings,
  ShieldCheck,
  Shuffle,
  Sparkles,
  Target,
  Timer,
  UserCircle,
  Users,
  Wallet,
} from "lucide-react";

// ── icons (moved out of AppLayout) ────────────────────────────────────────

const NAV_ICON_BY_PATH = {
  "/app": LayoutDashboard,
  "/app/meetings": CalendarDays,
  "/app/org-chart": Network,
  "/app/users": Users,
  "/app/departments": Building2,
  "/app/analytics": BarChart3,
  "/app/reports": FileText,
  "/app/attendance": Clock,
  "/app/attendance/report": BarChart3,
  "/app/leaves": CalendarOff,
  "/app/leaves/approvals": CheckCircle2,
  "/app/payroll": Wallet,
  "/app/payroll/setup": Settings,
  "/app/payroll/components": Layers,
  "/app/payroll/structures": LayoutList,
  "/app/payroll/inputs": CalendarClock,
  "/app/payslips": ReceiptText,
  "/app/holidays": PartyPopper,
  "/app/shifts": Shuffle,
  "/app/schedules": CalendarRange,
  "/app/announcements": Megaphone,
  "/app/documents": FileText,
  "/app/employee-files": Files,
  "/app/lifecycle": GitBranch,
  "/app/performance": Target,
  "/app/expenses": Wallet,
  "/app/assets": Monitor,
  "/app/projects": FolderOpen,
  "/app/tasks": ListTodo,
  "/app/recruitment": ClipboardList,
  "/app/recruitment/requisitions": ClipboardList,
  "/app/recruitment/candidates": Users,
  "/app/recruitment/interviews": CalendarClock,
  "/app/recruitment/my-interviews": CalendarClock,
  "/app/recruitment/pre-onboarding": ClipboardList,
  "/app/support": LifeBuoy,
  "/app/exit": DoorOpen,
  "/app/company": Settings,
  "/app/billing": CreditCard,
  "/app/subscription": CreditCard,
  "/app/governance": ShieldCheck,
  "/app/roles-permissions": KeyRound,
  "/app/profile": UserCircle,
  "/app/notifications": Bell,
  "/app/notification-settings": BellRing,
  "/app/security/sessions": LockKeyhole,
  "/app/security": ShieldCheck,
  "/app/audit-logs": ScrollText,
  "/app/security/settings": Settings,
};

/*
 * Removes the existing emoji prefix from labels.
 * Example: "🏠 Dashboard" becomes "Dashboard".
 */
const cleanNavLabel = (label = "") =>
  String(label).replace(/^[^A-Za-z0-9]+/, "").trim();

const getSoonIcon = (label = "") => {
  const cleanLabel = cleanNavLabel(label);

  if (cleanLabel.includes("Celebrations")) return PartyPopper;
  if (cleanLabel.includes("Chat")) return MessageCircle;
  if (cleanLabel.includes("Time Tracking")) return Timer;
  if (cleanLabel.includes("Daily Reports")) return BarChart3;
  if (cleanLabel.includes("Employee Records")) return Files;

  return Sparkles;
};

const getNavIcon = (item) =>
  NAV_ICON_BY_PATH[item.to] || getSoonIcon(item.label);

// ── groups ───────────────────────────────────────────────────────────────
//
// The flat sidebar reached 35+ rows, so every page now belongs to a group.
// `paths` are exact matches, `prefixes` fold whole areas (recruitment,
// security, payroll, projects/:id) into one entry.

const NAV_GROUPS = [
  { id: "home", label: "Home", icon: LayoutDashboard, paths: ["/app"] },

  {
    id: "people",
    label: "People",
    icon: Users,
    paths: [
      "/app/users",
      "/app/departments",
      "/app/org-chart",
      "/app/employee-files",
      "/app/lifecycle",
      "/app/performance",
      "/app/documents",
      "/app/assets",
    ],
  },

  {
    id: "time",
    label: "Time & Leave",
    icon: Clock,
    paths: ["/app/shifts", "/app/schedules", "/app/holidays"],
    prefixes: ["/app/attendance", "/app/leaves"],
  },

  {
    id: "payroll",
    label: "Payroll",
    icon: Wallet,
    // Pinned pages first: Payroll, Employee Payroll, Payslips, then the 29.1
    // configuration screens.
    paths: ["/app/payroll", "/app/payroll/employees", "/app/payslips"],
    prefixes: ["/app/payroll"],
  },

  {
    id: "recruitment",
    label: "Recruitment",
    icon: ClipboardList,
    paths: ["/app/recruitment"],
    prefixes: ["/app/recruitment"],
  },

  {
    id: "work",
    label: "Work",
    icon: FolderOpen,
    paths: ["/app/tasks", "/app/meetings", "/app/announcements"],
    prefixes: ["/app/projects"],
  },

  {
    id: "insights",
    label: "Insights",
    icon: BarChart3,
    paths: ["/app/analytics", "/app/reports"],
  },

  {
    id: "me",
    label: "Me",
    icon: UserCircle,
    paths: ["/app/profile", "/app/notifications", "/app/notification-settings"],
  },

  // ── behind "More"
  {
    id: "finance",
    label: "Finance",
    icon: CreditCard,
    paths: ["/app/expenses", "/app/billing", "/app/subscription"],
    more: true,
  },

  {
    id: "admin",
    label: "Administration",
    icon: ShieldCheck,
    paths: ["/app/company", "/app/governance", "/app/roles-permissions", "/app/support", "/app/exit"],
    prefixes: ["/app/security", "/app/audit-logs"],
    more: true,
  },
];

const PRIMARY_GROUPS = NAV_GROUPS.filter((group) => !group.more);
const MORE_GROUPS = NAV_GROUPS.filter((group) => group.more);

const matchesGroup = (group, to) => {
  if (!to) return false;
  if ((group.paths || []).includes(to)) return true;
  return (group.prefixes || []).some(
    (prefix) => to === prefix || to.startsWith(`${prefix}/`),
  );
};

const groupMenu = (items = []) => {
  const buckets = new Map(NAV_GROUPS.map((group) => [group.id, []]));
  const other = [];
  const groupOfPath = new Map();

  items.forEach((item) => {
    const group = NAV_GROUPS.find((candidate) => matchesGroup(candidate, item.to));
    if (group) {
      buckets.get(group.id).push(item);
      if (item.to) groupOfPath.set(item.to, group.id);
    } else {
      other.push(item);
    }
  });

  return { buckets, other, groupOfPath };
};

const itemClass = ({ isActive }) =>
  `flex items-center gap-2.5 rounded-lg py-2 pl-8 pr-3 text-[13px] transition ${
    isActive
      ? "bg-crewly-green/10 text-crewly-green"
      : "text-crewly-dim hover:bg-crewly-bg hover:text-crewly-text"
  }`;

const singleClass = ({ isActive }) =>
  `flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition ${
    isActive
      ? "bg-crewly-green/10 text-crewly-green"
      : "text-crewly-dim hover:bg-crewly-bg hover:text-crewly-text"
  }`;

const headerClass = (active) =>
  `flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition ${
    active
      ? "text-crewly-text"
      : "text-crewly-dim hover:bg-crewly-bg hover:text-crewly-text"
  }`;

const Sidebar = ({ menu = [] }) => {
  const location = useLocation();
  const navigate = useNavigate();

  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem("crewly.sidebar.collapsed") === "true",
  );
  const [query, setQuery] = useState("");
  const [openGroup, setOpenGroup] = useState(null);
  const [moreOpen, setMoreOpen] = useState(false);

  const { buckets, other, groupOfPath } = useMemo(() => groupMenu(menu), [menu]);

  // Which group owns the page we are on — it opens itself on navigation.
  const activeGroupId = useMemo(() => {
    if (groupOfPath.has(location.pathname)) {
      return groupOfPath.get(location.pathname);
    }

    const byPrefix = NAV_GROUPS.find(
      (group) => group.id !== "home" && matchesGroup(group, location.pathname),
    );

    return byPrefix?.id || null;
  }, [groupOfPath, location.pathname]);

  useEffect(() => {
    if (!activeGroupId) return;

    setOpenGroup(activeGroupId);
    if (NAV_GROUPS.find((group) => group.id === activeGroupId)?.more) {
      setMoreOpen(true);
    }
  }, [activeGroupId]);

  useEffect(() => {
    localStorage.setItem("crewly.sidebar.collapsed", String(collapsed));
  }, [collapsed]);

  // A search is a one-shot jump: following a result clears it.
  useEffect(() => {
    setQuery("");
  }, [location.pathname]);

  const searching = query.trim().length > 0;

  const results = useMemo(() => {
    if (!searching) return [];

    const needle = query.trim().toLowerCase();

    return menu
      .map((item) => ({ item, label: cleanNavLabel(item.label) }))
      .filter(({ label }) => label.toLowerCase().includes(needle))
      .slice(0, 40);
  }, [menu, query, searching]);

  const renderItem = (item) => {
    const Icon = getNavIcon(item);
    const label = cleanNavLabel(item.label);
    const key = `${item.to || "soon"}-${label}`;

    if (item.soon) {
      return (
        <span
          key={key}
          title="Coming in an upcoming phase"
          className="flex cursor-not-allowed items-center gap-2.5 rounded-lg py-2 pl-8 pr-3 text-[13px] text-crewly-dim/40"
        >
          <Icon aria-hidden="true" className="h-4 w-4 shrink-0" strokeWidth={1.8} />
          <span className="min-w-0 flex-1 truncate">{label}</span>
          <span className="text-[10px]">soon</span>
        </span>
      );
    }

    return (
      <NavLink key={key} to={item.to} end={item.end} className={itemClass}>
        <Icon aria-hidden="true" className="h-4 w-4 shrink-0" strokeWidth={1.8} />
        <span className="min-w-0 flex-1 truncate">{label}</span>
      </NavLink>
    );
  };

  const renderGroup = (group) => {
    const items = buckets.get(group.id) || [];
    if (!items.length) return null;

    const GroupIcon = group.icon;
    const isOpen = openGroup === group.id;
    const active = activeGroupId === group.id;

    // A group with a single page is just the page.
    if (items.length === 1 && !items[0].soon) {
      const only = items[0];
      const Icon = getNavIcon(only);

      return (
        <NavLink key={group.id} to={only.to} end={only.end} className={singleClass}>
          <Icon aria-hidden="true" className="h-[17px] w-[17px] shrink-0" strokeWidth={1.8} />
          <span className="min-w-0 flex-1 truncate">{cleanNavLabel(only.label)}</span>
        </NavLink>
      );
    }

    return (
      <div key={group.id}>
        <button
          type="button"
          onClick={() => setOpenGroup(isOpen ? null : group.id)}
          className={headerClass(active)}
          aria-expanded={isOpen}
          title={group.label}
        >
          <GroupIcon aria-hidden="true" className="h-[17px] w-[17px] shrink-0" strokeWidth={1.8} />
          <span className="min-w-0 flex-1 truncate text-left">{group.label}</span>
          <span className="text-[10px] text-crewly-dim/70">{items.length}</span>
          <ChevronDown
            aria-hidden="true"
            className={`h-3.5 w-3.5 shrink-0 transition ${isOpen ? "rotate-180" : ""}`}
          />
        </button>

        {isOpen && <div className="mt-0.5 space-y-0.5">{items.map(renderItem)}</div>}
      </div>
    );
  };

  const renderCollapsed = () => (
    <div className="space-y-1">
      {NAV_GROUPS.filter((group) => (buckets.get(group.id) || []).length).map((group) => {
        const Icon = group.icon;
        const items = buckets.get(group.id) || [];
        const single = items.length === 1 && !items[0].soon ? items[0] : null;

        return (
          <button
            key={group.id}
            type="button"
            title={group.label}
            onClick={() => {
              setCollapsed(false);
              setOpenGroup(group.id);
              if (group.more) setMoreOpen(true);
              // A one-page group (Home) is a destination, not a dropdown.
              if (single) navigate(single.to);
            }}
            className={`flex h-10 w-full items-center justify-center rounded-lg transition ${
              activeGroupId === group.id
                ? "bg-crewly-green/10 text-crewly-green"
                : "text-crewly-dim hover:bg-crewly-bg hover:text-crewly-text"
            }`}
          >
            <Icon aria-hidden="true" className="h-[18px] w-[18px]" strokeWidth={1.8} />
          </button>
        );
      })}
    </div>
  );

  return (
    <aside
      className={`sticky top-0 flex h-screen shrink-0 flex-col border-r border-crewly-border bg-crewly-card py-5 transition-[width] duration-150 ${
        collapsed ? "w-16 px-2" : "w-60 px-3"
      }`}
    >
      <div className="flex items-center justify-between gap-2 px-1">
        {collapsed ? (
          <button
            type="button"
            title="Expand sidebar"
            onClick={() => setCollapsed(false)}
            className="mx-auto text-lg font-extrabold tracking-wide text-crewly-green"
          >
            C
          </button>
        ) : (
          <>
            <div className="text-lg font-extrabold tracking-wide text-crewly-green">
              Crewly <span className="text-crewly-orange">HRMS</span>
            </div>

            <button
              type="button"
              onClick={() => setCollapsed(true)}
              title="Collapse sidebar"
              className="rounded p-1 text-crewly-dim hover:bg-crewly-bg hover:text-crewly-text"
            >
              <ChevronsLeft aria-hidden="true" className="h-4 w-4" />
            </button>
          </>
        )}
      </div>

      {collapsed ? (
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          title="Search pages"
          className="mt-4 flex h-9 w-full items-center justify-center rounded-lg text-crewly-dim hover:bg-crewly-bg hover:text-crewly-text"
        >
          <Search aria-hidden="true" className="h-4 w-4" />
        </button>
      ) : (
        <div className="relative mt-4">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-crewly-dim/60"
          />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search pages"
            className="input w-full py-2 pl-9 pr-3 text-[13px]"
          />
        </div>
      )}

      <nav className="mt-3 flex-1 space-y-1 overflow-y-auto pr-0.5">
        {collapsed ? (
          renderCollapsed()
        ) : searching ? (
          results.length === 0 ? (
            <p className="px-3 py-2 text-xs text-crewly-dim">
              No page matches “{query.trim()}”
            </p>
          ) : (
            <div className="space-y-0.5">
              {results.map(({ item, label }) => {
                const Icon = getNavIcon(item);
                const key = `${item.to || "soon"}-${label}`;

                if (item.soon) {
                  return (
                    <span
                      key={key}
                      className="flex cursor-not-allowed items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] text-crewly-dim/40"
                    >
                      <Icon aria-hidden="true" className="h-4 w-4 shrink-0" strokeWidth={1.8} />
                      <span className="min-w-0 flex-1 truncate">{label}</span>
                      <span className="text-[10px]">soon</span>
                    </span>
                  );
                }

                return (
                  <NavLink key={key} to={item.to} end={item.end} className={singleClass}>
                    <Icon aria-hidden="true" className="h-4 w-4 shrink-0" strokeWidth={1.8} />
                    <span className="min-w-0 flex-1 truncate">{label}</span>
                  </NavLink>
                );
              })}
            </div>
          )
        ) : (
          <>
            {PRIMARY_GROUPS.map(renderGroup)}

            {(MORE_GROUPS.some((group) => (buckets.get(group.id) || []).length) ||
              other.length > 0) && (
              <div>
                <button
                  type="button"
                  onClick={() => setMoreOpen((prev) => !prev)}
                  className={headerClass(false)}
                  aria-expanded={moreOpen}
                >
                  <MoreHorizontal
                    aria-hidden="true"
                    className="h-[17px] w-[17px] shrink-0"
                    strokeWidth={1.8}
                  />
                  <span className="min-w-0 flex-1 truncate text-left">More</span>
                  <ChevronDown
                    aria-hidden="true"
                    className={`h-3.5 w-3.5 shrink-0 transition ${moreOpen ? "rotate-180" : ""}`}
                  />
                </button>

                {moreOpen && (
                  <div className="mt-1 space-y-1">
                    {MORE_GROUPS.map(renderGroup)}

                    {other.length > 0 && (
                      <div>
                        <p className="px-3 pb-1 pt-2 text-[10px] uppercase tracking-wide text-crewly-dim/60">
                          Other
                        </p>
                        {other.map(renderItem)}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </nav>

      <div className="flex items-center justify-between pt-3 text-[11px] text-crewly-dim/60">
        {collapsed ? (
          <button
            type="button"
            onClick={() => setCollapsed(false)}
            title="Expand sidebar"
            className="mx-auto rounded p-1 hover:bg-crewly-bg hover:text-crewly-text"
          >
            <ChevronsRight aria-hidden="true" className="h-4 w-4" />
          </button>
        ) : (
          <span>Crewly HRMS · Phase 29</span>
        )}
      </div>
    </aside>
  );
};

export default Sidebar;
