WITH starters(id, title, category, schema_json, scopes_json, merge_rule, default_json) AS (
  VALUES
    ('seats.limit','签约席位','limit','{"kind":"integer","min":0}','["tenant"]','fixed','0'),
    ('access.agents','可用 Agent','access','{"kind":"resource_set","catalog":"agents"}','["tenant","group","member"]','intersection','[]'),
    ('access.models','可用模型','access','{"kind":"resource_set","catalog":"models"}','["tenant","group","member"]','intersection','[]'),
    ('lease.minutes','租约时长','limit','{"kind":"integer","min":1,"max":1440}','["tenant","group","member"]','min','10'),
    ('lease.budget','单设备租约额度','limit','{"kind":"money_milli","min":0}','["tenant","group","member"]','min','0'),
    ('quota.distribution','允许分配配额','limit','{"kind":"boolean"}','["tenant"]','fixed','false'),
    ('quota.monthly','月度用量上限','limit','{"kind":"money_milli","min":0}','["tenant","group","member"]','min','0'),
    ('observation.admin.summary','管理员可查看监察摘要','governance','{"kind":"boolean"}','["tenant"]','and','false'),
    ('observation.admin.content','管理员可查看会话正文','governance','{"kind":"boolean"}','["tenant"]','and','false'),
    ('observation.group_admin.summary','组管理员可查看监察摘要','governance','{"kind":"boolean"}','["tenant"]','and','false'),
    ('observation.group_admin.content','组管理员可查看会话正文','governance','{"kind":"boolean"}','["tenant"]','and','false')
)
INSERT OR IGNORE INTO policy_definitions (id, version, definition_json)
SELECT id, 1, json_object('id', id, 'version', 1, 'title', title, 'description', '',
  'category', category, 'schema', json(schema_json), 'scopes', json(scopes_json), 'merge', merge_rule,
  'default_value', json(default_json), 'binding', json_object('adapter', id, 'abi', 1))
FROM starters;

WITH starters(id, name, description, seats, distribute) AS (
  VALUES ('trial','试用版','核定模型、Agent 与租约额度后签发。',5,'false'),
         ('team','团队版','核定模型、Agent 与租约额度后签发，可开放组及个人配额。',50,'true')
)
INSERT OR IGNORE INTO policy_templates (id, version, name, description, entries_json)
SELECT s.id, 1, s.name, s.description,
  (SELECT json_group_array(json_object('clause_ref', json_object('id', d.id, 'version', d.version), 'value', json(
    CASE d.id
      WHEN 'seats.limit' THEN CAST(s.seats AS TEXT)
      WHEN 'quota.distribution' THEN s.distribute
      ELSE (d.definition_json -> '$.default_value')
    END)))
  FROM policy_definitions d WHERE d.version = 1 AND d.id IN
    ('seats.limit', 'access.agents', 'access.models', 'lease.minutes', 'lease.budget', 'quota.distribution'))
FROM starters s;
