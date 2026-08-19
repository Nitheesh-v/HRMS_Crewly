import { Navigate, useLocation } from 'react-router-dom';
import useAuth from '../hooks/useAuth.jsx';

const RequireAuth = ({ children,redirectTo = '/login',}) => {
  const { isAuthenticated } = useAuth();
  const location = useLocation();

  if (!isAuthenticated) {
    return (
  <Navigate
    to={redirectTo}
    state={{ from: location }}
    replace
  />
);
  }

  return children;
};

export default RequireAuth;