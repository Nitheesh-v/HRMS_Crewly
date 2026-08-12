// ============================================================
// ☁️ CLOUDINARY CONFIG — image/file uploads
// Hardened: if keys are missing OR malformed (e.g. cloud name
// with spaces) → dev fallback mode instead of runtime 500s.
// ============================================================
import { v2 as cloudinary } from 'cloudinary';

const { CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET } = process.env;

// Cloud names are lowercase letters/digits/hyphens only — NO spaces
const CLOUD_NAME_OK = /^[a-z0-9][a-z0-9_-]{1,40}$/.test(CLOUDINARY_CLOUD_NAME || '');

export const cloudinaryReady = Boolean(
  CLOUD_NAME_OK && CLOUDINARY_API_KEY && CLOUDINARY_API_SECRET
);

if (cloudinaryReady) {
  cloudinary.config({
    cloud_name: CLOUDINARY_CLOUD_NAME,
    api_key: CLOUDINARY_API_KEY,
    api_secret: CLOUDINARY_API_SECRET,
    secure: true,
  });
  console.log(`☁️  Cloudinary connected (cloud: ${CLOUDINARY_CLOUD_NAME})`);
} else {
  console.warn('⚠️  Cloudinary keys missing/invalid — uploads use inline storage (dev mode).');
  if (CLOUDINARY_CLOUD_NAME && !CLOUD_NAME_OK) {
    console.warn(`   ↳ "${CLOUDINARY_CLOUD_NAME}" is not a valid cloud name (no spaces allowed). Copy the exact "Cloud name" from your Cloudinary Console.`);
  }
}

export default cloudinary;