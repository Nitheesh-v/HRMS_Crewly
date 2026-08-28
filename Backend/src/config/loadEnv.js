// ============================================================
// ⚡ ENV LOADING — import this FIRST from every entry point.
//
// Several modules snapshot process.env at IMPORT time
// (config/cloudinary.js checks keys, utils/mailer.js picks
// SMTP vs MOCK, parsing services read bounded defaults).
// ESM evaluates imports in order, so .env MUST be loaded
// before that graph is evaluated:
//
//   import './config/loadEnv.js';   // always first
//   import app from './app.js';     // graph that snapshots env
//
// dotenv never overrides already-set variables, so this is safe
// to run more than once and safe when .env does not exist
// (CI/sandbox/tests set variables directly).
// ============================================================

import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const backendDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..'
);

dotenv.config({ path: path.join(backendDir, '.env') });
