WITH starters(id, title, category, schema_json, scopes_json, merge_rule, default_json) AS (
  VALUES
    ('access.tools','可用 Tools','access','{"kind":"resource_set","catalog":"tools"}','["tenant","group","member"]','intersection','[]'),
    ('balance.warn','低余额提醒阈值','limit','{"kind":"money_milli","min":0}','["tenant"]','min','0'),
    ('balance.restrict','低成本模型切换阈值','limit','{"kind":"money_milli","min":0}','["tenant"]','min','0'),
    ('balance.fallback_models','低成本模型','access','{"kind":"resource_set","catalog":"models"}','["tenant"]','intersection','[]'),
    ('billing.discount','月结折扣','billing','{"kind":"ratio_ppm","min":0,"max":1000000}','["tenant"]','fixed','1000000')
)
INSERT OR IGNORE INTO policy_definitions (id, version, definition_json)
SELECT id, 1, json_object('id', id, 'version', 1, 'title', title, 'description', '',
  'category', category, 'schema', json(schema_json), 'scopes', json(scopes_json), 'merge', merge_rule,
  'default_value', json(default_json), 'binding', json_object('adapter', id, 'abi', 1))
FROM starters;
