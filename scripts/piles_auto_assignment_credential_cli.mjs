import fs from 'fs';
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

function isEncryptedCredential(value) {
  return typeof value === 'string' && value.startsWith(`${PREFIX}:`);
}

function encryptCredential(value) {
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

function decryptCredential(value) {
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

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  const lines = fs.readFileSync(file, 'utf8').split(/\n/);
  for (const line of lines) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match && process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2];
    }
  }
}

loadEnvFile('.env');
loadEnvFile('.env.local');

const [mode, value = ''] = process.argv.slice(2);

if (mode === 'encrypt') {
  process.stdout.write(encryptCredential(value));
} else if (mode === 'decrypt') {
  process.stdout.write(decryptCredential(value));
} else {
  console.error('Usage: node scripts/piles_auto_assignment_credential_cli.mjs <encrypt|decrypt> <value>');
  process.exit(1);
}
