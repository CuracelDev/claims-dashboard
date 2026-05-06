import fs from 'fs';
import crypto from 'crypto';
import pg from 'pg';
import { encryptCredential } from '../lib/piles-auto-assignment-credentials.mjs';

const { Pool } = pg;
const DEFAULT_CSV = '/Users/sam/Downloads/Data Operations OKR 2026 - Bot Used for Operational Task.csv';

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

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (inQuotes) {
      if (ch === '"' && next === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n') {
      row.push(cell.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += ch;
    }
  }
  row.push(cell.replace(/\r$/, ''));
  rows.push(row);
  return rows;
}

function clean(value) {
  return String(value || '').trim();
}

function normalizeInsurer(value) {
  const raw = clean(value);
  if (!raw) return raw;
  const map = {
    'Old Mutual': 'UAPOM',
    Defmis: 'DEFMIS',
  };
  return map[raw] || raw;
}

function roleConfig(insurer, ownerName) {
  const primaryByInsurer = {
    'Jubilee Kenya': 'Sophie',
    'DEFMIS': 'Sophie',
    'Jubilee Tanzania': 'Morenike',
    'Jubilee Uganda': 'Daniel',
    'UAPOM': 'Emmanuel',
  };
  const supportByInsurer = {
    'UAPOM': new Set(['Sophie', 'Morenike', 'Daniel']),
    'Jubilee Uganda': new Set(['Morenike', 'Sophie', 'Emmanuel']),
    'Jubilee Kenya': new Set(['Morenike', 'Emmanuel', 'Daniel']),
    'Jubilee Tanzania': new Set(['Sophie', 'Emmanuel', 'Daniel']),
    'DEFMIS': new Set(['Morenike', 'Emmanuel', 'Daniel']),
    'AXA Mansard': new Set(['Sophie', 'Morenike', 'Emmanuel', 'Daniel']),
  };
  if (ownerName === 'Muyiwa') {
    return { assignmentRole: 'admin', supportCapacityRatio: 1, priorityOrder: 1, isActive: false, isAvailable: false };
  }
  if (primaryByInsurer[insurer] === ownerName) {
    return { assignmentRole: 'primary', supportCapacityRatio: 1, priorityOrder: 10, isActive: insurer !== 'AXA Mansard', isAvailable: insurer !== 'AXA Mansard' };
  }
  const isSupport = supportByInsurer[insurer]?.has(ownerName) ?? true;
  return { assignmentRole: isSupport ? 'support' : 'primary', supportCapacityRatio: isSupport ? 0.6 : 1, priorityOrder: isSupport ? 50 : 20, isActive: insurer !== 'AXA Mansard', isAvailable: insurer !== 'AXA Mansard' };
}

loadLocalEnv();

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}
if (!process.env.BOT_CREDENTIALS_ENCRYPTION_KEY) {
  console.error('BOT_CREDENTIALS_ENCRYPTION_KEY is not set.');
  process.exit(1);
}

const csvPath = process.argv[2] || DEFAULT_CSV;
if (!fs.existsSync(csvPath)) {
  console.error(`CSV file not found: ${csvPath}`);
  process.exit(1);
}

const rows = parseCsv(fs.readFileSync(csvPath, 'utf8'));
const leftEntries = [];
const masterCredentials = [];
let currentInsurer = '';
let inMasterSection = false;

for (const rawRow of rows) {
  const row = [...rawRow];
  while (row.length < 9) row.push('');
  const [c0, c1, c2, c3, c4, , c6, c7, c8] = row.map(clean);

  if (c0 === 'Insurer' && c1 === 'Names') {
    continue;
  }

  if (c6 === 'Master Insurer Login') {
    inMasterSection = true;
    continue;
  }

  if (c0) currentInsurer = normalizeInsurer(c0);
  if (currentInsurer && c1) {
    leftEntries.push({
      insurerName: currentInsurer,
      ownerName: c1,
      botName: c2 || c1,
      botEmail: c3,
      botPassword: c4,
    });
  }

  if (inMasterSection && c6 && c7) {
    masterCredentials.push({
      insurerName: normalizeInsurer(c6),
      loginEmail: c7,
      loginPassword: c8,
    });
  }
}

