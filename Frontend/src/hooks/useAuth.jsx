import {
  useDispatch,
  useSelector,
} from 'react-redux';
import authService from '../services/authService.js';
import {
  logout as logoutAction,
  setCredentials,
} from '../redux/slices/AuthSlices.js';

const useAuth = () => {
  const dispatch = useDispatch();

  const {
    user,
    token,
  } = useSelector(
    (state) => state.auth,
  );

  const localLogout = () =>
    dispatch(logoutAction());

  /*
   * Server logout runs before Redux and
   * localStorage are cleared.
   */
  const secureLogout = async () => {
    try {
      await authService.logout();
    } catch {
      /*
       * A revoked or expired server session
       * must not stop local cleanup.
       */
    } finally {
      dispatch(logoutAction());
    }
  };

  return {
    user,
    token,

    isAuthenticated:
      Boolean(user && token),

    hasRole: (...roles) =>
      Boolean(
        user &&
        roles.includes(user.role),
      ),

    login: (
      userData,
      accessToken,
    ) =>
      dispatch(
        setCredentials({
          user: userData,
          token: accessToken,
        }),
      ),

    logout: localLogout,
    secureLogout,
  };
};

export default useAuth;