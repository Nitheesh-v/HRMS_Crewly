// ─────────────────────────────────────────────────────────────────────────────
// Phase 36.1 — AI chat controller.
//
// Deliberately thin. Every guardrail (kill switch, rate limit, quota,
// redaction, vendor-error opacity) lives in services/ai/aiProvider.js, so
// this file does three things and nothing else:
//   1. take identity from the VERIFIED session — never from the body;
//   2. call the provider;
//   3. write the reply, mapping an AIError to its stable code.
//
// Step 3 is why the try/catch exists at all: utils/errorHandler drops a
// custom `err.code`, so the code-bearing 429/503 replies this feature needs
// are written here, directly (briefing §J pitfall 1).
// ─────────────────────────────────────────────────────────────────────────────
import asyncHandler from '../utils/asyncHandler.js';

import { AI_FEATURE_HR_CHAT } from '../services/ai/aiConfig.js';

import { AIError, sendAIError } from '../services/ai/aiErrors.js';

import { aiChat } from '../services/ai/aiProvider.js';

// POST /api/ai/chat  { messages: [{role, content}] }
export const chat = asyncHandler(async (req, res) => {
  try {
    // Data from frontend - requests from frontend
    const { messages } = req.body;

    const result = await aiChat({
      messages,

      // Tenant authority and caller identity are SERVER-DERIVED. The body
      // never carries them (pinned by the validator's noIdentityOverride).
      companyId: req.companyId,
      userId: req.user._id,
      feature: AI_FEATURE_HR_CHAT,
    });

    // Data to frontend - response to frontend
    return res.status(200).json({
      statusCode: 200,
      success: true,
      data: result,
      message: 'AI response ready',
    });
  } catch (error) {
    // A code-bearing AI reply is written directly — the shared error pipeline
    // has no code field, and the frontend branches on these codes.
    if (error instanceof AIError) {
      return sendAIError(res, error);
    }

    // Anything else is a genuine bug: let the normal pipeline log it with a
    // request id and answer a generic 500.
    throw error;
  }
});
