// 展示格式化：橡皮金额、时间、角色与状态的中文标签。

export function formatMilli(milli) {
  if (milli === null || milli === undefined) return '不限'
  const v = milli / 1000
  // 去掉浮点尾差，最多三位小数
  return String(Math.round(v * 1000) / 1000)
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
