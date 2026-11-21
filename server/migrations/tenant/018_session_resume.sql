ALTER TABLE agent_sessions ADD COLUMN resumed_seq INTEGER;
ALTER TABLE agent_sessions ADD COLUMN content_floor_seq INTEGER;
ALTER TABLE agent_sessions ADD COLUMN content_floor_at TEXT;
