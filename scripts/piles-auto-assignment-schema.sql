CREATE TABLE IF NOT EXISTS piles_auto_assignment_master_accounts (
  id text PRIMARY KEY DEFAULT md5(random()::text || clock_timestamp()::text),
  insurer_name text NOT NULL UNIQUE,
  login_email text NOT NULL,
  login_password text,
  notes text,
  is_active boolean DEFAULT true,
  last_password_update timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS piles_auto_assignment_bot_accounts (
  id text PRIMARY KEY DEFAULT md5(random()::text || clock_timestamp()::text),
  master_account_id text REFERENCES piles_auto_assignment_master_accounts(id) ON DELETE CASCADE,
  insurer_name text NOT NULL,
  owner_name text NOT NULL,
  bot_name text,
  bot_email text,
  bot_password text,
  assignment_role text DEFAULT 'primary',
  support_capacity_ratio numeric DEFAULT 1,
  availability_status text DEFAULT 'available',
  availability_note text,
  notes text,
  is_active boolean DEFAULT true,
  is_available boolean DEFAULT true,
  priority_order integer DEFAULT 100,
  current_claim_load integer DEFAULT 0,
  last_assigned_at timestamptz,
  last_completed_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS piles_auto_assignment_bot_accounts_master_idx
  ON piles_auto_assignment_bot_accounts (master_account_id);

CREATE INDEX IF NOT EXISTS piles_auto_assignment_bot_accounts_insurer_idx
  ON piles_auto_assignment_bot_accounts (insurer_name);

ALTER TABLE IF EXISTS piles_auto_assignment_bot_accounts
  ADD COLUMN IF NOT EXISTS assignment_role text DEFAULT 'primary';

ALTER TABLE IF EXISTS piles_auto_assignment_bot_accounts
  ADD COLUMN IF NOT EXISTS support_capacity_ratio numeric DEFAULT 1;

ALTER TABLE IF EXISTS piles_auto_assignment_bot_accounts
  ADD COLUMN IF NOT EXISTS availability_status text DEFAULT 'available';

ALTER TABLE IF EXISTS piles_auto_assignment_bot_accounts
  ADD COLUMN IF NOT EXISTS availability_note text;

CREATE TABLE IF NOT EXISTS piles_auto_assignment_rules (
  id text PRIMARY KEY DEFAULT md5(random()::text || clock_timestamp()::text),
  master_account_id text NOT NULL REFERENCES piles_auto_assignment_master_accounts(id) ON DELETE CASCADE,
  insurer_name text NOT NULL UNIQUE,
  distribution_mode text DEFAULT 'balanced_finish',
  minimum_claim_chunk integer DEFAULT 25,
  reassignment_threshold_minutes integer DEFAULT 120,
  stale_claim_threshold integer DEFAULT 40,
  target_completion_gap_minutes integer DEFAULT 30,
  is_active boolean DEFAULT true,
  notes text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS piles_auto_assignment_bot_metrics (
  id text PRIMARY KEY DEFAULT md5(random()::text || clock_timestamp()::text),
  bot_account_id text NOT NULL UNIQUE REFERENCES piles_auto_assignment_bot_accounts(id) ON DELETE CASCADE,
  metric_window text DEFAULT 'rolling_24h',
  claims_completed integer DEFAULT 0,
  hours_logged numeric DEFAULT 0,
  claims_per_hour numeric DEFAULT 0,
  active_claim_load integer DEFAULT 0,
  projected_finish_at timestamptz,
  details jsonb DEFAULT '{}'::jsonb,
  observed_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS piles_auto_assignment_logs (
  id text PRIMARY KEY DEFAULT md5(random()::text || clock_timestamp()::text),
  master_account_id text REFERENCES piles_auto_assignment_master_accounts(id) ON DELETE SET NULL,
  bot_account_id text REFERENCES piles_auto_assignment_bot_accounts(id) ON DELETE SET NULL,
  insurer_name text NOT NULL,
  event_type text NOT NULL,
  source text DEFAULT 'dashboard',
  status text DEFAULT 'logged',
  assigned_by text,
  pile_count integer DEFAULT 0,
  claim_count integer DEFAULT 0,
  details jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS piles_auto_assignment_logs_insurer_created_idx
  ON piles_auto_assignment_logs (insurer_name, created_at DESC);
