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
  }, []);

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
      await permissionService.saveRolePermissions(
        selectedRoleId,
        selectedPermissions,
      );

      setMessage("Role permissions updated");
      await load();
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

  const deactivateRole = async () => {
    if (!selectedRole || selectedRole.isSystemRole) return;

    const confirmed = window.confirm(`Deactivate ${selectedRole.name}?`);

    if (!confirmed) return;

    try {
      await permissionService.deactivateRole(selectedRole._id);

      setMessage("Role deactivated");
      setSelectedRoleId("");
      await load();
    } catch (error) {
      setMessage(error?.message || "Could not deactivate role");
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
                <button
                  type="button"
                  onClick={createRole}
                  disabled={busy}
                  className="text-sm text-indigo-300"
                >
                  ＋ Create
                </button>
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
    </div>
  );
};

export default RolesPermissionsPage;
