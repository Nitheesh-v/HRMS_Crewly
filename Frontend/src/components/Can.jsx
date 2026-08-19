import usePermission from '../hooks/usePermission.js';

const Can = ({
  permission,
  any = [],
  all = [],
  fallback = null,
  children,
}) => {
  const {
    loading,
    hasPermission,
    hasAnyPermission,
    hasAllPermissions,
  } = usePermission();

  if (loading) {
    return fallback;
  }

  let allowed = true;

  if (permission) {
    allowed =
      hasPermission(permission);
  }

  if (any.length) {
    allowed =
      allowed &&
      hasAnyPermission(any);
  }

  if (all.length) {
    allowed =
      allowed &&
      hasAllPermissions(all);
  }

  return allowed
    ? children
    : fallback;
};

export const PermissionGate =
  Can;

export const ProtectedAction =
  Can;

export default Can;