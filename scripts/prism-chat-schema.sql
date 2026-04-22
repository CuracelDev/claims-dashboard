CREATE TABLE IF NOT EXISTS prism_conversations (
  id text PRIMARY KEY DEFAULT md5(random()::text || clock_timestamp()::text),
  created_by text,
  slack_channel text NOT NULL,
  slack_thread_ts text NOT NULL UNIQUE,
  status text DEFAULT 'open',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS prism_messages (
  id text PRIMARY KEY DEFAULT md5(random()::text || clock_timestamp()::text),
  conversation_id text REFERENCES prism_conversations(id) ON DELETE CASCADE,
  direction text NOT NULL,
  body text NOT NULL,
  slack_ts text,
  slack_user_id text,
  status text DEFAULT 'sent',
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS prism_messages_conversation_created_idx
  ON prism_messages (conversation_id, created_at);

CREATE INDEX IF NOT EXISTS prism_conversations_thread_idx
  ON prism_conversations (slack_thread_ts);
