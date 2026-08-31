import Company from "../models/Company.js";
import User from "../models/User.js";
import SecuritySession from "../models/SecuritySession.js";
import SecurityEvent from "../models/SecurityEvent.js";
import RefreshToken from "../models/RefreshToken.js";
import PasswordResetToken from "../models/PasswordResetToken.js";
import AuditLog from "../models/AuditLog.js";

import ApiError from "../utils/ApiError.js";
import ApiResponse from "../utils/ApiResponse.js";
import asyncHandler from "../utils/asyncHandler.js";

import {
  clearRefreshCookie,
  revokeAllUserSessions,
  revokeCurrentSession,
  rotateRefreshToken,
} from "../utils/tokenService.js";

import {
  getRequestIp,
  getSecurityPolicy,
  hashToken,
  passwordWasUsed,
  randomToken,
  validatePassword,
} from "../utils/securityPolicy.js";

import {
  recordAudit,
  recordSecurityEvent,
} from "../utils/securityauditService.js";

import {
  sendMail,
} from "../utils/mailer.js";

import env from "../config/env.js";

const LOGIN_EVENT_TYPES = [
  "LOGIN_SUCCESS",
  "LOGIN_FAILED",
  "ACCOUNT_LOCKED",
  "ACCOUNT_UNLOCKED",
  "NEW_DEVICE_LOGIN",
  "REFRESH_TOKEN_REUSE",
];

const valueId = (value) => {
  if (!value) return "";

  return String(
    value._id ||
    value.id ||
    value,
  );
};

const securityEventType = (event) =>
  String(
    event.event ||
    event.type ||
    event.eventType ||
    event.action ||
    event.category ||
    event.metadata?.event ||
    event.metadata?.eventType ||
    "SECURITY_EVENT",
  ).toUpperCase();

const securityEventIp = (event) =>
  String(
    event.ip ||
    event.ipAddress ||
    event.metadata?.ip ||
    event.metadata?.ipAddress ||
    "",
  ).replace(
    /^::ffff:/,
    "",
  );

const publicSession = (
  session,
  currentSessionId,
) => ({
  id:
    session._id,

  sessionId:
    session.sessionId,

  device:
    session.device || {
      browser:
        session.browser ||
        "Unknown browser",

      operatingSystem:
        session.operatingSystem ||
        session.os ||
        "Unknown OS",

      deviceType:
        session.deviceType ||
        "Unknown device",
    },

  ipAddress:
    String(
      session.ipAddress ||
      session.ip ||
      "",
    ).replace(
      /^::ffff:/,
      "",
    ),

  loginAt:
    session.loginAt ||
    session.createdAt ||
    null,

  lastActivityAt:
    session.lastActivityAt ||
    session.lastSeenAt ||
    session.updatedAt ||
    null,

  expiresAt:
    session.expiresAt ||
    null,

  current:
    session.sessionId ===
    currentSessionId,
});

/*
 * POST /api/auth/refresh
 */
export const refresh =
  asyncHandler(
    async (req, res) => {
      try {
        const data =
          // DB Logic - DB logics
          await rotateRefreshToken({
            req,
            res,
          });

        return ApiResponse.success(
          // Data to frontend - response to frontend
          res,
          {
            message:
              "Access token refreshed",

            data,
          },
        );
      } catch (error) {
        clearRefreshCookie(res);

        throw new ApiError(
          error.statusCode || 401,
          error.message ||
            "Could not refresh session",
        );
      }
    },
  );

/*
 * POST /api/auth/logout
 */
export const logout =
  asyncHandler(
    async (req, res) => {
      // DB Logic - DB logics
      await revokeCurrentSession({
        req,
        res,
        user: req.user,
        sessionId:
          req.sessionId,
      });

      await recordAudit({
        req,
        action: "USER_LOGOUT",
        companyId:
          req.companyId,
        actorId:
          req.user._id,
        resource:
          "SecuritySession",
        resourceId:
          req.securitySession
            ?._id,
        critical: true,
      });

      return ApiResponse.success(
        // Data to frontend - response to frontend
        res,
        {
          message:
            "Logged out securely",

          data: {},
        },
      );
    },
  );

