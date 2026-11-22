import { ulid } from 'ulid';
import { invalid } from './api';
import { inputMultiplierPpm, rateKeys, readPlan, type ModelRate } from './commerce-data';
import { hash } from './credentials';
import type { PolicyReader, SignedEntry } from './policy-types';
import type { Store, Transaction } from './store';

type SalesRate = ModelRate & {
  model_id: string; commerce_plan_id: string; source_rate_key: string | null;
  input_multiplier_basis: 'cny_1_per_mtok_input'; input_multiplier_ppm: number; terms_digest: string;
};
type Snapshot = SalesRate & {
  rate_version_id: string; platform_revision: number; valid_from: string; valid_until: string | null;
};

// Freeze the signed ceiling even when the tenant or a member currently selects fewer models.
export function signatureSalesRates(store: Store, entries: SignedEntry[]): SalesRate[] {
  const signed = new Map(entries.map(entry => [entry.definition.binding?.adapter, entry.signed_value]));
  const selectedPlan = signed.get('billing.plan');
  const selectedModels = signed.get('access.models');
  if (!Array.isArray(selectedPlan) || !selectedPlan.length || !Array.isArray(selectedModels)) return [];
  const plan = readPlan(store, { commerce_plan_id: selectedPlan[0] });
  if (!plan) invalid('commerce_plan_id');
  const models = new Set(selectedModels);
  const terms_digest = hash(JSON.stringify(plan.terms));
  return plan.terms.model_prices.filter(price => models.has(price.model_id)).map(price => ({
    ...price, source_rate_key: price.source_rate_key ?? null, commerce_plan_id: plan.id, terms_digest,
    input_multiplier_basis: 'cny_1_per_mtok_input' as const,
    input_multiplier_ppm: inputMultiplierPpm(price.input_milli_per_mtok),
  })).sort((a, b) => a.model_id < b.model_id ? -1 : a.model_id > b.model_id ? 1 : 0);
}

export function insertSalesRateSnapshots(sql: Transaction, revision: number, validFrom: string, rates: SalesRate[]) {
  for (const rate of rates) {
    sql.run(`INSERT INTO sales_rate_snapshots (rate_version_id, platform_revision, model_id, commerce_plan_id,
      source_rate_key, terms_digest, valid_from, input_multiplier_basis, input_multiplier_ppm, ${rateKeys.join(', ')})
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      'rate_' + ulid(), revision, rate.model_id, rate.commerce_plan_id, rate.source_rate_key, rate.terms_digest, validFrom,
      rate.input_multiplier_basis, rate.input_multiplier_ppm, ...rateKeys.map(key => rate[key]),
    ]);
  }
}

export function readSalesRateSnapshots(sql: PolicyReader, revision: number): Snapshot[] {
  return sql.all<Snapshot>('SELECT * FROM sales_rate_snapshots WHERE platform_revision = ? ORDER BY model_id', [revision]);
}
