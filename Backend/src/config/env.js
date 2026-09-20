import dotenv from 'dotenv';
dotenv.config();

// ─────────────────────────────────────────────────────────────────────────────
// Phase 32.15 — CONFIGURATION VALIDATION (§10/§11/§95/§102)
//
// Startup law:
//   FAIL STARTUP  — without which SAFE operation is impossible
//                   (MONGO_URI always; a real JWT_SECRET in production).
//   DEGRADED      — Redis/cache/realtime/observability subsystems own
//                   their own bounded degradation (32.6/32.4/32.11/32.12).
//   FEATURE OFF   — SMTP/storage/billing integrations degrade per
//                   existing 32.8/28.x policies.
//
// Secret-safety law (§95): validation errors NAME the variable, never
// its value. validateProductionConfig is pure + exported so the
// config:check CLI and tests exercise the SAME logic the server runs.
// ─────────────────────────────────────────────────────────────────────────────

const DEV_JWT_DEFAULT = 'dev_secret_change_me';
const MIN_PRODUCTION_JWT_SECRET_LENGTH = 32;

/**
 * Pure production-configuration validation. Returns { ok, errors } where
 * each error names the offending variable and a safe reason — never a value.
 */
export const validateProductionConfig = (source = process.env) => {
  const errors = [];

  if (!String(source.MONGO_URI || '').trim()) {
    errors.push('MONGO_URI: required in production (authoritative business state)');
  }

  const jwtSecret = String(source.JWT_SECRET || '');
  if (!jwtSecret) {
    errors.push('JWT_SECRET: required in production (must not start insecurely)');
  } else if (jwtSecret === DEV_JWT_DEFAULT) {
    errors.push('JWT_SECRET: the development default is refused in production');
  } else if (jwtSecret.length < MIN_PRODUCTION_JWT_SECRET_LENGTH) {
    errors.push(`JWT_SECRET: too short for production (minimum ${MIN_PRODUCTION_JWT_SECRET_LENGTH} characters)`);
  }

  return { ok: errors.length === 0, errors };
};

const env = {
  NODE_ENV: process.env.NODE_ENV || 'development',
  PORT: process.env.PORT || 5000,
  MONGO_URI: process.env.MONGO_URI,
  CLIENT_URL: process.env.CLIENT_URL || 'http://localhost:5173',
  JWT_SECRET: process.env.JWT_SECRET || 'dev_secret_change_me',
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || '7d',
};

// Always-enforced requirement (all environments): Mongo is authoritative.
const required = ['MONGO_URI'];
const missing = required.filter((key) => !process.env[key]);
if (missing.length > 0) {
  console.error(`❌ Missing required environment variables: ${missing.join(', ')}`);
  console.error('👉 Check your Backend/.env file.');
  process.exit(1);
}

// Phase 32.15 — production fail-fast (same validator the config:check
// CLI exposes). Development/test keep their convenient defaults; a
// production process never boots insecurely (§10).
if (env.NODE_ENV === 'production') {
  const verdict = validateProductionConfig(process.env);
  if (!verdict.ok) {
    console.error('❌ Invalid production configuration:');
    for (const error of verdict.errors) console.error(`   • ${error}`);
    process.exit(1);
  }
}

export default env;