/*
 * POST /api/auth/logout-all
 */
export const logoutAll =
  asyncHandler(
    async (req, res) => {
      // DB Logic - DB logics
      await revokeAllUserSessions({
        req,
        res,
        user: req.user,
      });

      await recordAudit({
        req,
        action:
          "ALL_SESSIONS_REVOKED",
        companyId:
          req.companyId,
        actorId:
          req.user._id,
        resource: "User",
        resourceId:
          req.user._id,
        critical: true,
      });

      return ApiResponse.success(
        // Data to frontend - response to frontend
        res,
        {
          message:
            "Logged out from all devices",

          data: {},
        },
      );
    },
  );

/*
 * GET /api/auth/sessions
 *
 * Returns active sessions and the authenticated
 * user's recent login-related security activity.
 */
export const sessionsWithHistory =
  asyncHandler(
    async (req, res) => {
      const now = new Date();

      const [
        sessionDocuments,
        companyEvents,
        auditLoginLogs,
      // DB Logic - DB logics
      ] = await Promise.all([
        SecuritySession.find({
          companyId:
            req.companyId,

          user:
            req.user._id,

          revokedAt: null,

          expiresAt: {
            $gt: now,
          },
        })
          .sort({
            lastActivityAt: -1,
            lastSeenAt: -1,
            updatedAt: -1,
          })
          .lean(),

        /*
         * Load only a bounded set of tenant events.
         * They are filtered to the current user below.
         */
        SecurityEvent.find({
          companyId:
            req.companyId,
        })
          .sort({
            createdAt: -1,
          })
          .limit(100)
          .lean(),

        /*
         * AuditLog provides a reliable fallback for
         * older SecurityEvent document structures.
         */
        AuditLog.find({
          companyId:
            req.companyId,

          actor:
            req.user._id,

          $or: [
            {
              action: {
                $in:
                  LOGIN_EVENT_TYPES,
              },
            },

            {
              path:
                "/api/auth/login",
            },
          ],
        })
          .sort({
            createdAt: -1,
          })
          .limit(20)
          .lean(),
      ]);

      const currentUserId =
        // Data from frontend - requests from frontend
        String(req.user._id);

      const currentEmail =
        String(
          req.user.email || "",
        ).toLowerCase();

      const ownEvents =
        companyEvents.filter(
          (event) => {
            const possibleUserIds = [
              event.user,
              event.userId,
              event.actor,
              event.actorId,
              event.subjectUser,
              event.subjectUserId,
              event.metadata?.user,
              event.metadata?.userId,
              event.metadata?.actorId,
              event.metadata
                ?.subjectUserId,
            ]
              .filter(Boolean)
              .map(valueId);

            const possibleEmails = [
              event.email,
              event.userEmail,
              event.metadata?.email,
              event.metadata
                ?.userEmail,
            ]
              .filter(Boolean)
              .map((value) =>
                String(
                  value,
                ).toLowerCase(),
              );

            return (
              possibleUserIds.includes(
                currentUserId,
              ) ||
              (
                currentEmail &&
                possibleEmails.includes(
                  currentEmail,
                )
              )
            );
          },
        );

      const sessions =
        sessionDocuments.map(
          (session) =>
            publicSession(
              session,
              req.sessionId,
            ),
        );

      /*
       * The current SecurityEvent service writes the
       * event name into event, not type.
       */
      const securityLoginHistory =
        ownEvents
          .map((event) => ({
            _id:
              event._id,

            type:
              securityEventType(
                event,
              ),

            severity:
              String(
                event.severity ||
                event.level ||
                "INFO",
              ).toUpperCase(),

            success:
              event.success !==
              false,

            message:
              event.message ||
              event.description ||
              event.metadata
                ?.message ||
              "",

            ip:
              securityEventIp(
                event,
              ),

            userAgent:
              event.userAgent ||
              "",

            createdAt:
              event.createdAt ||
              event.occurredAt ||
              event.timestamp,
          }))
          .filter((event) =>
            LOGIN_EVENT_TYPES.includes(
              event.type,
            ),
          )
          .slice(0, 20);

      const auditLoginHistory =
        auditLoginLogs.map(
          (log) => {
            let type =
              LOGIN_EVENT_TYPES.includes(
                log.action,
              )
                ? log.action
                : "LOGIN_SUCCESS";

            if (
              log.path ===
                "/api/auth/login" &&
              Number(
                log.statusCode,
              ) >= 400
            ) {
              type =
                "LOGIN_FAILED";
            }

            return {
              _id:
                `audit-${log._id}`,

              type,

              severity:
                Number(
                  log.statusCode,
                ) >= 400
                  ? "WARNING"
                  : "INFO",

              success:
                Number(
                  log.statusCode,
                ) < 400,

              message:
                log.metadata
                  ?.message ||
                (
                  type ===
                  "LOGIN_SUCCESS"
                    ? "Account signed in successfully"
                    : "Login attempt failed"
                ),

              ip:
                String(
                  log.ip || "",
                ).replace(
                  /^::ffff:/,
                  "",
                ),

              userAgent:
                log.metadata
                  ?.userAgent ||
                "",

              createdAt:
                log.createdAt,
            };
          },
        );

      /*
       * Prefer SecurityEvent records because they contain
       * more authentication context. Use AuditLog when no
       * compatible SecurityEvent records exist.
       */
      const loginHistory =
        (
          securityLoginHistory.length
            ? securityLoginHistory
            : auditLoginHistory
        )
          .filter(
            (event) =>
              event.createdAt,
          )
          .sort(
            (
              first,
              second,
            ) =>
              new Date(
                second.createdAt,
              ).getTime() -
              new Date(
                first.createdAt,
              ).getTime(),
          )
          .slice(0, 20);

      return ApiResponse.success(
        // Data to frontend - response to frontend
        res,
        {
          message:
            "Active sessions and login history",

          data: {
            sessions,
            loginHistory,
          },
        },
      );
    },
  );

