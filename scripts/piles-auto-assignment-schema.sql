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
  status text NOT NULL DEFAULT 'started' CONSTRAINT piles_auto_assignment_runner_runs_status_check CHECK (status IN (
    'queued', 'started', 'running', 'completed', 'completed_with_issues', 'failed',
    'covered_by_active_cycle', 'cancelled', 'manual_action_required', 'partial', 'skipped_overlap'
  )),
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
  status text NOT NULL DEFAULT 'queued' CONSTRAINT piles_auto_assignment_insurer_runs_status_check CHECK (status IN (
    'queued', 'running', 'completed', 'completed_with_issues', 'partial', 'failed',
    'manual_action_required', 'skipped_inactive', 'skipped_overlap',
    'covered_by_active_cycle', 'cancelled'
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

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'piles_auto_assignment_runner_runs'::regclass
      AND conname = 'piles_auto_assignment_runner_runs_status_check'
      AND pg_get_constraintdef(oid) NOT LIKE '%completed_with_issues%'
  ) THEN
    ALTER TABLE piles_auto_assignment_runner_runs
      DROP CONSTRAINT piles_auto_assignment_runner_runs_status_check;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'piles_auto_assignment_runner_runs'::regclass
      AND conname = 'piles_auto_assignment_runner_runs_status_check'
  ) THEN
    ALTER TABLE piles_auto_assignment_runner_runs
      ADD CONSTRAINT piles_auto_assignment_runner_runs_status_check CHECK (status IN (
        'queued', 'started', 'running', 'completed', 'completed_with_issues', 'failed',
        'covered_by_active_cycle', 'cancelled', 'manual_action_required', 'partial', 'skipped_overlap'
      )) NOT VALID;
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'piles_auto_assignment_insurer_runs'::regclass
      AND conname = 'piles_auto_assignment_insurer_runs_status_check'
      AND pg_get_constraintdef(oid) NOT LIKE '%completed_with_issues%'
  ) THEN
    ALTER TABLE piles_auto_assignment_insurer_runs
      DROP CONSTRAINT piles_auto_assignment_insurer_runs_status_check;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'piles_auto_assignment_insurer_runs'::regclass
      AND conname = 'piles_auto_assignment_insurer_runs_status_check'
  ) THEN
    ALTER TABLE piles_auto_assignment_insurer_runs
      ADD CONSTRAINT piles_auto_assignment_insurer_runs_status_check CHECK (status IN (
        'queued', 'running', 'completed', 'completed_with_issues', 'partial', 'failed',
        'manual_action_required', 'skipped_inactive', 'skipped_overlap',
        'covered_by_active_cycle', 'cancelled'
      )) NOT VALID;
  END IF;
END $$;

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

ALTER TABLE IF EXISTS piles_auto_assignment_bot_account_history
  ADD COLUMN IF NOT EXISTS previous_values jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE IF EXISTS piles_auto_assignment_bot_account_history
  ADD COLUMN IF NOT EXISTS new_values jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE OR REPLACE FUNCTION piles_audit_bot_account_insert()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
