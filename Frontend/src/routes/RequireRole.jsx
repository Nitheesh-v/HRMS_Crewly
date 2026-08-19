import { Navigate } from 'react-router-dom';
import useAuth from '../hooks/useAuth.jsx';
import {
  getDashboardPath,
} from '../utils/roles.js';

const RequireRole = ({
  roles,
  children,
}) => {
  const { user } = useAuth();

  if (!user) {
    return (
      <Navigate
        to="/login"
        replace
      />
    );
  }

  if (
    !roles.includes(user.role)
  ) {
    return (
      <Navigate
        to={getDashboardPath(
          user.role
        )}
        replace
      />
    );
  }

  return children;
};

export default RequireRole;