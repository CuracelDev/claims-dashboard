const ADMINER_URL = process.env.ADMINER_URL || 'https://db.crl.to';
const ADMINER_SERVER = process.env.ADMINER_SERVER || '10.189.80.3';
const ADMINER_DRIVER = process.env.ADMINER_DRIVER || 'pgsql';
const ADMINER_USER = process.env.ADMINER_USER;
const ADMINER_PASSWORD = process.env.ADMINER_PASSWORD;
const ADMINER_DB = process.env.ADMINER_DB || 'claims_dashboard_db';

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const PAGE_SIZE = Number(process.env.MIGRATION_PAGE_SIZE || 1000);
const INSERT_CHUNK_SIZE = Number(process.env.MIGRATION_INSERT_CHUNK_SIZE || 150);

const TABLES = [
  'audit_log',
  'claim_errors',
  'daily_reports',
  'insurer_feedback_items',
  'leave_records',
  'metric_definitions',
  'okr_entries',
  'platform_settings',
  'piles_auto_assignment_bot_accounts',
  'piles_auto_assignment_bot_metrics',
  'piles_auto_assignment_logs',
  'piles_auto_assignment_master_accounts',
  'piles_auto_assignment_pile_snapshots',
  'piles_auto_assignment_runner_runs',
  'piles_auto_assignment_rules',
  'piles_auto_assignment_tracked_piles',
  'prism_conversations',
  'prism_logs',
  'prism_messages',
  'qa_flags',
  'sessions',
  'slack_summaries',
  'target_logs',
  'tasks',
  'team_leave',
  'team_members',
  'weekly_targets',
];

const NUMERIC_ID_TABLES = [
  'audit_log',
  'claim_errors',
  'daily_reports',
  'leave_records',
  'metric_definitions',
  'okr_entries',
  'prism_logs',
  'sessions',
  'slack_summaries',
  'tasks',
  'team_leave',
  'team_members',
];