BEGIN
  INSERT INTO piles_auto_assignment_bot_account_history
    (bot_account_id, insurer_name, owner_name, assignment_role, support_capacity_ratio,
     availability_status, availability_note, active_from_time, active_to_time,
     shift_grace_minutes, is_active, is_available, priority_order,
     changed_by_name, changed_by_member_id, change_source, change_reason,
     previous_values, new_values)
  VALUES
    (NEW.id, NEW.insurer_name, NEW.owner_name, NEW.assignment_role, NEW.support_capacity_ratio,
     NEW.availability_status, NEW.availability_note, NEW.active_from_time, NEW.active_to_time,
     NEW.shift_grace_minutes, NEW.is_active, NEW.is_available, NEW.priority_order,
     NEW.updated_by_name, NEW.updated_by_member_id, 'bot_accounts_api_create',
     'Bot account created', '{}'::jsonb,
     jsonb_build_object(
       'assignment_role', NEW.assignment_role, 'support_capacity_ratio', NEW.support_capacity_ratio,
       'availability_status', NEW.availability_status, 'availability_note', NEW.availability_note,
       'active_from_time', NEW.active_from_time, 'active_to_time', NEW.active_to_time,
       'shift_grace_minutes', NEW.shift_grace_minutes, 'is_active', NEW.is_active,
       'is_available', NEW.is_available, 'priority_order', NEW.priority_order,
       'current_claim_load', NEW.current_claim_load, 'bot_name', NEW.bot_name,
       'owner_name', NEW.owner_name, 'insurer_name', NEW.insurer_name,
       'email_configured', coalesce(NEW.bot_email, '') <> '',
       'password_configured', coalesce(NEW.bot_password, '') <> ''
     ));
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS piles_audit_bot_account_insert_trigger ON piles_auto_assignment_bot_accounts;
CREATE TRIGGER piles_audit_bot_account_insert_trigger
AFTER INSERT ON piles_auto_assignment_bot_accounts
FOR EACH ROW EXECUTE FUNCTION piles_audit_bot_account_insert();