/*
 * Compatibility export for authRoutes versions that use listSessions.
 */
export const listSessions =
  sessionsWithHistory;

/*
 * DELETE /api/auth/sessions/:sessionId
 *
 * The frontend sends the session document id.
 */
export const revokeSession =
  asyncHandler(
    async (req, res) => {
      const session =
        // DB Logic - DB logics
        await SecuritySession.findOne({
          _id:
            req.params.sessionId,

          user:
            req.user._id,

          companyId:
            req.companyId,

          revokedAt: null,
        });

      if (!session) {
        throw ApiError.notFound(
          "Session not found",
        );
      }

      if (
        session.sessionId ===
        // Data from frontend - requests from frontend
        req.sessionId
      ) {
        throw ApiError.badRequest(
          "Use Logout to end your current session",
        );
      }

      session.revokedAt =
        new Date();

      session.revokedBy =
        req.user._id;

      session.revokeReason =
        "Revoked by user";

      await session.save();

      await RefreshToken.updateMany(
        {
          $or: [
            {
              session:
                session._id,
            },

            {
              sessionId:
                session.sessionId,
            },
          ],

          revokedAt: null,
        },

        {
          $set: {
            revokedAt:
              new Date(),

            revokeReason:
              "Session revoked by user",
          },
        },
      );

      await recordSecurityEvent({
        req,
        companyId:
          req.companyId,
        userId:
          req.user._id,
        sessionId:
          session.sessionId,
        event:
          "SESSION_REVOKED",
      });

      return ApiResponse.success(
        // Data to frontend - response to frontend
        res,
        {
          message:
            "Session revoked",

          data: {},
        },
      );
    },
  );

/*
 * PATCH /api/auth/change-password
 */
