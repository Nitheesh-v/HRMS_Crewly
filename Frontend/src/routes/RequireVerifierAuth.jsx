import { Navigate, useLocation } from 'react-router-dom';
import bgvVerifierAuthService from '../services/bgvVerifierAuthService.js';

// Phase 30.12 — client-side convenience guard for the internal verifier
// portal. The SECURITY authority remains the backend verifier session
// (requireVerifierAuth re-checks the revocable session row AND account
// ACTIVE state on every request); this only redirects visitors with no
// stored session token to the dedicated verifier login.
const RequireVerifierAuth = ({ children }) => {
  const location = useLocation();
  const token = bgvVerifierAuthService.getToken();
  if (!token) {
    return <Navigate to="/bgv-verifier/login" state={{ from: location }} replace />;
  }
  return children;
};

export default RequireVerifierAuth;