CREATE OR REPLACE FUNCTION piles_update_bot_account_with_history(
  target_bot_id text,
  patch jsonb,
  actor_name text,
  actor_member_id text,
  change_source text,
  change_reason text
) RETURNS piles_auto_assignment_bot_accounts
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE previous_row piles_auto_assignment_bot_accounts;
DECLARE next_row piles_auto_assignment_bot_accounts;
DECLARE previous_safe jsonb;
DECLARE next_safe jsonb;
BEGIN
  SELECT * INTO previous_row FROM piles_auto_assignment_bot_accounts
    WHERE id = target_bot_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Bot account not found'; END IF;

  UPDATE piles_auto_assignment_bot_accounts SET
    master_account_id = CASE WHEN patch ? 'master_account_id' THEN nullif(patch->>'master_account_id', '') ELSE master_account_id END,
    insurer_name = CASE WHEN patch ? 'insurer_name' THEN nullif(patch->>'insurer_name', '') ELSE insurer_name END,
    owner_name = CASE WHEN patch ? 'owner_name' THEN nullif(patch->>'owner_name', '') ELSE owner_name END,
    bot_name = CASE WHEN patch ? 'bot_name' THEN nullif(patch->>'bot_name', '') ELSE bot_name END,
    bot_email = CASE WHEN patch ? 'bot_email' THEN patch->>'bot_email' ELSE bot_email END,
    bot_password = CASE WHEN patch ? 'bot_password' THEN patch->>'bot_password' ELSE bot_password END,
    assignment_role = CASE WHEN patch ? 'assignment_role' THEN patch->>'assignment_role' ELSE assignment_role END,
    support_capacity_ratio = CASE WHEN patch ? 'support_capacity_ratio' THEN (patch->>'support_capacity_ratio')::numeric ELSE support_capacity_ratio END,
    availability_status = CASE WHEN patch ? 'availability_status' THEN patch->>'availability_status' ELSE availability_status END,
    availability_note = CASE WHEN patch ? 'availability_note' THEN nullif(patch->>'availability_note', '') ELSE availability_note END,
    active_from_time = CASE WHEN patch ? 'active_from_time' THEN patch->>'active_from_time' ELSE active_from_time END,
    active_to_time = CASE WHEN patch ? 'active_to_time' THEN nullif(patch->>'active_to_time', '') ELSE active_to_time END,
    shift_grace_minutes = CASE WHEN patch ? 'shift_grace_minutes' THEN (patch->>'shift_grace_minutes')::integer ELSE shift_grace_minutes END,
    notes = CASE WHEN patch ? 'notes' THEN nullif(patch->>'notes', '') ELSE notes END,
    is_active = CASE WHEN patch ? 'is_active' THEN (patch->>'is_active')::boolean ELSE is_active END,
    is_available = CASE WHEN patch ? 'is_available' THEN (patch->>'is_available')::boolean ELSE is_available END,
    priority_order = CASE WHEN patch ? 'priority_order' THEN (patch->>'priority_order')::integer ELSE priority_order END,
    current_claim_load = CASE WHEN patch ? 'current_claim_load' THEN (patch->>'current_claim_load')::integer ELSE current_claim_load END,
    last_assigned_at = CASE WHEN patch ? 'last_assigned_at' THEN nullif(patch->>'last_assigned_at', '')::timestamptz ELSE last_assigned_at END,
    last_completed_at = CASE WHEN patch ? 'last_completed_at' THEN nullif(patch->>'last_completed_at', '')::timestamptz ELSE last_completed_at END,
    updated_by_name = actor_name,
    updated_by_member_id = actor_member_id,
    updated_at = now()
  WHERE id = target_bot_id RETURNING * INTO next_row;

  previous_safe := jsonb_build_object(
    'assignment_role', previous_row.assignment_role, 'support_capacity_ratio', previous_row.support_capacity_ratio,
    'availability_status', previous_row.availability_status, 'availability_note', previous_row.availability_note,
    'active_from_time', previous_row.active_from_time, 'active_to_time', previous_row.active_to_time,
    'shift_grace_minutes', previous_row.shift_grace_minutes, 'is_active', previous_row.is_active,
    'is_available', previous_row.is_available, 'priority_order', previous_row.priority_order,
    'current_claim_load', previous_row.current_claim_load, 'bot_name', previous_row.bot_name,
    'owner_name', previous_row.owner_name, 'insurer_name', previous_row.insurer_name,
    'email_configured', coalesce(previous_row.bot_email, '') <> '',
    'password_configured', coalesce(previous_row.bot_password, '') <> ''
  );
  next_safe := jsonb_build_object(
    'assignment_role', next_row.assignment_role, 'support_capacity_ratio', next_row.support_capacity_ratio,
    'availability_status', next_row.availability_status, 'availability_note', next_row.availability_note,
    'active_from_time', next_row.active_from_time, 'active_to_time', next_row.active_to_time,
    'shift_grace_minutes', next_row.shift_grace_minutes, 'is_active', next_row.is_active,
    'is_available', next_row.is_available, 'priority_order', next_row.priority_order,
    'current_claim_load', next_row.current_claim_load, 'bot_name', next_row.bot_name,
    'owner_name', next_row.owner_name, 'insurer_name', next_row.insurer_name,
    'email_configured', coalesce(next_row.bot_email, '') <> '',
    'password_configured', coalesce(next_row.bot_password, '') <> ''
  );

  INSERT INTO piles_auto_assignment_bot_account_history
    (bot_account_id, insurer_name, owner_name, assignment_role, support_capacity_ratio,
     availability_status, availability_note, active_from_time, active_to_time,
     shift_grace_minutes, is_active, is_available, priority_order,
     changed_by_name, changed_by_member_id, change_source, change_reason,
     previous_values, new_values)
  VALUES
    (target_bot_id, next_row.insurer_name, next_row.owner_name, next_row.assignment_role,
     next_row.support_capacity_ratio, next_row.availability_status, next_row.availability_note,
     next_row.active_from_time, next_row.active_to_time, next_row.shift_grace_minutes,
     next_row.is_active, next_row.is_available, next_row.priority_order,
     actor_name, actor_member_id, coalesce(nullif(change_source, ''), 'dashboard'),
     change_reason, previous_safe, next_safe);
  RETURN next_row;
END $$;

REVOKE ALL ON FUNCTION piles_update_bot_account_with_history(text, jsonb, text, text, text, text) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION piles_update_bot_account_with_history(text, jsonb, text, text, text, text) TO service_role;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS piles_auto_assignment_bot_account_history_bot_idx
  ON piles_auto_assignment_bot_account_history (bot_account_id, effective_at DESC);

