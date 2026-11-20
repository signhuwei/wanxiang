// 展示格式化：橡皮金额、时间、角色与状态的中文标签。

export function formatMilli(milli) {
  if (milli === null || milli === undefined) return '不限'
  const v = milli / 1000
  // 去掉浮点尾差，最多三位小数
  return String(Math.round(v * 1000) / 1000)
}

// 配额用量：quotaMilli 为 null 表示不限，只显示已用，不判定状态。
// 否则按用量占比分三档：ok（<80%）、warn（80%~100%）、error（已到或超出）。
export function quotaUsageLevel(usedMilli, quotaMilli) {
  if (quotaMilli === null || quotaMilli === undefined) return 'ok'
  const used = usedMilli || 0
  if (used >= quotaMilli) return 'error'
  if (quotaMilli > 0 && used >= quotaMilli * 0.8) return 'warn'
  return 'ok'
}

export function formatQuotaUsage(usedMilli, quotaMilli) {
  const used = formatMilli(usedMilli ?? 0)
  const quota = quotaMilli === null || quotaMilli === undefined ? '不限' : formatMilli(quotaMilli)
  return used + ' / ' + quota
}

export const QUOTA_HINT = '每自然月重置，按 Asia/Shanghai；留空为不限'
export const QUOTA_INVALID_MESSAGE = '橡皮配额必须是不小于 0 的整数'

// 配额表单输入是整数橡皮，换算成毫橡皮（契约字段 quota_milli）后再校验非负整数。
export function parseQuotaEraserInput(value) {
  if (value === null || value === undefined || value === '') return { quotaMilli: null }
  const n = Number(value)
  if (!Number.isInteger(n) || n < 0) return { error: QUOTA_INVALID_MESSAGE }
  return { quotaMilli: n * 1000 }
}

export function formatDateTime(rfc3339) {
  if (!rfc3339) return '—'
  const d = new Date(rfc3339)
  if (Number.isNaN(d.getTime())) return '—'
  const pad = n => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
}

export function formatBytes(bytes) {
  if (bytes === null || bytes === undefined) return '—'
  const n = Number(bytes)
  if (!Number.isFinite(n) || n < 0) return '—'
  if (n < 1024) return n + ' B'
  const units = ['KB', 'MB', 'GB']
  let v = n / 1024, i = 0
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return (Math.round(v * 10) / 10) + ' ' + units[i]
}

const ROLE_LABELS = { owner: '户主', admin: '管理员', group_admin: '组管', member: '成员' }
const MEMBER_STATUS = { active: '正常', disabled: '已禁用' }
const TENANT_STATUS = { active: '正常', suspended: '已暂停' }
export const DESKTOP_RELEASE_STATUS = { draft: '草稿', published: '已发布', unlisted: '已下架' }
export const DESKTOP_OS_LABELS = { darwin: 'macOS', windows: 'Windows' }

export function roleLabel(role) {
  return ROLE_LABELS[role] ?? role ?? '—'
}

export function memberStatusLabel(status) {
  return MEMBER_STATUS[status] ?? status ?? '—'
}

export function tenantStatusLabel(status) {
  return TENANT_STATUS[status] ?? status ?? '—'
}
