CREATE TABLE commerce_plans (
  id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, version INTEGER NOT NULL CHECK(version>0),
  name TEXT NOT NULL, terms_json TEXT NOT NULL CHECK(json_valid(terms_json)), created_at TEXT NOT NULL,
  created_by TEXT NOT NULL, UNIQUE(plan_id,version)
) STRICT;
CREATE TABLE commerce_tiers (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1), revision INTEGER NOT NULL,
  floor_model_id TEXT NOT NULL REFERENCES models(id), models_json TEXT NOT NULL CHECK(json_valid(models_json))
) STRICT;

INSERT OR IGNORE INTO policy_definitions(id,version,definition_json) VALUES ('billing.plan',1,
  '{"id":"billing.plan","version":1,"title":"商业计费方案","description":"","category":"billing","schema":{"kind":"resource_set","catalog":"commerce_plans"},"scopes":["tenant"],"merge":"fixed","default_value":[],"binding":{"adapter":"billing.plan","abi":1}}');
