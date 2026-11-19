ALTER TABLE leases ADD COLUMN seq INTEGER NOT NULL DEFAULT 1 CHECK (seq > 0);
CREATE UNIQUE INDEX outstanding_lease_by_device ON leases(device_id) WHERE status = 'active';
CREATE INDEX leases_by_device_and_seq ON leases(device_id, seq DESC);
CREATE TABLE lease_operations (
  device_id TEXT NOT NULL REFERENCES devices(id), op_id TEXT NOT NULL, lease_id TEXT NOT NULL REFERENCES leases(id),
  used_milli INTEGER NOT NULL, result_json TEXT NOT NULL, PRIMARY KEY (device_id, op_id)
) STRICT;
ALTER TABLE ledger ADD COLUMN note TEXT;
CREATE INDEX ledger_by_kind_and_at ON ledger(kind, at);

ALTER TABLE usage RENAME TO usage_previous;
CREATE TABLE usage (
  device_id TEXT NOT NULL REFERENCES devices(id), seq INTEGER NOT NULL CHECK (seq > 0), request_id TEXT NOT NULL,
  session_id TEXT, lease_id TEXT REFERENCES leases(id), provider_id TEXT, model_id TEXT NOT NULL,
  input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, cache_read_tokens INTEGER NOT NULL, cache_write_tokens INTEGER NOT NULL,
  cost_milli INTEGER, status TEXT NOT NULL, at TEXT NOT NULL, complete INTEGER NOT NULL CHECK (complete IN (0,1)),
  settlement_status TEXT NOT NULL CHECK (settlement_status IN ('pending','reconciled','unverified')),
  PRIMARY KEY (device_id, seq)
) STRICT;
INSERT INTO usage (device_id, seq, request_id, session_id, model_id, input_tokens, output_tokens, cache_read_tokens,
  cache_write_tokens, cost_milli, status, at, complete, settlement_status)
SELECT device_id, seq, request_id, session_id, model_id, input_tokens, output_tokens, cache_read_tokens,
  cache_write_tokens, cost_milli, status, at, 0, 'unverified' FROM usage_previous;
DROP TABLE usage_previous;
CREATE INDEX usage_by_lease ON usage(lease_id, complete, settlement_status);

CREATE TABLE ingest_sequences (
  device_id TEXT NOT NULL REFERENCES devices(id), seq INTEGER NOT NULL, PRIMARY KEY (device_id, seq)
) STRICT;
INSERT INTO ingest_sequences SELECT device_id, seq FROM session_events UNION SELECT device_id, seq FROM usage;
CREATE TABLE ingest_cursors (
  device_id TEXT PRIMARY KEY REFERENCES devices(id), ack_seq INTEGER NOT NULL
) STRICT;