const uniqueMasterByInsurer = new Map();
for (const item of masterCredentials) {
  if (!item.insurerName) continue;
  uniqueMasterByInsurer.set(item.insurerName, item);
}

const pool = new Pool({ connectionString: databaseUrl });
const metricsByRole = { primary: 35, support: 20, admin: 0 };

try {
  await pool.query('begin');
  await pool.query('delete from piles_auto_assignment_logs');
  await pool.query('delete from piles_auto_assignment_bot_metrics');
  await pool.query('delete from piles_auto_assignment_rules');
  await pool.query('delete from piles_auto_assignment_bot_accounts');
  await pool.query('delete from piles_auto_assignment_master_accounts');

  const masterIdByInsurer = new Map();
  for (const master of uniqueMasterByInsurer.values()) {
    const masterId = crypto.randomUUID();
    const result = await pool.query(
      `insert into piles_auto_assignment_master_accounts
        (id, insurer_name, login_email, login_password, notes, is_active, last_password_update, updated_at)
       values ($1, $2, $3, $4, $5, true, $6, $6)
       returning id`,
      [
        masterId,
        master.insurerName,
        encryptCredential(master.loginEmail),
        master.loginPassword ? encryptCredential(master.loginPassword) : '',
        'Seeded from the Bot Used for Operational Task CSV.',
        master.loginPassword ? new Date().toISOString() : null,
      ],
    );
    masterIdByInsurer.set(master.insurerName, result.rows[0].id);
  }

  const seenRuleInsurers = new Set();
  for (const entry of leftEntries) {
    const insurerName = entry.insurerName;
    const masterAccountId = masterIdByInsurer.get(insurerName) || null;
    const role = roleConfig(insurerName, entry.ownerName);
    const availabilityStatus = role.isAvailable ? 'available' : 'unconfigured';
    const botId = crypto.randomUUID();
    const botResult = await pool.query(
      `insert into piles_auto_assignment_bot_accounts
        (id, master_account_id, insurer_name, owner_name, bot_name, bot_email, bot_password, assignment_role, support_capacity_ratio, availability_status, availability_note, notes, is_active, is_available, priority_order, current_claim_load, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 0, $16)
       returning id`,
      [
        botId,
        masterAccountId,
        insurerName,
        entry.ownerName,
        entry.botName,
        entry.botEmail ? encryptCredential(entry.botEmail) : null,
        entry.botPassword ? encryptCredential(entry.botPassword) : '',
        role.assignmentRole,
        role.supportCapacityRatio,
        availabilityStatus,
        role.isAvailable ? null : 'Seeded as unconfigured from CSV; confirm portal assignee before use.',
        'Seeded from the Bot Used for Operational Task CSV.',
        role.isActive,
        role.isAvailable,
        role.priorityOrder,
        new Date().toISOString(),
      ],
    );

    if (role.assignmentRole !== 'admin') {
      await pool.query(
        `insert into piles_auto_assignment_bot_metrics
          (id, bot_account_id, metric_window, claims_completed, hours_logged, claims_per_hour, active_claim_load, observed_at, updated_at)
         values ($1, $2, 'seed_baseline', 0, 0, $3, 0, $4, $4)`,
        [crypto.randomUUID(), botResult.rows[0].id, metricsByRole[role.assignmentRole] || 20, new Date().toISOString()],
      );
    }

    if (!seenRuleInsurers.has(insurerName) && masterAccountId) {
      seenRuleInsurers.add(insurerName);
      await pool.query(
        `insert into piles_auto_assignment_rules
          (id, master_account_id, insurer_name, distribution_mode, minimum_claim_chunk, reassignment_threshold_minutes, stale_claim_threshold, target_completion_gap_minutes, is_active, notes, updated_at)
         values ($1, $2, $3, 'balanced_finish', 25, 120, 40, 30, true, $4, $5)`,
        [crypto.randomUUID(), masterAccountId, insurerName, 'Seeded from the Bot Used for Operational Task CSV.', new Date().toISOString()],
      );
    }
  }

  await pool.query('commit');
  console.log(`Seeded ${masterIdByInsurer.size} master accounts and ${leftEntries.length} bot rows from ${csvPath}.`);
} catch (error) {
  await pool.query('rollback');
  console.error(error);
  process.exit(1);
} finally {
  await pool.end();
}
