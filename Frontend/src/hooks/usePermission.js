import {
  useCallback,
  useMemo,
} from "react";
import {
  useSelector,
} from "react-redux";

const permissionKey = (value) => {
  if (!value) return "";

  if (typeof value === "string") {
    return value
      .trim()
      .toUpperCase();
  }

  const key =
    value.key ||
    value.code ||
    value.permission ||
    value.name ||
    "";

  return String(key)
    .trim()
    .toUpperCase();
};

const normalizePermissions = (
  values,
) => {
  if (!Array.isArray(values)) {
    return [];
  }

  return values
    .map(permissionKey)
    .filter(Boolean);
};

const flattenPermissions = (
  values,
) =>
  values
    .flat(Infinity)
    .map(permissionKey)
    .filter(Boolean);

const usePermission = () => {
  /*
   * Primary Redux key: state.permissions
   * Singular fallback supports older local stores.
   */
  const permissionState =
    useSelector(
      (state) =>
        state.permissions ||
        state.permission ||
        {},
    );

  const role =
    permissionState.role ||
    null;

  const permissions =
    useMemo(
      () =>
        normalizePermissions(
          permissionState.permissions,
        ),
      [
        permissionState.permissions,
      ],
    );

  const deniedPermissions =
    useMemo(
      () =>
        normalizePermissions(
          permissionState.deniedPermissions,
        ),
      [
        permissionState.deniedPermissions,
      ],
    );

  const grantedSet =
    useMemo(
      () =>
        new Set(permissions),
      [permissions],
    );

  const deniedSet =
    useMemo(
      () =>
        new Set(
          deniedPermissions,
        ),
      [deniedPermissions],
    );

  /*
   * Explicit DENY always wins.
   * The backend already calculates effective role,
   * custom-role and user-override permissions.
   */
  const hasPermission =
    useCallback(
      (permission) => {
        const key =
          permissionKey(
            permission,
          );

        if (!key) {
          return false;
        }

        if (
          deniedSet.has(key) ||
          deniedSet.has("*")
        ) {
          return false;
        }

        return (
          grantedSet.has("*") ||
          grantedSet.has(key)
        );
      },
      [
        deniedSet,
        grantedSet,
      ],
    );

  const hasAnyPermission =
    useCallback(
      (...requested) => {
        const keys =
          flattenPermissions(
            requested,
          );

        if (!keys.length) {
          return false;
        }

        return keys.some(
          (permission) =>
            hasPermission(
              permission,
            ),
        );
      },
      [hasPermission],
    );

  const hasAllPermissions =
    useCallback(
      (...requested) => {
        const keys =
          flattenPermissions(
            requested,
          );

        if (!keys.length) {
          return false;
        }

        return keys.every(
          (permission) =>
            hasPermission(
              permission,
            ),
        );
      },
      [hasPermission],
    );

  const loaded =
    Boolean(
      permissionState.loaded,
    );

  const loading =
    Boolean(
      permissionState.loading,
    );

  return {
    role,
    permissions,
    deniedPermissions,
    loaded,
    isLoaded: loaded,
    loading,
    isLoading: loading,
    error:
      permissionState.error ||
      null,

    loadedUserId:
      permissionState.loadedUserId ||
      null,

    hasPermission,

    // Compatibility aliases used by different components.
    can: hasPermission,
    has: hasPermission,

    hasAnyPermission,
    hasAny: hasAnyPermission,

    hasAllPermissions,
    hasAll: hasAllPermissions,

    isCompanyAdmin:
      role ===
      "COMPANY_ADMIN",
  };
};

export default usePermission;