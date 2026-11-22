-- Rollout roster: which tenant devices a pool release job targets, and the exact tenant target it produced.
-- Device state is folded from the tenant database at read time; this table only holds identity, target reference
-- and the job's own outcome for the row.
CREATE TABLE route_rollout_targets (
  rollout_id TEXT NOT NULL REFERENCES route_release_jobs(job_id),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  device_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  target_config_revision INTEGER CHECK (target_config_revision IS NULL OR target_config_revision > 0),
  projection_id TEXT,
  outcome TEXT CHECK (outcome IN ('superseded', 'failed')),
  outcome_reason TEXT,
  registered_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (rollout_id, tenant_id, device_id),
  CHECK ((target_config_revision IS NULL) = (projection_id IS NULL)),
  CHECK ((outcome IS NULL) = (outcome_reason IS NULL))
) STRICT;
CREATE INDEX route_rollout_targets_by_device ON route_rollout_targets(tenant_id, device_id, rollout_id);
