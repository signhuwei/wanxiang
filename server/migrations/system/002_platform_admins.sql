CREATE TABLE platform_admins (
  user_id TEXT PRIMARY KEY REFERENCES platform_users(id)
) STRICT;