const TABLE_COLUMNS = {
  audit_log: [
    ['id', 'bigint'], ['member_id', 'bigint'], ['member_name', 'text'], ['action', 'text'],
    ['entity_type', 'text'], ['entity_id', 'text'], ['details', 'jsonb'], ['source', 'text'],
    ['ip_address', 'text'], ['created_at', 'timestamptz'],
  ],
  claim_errors: [
    ['id', 'bigint'], ['created_at', 'timestamptz'], ['channel_id', 'text'],
    ['channel_name', 'text'], ['message_ts', 'text'], ['raw_message', 'text'],
    ['error_type', 'text'], ['hmo', 'text'], ['env', 'text'], ['inv_id', 'text'],
    ['provider_code', 'text'], ['error_message', 'text'], ['refs', 'jsonb'],
    ['parsed_at', 'timestamptz'],
  ],
  daily_reports: [
    ['id', 'bigint'], ['team_member_id', 'bigint'], ['report_date', 'date'],
    ['metrics', 'jsonb'], ['tasks_completed', 'text'], ['notes', 'text'],
    ['sent_to_slack', 'boolean'], ['slack_channel', 'text'], ['sent_at', 'timestamptz'],
    ['created_at', 'timestamptz'], ['updated_at', 'timestamptz'], ['status', 'text'],
  ],
  insurer_feedback_items: [
    ['id', 'text'], ['insurer', 'text'], ['claim_id', 'text'], ['insurance_number', 'text'],
    ['diagnosis', 'text'], ['care_item', 'text'], ['issue_category', 'text'],
    ['issue_description', 'text'], ['recommendation', 'text'], ['action_taken', 'text'],
    ['status', 'text'], ['owner', 'text'], ['feedback_date', 'date'],
    ['resolution_date', 'date'], ['notes', 'text'], ['payable_status', 'text'],
    ['resolution_status', 'text'], ['created_at', 'timestamptz'], ['updated_at', 'timestamptz'],
  ],
  leave_records: [
    ['id', 'bigint'], ['team_member_id', 'bigint'], ['leave_type', 'text'],
    ['start_date', 'date'], ['end_date', 'date'], ['reason', 'text'],
    ['marked_by', 'text'], ['created_at', 'timestamptz'],
  ],
  metric_definitions: [
    ['id', 'bigint'], ['category', 'text'], ['label', 'text'], ['metric_key', 'text'],
    ['key', 'text'], ['data_type', 'text'], ['display_order', 'integer'],
    ['is_active', 'boolean'], ['insurer_link', 'text'], ['created_at', 'timestamptz'],
    ['applies_to_all', 'boolean'], ['applicable_members', 'jsonb'], ['active', 'boolean'],
  ],
  okr_entries: [
    ['id', 'bigint'], ['created_at', 'timestamptz'], ['quarter', 'text'],
    ['objective', 'text'], ['kr_number', 'integer'], ['key_result', 'text'],
    ['target', 'numeric'], ['actual', 'numeric'], ['grade', 'numeric'], ['status', 'text'],
    ['start_date', 'date'], ['due_date', 'date'],
  ],
  platform_settings: [
    ['key', 'text'], ['value', 'text'], ['label', 'text'], ['description', 'text'],
    ['category', 'text'], ['type', 'text'], ['updated_at', 'timestamptz'],
  ],
  piles_auto_assignment_master_accounts: [
    ['id', 'text'], ['insurer_name', 'text'], ['login_email', 'text'], ['login_password', 'text'],
    ['notes', 'text'], ['is_active', 'boolean'], ['last_password_update', 'timestamptz'],
    ['created_at', 'timestamptz'], ['updated_at', 'timestamptz'],
  ],
  piles_auto_assignment_bot_accounts: [
    ['id', 'text'], ['master_account_id', 'text'], ['insurer_name', 'text'], ['owner_name', 'text'],
    ['bot_name', 'text'], ['bot_email', 'text'], ['bot_password', 'text'], ['assignment_role', 'text'],
    ['support_capacity_ratio', 'numeric'], ['availability_status', 'text'], ['availability_note', 'text'], ['notes', 'text'],
    ['is_active', 'boolean'], ['is_available', 'boolean'], ['priority_order', 'integer'],
    ['current_claim_load', 'integer'], ['last_assigned_at', 'timestamptz'], ['last_completed_at', 'timestamptz'],
    ['created_at', 'timestamptz'], ['updated_at', 'timestamptz'],
  ],
  piles_auto_assignment_rules: [
    ['id', 'text'], ['master_account_id', 'text'], ['insurer_name', 'text'], ['distribution_mode', 'text'],
    ['minimum_claim_chunk', 'integer'], ['reassignment_threshold_minutes', 'integer'],
    ['stale_claim_threshold', 'integer'], ['target_completion_gap_minutes', 'integer'],
    ['is_active', 'boolean'], ['notes', 'text'], ['created_at', 'timestamptz'], ['updated_at', 'timestamptz'],
  ],
  piles_auto_assignment_bot_metrics: [
    ['id', 'text'], ['bot_account_id', 'text'], ['metric_window', 'text'], ['claims_completed', 'integer'],
    ['hours_logged', 'numeric'], ['claims_per_hour', 'numeric'], ['active_claim_load', 'integer'],
    ['projected_finish_at', 'timestamptz'], ['details', 'jsonb'], ['observed_at', 'timestamptz'], ['updated_at', 'timestamptz'],
  ],
  piles_auto_assignment_logs: [
    ['id', 'text'], ['master_account_id', 'text'], ['bot_account_id', 'text'], ['insurer_name', 'text'],
    ['event_type', 'text'], ['source', 'text'], ['status', 'text'], ['assigned_by', 'text'],
    ['pile_count', 'integer'], ['claim_count', 'integer'], ['details', 'jsonb'], ['created_at', 'timestamptz'],
  ],
  piles_auto_assignment_tracked_piles: [
    ['id', 'text'], ['master_account_id', 'text'], ['bot_account_id', 'text'], ['insurer_name', 'text'],
    ['tracking_key', 'text'], ['last_pile_key', 'text'], ['provider', 'text'], ['claim_month', 'text'],
    ['submitted_date', 'text'], ['claims_total', 'integer'], ['synced_claims', 'integer'], ['remaining_claims', 'integer'],
    ['assignment_type', 'text'], ['current_status', 'text'], ['current_status_bucket', 'text'], ['current_assigned', 'text'],
    ['filter_month', 'text'], ['first_assigned_at', 'timestamptz'], ['assigned_at', 'timestamptz'], ['first_seen_at', 'timestamptz'],
    ['last_seen_at', 'timestamptz'], ['last_progress_at', 'timestamptz'], ['last_reassigned_at', 'timestamptz'], ['completed_at', 'timestamptz'],
    ['is_active', 'boolean'], ['is_stale', 'boolean'], ['stale_reason', 'text'], ['details', 'jsonb'],
    ['created_at', 'timestamptz'], ['updated_at', 'timestamptz'],
  ],
  piles_auto_assignment_pile_snapshots: [
    ['id', 'text'], ['tracked_pile_id', 'text'], ['insurer_name', 'text'], ['bot_account_id', 'text'],
    ['tracking_key', 'text'], ['pile_key', 'text'], ['provider', 'text'], ['claims_total', 'integer'],
    ['synced_claims', 'integer'], ['remaining_claims', 'integer'], ['progress_claims', 'integer'], ['status', 'text'],
    ['status_bucket', 'text'], ['assigned', 'text'], ['is_completed', 'boolean'], ['observed_at', 'timestamptz'],
    ['details', 'jsonb'],
  ],
  piles_auto_assignment_runner_runs: [
    ['id', 'text'], ['insurer_name', 'text'], ['run_scope', 'text'], ['portal_environment', 'text'],
    ['backend', 'text'], ['run_source', 'text'], ['months', 'jsonb'], ['year', 'text'],
    ['mode', 'text'], ['status', 'text'], ['started_at', 'timestamptz'], ['finished_at', 'timestamptz'],
    ['duration_ms', 'integer'], ['stdout', 'text'], ['stderr', 'text'], ['details', 'jsonb'],
    ['created_at', 'timestamptz'], ['updated_at', 'timestamptz'],
  ],
  prism_logs: [
    ['id', 'bigint'], ['sent_by', 'text'], ['message', 'text'], ['category', 'text'],
    ['summary', 'text'], ['slack_ts', 'text'], ['status', 'text'], ['created_at', 'timestamptz'],
    ['prism_reply', 'text'], ['flagged_user', 'text'],
  ],
  prism_conversations: [
    ['id', 'text'], ['created_by', 'text'], ['slack_channel', 'text'], ['slack_thread_ts', 'text'],
    ['status', 'text'], ['created_at', 'timestamptz'], ['updated_at', 'timestamptz'],
  ],
  prism_messages: [
    ['id', 'text'], ['conversation_id', 'text'], ['direction', 'text'], ['body', 'text'],
    ['slack_ts', 'text'], ['slack_user_id', 'text'], ['status', 'text'], ['created_at', 'timestamptz'],
  ],
  qa_flags: [
    ['id', 'text'], ['claim_id', 'text'], ['full_name', 'text'], ['insurance_number', 'text'],
    ['item_description', 'text'], ['qty_billed', 'numeric'], ['qty_approved', 'numeric'],
    ['unit_price_billed', 'numeric'], ['unit_price_calculated', 'numeric'],
    ['bill_submitted', 'numeric'], ['bill_approved', 'numeric'], ['vetting_comment', 'text'],
    ['item_status', 'text'], ['issues', 'text'], ['encounter_date', 'date'],
    ['created_at', 'timestamptz'], ['flagged_at', 'timestamptz'], ['provider_name', 'text'],
    ['insurer_name', 'text'], ['source', 'text'],
  ],
  sessions: [
    ['id', 'bigint'], ['member_id', 'bigint'], ['session_token', 'text'],
    ['is_guest', 'boolean'], ['created_at', 'timestamptz'], ['expires_at', 'timestamptz'],
  ],
  slack_summaries: [
    ['id', 'bigint'], ['date', 'date'], ['summary_type', 'text'],
    ['submitted_count', 'integer'], ['pending_count', 'integer'],
    ['results', 'jsonb'], ['created_at', 'timestamptz'],
  ],
  target_logs: [
    ['id', 'text'], ['target_id', 'text'], ['date', 'date'],
    ['value', 'numeric'], ['note', 'text'], ['created_at', 'timestamptz'],
  ],
  tasks: [
    ['id', 'bigint'], ['title', 'text'], ['description', 'text'], ['assigned_to', 'bigint'],
    ['created_by', 'text'], ['insurer', 'text'], ['status', 'text'], ['priority', 'text'],
    ['due_date', 'date'], ['completed_at', 'timestamptz'], ['slack_notified', 'boolean'],
    ['created_at', 'timestamptz'], ['updated_at', 'timestamptz'], ['assigned_by', 'text'],
    ['category', 'text'],
  ],
  team_leave: [
    ['id', 'bigint'], ['team_member_id', 'bigint'], ['leave_type', 'text'],
    ['start_date', 'date'], ['end_date', 'date'], ['reason', 'text'],
    ['marked_by', 'text'], ['created_at', 'timestamptz'],
  ],
  team_members: [
    ['id', 'bigint'], ['name', 'text'], ['email', 'text'], ['slack_user_id', 'text'],
    ['role', 'text'], ['is_active', 'boolean'], ['created_at', 'timestamptz'],
    ['active', 'boolean'], ['display_name', 'text'], ['report_pin', 'text'], ['birthday', 'date'],
  ],
  weekly_targets: [
    ['id', 'text'], ['name', 'text'], ['type', 'text'], ['target_value', 'numeric'],
    ['start_date', 'date'], ['end_date', 'date'], ['metric_key', 'text'],
    ['description', 'text'], ['created_at', 'timestamptz'], ['updated_at', 'timestamptz'],
  ],
};

