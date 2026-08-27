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
    // Soft-fail with a clear message instead of a silent dashboard bounce.
    // Common during Phase upgrades before the user session reloads new permissions.
    return (
      <div className="mx-auto max-w-xl rounded-2xl border border-amber-500/25 bg-amber-500/10 p-6 text-amber-50">
        <h1 className="text-lg font-semibold">Permission required</h1>
        <p className="mt-2 text-sm leading-6 text-amber-100/90">
          Your account cannot open this page yet
          {permission ? (
            <>
              {' '}
              (<code className="rounded bg-slate-950/40 px-1.5 py-0.5 text-xs">{permission}</code>)
            </>
          ) : null}
          .
        </p>
        <p className="mt-3 text-sm leading-6 text-amber-100/80">
          If you just pulled Phase 27.12, restart the local backend, make sure the frontend
          API URL points at that backend, then log out and log back in so role permissions
          migrate.
        </p>
        <a href="/app" className="btn-ghost mt-5 inline-flex">
          Back to dashboard
        </a>
      </div>
    );
  }

  return children;
};

export default RequirePermission;