export const changePassword =
  asyncHandler(
    async (req, res) => {
      const {
        currentPassword,
        newPassword,
        confirmPassword,
      } = req.body;

      if (
        newPassword !==
        confirmPassword
      ) {
        throw ApiError.badRequest(
          "New passwords do not match",
        );
      }

      const user =
        // DB Logic - DB logics
        await User.findById(
          // Data from frontend - requests from frontend
          req.user._id,
        )
          .select("+password")
          .select(
            "+passwordHistory.hash",
          );

      if (!user) {
        throw ApiError.notFound(
          "User not found",
        );
      }

      const validCurrent =
        await user.comparePassword(
          currentPassword,
        );

      if (!validCurrent) {
        throw ApiError.badRequest(
          "Current password is incorrect",
        );
      }

      const policy =
        await getSecurityPolicy(
          req.companyId,
        );

      const validation =
        validatePassword(
          newPassword,
          policy,
        );

      if (!validation.valid) {
        throw ApiError.badRequest(
          validation.errors.join(
            ", ",
          ),
        );
      }

      const reused =
        await passwordWasUsed(
          newPassword,
          user.password,
          user.passwordHistory,
        );

      if (reused) {
        throw ApiError.badRequest(
          `You cannot reuse your last ${validation.policy.historyCount} passwords`,
        );
      }

      user.passwordHistory.unshift({
        hash:
          user.password,

        changedAt:
          new Date(),
      });

      user.passwordHistory =
        user.passwordHistory.slice(
          0,
          validation.policy
            .historyCount,
        );

      user.password =
        newPassword;

      user.passwordChangedAt =
        new Date();

      user.tokenVersion =
        Number(
          user.tokenVersion ||
          0,
        ) + 1;

      await user.save();

      await revokeAllUserSessions({
        req,
        res,
        user,
        reason:
          "Password changed",
      });

      await recordSecurityEvent({
        req,
        companyId:
          req.companyId,
        userId:
          user._id,
        event:
          "PASSWORD_CHANGED",
      });

      await recordAudit({
        req,
        action:
          "PASSWORD_CHANGED",
        companyId:
          req.companyId,
        actorId:
          user._id,
        resource: "User",
        resourceId:
          user._id,
        critical: true,
      });

      return ApiResponse.success(
        // Data to frontend - response to frontend
        res,
        {
          message:
            "Password changed. Please sign in again.",

          data: {},
        },
      );
    },
  );

/*
 * POST /api/auth/forgot-password
 */
export const forgotPassword =
  asyncHandler(
    async (req, res) => {
      const genericMessage =
        "If the account exists, a password reset link has been sent.";

      const companyCode =
        String(
          // Data from frontend - requests from frontend
          req.body.companyCode ||
          "",
        )
          .trim()
          .toLowerCase();

      const email =
        String(
          req.body.email || "",
        )
          .trim()
          .toLowerCase();

      const company =
        // DB Logic - DB logics
        await Company.findOne({
          code: companyCode,
        }).select("_id");

      if (company) {
        const user =
          await User.findOne({
            companyId:
              company._id,
            email,
            status: "ACTIVE",
          });

        if (user) {
          const rawToken =
            randomToken(48);

          await PasswordResetToken.deleteMany({
            user:
              user._id,
            usedAt: null,
          });

          await PasswordResetToken.create({
            user:
              user._id,

            companyId:
              company._id,

            tokenHash:
              hashToken(
                rawToken,
              ),

            expiresAt:
              new Date(
                Date.now() +
                30 *
                  60 *
                  1000,
              ),

            requestedIp:
              getRequestIp(req),
          });

          const clientUrl =
            String(
              env.CLIENT_URL,
            )
              .split(",")[0]
              .trim()
              .replace(
                /\/$/,
                "",
              );

          const resetUrl =
            `${clientUrl}/reset-password?token=${encodeURIComponent(
              rawToken,
            )}`;

          try {
            await sendMail({
              to:
                user.email,

              subject:
                "Reset your Crewly password",

              text:
                `Reset your password: ${resetUrl}\n` +
                "This link expires in 30 minutes.",
            });
          } catch {
            // Generic response remains unchanged.
          }

          await recordSecurityEvent({
            req,
            companyId:
              company._id,
            userId:
              user._id,
            event:
              "PASSWORD_RESET_REQUESTED",
          });
        }
      }

      return ApiResponse.success(
        // Data to frontend - response to frontend
        res,
        {
          message:
            genericMessage,

          data: {},
        },
      );
    },
  );

