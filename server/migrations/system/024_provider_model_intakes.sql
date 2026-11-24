CREATE TABLE provider_model_intakes (
  draft_id TEXT PRIMARY KEY,
  catalog_item_id TEXT NOT NULL,
  discovery_id TEXT NOT NULL,
  endpoint_revision INTEGER NOT NULL CHECK (endpoint_revision > 0),
  created_by TEXT NOT NULL REFERENCES platform_users(id),
  created_at TEXT NOT NULL,
  UNIQUE(catalog_item_id, endpoint_revision),
  FOREIGN KEY(discovery_id, catalog_item_id) REFERENCES provider_channel_discoveries(discovery_id, catalog_item_id)
) STRICT;
