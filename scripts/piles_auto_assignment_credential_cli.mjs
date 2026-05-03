import fs from 'fs';
import { decryptCredential, encryptCredential } from '../lib/piles-auto-assignment-credentials.mjs';

function loadLocalEnv() {
  if (!fs.existsSync('.env.local')) return;
  const lines = fs.readFileSync('.env.local', 'utf8').split(/\n/);
  for (const line of lines) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match && process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2];
    }
  }
}

loadLocalEnv();

const [mode, value = ''] = process.argv.slice(2);

if (mode === 'encrypt') {
  process.stdout.write(encryptCredential(value));
} else if (mode === 'decrypt') {
  process.stdout.write(decryptCredential(value));
} else {
  console.error('Usage: node scripts/piles_auto_assignment_credential_cli.mjs <encrypt|decrypt> <value>');
  process.exit(1);
}