const CREATE_TABLE_SQL = {
  audit_log: `
    CREATE TABLE audit_log (
      id bigserial PRIMARY KEY,
      member_id bigint,
      member_name text,
      action text,
      entity_type text,
      entity_id text,
      details jsonb,
      source text DEFAULT 'app',
      ip_address text,
      created_at timestamptz DEFAULT now()
    )`,
  claim_errors: `
    CREATE TABLE claim_errors (
      id bigserial PRIMARY KEY,
      created_at timestamptz DEFAULT now(),
      channel_id text,
      channel_name text,
      message_ts text,
      raw_message text,
      error_type text,
      hmo text,
      env text,
      inv_id text,
      provider_code text,
      error_message text,
      refs jsonb,
      parsed_at timestamptz
    )`,
  daily_reports: `
    CREATE TABLE daily_reports (
      id bigserial PRIMARY KEY,
      team_member_id bigint NOT NULL,
      report_date date NOT NULL,
      metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
      tasks_completed text,
      notes text,
      sent_to_slack boolean DEFAULT false,
      slack_channel text,
      sent_at timestamptz,
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now(),
      status text DEFAULT 'submitted',
      CONSTRAINT daily_reports_member_date_unique UNIQUE (team_member_id, report_date)
    )`,
  insurer_feedback_items: `
    CREATE TABLE insurer_feedback_items (
      id text PRIMARY KEY DEFAULT md5(random()::text || clock_timestamp()::text),
      insurer text,
      claim_id text,
      insurance_number text,
      diagnosis text,
      care_item text,
      issue_category text,
      issue_description text,
      recommendation text,
      action_taken text,
      status text,
      owner text,
      feedback_date date,
      resolution_date date,
      notes text,
      payable_status text,
      resolution_status text,
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now()
    )`,
  leave_records: `
    CREATE TABLE leave_records (
      id bigserial PRIMARY KEY,
      team_member_id bigint,
      leave_type text,
      start_date date,
      end_date date,
      reason text,
      marked_by text,
      created_at timestamptz DEFAULT now()
    )`,
  metric_definitions: `
    CREATE TABLE metric_definitions (
      id bigserial PRIMARY KEY,
      category text,
      label text,
      metric_key text,
      key text,
      data_type text,
      display_order integer,
      is_active boolean DEFAULT true,
      insurer_link text,
      created_at timestamptz DEFAULT now(),
      applies_to_all boolean DEFAULT true,
      applicable_members jsonb DEFAULT '[]'::jsonb,
      active boolean DEFAULT true,
      CONSTRAINT metric_definitions_metric_key_unique UNIQUE (metric_key)
    )`,
  okr_entries: `
    CREATE TABLE okr_entries (
      id bigserial PRIMARY KEY,
      created_at timestamptz DEFAULT now(),
      quarter text,
      objective text,
      kr_number integer,
      key_result text,
      target numeric,
      actual numeric,
      grade numeric,
      status text,
      start_date date,
      due_date date
    )`,
  platform_settings: `
    CREATE TABLE platform_settings (
      key text PRIMARY KEY,
      value text,
      label text,
      description text,
      category text,
      type text,
      updated_at timestamptz DEFAULT now()
    )`,
  piles_auto_assignment_master_accounts: `
    CREATE TABLE piles_auto_assignment_master_accounts (
      id text PRIMARY KEY DEFAULT md5(random()::text || clock_timestamp()::text),
      insurer_name text NOT NULL UNIQUE,
      login_email text NOT NULL,
      login_password text,
      notes text,
      is_active boolean DEFAULT true,
      last_password_update timestamptz,
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now()
    )`,
  piles_auto_assignment_bot_accounts: `
    CREATE TABLE piles_auto_assignment_bot_accounts (
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
    )`,
  piles_auto_assignment_rules: `
    CREATE TABLE piles_auto_assignment_rules (
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
    )`,
  piles_auto_assignment_bot_metrics: `
    CREATE TABLE piles_auto_assignment_bot_metrics (
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
    )`,
  piles_auto_assignment_logs: `
    CREATE TABLE piles_auto_assignment_logs (
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
    )`,
  piles_auto_assignment_tracked_piles: `
    CREATE TABLE piles_auto_assignment_tracked_piles (
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
      filter_month text,
      first_assigned_at timestamptz,
      assigned_at timestamptz,
      first_seen_at timestamptz,
      last_seen_at timestamptz,
      last_progress_at timestamptz,
      last_reassigned_at timestamptz,
      completed_at timestamptz,
      is_active boolean DEFAULT true,
      is_stale boolean DEFAULT false,
      stale_reason text,
      details jsonb DEFAULT '{}'::jsonb,
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now(),
      CONSTRAINT piles_auto_assignment_tracked_piles_unique UNIQUE (insurer_name, tracking_key)
    )`,
  piles_auto_assignment_pile_snapshots: `
    CREATE TABLE piles_auto_assignment_pile_snapshots (
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
    )`,
  piles_auto_assignment_runner_runs: `
    CREATE TABLE piles_auto_assignment_runner_runs (
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
    )`,
  prism_logs: `
    CREATE TABLE prism_logs (
      id bigserial PRIMARY KEY,
      sent_by text,
      message text,
      category text,
      summary text,
      slack_ts text,
      status text,
      created_at timestamptz DEFAULT now(),
      prism_reply text,
      flagged_user text
    )`,
  prism_conversations: `
    CREATE TABLE prism_conversations (
      id text PRIMARY KEY DEFAULT md5(random()::text || clock_timestamp()::text),
      created_by text,
      slack_channel text NOT NULL,
      slack_thread_ts text NOT NULL UNIQUE,
      status text DEFAULT 'open',
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now()
    )`,
  prism_messages: `
    CREATE TABLE prism_messages (
      id text PRIMARY KEY DEFAULT md5(random()::text || clock_timestamp()::text),
      conversation_id text REFERENCES prism_conversations(id) ON DELETE CASCADE,
      direction text NOT NULL,
      body text NOT NULL,
      slack_ts text,
      slack_user_id text,
      status text DEFAULT 'sent',
      created_at timestamptz DEFAULT now()
    )`,
  qa_flags: `
    CREATE TABLE qa_flags (
      id text PRIMARY KEY DEFAULT md5(random()::text || clock_timestamp()::text),
      claim_id text,
      full_name text,
      insurance_number text,
      item_description text,
      qty_billed numeric,
      qty_approved numeric,
      unit_price_billed numeric,
      unit_price_calculated numeric,
      bill_submitted numeric,
      bill_approved numeric,
      vetting_comment text,
      item_status text,
      issues text,
      encounter_date date,
      created_at timestamptz,
      flagged_at timestamptz DEFAULT now(),
      provider_name text,
      insurer_name text,
      source text,
      CONSTRAINT qa_flags_upsert_unique UNIQUE (claim_id, item_description, issues, encounter_date)
    )`,
  sessions: `
    CREATE TABLE sessions (
      id bigserial PRIMARY KEY,
      member_id bigint,
      session_token text NOT NULL DEFAULT md5(random()::text || clock_timestamp()::text),
      is_guest boolean DEFAULT false,
      created_at timestamptz DEFAULT now(),
      expires_at timestamptz,
      CONSTRAINT sessions_token_unique UNIQUE (session_token)
    )`,
  slack_summaries: `
    CREATE TABLE slack_summaries (
      id bigserial PRIMARY KEY,
      date date,
      summary_type text,
      submitted_count integer,
      pending_count integer,
      results jsonb,
      created_at timestamptz DEFAULT now()
    )`,
  target_logs: `
    CREATE TABLE target_logs (
      id text PRIMARY KEY DEFAULT md5(random()::text || clock_timestamp()::text),
      target_id text NOT NULL,
      date date NOT NULL,
      value numeric,
      note text,
      created_at timestamptz DEFAULT now(),
      CONSTRAINT target_logs_target_date_unique UNIQUE (target_id, date)
    )`,
  tasks: `
    CREATE TABLE tasks (
      id bigserial PRIMARY KEY,
      title text NOT NULL,
      description text,
      assigned_to bigint,
      created_by text,
      insurer text,
      status text DEFAULT 'todo',
      priority text DEFAULT 'medium',
      due_date date,
      completed_at timestamptz,
      slack_notified boolean DEFAULT false,
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now(),
      assigned_by text,
      category text
    )`,
  team_leave: `
    CREATE TABLE team_leave (
      id bigserial PRIMARY KEY,
      team_member_id bigint NOT NULL,
      leave_type text NOT NULL,
      start_date date NOT NULL,
      end_date date NOT NULL,
      reason text,
      marked_by text,
      created_at timestamptz DEFAULT now()
    )`,
  team_members: `
    CREATE TABLE team_members (
      id bigserial PRIMARY KEY,
      name text NOT NULL,
      email text,
      slack_user_id text,
      role text,
      is_active boolean DEFAULT true,
      created_at timestamptz DEFAULT now(),
      active boolean DEFAULT true,
      display_name text,
      report_pin text,
      birthday date
    )`,
  weekly_targets: `
    CREATE TABLE weekly_targets (
      id text PRIMARY KEY DEFAULT md5(random()::text || clock_timestamp()::text),
      name text NOT NULL,
      type text,
      target_value numeric,
      start_date date,
      end_date date,
      metric_key text,
      description text,
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now()
    )`,
};

