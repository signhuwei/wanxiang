import { limitedJson, readOverHttp, type ProviderChannelFetch } from './channel-catalog-upstream';

export const balanceAdapters = ['new_api', 'sub2api'] as const;
export type BalanceAdapter = typeof balanceAdapters[number];
export type BalanceReading = { amount_micro: number | null; quota_units: number | null; exhausted: boolean; reason_code: string | null };
type BalanceTarget = { adapter: BalanceAdapter; source_origin: string; expected_user_id: string; quota_per_unit: number | null };

const paths: Record<BalanceAdapter, string> = { new_api: '/api/user/self', sub2api: '/api/v1/user/profile' };
const maxAmount = BigInt(Number.MAX_SAFE_INTEGER);
const transportErrors = ['probe_timeout', 'destination_denied', 'response_limit', 'schema_mismatch'];
const responseErrors = new Map([[401, 'credential_rejected'], [403, 'permission_denied'], [404, 'unsupported_capability']]);

export const noBalance = (reason_code: string): BalanceReading => ({ amount_micro: null, quota_units: null, exhausted: false, reason_code });

export function balanceOrigin(value: string | null) {
  const url = value ? URL.parse(value) : null;
  return url?.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash ? url.origin : null;
}

export function balanceUserId(value: unknown) {
  const id = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  return typeof id === 'string' && /^[1-9][0-9]{0,18}$/.test(id) ? id : null;
}

function asObject(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function usdMicro(value: unknown) {
  const raw = typeof value === 'number' && Number.isFinite(value) ? String(value) : value;
  if (typeof raw !== 'string') return null;
  const parts = /^(\d{1,16})(?:\.(\d{1,20}))?(?:e([+-]?\d{1,3}))?$/.exec(raw);
  if (!parts) return null;
  const fractional = parts[2] ?? '';
  const decimal = BigInt(parts[1]! + fractional);
  const shift = 6 - fractional.length + Number(parts[3] ?? 0);
  if (shift > 16 && decimal > 0n) return null;
  const micro = shift >= 0 ? decimal * 10n ** BigInt(shift) : decimal / 10n ** BigInt(-shift);
  return micro <= maxAmount ? { amount_micro: Number(micro), exhausted: decimal === 0n } : null;
}

export async function observeRelayBalance(target: BalanceTarget, credential: string, send = readOverHttp): Promise<BalanceReading> {
  const origin = balanceOrigin(target.source_origin);
  if (!origin || origin !== target.source_origin) return noBalance('destination_denied');
  const newApi = target.adapter === 'new_api';
  const url = new URL(paths[target.adapter], origin);
  const headers = new Headers({ Accept: 'application/json', Authorization: newApi ? credential : `Bearer ${credential}` });
  if (newApi) headers.set('New-Api-User', target.expected_user_id);
  const signal = AbortSignal.timeout(15_000);
  try {
    const response = await send(url, headers, signal);
    if (!response.ok || response.redirected) {
      await response.body?.cancel().catch(() => {});
      if (response.redirected || (response.status >= 300 && response.status < 400)) return noBalance('redirect_denied');
      return noBalance(responseErrors.get(response.status) ?? 'upstream_error');
    }
    const body = await limitedJson(response, 256 * 1024);
    if (newApi ? body?.success === false : body?.code !== undefined && body.code !== 0) return noBalance('probe_refused');
    if (newApi ? body?.success !== true : body?.code !== 0) return noBalance('schema_mismatch');
    const data = asObject(body.data);
    if (!data) return noBalance('schema_mismatch');
    const id = balanceUserId(data.id);
    if (!id) return noBalance('schema_mismatch');
    if (id !== target.expected_user_id) return noBalance('account_scope_mismatch');
    if (newApi) {
      const quota = data.quota;
      if (typeof quota !== 'number' || !Number.isSafeInteger(quota) || quota < 0 || !target.quota_per_unit) return noBalance('schema_mismatch');
      const amount = BigInt(quota) * 1_000_000n / BigInt(target.quota_per_unit);
      if (amount > maxAmount) return noBalance('schema_mismatch');
      return { amount_micro: Number(amount), quota_units: quota, exhausted: quota === 0, reason_code: null };
    }
    const balance = usdMicro(data.balance);
    return balance ? { ...balance, quota_units: null, reason_code: null } : noBalance('schema_mismatch');
  } catch (error) {
    const reason = error instanceof Error ? error.message : '';
    return noBalance(signal.aborted ? 'probe_timeout' : transportErrors.includes(reason) ? reason : 'probe_unreachable');
  }
}
