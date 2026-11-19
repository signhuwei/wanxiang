CREATE TABLE mvp_seed (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  owner_user_id TEXT NOT NULL REFERENCES platform_users(id),
  employee_user_id TEXT NOT NULL REFERENCES platform_users(id)
) STRICT;