const INDEX_SQL = [
  'CREATE INDEX daily_reports_report_date_idx ON daily_reports (report_date)',
  'CREATE INDEX daily_reports_member_date_idx ON daily_reports (team_member_id, report_date)',
  'CREATE INDEX claim_errors_created_at_idx ON claim_errors (created_at)',
  'CREATE INDEX qa_flags_flagged_at_idx ON qa_flags (flagged_at)',
  'CREATE INDEX qa_flags_claim_id_idx ON qa_flags (claim_id)',
  'CREATE INDEX piles_auto_assignment_tracked_piles_insurer_active_idx ON piles_auto_assignment_tracked_piles (insurer_name, is_active, last_seen_at DESC)',
  'CREATE INDEX piles_auto_assignment_tracked_piles_bot_active_idx ON piles_auto_assignment_tracked_piles (bot_account_id, is_active, last_seen_at DESC)',
  'CREATE INDEX piles_auto_assignment_pile_snapshots_tracked_idx ON piles_auto_assignment_pile_snapshots (tracked_pile_id, observed_at DESC)',
  'CREATE INDEX piles_auto_assignment_pile_snapshots_bot_idx ON piles_auto_assignment_pile_snapshots (bot_account_id, observed_at DESC)',
  'CREATE INDEX piles_auto_assignment_runner_runs_started_idx ON piles_auto_assignment_runner_runs (started_at DESC)',
  'CREATE INDEX tasks_assigned_to_idx ON tasks (assigned_to)',
  'CREATE INDEX target_logs_target_id_idx ON target_logs (target_id)',
  'CREATE INDEX team_leave_member_dates_idx ON team_leave (team_member_id, start_date, end_date)',
];