CREATE TABLE IF NOT EXISTS piles_auto_assignment_schedule_requests (
  id text PRIMARY KEY DEFAULT md5(random()::text || clock_timestamp()::text),
  insurer_name text NOT NULL,
  requested_runner_run_id text REFERENCES piles_auto_assignment_runner_runs(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'pending' CONSTRAINT piles_auto_assignment_schedule_requests_status_check CHECK (status IN (
    'pending', 'claimed', 'cancelled_legacy'
  )),
  claimed_by_runner_run_id text REFERENCES piles_auto_assignment_runner_runs(id) ON DELETE SET NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS piles_auto_assignment_schedule_requests_pending_idx
  ON piles_auto_assignment_schedule_requests (lower(insurer_name))
  WHERE status = 'pending';

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'piles_auto_assignment_schedule_requests'::regclass
      AND conname = 'piles_auto_assignment_schedule_requests_status_check'
      AND pg_get_constraintdef(oid) NOT LIKE '%cancelled_legacy%'
  ) THEN
    ALTER TABLE piles_auto_assignment_schedule_requests
      DROP CONSTRAINT piles_auto_assignment_schedule_requests_status_check;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'piles_auto_assignment_schedule_requests'::regclass
      AND conname = 'piles_auto_assignment_schedule_requests_status_check'
  ) THEN
    ALTER TABLE piles_auto_assignment_schedule_requests
      ADD CONSTRAINT piles_auto_assignment_schedule_requests_status_check CHECK (
        status IN ('pending', 'claimed', 'cancelled_legacy')
      ) NOT VALID;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS piles_auto_assignment_work_items (
  id text PRIMARY KEY DEFAULT md5(random()::text || clock_timestamp()::text),
  parent_runner_run_id text REFERENCES piles_auto_assignment_runner_runs(id) ON DELETE SET NULL,
  insurer_name text NOT NULL,
  canonical_insurer_name text NOT NULL CHECK (btrim(canonical_insurer_name) <> ''),
  source text NOT NULL CHECK (source IN ('schedule', 'manual', 'readiness', 'recovery')),
  request_scope text NOT NULL CHECK (request_scope IN ('all_active', 'single_insurer')),
  disposition text NOT NULL DEFAULT 'queued' CHECK (disposition IN (
    'queued', 'claimed', 'covered_by_active_cycle', 'follow_up_queued', 'inactive',
    'completed', 'failed', 'cancelled'
  )),
  covered_by_insurer_run_id text REFERENCES piles_auto_assignment_insurer_runs(id) ON DELETE SET NULL,
  worker_id text,
  claim_token text,
  lease_expires_at timestamptz,
  heartbeat_at timestamptz,
  generation_requested_at timestamptz NOT NULL DEFAULT now(),
  attempt_number integer NOT NULL DEFAULT 0 CHECK (attempt_number >= 0),
  requested_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  reason_code text CHECK (
    reason_code IS NULL OR (
      char_length(reason_code) <= 80 AND reason_code ~ '^[a-z0-9._-]+$'
    )
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS piles_auto_assignment_work_items_queued_generation_idx
  ON piles_auto_assignment_work_items (canonical_insurer_name, source, request_scope)
  WHERE disposition = 'queued';

CREATE UNIQUE INDEX IF NOT EXISTS piles_auto_assignment_work_items_follow_up_idx
  ON piles_auto_assignment_work_items (canonical_insurer_name)
  WHERE disposition = 'follow_up_queued';

CREATE INDEX IF NOT EXISTS piles_auto_assignment_work_items_claim_order_idx
  ON piles_auto_assignment_work_items (
    parent_runner_run_id, disposition, generation_requested_at, requested_at, id
  )
  WHERE disposition IN ('queued', 'follow_up_queued');

CREATE INDEX IF NOT EXISTS piles_auto_assignment_work_items_expired_lease_idx
  ON piles_auto_assignment_work_items (lease_expires_at, canonical_insurer_name)
  WHERE disposition = 'claimed';

ALTER TABLE IF EXISTS piles_auto_assignment_logs
  ADD COLUMN IF NOT EXISTS insurer_run_id text REFERENCES piles_auto_assignment_insurer_runs(id) ON DELETE SET NULL;

ALTER TABLE IF EXISTS piles_auto_assignment_logs
  ADD COLUMN IF NOT EXISTS batch_id text REFERENCES piles_auto_assignment_batches(id) ON DELETE SET NULL;
