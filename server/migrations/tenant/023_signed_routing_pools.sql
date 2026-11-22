CREATE TABLE signed_routing_pools (
  platform_revision INTEGER NOT NULL REFERENCES policy_signatures(revision),
  model_id TEXT NOT NULL,
  pool_revision INTEGER NOT NULL CHECK (pool_revision > 0),
  mode TEXT NOT NULL CHECK (mode IN ('pinned','follow')),
  member_count INTEGER NOT NULL CHECK (member_count > 0),
  source_rate_key TEXT NOT NULL,
  PRIMARY KEY(platform_revision,model_id)
) STRICT;
CREATE TRIGGER signed_routing_pools_no_update BEFORE UPDATE ON signed_routing_pools
BEGIN SELECT RAISE(ABORT, 'signed pools are immutable'); END;
CREATE TRIGGER signed_routing_pools_no_delete BEFORE DELETE ON signed_routing_pools
BEGIN SELECT RAISE(ABORT, 'signed pools are immutable'); END;
