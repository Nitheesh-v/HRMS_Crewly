import { Navigate } from 'react-router-dom';
import useAuth from '../hooks/useAuth.jsx';

// Usage: <RequireRole roles={['SUPER_ADMIN']}><Page/></RequireRole>
const RequireRole = ({ roles, children }) => {
  const { user } = useAuth();

  if (!user || !roles.includes(user.role)) {
    return <Navigate to="/login" replace />;
  }
  return children;
};

export default RequireRole;