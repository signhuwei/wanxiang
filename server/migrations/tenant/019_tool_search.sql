ALTER TABLE commerce_tool_calls ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'mcp'
  CHECK (source_kind IN ('mcp', 'http_search'));
ALTER TABLE commerce_tool_calls ADD COLUMN request_fingerprint TEXT;
ALTER TABLE commerce_tool_calls ADD COLUMN lease_id TEXT REFERENCES leases(id);
ALTER TABLE commerce_tool_calls ADD COLUMN reserved_until TEXT;
ALTER TABLE commerce_tool_calls ADD COLUMN package_reserved INTEGER NOT NULL DEFAULT 0
  CHECK (package_reserved >= 0 AND package_reserved <= fee_milli);
ALTER TABLE commerce_tool_calls ADD COLUMN outcome TEXT
  CHECK (outcome IN ('upstream_failed', 'upstream_unconfirmed'));
CREATE INDEX commerce_search_holds ON commerce_tool_calls(reserved_until, month, user_id)
  WHERE source_kind = 'http_search' AND status = 'awaiting_result';
