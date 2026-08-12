import jwt from 'jsonwebtoken';
import env from '../config/env.js';
import User from '../models/User.js';
import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';

// Verifies JWT and attaches req.user + req.companyId
export const protect = asyncHandler(async (req, res, next) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    throw ApiError.unauthorized('Not authorized — no token provided');
  }

  const token = header.split(' ')[1];
  let decoded;
  try {
    decoded = jwt.verify(token, env.JWT_SECRET);
  } catch (err) {
    throw ApiError.unauthorized(
      err.name === 'TokenExpiredError' ? 'Session expired — please log in again' : 'Invalid token'
    );
  }

  const user = await User.findById(decoded.id);
  if (!user) throw ApiError.unauthorized('Account no longer exists');
  if (user.status !== 'ACTIVE') throw ApiError.forbidden('Your account is deactivated');

  req.user = user;
  req.companyId = user.companyId; // ← multi-tenant key used everywhere
  next();
});

// Role guard:  router.delete('/x', protect, authorize('COMPANY_ADMIN'), handler)
export const authorize = (...roles) => {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      throw ApiError.forbidden('You do not have permission to access this resource');
    }
    next();
  };
};






                                             
                                       // Code expalnation

// import jwt from 'jsonwebtoken';
// import env from '../config/env.js';
// import User from '../models/User.js';
// import ApiError from '../utils/ApiError.js';
// import asyncHandler from '../utils/asyncHandler.js';

// /* =====================================================================
//    MIDDLEWARE 1: protect
//    ---------------------------------------------------------------------
//    Purpose : "Is this request from a logged-in user?"
//    How     : Reads the JWT from the Authorization header, verifies it,
//              loads the user from the database, attaches it to req.user.
//    Usage   : router.get('/me', protect, getMe);
//    ===================================================================== */
// export const protect = asyncHandler(async (req, res, next) => {
//   // STEP 1 — Read the header. Frontend sends: "Authorization: Bearer <token>"
//   const header = req.headers.authorization;

//   // STEP 2 — If there is no header (or wrong format) → reject immediately
//   if (!header || !header.startsWith('Bearer ')) {
//     throw ApiError.unauthorized('Not authorized — no token provided');
//   }

//   // STEP 3 — Split "Bearer <token>" and take only the token part
//   const token = header.split(' ')[1];

//   // STEP 4 — Verify the token with our secret.
//   // jwt.verify THROWS an error if the token is fake or expired,
//   // so we capture the payload inside try/catch.
//   let decoded;
//   try {
//     decoded = jwt.verify(token, env.JWT_SECRET);
//     // decoded = { id, role, companyId }  ← what we put inside when logging in
//   } catch (err) {
//     if (err.name === 'TokenExpiredError') {
//       throw ApiError.unauthorized('Session expired — please log in again');
//     }
//     throw ApiError.unauthorized('Invalid token');
//   }

//   // STEP 5 — Load the real user from the database using the id in the token.
//   // (We re-check the DB so a deleted/deactivated user can't use old tokens.)
//   const user = await User.findById(decoded.id);

//   if (!user) {
//     throw ApiError.unauthorized('Account no longer exists');
//   }

//   if (user.status !== 'ACTIVE') {
//     throw ApiError.forbidden('Your account is deactivated');
//   }

//   // STEP 6 — Attach useful data to the request object.
//   // Every controller/middleware AFTER this one can use req.user & req.companyId.
//   req.user = user;
//   req.companyId = user.companyId; // the multi-tenant key 🔑

//   // STEP 7 — All good. Pass control to the next middleware / route handler.
//   next();
// });



// /* =====================================================================
//    MIDDLEWARE 2: authorize  (middleware factory)
//    ---------------------------------------------------------------------
//    Purpose : "Is this user's ROLE allowed on this route?"
//    How     : It's a FUNCTION THAT RETURNS A MIDDLEWARE.
//              You call it with allowed roles when defining the route;
//              the function it returns runs on every request.
//    Usage   : router.post('/employees',
//                          protect,                          // 1) logged in?
//                          authorize('COMPANY_ADMIN', 'HR'), // 2) role allowed?
//                          createEmployee);                  // 3) then run
//    ===================================================================== */
// export const authorize = (...allowedRoles) => {
//   // Outer function — runs ONCE when the route is defined.
//   // allowedRoles becomes e.g. ['COMPANY_ADMIN', 'HR_MANAGER']

//   const roleCheckMiddleware = (req, res, next) => {
//     // Inner function — THIS is the real middleware; it runs on EVERY request.

//     // protect must run before this, so req.user already exists
//     if (!req.user) {
//       throw ApiError.unauthorized('Not authorized');
//     }

//     // Is the user's role inside the allowed list?
//     if (!allowedRoles.includes(req.user.role)) {
//       throw ApiError.forbidden('You do not have permission to access this resource');
//     }

//     // Role is allowed → continue
//     next();
//   };

//   // Hand the inner middleware back to Express
//   return roleCheckMiddleware;
// };