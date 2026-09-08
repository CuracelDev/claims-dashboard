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
  active_from_time text DEFAULT '09:00',
  active_to_time text,
  shift_grace_minutes integer DEFAULT 120,
  notes text,
  is_active boolean DEFAULT true,
  is_available boolean DEFAULT true,
  priority_order integer DEFAULT 100,
  current_claim_load integer DEFAULT 0,
  last_assigned_at timestamptz,
  last_completed_at timestamptz,
  updated_by_name text,
  updated_by_member_id text,
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

ALTER TABLE IF EXISTS piles_auto_assignment_bot_accounts
  ADD COLUMN IF NOT EXISTS active_from_time text;

ALTER TABLE IF EXISTS piles_auto_assignment_bot_accounts
  ADD COLUMN IF NOT EXISTS active_to_time text;

ALTER TABLE IF EXISTS piles_auto_assignment_bot_accounts
  ADD COLUMN IF NOT EXISTS shift_grace_minutes integer DEFAULT 120;

ALTER TABLE IF EXISTS piles_auto_assignment_bot_accounts
  ADD COLUMN IF NOT EXISTS updated_by_name text;

ALTER TABLE IF EXISTS piles_auto_assignment_bot_accounts
  ADD COLUMN IF NOT EXISTS updated_by_member_id text;

ALTER TABLE IF EXISTS piles_auto_assignment_bot_accounts
  ALTER COLUMN active_from_time SET DEFAULT '09:00';

UPDATE piles_auto_assignment_bot_accounts
SET active_from_time = '09:00'
WHERE active_from_time IS NULL OR btrim(active_from_time) = '';

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

CREATE TABLE IF NOT EXISTS piles_auto_assignment_tracked_piles (
  id text PRIMARY KEY DEFAULT md5(random()::text || clock_timestamp()::text),
  master_account_id text REFERENCES piles_auto_assignment_master_accounts(id) ON DELETE SET NULL,
  bot_account_id text REFERENCES piles_auto_assignment_bot_accounts(id) ON DELETE SET NULL,
  insurer_name text NOT NULL,
  tracking_key text NOT NULL,
  last_pile_key text,
  provider text NOT NULL,
  claim_month text,
  submitted_date text,
  claims_total integer DEFAULT 0,
  synced_claims integer DEFAULT 0,
  remaining_claims integer DEFAULT 0,
  assignment_type text DEFAULT 'Vetting',
  current_status text,
  current_status_bucket text,
  current_assigned text,
  filter_month text,
  first_assigned_at timestamptz DEFAULT now(),
  assigned_at timestamptz DEFAULT now(),
  first_seen_at timestamptz DEFAULT now(),
  last_seen_at timestamptz DEFAULT now(),
  last_progress_at timestamptz,
  last_reassigned_at timestamptz,
  completed_at timestamptz,
  is_active boolean DEFAULT true,
  is_stale boolean DEFAULT false,
  stale_reason text,
  details jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE (insurer_name, tracking_key)
);

CREATE INDEX IF NOT EXISTS piles_auto_assignment_tracked_piles_insurer_active_idx
  ON piles_auto_assignment_tracked_piles (insurer_name, is_active, last_seen_at DESC);

