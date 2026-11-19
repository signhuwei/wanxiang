-- 诊断任务加保留期限：成功上传的日志包 7 天后不可再下载（S1-S5/W5 验收 #6）。
-- `uploaded_at` 单独记上传完成时间，和创建时间 `at`（下发指令时）分开，保留期从上传完成起算。
--
-- 同时去掉 requested_by 对 members(user_id) 的外键：平台管理员也能发起诊断（见 s1-acceptance.md #6），
-- 但平台管理员不是任何租户的 member。requested_by 现在可以是 platform_users 里的任意用户，和
-- audit.actor 的口径一致（audit 表本来就没有这个外键）。SQLite 的列级外键不能原地去掉，整表重建。
CREATE TABLE diag_jobs_new (
  id TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES devices(id), kind TEXT NOT NULL, status TEXT NOT NULL,
  object_key TEXT, requested_by TEXT NOT NULL, at TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
  expires_at TEXT, uploaded_at TEXT, detail_json TEXT
) STRICT;
INSERT INTO diag_jobs_new (id, device_id, kind, status, object_key, requested_by, at, revision)
  SELECT id, device_id, kind, status, object_key, requested_by, at, revision FROM diag_jobs;
DROP TABLE diag_jobs;
ALTER TABLE diag_jobs_new RENAME TO diag_jobs;
CREATE INDEX diag_jobs_by_device_and_at ON diag_jobs(device_id, at);
