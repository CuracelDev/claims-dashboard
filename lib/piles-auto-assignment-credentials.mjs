import crypto from 'crypto';

const PREFIX = 'enc:v1';

function getRawKey() {
  return (process.env.BOT_CREDENTIALS_ENCRYPTION_KEY || '').trim();
}

function getKeyBuffer() {
  const raw = getRawKey();
  if (!raw) return null;
  return crypto.createHash('sha256').update(raw).digest();
}

export function credentialsEncryptionEnabled() {
  return Boolean(getKeyBuffer());
}

export function isEncryptedCredential(value) {
  return typeof value === 'string' && value.startsWith(`${PREFIX}:`);
}

export function encryptCredential(value) {
  if (value == null) return value;
  const plain = String(value);
  if (!plain) return plain;
  if (isEncryptedCredential(plain)) return plain;

  const key = getKeyBuffer();
  if (!key) {
    throw new Error('BOT_CREDENTIALS_ENCRYPTION_KEY is not set.');
  }

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}:${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

export function decryptCredential(value) {
  if (value == null) return value;
  const raw = String(value);
  if (!isEncryptedCredential(raw)) return raw;

  const key = getKeyBuffer();
  if (!key) {
    throw new Error('BOT_CREDENTIALS_ENCRYPTION_KEY is not set.');
  }

  const [, version, ivText, tagText, cipherText] = raw.split(':');
  if (version !== 'v1' || !ivText || !tagText || !cipherText) {
    throw new Error('Invalid encrypted credential format.');
  }

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivText, 'base64'));
  decipher.setAuthTag(Buffer.from(tagText, 'base64'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(cipherText, 'base64')),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}

export function decryptCredentialFields(item, fields) {
  if (!item || typeof item !== 'object') return item;
  const copy = { ...item };
  for (const field of fields) {
    if (copy[field] !== undefined && copy[field] !== null && copy[field] !== '') {
      copy[field] = decryptCredential(copy[field]);
    }
  }
  return copy;
}