/*
 * POST /api/auth/reset-password
 */
export const resetPassword =
  asyncHandler(
    async (req, res) => {
      const {
        token,
        newPassword,
        confirmPassword,
      } = req.body;

      if (
        !token ||
        !newPassword
      ) {
        throw ApiError.badRequest(
          "Reset token and new password are required",
        );
      }

      if (
        newPassword !==
        confirmPassword
      ) {
        throw ApiError.badRequest(
          "Passwords do not match",
        );
      }

      const resetToken =
        // DB Logic - DB logics
        await PasswordResetToken.findOne({
          tokenHash:
            hashToken(token),

          usedAt: null,

          expiresAt: {
            $gt:
              new Date(),
          },
        });

      if (!resetToken) {
        throw ApiError.badRequest(
          "Reset link is invalid or expired",
        );
      }

      const user =
        await User.findById(
          resetToken.user,
        )
          .select("+password")
          .select(
            "+passwordHistory.hash",
          );

      if (!user) {
        throw ApiError.badRequest(
          "Reset link is invalid or expired",
        );
      }

      const policy =
        await getSecurityPolicy(
          resetToken.companyId,
        );

      const validation =
        validatePassword(
          newPassword,
          policy,
        );

      if (!validation.valid) {
        throw ApiError.badRequest(
          validation.errors.join(
            ", ",
          ),
        );
      }

      const reused =
        await passwordWasUsed(
          newPassword,
          user.password,
          user.passwordHistory,
        );

      if (reused) {
        throw ApiError.badRequest(
          "This password was used previously",
        );
      }

      user.passwordHistory.unshift({
        hash:
          user.password,

        changedAt:
          new Date(),
      });

      user.passwordHistory =
        user.passwordHistory.slice(
          0,
          validation.policy
            .historyCount,
        );

      user.password =
        newPassword;

      user.passwordChangedAt =
        new Date();

      // Phase 27.13 — first-time account setup uses the same secure token path.
      if (user.accountSetupRequired) {
        user.accountSetupRequired = false;
        user.accountSetupCompletedAt = new Date();
      }

      user.tokenVersion =
        Number(
          user.tokenVersion ||
          0,
        ) + 1;

      await user.save();

      resetToken.usedAt =
        new Date();

      await resetToken.save();

      if (user.accountSetupCompletedAt) {
        await recordAudit({
          req,
          action: "ACCOUNT_SETUP_COMPLETED",
          companyId: resetToken.companyId,
          actorId: user._id,
          resource: "User",
          resourceId: user._id,
          critical: true,
        });
      }

      await Promise.all([
        SecuritySession.updateMany(
          {
            user:
              user._id,
            revokedAt: null,
          },

          {
            $set: {
              revokedAt:
                new Date(),

              revokeReason:
                "Password reset",
            },
          },
        ),

        RefreshToken.updateMany(
          {
            user:
              user._id,
            revokedAt: null,
          },

          {
            $set: {
              revokedAt:
                new Date(),

              revokeReason:
                "Password reset",
            },
          },
        ),
      ]);

      await recordSecurityEvent({
        req,
        companyId:
          resetToken.companyId,
        userId:
          user._id,
        event:
          "PASSWORD_RESET_COMPLETED",
      });

      await recordAudit({
        req,
        action:
          "PASSWORD_RESET_COMPLETED",
        companyId:
          resetToken.companyId,
        actorId:
          user._id,
        resource: "User",
        resourceId:
          user._id,
        critical: true,
      });

      return ApiResponse.success(
        // Data to frontend - response to frontend
        res,
        {
          message:
            "Password reset successful. Please sign in.",

          data: {},
        },
      );
    },
  );