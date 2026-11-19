ALTER TABLE session_events ADD COLUMN source_offset INTEGER;
ALTER TABLE session_events ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
CREATE INDEX agent_sessions_by_user ON agent_sessions(user_id, started_at DESC, id);
CREATE INDEX usage_by_session ON usage(device_id, session_id);
ALTER TABLE agent_sessions ADD COLUMN started_seq INTEGER;
ALTER TABLE agent_sessions ADD COLUMN ended_seq INTEGER;
ALTER TABLE agent_sessions ADD COLUMN last_event_at TEXT;
