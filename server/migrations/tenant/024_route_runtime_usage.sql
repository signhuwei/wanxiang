CREATE TABLE route_runtime_usage (
  device_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  request_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  projection_id TEXT NOT NULL,
  config_revision INTEGER NOT NULL,
  pool_revision INTEGER NOT NULL,
  deployment_id TEXT NOT NULL,
  deployment_revision INTEGER NOT NULL,
  rate_version_id TEXT NOT NULL REFERENCES sales_rate_snapshots(rate_version_id),
  digest TEXT NOT NULL,
  procurement_json TEXT,
  procurement_state TEXT NOT NULL CHECK (procurement_state IN ('pending','posted','unavailable')),
  PRIMARY KEY(device_id,seq),
  UNIQUE(device_id,request_id),
  UNIQUE(device_id,attempt_id),
  FOREIGN KEY(device_id,seq) REFERENCES usage(device_id,seq)
) STRICT;
CREATE TABLE route_runtime_attempts (
  device_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  attempt_id TEXT NOT NULL,
  deployment_id TEXT NOT NULL,
  deployment_revision INTEGER NOT NULL CHECK (deployment_revision > 0),
  outcome TEXT NOT NULL CHECK (outcome IN ('connect_refused','completed')),
  PRIMARY KEY(device_id,seq,ordinal),
  UNIQUE(device_id,attempt_id),
  FOREIGN KEY(device_id,seq) REFERENCES route_runtime_usage(device_id,seq)
) STRICT;
ALTER TABLE lease_operations ADD COLUMN usage_through_seq INTEGER CHECK (usage_through_seq >= 0);
