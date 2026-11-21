CREATE TABLE policy_legacy_retirement (
  id INTEGER PRIMARY KEY CHECK (id = 1)
) STRICT;

INSERT INTO policy_legacy_retirement (id)
SELECT 1 WHERE EXISTS (SELECT 1 FROM contract) AND NOT EXISTS (SELECT 1 FROM policy_head);
