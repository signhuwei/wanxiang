-- Multi-channel routing, batch 2: immutable procurement quotes, FX revisions and signable input-multiplier rates.
-- Legacy rates, plans, signatures and ledgers are untouched; nothing here changes an issued price.

CREATE TABLE procurement_quote_heads (
  deployment_id TEXT PRIMARY KEY REFERENCES model_deployments(deployment_id), quote_id TEXT NOT NULL UNIQUE,
  head_revision INTEGER NOT NULL CHECK (head_revision > 0), updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE procurement_quotes (
  quote_id TEXT NOT NULL REFERENCES procurement_quote_heads(quote_id), quote_revision INTEGER NOT NULL CHECK (quote_revision > 0),
  deployment_id TEXT NOT NULL, deployment_revision INTEGER NOT NULL, provider_id TEXT NOT NULL, account_id TEXT NOT NULL,
  currency TEXT NOT NULL CHECK (length(currency) = 3 AND currency = upper(currency) AND currency GLOB '[A-Z][A-Z][A-Z]'),
  tariff_scope_kind TEXT NOT NULL CHECK (tariff_scope_kind = 'deployment'),
  valid_from TEXT NOT NULL, valid_until TEXT, source_kind TEXT NOT NULL CHECK (source_kind = 'manual'), source_reference TEXT,
  reason TEXT NOT NULL, published_by TEXT NOT NULL, published_at TEXT NOT NULL,
  PRIMARY KEY (quote_id, quote_revision),
  FOREIGN KEY (deployment_id, deployment_revision) REFERENCES model_deployment_revisions(deployment_id, deployment_revision),
  FOREIGN KEY (provider_id, account_id) REFERENCES provider_accounts(provider_id, account_id),
  CHECK (valid_until IS NULL OR valid_until > valid_from)
) STRICT;
CREATE UNIQUE INDEX procurement_quotes_by_start ON procurement_quotes(quote_id, valid_from);
CREATE INDEX procurement_quotes_by_deployment ON procurement_quotes(deployment_id, valid_from DESC, quote_revision DESC);

CREATE TABLE procurement_quote_items (
  quote_id TEXT NOT NULL, quote_revision INTEGER NOT NULL,
  dimension TEXT NOT NULL CHECK (dimension IN ('input', 'output', 'cache_read', 'cache_write', 'request')),
  rate_micro TEXT NOT NULL CHECK (length(rate_micro) BETWEEN 1 AND 38 AND rate_micro NOT GLOB '*[^0-9]*' AND (rate_micro = '0' OR rate_micro NOT GLOB '0*')),
  quantity_basis INTEGER NOT NULL CHECK (quantity_basis > 0), unit TEXT NOT NULL CHECK (unit IN ('token', 'request')),
  PRIMARY KEY (quote_id, quote_revision, dimension),
  FOREIGN KEY (quote_id, quote_revision) REFERENCES procurement_quotes(quote_id, quote_revision),
  CHECK ((dimension = 'request') = (unit = 'request'))
) STRICT;

CREATE TABLE procurement_fx_heads (
  base_currency TEXT NOT NULL, quote_currency TEXT NOT NULL CHECK (quote_currency = 'CNY'),
  head_revision INTEGER NOT NULL CHECK (head_revision > 0), updated_at TEXT NOT NULL,
  PRIMARY KEY (base_currency, quote_currency)
) STRICT;

CREATE TABLE procurement_fx_rates (
  base_currency TEXT NOT NULL CHECK (length(base_currency) = 3 AND base_currency GLOB '[A-Z][A-Z][A-Z]' AND base_currency != 'CNY'),
  quote_currency TEXT NOT NULL CHECK (quote_currency = 'CNY'), fx_revision INTEGER NOT NULL CHECK (fx_revision > 0),
  rate_numerator TEXT NOT NULL CHECK (length(rate_numerator) BETWEEN 1 AND 38 AND rate_numerator NOT GLOB '*[^0-9]*' AND rate_numerator NOT GLOB '0*'),
  rate_denominator TEXT NOT NULL CHECK (length(rate_denominator) BETWEEN 1 AND 38 AND rate_denominator NOT GLOB '*[^0-9]*' AND rate_denominator NOT GLOB '0*'),
  observed_at TEXT NOT NULL, valid_from TEXT NOT NULL, valid_until TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind = 'manual'), source_reference TEXT, reason TEXT NOT NULL,
  published_by TEXT NOT NULL, published_at TEXT NOT NULL,
  PRIMARY KEY (base_currency, quote_currency, fx_revision),
  FOREIGN KEY (base_currency, quote_currency) REFERENCES procurement_fx_heads(base_currency, quote_currency),
  CHECK (valid_until > valid_from)
) STRICT;
CREATE UNIQUE INDEX procurement_fx_by_start ON procurement_fx_rates(base_currency, quote_currency, valid_from);

