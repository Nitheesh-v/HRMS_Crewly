import jwt from 'jsonwebtoken';
import env from '../config/env.js';
import SecuritySession from '../models/SecuritySession.js';

const unauthorized = (
  res,
  message
) =>
  res.status(401).json({
    statusCode: 401,
    success: false,
    code:
      'SESSION_INVALID',
    message,
  });

export const requireCustomerSession = async (
  req,
  res,
  next
) => {
  try {
    const token =
      req.headers.authorization
        ?.startsWith('Bearer ')
        ? req.headers.authorization
            .slice(7)
        : '';

    if (!token) {
      return unauthorized(
        res,
        'Access token required'
      );
    }

    const decoded =
      jwt.verify(
        token,
        env.JWT_SECRET
      );

    if (
      !decoded.sessionId ||
      decoded.tokenVersion ===
        undefined
    ) {
      return unauthorized(
        res,
        'Please sign in again'
      );
    }

    if (
      String(decoded.sub) !==
        String(req.user?._id) ||
      Number(
        decoded.tokenVersion
      ) !==
        Number(
          req.user
            ?.tokenVersion ||
            0
        )
    ) {
      return unauthorized(
        res,
        'Access token is no longer valid'
      );
    }

    const session =
      await SecuritySession.findOne({
        user:
          req.user._id,
        companyId:
          req.companyId,
        sessionId:
          decoded.sessionId,
        revokedAt: null,
        expiresAt: {
          $gt: new Date(),
        },
      });

    if (!session) {
      return unauthorized(
        res,
        'Session expired or revoked'
      );
    }

    session.lastActivityAt =
      new Date();

    // Avoid blocking normal requests on activity tracking.
    SecuritySession.updateOne(
      {
        _id: session._id,
      },
      {
        $set: {
          lastActivityAt:
            session.lastActivityAt,
        },
      }
    ).catch(() => {});

    req.securitySession =
      session;

    req.sessionId =
      session.sessionId;

    next();
  } catch (error) {
    return unauthorized(
      res,
      error.name ===
        'TokenExpiredError'
        ? 'Access token expired'
        : 'Invalid access token'
    );
  }
};