import { useSelector, useDispatch } from 'react-redux';
import { setCredentials, logout as logoutAction } from "../redux/slices/AuthSlices.js"

/*
 * One hook for all auth needs:
 *   const { user, isAuthenticated, login, logout, hasRole } = useAuth();
 */
const useAuth = () => {
  const dispatch = useDispatch();
  const { user, token } = useSelector((state) => state.auth);

  return {
    user,
    token,
    isAuthenticated: !!user && !!token,
    hasRole: (...roles) => !!user && roles.includes(user.role),
    login: (userData, authToken) => dispatch(setCredentials({ user: userData, token: authToken })),
    logout: () => dispatch(logoutAction()),
  };
};

export default useAuth;