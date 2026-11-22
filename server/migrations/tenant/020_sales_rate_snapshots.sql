CREATE TABLE sales_rate_snapshots (
  rate_version_id TEXT PRIMARY KEY,
  platform_revision INTEGER NOT NULL REFERENCES policy_signatures(revision),
  model_id TEXT NOT NULL, commerce_plan_id TEXT NOT NULL, source_rate_key TEXT,
  terms_digest TEXT NOT NULL CHECK (length(terms_digest) = 64),
  valid_from TEXT NOT NULL, valid_until TEXT CHECK (valid_until > valid_from),
  input_multiplier_basis TEXT NOT NULL CHECK (input_multiplier_basis = 'cny_1_per_mtok_input'),
  input_multiplier_ppm INTEGER NOT NULL CHECK (input_multiplier_ppm BETWEEN 0 AND 9007199254740991
    AND input_multiplier_ppm = input_milli_per_mtok * 1000),
  input_milli_per_mtok INTEGER NOT NULL CHECK (input_milli_per_mtok >= 0),
  output_milli_per_mtok INTEGER NOT NULL CHECK (output_milli_per_mtok >= 0),
  cache_read_milli_per_mtok INTEGER NOT NULL CHECK (cache_read_milli_per_mtok >= 0),
  cache_write_milli_per_mtok INTEGER NOT NULL CHECK (cache_write_milli_per_mtok >= 0),
  UNIQUE (platform_revision, model_id)
) STRICT;

CREATE TRIGGER sales_rate_snapshots_no_update BEFORE UPDATE ON sales_rate_snapshots
BEGIN SELECT RAISE(ABORT, 'signed sales rate is immutable'); END;
CREATE TRIGGER sales_rate_snapshots_no_delete BEFORE DELETE ON sales_rate_snapshots
BEGIN SELECT RAISE(ABORT, 'signed sales rate is immutable'); END;
