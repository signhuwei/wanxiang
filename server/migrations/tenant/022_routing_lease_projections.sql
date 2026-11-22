-- Leases bound to the device's applied projection (contracts/routing-lease-gate.md).
-- Signature, revocation and validity come from the snapshot; billing comes from the frozen lease and signature terms.
CREATE UNIQUE INDEX leases_id_device ON leases(id, device_id);

CREATE TABLE routing_lease_projections (
  lease_id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  config_revision INTEGER NOT NULL,
  projection_id TEXT NOT NULL,
  FOREIGN KEY (lease_id, device_id) REFERENCES leases(id, device_id),
  FOREIGN KEY (device_id, config_revision, projection_id)
    REFERENCES routing_config_snapshots(device_id, config_revision, projection_id)
) STRICT;
CREATE TRIGGER routing_lease_projections_no_update BEFORE UPDATE ON routing_lease_projections
BEGIN SELECT RAISE(ABORT, 'lease projection is immutable'); END;
CREATE TRIGGER routing_lease_projections_no_delete BEFORE DELETE ON routing_lease_projections
BEGIN SELECT RAISE(ABORT, 'lease projection is immutable'); END;

-- Isolated renewals compare mode too; existing operations stay legacy.
ALTER TABLE lease_operations ADD COLUMN mode TEXT NOT NULL DEFAULT 'legacy'
  CHECK (mode IN ('legacy', 'route_pool', 'route_pool_release_only'));
