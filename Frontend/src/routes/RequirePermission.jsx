import {
  Navigate,
} from 'react-router-dom';
import usePermission from '../hooks/usePermission.js';

const RequirePermission = ({
  permission,
  any = [],
  all = [],
  children,
}) => {
  const {
    loading,
    hasPermission,
    hasAnyPermission,
    hasAllPermissions,
  } = usePermission();

  if (loading) {
    return (
      <div className="p-6 text-crewly-dim">
        Checking permissions…
      </div>
    );
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

  if (!allowed) {
    return (
      <Navigate
        to="/app"
        replace
      />
    );
  }

  return children;
};

export default RequirePermission;