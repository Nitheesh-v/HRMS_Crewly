/* eslint-disable react-hooks/set-state-in-effect, react-hooks/exhaustive-deps */

import { useEffect, useMemo, useState } from "react";
import permissionService from "../../services/permissionService.js";
import usePermission from "../../hooks/usePermission.js";
import Can from "../../components/Can.jsx";
import { Save } from "lucide-react";

const panel = "rounded-xl border border-slate-700 bg-slate-900 p-4";

const inp =
  "rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-indigo-500";

const btn =
  "rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50";

const RolesPermissionsPage = () => {
  const { refreshPermissions } = usePermission();

  const [tab, setTab] = useState("roles");
  const [roles, setRoles] = useState([]);
  const [groups, setGroups] = useState({});
  const [users, setUsers] = useState([]);

  const [selectedRoleId, setSelectedRoleId] = useState("");

  const [selectedPermissions, setSelectedPermissions] = useState([]);

  const [selectedUserId, setSelectedUserId] = useState("");

  const [userPermissionData, setUserPermissionData] = useState(null);

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [templates, setTemplates] = useState([]);
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);

  const selectedRole = useMemo(
    () => roles.find((role) => role._id === selectedRoleId) || null,
    [roles, selectedRoleId],
  );

  const selectedUser = useMemo(
    () => users.find((user) => user._id === selectedUserId) || null,
    [users, selectedUserId],
  );

  const allPermissions = useMemo(() => Object.values(groups).flat(), [groups]);

  const availablePermissionIds = useMemo(
    () =>
      allPermissions
        .filter((permission) => permission.available)
        .map((permission) => permission._id),
    [allPermissions],
  );

  const normalizeUsers = (response) => {
    if (Array.isArray(response)) return response;
    if (Array.isArray(response?.users)) return response.users;
    if (Array.isArray(response?.rows)) return response.rows;
    if (Array.isArray(response?.data)) return response.data;
    return [];
  };

  const loadUsers = async () => {
    try {
      const response = await permissionService.users();
      setUsers(normalizeUsers(response));
    } catch (error) {
      setMessage(error?.message || "Could not load users");
    }
  };

  const selectRole = (role) => {
    setSelectedRoleId(role._id);

    setSelectedPermissions(
      (role.permissions || []).map((permission) => permission._id),
    );
  };

  const load = async () => {
    setLoading(true);
    setMessage("");

    try {
      const [roleRows, permissionData] = await Promise.all([
        permissionService.roles(),
        permissionService.permissions(),
      ]);

      const normalizedRoles = Array.isArray(roleRows)
        ? roleRows
        : Array.isArray(roleRows?.rows)
          ? roleRows.rows
          : [];

      setRoles(normalizedRoles);
      setGroups(permissionData?.groups || {});

      if (normalizedRoles.length) {
        const currentRole =
          normalizedRoles.find((role) => role._id === selectedRoleId) ||
          normalizedRoles[0];

        selectRole(currentRole);
      }
    } catch (error) {
      setMessage(error?.message || "Could not load roles and permissions");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    loadUsers();
    loadTemplates();
  }, []);

  const loadTemplates = async () => {
    try {
      const data = await permissionService.roleTemplates();
      setTemplates(data?.templates || []);
    } catch {
      setTemplates([]);
    }
  };

  const togglePermission = (permissionId) => {
    setSelectedPermissions((current) =>
      current.includes(permissionId)
        ? current.filter((id) => id !== permissionId)
        : [...current, permissionId],
    );
  };

  const saveRolePermissions = async () => {
    if (!selectedRoleId) return;

    setBusy(true);
    setMessage("");

    try {
      const updatedRole =
        await permissionService.saveRolePermissions(
          selectedRoleId,
          selectedPermissions,
        );

      setRoles((current) =>
        current.map((role) =>
          role._id === updatedRole._id
            ? updatedRole
            : role,
        ),
      );
      selectRole(updatedRole);
      setMessage("Role permissions updated successfully");
      await refreshPermissions();
    } catch (error) {
      setMessage(error?.message || "Could not save permissions");
    } finally {
      setBusy(false);
    }
  };

  const createRole = async () => {
    const name = window.prompt("Custom role name");

    if (!name?.trim()) return;

    const description = window.prompt("Role description", "") || "";

    setBusy(true);
    setMessage("");

    try {
      const role = await permissionService.createRole({
        name: name.trim(),
        description,
        permissions: [],
      });

      setMessage("Custom role created");
      await load();
      selectRole(role);
    } catch (error) {
      setMessage(error?.message || "Could not create role");
    } finally {
      setBusy(false);
    }
  };

  // Phase 29.1 RBAC update — create a role from a payroll role template.
  // Templates are opt-in: nothing is seeded into the company until an
  // administrator picks one here.
  const createRoleFromTemplate = async (template) => {
    setBusy(true);
    setMessage("");

    try {
      const role = await permissionService.createRole({
        name: template.name,
        description: template.description,
        template: template.key,
        permissions: template.permissions,
      });

      setTemplatePickerOpen(false);
      setMessage(
        `${template.name} role created — review its permissions and assign users.`,
      );
      await load();
      selectRole(role);
    } catch (error) {
      setMessage(error?.message || "Could not create role from template");
    } finally {
      setBusy(false);
    }
  };

  const duplicateRole = async () => {
    if (!selectedRole) return;

    const name = window.prompt("New role name", `${selectedRole.name} Copy`);

    if (!name?.trim()) return;

    try {
      await permissionService.duplicateRole(selectedRole._id, {
        name: name.trim(),
      });

      setMessage("Role duplicated");
      await load();
    } catch (error) {
      setMessage(error?.message || "Could not duplicate role");
    }
  };

  // A role people still hold cannot simply be switched off: their
  // permissions resolve through it. Offer to move them out in one step
  // instead of dead-ending on a 409.
  const deactivateRole = async (reassignTo = "") => {
    if (!selectedRole || selectedRole.isSystemRole) return;

    const members = Number(selectedRole.memberCount || 0);

    if (members > 0 && !reassignTo) {
      const target = window.prompt(
        `${members} user(s) still hold ${selectedRole.name}.\n` +
          `Move them to which role, then deactivate? (default: EMPLOYEE)`,
        "EMPLOYEE"
      );

      if (target === null) return;

      const code = String(target || "").trim() || "EMPLOYEE";

      const okToMove = window.confirm(
        `Move ${members} user(s) to ${code} and deactivate ${selectedRole.name}?`
      );

      if (!okToMove) return;

      return deactivateRole(code);
    }

    const confirmed = window.confirm(
      members > 0
        ? `Move ${members} user(s) to ${reassignTo} and deactivate ${selectedRole.name}?`
        : `Deactivate ${selectedRole.name}?`
    );

    if (!confirmed) return;

    try {
      const payload = reassignTo ? { reassignTo } : {};

      await permissionService.deactivateRole(selectedRole._id, payload);

      setMessage(
        members > 0
          ? `Role deactivated — ${members} user(s) moved to ${reassignTo}`
          : "Role deactivated"
      );

      setSelectedRoleId("");
      await load();
    } catch (error) {
      const details = error?.data?.data || error?.data || {};
      const who = Array.isArray(details.members) ? details.members : [];

      const names = who
        .slice(0, 3)
        .map((member) => member.name || member.email)
        .filter(Boolean)
        .join(", ");

      setMessage(
        [
          error?.message || "Could not deactivate role",
          details.assignedUsers ? ` (${details.assignedUsers} user(s)${names ? `: ${names}${details.assignedUsers > 3 ? "…" : ""}` : ""})` : "",
          Array.isArray(details.reassignOptions) && details.reassignOptions.length
            ? ` Move them first: Users → edit user → Role (options: ${details.reassignOptions.join(", ")})`
            : "",
        ].join("")
      );
    }
  };

  const loadUserPermissions = async (userId) => {
    setSelectedUserId(userId);

    if (!userId) {
      setUserPermissionData(null);
      return;
    }

    try {
      const result = await permissionService.userPermissions(userId);

      setUserPermissionData(result);
    } catch (error) {
      setMessage(error?.message || "Could not load user permissions");
    }
  };

  const assignRole = async (roleId) => {
    if (!selectedUserId || !roleId) return;

    try {
      await permissionService.assignUserRole(selectedUserId, roleId);

      setMessage("User role updated");

      await loadUserPermissions(selectedUserId);
      await loadUsers();
    } catch (error) {
      setMessage(error?.message || "Could not assign role");
    }
  };

  const findOverride = (permissionId) =>
    (userPermissionData?.overrides || []).find(
      (override) =>
        String(override.permission?._id || override.permission) ===
        String(permissionId),
    );

  const setOverride = (permissionId, effect) => {
    setUserPermissionData((current) => {
      if (!current) return current;

      const remaining = (current.overrides || []).filter(
        (override) =>
          String(override.permission?._id || override.permission) !==
          String(permissionId),
      );

      if (!effect) {
        return {
          ...current,
          overrides: remaining,
        };
      }

      return {
        ...current,
        overrides: [
          ...remaining,
          {
            permission: permissionId,
            effect,
            reason: "Company permission override",
          },
        ],
      };
    });
  };

  const saveOverrides = async () => {
    if (!selectedUserId || !userPermissionData) return;

    const overrides = (userPermissionData.overrides || []).map((override) => ({
      permission: override.permission?._id || override.permission,
      effect: override.effect,
      reason: override.reason || "",
    }));

    try {
      await permissionService.saveUserOverrides(selectedUserId, overrides);

      setMessage("User permission overrides saved");

      await loadUserPermissions(selectedUserId);
    } catch (error) {
      setMessage(error?.message || "Could not save overrides");
    }
  };

  if (loading) {
    return (
      <div className="p-6 text-slate-400">Loading roles and permissions…</div>
    );
  }

  return (
    <div className="space-y-5 p-6 text-slate-100">
      <div>
        <h1 className="text-2xl font-bold">🛡️ Roles & Permissions</h1>

        <p className="text-sm text-slate-400">
          Configure company roles, permission matrices and user-specific
          overrides.
        </p>
      </div>

      {message && (
        <div className="rounded-lg border border-indigo-500/40 bg-indigo-500/10 px-4 py-3 text-sm text-indigo-200">
          {message}
        </div>
      )}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => setTab("roles")}
          className={tab === "roles" ? btn : inp}
        >
          Roles
        </button>

        <button
          type="button"
          onClick={() => setTab("users")}
          className={tab === "users" ? btn : inp}
        >
          User Assignments
        </button>
      </div>

      {tab === "roles" && (
        <div className="grid gap-4 xl:grid-cols-[280px_1fr]">
          <aside className={panel}>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="font-semibold">Roles</h2>

              <Can permission="SETTINGS_MANAGE">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setTemplatePickerOpen(true)}
                    disabled={busy}
                    className="text-sm text-indigo-300"
                  >
                    ＋ Template
                  </button>
                  <button
                    type="button"
                    onClick={createRole}
                    disabled={busy}
                    className="text-sm text-indigo-300"
                  >
                    ＋ Blank
                  </button>
                </div>
              </Can>
            </div>

            <div className="space-y-1">
              {roles.map((role) => (
                <button
                  type="button"
                  key={role._id}
                  onClick={() => selectRole(role)}
                  className={`w-full rounded-lg px-3 py-2 text-left text-sm ${
                    selectedRoleId === role._id
                      ? "bg-indigo-600 text-white"
                      : "bg-slate-800 text-slate-300"
                  }`}
                >
                  <span className="font-medium">{role.name}</span>

                  <small className="block text-xs opacity-70">
                    {role.isSystemRole
                      ? "Protected system role"
                      : "Custom role"}
                  </small>
                </button>
              ))}
            </div>
          </aside>

          <section className="space-y-4">
            {!selectedRole ? (
              <div className={panel}>Select a role.</div>
            ) : (
              <>
                <div className={panel}>
                  <div className="flex flex-wrap justify-between gap-3">
                    <div>
                      <h2 className="text-lg font-bold">{selectedRole.name}</h2>

                      <p className="text-sm text-slate-400">
                        {selectedRole.description}
                      </p>

                      <p className="mt-1 text-xs text-slate-500">
                        {Number(selectedRole.memberCount || 0)} user(s) hold
                        this role
                        {Number(selectedRole.memberCount || 0) > 0
                          ? " — they are moved to another role before it can be deactivated"
                          : ""}
                      </p>
                    </div>

                    <Can permission="SETTINGS_MANAGE">
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={duplicateRole}
                          className={inp}
                        >
                          Duplicate
                        </button>

                        {!selectedRole.isSystemRole && (
                          <button
                            type="button"
                            onClick={deactivateRole}
                            className="rounded-lg bg-red-500/15 px-3 py-2 text-sm text-red-300"
                          >
                            Deactivate
                          </button>
                        )}
                      </div>
                    </Can>
                  </div>
                </div>

                <div className={panel}>
                  <div className="sticky top-0 z-20 -mx-4 -mt-4 mb-4 flex flex-wrap items-center justify-between gap-3 rounded-t-xl border-b border-slate-700 bg-slate-900/95 p-4 backdrop-blur">
                    <div>
                      <h2 className="font-semibold">Permission Matrix</h2>
                      <p className="text-xs text-slate-500">
                        {selectedPermissions.length} permissions selected
                      </p>
                      {message && (
                        <p className="mt-1 text-xs text-indigo-300">
                          {message}
                        </p>
                      )}
                    </div>

                    <Can permission="SETTINGS_MANAGE">
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={() =>
                            setSelectedPermissions(availablePermissionIds)
                          }
                          className={inp}
                        >
                          Select All
                        </button>

                        <button
                          type="button"
                          onClick={() => setSelectedPermissions([])}
                          className={inp}
                        >
                          Clear All
                        </button>

                        <button
                          type="button"
                          disabled={busy}
                          onClick={saveRolePermissions}
                          className={`${btn} gap-2`}
                        >
                          <Save className="h-4 w-4" />
                          {busy ? "Saving…" : "Save Permissions"}
                        </button>
                      </div>
                    </Can>
                  </div>

                  <div className="space-y-5">
                    {Object.entries(groups).map(([group, permissions]) => (
                      <div key={group}>
                        <h3 className="mb-2 text-xs font-bold uppercase tracking-wide text-indigo-300">
                          {group.replaceAll("_", " ")}
                        </h3>

                        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                          {permissions.map((permission) => (
                            <label
                              key={permission._id}
                              className={`flex items-start gap-2 rounded-lg border p-3 text-sm ${
                                permission.available
                                  ? "border-slate-700 bg-slate-800"
                                  : "cursor-not-allowed border-slate-800 bg-slate-950 opacity-50"
                              }`}
                            >
                              <input
                                type="checkbox"
                                disabled={!permission.available}
                                checked={selectedPermissions.includes(
                                  permission._id,
                                )}
                                onChange={() =>
                                  togglePermission(permission._id)
                                }
                              />

                              <span>
                                <b>{permission.action}</b>

                                <small className="block text-slate-500">
                                  {permission.description}

                                  {permission.scope !== "ALL" &&
                                    ` · ${permission.scope}`}
                                </small>

                                {!permission.available && (
                                  <small className="text-amber-400">
                                    Upgrade required
                                  </small>
                                )}
                              </span>
                            </label>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>

                </div>
              </>
            )}
          </section>
        </div>
      )}

      {tab === "users" && (
        <div className="grid gap-4 xl:grid-cols-[320px_1fr]">
          <aside className={panel}>
            <h2 className="mb-3 font-semibold">Users</h2>

            <select
              className={`${inp} w-full`}
              value={selectedUserId}
              onChange={(event) => loadUserPermissions(event.target.value)}
            >
              <option value="">Select user</option>

              {users
                .filter((companyUser) => companyUser.role !== "COMPANY_ADMIN")
                .map((companyUser) => (
                  <option key={companyUser._id} value={companyUser._id}>
                    {companyUser.name} · {companyUser.role}
                  </option>
                ))}
            </select>

            {selectedUser && (
              <div className="mt-4">
                <label className="mb-1 block text-xs text-slate-500">
                  Company Role
                </label>

                <select
                  className={`${inp} w-full`}
                  value={
                    userPermissionData?.user?.roleRef?._id ||
                    userPermissionData?.user?.roleRef ||
                    ""
                  }
                  onChange={(event) => assignRole(event.target.value)}
                >
                  <option value="">Select role</option>

                  {roles
                    .filter((role) => role.isActive)
                    .map((role) => (
                      <option key={role._id} value={role._id}>
                        {role.name}
                      </option>
                    ))}
                </select>
              </div>
            )}
          </aside>

          <section className={panel}>
            {!userPermissionData ? (
              <p className="text-slate-500">
                Select a user to manage role and permission overrides.
              </p>
            ) : (
              <>
                <h2 className="font-semibold">
                  Overrides for {userPermissionData.user.name}
                </h2>

                <p className="mb-4 text-sm text-slate-500">
                  Explicit DENY overrides both ALLOW and role permissions.
                </p>

                <div className="space-y-4">
                  {Object.entries(groups).map(([group, permissions]) => (
                    <div key={group}>
                      <h3 className="mb-2 text-xs font-bold uppercase text-indigo-300">
                        {group.replaceAll("_", " ")}
                      </h3>

                      <div className="grid gap-2 md:grid-cols-2">
                        {permissions.map((permission) => {
                          const override = findOverride(permission._id);

                          return (
                            <div
                              key={permission._id}
                              className="flex items-center justify-between gap-2 rounded-lg bg-slate-800 p-2 text-sm"
                            >
                              <span>{permission.name}</span>

                              <select
                                className={inp}
                                value={override?.effect || ""}
                                disabled={!permission.available}
                                onChange={(event) =>
                                  setOverride(
                                    permission._id,
                                    event.target.value,
                                  )
                                }
                              >
                                <option value="">Inherit</option>
                                <option value="ALLOW">Allow</option>
                                <option value="DENY">Deny</option>
                              </select>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>

                <Can permission="USER_UPDATE">
                  <button
                    type="button"
                    onClick={saveOverrides}
                    className={`${btn} mt-5`}
                  >
                    Save User Overrides
                  </button>
                </Can>
              </>
            )}
          </section>
        </div>
      )}

      {/* Phase 29.1 RBAC update — payroll role templates (opt-in, never seeded) */}
      {templatePickerOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4"
          onClick={() => setTemplatePickerOpen(false)}
        >
          <div
            className={`${panel} max-h-[92vh] w-full max-w-2xl overflow-y-auto`}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h2 className="text-lg font-semibold">Create role from template</h2>
                <p className="mt-1 text-xs text-slate-400">
                  Payroll is controlled by permissions, not by the Company Admin role.
                  Pick a template to delegate payroll work to HR, Payroll or Finance —
                  you can edit every permission afterwards.
                </p>
              </div>
              <button
                onClick={() => setTemplatePickerOpen(false)}
                className="text-slate-400 hover:text-slate-100"
              >
                ✕
              </button>
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              {templates.map((template) => (
                <button
                  key={template.key}
                  type="button"
                  disabled={busy}
                  onClick={() => createRoleFromTemplate(template)}
                  className="rounded-lg border border-slate-700 bg-slate-950 p-4 text-left transition hover:border-indigo-500 disabled:opacity-50"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-slate-100">{template.name}</span>
                    <span className="rounded-full bg-slate-800 px-2 py-0.5 text-[10px] uppercase text-slate-300">
                      {String(template.defaultScope || "").replace(/_/g, " ")}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-slate-400">{template.description}</p>
                  <p className="mt-2 text-[11px] text-slate-500">
                    {template.permissions.length} permissions
                    {template.separationException
                      ? " · concentrates approval + payment duties"
                      : " · separation of duties built in"}
                  </p>
                </button>
              ))}

              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setTemplatePickerOpen(false);
                  createRole();
                }}
                className="rounded-lg border border-dashed border-slate-700 bg-slate-950 p-4 text-left transition hover:border-indigo-500"
              >
                <span className="font-semibold text-slate-100">Blank role</span>
                <p className="mt-1 text-xs text-slate-400">
                  Start with no permissions and pick exactly what this role needs.
                </p>
              </button>
            </div>

            {templates.length === 0 && (
              <p className="mt-3 text-xs text-slate-400">
                No templates available on your current subscription plan.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default RolesPermissionsPage;
