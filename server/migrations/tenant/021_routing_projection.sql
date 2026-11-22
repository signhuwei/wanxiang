-- Persistent device targets for route_pool.v1 (contracts/routing-projection.md).
-- payload_json is the complete config without envelope material (route_pool.secrets = []) and without the frame id;
-- it is resealed from frozen credential versions on every send.
CREATE TABLE routing_config_snapshots (
  device_id TEXT NOT NULL REFERENCES devices(id),
  config_revision INTEGER NOT NULL CHECK (config_revision > 0),
  projection_id TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  platform_revision INTEGER NOT NULL REFERENCES policy_signatures(revision),
  policy_revision INTEGER NOT NULL CHECK (policy_revision > 0),
  revocation_revision INTEGER NOT NULL CHECK (revocation_revision >= 0),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  digest TEXT NOT NULL CHECK (length(digest) = 64),
  source_token TEXT NOT NULL CHECK (length(source_token) = 64),
  created_at TEXT NOT NULL,
  valid_until TEXT NOT NULL CHECK (valid_until > created_at),
  PRIMARY KEY (device_id, config_revision),
  UNIQUE (device_id, config_revision, projection_id)
) STRICT;
CREATE INDEX routing_config_snapshots_latest ON routing_config_snapshots(device_id, config_revision DESC);
CREATE TRIGGER routing_config_snapshots_no_update BEFORE UPDATE ON routing_config_snapshots
BEGIN SELECT RAISE(ABORT, 'device projection is immutable'); END;
CREATE TRIGGER routing_config_snapshots_no_delete BEFORE DELETE ON routing_config_snapshots
BEGIN SELECT RAISE(ABORT, 'device projection is immutable'); END;

CREATE TABLE routing_config_deliveries (
  device_id TEXT NOT NULL,
  config_revision INTEGER NOT NULL,
  projection_id TEXT NOT NULL,
  targeted_at TEXT NOT NULL,
  sent_at TEXT,
  applied_at TEXT,
  rejected_at TEXT,
  last_failure_json TEXT CHECK (last_failure_json IS NULL OR json_valid(last_failure_json)),
  retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  PRIMARY KEY (device_id, config_revision),
  FOREIGN KEY (device_id, config_revision, projection_id)
    REFERENCES routing_config_snapshots(device_id, config_revision, projection_id)
) STRICT;

-- receipt_id is the config_applied frame id. content_digest covers the whole valid receipt; only stable codes are kept.
CREATE TABLE routing_config_receipts (
  device_id TEXT NOT NULL,
  receipt_id TEXT NOT NULL,
  config_revision INTEGER NOT NULL,
  projection_id TEXT NOT NULL,
  policy_revision INTEGER NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('applied', 'rejected')),
  error_code TEXT,
  error_reason TEXT,
  content_digest TEXT NOT NULL CHECK (length(content_digest) = 64),
  received_at TEXT NOT NULL,
  PRIMARY KEY (device_id, receipt_id),
  FOREIGN KEY (device_id, config_revision, projection_id)
    REFERENCES routing_config_snapshots(device_id, config_revision, projection_id),
  CHECK ((result = 'applied') = (error_code IS NULL)),
  CHECK ((error_code IS NULL) = (error_reason IS NULL))
) STRICT;
CREATE INDEX routing_config_receipts_by_target ON routing_config_receipts(device_id, config_revision, received_at DESC);

-- Actual projection of the applied head; legacy-protocol confirmations write NULL.
ALTER TABLE policy_device_applications ADD COLUMN projection_id TEXT;
