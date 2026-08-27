import crypto from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;

const resolveKey = () => {
  const configured =
    process.env.FIELD_ENCRYPTION_KEY ||
    process.env.JWT_SECRET ||
    'crewly-dev-field-encryption-key';
  return crypto.createHash('sha256').update(String(configured)).digest();
};

export const encryptSensitiveValue = (value) => {
  if (value === null || value === undefined || value === '') return '';

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, resolveKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(String(value), 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return [
    'v1',
    iv.toString('base64url'),
    tag.toString('base64url'),
    encrypted.toString('base64url'),
  ].join('.');
};

export const decryptSensitiveValue = (payload) => {
  if (!payload || typeof payload !== 'string') return '';

  const [version, ivPart, tagPart, dataPart] = payload.split('.');
  if (version !== 'v1' || !ivPart || !tagPart || !dataPart) return '';

  try {
    const decipher = crypto.createDecipheriv(
      ALGORITHM,
      resolveKey(),
      Buffer.from(ivPart, 'base64url')
    );
    decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(dataPart, 'base64url')),
      decipher.final(),
    ]);
    return decrypted.toString('utf8');
  } catch {
    return '';
  }
};

export const fingerprintSensitiveValue = (value) => {
  if (!value) return '';
  return crypto
    .createHash('sha256')
    .update(String(value).trim().toUpperCase())
    .digest('hex');
};

export const maskDocumentNumber = (value) => {
  const normalized = String(value || '').trim();
  if (!normalized) return '';
  if (normalized.length <= 4) return '*'.repeat(normalized.length);
  const visible = normalized.slice(-4);
  return `${'*'.repeat(Math.min(8, normalized.length - 4))}${visible}`;
};
