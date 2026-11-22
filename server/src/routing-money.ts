// Token counts on this boundary have already been normalized into disjoint categories.
const tokenDimensions = ['input', 'output', 'cache_read', 'cache_write'] as const;
const procurementDimensions = [...tokenDimensions, 'request'] as const;
type TokenDimension = typeof tokenDimensions[number];
export type RoutingTokenUsage = Record<`${TokenDimension}_tokens`, number>;
export type RoutingSalesRates = Record<`${TokenDimension}_milli_per_mtok`, number>;

export type UnitPrice = { rate_micro: string; quantity_basis: number };
export type ProcurementFxRate = {
  base_currency: string; quote_currency: string; rate_numerator: string; rate_denominator: string;
};
export type InputPriceChannel = { deployment_id: string } & (
  | { reason_code: string }
  | { currency: string; input: UnitPrice | null; fx?: ProcurementFxRate | null }
);
export type ProcurementPrice = {
  currency: string;
  items: Partial<Record<TokenDimension | 'request', UnitPrice>>;
};
export type ProcurementRounding = 'exact' | 'ceil' | 'floor' | 'half_up';
type Fraction = { numerator: bigint; denominator: bigint };

const million = 1_000_000n;
const ppmStep = 1000n;
const maxDecimalDigits = 38;
const identityRate = { numerator: 1n, denominator: 1n };

function wireInteger(value: number, field: string): bigint {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(field);
  return BigInt(value);
}

function safeNumber(value: bigint, field: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError(field);
  return Number(value);
}

// Canonical unsigned base-10 strings. Bound both financial inputs and wire results.
function unsignedDecimal(value: string, field: string): bigint {
  if (typeof value !== 'string' || value.length > maxDecimalDigits || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new RangeError(field);
  }
  return BigInt(value);
}

function unitPrice(price: UnitPrice): Fraction {
  const denominator = wireInteger(price.quantity_basis, 'quantity_basis');
  if (denominator === 0n) throw new RangeError('quantity_basis');
  return { numerator: unsignedDecimal(price.rate_micro, 'rate_micro'), denominator };
}

// null indicates that this channel has no usable exchange rate. The caller resolves
// tariff scope, quote/FX validity windows and revocations at a single pricing_at.
function cnyFx(currency: string, fx?: ProcurementFxRate | null): Fraction | null {
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) throw new RangeError('currency');
  if (!fx) return currency === 'CNY' ? identityRate : null;
  if (fx.base_currency !== currency || fx.quote_currency !== 'CNY') throw new RangeError('FX currency pair');
  const numerator = unsignedDecimal(fx.rate_numerator, 'rate_numerator');
  const denominator = unsignedDecimal(fx.rate_denominator, 'rate_denominator');
  if (numerator === 0n || denominator === 0n || (currency === 'CNY' && numerator !== denominator)) {
    throw new RangeError('FX rate');
  }
  return { numerator, denominator };
}

function ceil(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

/** Compare effective regular-input quotes per million tokens without rounding the channels. */
export function recommendInputMultiplier(channels: readonly InputPriceChannel[]) {
  let highest: Fraction | undefined;
  const unavailable: { deployment_id: string; reason_code: string }[] = [];
  for (const channel of channels) {
    if ('reason_code' in channel) {
      unavailable.push({ deployment_id: channel.deployment_id, reason_code: channel.reason_code });
      continue;
    }
    if (channel.input == null) {
      unavailable.push({ deployment_id: channel.deployment_id, reason_code: 'missing_input_quote' });
      continue;
    }
    const raw = unitPrice(channel.input);
    const fx = cnyFx(channel.currency, channel.fx);
    if (!fx) {
      unavailable.push({ deployment_id: channel.deployment_id, reason_code: 'missing_fx' });
      continue;
    }
    const numerator = raw.numerator * million * fx.numerator;
    const denominator = raw.denominator * fx.denominator;
    if (!highest || numerator * highest.denominator > highest.numerator * denominator) highest = { numerator, denominator };
  }
  const calculation_status = !highest ? 'unavailable' : unavailable.length ? 'partial' : 'complete';
  // At CNY 1 per million input tokens, one micro-CNY per million is one ppm.
  const ppm = highest ? safeNumber(ceil(highest.numerator, highest.denominator * ppmStep) * ppmStep, 'input_multiplier_ppm') : null;
  return { calculation_status, recommended_input_multiplier_ppm: ppm, unavailable } as const;
}

/** Mirrors Edge pricing::cost_milli. Add all four dimensions before rounding the sale once. */
export function salesCostMilli(usage: RoutingTokenUsage, rates: RoutingSalesRates): number {
  let total = 0n;
  for (const dimension of tokenDimensions) {
    const tokens = wireInteger(usage[`${dimension}_tokens`], `${dimension}_tokens`);
    const rate = wireInteger(rates[`${dimension}_milli_per_mtok`], `${dimension}_milli_per_mtok`);
    total += tokens * rate;
  }
  return safeNumber(ceil(total, million), 'cost_milli');
}

function roundedMicro(numerator: bigint, denominator: bigint, rounding: ProcurementRounding): bigint {
  switch (rounding) {
    case 'ceil': return ceil(numerator, denominator);
    case 'floor': return numerator / denominator;
    case 'half_up': return (2n * numerator + denominator) / (2n * denominator);
    case 'exact':
      if (numerator % denominator !== 0n) throw new RangeError('fractional micro-CNY requires a rounding rule');
      return numerator / denominator;
    default: throw new RangeError('rounding');
  }
}

/** Value one measured attempt. A request item, when present, applies once. The
 * caller selects the published rounding rule for the combined CNY estimate. */
export function procurementCostCnyMicro(usage: RoutingTokenUsage, price: ProcurementPrice,
  fxRate: ProcurementFxRate | null, rounding: ProcurementRounding): string {
  const fx = cnyFx(price.currency, fxRate);
  if (!fx) throw new RangeError('missing_fx');
  let numerator = 0n;
  let denominator = 1n;
  for (const dimension of procurementDimensions) {
    const count = dimension === 'request' ? 1n : wireInteger(usage[`${dimension}_tokens`], `${dimension}_tokens`);
    const item = price.items[dimension];
    if (!item) {
      if (dimension !== 'request' && count > 0n) throw new RangeError(`missing ${dimension} price`);
      continue;
    }
    const rate = unitPrice(item);
    numerator = numerator * rate.denominator + count * rate.numerator * denominator;
    denominator *= rate.denominator;
  }
  const amount = roundedMicro(numerator * fx.numerator, denominator * fx.denominator, rounding).toString();
  if (amount.length > maxDecimalDigits) throw new RangeError('amount_micro');
  return amount;
}
