import { useEffect, useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import useAuth from "../hooks/useAuth.jsx";
import superAdminService from "../services/superAdminService.js";

const MENU = [
  {
    to: "/super-admin/dashboard",
    label: "Dashboard",
    icon: "📊",
    roles: ["ALL"],
  },
  {
    to: "/super-admin/companies",
    label: "Companies",
    icon: "🏢",
    roles: ["ALL"],
  },
  {
    to: "/super-admin/users",
    label: "Users",
    icon: "👥",
    roles: ["SUPER_ADMIN", "PLATFORM_ADMIN", "SUPPORT_ADMIN"],
  },
  {
    to: "/super-admin/subscriptions",
    label: "Subscriptions",
    icon: "🔄",
    roles: ["SUPER_ADMIN", "BILLING_ADMIN"],
  },
  {
    to: "/super-admin/plans",
    label: "Plans",
    icon: "📦",
    roles: ["SUPER_ADMIN", "BILLING_ADMIN"],
  },
  {
    to: "/super-admin/billing",
    label: "Billing",
    icon: "🧾",
    roles: ["SUPER_ADMIN", "BILLING_ADMIN"],
  },
  {
    to: "/super-admin/bgv-services",
    label: "BGV Services",
    icon: "🔍",
    roles: ["SUPER_ADMIN", "BILLING_ADMIN"],
  },
  {
    to: "/super-admin/revenue",
    label: "Revenue",
    icon: "💰",
    roles: ["SUPER_ADMIN", "BILLING_ADMIN", "PLATFORM_ADMIN"],
  },
  {
    to: "/super-admin/usage",
    label: "Usage",
    icon: "📈",
    roles: ["SUPER_ADMIN", "PLATFORM_ADMIN"],
  },
  {
    to: "/super-admin/support",
    label: "Support",
    icon: "🎫",
    roles: ["SUPER_ADMIN", "SUPPORT_ADMIN"],
  },
  {
    to: "/super-admin/system-health",
    label: "System Health",
    icon: "🩺",
    roles: ["SUPER_ADMIN", "PLATFORM_ADMIN"],
  },
  {
    to: "/super-admin/background-operations",
    label: "Background Operations",
    icon: "🗂️",
    roles: ["SUPER_ADMIN", "PLATFORM_ADMIN"],
  },
  {
    to: "/super-admin/audit-logs",
    label: "Audit Logs",
    icon: "🛡️",
    roles: ["SUPER_ADMIN", "PLATFORM_ADMIN"],
  },
  {
    to: "/super-admin/settings",
    label: "Settings",
    icon: "⚙️",
    roles: ["SUPER_ADMIN", "PLATFORM_ADMIN"],
  },
];

const SuperAdminLayout = () => {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const [mobileOpen, setMobileOpen] = useState(false);

  const [search, setSearch] = useState("");

  const [results, setResults] = useState(null);

  const [notifications, setNotifications] = useState({
    rows: [],
    unread: 0,
  });

  const [showNotifications, setShowNotifications] = useState(false);

  const [systemStatus, setSystemStatus] = useState("HEALTHY");

  const visibleMenu = MENU.filter(
    (item) => item.roles.includes("ALL") || item.roles.includes(user?.role),
  );

  useEffect(() => {
    Promise.allSettled([
      superAdminService.notifications(),
      superAdminService.health(),
    ]).then(([notificationResult, healthResult]) => {
      if (notificationResult.status === "fulfilled") {
        setNotifications(
          notificationResult.value || {
            rows: [],
            unread: 0,
          },
        );
      }

      if (healthResult.status === "fulfilled") {
        setSystemStatus(healthResult.value?.overall || "HEALTHY");
      }
    });
  }, []);

  const submitSearch = async (event) => {
    event.preventDefault();

    if (search.trim().length < 2) {
      setResults(null);
      return;
    }

    try {
      const data = await superAdminService.search(search.trim());

      setResults(data);
    } catch {
      setResults({
        error: "Search failed",
      });
    }
  };

  const handleLogout = async () => {
    try {
      await superAdminService.logout();
    } catch {
      // Local logout must still run.
    }

    logout();

    navigate("/super-admin/login", { replace: true });
  };

  const markAll = async () => {
    try {
      await superAdminService.markAllNotifications();

      setNotifications((current) => ({
        ...current,
        unread: 0,

        rows: current.rows.map((row) => ({
          ...row,
          read: true,
        })),
      }));
    } catch {
      // Notification failure is non-blocking.
    }
  };

  const sidebar = (
    <aside className="flex h-full w-64 flex-col border-r border-orange-500/20 bg-slate-950">
      <div className="border-b border-slate-800 px-5 py-5">
        <p className="text-xs font-semibold uppercase tracking-[0.25em] text-orange-400">
          Provider Portal
        </p>

        <h1 className="mt-1 text-xl font-black text-white">
          Crewly <span className="text-cyan-400">Control</span>
        </h1>
      </div>

      <nav className="flex-1 space-y-1 overflow-y-auto p-3">
        {visibleMenu.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            onClick={() => setMobileOpen(false)}
            className={({ isActive }) =>
              `flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition ${
                isActive
                  ? "bg-orange-500/15 text-orange-300"
                  : "text-slate-400 hover:bg-slate-900 hover:text-white"
              }`
            }
          >
            <span>{item.icon}</span>
            <span>{item.label}</span>
          </NavLink>
        ))}
      </nav>

      <div className="border-t border-slate-800 p-4">
        <p className="truncate text-sm font-semibold text-white">
          {user?.name || "Platform Admin"}
        </p>

        <p className="text-xs text-orange-400">
          {user?.role?.replaceAll("_", " ")}
        </p>

        <button
          type="button"
          onClick={handleLogout}
          className="mt-3 w-full rounded-lg bg-slate-900 px-3 py-2 text-left text-sm text-slate-300 hover:text-red-300"
        >
          🚪 Logout
        </button>
      </div>
    </aside>
  );

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <div className="fixed inset-y-0 left-0 z-40 hidden lg:block">
        {sidebar}
      </div>

      {mobileOpen && (
        <div className="fixed inset-0 z-50 flex lg:hidden">
          {sidebar}

          <button
            type="button"
            aria-label="Close menu"
            className="flex-1 bg-black/60"
            onClick={() => setMobileOpen(false)}
          />
        </div>
      )}

      <div className="lg:pl-64">
        <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-slate-800 bg-slate-950/95 px-4 backdrop-blur lg:px-6">
          <button
            type="button"
            className="rounded-lg border border-slate-700 px-3 py-2 lg:hidden"
            onClick={() => setMobileOpen(true)}
          >
            ☰
          </button>

          <form onSubmit={submitSearch} className="relative max-w-xl flex-1">
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search companies, users, subscriptions, tickets…"
              className="w-full rounded-lg border border-slate-700 bg-slate-900 px-4 py-2 text-sm outline-none focus:border-orange-500"
            />

            {results && (
              <div className="absolute left-0 right-0 top-11 max-h-80 overflow-auto rounded-xl border border-slate-700 bg-slate-900 p-3 shadow-2xl">
                {results.error ? (
                  <p className="text-sm text-red-300">{results.error}</p>
                ) : (
                  Object.entries(results).map(
                    ([type, rows]) =>
                      Array.isArray(rows) &&
                      rows.length > 0 && (
                        <div key={type} className="mb-3">
                          <p className="text-xs uppercase text-orange-400">
                            {type}
                          </p>

                          {rows.slice(0, 5).map((row) => (
                            <p
                              key={row._id}
                              className="mt-1 truncate text-sm text-slate-300"
                            >
                              {row.name ||
                                row.subject ||
                                row.email ||
                                row.plan ||
                                row.orderId}
                            </p>
                          ))}
                        </div>
                      ),
                  )
                )}

                <button
                  type="button"
                  onClick={() => setResults(null)}
                  className="text-xs text-slate-500"
                >
                  Close
                </button>
              </div>
            )}
          </form>

          <span
            className={`hidden rounded-full px-3 py-1 text-xs font-semibold sm:inline ${
              systemStatus === "HEALTHY"
                ? "bg-emerald-500/15 text-emerald-300"
                : systemStatus === "DOWN"
                  ? "bg-red-500/15 text-red-300"
                  : "bg-amber-500/15 text-amber-300"
            }`}
          >
            ● {systemStatus}
          </span>

          <div className="relative">
            <button
              type="button"
              onClick={() => setShowNotifications((value) => !value)}
              className="relative rounded-lg border border-slate-700 px-3 py-2"
            >
              🔔
              {notifications.unread > 0 && (
                <span className="absolute -right-1 -top-1 rounded-full bg-orange-500 px-1.5 text-[10px]">
                  {notifications.unread}
                </span>
              )}
            </button>

            {showNotifications && (
              <div className="absolute right-0 top-12 w-80 rounded-xl border border-slate-700 bg-slate-900 p-3 shadow-2xl">
                <div className="mb-2 flex justify-between">
                  <b>Platform alerts</b>

                  <button
                    type="button"
                    onClick={markAll}
                    className="text-xs text-orange-300"
                  >
                    Mark all read
                  </button>
                </div>

                <div className="max-h-72 space-y-2 overflow-auto">
                  {(notifications.rows || []).slice(0, 10).map((notice) => (
                    <div
                      key={notice._id}
                      className="rounded-lg bg-slate-800 p-2"
                    >
                      <p className="text-sm font-medium">{notice.title}</p>

                      <p className="text-xs text-slate-400">{notice.message}</p>
                    </div>
                  ))}

                  {!notifications.rows?.length && (
                    <p className="text-sm text-slate-500">
                      No platform alerts.
                    </p>
                  )}
                </div>
              </div>
            )}
          </div>

          <NavLink
            to="/super-admin/settings"
            className="hidden text-sm text-slate-300 sm:block"
          >
            {user?.name}
          </NavLink>
        </header>

        <main className="p-4 lg:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
};

export default SuperAdminLayout;
export { SuperAdminLayout };