function requireEnv(name, value) {
  if (!value) {
    console.error(`${name} is required`);
    process.exit(1);
  }
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function isBlank(value) {
  return value === undefined || value === null || value === '';
}

function toBoolean(value) {
  if (isBlank(value)) return null;
  if (value === true || value === false) return value;
  if (typeof value === 'number') return value !== 0;
  const normalized = String(value).trim().toLowerCase();
  if (['true', 't', '1', 'yes', 'y'].includes(normalized)) return true;
  if (['false', 'f', '0', 'no', 'n'].includes(normalized)) return false;
  return null;
}

function sqlLiteral(value, type) {
  if (isBlank(value)) return 'NULL';

  if (type === 'jsonb') {
    return `${sqlString(JSON.stringify(value))}::jsonb`;
  }

  if (type === 'boolean') {
    const bool = toBoolean(value);
    return bool === null ? 'NULL' : bool ? 'TRUE' : 'FALSE';
  }

  if (['bigint', 'integer', 'numeric'].includes(type)) {
    const num = Number(value);
    return Number.isFinite(num) ? String(num) : 'NULL';
  }

  if (type === 'date') {
    const raw = String(value);
    let date = /^\d{4}-\d{2}-\d{2}/.test(raw) ? raw.slice(0, 10) : raw;
    const slash = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (slash) {
      const [, day, month, year] = slash;
      date = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
    }
    return sqlString(date);
  }

  if (type === 'timestamptz') {
    return sqlString(value);
  }

  return sqlString(value);
}

function rowValue(row, table, column) {
  if (table === 'metric_definitions' && column === 'key') return row.key ?? row.metric_key ?? null;
  if (table === 'metric_definitions' && column === 'metric_key') return row.metric_key ?? row.key ?? null;
  if (table === 'qa_flags' && column === 'issues') return row.issues ?? null;
  return row[column] ?? null;
}

function uniqueRows(table, rows) {
  const keyFns = {
    daily_reports: (r) => `${r.team_member_id ?? ''}|${String(r.report_date ?? '').slice(0, 10)}`,
    metric_definitions: (r) => r.metric_key ?? r.key ?? r.id,
    platform_settings: (r) => r.key,
    qa_flags: (r) => `${r.claim_id ?? ''}|${r.item_description ?? ''}|${JSON.stringify(r.issues ?? null)}|${String(r.encounter_date ?? '').slice(0, 10)}`,
    sessions: (r) => r.session_token ?? r.id,
    target_logs: (r) => `${r.target_id ?? ''}|${String(r.date ?? '').slice(0, 10)}`,
    team_members: (r) => r.id,
    weekly_targets: (r) => r.id,
  };

  const keyFn = keyFns[table];
  if (!keyFn) return rows;

  const byKey = new Map();
  for (const row of rows) {
    const key = String(keyFn(row));
    if (!key || key === 'undefined' || key === 'null') continue;
    byKey.set(key, row);
  }
  return Array.from(byKey.values());
}

function insertSql(table, rows) {
  if (!rows.length) return null;
  const columns = TABLE_COLUMNS[table];
  const names = columns.map(([name]) => `"${name}"`).join(', ');
  const values = rows.map((row) => {
    const rowSql = columns.map(([name, type]) => {
      const value = rowValue(row, table, name);
      if (name === 'id' && isBlank(value)) return 'DEFAULT';
      return sqlLiteral(value, type);
    });
    return `(${rowSql.join(', ')})`;
  });
  return `INSERT INTO "${table}" (${names}) VALUES\n${values.join(',\n')};`;
}

function createSchemaSql(backupSchema) {
  const dropSql = TABLES.map((table) => `DROP TABLE IF EXISTS "${table}" CASCADE;`).join('\n');
  const createSql = TABLES.map((table) => `${CREATE_TABLE_SQL[table]};`).join('\n\n');
  const indexes = INDEX_SQL.map((statement) => `${statement};`).join('\n');
  const backupList = TABLES.map(sqlString).join(', ');

  return `
CREATE SCHEMA IF NOT EXISTS "${backupSchema}";
DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[${backupList}]
  LOOP
    IF to_regclass('public.' || quote_ident(table_name)) IS NOT NULL THEN
      EXECUTE format('CREATE TABLE IF NOT EXISTS "${backupSchema}".%I AS TABLE public.%I', table_name, table_name);
    END IF;
  END LOOP;
END $$;

${dropSql}

${createSql}

${indexes}
`;
}

function sequenceSql() {
  return NUMERIC_ID_TABLES.map((table) => `
SELECT setval(
  pg_get_serial_sequence('${table}', 'id'),
  GREATEST(COALESCE((SELECT MAX(id) FROM "${table}"), 0) + 1, 1),
  false
);`).join('\n');
}

async function supabaseFetchTable(table) {
  const rows = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const to = from + PAGE_SIZE - 1;
    const endpoint = `${SUPABASE_URL}/rest/v1/${table}?select=*`;
    const res = await fetch(endpoint, {
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        Range: `${from}-${to}`,
        'Range-Unit': 'items',
      },
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Supabase fetch failed for ${table}: ${res.status} ${body}`);
    }

    const page = await res.json();
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  return uniqueRows(table, rows);
}

function cookieHeader(cookies) {
  return Array.from(cookies.entries()).map(([key, value]) => `${key}=${value}`).join('; ');
}

function updateCookies(cookies, response) {
  const raw = response.headers.getSetCookie?.() || [];
  const fallback = response.headers.get('set-cookie');
  if (fallback && raw.length === 0) raw.push(fallback);
  for (const cookie of raw) {
    const first = cookie.split(/,(?=[^;,]+=)|;/)[0];
    const index = first.indexOf('=');
    if (index > 0) cookies.set(first.slice(0, index), first.slice(index + 1));
  }
}

async function adminerRequest(cookies, url, options = {}) {
  const headers = { ...(options.headers || {}) };
  const cookie = cookieHeader(cookies);
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(url, { ...options, headers, redirect: 'manual' });
  updateCookies(cookies, res);
  return res;
}

async function adminerLogin(cookies) {
  await adminerRequest(cookies, ADMINER_URL);
  const body = new URLSearchParams();
  body.set('auth[driver]', ADMINER_DRIVER);
  body.set('auth[server]', ADMINER_SERVER);
  body.set('auth[username]', ADMINER_USER);
  body.set('auth[password]', ADMINER_PASSWORD);
  body.set('auth[db]', ADMINER_DB);

  const res = await adminerRequest(cookies, ADMINER_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  let html = await res.text();
  let current = res;
  for (let i = 0; current.status >= 300 && current.status < 400 && i < 5; i += 1) {
    const location = current.headers.get('location') || ADMINER_URL;
    current = await adminerRequest(cookies, new URL(location, ADMINER_URL).toString());
    html = await current.text();
  }
  if (!html.includes('Schema: public') && !html.includes('SQL command')) {
    throw new Error(`Adminer login did not reach the database page. Status: ${current.status}. ${stripHtml(html).slice(0, 500)}`);
  }
}

function sqlUrl() {
  const query = new URLSearchParams({
    [ADMINER_DRIVER]: ADMINER_SERVER,
    username: ADMINER_USER,
    db: ADMINER_DB,
    ns: 'public',
    sql: '',
  });
  return `${ADMINER_URL}/?${query.toString()}`;
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<style[\s\S]*?<\/style>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

async function getSqlToken(cookies) {
  const res = await adminerRequest(cookies, sqlUrl());
  const html = await res.text();
  const match = html.match(/<form action="" method="post" enctype="multipart\/form-data" id="form">[\s\S]*?name='token' value='([^']+)'/);
  if (!match) throw new Error('Could not find Adminer SQL token');
  return match[1];
}

async function execSql(cookies, sql, label) {
  const token = await getSqlToken(cookies);
  const body = new URLSearchParams();
  body.set('query', sql);
  body.set('limit', '100');
  body.set('token', token);

  const res = await adminerRequest(cookies, sqlUrl(), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const html = await res.text();
  if (html.includes("<p class='error'>")) {
    throw new Error(`Adminer SQL failed during ${label}: ${stripHtml(html).slice(0, 1200)}`);
  }
}

function chunks(rows, size) {
  const out = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

async function main() {
  requireEnv('ADMINER_USER', ADMINER_USER);
  requireEnv('ADMINER_PASSWORD', ADMINER_PASSWORD);
  requireEnv('SUPABASE_URL or NEXT_PUBLIC_SUPABASE_URL', SUPABASE_URL);
  requireEnv('SUPABASE_SERVICE_ROLE_KEY', SUPABASE_KEY);

  const backupSchema = `migration_backup_${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}`;
  const cookies = new Map();

  console.log('Fetching Supabase source data...');
  const sourceData = {};
  for (const table of TABLES) {
    sourceData[table] = await supabaseFetchTable(table);
    console.log(`  ${table}: ${sourceData[table].length}`);
  }

  console.log('Logging in to Adminer...');
  await adminerLogin(cookies);

  console.log(`Backing up current production tables to ${backupSchema} and recreating schema...`);
  await execSql(cookies, createSchemaSql(backupSchema), 'backup and create schema');

  for (const table of TABLES) {
    const tableChunks = chunks(sourceData[table], INSERT_CHUNK_SIZE);
    if (!tableChunks.length) {
      console.log(`  ${table}: no rows to insert`);
      continue;
    }

    let inserted = 0;
    for (const [index, chunk] of tableChunks.entries()) {
      await execSql(cookies, insertSql(table, chunk), `${table} insert chunk ${index + 1}/${tableChunks.length}`);
      inserted += chunk.length;
      if (inserted % 1000 === 0 || index === tableChunks.length - 1) {
        console.log(`  ${table}: inserted ${inserted}/${sourceData[table].length}`);
      }
    }
  }

  console.log('Resetting sequences...');
  await execSql(cookies, sequenceSql(), 'reset sequences');

  console.log('Verifying production row counts...');
  const verifySql = TABLES.map((table) => `SELECT '${table}' AS table_name, count(*)::text AS rows FROM "${table}"`).join('\nUNION ALL\n') + ';';
  await execSql(cookies, verifySql, 'verify counts');

  console.log(`Fresh migration complete. Backup schema: ${backupSchema}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