CREATE INDEX IF NOT EXISTS piles_auto_assignment_tracked_piles_bot_active_idx
  ON piles_auto_assignment_tracked_piles (bot_account_id, is_active, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS piles_auto_assignment_pile_snapshots (
  id text PRIMARY KEY DEFAULT md5(random()::text || clock_timestamp()::text),
  tracked_pile_id text NOT NULL REFERENCES piles_auto_assignment_tracked_piles(id) ON DELETE CASCADE,
  insurer_name text NOT NULL,
  bot_account_id text REFERENCES piles_auto_assignment_bot_accounts(id) ON DELETE SET NULL,
  tracking_key text NOT NULL,
  pile_key text,
  provider text,
  claims_total integer DEFAULT 0,
  synced_claims integer DEFAULT 0,
  remaining_claims integer DEFAULT 0,
  progress_claims integer DEFAULT 0,
  status text,
  status_bucket text,
  assigned text,
  is_completed boolean DEFAULT false,
  observed_at timestamptz DEFAULT now(),
  details jsonb DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS piles_auto_assignment_pile_snapshots_tracked_idx
  ON piles_auto_assignment_pile_snapshots (tracked_pile_id, observed_at DESC);

CREATE INDEX IF NOT EXISTS piles_auto_assignment_pile_snapshots_bot_idx
  ON piles_auto_assignment_pile_snapshots (bot_account_id, observed_at DESC);

CREATE TABLE IF NOT EXISTS piles_auto_assignment_external_assignments (
  id text PRIMARY KEY DEFAULT md5(random()::text || clock_timestamp()::text),
  master_account_id text REFERENCES piles_auto_assignment_master_accounts(id) ON DELETE SET NULL,
  bot_account_id text REFERENCES piles_auto_assignment_bot_accounts(id) ON DELETE SET NULL,
  insurer_name text NOT NULL,
  tracking_key text NOT NULL,
  last_pile_key text,
  provider text,
  claim_month text,
  submitted_date text,
  claims_total integer DEFAULT 0,
  synced_claims integer DEFAULT 0,
  remaining_claims integer DEFAULT 0,
  assignment_type text DEFAULT 'Vetting',
  current_status text,
  current_status_bucket text,
  current_assigned text,
  owner_name text,
  first_detected_at timestamptz DEFAULT now(),
  last_seen_at timestamptz DEFAULT now(),
  notification_sent_at timestamptz,
  cleared_at timestamptz,
  is_active boolean DEFAULT true,
  details jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE (insurer_name, tracking_key)
);

CREATE INDEX IF NOT EXISTS piles_auto_assignment_external_assignments_insurer_active_idx
  ON piles_auto_assignment_external_assignments (insurer_name, is_active, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS piles_auto_assignment_weekend_rosters (
  id text PRIMARY KEY DEFAULT md5(random()::text || clock_timestamp()::text),
  weekend_start date NOT NULL,
  weekend_end date NOT NULL,
  timezone text DEFAULT 'Africa/Lagos',
  source text DEFAULT 'n8n_weekend_shift_roster',
  status text DEFAULT 'received',
  raw_message text,
  raw_payload jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE (weekend_start, weekend_end, source)
);

CREATE INDEX IF NOT EXISTS piles_auto_assignment_weekend_rosters_dates_idx
  ON piles_auto_assignment_weekend_rosters (weekend_start, weekend_end, updated_at DESC);

CREATE TABLE IF NOT EXISTS piles_auto_assignment_weekend_roster_members (
  id text PRIMARY KEY DEFAULT md5(random()::text || clock_timestamp()::text),
  roster_id text NOT NULL REFERENCES piles_auto_assignment_weekend_rosters(id) ON DELETE CASCADE,
  team_member_id text,
  owner_name text NOT NULL,
  slack_user_id text,
  slack_mention text,
  duty_status text NOT NULL,
  raw_payload jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE (roster_id, owner_name, duty_status)
);

CREATE INDEX IF NOT EXISTS piles_auto_assignment_weekend_roster_members_roster_idx
  ON piles_auto_assignment_weekend_roster_members (roster_id, duty_status, owner_name);

CREATE TABLE IF NOT EXISTS piles_auto_assignment_weekend_bot_state_snapshots (
  id text PRIMARY KEY DEFAULT md5(random()::text || clock_timestamp()::text),
  roster_id text REFERENCES piles_auto_assignment_weekend_rosters(id) ON DELETE CASCADE,
  bot_account_id text NOT NULL REFERENCES piles_auto_assignment_bot_accounts(id) ON DELETE CASCADE,
  insurer_name text NOT NULL,
  owner_name text NOT NULL,
  previous_assignment_role text,
  previous_availability_status text,
  previous_availability_note text,
  previous_is_available boolean,
  previous_is_active boolean,
  applied_at timestamptz DEFAULT now(),
  restored_at timestamptz,
  details jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE (roster_id, bot_account_id)
);

CREATE INDEX IF NOT EXISTS piles_auto_assignment_weekend_bot_state_snapshots_restore_idx
  ON piles_auto_assignment_weekend_bot_state_snapshots (restored_at, applied_at DESC);

CREATE TABLE IF NOT EXISTS piles_auto_assignment_runner_runs (
  id text PRIMARY KEY DEFAULT md5(random()::text || clock_timestamp()::text),
  insurer_name text,
  run_scope text NOT NULL DEFAULT 'single',
  portal_environment text NOT NULL DEFAULT 'production',
  backend text NOT NULL DEFAULT 'local',
  run_source text NOT NULL DEFAULT 'manual',
  months jsonb DEFAULT '[]'::jsonb,
  year text,
  mode text NOT NULL DEFAULT 'dry-run',
  status text NOT NULL DEFAULT 'started',
  started_at timestamptz DEFAULT now(),
  finished_at timestamptz,
  duration_ms integer DEFAULT 0,
  stdout text,
  stderr text,
  details jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS piles_auto_assignment_runner_runs_started_idx
  ON piles_auto_assignment_runner_runs (started_at DESC);

CREATE TABLE IF NOT EXISTS piles_auto_assignment_insurer_runs (
  id text PRIMARY KEY DEFAULT md5(random()::text || clock_timestamp()::text),
  runner_run_id text REFERENCES piles_auto_assignment_runner_runs(id) ON DELETE SET NULL,
  master_account_id text REFERENCES piles_auto_assignment_master_accounts(id) ON DELETE SET NULL,
  insurer_name text NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN (
    'queued', 'running', 'completed', 'partial', 'failed',
    'manual_action_required', 'skipped_inactive', 'skipped_overlap'
  )),
  phase text NOT NULL DEFAULT 'configuration' CHECK (phase IN (
    'configuration', 'login', 'scan', 'plan', 'apply', 'reconcile', 'complete'
  )),
  discovered_pile_count integer NOT NULL DEFAULT 0 CHECK (discovered_pile_count >= 0),
  discovered_claim_count integer NOT NULL DEFAULT 0 CHECK (discovered_claim_count >= 0),
  planned_pile_count integer NOT NULL DEFAULT 0 CHECK (planned_pile_count >= 0),
  planned_claim_count integer NOT NULL DEFAULT 0 CHECK (planned_claim_count >= 0),
  submitted_pile_count integer NOT NULL DEFAULT 0 CHECK (submitted_pile_count >= 0),
  submitted_claim_count integer NOT NULL DEFAULT 0 CHECK (submitted_claim_count >= 0),
  confirmed_pile_count integer NOT NULL DEFAULT 0 CHECK (confirmed_pile_count >= 0),
  confirmed_claim_count integer NOT NULL DEFAULT 0 CHECK (confirmed_claim_count >= 0),
  reconciliation_pending_pile_count integer NOT NULL DEFAULT 0 CHECK (reconciliation_pending_pile_count >= 0),
  reconciliation_pending_claim_count integer NOT NULL DEFAULT 0 CHECK (reconciliation_pending_claim_count >= 0),
  conflict_pile_count integer NOT NULL DEFAULT 0 CHECK (conflict_pile_count >= 0),
  failed_pile_count integer NOT NULL DEFAULT 0 CHECK (failed_pile_count >= 0),
  error_code text,
  error_message text,
  heartbeat_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS piles_auto_assignment_insurer_runs_runner_idx
  ON piles_auto_assignment_insurer_runs (runner_run_id, created_at);

CREATE INDEX IF NOT EXISTS piles_auto_assignment_insurer_runs_active_idx
  ON piles_auto_assignment_insurer_runs (insurer_name, heartbeat_at DESC)
  WHERE status IN ('queued', 'running');

CREATE TABLE IF NOT EXISTS piles_auto_assignment_scan_contexts (
  id text PRIMARY KEY DEFAULT md5(random()::text || clock_timestamp()::text),
  insurer_run_id text NOT NULL REFERENCES piles_auto_assignment_insurer_runs(id) ON DELETE CASCADE,
  insurer_name text NOT NULL,
  filter_month text NOT NULL,
  requested_year text NOT NULL,
  effective_years jsonb NOT NULL DEFAULT '[]'::jsonb,
  status_bucket text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'scanning', 'complete', 'empty', 'failed'
  )),
  page_count integer NOT NULL DEFAULT 0 CHECK (page_count >= 0),
  distinct_pile_count integer NOT NULL DEFAULT 0 CHECK (distinct_pile_count >= 0),
  unassigned_pile_count integer NOT NULL DEFAULT 0 CHECK (unassigned_pile_count >= 0),
  claim_count integer NOT NULL DEFAULT 0 CHECK (claim_count >= 0),
  ui_evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  network_evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  table_evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_code text,
  error_message text,
  started_at timestamptz,
  settled_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (insurer_run_id, filter_month, requested_year, status_bucket)
);

CREATE INDEX IF NOT EXISTS piles_auto_assignment_scan_contexts_run_idx
  ON piles_auto_assignment_scan_contexts (insurer_run_id, status, created_at);

CREATE TABLE IF NOT EXISTS piles_auto_assignment_batches (
  id text PRIMARY KEY DEFAULT md5(random()::text || clock_timestamp()::text),
  insurer_run_id text NOT NULL REFERENCES piles_auto_assignment_insurer_runs(id) ON DELETE CASCADE,
  scan_context_id text REFERENCES piles_auto_assignment_scan_contexts(id) ON DELETE SET NULL,
  insurer_name text NOT NULL,
  bot_account_id text REFERENCES piles_auto_assignment_bot_accounts(id) ON DELETE SET NULL,
  intended_owner_name text NOT NULL,
  intended_portal_assignee text NOT NULL,
  assignment_type text NOT NULL,
  status_bucket text NOT NULL,
  status text NOT NULL DEFAULT 'planned' CHECK (status IN (
    'planned', 'selecting', 'selected', 'submitted', 'partially_confirmed',
    'confirmed', 'reconciliation_pending', 'conflict', 'failed'
  )),
  planned_pile_count integer NOT NULL DEFAULT 0 CHECK (planned_pile_count >= 0),
  planned_claim_count integer NOT NULL DEFAULT 0 CHECK (planned_claim_count >= 0),
  selected_pile_count integer NOT NULL DEFAULT 0 CHECK (selected_pile_count >= 0),
  confirmed_pile_count integer NOT NULL DEFAULT 0 CHECK (confirmed_pile_count >= 0),
  pending_pile_count integer NOT NULL DEFAULT 0 CHECK (pending_pile_count >= 0),
  conflict_pile_count integer NOT NULL DEFAULT 0 CHECK (conflict_pile_count >= 0),
  failed_pile_count integer NOT NULL DEFAULT 0 CHECK (failed_pile_count >= 0),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  submitted_at timestamptz,
  finished_at timestamptz,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS piles_auto_assignment_batches_run_idx
  ON piles_auto_assignment_batches (insurer_run_id, status, created_at);

CREATE TABLE IF NOT EXISTS piles_auto_assignment_attempts (
  id text PRIMARY KEY DEFAULT md5(random()::text || clock_timestamp()::text),
  batch_id text NOT NULL REFERENCES piles_auto_assignment_batches(id) ON DELETE CASCADE,
  insurer_run_id text NOT NULL REFERENCES piles_auto_assignment_insurer_runs(id) ON DELETE CASCADE,
  tracked_pile_id text REFERENCES piles_auto_assignment_tracked_piles(id) ON DELETE SET NULL,
  insurer_name text NOT NULL,
  tracking_key text NOT NULL,
  last_pile_key text,
  bot_account_id text REFERENCES piles_auto_assignment_bot_accounts(id) ON DELETE SET NULL,
  intended_owner_name text NOT NULL,
  intended_portal_assignee text NOT NULL,
  observed_assignee text,
  status text NOT NULL DEFAULT 'planned' CHECK (status IN (
    'planned', 'selected', 'submitted', 'confirmed_visible', 'confirmed_reconciled',
    'reconciliation_pending', 'still_unassigned', 'manual_action_required', 'conflict', 'failed'
  )),
  claim_count integer NOT NULL DEFAULT 0 CHECK (claim_count >= 0),
  filter_context jsonb NOT NULL DEFAULT '{}'::jsonb,
  attempt_number integer NOT NULL DEFAULT 1 CHECK (attempt_number > 0),
  evidence_code text,
  evidence_details jsonb NOT NULL DEFAULT '{}'::jsonb,
  selected_at timestamptz,
  submitted_at timestamptz,
  confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (batch_id, tracking_key)
);

CREATE UNIQUE INDEX IF NOT EXISTS piles_auto_assignment_attempts_active_key_idx
  ON piles_auto_assignment_attempts (insurer_name, tracking_key)
  WHERE status IN ('planned', 'selected', 'submitted', 'reconciliation_pending', 'still_unassigned');

CREATE INDEX IF NOT EXISTS piles_auto_assignment_attempts_run_idx
  ON piles_auto_assignment_attempts (insurer_run_id, status, updated_at);

CREATE TABLE IF NOT EXISTS piles_auto_assignment_bot_account_history (
  id text PRIMARY KEY DEFAULT md5(random()::text || clock_timestamp()::text),
  bot_account_id text NOT NULL REFERENCES piles_auto_assignment_bot_accounts(id) ON DELETE CASCADE,
  insurer_name text NOT NULL,
  owner_name text NOT NULL,
  assignment_role text,
  support_capacity_ratio numeric,
  availability_status text,
  availability_note text,
  active_from_time text,
  active_to_time text,
  shift_grace_minutes integer,
  is_active boolean,
  is_available boolean,
  priority_order integer,
  changed_by_name text,
  changed_by_member_id text,
  change_source text NOT NULL DEFAULT 'dashboard',
  change_reason text,
  effective_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS piles_auto_assignment_bot_account_history_bot_idx
  ON piles_auto_assignment_bot_account_history (bot_account_id, effective_at DESC);

ALTER TABLE IF EXISTS piles_auto_assignment_logs
  ADD COLUMN IF NOT EXISTS insurer_run_id text REFERENCES piles_auto_assignment_insurer_runs(id) ON DELETE SET NULL;

ALTER TABLE IF EXISTS piles_auto_assignment_logs
  ADD COLUMN IF NOT EXISTS batch_id text REFERENCES piles_auto_assignment_batches(id) ON DELETE SET NULL;