-- Immutable platform rate versions offered for signing. Devices never read these drafts.
CREATE TABLE platform_rate_versions (
  source_rate_key TEXT PRIMARY KEY, model_id TEXT NOT NULL REFERENCES models(id),
  input_multiplier_basis TEXT NOT NULL CHECK (input_multiplier_basis = 'cny_1_per_mtok_input'),
  input_multiplier_ppm INTEGER NOT NULL CHECK (input_multiplier_ppm >= 0 AND input_multiplier_ppm % 1000 = 0),
  recommended_input_multiplier_ppm INTEGER CHECK (recommended_input_multiplier_ppm IS NULL OR recommended_input_multiplier_ppm % 1000 = 0),
  input_milli_per_mtok INTEGER NOT NULL, output_milli_per_mtok INTEGER NOT NULL CHECK (output_milli_per_mtok >= 0),
  cache_read_milli_per_mtok INTEGER NOT NULL CHECK (cache_read_milli_per_mtok >= 0),
  cache_write_milli_per_mtok INTEGER NOT NULL CHECK (cache_write_milli_per_mtok >= 0),
  sales_rates_source TEXT NOT NULL, pool_revision INTEGER NOT NULL, pricing_at TEXT NOT NULL,
  calculation_status TEXT NOT NULL CHECK (calculation_status IN ('complete', 'partial', 'unavailable')),
  based_on_source_rate_key TEXT REFERENCES platform_rate_versions(source_rate_key), source_digest TEXT NOT NULL,
  override_reason TEXT, status TEXT NOT NULL CHECK (status = 'available_to_sign'), created_by TEXT NOT NULL, created_at TEXT NOT NULL,
  FOREIGN KEY (model_id, pool_revision) REFERENCES model_pool_revisions(model_id, pool_revision),
  CHECK (input_milli_per_mtok * 1000 = input_multiplier_ppm)
) STRICT;
CREATE INDEX platform_rate_versions_by_model ON platform_rate_versions(model_id, created_at DESC);

CREATE TABLE platform_rate_channels (
  source_rate_key TEXT NOT NULL REFERENCES platform_rate_versions(source_rate_key), deployment_id TEXT NOT NULL,
  deployment_revision INTEGER NOT NULL, quote_id TEXT, quote_revision INTEGER, currency TEXT, amount_micro TEXT,
  quantity_basis INTEGER, unit TEXT, fx_revision INTEGER, rate_numerator TEXT, rate_denominator TEXT,
  input_cny_micro_per_mtok TEXT, reason_code TEXT,
  PRIMARY KEY (source_rate_key, deployment_id),
  FOREIGN KEY (quote_id, quote_revision) REFERENCES procurement_quotes(quote_id, quote_revision),
  CHECK (reason_code IS NOT NULL OR input_cny_micro_per_mtok IS NOT NULL)
) STRICT;

CREATE TABLE platform_rate_heads (
  model_id TEXT PRIMARY KEY REFERENCES models(id), source_rate_key TEXT NOT NULL REFERENCES platform_rate_versions(source_rate_key),
  updated_at TEXT NOT NULL
) STRICT;
