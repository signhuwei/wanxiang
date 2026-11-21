import { monotonicFactory } from 'ulid';
import { iso } from './credentials';
import type { Transaction } from './store';

export type BalanceMode = 'normal' | 'warn' | 'restricted' | 'stopped';
type BalanceSettings = { low_balance_warn_milli?: number; low_balance_restrict_milli?: number; low_balance_models_json?: string };
type Wallet = { balance_milli: number; reserved_milli: number };
type BalanceNoticeKind = 'balance_warning' | 'balance_restricted' | 'balance_stopped' | 'balance_restored';
type BalanceNotice = { id: string; kind: BalanceNoticeKind; title: string; at: string; policy_revision: number };
const noticeId = monotonicFactory();

export const balanceLabels: Record<BalanceMode, string> = {
  normal: '正常',
  warn: '余额预警',
  restricted: '仅低成本模型可用',
  stopped: '余额耗尽',
};

const noticeContent: Record<BalanceMode, Pick<BalanceNotice, 'kind' | 'title'>> = {
  normal: { kind: 'balance_restored', title: '可用模型已恢复' },
  warn: { kind: 'balance_warning', title: '租户余额已达到预警阈值' },
  restricted: { kind: 'balance_restricted', title: '租户余额不足，仅开放合约允许的低成本模型' },
  stopped: { kind: 'balance_stopped', title: '租户余额耗尽，模型调用已暂停' },
};

export function balancePolicyEnabled(settings: BalanceSettings) {
  return (settings.low_balance_warn_milli ?? 0) > 0 || (settings.low_balance_restrict_milli ?? 0) > 0;
}

export function balanceThresholdOrderInvalid(warn: unknown, restrict: unknown) {
  return typeof warn === 'number' && typeof restrict === 'number' && warn > 0 && restrict > warn;
}

export function balancePolicyMode(settings: BalanceSettings, wallet: Wallet): BalanceMode {
  if (!balancePolicyEnabled(settings)) return 'normal';
  const { balance_milli: available, reserved_milli: reserved } = wallet;
  if (available + reserved <= 0) return 'stopped';
  const warn = settings.low_balance_warn_milli ?? 0;
  const restrict = settings.low_balance_restrict_milli ?? 0;
  if (restrict > 0 && available <= restrict) return 'restricted';
  if (warn > 0 && available <= warn) return 'warn';
  return 'normal';
}

export function balanceFallbackModels(settings: BalanceSettings): string[] {
  return JSON.parse(settings.low_balance_models_json ?? '[]');
}

export function readBalanceMode(sql: Pick<Transaction, 'get'>): BalanceMode {
  return sql.get<{ mode: BalanceMode }>('SELECT mode FROM policy_balance_state WHERE id = 1')?.mode ?? 'normal';
}

export function recordBalanceMode(sql: Transaction, mode: BalanceMode, policyRevision: number, at: number) {
  const previousMode = readBalanceMode(sql);
  if (mode === previousMode) return false;
  let notice = noticeContent[mode];
  if (mode === 'warn' && (previousMode === 'restricted' || previousMode === 'stopped')) {
    notice = { kind: 'balance_restored', title: '可用模型已恢复，租户仍处于余额预警状态' };
  }
  if (mode === 'normal' && previousMode === 'warn') notice = { ...notice, title: '租户余额已解除预警' };
  const recipients = sql.all<{ user_id: string }>("SELECT user_id FROM members WHERE status = 'active' ORDER BY user_id")
    .map(member => member.user_id);
  sql.run(`INSERT INTO policy_balance_state (id, mode) VALUES (1, ?)
    ON CONFLICT (id) DO UPDATE SET mode = excluded.mode`, [mode]);
  sql.run(`INSERT INTO policy_balance_notices (id, kind, title, at, policy_revision, user_ids_json)
    VALUES (?, ?, ?, ?, ?, ?)`, [`pbl_${noticeId(at)}`, notice.kind, notice.title, iso(at), policyRevision, JSON.stringify(recipients)]);
  return true;
}

export function balanceNotices(sql: Pick<Transaction, 'all'>, userId: string): BalanceNotice[] {
  return sql.all<BalanceNotice>(`SELECT id, kind, title, at, policy_revision FROM policy_balance_notices
    WHERE EXISTS (SELECT 1 FROM json_each(user_ids_json) WHERE value = ?)
    ORDER BY at DESC, rowid DESC LIMIT 20`, [userId]).reverse();
}
