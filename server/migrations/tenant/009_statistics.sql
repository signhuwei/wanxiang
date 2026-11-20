CREATE INDEX IF NOT EXISTS usage_by_at ON usage(at);
CREATE INDEX IF NOT EXISTS session_events_by_at ON session_events(at);
CREATE INDEX IF NOT EXISTS agent_sessions_by_started_at ON agent_sessions(started_at);
